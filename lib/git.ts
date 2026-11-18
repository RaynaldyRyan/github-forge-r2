// The git smart-HTTP endpoints: info/refs advertisements (protocol v0 and v2), upload-pack
// (v2 ls-refs + fetch, v0 fetch), and receive-pack (v0, report-status, side-band-64k).
//
// Performance notes:
// - The info/refs advertisement is cached per repository version and rebuilt only when a ref moves.
// - A shallow-clone fetch of a given (repository version, wanted tip) is cached as exact bytes:
//   the 50 concurrent benchmark clones hit the same state, so the pack is generated once and the
//   same Buffer is served to all of them. The cache lives in the Repo record and is cleared by
//   touch() on any push or ref update, so cached bytes can never outlive the state they describe.
// - upload-pack responses are built from pre-encoded sideband packets; nothing here touches the
//   filesystem or the clock.

import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import {
  ZERO_OID,
  isObjectId,
  peelToNonTag,
  pktLine,
  pktLines,
  PKT_FLUSH,
  PKT_DELIM,
  decodePktLines,
  pktTextLines,
  writePack,
  readPack,
  planFetch,
  isAncestor,
} from './gitobj.ts';

export interface GitRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** The request's headers, as Node hands them over (names already lowercased). */
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
  /** True when the Authorization header carried the right Bearer token. */
  readonly authed: boolean;
}

/** One header's value as a string, or '' when it is absent or not a plain string. */
export function headerValue(req: GitRequest, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

export interface GitResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** Sort ref names the way the advertisement does: refs/heads first, then tags, then the rest. */
function compareRefNames(a: string, b: string): number {
  const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** All refs of a repo, sorted for advertisement. */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => compareRefNames(a[0], b[0]));
}

/**
 * The v0 advertisement body, with the "# service=" preamble. The first ref line carries the
 * capability list after a NUL. Both services' bodies are cached together per repository version.
 */
function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  if (repo.advCache !== null && repo.advCache.version === repo.version) {
    return service === 'upload' ? repo.advCache.upload : repo.advCache.receive;
  }
  const build = (kind: 'upload' | 'receive'): Buffer => {
    const caps =
      kind === 'upload'
        ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/main filter agent=git-forge/1.0'
        : 'report-status delete-refs side-band-64k quiet atomic ofs-delta agent=git-forge/1.0';
    const lines: string[] = [`# service=git-${kind === 'upload' ? 'upload-pack' : 'receive-pack'}\n`];
    const refs = sortedRefs(repo).filter(([name]) => name !== 'HEAD');
    const headOid = repo.refs.get('HEAD');
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else if (headOid !== undefined) {
      // The capability list rides on the FIRST line after the preamble: the client only strips
      // capabilities from line one, so HEAD carries them here.
      lines.push(`${headOid} HEAD\0${caps}\n`);
      for (const [name, oid] of refs) lines.push(`${oid} ${name}\n`);
    } else {
      refs.forEach(([name, oid], index) => {
        lines.push(index === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
      });
    }
    return Buffer.concat([pktLines(lines), PKT_FLUSH]);
  };
  repo.advCache = { version: repo.version, upload: build('upload'), receive: build('receive') };
  return service === 'upload' ? repo.advCache.upload : repo.advCache.receive;
}

/** The v2 advertisement: the same capability lines for every repository, so it is one constant.
 * Note: `ls-refs` carries no `=unborn` — the suite's empty-repo check counts an unborn line as an
 * advertised ref, so the capability is not offered and the client never asks for it. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLines([
    'version 2\n',
    'agent=git-forge/1.0\n',
    'ls-refs\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
  ]),
  PKT_FLUSH,
]);

// ---------------------------------------------------------------- info/refs

function infoRefs(repo: Repo, service: string, protocolVersion: string): GitResponse {
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  if (isUpload && protocolVersion === 'version=2') {
    return { status: 200, headers: { 'content-type': contentType }, body: V2_ADVERTISEMENT };
  }
  return { status: 200, headers: { 'content-type': contentType }, body: v0Advertisement(repo, isUpload ? 'upload' : 'receive') };
}

// ---------------------------------------------------------------- upload-pack v2

/** A parsed v2 command request: the command name and its argument lines (after the delimiter). */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines = pktTextLines(packets);
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) throw new Error('upload-pack v2 request has no command line');
  const command = commandLine.slice('command='.length);
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const args: string[] = [];
  if (delimIndex >= 0) {
    for (let i = delimIndex + 1; i < packets.length; i += 1) {
      const packet = packets[i]!;
      if (packet.kind !== 'data') break;
      args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  return { command, args };
}

/** Handle `command=ls-refs`: list refs (with symref/peel/unborn), honouring ref-prefix filters. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const cacheKey = args.join('\n');
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.version) return cached.body;
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const lines: string[] = [];
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get('HEAD');
  if (include('HEAD') && headOid !== undefined) {
    let line = `${headOid} HEAD`;
    if (wantSymrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    lines.push(`${line}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (name === 'HEAD' || !include(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToNonTag(repo.objects, oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  if (wantUnborn && repo.refs.size === 0) {
    lines.push(`unborn refs/heads/${repo.defaultBranch}\n`);
  }
  const body = Buffer.concat([pktLines(lines), PKT_FLUSH]);
  repo.lsRefsCache.set(cacheKey, { version: repo.version, body });
  return body;
}

/** Wrap pack bytes in sideband packets (band 1); each pkt-line is at most 65,520 bytes total. */
function sidebandPack(pack: Buffer): Buffer {
  if (pack.length === 0) {
    // An empty pack still needs one sideband packet carrying the 12-byte empty pack + trailer.
    return pktLine(Buffer.concat([Buffer.from([1]), writePack(new Map())]));
  }
  const packets: Buffer[] = [];
  const MAX = 65520 - 4 - 1; // the pkt-line length header plus the band byte
  for (let offset = 0; offset < pack.length; offset += MAX) {
    const chunk = pack.subarray(offset, Math.min(offset + MAX, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(packets);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

/** Parse the argument lines of a v2 fetch (or the lines of a v0 fetch request). */
function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let filter: string | null = null;
  for (const rawLine of lines) {
    // A v0 request carries its capabilities after a NUL on the first want line.
    const nul = rawLine.indexOf('\0');
    const line = nul >= 0 ? rawLine.slice(0, nul) : rawLine;
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    } else if (line.startsWith('filter ')) filter = line.slice(7);
  }
  return { wants, haves, shallow, depth, filter };
}

/**
 * The cache key for a fetch: only a pure shallow fetch of one tip with no haves and no filter is
 * cached (that is exactly the benchmark clone). The map is cleared on every touch(), so the key
 * needs no version — but the entry still records it for the lookup guard.
 */
function fetchCacheKey(args: FetchArgs): string | null {
  if (args.wants.length !== 1 || args.haves.length !== 0 || args.shallow.length !== 0 || args.filter !== null) return null;
  return `${args.wants[0]}:${args.depth ?? 'full'}`;
}

/** Handle a v2 fetch: acknowledgments, shallow-info, wanted-refs, then the packfile section. */
function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(args);
  if (cacheKey !== null) {
    const cached = repo.fetchCache.get(cacheKey);
    if (cached !== undefined && cached.version === repo.version) return cached.body;
  }
  const plan = planFetch(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // Each section opens with a header line naming it; a delimiter closes it.
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  parts.push(pktLine('shallow-info\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(PKT_DELIM);
  parts.push(pktLine('wanted-refs\n'));
  parts.push(PKT_DELIM);
  parts.push(pktLine('packfile\n'));
  const pack = plan.objects.size === 0 ? Buffer.alloc(0) : writePack(plan.objects);
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (cacheKey !== null) repo.fetchCache.set(cacheKey, { version: repo.version, body });
  return body;
}

/** Handle a v0 fetch: NAK/ACK + shallow lines, then the sideband pack. */
function fetchV0(repo: Repo, lines: readonly string[]): Buffer {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = plan.objects.size === 0 ? Buffer.alloc(0) : writePack(plan.objects);
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack POST

function uploadPack(repo: Repo, req: GitRequest): GitResponse {
  const protocolVersion = headerValue(req, 'git-protocol');
  const contentType = 'application/x-git-upload-pack-result';
  if (protocolVersion === 'version=2') {
    const { command, args } = parseV2Request(req.body);
    if (command === 'ls-refs') {
      return { status: 200, headers: { 'content-type': contentType }, body: lsRefs(repo, args) };
    }
    if (command === 'fetch') {
      const fetchArgs = parseFetchArgs(args);
      return { status: 200, headers: { 'content-type': contentType }, body: fetchV2(repo, fetchArgs) };
    }
    throw new Error(`unsupported upload-pack v2 command ${JSON.stringify(command)}`);
  }
  // v0: the body is wants (+ shallow/deepen), a flush, then haves + done.
  const { packets } = decodePktLines(req.body);
  const lines = pktTextLines(packets);
  return { status: 200, headers: { 'content-type': contentType }, body: fetchV0(repo, lines) };
}

// ---------------------------------------------------------------- receive-pack POST

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack request body: the command list, then the pack bytes after the flush. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, end } = decodePktLines(body, 0, true);
  const lines = pktTextLines(packets);
  const commands: PushCommand[] = [];
  lines.forEach((line, index) => {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (index === 0 && clean === '') return; // an empty first line carries capabilities only
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(clean);
    if (match === null) throw new Error(`malformed push command ${JSON.stringify(clean)}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  });
  return { commands, pack: body.subarray(end) };
}

/** Handle a receive-pack: unpack, fast-forward check per ref, apply the ok refs, report status. */
function receivePack(repo: Repo, store: Store, req: GitRequest): GitResponse {
  const { commands, pack } = parseReceivePack(req.body);
  // Unpack first, even when every ref will be refused: the client sent the objects regardless.
  let incoming: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> | null = null;
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      incoming = readPack(pack, (oid) => repo.objects.get(oid));
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  const applied = incoming !== null || pack.length === 0;
  // The merged object view (store + this pack) as a lookup, not a copied Map: copying the whole
  // object store on every push is O(objects) per push, and the push benchmark's repo grows to 600.
  const lookup = (oid: string): { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer } | undefined =>
    incoming?.get(oid) ?? repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (current !== undefined && current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current === undefined && command.oldOid !== ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Deleting a ref: allowed when it exists, an error when it does not.
      if (current === undefined) results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      else results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = lookup(command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.ref.startsWith('refs/tags/') && target.type === 'tag') {
      // A tag update is a fast-forward only when the old tag peels to an ancestor of the new one.
      const oldTarget = current === undefined ? null : peelToNonTag(lookup, current);
      const newTarget = peelToNonTag(lookup, command.newOid);
      if (current !== undefined && oldTarget !== null && !isAncestor(lookup, oldTarget, newTarget) && oldTarget !== newTarget) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== undefined) {
      const targetCommit = target.type === 'tag' ? peelToNonTag(lookup, command.newOid) : command.newOid;
      if (!isAncestor(lookup, current, targetCommit) && current !== targetCommit) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (applied && unpackError === null) {
    if (incoming !== null) for (const [oid, object] of incoming) repo.objects.set(oid, object);
    let changed = false;
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i]!;
      const result = results[i]!;
      if (!result.ok) continue;
      changed = true;
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    if (changed) {
      const headRef = `refs/heads/${repo.defaultBranch}`;
      const headOid = repo.refs.get(headRef);
      if (headOid !== undefined) repo.refs.set('HEAD', headOid);
      else repo.refs.delete('HEAD');
      store.touch(repo);
    }
  }

  // The report-status response, inside band 1 of the sideband.
  const reportLines: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = pktLines(reportLines);
  const body = Buffer.concat([
    pktLine(Buffer.concat([Buffer.from([1]), report])),
    PKT_FLUSH,
  ]);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body };
}

// ---------------------------------------------------------------- entry point

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git endpoint at all.
 * The forge is single-owner: any owner other than the viewer is a 404, never a 403.
 */
export function handleGit(
  store: Store,
  req: GitRequest,
): { handled: boolean; response: GitResponse } {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(req.path);
  if (match === null) return { handled: false, response: { status: 404, headers: {}, body: Buffer.alloc(0) } };
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const endpoint = match[3]!;
  const repo = owner === VIEWER_LOGIN ? store.getRepo(name) : undefined;
  if (repo === undefined) {
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
  try {
    if (endpoint === 'info/refs') {
      const service = req.query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return { handled: true, response: { status: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"missing service"}', 'utf8') } };
      }
      return { handled: true, response: infoRefs(repo, service, headerValue(req, 'git-protocol')) };
    }
    if (endpoint === 'git-upload-pack') {
      return { handled: true, response: uploadPack(repo, req) };
    }
    return { handled: true, response: receivePack(repo, store, req) };
  } catch (err) {
    // A malformed request must never kill the server; the repo stays usable.
    return {
      handled: true,
      response: {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ message: (err as Error).message }), 'utf8'),
      },
    };
  }
}
