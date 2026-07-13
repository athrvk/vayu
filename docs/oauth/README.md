# OAuth 2.0 for Vayu — Research & Design

This directory contains the research and design work for adding OAuth 2.0 support to Vayu — the shared understanding the implementation follows.

**Status:** Engine PR 1 (static bearer/basic/apikey auth resolution) plus a structural refactor have landed on `claude/vayu-oauth-2-support-hsqpau`. See [04-implementation-plan.md §0](./04-implementation-plan.md#0-implementation-status) for what exists and how it deviates from the plan. The oauth2 token machinery, routes, and all app/UI work are still to come.

| Doc | Contents |
|-----|----------|
| [01-current-state.md](./01-current-state.md) | How Vayu works today: engine execution paths, DB layer, scripting runtime, app auth scaffold, variables, send flow, importers, Electron main capabilities — with file/line references |
| [02-postman-bruno.md](./02-postman-bruno.md) | How Postman and Bruno implement OAuth 2.0: grant types, config fields, storage formats (Postman collection v2.1 `auth.oauth2`, Bruno `.bru` `auth:oauth2`), Electron flow mechanics, token caching/refresh, and RFC-level best practices |
| [03-design.md](./03-design.md) | The proposed Vayu design: typed `OAuth2Config` schema, token acquisition/caching/injection architecture, UI plan, importer mapping tables, security considerations, and a phased implementation roadmap |
| [04-implementation-plan.md](./04-implementation-plan.md) | The in-depth engine + UI implementation plan: exact files, signatures, JSON contracts, call-site placement, test matrix, PR slicing, and corrections to 03-design found by reading the real code |

## TL;DR

**Where we are.** Vayu already has most of the *storage and UI scaffolding* for OAuth 2.0: the domain type `RequestAuth` reserves `{ mode: "oauth2", config }`, the engine persists auth as an opaque JSON column (no migration needed), collection→request auth inheritance exists, importers already preserve Postman/Insomnia/OpenAPI oauth2 blocks, and the request-builder Auth panel has an "OAuth 2.0 — Coming Soon" stub.

**The catch.** Nothing in Vayu *applies* auth at execution time. The app sends an `auth` field to the engine's `POST /request` and `POST /run`, but the engine's deserializer silently drops it — even bearer/basic/api-key never reach the wire unless the user types an `Authorization` header manually. OAuth work must close this pre-existing gap, not just add a new mode.

**The recommendation** (detailed in [03-design.md](./03-design.md)):

1. **Resolve auth into headers in the engine** (`deserialize_request` / execution path), so both single sends and load-test runs get correct auth — this fixes bearer/basic/apikey too.
2. **Non-interactive OAuth flows** (client credentials, password, refresh token) run in the **engine** via a new `POST /oauth2/token` route modeled on the existing `POST /import/fetch` outbound-HTTP precedent, with a token cache table in SQLite.
3. **Interactive flows** (authorization code + PKCE) run in **Electron main** — system browser via `shell.openExternal` + ephemeral loopback HTTP listener (RFC 8252), with an embedded hardened `BrowserWindow` as fallback (Bruno's approach) — because the C++ sidecar cannot own a browser window.
4. **Phased delivery**: Phase 1 client credentials + password (no browser needed), Phase 2 authorization code + PKCE, Phase 3 token manager UI + auto-refresh polish, Phase 4 importer executability + `safeStorage` encryption for secrets.
