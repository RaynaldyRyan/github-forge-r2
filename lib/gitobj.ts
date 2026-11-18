// Git primitives: object hashing, tree/commit/tag parsing and building, the pkt-line codec, packfile
// reading and writing (plain objects plus OFS/REF deltas on read), reachability, the upload-pack fetch
// computation (wants/haves/depth/shallow), and tree diffs for pull-request files.
//
// Everything here is pure over Buffers and Maps: no I/O, no clock. Pack bytes are deterministic —
// entries are written in ascending object-id order — so a cached pack is byte-identical every time.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0` + data, hex. */
export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name terminator');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object; returns the target object id and type. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}

/** Peel a tag (following tag chains) to its non-tag target, or the oid itself when it is not a tag. */
export function peelToNonTag(
  objects: ReadonlyMap<string, GitObject> | ((oid: string) => GitObject | undefined),
  oid: string,
): string {
  const lookup = typeof objects === 'function' ? objects : (id: string): GitObject | undefined => objects.get(id);
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line: 4 hex length digits + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.allocUnsafe(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** The flush packet (0000) and the delimiter packet (0001). */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of text lines as pkt-lines (each line keeps its trailing \n). */
export function pktLines(lines: readonly string[]): Buffer {
  if (lines.length === 0) return Buffer.alloc(0);
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode a pkt-line stream. Returns the packets and the offset just past the last one, so a caller
 * can read the pack bytes that follow a command list. With `stopAtFirstFlush` the decode ends at
 * the first flush packet (a receive-pack command list ends there; the pack follows). Throws on a
 * malformed length.
 */
export function decodePktLines(bytes: Buffer, start = 0, stopAtFirstFlush = false): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= bytes.length) {
    const hex = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFirstFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) throw new Error('pkt-line overruns its buffer');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, end: offset };
}

/** The text lines of data packets, without trailing newlines. */
export function pktTextLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODES: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObject['type']>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one object's pack header: the type/size varint. */
function packObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = TYPE_CODES[type]!;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas), in ascending object-id order, so the bytes are
 * deterministic for a given object set. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = objects.get(oid)!;
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) copyOffset |= delta[offset++]! << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) copySize |= delta[offset++]! << (bit * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy overruns its base');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert overruns');
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks, targetSize);
}

/**
 * Read a packfile into objects. Resolves OFS_DELTA and REF_DELTA against earlier entries in the pack
 * or, for REF_DELTA, against `resolveBase` (the repository's store). Throws on any malformation.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) {
    throw new Error('pack trailer checksum mismatch');
  }

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObject['type'];
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const first = pack[offset++]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let base = pack[offset++]!;
      let baseOffset = base & 0x7f;
      while ((base & 0x80) !== 0) {
        base = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (base & 0x7f);
      }
      if (baseOffset <= 0 || baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry inflated size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObject['type']; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObject['type'];
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error('ref-delta base is neither in the pack nor in the store');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPES[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` by following commit parents (or equals it). */
export function isAncestor(
  objects: ReadonlyMap<string, GitObject> | ((oid: string) => GitObject | undefined),
  ancestor: string,
  tip: string,
): boolean {
  if (ancestor === tip) return true;
  const lookup = typeof objects === 'function' ? objects : (id: string): GitObject | undefined => objects.get(id);
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The newest common ancestor of two commits (a merge base), or null when there is none. */
export function mergeBase(objects: ReadonlyMap<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  // BFS from b: the first commit also in a's ancestry is the newest common ancestor.
  const seenB = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- the fetch computation

export interface FetchPlan {
  /** The objects to send, as a map (deduplicated). */
  readonly objects: Map<string, GitObject>;
  /** Commits the client must mark shallow after this fetch. */
  readonly shallow: string[];
  /** The client's former shallow boundaries that are no longer shallow. */
  readonly unshallow: string[];
  /** Haves the server shares (an ACK each); empty means NAK. */
  readonly acks: string[];
}

/**
 * Plan an upload-pack fetch: which objects to send for `wants`, given the client's `haves`, its
 * current shallow boundaries, and an optional depth limit.
 *
 * Held objects are those reachable from the haves, stopping at the client's shallow boundaries
 * (a shallow commit's parents are NOT held). A wanted commit is sent with its tree and blobs
 * unless held; parents are followed up to `depth` generations (depth 1 = the wants alone). A sent
 * commit whose parent was cut off by the depth limit (and is not held) is a new shallow boundary;
 * a former boundary whose parents are all sent or held is unshallowed.
 */
export function planFetch(
  objects: ReadonlyMap<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => objects.get(oid);
  const shallowSet = new Set(clientShallow);

  // The objects the client already holds: reachable from the haves, stopping at shallow boundaries.
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) if (isObjectId(have)) queue.push(have);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue; // a shallow boundary: its parents are not held
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (!isObjectId(have)) continue;
    for (const want of wants) {
      if (isAncestor(objects, have, want)) {
        acks.push(have);
        break;
      }
    }
  }

  // Walk from the wants, generation by generation, skipping held objects.
  const send = new Map<string, GitObject>();
  const shallow: string[] = [];
  const commitGen = new Map<string, number>();
  const commitQueue: string[] = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'commit' || object.type === 'tag') {
      commitQueue.push(want);
      commitGen.set(want, 0);
    } else {
      // A want naming a tree or blob directly: send it and its closure.
      if (!held.has(want)) {
        for (const oid of collectReachable([want], lookup)) {
          if (!held.has(oid)) {
            const entry = lookup(oid);
            if (entry !== undefined) send.set(oid, entry);
          }
        }
      }
    }
  }
  // Expand tags to their targets (a tag want sends the tag plus its target's closure).
  const tagTargets: string[] = [];
  for (const want of commitQueue) {
    const object = lookup(want);
    if (object?.type === 'tag') {
      if (!held.has(want)) send.set(want, object);
      const target = peelToNonTag(objects, want);
      if (target !== want && !commitGen.has(target)) {
        commitGen.set(target, 0);
        tagTargets.push(target);
      }
    }
  }
  commitQueue.push(...tagTargets);

  const includedCommits = new Set<string>();
  while (commitQueue.length > 0) {
    const oid = commitQueue.shift()!;
    const gen = commitGen.get(oid)!;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (includedCommits.has(oid)) continue;
    if (held.has(oid)) {
      // Held: do not send, and do not traverse — except through a shallow boundary, whose parents
      // are NOT held (the held computation stopped there). A deepen request needs those parents.
      if (shallowSet.has(oid)) {
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) {
          if (held.has(parent)) continue;
          if (depth !== null && gen + 1 >= depth) continue;
          if (!commitGen.has(parent)) {
            commitGen.set(parent, gen + 1);
            commitQueue.push(parent);
          }
        }
      }
      continue;
    }
    if (depth !== null && gen >= depth) continue; // beyond the depth limit: never included
    includedCommits.add(oid);
    send.set(oid, object);
    const commit = parseCommit(object.data);
    // The commit's tree closure (trees + blobs), skipping held objects.
    for (const treeOid of collectReachable([commit.tree], lookup)) {
      if (held.has(treeOid)) continue;
      const entry = lookup(treeOid);
      if (entry !== undefined) send.set(treeOid, entry);
    }
    // Parents: follow when within the depth limit; otherwise this commit is a shallow boundary.
    let cutByDepth = false;
    for (const parent of commit.parents) {
      if (held.has(parent)) continue;
      if (depth !== null && gen + 1 >= depth) {
        cutByDepth = true;
        continue;
      }
      if (!commitGen.has(parent)) {
        commitGen.set(parent, gen + 1);
        commitQueue.push(parent);
      }
    }
    if (cutByDepth) shallow.push(oid);
  }

  // Unshallow: a former boundary whose parents are all sent or held now.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const allPresent = parents.every((parent) => send.has(parent) || held.has(parent));
    if (allPresent) unshallow.push(boundary);
  }

  return { objects: send, shallow, unshallow, acks };
}

// ---------------------------------------------------------------- tree diffs

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
}

/** Flatten a tree into path -> blob oid (recursing into subtrees). */
export function flattenTree(objects: ReadonlyMap<string, GitObject>, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Count line additions/deletions between two blob versions (common prefix/suffix heuristic). */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newData !== null && newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** Diff two trees (by oid) into per-file changes, sorted by path. */
export function diffTrees(
  objects: ReadonlyMap<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const base = baseTreeOid === null ? new Map<string, string>() : flattenTree(objects, baseTreeOid);
  const head = headTreeOid === null ? new Map<string, string>() : flattenTree(objects, headTreeOid);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const baseOid = base.get(path);
    const headOid = head.get(path);
    if (baseOid === headOid) continue;
    const oldData = baseOid === undefined ? null : (objects.get(baseOid)?.data ?? null);
    const newData = headOid === undefined ? null : (objects.get(headOid)?.data ?? null);
    const counts = lineDiff(oldData, newData);
    changes.push({
      path,
      status: baseOid === undefined ? 'added' : headOid === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

/** The tree oid of a commit, or null when the commit is missing. */
export function commitTree(objects: ReadonlyMap<string, GitObject>, commitOid: string): string | null {
  const object = objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}
