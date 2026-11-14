// Git smart-HTTP protocol: pkt-line codec, v0/v2 advertisements, ls-refs,
// fetch (v0 + v2), receive-pack. Follows the wire the suite's git client
// speaks (see kit program/env/src/git-client.ts).

import { parseCommit, parsePack, parseTag, writePack, ZERO_OID, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ pkt-line

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLinesToBuffer(lines: string[], endFlush = true): Buffer {
  const parts = lines.map((l) => pktLine(l));
  if (endFlush) parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface PktRead {
  lines: string[];
  /** Offset just past the terminating flush (or end of buffer). */
  nextOffset: number;
}

/** Read pkt-lines until flush/EOF. Throws on malformed framing. */
export function readPktLines(buf: Buffer, start = 0): PktRead {
  const lines: string[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') return { lines, nextOffset: off + 4 };
    if (head === '0001') {
      lines.push('\u0001');
      off += 4;
      continue;
    }
    if (head === '0002') {
      lines.push('\u0002');
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`malformed pkt-line header ${JSON.stringify(head)}`);
    }
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, nextOffset: off };
}

// ------------------------------------------------------------------ refs

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      entry.peeled = repoPeel(repo, oid);
    }
    out.push(entry);
  }
  return out;
}

function repoPeel(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

function headTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get([...repo.refs.keys()].sort()[0] ?? '') ?? ZERO_OID;
}

const UPLOAD_CAPS_V0 = [
  `symref=HEAD:refs/heads/main`,
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'multi_ack',
  'multi_ack_detailed',
  'agent=forge/1.0',
  'object-format=sha1',
].join(' ');

const RECEIVE_CAPS_V0 = [
  'report-status',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'agent=forge/1.0',
  'object-format=sha1',
].join(' ');

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headTip(repo);
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled !== undefined) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  // Real git ends the advertisement with a flush: without it, a pushing
  // client reads EOF where it expects a flush and reports "the remote end
  // hung up upon initial contact".
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLinesToBuffer([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
  ]);
}

// ------------------------------------------------------------------ sideband

/** Wrap raw bytes as sideband band-1 packets (max 65515 data bytes each). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    const chunk = data.subarray(off, Math.min(off + 65515, data.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const len = payload.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { lines } = readPktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const line of lines) {
    if (line === '\u0001') {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue; // command=ls-refs, agent, object-format
    if (line === 'peel\n') peel = true;
    else if (line === 'symrefs\n') symrefs = true;
    else if (line === 'unborn\n') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
    else if (line.startsWith('ref-prefix\t')) prefixes.push(line.slice('ref-prefix\t'.length).replace(/\n$/, ''));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    if (unborn && matches('HEAD')) out.push('unborn HEAD symref-target:refs/heads/main\n');
    return pktLinesToBuffer(out);
  }
  const tip = headTip(repo);
  if (matches('HEAD')) {
    out.push(symrefs ? `${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${tip} HEAD\n`);
  }
  for (const r of refs) {
    if (!matches(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled !== undefined) line += ` peeled:${r.peeled}`;
    out.push(`${line}\n`);
  }
  return pktLinesToBuffer(out);
}

// ------------------------------------------------------------------ fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseV2Fetch(body: Buffer): FetchRequest {
  const { lines } = readPktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], done: false };
  let seenDelim = false;
  for (const raw of lines) {
    if (raw === '\u0001') {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue;
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') req.done = true;
  }
  return req;
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], done: false };
  // First section: wants (+features on first line), shallow, deepen; ends flush.
  const first = readPktLines(body);
  for (const raw of first.lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]!.trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
  }
  // Second section: haves + done; ends flush.
  if (first.nextOffset < body.length) {
    const second = readPktLines(body, first.nextOffset);
    for (const raw of second.lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      else if (line === 'done') req.done = true;
    }
  }
  return req;
}

function buildFetchPack(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = store.collectFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  return writePack(objects);
}

export function handleFetchV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const req = parseV2Fetch(body);
  if (req.wants.length === 0) throw new Error('fetch with no wants');
  const { objects, shallow, unshallow } = store.collectFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // Acknowledgments are sent ONLY when the client sent haves without a
  // `done` line (real-git multi-round negotiation; the suite always sends
  // `done`, so it takes the packfile path below). Rules, as real git's
  // upload-pack implements them:
  //   - ACK every have the server actually holds (in request order);
  //   - if some have is a common ancestor of a want, append `ready` and
  //     continue to the packfile; otherwise end the response with a flush
  //     (the client then offers more haves in another round);
  //   - if no have is held at all, answer NAK + flush, no packfile.
  // Wants are peeled to commits first: a fetch --tags wants tag objects,
  // whose target commits are what the haves descend from.
  if (req.haves.length > 0 && !req.done) {
    const peeledWants = req.wants.map((w) => store.peelToCommit(repo, w));
    const existing = req.haves.filter((h) => repo.objects.has(h));
    if (existing.length === 0) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    const common = existing.filter((h) =>
      peeledWants.some((w) => store.isAncestor(repo, h, w) || h === w),
    );
    parts.push(pktLine('acknowledgments\n'));
    for (const h of existing) parts.push(pktLine(`ACK ${h}\n`));
    if (common.length === 0) {
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  // Shallow-info section (when there is one): lines carry no trailing
  // newline (their pkt-line frames them).
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}`));
    parts.push(PKT_DELIM);
  }
  // packfile section
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const req = parseV0Fetch(body);
  if (req.wants.length === 0) throw new Error('fetch with no wants');
  const { objects, shallow, unshallow } = store.collectFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // Real git's v0 order: shallow/unshallow lines (no trailing newline)
  // first, then the ACK/NAK lines, then the sideband pack.
  for (const s of shallow) parts.push(pktLine(`shallow ${s}`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}`));
  const common: string[] = [];
  for (const h of req.haves) {
    if (req.wants.some((w) => store.isAncestor(repo, h, w) || h === w)) common.push(h);
  }
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    // multi_ack_detailed: one `ACK <oid> continue` per common have, then a
    // bare `ACK <oid>` that closes the negotiation.
    for (const h of common) parts.push(pktLine(`ACK ${h} continue\n`));
    parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  }
  parts.push(sideband(pack));
  // Real git ends the v0 fetch response with a flush after the sideband
  // pack: without it the client's demultiplexer reads EOF mid-packet and
  // fails with "unexpected disconnect while reading sideband packet".
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface ReceiveResult {
  ok: boolean;
  /** Report stream (already sideband-wrapped) when ok. */
  body?: Buffer;
  /** Error detail when not ok. */
  error?: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): ReceiveResult {
  let commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packOffset: number;
  try {
    const { lines, nextOffset } = readPktLines(body);
    packOffset = nextOffset;
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmd = nul === -1 ? line : line.slice(0, nul);
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmd);
      if (m === null) throw new Error(`bad receive-pack command ${JSON.stringify(cmd)}`);
      commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Parse + store the pack first (objects land even if a ref is refused).
  // REF_DELTA bases may be objects the repo already holds (thin packs).
  let packEntries: ReturnType<typeof parsePack> = [];
  if (packOffset < body.length) {
    try {
      packEntries = parsePack(body.subarray(packOffset), (oid) => repo.objects.get(oid));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    for (const e of packEntries) {
      if (!repo.objects.has(e.oid)) repo.objects.set(e.oid, { type: e.type, data: e.data });
    }
  }
  // Apply refs independently; collect per-ref results.
  const inner: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let result: string | null = null;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) result = 'remote ref does not exist';
      else {
        repo.refs.delete(cmd.ref);
        result = null;
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) result = 'non-fast-forward';
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        result = null;
      }
    } else {
      if (current === undefined) result = 'remote ref does not exist';
      else if (current !== cmd.oldOid) result = 'old oid mismatch';
      else if (!store.isAncestor(repo, store.peelToCommit(repo, cmd.oldOid), store.peelToCommit(repo, cmd.newOid))) {
        result = 'non-fast-forward';
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        result = null;
      }
    }
    inner.push(result === null ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${result}\n`);
  }
  // Inner stream ends with a flush pkt-line inside a band-1 packet; outer ends flush.
  const innerBuf = Buffer.concat([...inner.map((l) => pktLine(l)), PKT_FLUSH]);
  const outer = Buffer.concat([sideband(innerBuf), PKT_FLUSH]);
  return { ok: true, body: outer };
}

// ------------------------------------------------------------------ entry points

export function isGitProtocolV2(headers: Record<string, string | string[] | undefined>): boolean {
  const v = headers['git-protocol'];
  const s = Array.isArray(v) ? v[0] : v;
  return s !== undefined && s.includes('version=2');
}

export function advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') return v2Advertisement();
  return v0Advertisement(service, repo);
}

/** Route a POST to git-upload-pack: v2 command or v0 fetch. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, v2: boolean): Buffer {
  if (v2) {
    const { lines } = readPktLines(body);
    const command = lines[0]?.replace(/\n$/, '') ?? '';
    if (command === 'command=ls-refs') return handleLsRefs(repo, body);
    if (command === 'command=fetch') return handleFetchV2(store, repo, body);
    throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  }
  return handleFetchV0(store, repo, body);
}

export { parseCommit };
