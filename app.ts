// The HTTP server: one Node process serving the git smart-HTTP endpoints, REST v3, GraphQL v4
// and MCP from a single in-memory store. main.ts binds it to an ephemeral port and registers it
// with the env; this file only answers requests.
//
// Auth: the Bearer token is MAKEFUN_SHOP_TOKEN. A request is authed when its Authorization header
// carries exactly that token. (When the variable is unset — local smoke tests only — every request
// is treated as authed; the trial always sets it.) Every reply carries a non-empty
// X-GitHub-Request-Id, a deterministic per-process counter.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, parseTrialNow } from './lib/store.ts';
import { handleGit, type GitRequest, type GitResponse } from './lib/git.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

/** The largest request body accepted: packs stay well under this, and it bounds memory. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The request-id counter: deterministic, non-empty, unique per reply. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** True when the request's Authorization header carries the shop token. */
function isAuthed(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${SHOP_TOKEN}`;
}

/** A shared empty query set for requests without a query string (handlers only read from it). */
const EMPTY_QUERY = new URLSearchParams();

/** Read the whole request body (empty for a GET), rejecting an over-large one. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, response: GitResponse): void {
  const headers: Record<string, string> = { ...response.headers, 'x-github-request-id': nextRequestId() };
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  });
}

/** Create the server (main.ts binds it). The store is built once, from MAKEFUN_TRIAL_NOW. */
export function createApp(): Server {
  const store = new Store(parseTrialNow(process.env.MAKEFUN_TRIAL_NOW));

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Split the path and query by hand: a full URL parse costs more than this request's work.
        const rawUrl = req.url ?? '/';
        const qIndex = rawUrl.indexOf('?');
        const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
        const query = qIndex < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIndex + 1));
        const method = req.method ?? 'GET';

        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GET and HEAD never carry a body on this surface; do not wait a tick for one.
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const request: GitRequest = {
          method,
          path,
          query,
          headers: req.headers,
          body,
          authed: isAuthed(req),
        };

        const git = handleGit(store, request);
        if (git.handled) {
          send(res, git.response);
          return;
        }
        const rest = handleRest(store, request);
        if (rest.handled) {
          send(res, rest.response);
          return;
        }
        const graphql = handleGraphQL(store, request);
        if (graphql.handled) {
          send(res, graphql.response);
          return;
        }
        const mcp = handleMcp(store, request);
        if (mcp.handled) {
          send(res, mcp.response);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler failure must never kill the server or leave a request hanging.
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        else res.end();
      }
    })();
  });

  // The read benchmark holds one connection for 2,000 sequential requests; keep it alive.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}
