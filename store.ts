// Store + git object model for the forge: in-memory repos, SHA-1 objects,
// pack read/write, fetch object selection, tree manipulation, PR diffs.
// Everything stored/served is deterministic: fixed epoch + counters, no wall
// clock, no unseeded randomness (the suite replays two runs byte-identical).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'Absaa00';
export const VIEWER_EMAIL = 'Teukuabsa@gmail.com';
/** Fixed epoch for every timestamp the forge stores or serves (2025-01-01T00:00:00Z). */
export const EPOCH = 1735689600;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// ------------------------------------------------------------------ commits/trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree ordering: names compare as-is, directories as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildCommitBytes(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export function buildTagBytes(target: string, targetType: ObjType, tagName: string, message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  return Buffer.from(
    `object ${target}\ntype ${targetType}\ntag ${tagName}\ntagger ${who}\n\n${message}`,
    'utf8',
  );
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? ZERO_OID;
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  return { tree, parents, message };
}

export function parseTag(data: Buffer): { object: string; type: ObjType; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const object = /^object ([0-9a-f]{40})$/m.exec(head)?.[1] ?? ZERO_OID;
  const type = (/^type (\w+)$/m.exec(head)?.[1] ?? 'commit') as ObjType;
  return { object, type, message };
}

// ------------------------------------------------------------------ pack format

const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
const PACK_TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum = PACK_TYPE[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

export function writePack(objects: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a packfile with plain (non-delta) objects. Throws on delta/malformed. */
export function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const out: PackEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length) throw new Error('pack truncated');
    let byte = buf[off];
    off += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (off >= buf.length) throw new Error('pack truncated in size');
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) throw new Error('ofs-delta packs are not accepted');
    if (typeNum === 7) throw new Error('ref-delta packs are not accepted');
    const type = PACK_TYPE_NAME[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    // inflateSync with info:true exposes engine.bytesWritten = bytes consumed.
    const { buffer, engine } = inflateSync(buf.subarray(off), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (buffer.length !== size) throw new Error(`pack object size mismatch: declared ${size}, got ${buffer.length}`);
    out.push({ oid: oidOf(type, buffer), type, data: buffer });
    off += engine.bytesWritten;
  }
  return out;
}

// ------------------------------------------------------------------ repo store

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  baseTreeOid: string;
  /** filename -> blob oid at PR creation base (null = absent). */
  baseFiles: Map<string, string | null>;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  seq: number;
}

export class Store {
  readonly viewer = VIEWER_LOGIN;
  repos = new Map<string, Repo>();
  repoSeq = 0;
  issueSeq = 0;
  commentSeq = 0;
  pullSeq = 0;
  private tsCounter = 0;

  /** Deterministic ISO timestamp: epoch + 1s per call. */
  ts(): string {
    this.tsCounter += 1;
    return new Date((EPOCH + this.tsCounter) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Deterministic commit timestamp (seconds). */
  commitTs(): number {
    this.tsCounter += 1;
    return EPOCH + this.tsCounter;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const now = this.ts();
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: this.viewer,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      seq: this.repoSeq,
    };
    this.repos.set(this.key(this.viewer, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  addObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Peel a tag object to its commit oid (lightweight tags are already commits). */
  peelToCommit(repo: Repo, oid: string): string {
    let cur = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  refTargetCommit(repo: Repo, refName: string): string | undefined {
    const oid = repo.refs.get(refName);
    if (oid === undefined) return undefined;
    return this.peelToCommit(repo, oid);
  }

  /** Is `anc` an ancestor of (or equal to) `desc`? Both commit oids. */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** All commits reachable from `starts`, with generation (1 = a start). */
  reachableCommits(repo: Repo, starts: string[], maxGen?: number): Map<string, number> {
    const out = new Map<string, number>();
    const queue: { oid: string; gen: number }[] = starts.map((oid) => ({ oid, gen: 1 }));
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      const prev = out.get(oid);
      if (prev !== undefined && prev <= gen) continue;
      out.set(oid, gen);
      if (maxGen !== undefined && gen >= maxGen) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
    }
    return out;
  }

  /** Every object reachable from a set of commits (commits + their trees/blobs). */
  reachableObjects(repo: Repo, commits: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack: { oid: string; kind: 'commit' | 'tree' }[] = [];
    for (const c of commits) stack.push({ oid: c, kind: 'commit' });
    while (stack.length > 0) {
      const { oid, kind } = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (kind === 'commit' && obj.type === 'commit') {
        const { tree } = parseCommit(obj.data);
        stack.push({ oid: tree, kind: 'tree' });
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          stack.push({ oid: e.oid, kind: 'tree' });
        }
      }
    }
    return out;
  }

  /**
   * Object selection for a fetch: closure(wants, depth) minus held-closure,
   * where the held closure stops at client-declared shallow boundaries.
   * Returns the pack entries plus shallow/unshallow lines for the response.
   */
  collectFetch(
    repo: Repo,
    wants: string[],
    haves: string[],
    clientShallow: string[],
    depth?: number,
  ): { objects: PackEntry[]; shallow: string[]; unshallow: string[] } {
    const wantGen = this.reachableCommits(repo, wants, depth);
    // Held closure: reachable from haves, not crossing shallow boundaries.
    const shallowSet = new Set(clientShallow);
    const held = new Set<string>();
    const queue = [...haves];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (held.has(cur)) continue;
      held.add(cur);
      if (shallowSet.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    const heldObjects = this.reachableObjects(repo, held);
    const sendCommits = [...wantGen.keys()].filter((oid) => !held.has(oid));
    const sendObjects = this.reachableObjects(repo, sendCommits);
    for (const oid of heldObjects) sendObjects.delete(oid);
    const objects: PackEntry[] = [];
    for (const oid of sendObjects) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.push({ oid, type: obj.type, data: obj.data });
    }
    // Deterministic pack order: commits, then trees, then blobs, then tags; by oid.
    const rank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
    objects.sort((a, b) => rank[a.type] - rank[b.type] || (a.oid < b.oid ? -1 : 1));
    // Boundary commits: included commits with a parent outside the included set.
    const shallow: string[] = [];
    const unshallow: string[] = [];
    for (const oid of wantGen.keys()) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const cut = parents.some((p) => !wantGen.has(p));
      if (parents.length > 0 && cut) shallow.push(oid);
    }
    for (const s of clientShallow) {
      if (!wantGen.has(s)) continue;
      if (shallow.includes(s)) continue;
      unshallow.push(s);
    }
    shallow.sort();
    unshallow.sort();
    return { objects, shallow, unshallow };
  }

  /** Flat file map of a tree: path -> {mode, oid}. */
  flattenTree(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    if (treeOid === null || treeOid === ZERO_OID) return out;
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Build a new tree from `baseTreeOid` with `path` set to `blobOid`
   * (or deleted when blobOid is null). Returns the new tree oid.
   */
  treeWithChange(repo: Repo, baseTreeOid: string | null, parts: string[], blobOid: string | null): string {
    if (parts.length === 0) throw new Error('empty path');
    const [head, ...rest] = parts as [string, string[]];
    const baseEntries: TreeEntry[] =
      baseTreeOid === null || baseTreeOid === ZERO_OID
        ? []
        : parseTree(repo.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0));
    const out: TreeEntry[] = [];
    let handled = false;
    for (const e of baseEntries) {
      if (e.name !== head) {
        out.push(e);
        continue;
      }
      handled = true;
      if (rest.length === 0) {
        if (blobOid !== null) out.push({ mode: '100644', name: head, oid: blobOid });
        // else: delete the entry
      } else {
        if (e.mode !== '40000') {
          // A file sits where a directory is needed: replace it with a tree.
          const sub = this.treeWithChange(repo, null, rest, blobOid);
          out.push({ mode: '40000', name: head, oid: sub });
        } else {
          const sub = this.treeWithChange(repo, e.oid, rest, blobOid);
          out.push({ mode: '40000', name: head, oid: sub });
        }
      }
    }
    if (!handled) {
      if (rest.length === 0) {
        if (blobOid !== null) out.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const sub = this.treeWithChange(repo, null, rest, blobOid);
        out.push({ mode: '40000', name: head, oid: sub });
      }
    }
    return this.addObject(repo, 'tree', buildTreeBytes(out));
  }

  /** Create a commit on a branch from a tree (parents = current tip or []). */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parents = tip === undefined ? [] : [this.peelToCommit(repo, tip)];
    const data = buildCommitBytes(treeOid, parents, message, this.commitTs());
    const oid = this.addObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** All commits reachable from a ref, newest-first by generation order. */
  commitsFrom(repo: Repo, refOid: string): string[] {
    const gen = this.reachableCommits(repo, [refOid]);
    // BFS order already approximates newest-first; sort by generation, then oid
    // for determinism (ties only among unrelated roots, which cannot happen
    // for a single linear history; merges keep generation order).
    return [...gen.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([oid]) => oid);
  }
}

/** Line-diff counts for small text blobs (LCS on lines). */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: n - lcs, deletions: m - lcs };
}
