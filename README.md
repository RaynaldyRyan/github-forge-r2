# github-forge

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![make.fun](https://img.shields.io/badge/built%20for-make.fun-green)](https://make.fun)
[![join make.fun](https://img.shields.io/badge/join-make.fun-orange)](https://make.fun/r/rhhrb4xy)

A GitHub-compatible git forge in one Node process, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): git smart HTTP, REST v3,
GraphQL v4 and MCP, with no dependencies, no git binary and no filesystem — everything lives in
memory, and every timestamp comes from the trial clock.

New to make.fun? Sign up with my referral link: https://make.fun/r/rhhrb4xy

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports Node built-ins and its own modules only.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: server/discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Layout

- `main.ts`: the entry <-> env lifecycle (bind, register, wait for done, exit 0).
- `app.ts`: the HTTP server: auth, body reading, routing.
- `lib/store.ts`: the in-memory store, the deterministic clock, the caches.
- `lib/gitobj.ts`: git primitives — objects, trees, commits, pkt-lines, packfiles, fetch planning.
- `lib/git.ts`: the smart-HTTP endpoints, including the cached shallow-clone pack.
- `lib/rest.ts`: REST v3, including the cached issue JSON fast path.
- `lib/graphql.ts`: a small GraphQL parser and executor for the contest's documents.
- `lib/mcp.ts`: the MCP endpoint and its six tools.

## Performance

The four timed workloads share one idea: never recompute what the state already determines.

- **Clone**: a shallow fetch of a given tip is generated once per repository version and cached as
  exact bytes; the 50 concurrent clones serve the same Buffer. Any push or ref update invalidates it.
- **Read**: each issue's REST JSON is serialized once and cached; a read serves the cached Buffer.
- **Push**: objects land in a `Map`, hashed with `node:crypto` and inflated with `node:zlib`;
  the fast-forward check walks parents in memory. No filesystem anywhere.
- **Write**: issue creation is O(1) — one Map insert, one append, one stringify that fills the cache.

Determinism is a hard rule: no wall clock, no unseeded randomness, and no cache ever changes an
observable answer — the final trials are replayed and the state export must match byte for byte.

## Licence

MIT — see [LICENSE](LICENSE).
