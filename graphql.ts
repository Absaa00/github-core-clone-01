// GraphQL v4: a small parser + executor for exactly the documents the suite
// sends (see kit program/env/src/checks-graphql.ts). Hand-written: no deps,
// deterministic, no clock. Supports query/mutation, variables, arguments
// (variables, strings, ints, booleans, enums, lists, objects), aliases,
// inline fragments, and __type introspection.

import type { ServerResponse } from 'node:http';
import { buildCommitBytes, parseCommit, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { gqlId, parseGqlId, prConflict, sendJson, type Ctx } from './util.ts';
// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  children: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; children: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_\-.]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\-.]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t} but got ${got}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      // Optional operation name.
      if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') this.next();
      // Optional variable definitions.
      if (this.peek() === '(') {
        let depth = 0;
        do {
          const t = this.next();
          if (t === '(') depth += 1;
          if (t === ')') depth -= 1;
        } while (depth > 0);
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, selections };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      // Fragment spreads (named) are not used by the suite; ignore directives.
      const children = this.parseSelectionSet();
      return { kind: 'inline', typeCondition, children };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives (@...) are not used by the suite; skip them.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        let depth = 0;
        do {
          const t = this.next();
          if (t === '(') depth += 1;
          if (t === ')') depth -= 1;
        } while (depth > 0);
      }
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, children } };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    return { kind: 'enum', value: t };
  }
}

export function parseDocument(src: string): Operation {
  return new Parser(tokenize(src)).parseOperation();
}

// ------------------------------------------------------------------ execution

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, vars: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, vars);
  return out;
}

function cursorFor(n: number): string {
  return Buffer.from(`issue:${n}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^issue:(\d+)$/.exec(text);
    return m === null ? null : parseInt(m[1]!, 10);
  } catch {
    return null;
  }
}

// Static introspection tables for __type.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url', 'createdAt', 'updatedAt', 'defaultBranch', 'isPrivate', 'fork'],
  SearchType: [],
};
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'CODE', 'COMMIT'],
};

interface ExecCtx {
  store: Store;
  ctx: Ctx;
  vars: Variables;
  errors: { message: string }[];
}

class GqlError extends Error {}

function unknownField(typeName: string, field: string): never {
  throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
}

function executeSelections(
  selections: SelectionNode[],
  parent: unknown,
  typeName: string,
  ectx: ExecCtx,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== typeName) continue;
      const sub = executeSelections(sel.children, parent, typeName, ectx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const f = sel.field;
    const key = f.alias ?? f.name;
    out[key] = resolveField(f, parent, typeName, ectx);
  }
  return out;
}

function resolveField(f: FieldNode, parent: unknown, typeName: string, ectx: ExecCtx): unknown {
  const args = argsOf(f, ectx.vars);
  switch (typeName) {
    case 'Query':
      return resolveQueryField(f, args, ectx);
    case 'Mutation':
      return resolveMutationField(f, args, ectx);
    case 'Repository':
      return resolveRepositoryField(f, parent as Repo, args, ectx);
    case 'Issue':
      return resolveIssueField(f, parent as { repo: Repo; issue: Issue }, args, ectx);
    case 'PullRequest':
      return resolvePullRequestField(f, parent as { repo: Repo; pr: Pull }, args, ectx);
    case 'User':
      return resolveUserField(f, parent as { login: string }, ectx);
    case 'Ref':
      return resolveRefField(f, parent as { name: string }, ectx);
    case 'IssueConnection':
    case 'PullRequestConnection':
      return resolveConnectionField(f, parent as { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }, ectx);
    case 'PageInfo':
      return resolvePageInfoField(f, parent as { hasNextPage: boolean; endCursor: string | null }, ectx);
    case 'IssueComment':
      return resolveCommentField(f, parent as { comment: Issue['comments'][number] }, ectx);
    case 'PullRequestFile':
      return resolveFileField(f, parent as Record<string, unknown>, ectx);
    case '__Type':
      return resolveTypeField(f, parent as { name: string }, ectx);
    case '__Field':
    case '__EnumValue':
      return resolveLeafField(f, parent as Record<string, unknown>);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
      return resolvePayloadField(f, parent as Record<string, unknown>, typeName, ectx);
    case 'CommentEdge': {
      const node = (parent as { node: unknown }).node;
      if (f.name === 'node') {
        if (f.children.length === 0) return node;
        return executeSelections(f.children, node as { repo: Repo; issue: Issue; comment: Issue['comments'][number] }, 'IssueComment', ectx);
      }
      return unknownField('CommentEdge', f.name);
    }
    default:
      return unknownField(typeName, f.name);
  }
}

function resolveQueryField(f: FieldNode, args: Record<string, unknown>, ectx: ExecCtx): unknown {
  const { store } = ectx;
  switch (f.name) {
    case 'viewer': {
      if (f.children.length === 0) return { login: VIEWER_LOGIN };
      return executeSelections(f.children, { login: VIEWER_LOGIN }, 'User', ectx);
    }
    case 'repository': {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return null;
      if (f.children.length === 0) return {};
      return executeSelections(f.children, repo, 'Repository', ectx);
    }
    case 'node': {
      const parsed = parseGqlId(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const [owner, name] = parsed.key.split('/');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner!, name!);
        if (repo === undefined) return null;
        if (f.children.length === 0) return {};
        return executeSelections(f.children, repo, 'Repository', ectx);
      }
      return null;
    }
    case '__type': {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      if (fields === undefined && TYPE_ENUM_VALUES[name] === undefined) return null;
      const typeObj = { name };
      if (f.children.length === 0) return typeObj;
      return executeSelections(f.children, typeObj, '__Type', ectx);
    }
    default:
      return unknownField('Query', f.name);
  }
}

function resolveMutationField(f: FieldNode, args: Record<string, unknown>, ectx: ExecCtx): unknown {
  const { store, ctx } = ectx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (f.name) {
    case 'createIssue': {
      const parsed = parseGqlId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GqlError('createIssue: unknown repository');
      const [owner, name] = parsed.key.split('/');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner!, name!) : undefined;
      if (repo === undefined) throw new GqlError('createIssue: unknown repository');
      const title = String(input.title ?? '');
      if (title === '') throw new GqlError('createIssue: title is required');
      store.issueSeq += 1;
      const now = store.ts();
      const issue: Issue = {
        id: store.issueSeq,
        number: repo.issues.length + 1,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      const payload = { issue: { repo, issue } };
      return f.children.length === 0 ? payload : executeSelections(f.children, payload, 'CreateIssuePayload', ectx);
    }
    case 'closeIssue': {
      const parsed = parseGqlId(String(input.issueId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GqlError('closeIssue: unknown issue');
      const [owner, name, num] = parsed.key.split('/');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner!, name!) : undefined;
      const issue = repo?.issues.find((i) => i.number === parseInt(num!, 10));
      if (repo === undefined || issue === undefined) throw new GqlError('closeIssue: unknown issue');
      issue.state = 'closed';
      issue.closedAt = store.ts();
      issue.updatedAt = issue.closedAt;
      const payload = { issue: { repo, issue } };
      return f.children.length === 0 ? payload : executeSelections(f.children, payload, 'CloseIssuePayload', ectx);
    }
    case 'createPullRequest': {
      const parsed = parseGqlId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GqlError('createPullRequest: unknown repository');
      const [owner, name] = parsed.key.split('/');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner!, name!) : undefined;
      if (repo === undefined) throw new GqlError('createPullRequest: unknown repository');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) throw new GqlError('createPullRequest: head or base branch does not exist');
      const dup = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
      if (dup !== undefined) throw new GqlError('createPullRequest: a pull request already exists for this head and base');
      const headCommit = store.peelToCommit(repo, headTip);
      const baseCommit = store.peelToCommit(repo, baseTip);
      const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
      store.pullSeq += 1;
      const now = store.ts();
      const pr: Pull = {
        id: store.pullSeq,
        number: repo.pulls.length + 1,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
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
      const payload = { pullRequest: { repo, pr } };
      return f.children.length === 0 ? payload : executeSelections(f.children, payload, 'CreatePullRequestPayload', ectx);
    }
    case 'mergePullRequest': {
      const parsed = parseGqlId(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.kind !== 'PullRequest') throw new GqlError('mergePullRequest: unknown pull request');
      const [owner, name, num] = parsed.key.split('/');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner!, name!) : undefined;
      const pr = repo?.pulls.find((p) => p.number === parseInt(num!, 10));
      if (repo === undefined || pr === undefined) throw new GqlError('mergePullRequest: unknown pull request');
      if (pr.state !== 'open') throw new GqlError('mergePullRequest: pull request is not open');
      if (prConflict(store, repo, pr)) throw new GqlError('mergePullRequest: pull request is not mergeable');
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headTip === undefined || baseTip === undefined) throw new GqlError('mergePullRequest: head or base branch does not exist');
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
      const payload = { pullRequest: { repo, pr } };
      void ctx;
      return f.children.length === 0 ? payload : executeSelections(f.children, payload, 'MergePullRequestPayload', ectx);
    }
    case 'addComment': {
      const parsed = parseGqlId(String(input.subjectId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GqlError('addComment: unknown subject');
      const [owner, name, num] = parsed.key.split('/');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner!, name!) : undefined;
      const issue = repo?.issues.find((i) => i.number === parseInt(num!, 10));
      if (repo === undefined || issue === undefined) throw new GqlError('addComment: unknown subject');
      const body = String(input.body ?? '');
      store.commentSeq += 1;
      const now = store.ts();
      const comment = { id: store.commentSeq, body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      const payload = { commentEdge: { node: { repo, issue, comment } } };
      return f.children.length === 0 ? payload : executeSelections(f.children, payload, 'AddCommentPayload', ectx);
    }
    default:
      return unknownField('Mutation', f.name);
  }
}

function resolveRepositoryField(f: FieldNode, repo: Repo, args: Record<string, unknown>, ectx: ExecCtx): unknown {
  const { store, ctx } = ectx;
  switch (f.name) {
    case 'id':
      return gqlId('Repository', `${repo.owner}/${repo.name}`);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return f.children.length === 0 ? { login: repo.owner } : executeSelections(f.children, { login: repo.owner }, 'User', ectx);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return f.children.length === 0 ? { name: repo.defaultBranch } : executeSelections(f.children, { name: repo.defaultBranch }, 'Ref', ectx);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'defaultBranch':
      return repo.defaultBranch;
    case 'isPrivate':
      return repo.isPrivate;
    case 'fork':
      return false;
    case 'issue': {
      const n = Number(args.number);
      const issue = repo.issues.find((i) => i.number === n);
      if (issue === undefined) return null;
      if (f.children.length === 0) return {};
      return executeSelections(f.children, { repo, issue }, 'Issue', ectx);
    }
    case 'issues': {
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = typeof args.after === 'string' ? args.after : undefined;
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      let items = [...repo.issues];
      if (states !== undefined) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        items = items.filter((i) => wanted.has(i.state));
      }
      const dir = String(orderBy.direction ?? 'DESC');
      items.sort((a, b) => (dir === 'ASC' ? a.number - b.number : b.number - a.number));
      const afterNum = numberFromCursor(after);
      if (afterNum !== null) {
        items = dir === 'ASC' ? items.filter((i) => i.number > afterNum) : items.filter((i) => i.number < afterNum);
      }
      const page = items.slice(0, first);
      const hasNextPage = items.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
      const conn = { nodes: page.map((issue) => ({ repo, issue })), hasNextPage, endCursor };
      if (f.children.length === 0) return conn;
      // Connection: nodes { ... } pageInfo { ... }
      const out: Record<string, unknown> = {};
      for (const sel of f.children) {
        if (sel.kind !== 'field') continue;
        if (sel.field.name === 'nodes') {
          out[sel.field.alias ?? 'nodes'] = conn.nodes.map((n) =>
            sel.field.children.length === 0 ? {} : executeSelections(sel.field.children, n, 'Issue', ectx),
          );
        } else if (sel.field.name === 'pageInfo') {
          out[sel.field.alias ?? 'pageInfo'] =
            sel.field.children.length === 0 ? conn : executeSelections(sel.field.children, conn, 'PageInfo', ectx);
        } else if (sel.field.name === 'totalCount') {
          out[sel.field.alias ?? 'totalCount'] = items.length;
        } else {
          return unknownField('IssueConnection', sel.field.name);
        }
      }
      return out;
    }
    case 'pullRequest': {
      const n = Number(args.number);
      const pr = repo.pulls.find((p) => p.number === n);
      if (pr === undefined) return null;
      if (f.children.length === 0) return {};
      return executeSelections(f.children, { repo, pr }, 'PullRequest', ectx);
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = typeof args.after === 'string' ? args.after : undefined;
      let items = [...repo.pulls];
      items.sort((a, b) => b.number - a.number);
      const afterNum = numberFromCursor(after);
      if (afterNum !== null) items = items.filter((p) => p.number < afterNum);
      const page = items.slice(0, first);
      const hasNextPage = items.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
      const conn = { nodes: page.map((pr) => ({ repo, pr })), hasNextPage, endCursor };
      if (f.children.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const sel of f.children) {
        if (sel.kind !== 'field') continue;
        if (sel.field.name === 'nodes') {
          out[sel.field.alias ?? 'nodes'] = conn.nodes.map((n) =>
            sel.field.children.length === 0 ? {} : executeSelections(sel.field.children, n, 'PullRequest', ectx),
          );
        } else if (sel.field.name === 'pageInfo') {
          out[sel.field.alias ?? 'pageInfo'] =
            sel.field.children.length === 0 ? conn : executeSelections(sel.field.children, conn, 'PageInfo', ectx);
        } else if (sel.field.name === 'totalCount') {
          out[sel.field.alias ?? 'totalCount'] = items.length;
        } else {
          return unknownField('PullRequestConnection', sel.field.name);
        }
      }
      return out;
    }
    default:
      return unknownField('Repository', f.name);
  }
  void ctx;
}

function resolveIssueField(f: FieldNode, parent: { repo: Repo; issue: Issue }, _args: Record<string, unknown>, ectx: ExecCtx): unknown {
  const { issue } = parent;
  switch (f.name) {
    case 'id':
      return gqlId('Issue', `${parent.repo.owner}/${parent.repo.name}/${issue.number}`);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'author':
      return f.children.length === 0 ? { login: VIEWER_LOGIN } : executeSelections(f.children, { login: VIEWER_LOGIN }, 'User', ectx);
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'url':
      return `https://github.com/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
    default:
      return unknownField('Issue', f.name);
  }
}

function resolvePullRequestField(f: FieldNode, parent: { repo: Repo; pr: Pull }, _args: Record<string, unknown>, ectx: ExecCtx): unknown {
  const { store } = ectx;
  const { repo, pr } = parent;
  switch (f.name) {
    case 'id':
      return gqlId('PullRequest', `${repo.owner}/${repo.name}/${pr.number}`);
    case 'databaseId':
      return pr.id;
    case 'number':
      return pr.number;
    case 'title':
      return pr.title;
    case 'body':
      return pr.body;
    case 'state':
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pr.merged;
    case 'mergeable':
      return prConflict(store, repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName':
      return pr.headRef;
    case 'baseRefName':
      return pr.baseRef;
    case 'headRef': {
      const tip = repo.refs.get(`refs/heads/${pr.headRef}`);
      if (tip === undefined) return null;
      return f.children.length === 0 ? { name: pr.headRef } : executeSelections(f.children, { name: pr.headRef }, 'Ref', ectx);
    }
    case 'baseRef': {
      const tip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (tip === undefined) return null;
      return f.children.length === 0 ? { name: pr.baseRef } : executeSelections(f.children, { name: pr.baseRef }, 'Ref', ectx);
    }
    case 'author':
      return f.children.length === 0 ? { login: VIEWER_LOGIN } : executeSelections(f.children, { login: VIEWER_LOGIN }, 'User', ectx);
    case 'createdAt':
      return pr.createdAt;
    case 'updatedAt':
      return pr.updatedAt;
    case 'mergedAt':
      return pr.mergedAt;
    case 'mergeCommit':
      return pr.mergeSha === null ? null : { oid: pr.mergeSha };
    case 'files': {
      const first = typeof _args.first === 'number' ? _args.first : 10;
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
      const headTree = headTip === undefined ? '' : parseCommit(repo.objects.get(store.peelToCommit(repo, headTip))!.data).tree;
      const headFiles = store.flattenTree(repo, headTree);
      const allPaths = new Set([...pr.baseFiles.keys(), ...headFiles.keys()]);
      const nodes: Record<string, unknown>[] = [];
      for (const path of [...allPaths].sort()) {
        const bOid = pr.baseFiles.has(path) ? pr.baseFiles.get(path)! : null;
        const hOid = headFiles.get(path)?.oid ?? null;
        if (bOid === hOid) continue;
        nodes.push({ path });
      }
      const page = nodes.slice(0, first);
      const conn = { nodes: page, hasNextPage: nodes.length > first, endCursor: null as string | null };
      if (f.children.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const sel of f.children) {
        if (sel.kind !== 'field') continue;
        if (sel.field.name === 'nodes') {
          out[sel.field.alias ?? 'nodes'] = conn.nodes.map((n) =>
            sel.field.children.length === 0 ? n : executeSelections(sel.field.children, n, 'PullRequestFile', ectx),
          );
        } else if (sel.field.name === 'pageInfo') {
          out[sel.field.alias ?? 'pageInfo'] =
            sel.field.children.length === 0 ? conn : executeSelections(sel.field.children, conn, 'PageInfo', ectx);
        } else if (sel.field.name === 'totalCount') {
          out[sel.field.alias ?? 'totalCount'] = nodes.length;
        } else {
          return unknownField('PullRequestFileConnection', sel.field.name);
        }
      }
      return out;
    }
    default:
      return unknownField('PullRequest', f.name);
  }
}

function resolveUserField(f: FieldNode, parent: { login: string }, _ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'login':
      return parent.login;
    case 'id':
      return gqlId('User', parent.login);
    default:
      return unknownField('User', f.name);
  }
}

function resolveRefField(f: FieldNode, parent: { name: string }, _ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'name':
      return parent.name;
    case 'id':
      return gqlId('Ref', parent.name);
    default:
      return unknownField('Ref', f.name);
  }
}

function resolveConnectionField(f: FieldNode, parent: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }, ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'nodes':
      return parent.nodes;
    case 'pageInfo':
      return f.children.length === 0 ? parent : executeSelections(f.children, parent, 'PageInfo', ectx);
    case 'totalCount':
      return parent.nodes.length;
    default:
      return unknownField('Connection', f.name);
  }
}

function resolvePageInfoField(f: FieldNode, parent: { hasNextPage: boolean; endCursor: string | null }, _ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'hasNextPage':
      return parent.hasNextPage;
    case 'endCursor':
      return parent.endCursor;
    case 'hasPreviousPage':
      return false;
    case 'startCursor':
      return parent.endCursor;
    default:
      return unknownField('PageInfo', f.name);
  }
}

function resolveCommentField(f: FieldNode, parent: { comment: Issue['comments'][number] }, _ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'id':
      return gqlId('IssueComment', String(parent.comment.id));
    case 'databaseId':
      return parent.comment.id;
    case 'body':
      return parent.comment.body;
    case 'author':
      return { login: VIEWER_LOGIN };
    case 'createdAt':
      return parent.comment.createdAt;
    case 'updatedAt':
      return parent.comment.updatedAt;
    default:
      return unknownField('IssueComment', f.name);
  }
}

function resolveFileField(f: FieldNode, parent: Record<string, unknown>, _ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'path':
      return parent.path ?? null;
    default:
      return unknownField('PullRequestFile', f.name);
  }
}

function resolveTypeField(f: FieldNode, parent: { name: string }, ectx: ExecCtx): unknown {
  switch (f.name) {
    case 'name':
      return parent.name;
    case 'fields': {
      const names = TYPE_FIELDS[parent.name] ?? [];
      const nodes = names.map((n) => ({ name: n }));
      if (f.children.length === 0) return nodes;
      return nodes.map((n) => executeSelections(f.children, n, '__Field', ectx));
    }
    case 'enumValues': {
      const names = TYPE_ENUM_VALUES[parent.name] ?? [];
      const nodes = names.map((n) => ({ name: n }));
      if (f.children.length === 0) return nodes;
      return nodes.map((n) => executeSelections(f.children, n, '__EnumValue', ectx));
    }
    default:
      return unknownField('__Type', f.name);
  }
}

function resolvePayloadField(f: FieldNode, parent: Record<string, unknown>, typeName: string, ectx: ExecCtx): unknown {
  const value = parent[f.name];
  if (value === undefined) return unknownField(typeName, f.name);
  if (f.children.length === 0) return value;
  const targetType =
    f.name === 'issue' ? 'Issue' : f.name === 'pullRequest' ? 'PullRequest' : f.name === 'commentEdge' ? 'CommentEdge' : typeName;
  return executeSelections(f.children, value as never, targetType, ectx);
}

// __Field / __EnumValue leaf resolvers are handled by executeSelections falling
// through to this generic leaf resolver via resolveField's default branch.
function resolveLeafField(f: FieldNode, parent: Record<string, unknown>): unknown {
  if (f.name === 'name') return parent.name ?? null;
  if (f.name === 'description') return null;
  if (f.name === 'isDeprecated') return false;
  if (f.name === 'deprecationReason') return null;
  return unknownField('__Field', f.name);
}

// ------------------------------------------------------------------ HTTP entry

export function handleGraphql(ctx: Ctx, res: ServerResponse): void {
  const body = ctx.json;
  const isBatch = Array.isArray(body);
  const operations: unknown[] = isBatch ? body : [body];
  const results: unknown[] = [];
  for (const op of operations) {
    if (op === null || typeof op !== 'object' || typeof (op as Record<string, unknown>).query !== 'string') {
      results.push({ errors: [{ message: 'Invalid GraphQL request: query is required' }] });
      continue;
    }
    const { query, variables } = op as { query: string; variables?: Record<string, unknown> };
    const vars: Variables = variables !== undefined && typeof variables === 'object' ? variables : {};
    let operation: Operation;
    try {
      operation = parseDocument(query);
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] });
      continue;
    }
    const ectx: ExecCtx = { store: ctx.store, ctx, vars, errors: [] };
    try {
      const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = executeSelections(operation.selections, null, rootType, ectx);
      results.push({ data });
    } catch (err) {
      if (err instanceof GqlError) {
        results.push({ data: null, errors: [{ message: err.message }] });
      } else {
        results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] });
      }
    }
  }
  sendJson(res, 200, isBatch ? results : results[0]);
}
