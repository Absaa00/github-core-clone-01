// The forge server: one process, one in-memory store. Routes:
//   GET  /healthz                                  boot probe (no auth)
//   GET  /api/v3[/]                                 API root (no auth)
//   GET  /api/v3/meta                              installed_version (no auth)
//   *    /api/v3/**                                REST v3 (Bearer auth)
//   POST /api/graphql                              GraphQL v4 (Bearer auth)
//   POST /mcp                                      MCP Streamable HTTP (Bearer auth)
//   *    /{owner}/{repo}.git/info/refs             git advertisement
//   POST /{owner}/{repo}.git/git-upload-pack       git fetch / ls-refs
//   POST /{owner}/{repo}.git/git-receive-pack      git push
//
// main.ts (lifecycle) is unchanged: it imports createApp from here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { advertisement, handleReceivePack, handleUploadPack, isGitProtocolV2 } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextRequestId, sendJson, sendRaw, type Ctx } from './util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m === null ? undefined : m[1];
}

function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return false;
  return tokenOf(req) === expected;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const host = req.headers.host ?? 'entry';
        let body = Buffer.alloc(0);
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          body = await readBody(req);
        }
        // JSON parse for the JSON surfaces (REST/GraphQL/MCP only).
        const isJsonSurface = path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp';
        let json: unknown = null;
        let jsonError = false;
        if (isJsonSurface && body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            jsonError = true;
          }
        }
        const ctx: Ctx = {
          store,
          method,
          url,
          path,
          headers: req.headers,
          body,
          json,
          jsonError,
          host,
          requestId,
        };

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GitHub API root: 200 with the token's scopes (no auth, like api.github.com).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
            'x-oauth-scopes': 'repo, read:org',
            'x-github-request-id': requestId,
          });
          return;
        }

        // /api/v3/meta: installed version (no auth, like api.github.com).
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, { installed_version: '1.0.0' }, { 'x-github-request-id': requestId });
          return;
        }

        // REST v3 (auth required).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          if (jsonError) {
            sendJson(res, 400, { message: 'Invalid JSON body' }, { 'x-github-request-id': requestId });
            return;
          }
          handleRest(ctx, res);
          return;
        }

        // GraphQL v4 (auth required).
        if (path === '/api/graphql') {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (jsonError) {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          handleGraphql(ctx, res);
          return;
        }

        // MCP (auth required).
        if (path === '/mcp') {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          handleMcp(ctx, res);
          return;
        }

        // Git smart HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          const action = gitMatch[3]!;
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service parameter is required' });
              return;
            }
            const v2 = isGitProtocolV2(req.headers);
            const ad = advertisement(service, repo, v2);
            const adType =
              service === 'git-receive-pack'
                ? 'application/x-git-receive-pack-advertisement'
                : 'application/x-git-upload-pack-advertisement';
            sendRaw(res, 200, ad, adType);
            return;
          }
          if (action === 'git-upload-pack') {
            if (method !== 'POST') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            try {
              const out = handleUploadPack(store, repo, body, isGitProtocolV2(req.headers));
              sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
            } catch (err) {
              sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
            }
            return;
          }
          // git-receive-pack
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const result = handleReceivePack(store, repo, body);
          if (!result.ok) {
            sendJson(res, 400, { message: result.error ?? 'Bad request' });
            return;
          }
          sendRaw(res, 200, result.body!, 'application/x-git-receive-pack-result');
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
