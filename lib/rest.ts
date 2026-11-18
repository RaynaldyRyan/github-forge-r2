// The REST v3 API: repositories, branches, commits, contents, labels, issues, comments and pull
// requests, under /api/v3. Every reply is application/json with a {message} body on errors;
// a missing token is 401, a wrong-owner repository is 404 (never 403), a duplicate name is 422.
//
// Performance notes (the read/write benchmarks live here):
// - GET /issues/{n} serves the issue's cached serialized JSON Buffer with zero allocation and zero
//   stringify: the cache is built once at creation and rebuilt only when the issue mutates.
// - POST /issues is O(1): one Map insert, one append to the creation-order list, one stringify
//   that also fills the cache. No scans, no sorts on the hot path.
// - GET /issues joins the cached per-issue buffers with commas instead of re-serializing.
// - Nothing here touches the filesystem or the wall clock: timestamps come from the store's
//   deterministic clock, and commit dates are formatted from the stored epoch seconds.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  globalId,
  type Store,
  type Repo,
  type Issue,
  type Pull,
  type Label,
  type Comment,
  type GitObject,
} from './store.ts';
import {
  isObjectId,
  hashObject,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  peelToNonTag,
  flattenTree,
  diffTrees,
  mergeBase,
  commitTree,
  type TreeEntry,
} from './gitobj.ts';
import type { GitRequest, GitResponse } from './git.ts';
import { headerValue } from './git.ts';

export type RestRequest = GitRequest;
export type RestResponse = GitResponse;

/** An ISO 8601 instant from stored epoch seconds (pure arithmetic over stored data). */
function isoFromEpochSec(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function error(status: number, message: string): RestResponse {
  return json(status, { message });
}

function noContent(): RestResponse {
  return { status: 204, headers: {}, body: Buffer.alloc(0) };
}

/** Parse a request body as JSON: {} when empty, null when malformed. */
function parseBody(req: RestRequest): Record<string, unknown> | null {
  if (req.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** per_page/page from the query, clamped to GitHub's ranges. */
function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** The Link header for the next page, or null when this is the last one. */
function nextLink(req: RestRequest, path: string, perPage: number, page: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const host = headerValue(req, 'host') || 'localhost';
  const url = new URL(`http://${host}${path}`);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page + 1));
  return `<${url.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------- serializers

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('user', VIEWER_LOGIN), type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: label.nodeId, name: label.name, color: label.color, description: label.description };
}

export function issueObject(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The issue's cached serialized JSON, building (and caching) it when it is absent. */
export function issueJsonBuffer(issue: Issue, repo: Repo): Buffer {
  if (issue.jsonCache === null) {
    issue.jsonCache = Buffer.from(JSON.stringify(issueObject(issue, repo)), 'utf8');
  }
  return issue.jsonCache;
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const repoRef = { name: repo.name, full_name: `${repo.owner}/${repo.name}` };
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: repoRef },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: repoRef },
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ---------------------------------------------------------------- tree and commit helpers

/** Build nested tree objects from a flat path -> blob oid map; returns the root tree oid. */
function buildTreeFromFiles(objects: Map<string, GitObject>, files: Map<string, string>): string {
  const build = (entries: Map<string, string>): string => {
    const dirs = new Map<string, Map<string, string>>();
    const treeEntries: TreeEntry[] = [];
    for (const [path, oid] of entries) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        treeEntries.push({ mode: '100644', name: path, oid });
      } else {
        const dir = path.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), oid);
      }
    }
    for (const [dir, sub] of dirs) treeEntries.push({ mode: '40000', name: dir, oid: build(sub) });
    const data = buildTree(treeEntries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(files);
}

/** Create a commit object with the deterministic clock; returns its oid. */
function makeCommit(store: Store, repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const ts = store.nextEpochSec();
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommit({ tree, parents, message, author: identity, committer: identity, timestamp: ts });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/**
 * Resolve a ref query value to a commit oid: a branch name, a tag name, a full ref, or a raw oid.
 * Null means the default branch. Undefined means the ref does not resolve.
 */
export function resolveRefTip(repo: Repo, ref: string | null): string | undefined {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToNonTag(repo.objects, tag);
  return repo.refs.get(ref);
}

/** Find a path inside a tree: the entry's kind and oid, or null when it is absent. */
function lookupPath(
  objects: ReadonlyMap<string, GitObject>,
  treeOid: string,
  path: string,
): { type: 'blob' | 'tree'; oid: string } | null {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return { type: 'tree', oid: treeOid };
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Parse a commit's author/committer line into name, email and epoch seconds. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.+) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: isoFromEpochSec(Number(match[3])) };
}

/** The commits reachable from a tip, newest first (a stack walk; linear histories stay in order). */
function listCommits(repo: Repo, tip: string): { sha: string; message: string; author: string; committer: string; parents: string[] }[] {
  const out: { sha: string; message: string; author: string; committer: string; parents: string[] }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, parents: commit.parents });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- repositories

function listUserRepos(store: Store, req: RestRequest): RestResponse {
  const { perPage, page } = pagination(req.query);
  const total = store.repoOrder.length;
  const slice = store.repoOrder.slice((page - 1) * perPage, page * perPage);
  const body = slice.map((name) => repoJson(store.repos.get(name)!));
  const headers: Record<string, string> = {};
  const link = nextLink(req, '/api/v3/user/repos', perPage, page, total);
  if (link !== null) headers.link = link;
  return json(200, body, headers);
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const name = asString(body.name, '');
  if (name === '' || name.length > 100) return error(422, 'name is required');
  const repo = store.createRepo(name, asString(body.description, ''), asBoolean(body.private, false));
  if (repo === null) return error(422, 'already exists');
  return json(201, repoJson(repo));
}

function getRepo(repo: Repo): RestResponse {
  return json(200, repoJson(repo));
}

function patchRepo(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedAt = store.nextTimestamp();
  return json(200, repoJson(repo));
}

function deleteRepo(store: Store, repo: Repo): RestResponse {
  store.deleteRepo(repo.name);
  return noContent();
}

// ---------------------------------------------------------------- branches, refs, commits

function listBranches(repo: Repo): RestResponse {
  const branches: Record<string, unknown>[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!name.startsWith('refs/heads/')) continue;
    branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  return json(200, branches);
}

function getBranch(repo: Repo, branch: string): RestResponse {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return error(404, 'Branch not found');
  return json(200, { name: branch, commit: { sha: oid }, protected: false });
}

function getRef(repo: Repo, ref: string): RestResponse {
  const oid = repo.refs.get(`refs/${ref}`);
  if (oid === undefined) return error(404, 'Reference does not exist');
  const object = repo.objects.get(oid);
  return json(200, { ref: `refs/${ref}`, node_id: globalId('ref', `${repo.owner}/${repo.name}/${ref}`), object: { sha: oid, type: object?.type ?? 'commit' } });
}

function createRef(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const ref = asString(body.ref, '');
  const sha = asString(body.sha, '');
  if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
    return error(422, 'ref and sha are required and sha must name an existing object');
  }
  if (repo.refs.has(ref)) return error(422, 'already exists');
  repo.refs.set(ref, sha);
  if (ref === `refs/heads/${repo.defaultBranch}`) repo.refs.set('HEAD', sha);
  store.touch(repo);
  const object = repo.objects.get(sha);
  return json(201, { ref, node_id: globalId('ref', `${repo.owner}/${repo.name}/${ref.slice('refs/'.length)}`), object: { sha, type: object?.type ?? 'commit' } });
}

function listRepoCommits(repo: Repo, req: RestRequest): RestResponse {
  const ref = req.query.get('sha');
  const tip = resolveRefTip(repo, ref);
  if (tip === undefined) {
    if (ref !== null) return error(404, 'No commit found for SHA');
    return json(200, []);
  }
  const commits = listCommits(repo, tip).map((commit) => ({
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  }));
  return json(200, commits);
}

// ---------------------------------------------------------------- contents

function getContents(repo: Repo, req: RestRequest, pathParts: readonly string[]): RestResponse {
  const filePath = pathParts.join('/');
  const tip = resolveRefTip(repo, req.query.get('ref'));
  if (tip === undefined) return error(404, 'No commit found for the ref');
  const treeOid = commitTree(repo.objects, tip);
  if (treeOid === null) return error(404, 'Not Found');
  const found = lookupPath(repo.objects, treeOid, filePath);
  if (found === null) return error(404, 'Not Found');
  if (found.type === 'tree') {
    const object = repo.objects.get(found.oid)!;
    const entries = parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
      sha: entry.oid,
    }));
    return json(200, entries);
  }
  const blob = repo.objects.get(found.oid);
  if (blob === undefined) return error(404, 'Not Found');
  const name = pathParts[pathParts.length - 1] ?? '';
  return json(200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: found.oid,
    size: blob.data.length,
    name,
    path: filePath,
  });
}

function putContents(store: Store, repo: Repo, req: RestRequest, pathParts: readonly string[]): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const filePath = pathParts.join('/');
  const message = asString(body.message, 'Update file');
  const contentB64 = asString(body.content, '');
  const branch = asString(body.branch, repo.defaultBranch);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  let data: Buffer;
  try {
    data = Buffer.from(contentB64, 'base64');
  } catch {
    return error(400, 'content is not valid base64');
  }
  // Resolve the branch tip; a missing branch starts from the default branch tip (or unborn).
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const baseTree = tip === undefined ? null : commitTree(repo.objects, tip);
  const files = baseTree === null ? new Map<string, string>() : flattenTree(repo.objects, baseTree);
  const existing = files.get(filePath);
  if (sha !== undefined && existing !== sha) return error(409, 'sha does not match the current file');
  if (sha === undefined && existing !== undefined) return error(409, 'sha is required to update an existing file');
  const blobOid = hashObject('blob', data);
  repo.objects.set(blobOid, { type: 'blob', data });
  files.set(filePath, blobOid);
  const treeOid = buildTreeFromFiles(repo.objects, files);
  const commitOid = makeCommit(store, repo, treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  if (branch === repo.defaultBranch) repo.refs.set('HEAD', commitOid);
  store.touch(repo);
  const status = existing === undefined ? 201 : 200;
  return json(status, {
    content: {
      name: pathParts[pathParts.length - 1] ?? '',
      path: filePath,
      sha: blobOid,
      size: data.length,
      encoding: 'base64',
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(store: Store, repo: Repo, req: RestRequest, pathParts: readonly string[]): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const filePath = pathParts.join('/');
  const message = asString(body.message, 'Delete file');
  const branch = asString(body.branch, repo.defaultBranch);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return error(404, 'Not Found');
  const treeOid = commitTree(repo.objects, tip);
  if (treeOid === null) return error(404, 'Not Found');
  const files = flattenTree(repo.objects, treeOid);
  const existing = files.get(filePath);
  if (existing === undefined) return error(404, 'Not Found');
  if (sha !== undefined && existing !== sha) return error(409, 'sha does not match the current file');
  files.delete(filePath);
  const newTreeOid = buildTreeFromFiles(repo.objects, files);
  const commitOid = makeCommit(store, repo, newTreeOid, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  if (branch === repo.defaultBranch) repo.refs.set('HEAD', commitOid);
  store.touch(repo);
  return json(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- labels

function listLabels(repo: Repo): RestResponse {
  return json(200, [...repo.labels.values()].map(labelJson));
}

function createLabel(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const name = asString(body.name, '');
  if (name === '') return error(422, 'name is required');
  if (repo.labels.has(name)) return error(422, 'already exists');
  const label: Label = {
    id: repo.nextLabelId++,
    nodeId: globalId('label', `${repo.owner}/${repo.name}/${name}`),
    name,
    color: asString(body.color, 'ededed'),
    description: asString(body.description, ''),
  };
  repo.labels.set(name, label);
  return json(201, labelJson(label));
}

// ---------------------------------------------------------------- issues

/** Create an issue record (shared by REST, GraphQL and MCP). Returns an error string on failure. */
export function createIssueRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): { issue: Issue } | { error: string } {
  if (title === '') return { error: 'title is required' };
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `unknown label ${JSON.stringify(name)}` };
    labels.push(label);
  }
  const number = repo.nextNumber++;
  const now = store.nextTimestamp();
  const issue: Issue = {
    id: repo.nextIssueId++,
    nodeId: globalId('issue', `${repo.owner}/${repo.name}/${number}`),
    number,
    title,
    body,
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  repo.issueOrder.push(number);
  return { issue };
}

/** Close an issue record (shared by REST, GraphQL and MCP). */
export function closeIssueRecord(store: Store, issue: Issue): void {
  if (issue.state === 'closed') return;
  const now = store.nextTimestamp();
  issue.state = 'closed';
  issue.updatedAt = now;
  issue.closedAt = now;
  store.invalidateIssue(issue);
}

/** Add a comment to an issue (shared by REST, GraphQL and MCP). */
export function addCommentRecord(store: Store, repo: Repo, issue: Issue, text: string): Comment {
  const now = store.nextTimestamp();
  const commentId = repo.nextCommentId++;
  const comment: Comment = {
    id: commentId,
    nodeId: globalId('comment', `${repo.owner}/${repo.name}/${issue.number}/${commentId}`),
    body: text,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  store.invalidateIssue(issue);
  return comment;
}

function createIssue(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const title = asString(body.title, '');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((name): name is string => typeof name === 'string') : [];
  const created = createIssueRecord(store, repo, title, asString(body.body, ''), labelNames);
  if ('error' in created) return error(422, created.error);
  return { status: 201, headers: { 'content-type': 'application/json' }, body: issueJsonBuffer(created.issue, repo) };
}

function getIssue(repo: Repo, number: number): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  return { status: 200, headers: { 'content-type': 'application/json' }, body: issueJsonBuffer(issue, repo) };
}

function listIssues(repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  const { perPage, page } = pagination(req.query);
  const numbers = direction === 'asc' ? repo.issueOrder : [...repo.issueOrder].reverse();
  const matching: Buffer[] = [];
  for (const number of numbers) {
    const issue = repo.issues.get(number)!;
    if (state !== 'all' && issue.state !== state) continue;
    matching.push(issueJsonBuffer(issue, repo));
  }
  const total = matching.length;
  const slice = matching.slice((page - 1) * perPage, page * perPage);
  const parts: Buffer[] = [Buffer.from('[', 'ascii')];
  slice.forEach((buffer, index) => {
    if (index > 0) parts.push(Buffer.from(',', 'ascii'));
    parts.push(buffer);
  });
  parts.push(Buffer.from(']', 'ascii'));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const link = nextLink(req, req.path, perPage, page, total);
  if (link !== null) headers.link = link;
  return { status: 200, headers, body: Buffer.concat(parts) };
}

function patchIssue(store: Store, repo: Repo, number: number, req: RestRequest): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    if (body.state !== issue.state) {
      issue.state = body.state;
      const now = store.nextTimestamp();
      issue.updatedAt = now;
      issue.closedAt = body.state === 'closed' ? now : null;
    }
  } else if (typeof body.title === 'string' || typeof body.body === 'string') {
    issue.updatedAt = store.nextTimestamp();
  }
  store.invalidateIssue(issue);
  return { status: 200, headers: { 'content-type': 'application/json' }, body: issueJsonBuffer(issue, repo) };
}

function listComments(repo: Repo, number: number): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  return json(200, issue.comments.map(commentJson));
}

function createComment(store: Store, repo: Repo, number: number, req: RestRequest): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const text = asString(body.body, '');
  if (text === '') return error(422, 'body is required');
  const comment = addCommentRecord(store, repo, issue, text);
  return json(201, commentJson(comment));
}

// ---------------------------------------------------------------- pull requests

/** Create a pull-request record (shared by REST, GraphQL and MCP). */
export function createPullRecord(
  store: Store,
  repo: Repo,
  head: string,
  base: string,
  title: string,
  body: string,
): { pull: Pull } | { error: string } {
  if (head === '' || base === '' || title === '') return { error: 'head, base and title are required' };
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
  if (head === base) return { error: 'head and base must differ' };
  const number = repo.nextNumber++;
  const now = store.nextTimestamp();
  const pull: Pull = {
    id: repo.nextPullId++,
    nodeId: globalId('pull', `${repo.owner}/${repo.name}/${number}`),
    number,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.set(number, pull);
  repo.pullOrder.push(number);
  return { pull };
}

function createPull(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const created = createPullRecord(
    store,
    repo,
    asString(body.head, ''),
    asString(body.base, ''),
    asString(body.title, ''),
    asString(body.body, ''),
  );
  if ('error' in created) return error(422, created.error);
  return json(201, pullJson(created.pull, repo));
}

function getPull(repo: Repo, number: number): RestResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return error(404, 'Not Found');
  return json(200, pullJson(pull, repo));
}

function listPulls(repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const { perPage, page } = pagination(req.query);
  const numbers = [...repo.pullOrder].reverse();
  const matching: Pull[] = [];
  for (const number of numbers) {
    const pull = repo.pulls.get(number)!;
    if (state !== 'all' && pull.state !== state) continue;
    matching.push(pull);
  }
  const total = matching.length;
  const slice = matching.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const link = nextLink(req, req.path, perPage, page, total);
  if (link !== null) headers.link = link;
  return json(200, slice.map((pull) => pullJson(pull, repo)), headers);
}

/** The files a pull request changes, as a merge-base-to-head diff (shared by REST and GraphQL). */
export function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base === null ? null : commitTree(repo.objects, base);
  const headTree = commitTree(repo.objects, headTip);
  return diffTrees(repo.objects, baseTree, headTree).map((change) => ({
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
}

function listPullFiles(repo: Repo, number: number): RestResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return error(404, 'Not Found');
  return json(200, pullFiles(repo, pull));
}

/** Whether a pull request can merge cleanly (shared by REST, GraphQL and MCP). */
export function checkMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base === null ? null : commitTree(repo.objects, base);
  const headTree = commitTree(repo.objects, headTip);
  const baseTipTree = commitTree(repo.objects, baseTip);
  const headChanges = diffTrees(repo.objects, baseTree, headTree);
  const baseChanges = diffTrees(repo.objects, baseTree, baseTipTree);
  const headFiles = headTree === null ? new Map<string, string>() : flattenTree(repo.objects, headTree);
  const baseTipFiles = baseTipTree === null ? new Map<string, string>() : flattenTree(repo.objects, baseTipTree);
  const headChanged = new Set(headChanges.map((change) => change.path));
  for (const change of baseChanges) {
    if (!headChanged.has(change.path)) continue;
    if (headFiles.get(change.path) !== baseTipFiles.get(change.path)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request (shared by REST, GraphQL and MCP): the base tip's tree with the
 * head's changes applied, committed on the base branch. Returns the merge commit's sha.
 */
export function mergePullRecord(
  store: Store,
  repo: Repo,
  pull: Pull,
): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch is missing', status: 422 };
  if (checkMergeable(repo, pull) === 'CONFLICTING') return { error: 'Pull Request is not mergeable', status: 405 };
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base === null ? null : commitTree(repo.objects, base);
  const headTree = commitTree(repo.objects, headTip);
  const baseTipTree = commitTree(repo.objects, baseTip);
  const headChanges = diffTrees(repo.objects, baseTree, headTree);
  const headFiles = headTree === null ? new Map<string, string>() : flattenTree(repo.objects, headTree);
  const baseTipFiles = baseTipTree === null ? new Map<string, string>() : flattenTree(repo.objects, baseTipTree);
  const result = new Map(baseTipFiles);
  for (const change of headChanges) {
    if (change.status === 'removed') result.delete(change.path);
    else {
      const oid = headFiles.get(change.path);
      if (oid !== undefined) result.set(change.path, oid);
    }
  }
  const treeOid = buildTreeFromFiles(repo.objects, result);
  const mergeSha = makeCommit(store, repo, treeOid, [baseTip], `Merge pull request #${pull.number}: ${pull.title}`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  if (pull.baseRef === repo.defaultBranch) repo.refs.set('HEAD', mergeSha);
  store.touch(repo);
  const now = store.nextTimestamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = now;
  pull.closedAt = now;
  return { sha: mergeSha };
}

function mergePull(store: Store, repo: Repo, number: number, req: RestRequest): RestResponse {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return error(404, 'Not Found');
  const body = parseBody(req);
  if (body === null) return error(400, 'request body is not valid JSON');
  const merged = mergePullRecord(store, repo, pull);
  if ('error' in merged) return error(merged.status, merged.error);
  return json(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- the router

/** The number in a path segment, or null when it is not a plain integer. */
function pathNumber(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d+$/.test(segment)) return null;
  return Number(segment);
}

/**
 * Handle a REST request. Returns handled:false when the path is not under /api/v3.
 * The forge is single-owner: any owner other than the viewer is a 404, never a 403.
 */
export function handleRest(store: Store, req: RestRequest): { handled: boolean; response: RestResponse } {
  const notHandled = { handled: false, response: { status: 404, headers: {}, body: Buffer.alloc(0) } };
  const parts = req.path.split('/').filter((part) => part !== '');
  if (parts.length < 2 || parts[0] !== 'api' || parts[1] !== 'v3') return notHandled;
  // parts[0] === 'api', parts[1] === 'v3'.
  const rest = parts.slice(2);

  // The two public answers (the starter served them without a token).
  if (rest.length === 0) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return {
      handled: true,
      response: json(
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_repositories_url: '/api/v3/user/repos',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      ),
    };
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: json(200, { installed_version: '1.0.0' }) };
  }

  if (!req.authed) return { handled: true, response: error(401, 'Requires authentication') };

  if (rest[0] === 'user' && rest.length === 1) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return {
      handled: true,
      response: json(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: globalId('user', VIEWER_LOGIN),
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
        html_url: `https://github.example/${VIEWER_LOGIN}`,
        created_at: '2025-01-01T00:00:00.000Z',
      }),
    };
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (req.method === 'GET') return { handled: true, response: listUserRepos(store, req) };
    if (req.method === 'POST') return { handled: true, response: createUserRepo(store, req) };
    return { handled: true, response: error(404, 'Not Found') };
  }

  if (rest[0] !== 'repos' || rest.length < 3) return { handled: true, response: error(404, 'Not Found') };
  const owner = decodeURIComponent(rest[1]!);
  const name = decodeURIComponent(rest[2]!);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(name) : undefined;
  if (repo === undefined) return { handled: true, response: error(404, 'Not Found') };
  const sub = rest.slice(3);

  if (sub.length === 0) {
    if (req.method === 'GET') return { handled: true, response: getRepo(repo) };
    if (req.method === 'PATCH') return { handled: true, response: patchRepo(store, repo, req) };
    if (req.method === 'DELETE') return { handled: true, response: deleteRepo(store, repo) };
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'branches' && sub.length === 1) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: listBranches(repo) };
  }
  if (sub[0] === 'branches' && sub.length > 1) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: getBranch(repo, sub.slice(1).map(decodeURIComponent).join('/')) };
  }
  if (sub[0] === 'git' && sub[1] === 'refs' && sub.length === 2) {
    if (req.method !== 'POST') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: createRef(store, repo, req) };
  }
  if (sub[0] === 'git' && sub[1] === 'refs' && sub.length > 2) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: getRef(repo, sub.slice(2).map(decodeURIComponent).join('/')) };
  }
  if (sub[0] === 'commits' && sub.length === 1) {
    if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
    return { handled: true, response: listRepoCommits(repo, req) };
  }
  if (sub[0] === 'contents') {
    if (req.method === 'GET') return { handled: true, response: getContents(repo, req, sub.slice(1).map(decodeURIComponent)) };
    if (req.method === 'PUT') return { handled: true, response: putContents(store, repo, req, sub.slice(1).map(decodeURIComponent)) };
    if (req.method === 'DELETE') return { handled: true, response: deleteContents(store, repo, req, sub.slice(1).map(decodeURIComponent)) };
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'labels' && sub.length === 1) {
    if (req.method === 'GET') return { handled: true, response: listLabels(repo) };
    if (req.method === 'POST') return { handled: true, response: createLabel(store, repo, req) };
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'issues' && sub.length === 1) {
    if (req.method === 'GET') return { handled: true, response: listIssues(repo, req) };
    if (req.method === 'POST') return { handled: true, response: createIssue(store, repo, req) };
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'issues' && sub.length >= 2) {
    const number = pathNumber(sub[1]);
    if (number === null) return { handled: true, response: error(404, 'Not Found') };
    if (sub.length === 2) {
      if (req.method === 'GET') return { handled: true, response: getIssue(repo, number) };
      if (req.method === 'PATCH') return { handled: true, response: patchIssue(store, repo, number, req) };
      return { handled: true, response: error(404, 'Not Found') };
    }
    if (sub[2] === 'comments' && sub.length === 3) {
      if (req.method === 'GET') return { handled: true, response: listComments(repo, number) };
      if (req.method === 'POST') return { handled: true, response: createComment(store, repo, number, req) };
    }
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'pulls' && sub.length === 1) {
    if (req.method === 'GET') return { handled: true, response: listPulls(repo, req) };
    if (req.method === 'POST') return { handled: true, response: createPull(store, repo, req) };
    return { handled: true, response: error(404, 'Not Found') };
  }
  if (sub[0] === 'pulls' && sub.length >= 2) {
    const number = pathNumber(sub[1]);
    if (number === null) return { handled: true, response: error(404, 'Not Found') };
    if (sub.length === 2) {
      if (req.method !== 'GET') return { handled: true, response: error(404, 'Not Found') };
      return { handled: true, response: getPull(repo, number) };
    }
    if (sub[2] === 'files' && sub.length === 3 && req.method === 'GET') {
      return { handled: true, response: listPullFiles(repo, number) };
    }
    if (sub[2] === 'merge' && sub.length === 3 && req.method === 'PUT') {
      return { handled: true, response: mergePull(store, repo, number, req) };
    }
    return { handled: true, response: error(404, 'Not Found') };
  }
  return { handled: true, response: error(404, 'Not Found') };
}
