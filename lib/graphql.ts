// A minimal GraphQL executor for the contest's 18 documents: a small recursive-descent parser
// (operations, fields, aliases, arguments, variables, lists, input objects, inline fragments)
// over a resolver table for the Query, Mutation, Repository, Issue, PullRequest, node() and
// __type surfaces the checks exercise. Unknown fields are reported as GraphQL errors with
// HTTP 200, never as HTTP errors; a missing token is HTTP 401; batched bodies answer in order.

import {
  VIEWER_LOGIN,
  parseGlobalId,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import {
  createIssueRecord,
  closeIssueRecord,
  createPullRecord,
  mergePullRecord,
  addCommentRecord,
  checkMergeable,
  pullFiles,
} from './rest.ts';
import type { GitRequest, GitResponse } from './git.ts';

export type GraphQLRequest = GitRequest;
export type GraphQLResponse = GitResponse;

// ---------------------------------------------------------------- the parser

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'spread' }
  | { kind: 'variable'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():[]!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      if (match === null) throw new Error(`bad variable at offset ${i}`);
      tokens.push({ kind: 'variable', value: match[0].slice(1) });
      i += match[0].length;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string in GraphQL document');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at offset ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (nameMatch !== null) {
      tokens.push({ kind: 'name', value: nameMatch[0] });
      i += nameMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, ValueNode>;
  readonly selection: Selection[] | null;
}

interface FragmentSelection {
  readonly kind: 'fragment';
  readonly typeCondition: string;
  readonly selection: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') {
        name = maybeName.value;
        this.next();
      }
      if (this.atPunct('(')) this.parseVariableDefinitions();
    }
    const selection = this.parseSelectionSet();
    return { kind, name, selection };
  }

  /** Consume the variable definitions; the types are not needed, only the names exist in the body. */
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new Error('only inline fragments are supported');
      const typeToken = this.next();
      if (typeToken.kind !== 'name') throw new Error('an inline fragment needs a type condition');
      return { kind: 'fragment', typeCondition: typeToken.value, selection: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('a selection must start with a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('an aliased field needs a name after the colon');
      name = nameToken.value;
    }
    let args: Record<string, ValueNode> = {};
    if (this.atPunct('(')) args = this.parseArguments();
    let selection: Selection[] | null = null;
    if (this.atPunct('{')) selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!this.atPunct(')')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('an argument needs a name');
      this.expectPunct(':');
      args[nameToken.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'variable':
        return { kind: 'variable', name: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.atPunct(']')) items.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Record<string, ValueNode> = {};
          while (!this.atPunct('}')) {
            const nameToken = this.next();
            if (nameToken.kind !== 'name') throw new Error('an input object field needs a name');
            this.expectPunct(':');
            fields[nameToken.value] = this.parseValue();
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${JSON.stringify(token.value)} in a value`);
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('unexpected token in a value');
    }
  }
}

// ---------------------------------------------------------------- values and cursors

/** Resolve a parsed value against the request's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

/** An opaque issue cursor: base64url of `issue:<number>`. */
function encodeIssueCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function decodeIssueCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the resolver table

/** A resolved object: its GraphQL type plus the store record(s) its fields read. */
interface TypedValue {
  readonly __type: string;
  readonly value: unknown;
}

interface ExecContext {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly errors: { message: string }[];
}

type Resolver = (ctx: ExecContext, value: unknown, args: Record<string, unknown>) => unknown;

const ISSUE_STATE = (state: string): string => (state === 'closed' ? 'CLOSED' : 'OPEN');
const PULL_STATE = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN');

function issueConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  let numbers = [...repo.issueOrder].reverse(); // CREATED_AT DESC, GitHub's default
  const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
  if (orderBy?.direction === 'ASC') numbers = [...repo.issueOrder];
  const states = args.states as unknown[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')));
    numbers = numbers.filter((number) => wanted.has(repo.issues.get(number)!.state));
  }
  const afterNumber = decodeIssueCursor(args.after);
  if (afterNumber !== null) {
    const index = numbers.indexOf(afterNumber);
    if (index >= 0) numbers = numbers.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : numbers.length;
  const page = numbers.slice(0, first);
  const hasNextPage = numbers.length > first;
  const endCursor = page.length > 0 ? encodeIssueCursor(page[page.length - 1]!) : null;
  return {
    __type: 'IssueConnection',
    value: { nodes: page.map((number) => repo.issues.get(number)!), pageInfo: { hasNextPage, endCursor } },
  };
}

/** Decode a global id into the repository (and number) it names, or null. */
function resolveGlobalId(
  store: Store,
  id: unknown,
): { repo: Repo; number?: number; comment?: number } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const [kind, key] = parsed;
  const parts = key.split('/');
  if (parts[0] !== VIEWER_LOGIN) return null;
  const repo = store.getRepo(parts[1] ?? '');
  if (repo === undefined) return null;
  if (kind === 'repo') return { repo };
  if (kind === 'issue' || kind === 'pull') {
    const number = Number(parts[2]);
    if (!Number.isInteger(number)) return null;
    return { repo, number };
  }
  if (kind === 'comment') {
    const number = Number(parts[2]);
    const comment = Number(parts[3]);
    if (!Number.isInteger(number) || !Number.isInteger(comment)) return null;
    return { repo, number, comment };
  }
  return null;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'closedAt', 'body', 'author', 'repository', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT'],
};

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User', value: null }),
    repository: (ctx, _value, args) => {
      if (args.owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(String(args.name ?? ''));
      return repo === undefined ? null : { __type: 'Repository', value: repo };
    },
    node: (ctx, _value, args) => {
      const resolved = resolveGlobalId(ctx.store, args.id);
      if (resolved === null) return null;
      const parsed = parseGlobalId(String(args.id));
      const kind = parsed?.[0];
      if (kind === 'repo') return { __type: 'Repository', value: resolved.repo };
      if (kind === 'issue' && resolved.number !== undefined) {
        const issue = resolved.repo.issues.get(resolved.number);
        return issue === undefined ? null : { __type: 'Issue', value: { repo: resolved.repo, issue } };
      }
      if (kind === 'pull' && resolved.number !== undefined) {
        const pull = resolved.repo.pulls.get(resolved.number);
        return pull === undefined ? null : { __type: 'PullRequest', value: { repo: resolved.repo, pull } };
      }
      return null;
    },
    __type: (_ctx, _value, args) => {
      const name = String(args.name ?? '');
      if (!(name in TYPE_FIELDS)) return null;
      return { __type: '__Type', value: name };
    },
  },
  Mutation: {
    createIssue: (ctx, _value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = resolveGlobalId(ctx.store, input.repositoryId);
      if (resolved === null) throw new Error('repositoryId does not name a repository');
      const created = createIssueRecord(ctx.store, resolved.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) throw new Error(created.error);
      return { __type: 'CreateIssuePayload', value: { repo: resolved.repo, issue: created.issue } };
    },
    closeIssue: (ctx, _value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = resolveGlobalId(ctx.store, input.issueId);
      if (resolved === null || resolved.number === undefined) throw new Error('issueId does not name an issue');
      const issue = resolved.repo.issues.get(resolved.number);
      if (issue === undefined) throw new Error('issueId does not name an issue');
      closeIssueRecord(ctx.store, issue);
      return { __type: 'CloseIssuePayload', value: { repo: resolved.repo, issue } };
    },
    createPullRequest: (ctx, _value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = resolveGlobalId(ctx.store, input.repositoryId);
      if (resolved === null) throw new Error('repositoryId does not name a repository');
      const created = createPullRecord(
        ctx.store,
        resolved.repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        String(input.body ?? ''),
      );
      if ('error' in created) throw new Error(created.error);
      return { __type: 'CreatePullRequestPayload', value: { repo: resolved.repo, pull: created.pull } };
    },
    mergePullRequest: (ctx, _value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = resolveGlobalId(ctx.store, input.pullRequestId);
      if (resolved === null || resolved.number === undefined) throw new Error('pullRequestId does not name a pull request');
      const pull = resolved.repo.pulls.get(resolved.number);
      if (pull === undefined) throw new Error('pullRequestId does not name a pull request');
      const merged = mergePullRecord(ctx.store, resolved.repo, pull);
      if ('error' in merged) throw new Error(merged.error);
      return { __type: 'MergePullRequestPayload', value: { repo: resolved.repo, pull } };
    },
    addComment: (ctx, _value, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = resolveGlobalId(ctx.store, input.subjectId);
      if (resolved === null || resolved.number === undefined) throw new Error('subjectId does not name an issue');
      const issue = resolved.repo.issues.get(resolved.number);
      if (issue === undefined) throw new Error('subjectId does not name an issue');
      const comment = addCommentRecord(ctx.store, resolved.repo, issue, String(input.body ?? ''));
      return { __type: 'AddCommentPayload', value: { repo: resolved.repo, issue, comment } };
    },
  },
  User: {
    login: () => VIEWER_LOGIN,
    id: () => 'user:adaiversen',
    name: () => 'ada iversen',
  },
  Repository: {
    id: (_ctx, value) => (value as Repo).nodeId,
    databaseId: (_ctx, value) => (value as Repo).id,
    name: (_ctx, value) => (value as Repo).name,
    nameWithOwner: (_ctx, value) => `${(value as Repo).owner}/${(value as Repo).name}`,
    owner: () => ({ __type: 'User', value: null }),
    defaultBranchRef: (_ctx, value) => ({ __type: 'Ref', value: { name: (value as Repo).defaultBranch } }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (_ctx, value, args) => {
      const repo = value as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : { __type: 'Issue', value: { repo, issue } };
    },
    issues: (_ctx, value, args) => issueConnection(value as Repo, args),
    pullRequests: (_ctx, value, args) => {
      const repo = value as Repo;
      const first = typeof args.first === 'number' ? args.first : repo.pullOrder.length;
      const numbers = [...repo.pullOrder].reverse().slice(0, first);
      return { __type: 'PullRequestConnection', value: numbers.map((number) => ({ repo, pull: repo.pulls.get(number)! })) };
    },
    pullRequest: (_ctx, value, args) => {
      const repo = value as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : { __type: 'PullRequest', value: { repo, pull } };
    },
  },
  Issue: {
    id: (_ctx, value) => (value as { issue: Issue }).issue.nodeId,
    number: (_ctx, value) => (value as { issue: Issue }).issue.number,
    title: (_ctx, value) => (value as { issue: Issue }).issue.title,
    state: (_ctx, value) => ISSUE_STATE((value as { issue: Issue }).issue.state),
    body: (_ctx, value) => (value as { issue: Issue }).issue.body,
  },
  IssueConnection: {
    nodes: (_ctx, value) => (value as { nodes: Issue[] }).nodes.map((issue) => ({ __type: 'Issue', value: { repo: null, issue } })),
    pageInfo: (_ctx, value) => ({ __type: 'PageInfo', value: (value as { pageInfo: unknown }).pageInfo }),
  },
  PageInfo: {
    hasNextPage: (_ctx, value) => (value as { hasNextPage: boolean }).hasNextPage,
    endCursor: (_ctx, value) => (value as { endCursor: string | null }).endCursor,
  },
  PullRequest: {
    id: (_ctx, value) => (value as { pull: Pull }).pull.nodeId,
    number: (_ctx, value) => (value as { pull: Pull }).pull.number,
    state: (_ctx, value) => PULL_STATE((value as { pull: Pull }).pull),
    merged: (_ctx, value) => (value as { pull: Pull }).pull.merged,
    headRefName: (_ctx, value) => (value as { pull: Pull }).pull.headRef,
    baseRefName: (_ctx, value) => (value as { pull: Pull }).pull.baseRef,
    mergeable: (_ctx, value) => {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      return checkMergeable(repo, pull);
    },
    files: (_ctx, value, args) => {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = pullFiles(repo, pull).slice(0, first);
      return { __type: 'PullRequestChangedFileConnection', value: files.map((file) => file.filename) };
    },
  },
  PullRequestConnection: {
    nodes: (_ctx, value) => (value as { repo: Repo; pull: Pull }[]).map((entry) => ({ __type: 'PullRequest', value: entry })),
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, value) => (value as string[]).map((path) => ({ __type: 'PullRequestChangedFile', value: path })),
  },
  PullRequestChangedFile: {
    path: (_ctx, value) => value as string,
  },
  Ref: {
    name: (_ctx, value) => (value as { name: string }).name,
  },
  __Type: {
    fields: (_ctx, value) => (TYPE_FIELDS[value as string] ?? []).map((name) => ({ __type: '__Field', value: name })),
    enumValues: (_ctx, value) => (TYPE_ENUM_VALUES[value as string] ?? []).map((name) => ({ __type: '__EnumValue', value: name })),
    name: (_ctx, value) => value as string,
  },
  __Field: {
    name: (_ctx, value) => value as string,
  },
  __EnumValue: {
    name: (_ctx, value) => value as string,
  },
  CreateIssuePayload: {
    issue: (_ctx, value) => ({ __type: 'Issue', value: value as { repo: Repo; issue: Issue } }),
  },
  CloseIssuePayload: {
    issue: (_ctx, value) => ({ __type: 'Issue', value: value as { repo: Repo; issue: Issue } }),
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, value) => ({ __type: 'PullRequest', value: value as { repo: Repo; pull: Pull } }),
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, value) => ({ __type: 'PullRequest', value: value as { repo: Repo; pull: Pull } }),
  },
  AddCommentPayload: {
    commentEdge: (_ctx, value) => ({ __type: 'IssueCommentEdge', value }),
  },
  IssueCommentEdge: {
    node: (_ctx, value) => ({ __type: 'IssueComment', value }),
  },
  IssueComment: {
    id: (_ctx, value) => (value as { comment: { nodeId: string } }).comment.nodeId,
    body: (_ctx, value) => (value as { comment: { body: string } }).comment.body,
  },
};

// ---------------------------------------------------------------- the executor

function executeSelection(ctx: ExecContext, typed: TypedValue, selections: readonly Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typed.__type) {
        Object.assign(out, executeSelection(ctx, typed, selection.selection));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const resolver = FIELDS[typed.__type]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typed.__type}".` });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(selection.args)) args[key] = resolveValue(node, ctx.variables);
    let value: unknown;
    try {
      value = resolver(ctx, typed.value, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, value, selection.selection);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, selection: readonly Selection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    if (selection === null) return null;
    return executeSelection(ctx, value as TypedValue, selection);
  }
  return value;
}

/** Execute one operation document; returns the response body object. */
function executeOperation(
  store: Store,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'query is required' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    operationName === null
      ? operations[0]!
      : (operations.find((candidate) => candidate.name === operationName) ?? operations[0]!);
  const variables =
    body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};
  const ctx: ExecContext = { store, variables, errors: [] };
  const root: TypedValue = { __type: operation.kind === 'mutation' ? 'Mutation' : 'Query', value: null };
  const data = executeSelection(ctx, root, operation.selection);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------- the HTTP handler

/**
 * Handle POST /api/graphql. Returns handled:false for any other path.
 * Unauthenticated requests are HTTP 401; a batched array body answers an array in order.
 */
export function handleGraphQL(store: Store, req: GraphQLRequest): { handled: boolean; response: GraphQLResponse } {
  const notHandled = { handled: false, response: { status: 404, headers: {}, body: Buffer.alloc(0) } };
  if (req.path !== '/api/graphql') return notHandled;
  if (req.method !== 'POST') {
    return {
      handled: true,
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"message":"Not Found"}', 'utf8'),
      },
    };
  }
  if (!req.authed) {
    return {
      handled: true,
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"message":"Requires authentication"}', 'utf8'),
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.length === 0 ? '{}' : req.body.toString('utf8'));
  } catch {
    return {
      handled: true,
      response: {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ errors: [{ message: 'request body is not valid JSON' }] }), 'utf8'),
      },
    };
  }
  const bodies = Array.isArray(parsed) ? parsed : [parsed];
  const responses = bodies.map((entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? executeOperation(store, entry as { query?: unknown; variables?: unknown; operationName?: unknown })
      : { errors: [{ message: 'each batched operation must be an object' }] },
  );
  return {
    handled: true,
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]), 'utf8'),
    },
  };
}
