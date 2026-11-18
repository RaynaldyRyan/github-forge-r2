// The MCP endpoint (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28): server/discover,
// initialize (the pre-discover handshake), tools/list and tools/call over the same store the REST
// surface reads, so every tool effect is visible over REST. Answers are single JSON bodies.
//
// The six tools use the github-mcp-server argument names, and every inputSchema keeps its required
// list to exactly the arguments the suite fills — a required property the suite cannot fill fails
// the check before the call is made. tools/list is built from one constant, so two answers hold
// the same tools array byte for byte.

import { VIEWER_LOGIN, type Store, type Repo } from './store.ts';
import {
  repoJson,
  pullJson,
  issueObject,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
} from './rest.ts';
import type { GitRequest, GitResponse } from './git.ts';

export type McpRequest = GitRequest;
export type McpResponse = GitResponse;

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '2.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

/** The tool list: one constant, serialized identically on every tools/list answer. */
const TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- JSON-RPC plumbing

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
  };
}

function rpcError(id: RpcId, code: number, message: string, status = 200): McpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8'),
  };
}

/** A tool result: the JSON as a text block, mirrored as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A tool execution failure: isError:true with a text message. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- argument reading

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Read owner/repo from the arguments, accepting the documented synonyms and full_name. */
function readRepoRef(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = asString(args.full_name ?? args.repo_full_name ?? args.repository_full_name);
  if (fullName !== null && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = asString(args.owner ?? args.owner_login ?? args.login ?? args.user);
  const repo = asString(args.repo ?? args.repository ?? args.repo_name ?? args.repository_name);
  if (owner === null || repo === null) return null;
  return { owner, repo };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const ref = readRepoRef(args);
  if (ref === null || ref.owner !== VIEWER_LOGIN) return null;
  return store.getRepo(ref.repo) ?? null;
}

// ---------------------------------------------------------------- tools/call

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcCode: number; message: string } {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name ?? args.repo ?? args.repository);
      if (repoName === null || repoName === '') return { result: toolError('name is required') };
      const repo = store.createRepo(
        repoName,
        asString(args.description ?? args.body) ?? '',
        asBoolean(args.private ?? args.is_private) ?? false,
      );
      if (repo === null) return { result: toolError(`repository ${JSON.stringify(repoName)} already exists`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolError('repository not found') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolError('repository not found') };
      const title = asString(args.title ?? args.issue_title ?? args.subject);
      if (title === null || title === '') return { result: toolError('title is required') };
      const created = createIssueRecord(store, repo, title, asString(args.body ?? args.content ?? args.text) ?? '', []);
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(issueObject(created.issue, repo)) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolError('repository not found') };
      const state = asString(args.state ?? args.status) ?? 'open';
      const issues = repo.issueOrder
        .map((number) => repo.issues.get(number)!)
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueObject(issue, repo));
      return { result: toolResult(issues) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolError('repository not found') };
      const title = asString(args.title ?? args.pr_title ?? args.subject);
      const head = asString(args.head ?? args.head_ref ?? args.head_branch ?? args.source ?? args.source_branch);
      const base = asString(args.base ?? args.base_ref ?? args.base_branch ?? args.target ?? args.target_branch);
      if (title === null || title === '' || head === null || head === '' || base === null || base === '') {
        return { result: toolError('title, head and base are required') };
      }
      const created = createPullRecord(store, repo, head, base, title, asString(args.body ?? args.content ?? args.text) ?? '');
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(pullJson(created.pull, repo)) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: toolError('repository not found') };
      const number = asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number ?? args.issue_number);
      if (number === null) return { result: toolError('pull_number is required') };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { result: toolError(`pull request #${number} not found`) };
      const merged = mergePullRecord(store, repo, pull);
      if ('error' in merged) return { result: toolError(merged.error) };
      return { result: toolResult({ merged: true, sha: merged.sha, number: pull.number, state: pull.state }) };
    }
    default:
      return { rpcCode: -32601, message: `Method not found: ${name}` };
  }
}

// ---------------------------------------------------------------- the HTTP handler

/**
 * Handle POST /mcp. Returns handled:false for any other path.
 * A notification (no id) answers 202 with no body; a malformed body is HTTP 400 + -32700.
 */
export function handleMcp(store: Store, req: McpRequest): { handled: boolean; response: McpResponse } {
  const notHandled = { handled: false, response: { status: 404, headers: {}, body: Buffer.alloc(0) } };
  if (req.path !== '/mcp') return notHandled;
  if (req.method !== 'POST') {
    return {
      handled: true,
      response: { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"Not Found"}', 'utf8') },
    };
  }
  if (!req.authed) {
    return {
      handled: true,
      response: { status: 401, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"Requires authentication"}', 'utf8') },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.length === 0 ? '{}' : req.body.toString('utf8'));
  } catch {
    return { handled: true, response: rpcError(null, -32700, 'Parse error', 400) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { handled: true, response: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId =
    typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params =
    request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  if (isNotification) {
    // A notification (notifications/initialized, notifications/cancelled) carries no answer.
    return { handled: true, response: { status: 202, headers: {}, body: Buffer.alloc(0) } };
  }

  switch (method) {
    case 'server/discover':
      return {
        handled: true,
        response: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        handled: true,
        response: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'tools/list':
      return { handled: true, response: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const outcome = callTool(store, toolName, args);
      if ('rpcCode' in outcome) return { handled: true, response: rpcError(id, outcome.rpcCode, outcome.message) };
      return { handled: true, response: rpcResult(id, outcome.result) };
    }
    case 'ping':
      return { handled: true, response: rpcResult(id, {}) };
    default:
      return { handled: true, response: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
