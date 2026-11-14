// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28.
// Tools share the same store as REST/GraphQL. No sessions are issued.

import type { ServerResponse } from 'node:http';
import { buildCommitBytes, parseCommit, VIEWER_LOGIN, type Repo } from './store.ts';
import { gqlId, issueJson, prConflict, pullJson, repoJson, sendJson, type Ctx } from './util.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The suite maps several synonym keys onto each argument; accept them all. */
function pick(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') return args[k];
  }
  return undefined;
}

function resolveOwnerRepo(ctx: Ctx, args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = pick(args, 'owner', 'owner_login', 'login') as string | undefined;
  let repo = pick(args, 'repo', 'repository', 'repository_name', 'name') as string | undefined;
  const full = pick(args, 'full_name', 'fullName') as string | undefined;
  if ((owner === undefined || repo === undefined) && typeof full === 'string' && full.includes('/')) {
    const [o, r] = full.split('/');
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function getRepoOrNull(ctx: Ctx, owner: string, repo: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, repo) ?? null;
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const { store } = ctx;
  switch (name) {
    case 'create_repo': {
      const repoName = pick(args, 'name', 'repo', 'repository') as string | undefined;
      if (repoName === undefined || repoName === '') return toolError('create_repo: name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        const existing = store.getRepo(VIEWER_LOGIN, repoName)!;
        return toolResult(repoJson(ctx, existing));
      }
      const repo = store.createRepo(
        repoName,
        (pick(args, 'description') as string | undefined) ?? '',
        pick(args, 'private') === true,
      );
      return toolResult(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const or = resolveOwnerRepo(ctx, args);
      if (or === null) return toolError('get_repo: owner and repo are required');
      const repo = getRepoOrNull(ctx, or.owner, or.repo);
      if (repo === null) return toolError(`get_repo: repository ${or.owner}/${or.repo} not found`);
      return toolResult(repoJson(ctx, repo));
    }
    case 'create_issue': {
      const or = resolveOwnerRepo(ctx, args);
      const title = pick(args, 'title') as string | undefined;
      if (or === null) return toolError('create_issue: owner and repo are required');
      if (title === undefined || title === '') return toolError('create_issue: title is required');
      const repo = getRepoOrNull(ctx, or.owner, or.repo);
      if (repo === null) return toolError(`create_issue: repository ${or.owner}/${or.repo} not found`);
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) return toolError(`create_issue: label '${l}' does not exist`);
      }
      store.issueSeq += 1;
      const now = store.ts();
      const issue = {
        id: store.issueSeq,
        number: repo.issues.length + 1,
        title,
        body: (pick(args, 'body', 'description') as string | undefined) ?? '',
        state: 'open' as const,
        labels,
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return toolResult(issueJson(ctx, repo, issue));
    }
    case 'list_issues': {
      const or = resolveOwnerRepo(ctx, args);
      if (or === null) return toolError('list_issues: owner and repo are required');
      const repo = getRepoOrNull(ctx, or.owner, or.repo);
      if (repo === null) return toolError(`list_issues: repository ${or.owner}/${or.repo} not found`);
      const state = (pick(args, 'state') as string | undefined) ?? 'open';
      const items = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return toolResult({ issues: items.map((i) => issueJson(ctx, repo, i)) });
    }
    case 'create_pull_request': {
      const or = resolveOwnerRepo(ctx, args);
      const title = pick(args, 'title') as string | undefined;
      const head = pick(args, 'head', 'head_branch', 'head_ref') as string | undefined;
      const base = pick(args, 'base', 'base_branch', 'base_ref') as string | undefined;
      if (or === null) return toolError('create_pull_request: owner and repo are required');
      if (title === undefined || title === '') return toolError('create_pull_request: title is required');
      if (head === undefined || base === undefined) return toolError('create_pull_request: head and base are required');
      const repo = getRepoOrNull(ctx, or.owner, or.repo);
      if (repo === null) return toolError(`create_pull_request: repository ${or.owner}/${or.repo} not found`);
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) return toolError('create_pull_request: head or base branch does not exist');
      const dup = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
      if (dup !== undefined) return toolError('create_pull_request: a pull request already exists for this head and base');
      const headCommit = store.peelToCommit(repo, headTip);
      const baseCommit = store.peelToCommit(repo, baseTip);
      const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
      store.pullSeq += 1;
      const now = store.ts();
      const pr = {
        id: store.pullSeq,
        number: repo.pulls.length + 1,
        title,
        body: (pick(args, 'body', 'description') as string | undefined) ?? '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha: headCommit,
        baseSha: baseCommit,
        baseTreeOid: baseTree,
        baseFiles: new Map([...store.flattenTree(repo, baseTree).entries()].map(([k, v]) => [k, v.oid] as [string, string | null])),
        merged: false,
        mergedAt: null,
        mergeSha: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.pulls.push(pr);
      const out = pullJson(ctx, repo, pr) as Record<string, unknown>;
      out.pull_number = pr.number;
      return toolResult(out);
    }
    case 'merge_pull_request': {
      const or = resolveOwnerRepo(ctx, args);
      const numRaw = pick(args, 'pull_number', 'number', 'pullNumber', 'pull_request_number');
      if (or === null) return toolError('merge_pull_request: owner and repo are required');
      if (numRaw === undefined) return toolError('merge_pull_request: pull_number is required');
      const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw), 10);
      const repo = getRepoOrNull(ctx, or.owner, or.repo);
      if (repo === null) return toolError(`merge_pull_request: repository ${or.owner}/${or.repo} not found`);
      const pr = repo.pulls.find((p) => p.number === num);
      if (pr === undefined) return toolError(`merge_pull_request: pull request ${num} not found`);
      if (pr.state !== 'open') return toolError('merge_pull_request: pull request is not open');
      if (prConflict(store, repo, pr)) return toolError('merge_pull_request: pull request is not mergeable');
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return toolError('merge_pull_request: head or base branch does not exist');
      const headCommit = store.peelToCommit(repo, headTip);
      const baseCommit = store.peelToCommit(repo, baseTip);
      const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
      const data = buildCommitBytes(headTree, [baseCommit], pr.title, store.commitTs());
      const squash = store.addObject(repo, 'commit', data);
      repo.refs.set(`refs/heads/${pr.baseRef}`, squash);
      const now = store.ts();
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = now;
      pr.mergeSha = squash;
      pr.closedAt = now;
      pr.updatedAt = now;
      return toolResult({ merged: true, sha: squash, number: pr.number, pull_number: pr.number, state: 'closed' });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

// ------------------------------------------------------------------ JSON-RPC

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(ctx: Ctx, res: ServerResponse): void {
  if (ctx.method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (ctx.jsonError || ctx.json === null || typeof ctx.json !== 'object' || Array.isArray(ctx.json)) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const req = ctx.json as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const hasId = req.id !== undefined && req.id !== null;

  // Notifications (no id): accept silently with 202 and no body.
  if (!hasId) {
    res.writeHead(202);
    res.end();
    return;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }));
      return;
    }
    case 'initialize': {
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        sendJson(res, 200, rpcError(id, -32602, `unknown tool ${name}`));
        return;
      }
      const missing = tool.inputSchema.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length > 0) {
        sendJson(res, 200, rpcResult(id, toolError(`missing required arguments: ${missing.join(', ')}`)));
        return;
      }
      sendJson(res, 200, rpcResult(id, callTool(ctx, name, args)));
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}

export { gqlId };
