// Shared HTTP + serialization helpers for the REST/GraphQL/MCP surfaces.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export interface Ctx {
  store: Store;
  method: string;
  url: URL;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  host: string;
  requestId: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...extra });
  res.end(buf);
}

/** GraphQL global id: base64url of `<Kind>:<key>` — opaque, stable, decodable. */
export function gqlId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGqlId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function baseUrlOf(ctx: Ctx): string {
  return `http://${ctx.host}`;
}

export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  const full = `${repo.owner}/${repo.name}`;
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: gqlId('Repository', full),
    name: repo.name,
    full_name: full,
    owner: { login: repo.owner, id: 1000, node_id: gqlId('User', repo.owner), type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${full}`,
    html_url: `https://github.com/${full}`,
    clone_url: `https://github.com/${full}.git`,
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    homepage: null,
    language: null,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    allow_forking: true,
  };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: gqlId('Issue', `${full}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l?.color ?? '000000', url: `${base}/api/v3/repos/${full}/labels/${encodeURIComponent(name)}`, default: false };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${base}/api/v3/repos/${full}/issues/${issue.number}`,
    html_url: `https://github.com/${full}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${full}`,
    assignee: null,
    assignees: [],
    locked: false,
  };
}

export function commentJson(ctx: Ctx, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: gqlId('IssueComment', `${full}/${comment.id}`),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `${base}/api/v3/repos/${full}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${full}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${base}/api/v3/repos/${full}/issues/${issue.number}`,
  };
}

export function pullJson(ctx: Ctx, repo: Repo, pr: Pull): Record<string, unknown> {
  const base = baseUrlOf(ctx);
  const full = `${repo.owner}/${repo.name}`;
  const headRepo = repoJson(ctx, repo);
  return {
    id: pr.id,
    node_id: gqlId('PullRequest', `${full}/${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, repo: headRepo },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, repo: headRepo },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    mergeable: !prConflict(ctx.store, repo, pr),
    mergeable_state: pr.merged ? 'merged' : prConflict(ctx.store, repo, pr) ? 'dirty' : 'clean',
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    url: `${base}/api/v3/repos/${full}/pulls/${pr.number}`,
    html_url: `https://github.com/${full}/pull/${pr.number}`,
    draft: false,
    locked: false,
  };
}

/**
 * Conflict rule: a file the PR changes (base-at-creation -> head) is conflicted
 * when the current base content differs from BOTH the creation base content
 * and the head content.
 */
export function prConflict(store: Store, repo: Repo, pr: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (baseTip === undefined) return false;
  const baseCommit = store.peelToCommit(repo, baseTip);
  const baseObj = repo.objects.get(baseCommit);
  if (baseObj === undefined || baseObj.type !== 'commit') return false;
  const curBaseTree = parseCommit(baseObj.data).tree;
  const curBaseFiles = store.flattenTree(repo, curBaseTree);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const headFiles =
    headTip === undefined
      ? new Map()
      : store.flattenTree(repo, parseCommit(repo.objects.get(store.peelToCommit(repo, headTip))!.data).tree);
  const changed = new Set<string>();
  for (const [path, oid] of pr.baseFiles) {
    const h = headFiles.get(path)?.oid ?? null;
    if (h !== oid) changed.add(path);
  }
  for (const path of headFiles.keys()) {
    if (!pr.baseFiles.has(path)) changed.add(path);
  }
  for (const path of changed) {
    const creationBase = pr.baseFiles.has(path) ? pr.baseFiles.get(path)! : null;
    const curBase = curBaseFiles.get(path)?.oid ?? null;
    const head = headFiles.get(path)?.oid ?? null;
    if (curBase !== creationBase && curBase !== head) return true;
  }
  return false;
}

/** Parse a `?per_page=&page=` pair (GitHub defaults: per_page 30, page 1). */
export function pagination(ctx: Ctx): { perPage: number; page: number } {
  const perPageRaw = parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(ctx.url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** GitHub-style Link header for paginated lists (absolute URLs). */
export function linkHeader(ctx: Ctx, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const base = baseUrlOf(ctx);
  const path = ctx.path;
  const links: string[] = [];
  const mk = (p: number, rel: string): string => {
    const u = new URL(`${base}${path}`);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return `<${u.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) {
    links.push(mk(page + 1, 'next'));
    links.push(mk(totalPages, 'last'));
  }
  if (page > 1) {
    links.push(mk(1, 'first'));
    links.push(mk(page - 1, 'prev'));
  }
  return links.join(', ');
}

export function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}
