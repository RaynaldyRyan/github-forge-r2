// The forge's in-memory store: every repository, git object, ref, issue, pull request, label and
// comment, plus the deterministic clock and the per-repository caches the benchmark leans on.
//
// Determinism: nothing here reads a wall clock or Math.random. Every timestamp comes from
// MAKEFUN_TRIAL_NOW (an RFC 3339 instant or epoch milliseconds) plus a monotonic per-event tick, so
// two runs that see the same requests in the same order produce byte-identical answers. The viewer
// identity is the contest's fixed scenario identity (wire.ts's fixed seed names the viewer
// "adaiversen"); the env's checks always speak as that user, so the forge is single-owner.

/** The token owner's login, from the contest's fixed scenario seed. */
export const VIEWER_LOGIN = 'adaiversen';
/** The token owner's numeric id, from the same fixed scenario. */
export const VIEWER_ID = 1000;
/** The token owner's display name and email, from the same fixed scenario. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
/** The fallback "now" when MAKEFUN_TRIAL_NOW is unset: the scenario epoch, 2025-01-01T00:00:00Z. */
export const FALLBACK_NOW_MS = 1_735_689_600_000;

/** Parse MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms) into milliseconds; the fallback when unset/unparseable. */
export function parseTrialNow(value: string | undefined): number {
  if (value === undefined || value === '') return FALLBACK_NOW_MS;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? ms : FALLBACK_NOW_MS;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
}

/** A git object: its type and raw bytes. */
export interface GitObject {
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly data: Buffer;
}

/** A label on a repository. */
export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** A comment on an issue. */
export interface Comment {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An issue. `jsonCache` is the pre-serialized REST body, rebuilt on any mutation. */
export interface Issue {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: Comment[];
  jsonCache: Buffer | null;
}

/** A pull request. `headSha`/`baseSha` are the tips at creation; the live head tip is read from the ref. */
export interface Pull {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** One repository: git state, REST state, and the caches the hot paths read. */
export interface Repo {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Object id -> object. The only object store; no filesystem anywhere. */
  readonly objects: Map<string, GitObject>;
  /** Ref name -> object id. */
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  /** Issue numbers in creation order (the sort=created order). */
  readonly issueOrder: number[];
  readonly pulls: Map<number, Pull>;
  readonly pullOrder: number[];
  readonly labels: Map<string, Label>;
  /** Shared issue/pull-request number counter (GitHub numbers them from one sequence). */
  nextNumber: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextLabelId: number;
  /** Bumped on every mutation; the git caches key off it. */
  version: number;
  /** Cached v0 ref advertisement (receive-pack and upload-pack share the ref list; the service line differs). */
  advCache: { version: number; upload: Buffer; receive: Buffer } | null;
  /** Cached v2 ls-refs responses by argument signature. */
  lsRefsCache: Map<string, { version: number; body: Buffer }>;
  /** Cached v2 fetch responses for the depth-1 single-want shape, by tip oid. */
  fetchCache: Map<string, { version: number; body: Buffer }>;
}

/** A global id: base64url of a typed key. Opaque (never the plain number), stable, decodable. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back to [kind, key], or null when it is not one of ours. */
export function parseGlobalId(id: string): [string, string] | null {
  if (typeof id !== 'string' || id === '' || id.length > 512) return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return [text.slice(0, at), text.slice(at + 1)];
  } catch {
    return null;
  }
}

/** The whole forge: the repository map, the id counters and the deterministic clock. */
export class Store {
  /** Repositories by name (single owner, so the name is the key). */
  readonly repos = new Map<string, Repo>();
  /** Repository database ids, in creation order. */
  readonly repoOrder: string[] = [];
  private nextRepoId = 1;
  private readonly baseNowMs: number;
  /** Monotonic event counter: every timestamped event takes the next tick (1 s apart). */
  private tickCount = 0;

  constructor(nowMs: number) {
    this.baseNowMs = nowMs;
  }

  /** The next deterministic timestamp, ISO 8601, one second after the previous event's. */
  nextTimestamp(): string {
    const ms = this.baseNowMs + this.tickCount * 1000;
    this.tickCount += 1;
    return new Date(ms).toISOString();
  }

  /** The next deterministic Unix timestamp in seconds, for a commit or tag object. */
  nextEpochSec(): number {
    return Math.floor(this.baseNowMs / 1000) + this.tickCount++;
  }

  /** The current tick's epoch seconds without advancing (for a commit that shares its event's time). */
  epochSec(): number {
    return Math.floor(this.baseNowMs / 1000) + this.tickCount;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** Create a repository; null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const now = this.nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      nodeId: globalId('repo', `${VIEWER_LOGIN}/${name}`),
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      issueOrder: [],
      pulls: new Map(),
      pullOrder: [],
      labels: new Map(),
      nextNumber: 1,
      nextIssueId: 1,
      nextPullId: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      version: 0,
      advCache: null,
      lsRefsCache: new Map(),
      fetchCache: new Map(),
    };
    this.repos.set(name, repo);
    this.repoOrder.push(name);
    return repo;
  }

  /** Delete a repository; false when it did not exist. */
  deleteRepo(name: string): boolean {
    if (!this.repos.has(name)) return false;
    this.repos.delete(name);
    const at = this.repoOrder.indexOf(name);
    if (at >= 0) this.repoOrder.splice(at, 1);
    return true;
  }

  /** Mark a repository mutated: bump its version and drop its git caches. */
  touch(repo: Repo): void {
    repo.version += 1;
    repo.advCache = null;
    repo.lsRefsCache.clear();
    repo.fetchCache.clear();
  }

  /** Drop one issue's cached REST JSON (call on any mutation of the issue). */
  invalidateIssue(issue: Issue): void {
    issue.jsonCache = null;
  }
}
