// REST v3 surface: repos, branches, commits, refs, contents, labels,
// issues, comments, pull requests. Every reply is JSON with
// X-GitHub-Request-Id; errors carry a string `message`.

import type { ServerResponse } from 'node:http';
import {
  buildCommitBytes,
  parseCommit,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  commentJson,
  gqlId,
  issueJson,
  linkHeader,
  nextRequestId,
  paginate,
  pagination,
  prConflict,
  pullJson,
  repoJson,
  sendJson,
  type Ctx,
} from './util.ts';

type Handler = (ctx: Ctx, res: ServerResponse, params: Record<string, string>) => void;

function ok(ctx: Ctx, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': ctx.requestId, ...extra });
}

function err(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  ok(ctx, res, status, { message });
}

function bodyObj(ctx: Ctx): Record<string, unknown> {
  return ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)
    ? (ctx.json as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Resolve a repo under the viewer; 404 when the owner is foreign or missing. */
function repoOr404(ctx: Ctx, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    err(ctx, res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    err(ctx, res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function issueOr404(ctx: Ctx, res: ServerResponse, repo: Repo, n: string): Issue | null {
  const num = parseInt(n, 10);
  const issue = repo.issues.find((i) => i.number === num);
  if (issue === undefined) {
    err(ctx, res, 404, 'Not Found');
    return null;
  }
  return issue;
}

function pullOr404(ctx: Ctx, res: ServerResponse, repo: Repo, n: string): Pull | null {
  const num = parseInt(n, 10);
  const pr = repo.pulls.find((p) => p.number === num);
  if (pr === undefined) {
    err(ctx, res, 404, 'Not Found');
    return null;
  }
  return pr;
}

// ------------------------------------------------------------------ repos

function createRepo(ctx: Ctx, res: ServerResponse): void {
  const b = bodyObj(ctx);
  const name = str(b.name).trim();
  if (name === '') {
    err(ctx, res, 422, 'name is required');
    return;
  }
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    err(ctx, res, 422, 'Repository already exists');
    return;
  }
  const repo = ctx.store.createRepo(name, str(b.description), b.private === true);
  ok(ctx, res, 201, repoJson(ctx, repo));
}

function listUserRepos(ctx: Ctx, res: ServerResponse): void {
  const { perPage, page } = pagination(ctx);
  const all = ctx.store.listRepos();
  const items = paginate(all, page, perPage).map((r) => repoJson(ctx, r));
  ok(ctx, res, 200, items, { link: linkHeader(ctx, page, perPage, all.length) });
}

function getRepo(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  ok(ctx, res, 200, repoJson(ctx, repo));
}

function patchRepo(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
  repo.updatedAt = ctx.store.ts();
  ok(ctx, res, 200, repoJson(ctx, repo));
}

function deleteRepo(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  ctx.store.deleteRepo(p.owner!, p.repo!);
  res.writeHead(204, { 'x-github-request-id': ctx.requestId });
  res.end();
}

// ------------------------------------------------------------------ branches/commits/refs

function listBranches(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const base = `http://${ctx.host}`;
  const out = [...repo.refs.keys()]
    .filter((r) => r.startsWith('refs/heads/'))
    .sort()
    .map((r) => {
      const name = r.slice('refs/heads/'.length);
      const sha = repo.refs.get(r)!;
      return { name, commit: { sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false };
    });
  ok(ctx, res, 200, out);
}

function getBranch(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${p.branch!}`);
  if (sha === undefined) {
    err(ctx, res, 404, 'Branch not found');
    return;
  }
  const base = `http://${ctx.host}`;
  ok(ctx, res, 200, {
    name: p.branch,
    commit: { sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
}

function listCommits(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const shaParam = ctx.url.searchParams.get('sha');
  let start: string | undefined;
  if (shaParam !== null) {
    if (repo.refs.has(`refs/heads/${shaParam}`)) start = repo.refs.get(`refs/heads/${shaParam}`);
    else if (repo.objects.has(shaParam)) start = shaParam;
    else {
      err(ctx, res, 404, 'Not Found');
      return;
    }
  } else {
    start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (start === undefined) {
    ok(ctx, res, 200, []);
    return;
  }
  const { perPage, page } = pagination(ctx);
  const all = ctx.store.commitsFrom(repo, ctx.store.peelToCommit(repo, start));
  const base = `http://${ctx.host}`;
  const items = paginate(all, page, perPage).map((sha) => {
    const obj = repo.objects.get(sha)!;
    const parsed = parseCommit(obj.data);
    const text = obj.data.toString('utf8');
    const ts = parseInt(/ (\d+) \+0000/.exec(text)?.[1] ?? '1735689600', 10);
    const date = new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      sha,
      commit: {
        message: parsed.message,
        author: { name: 'Absaa00', email: 'Teukuabsa@gmail.com', date },
        committer: { name: 'Absaa00', email: 'Teukuabsa@gmail.com', date },
      },
      author: { login: VIEWER_LOGIN },
      committer: { login: VIEWER_LOGIN },
      parents: parsed.parents.map((s) => ({ sha: s })),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    };
  });
  ok(ctx, res, 200, items, { link: linkHeader(ctx, page, perPage, all.length) });
}

function createRef(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const ref = str(b.ref);
  const sha = str(b.sha);
  if (!ref.startsWith('refs/') || sha === '') {
    err(ctx, res, 422, 'Invalid ref or sha');
    return;
  }
  if (repo.refs.has(ref)) {
    err(ctx, res, 422, 'Reference already exists');
    return;
  }
  if (!repo.objects.has(sha)) {
    err(ctx, res, 422, 'Invalid SHA');
    return;
  }
  repo.refs.set(ref, sha);
  const base = `http://${ctx.host}`;
  const obj = repo.objects.get(sha)!;
  ok(ctx, res, 201, {
    ref,
    node_id: gqlId('Ref', `${repo.owner}/${repo.name}/${ref}`),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: obj.type, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${obj.type}s/${sha}` },
  });
}

function getRef(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const ref = `refs/${p.rest!}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  const base = `http://${ctx.host}`;
  const obj = repo.objects.get(sha)!;
  ok(ctx, res, 200, {
    ref,
    node_id: gqlId('Ref', `${repo.owner}/${repo.name}/${ref}`),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: obj.type, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${obj.type}s/${sha}` },
  });
}

// ------------------------------------------------------------------ contents

function resolveRefTip(repo: Repo, refParam: string | null, store: { peelToCommit: (r: Repo, o: string) => string }): string | undefined {
  if (refParam === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${refParam}`)) return repo.refs.get(`refs/heads/${refParam}`);
  if (repo.objects.has(refParam)) return refParam;
  void store;
  return undefined;
}

function contentsPath(p: Record<string, string>): string {
  return decodeURIComponent(p.rest ?? '');
}

function getContents(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const path = contentsPath(p);
  const tip = resolveRefTip(repo, ctx.url.searchParams.get('ref'), ctx.store);
  if (tip === undefined) {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  const commitOid = ctx.store.peelToCommit(repo, tip);
  const commitObj = repo.objects.get(commitOid);
  if (commitObj === undefined || commitObj.type !== 'commit') {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  const treeOid = parseCommit(commitObj.data).tree;
  const files = ctx.store.flattenTree(repo, treeOid);
  const base = `http://${ctx.host}`;
  const full = `${repo.owner}/${repo.name}`;
  if (path === '') {
    ok(ctx, res, 200, dirListing(ctx, repo, treeOid, ''));
    return;
  }
  const file = files.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid)!;
    ok(ctx, res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      content: blob.data.toString('base64'),
      sha: file.oid,
      url: `${base}/api/v3/repos/${full}/contents/${encodeURIComponent(path)}`,
      html_url: `https://github.com/${full}/blob/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  // Directory?
  const prefix = `${path}/`;
  const isDir = [...files.keys()].some((k) => k.startsWith(prefix));
  if (isDir) {
    ok(ctx, res, 200, dirListing(ctx, repo, treeOid, path));
    return;
  }
  err(ctx, res, 404, 'Not Found');
}

function dirListing(ctx: Ctx, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const base = `http://${ctx.host}`;
  const full = `${repo.owner}/${repo.name}`;
  const files = ctx.store.flattenTree(repo, treeOid);
  const seen = new Map<string, { type: string; oid: string }>();
  for (const [path, f] of files) {
    if (dirPath !== '' && !path.startsWith(`${dirPath}/`)) continue;
    const rest = dirPath === '' ? path : path.slice(dirPath.length + 1);
    const first = rest.split('/')[0]!;
    if (rest.includes('/')) {
      if (!seen.has(first)) seen.set(first, { type: 'dir', oid: '' });
    } else {
      seen.set(first, { type: 'file', oid: f.oid });
    }
  }
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, v]) => {
      const path = dirPath === '' ? name : `${dirPath}/${name}`;
      return {
        type: v.type,
        name,
        path,
        sha: v.oid,
        size: v.type === 'file' ? (repo.objects.get(v.oid)?.data.length ?? 0) : 0,
        url: `${base}/api/v3/repos/${full}/contents/${encodeURIComponent(path)}`,
        html_url: `https://github.com/${full}/tree/${repo.defaultBranch}/${path}`,
      };
    });
}

function putContents(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const path = contentsPath(p);
  const message = str(b.message);
  const contentB64 = str(b.content);
  if (path === '' || message === '' || contentB64 === '') {
    err(ctx, res, 422, 'message and content are required');
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    err(ctx, res, 422, 'content is not valid base64');
    return;
  }
  const branch = str(b.branch) === '' ? repo.defaultBranch : str(b.branch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  let baseTree: string | null = null;
  if (tip !== undefined) {
    const commitOid = ctx.store.peelToCommit(repo, tip);
    const commitObj = repo.objects.get(commitOid);
    if (commitObj !== undefined && commitObj.type === 'commit') baseTree = parseCommit(commitObj.data).tree;
  }
  const files = ctx.store.flattenTree(repo, baseTree);
  const existing = files.get(path);
  const shaParam = str(b.sha);
  if (existing !== undefined && shaParam === '') {
    err(ctx, res, 422, "sha wasn't supplied");
    return;
  }
  if (existing !== undefined && shaParam !== '' && shaParam !== existing.oid) {
    err(ctx, res, 409, 'sha does not match');
    return;
  }
  if (existing === undefined && shaParam !== '') {
    err(ctx, res, 422, 'Invalid sha');
    return;
  }
  const blobOid = ctx.store.addObject(repo, 'blob', content);
  const newTree = ctx.store.treeWithChange(repo, baseTree, path.split('/'), blobOid);
  const parents = tip === undefined ? [] : [ctx.store.peelToCommit(repo, tip)];
  const commitData = buildCommitBytes(newTree, parents, message, ctx.store.commitTs());
  const commitOid = ctx.store.addObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = ctx.store.ts();
  const base = `http://${ctx.host}`;
  const full = `${repo.owner}/${repo.name}`;
  ok(ctx, res, existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      content: contentB64,
      type: 'file',
      url: `${base}/api/v3/repos/${full}/contents/${encodeURIComponent(path)}`,
    },
    commit: { sha: commitOid, message, url: `${base}/api/v3/repos/${full}/commits/${commitOid}` },
  });
}

function deleteContents(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const path = contentsPath(p);
  const message = str(b.message);
  const shaParam = str(b.sha);
  const branch = str(b.branch) === '' ? repo.defaultBranch : str(b.branch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  const commitOid = ctx.store.peelToCommit(repo, tip);
  const commitObj = repo.objects.get(commitOid);
  if (commitObj === undefined || commitObj.type !== 'commit') {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  const baseTree = parseCommit(commitObj.data).tree;
  const files = ctx.store.flattenTree(repo, baseTree);
  const existing = files.get(path);
  if (existing === undefined) {
    err(ctx, res, 404, 'Not Found');
    return;
  }
  if (shaParam !== '' && shaParam !== existing.oid) {
    err(ctx, res, 409, 'sha does not match');
    return;
  }
  const newTree = ctx.store.treeWithChange(repo, baseTree, path.split('/'), null);
  const commitData = buildCommitBytes(newTree, [commitOid], message, ctx.store.commitTs());
  const newCommit = ctx.store.addObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, newCommit);
  repo.updatedAt = ctx.store.ts();
  const base = `http://${ctx.host}`;
  ok(ctx, res, 200, {
    commit: { sha: newCommit, message, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${newCommit}` },
  });
}

// ------------------------------------------------------------------ labels

function createLabel(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const name = str(b.name).trim();
  if (name === '') {
    err(ctx, res, 422, 'name is required');
    return;
  }
  if (repo.labels.has(name)) {
    err(ctx, res, 422, 'Label already exists');
    return;
  }
  const color = str(b.color) === '' ? '000000' : str(b.color);
  repo.labels.set(name, { name, color });
  const base = `http://${ctx.host}`;
  ok(ctx, res, 201, {
    name,
    color,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    default: false,
  });
}

function listLabels(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const base = `http://${ctx.host}`;
  ok(ctx, res, 200, [...repo.labels.values()].map((l) => ({
    name: l.name,
    color: l.color,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}`,
    default: false,
  })));
}

// ------------------------------------------------------------------ issues

function createIssue(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const title = str(b.title).trim();
  if (title === '') {
    err(ctx, res, 422, 'title is required');
    return;
  }
  const labels: string[] = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
  for (const l of labels) {
    if (!repo.labels.has(l)) {
      err(ctx, res, 422, `Label '${l}' does not exist`);
      return;
    }
  }
  ctx.store.issueSeq += 1;
  const now = ctx.store.ts();
  const issue: Issue = {
    id: ctx.store.issueSeq,
    number: repo.issues.length + 1,
    title,
    body: str(b.body),
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  ok(ctx, res, 201, issueJson(ctx, repo, issue));
}

function listIssues(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const sort = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let items = [...repo.issues];
  if (state !== 'all') items = items.filter((i) => i.state === state);
  if (sort === 'created') {
    items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { perPage, page } = pagination(ctx);
  const pageItems = paginate(items, page, perPage).map((i) => issueJson(ctx, repo, i));
  ok(ctx, res, 200, pageItems, { link: linkHeader(ctx, page, perPage, items.length) });
}

function getIssue(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const issue = issueOr404(ctx, res, repo, p.number!);
  if (issue === null) return;
  ok(ctx, res, 200, issueJson(ctx, repo, issue));
}

function patchIssue(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const issue = issueOr404(ctx, res, repo, p.number!);
  if (issue === null) return;
  const b = bodyObj(ctx);
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  if (b.state === 'open' || b.state === 'closed') {
    issue.state = b.state;
    issue.closedAt = b.state === 'closed' ? ctx.store.ts() : null;
  }
  if (Array.isArray(b.labels)) {
    const labels = b.labels.filter((x): x is string => typeof x === 'string');
    for (const l of labels) {
      if (!repo.labels.has(l)) {
        err(ctx, res, 422, `Label '${l}' does not exist`);
        return;
      }
    }
    issue.labels = labels;
  }
  issue.updatedAt = ctx.store.ts();
  ok(ctx, res, 200, issueJson(ctx, repo, issue));
}

function createComment(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const issue = issueOr404(ctx, res, repo, p.number!);
  if (issue === null) return;
  const b = bodyObj(ctx);
  const body = str(b.body);
  if (body === '') {
    err(ctx, res, 422, 'body is required');
    return;
  }
  ctx.store.commentSeq += 1;
  const now = ctx.store.ts();
  const comment = { id: ctx.store.commentSeq, body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  ok(ctx, res, 201, commentJson(ctx, repo, issue, comment));
}

function listComments(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const issue = issueOr404(ctx, res, repo, p.number!);
  if (issue === null) return;
  const { perPage, page } = pagination(ctx);
  const items = paginate(issue.comments, page, perPage).map((c) => commentJson(ctx, repo, issue, c));
  ok(ctx, res, 200, items, { link: linkHeader(ctx, page, perPage, issue.comments.length) });
}

// ------------------------------------------------------------------ pulls

function createPull(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const b = bodyObj(ctx);
  const head = str(b.head);
  const base = str(b.base);
  const title = str(b.title).trim();
  if (head === '' || base === '' || title === '') {
    err(ctx, res, 422, 'head, base and title are required');
    return;
  }
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) {
    err(ctx, res, 422, 'head or base branch does not exist');
    return;
  }
  const dup = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
  if (dup !== undefined) {
    err(ctx, res, 422, 'A pull request already exists for this head and base');
    return;
  }
  const headCommit = ctx.store.peelToCommit(repo, headTip);
  const baseCommit = ctx.store.peelToCommit(repo, baseTip);
  const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
  ctx.store.pullSeq += 1;
  const now = ctx.store.ts();
  const pr: Pull = {
    id: ctx.store.pullSeq,
    number: repo.pulls.length + 1,
    title,
    body: str(b.body),
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headCommit,
    baseSha: baseCommit,
    baseTreeOid: baseTree,
    // Snapshot: path -> blob oid at creation base (null = absent).
    baseFiles: new Map([...ctx.store.flattenTree(repo, baseTree).entries()].map(([k, v]) => [k, v.oid] as [string, string | null])),
    merged: false,
    mergedAt: null,
    mergeSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.push(pr);
  ok(ctx, res, 201, pullJson(ctx, repo, pr));
}

function listPulls(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let items = [...repo.pulls];
  if (state !== 'all') items = items.filter((pr) => pr.state === state);
  items.sort((a, b) => b.number - a.number);
  const { perPage, page } = pagination(ctx);
  const pageItems = paginate(items, page, perPage).map((pr) => pullJson(ctx, repo, pr));
  ok(ctx, res, 200, pageItems, { link: linkHeader(ctx, page, perPage, items.length) });
}

function getPull(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const pr = pullOr404(ctx, res, repo, p.number!);
  if (pr === null) return;
  ok(ctx, res, 200, pullJson(ctx, repo, pr));
}

function listPullFiles(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const pr = pullOr404(ctx, res, repo, p.number!);
  if (pr === null) return;
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const headTree = headTip === undefined ? '' : parseCommit(repo.objects.get(ctx.store.peelToCommit(repo, headTip))!.data).tree;
  const headFiles = ctx.store.flattenTree(repo, headTree);
  const out: Record<string, unknown>[] = [];
  const allPaths = new Set([...pr.baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...allPaths].sort()) {
    const bOid = pr.baseFiles.has(path) ? pr.baseFiles.get(path)! : null;
    const hOid = headFiles.get(path)?.oid ?? null;
    if (bOid === hOid) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    const oldText = bOid === null ? '' : (repo.objects.get(bOid)?.data.toString('utf8') ?? '');
    const newText = hOid === null ? '' : (repo.objects.get(hOid)?.data.toString('utf8') ?? '');
    if (bOid === null) {
      status = 'added';
      additions = newText === '' ? 0 : newText.split('\n').length;
    } else if (hOid === null) {
      status = 'removed';
      deletions = oldText === '' ? 0 : oldText.split('\n').length;
    } else {
      status = 'modified';
      const d = lineDiff(oldText, newText);
      additions = d.additions;
      deletions = d.deletions;
    }
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: hOid ?? bOid,
      blob_url: '',
      raw_url: '',
    });
  }
  ok(ctx, res, 200, out);
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
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

function mergePull(ctx: Ctx, res: ServerResponse, p: Record<string, string>): void {
  const repo = repoOr404(ctx, res, p.owner!, p.repo!);
  if (repo === null) return;
  const pr = pullOr404(ctx, res, repo, p.number!);
  if (pr === null) return;
  if (pr.state !== 'open') {
    err(ctx, res, 405, 'Pull Request is not mergeable');
    return;
  }
  if (prConflict(ctx.store, repo, pr)) {
    err(ctx, res, 405, 'Pull Request is not mergeable');
    return;
  }
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    err(ctx, res, 422, 'head or base branch does not exist');
    return;
  }
  const headCommit = ctx.store.peelToCommit(repo, headTip);
  const baseCommit = ctx.store.peelToCommit(repo, baseTip);
  const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const data = buildCommitBytes(headTree, [baseCommit], pr.title, ctx.store.commitTs());
  const squash = ctx.store.addObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pr.baseRef}`, squash);
  const now = ctx.store.ts();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = now;
  pr.mergeSha = squash;
  pr.closedAt = now;
  pr.updatedAt = now;
  repo.updatedAt = now;
  ok(ctx, res, 200, { merged: true, sha: squash, message: `Pull Request #${pr.number} merged` });
}

// ------------------------------------------------------------------ routing

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    }).replace(/:\.\.\./g, '(.*)')}$`,
  );
  return { method, pattern: re, keys, handler };
}

// NOTE: `:rest` captures a single segment; contents/refs paths use `:rest...`
// style patterns handled by the raw regexes below (kept simple: match on the
// literal prefix then slice the remainder in the handler).
const ROUTES: Route[] = [
  route('POST', '/user/repos', createRepo),
  route('GET', '/user/repos', listUserRepos),
  route('GET', '/repos/:owner/:repo', getRepo),
  route('PATCH', '/repos/:owner/:repo', patchRepo),
  route('DELETE', '/repos/:owner/:repo', deleteRepo),
  route('GET', '/repos/:owner/:repo/branches', listBranches),
  route('GET', '/repos/:owner/:repo/branches/:branch', getBranch),
  route('GET', '/repos/:owner/:repo/commits', listCommits),
  route('POST', '/repos/:owner/:repo/git/refs', createRef),
  route('POST', '/repos/:owner/:repo/labels', createLabel),
  route('GET', '/repos/:owner/:repo/labels', listLabels),
  route('POST', '/repos/:owner/:repo/issues', createIssue),
  route('GET', '/repos/:owner/:repo/issues', listIssues),
  route('GET', '/repos/:owner/:repo/issues/:number', getIssue),
  route('PATCH', '/repos/:owner/:repo/issues/:number', patchIssue),
  route('POST', '/repos/:owner/:repo/issues/:number/comments', createComment),
  route('GET', '/repos/:owner/:repo/issues/:number/comments', listComments),
  route('POST', '/repos/:owner/:repo/pulls', createPull),
  route('GET', '/repos/:owner/:repo/pulls', listPulls),
  route('GET', '/repos/:owner/:repo/pulls/:number', getPull),
  route('GET', '/repos/:owner/:repo/pulls/:number/files', listPullFiles),
  route('PUT', '/repos/:owner/:repo/pulls/:number/merge', mergePull),
];

export function handleRest(ctx: Ctx, res: ServerResponse): boolean {
  const sub = ctx.path === '/api/v3' ? '/' : ctx.path.slice('/api/v3'.length);
  // Multi-segment tails (contents, git refs) need prefix matching.
  const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/.exec(sub);
  if (contentsMatch !== null) {
    const params = { owner: contentsMatch[1]!, repo: contentsMatch[2]!, rest: contentsMatch[3] ?? '' };
    if (ctx.method === 'GET') {
      getContents(ctx, res, params);
      return true;
    }
    if (ctx.method === 'PUT') {
      putContents(ctx, res, params);
      return true;
    }
    if (ctx.method === 'DELETE') {
      deleteContents(ctx, res, params);
      return true;
    }
    err(ctx, res, 405, 'Method Not Allowed');
    return true;
  }
  const refsMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/.exec(sub);
  if (refsMatch !== null && ctx.method === 'GET') {
    getRef(ctx, res, { owner: refsMatch[1]!, repo: refsMatch[2]!, rest: refsMatch[3]! });
    return true;
  }
  // Branch names may contain slashes (e.g. release/1.0).
  const branchMatch = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(sub);
  if (branchMatch !== null && ctx.method === 'GET') {
    getBranch(ctx, res, { owner: branchMatch[1]!, repo: branchMatch[2]!, branch: decodeURIComponent(branchMatch[3]!) });
    return true;
  }
  for (const r of ROUTES) {
    if (r.method !== ctx.method) continue;
    const m = r.pattern.exec(sub);
    if (m === null) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]!);
    });
    r.handler(ctx, res, params);
    return true;
  }
  // Known path but wrong method -> 405; unknown path -> 404 JSON.
  const anyMethod = ROUTES.some((r) => r.pattern.test(sub));
  if (anyMethod || contentsMatch !== null || refsMatch !== null || branchMatch !== null) {
    err(ctx, res, 405, 'Method Not Allowed');
    return true;
  }
  err(ctx, res, 404, 'Not Found');
  return true;
}

export { nextRequestId };
