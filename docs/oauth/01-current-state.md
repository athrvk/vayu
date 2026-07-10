# Current State of Vayu (pre-OAuth)

Findings from exploring the engine (`/engine`), its database, and the app (`/app`) with OAuth 2.0 in mind. File/line references are against the repo at the time of writing (2026-07).

Architecture recap: the C++ engine is a standalone HTTP daemon on `127.0.0.1:9876` that owns **all persistence and all outbound request execution**; the Electron + React app is a pure client of the engine's REST API. The app never sends the user's HTTP request itself.

---

## 1. HTTP request execution paths in the engine

There are **two** execution paths, both fed by the same request model and the same header-attach logic.

**Request model** — `engine/include/vayu/types.hpp:106-117`:

```cpp
struct Request {
    HttpMethod method = HttpMethod::GET;   // enum, types.hpp:46
    std::string url;
    Headers headers;                       // std::map<std::string,std::string>, types.hpp:88
    Body body;                             // {BodyMode mode; std::string content;}, types.hpp:98-101
    int timeout_ms = 30000;
    bool follow_redirects = true;
    int max_redirects = 10;
    bool verify_ssl = true;
};
```

The model has **no auth field** — `headers` is the only channel to the wire.

**Design-mode single send (`POST /request`):**

- Route handler: `engine/src/http/routes/execution.cpp:274`; body parsed at `:280`, converted to `vayu::Request` by `vayu::json::deserialize_request(json)` at `:288`.
- `deserialize_request` (`engine/src/utils/json.cpp:272-353`) reads **only** `method`, `url`, `headers` (flat JSON object), `body.mode` + `body.content`, and the options `timeout` / `followRedirects` / `maxRedirects` / `verifySSL`. **It does not read `auth`.**
- Send: `vayu::http::Client::send` (`engine/src/http/client.cpp:208`) — curl easy. Headers attached at `client.cpp:252-269` by iterating `request.headers` into a `curl_slist`, then `CURLOPT_HTTPHEADER` at `:268`. Auto-adds `User-Agent` if absent.

**Load-test path (`POST /run`):**

- Route: `execution.cpp:428`. Validates `method` + `url` + mode/duration/iterations, stores a `Run` with `config_snapshot = req.body`, then `RunManager::start_run` at `:503`.
- `RunManager` rebuilds the request from the same JSON via `deserialize_request` (`engine/src/core/run_manager.cpp:67`, `:415`) — so the load path **also ignores `auth`**.
- Load tests use the curl-multi event loop, with a second copy of the header-attach logic in `engine/src/http/event_loop/curl_utils.cpp:136-150`.

**Takeaway:** any injected `Authorization` header only reaches the wire if it is present in `Request.headers`. Neither execution path consults an `auth` object.

## 2. Existing auth support: stored but never applied

This is the single most important finding. **The engine never applies auth to an outgoing request**, and neither does the app:

- `db::Collection::auth` and `db::Request::auth` are opaque `std::string` JSON columns (`engine/include/vayu/types.hpp:678`, `:696`), serialized back out verbatim (`engine/src/utils/json.cpp:154-163` collection, defaulting to `{"mode":"none"}`; `:216-224` and `:597-611` request, defaulting to `{"mode":"inherit"}`), and accepted on write (`engine/src/http/routes/collections.cpp:116-120`, `engine/src/http/routes/requests.cpp:215-216`).
- There is **no** `Authorization`-building code anywhere in `engine/src` (the only `"Authorization"` literal is the CORS allow-list at `engine/src/http/server.cpp:107`).
- The app *does* send an `auth` field on execute (see §6), and it resolves inheritance and variables into it — but it never merges it into `headers`, and the engine drops it.

Net effect: **bearer / basic / api-key auth configured in the Auth panel today does not reach the wire.** The user must type an `Authorization` header manually. OAuth work must fix this general gap, not just add a new mode on top of a broken pipeline.

## 3. Engine HTTP server & route conventions

- Server: cpp-httplib, `engine/src/http/server.cpp`. Binds `127.0.0.1:<port>` (`:53`), CORS defaults + `OPTIONS .*` preflight (`:105-111`).
- **Route registration is modular**: each group is a free function `register_*_routes(RouteContext&)` declared in `engine/include/vayu/http/routes.hpp:62-72` and called from `Server::setup_routes` (`server.cpp:120-130`). `RouteContext` (routes.hpp:53-59) carries `httplib::Server&`, `db::Database&`, `core::RunManager&`, `bool verbose`, `ShutdownCallback`. A new OAuth endpoint would be a new `register_oauth_routes(ctx)` under `engine/src/http/routes/`.
- JSON conventions: `send_error(res, status, msg)` → `{"error": msg}` (routes.hpp:32-35); `send_json` (routes.hpp:40-42). Status philosophy (`execution.cpp:12-17`): 200 = engine handled it (target-server status lives inside the body), 400 = malformed, 500 = internal.
- Full route list: `/health`, `/config`, `/collections(+/:id)`, `/requests(+/:id)`, `/environments(+/:id)`, `/globals`, `POST /request`, `POST /run`, `/runs`, `/run/:id(+/stop,/report)`, `/stats/:runId` (SSE), `/metrics/live/:runId` (SSE), `/scripting/completions`, `POST /import/fetch`.
- **Outbound-HTTP-from-a-route precedent** (directly relevant to a token endpoint): `POST /import/fetch` (`engine/src/http/routes/import.cpp:27-78`) parses `{"url"}`, validates the scheme, calls `vayu::http::Client::get`, returns `{content, contentType}`. An OAuth token-exchange route can mirror this exactly with a POST to the token URL.

## 4. Database layer

- SQLite via `sqlite_orm`; schema and impl in `engine/src/db/database.cpp` (PImpl), public API in `engine/include/vayu/db/database.hpp`.
- DB file: `<data-dir>/db/vayu.db` (`engine/src/daemon.cpp:114`, `:151`). In production the app spawns the engine with `--data-dir <app.getPath("userData")>` (`app/electron/sidecar.ts:185-195`, `:350-364`), so dev = `<repo>/engine/data`, prod = Electron userData.
- Schema: one `make_storage(path)` listing all tables (`database.cpp:179-265`); enum↔TEXT adapters at `:51-168`. Tables: `collections`, `requests`, `environments`, `globals`, `runs`, `metrics`, `results`, `config_entries`.
- **Migration**: `storage.sync_schema()` (`database.cpp:399/446/460`) auto-creates tables/columns; there are no hand-written migration scripts. Backup/restore-on-corruption wraps the ctor (`database.cpp:343-460`).
- **The engine is the single source of truth** for collections, requests, environments, globals, config, and all run/metric data. The app has no domain database — its Zustand stores are ephemeral UI state; all CRUD goes through `app/src/services/api.ts`.
- Adding a new table (e.g. an `oauth_tokens` cache): (1) add a struct to `namespace db` in `types.hpp`; (2) add a `make_table(...)` line in `make_storage`; (3) add accessors to `class Database`; (4) `sync_schema()` migrates on next start.
- Because `auth` is an opaque JSON TEXT column, **storing an `oauth2` config requires no schema change at all**.

## 5. QuickJS scripting runtime — not a token-injection path

- `engine/src/runtime/script_engine.cpp` (vendored quickjs-ng), sandboxed (timeout/memory/stack limits from config, `execution.cpp:334-343`). Postman-compatible `pm` API: `pm.test`/`pm.expect`, `pm.response.*`, `pm.request.*`, `pm.environment` / `pm.globals` / `pm.collectionVariables` get/set.
- **Critical limitation:** `pm.request` exposes url/method/headers/body as **read-only copies** (`setup_pm_request`, `script_engine.cpp:883-918`; backing pointer is `const Request*`, `:73`). There is no `pm.request.headers.add`/`setHeader`. A pre-request script **cannot mutate the outgoing request**.
- Scripts *can* persist variables (`pm.environment.set` → written back to DB after design-mode runs via `persist_script_variables`, `execution.cpp:82-131`, `:410`), but variable interpolation happens **app-side before send** (§6) — so a script setting a token variable cannot affect the *current* request within the engine.
- **Implication:** the "pre-request script fetches a token" workaround common in Postman is not viable in Vayu as built. OAuth needs first-class support.

## 6. App-side: auth scaffold, send flow, variables

### The auth scaffold that already exists

- **Domain type** — `app/src/types/domain.ts:64-69` already reserves OAuth:

  ```ts
  export type RequestAuth =
    | { mode: "none" | "inherit" }
    | { mode: "bearer"; token: string }
    | { mode: "basic"; username: string; password: string }
    | { mode: "apikey"; key: string; value: string; in: "header" | "query" }
    | { mode: "oauth2" | "digest" | "aws" | "ntlm"; config: Record<string, unknown> };
  ```

  `AuthMode` union at `domain.ts:14-23` lists `"oauth2"`. `Collection.auth` is `Exclude<RequestAuth, {mode:"inherit"}>` (`domain.ts:71-83`) — collections are always concrete auth sources.
- **UI** — `app/src/modules/request-builder/components/RequestTabs/panels/AuthPanel.tsx` is a full auth editor (inherit/none/bearer/basic/api-key with `VariableInput` fields) with an explicit **"OAuth 2.0 - Coming Soon"** disabled badge (`AuthPanel.tsx:16`, `:201-206`). `AuthInheritBanner.tsx` renders resolved inherited auth and already has `oauth2` display cases (`:42-46`). Collection-level editor: `app/src/modules/collections/CollectionDetail/AuthTab.tsx`.
- **Editor state model** — `app/src/modules/request-builder/types.ts`: `AuthType = "none" | "inherit" | "bearer" | "basic" | "api-key"` (`types.ts:48`) and flat `AuthConfigState` (`:55-62`) **do not include oauth2 yet** — these are the types to extend. Editor↔domain mapping lives in `request-builder/index.tsx:130-150` (load) and `:377-398` (save).
- **API types** — `Create/UpdateRequestRequest` carry `auth?: RequestAuth` (`app/src/types/api.ts:79`, `:95`); collection variants at `:43`, `:55`. `RequestTransformer.toFrontend` defaults missing auth to `{mode:"inherit"}` (`app/src/services/transformers/request-transformer.ts:38-42`).

### Send flow (single request)

1. `RequestBuilder.handleExecute` (`app/src/modules/request-builder/index.tsx:173-352`): resolves `{{variables}}` in url/headers/body (`:179-224`), flattens enabled headers via `toFlatHeaders` and injects `X-Request-ID` / `X-Vayu-Version` (`:182-193`).
2. Auth resolution (`:226-238`): `inherit` walks `collectionAncestors` via `resolveInheritedAuth` (`:54-63`); concrete modes go through `authToRecord` (`:65-71`, literally `{...auth}`) then variable resolution. The result is passed as a **separate `auth` field** (`:260`) — **not merged into headers** — and the engine drops it (§2).
3. `useEngine().executeRequest` (`app/src/hooks/useEngine.ts:32-64`) → `apiService.executeRequest` (`app/src/services/api.ts:183-187`) → `httpClient.post("/request", ...)`.
4. Load tests mirror this: `handleConfirmLoadTest` (`index.tsx:435-586`) builds auth identically (`:493-508`) and posts to `/run`.

Payload shape — `ExecuteRequestRequest` (`app/src/types/api.ts:133-144`):

```ts
interface ExecuteRequestRequest {
  method: string; url: string;
  headers?: Record<string, string>;   // resolved, enabled-only
  body?: unknown;
  auth?: Record<string, unknown>;     // sent, but engine ignores it
  preRequestScript?: string; postRequestScript?: string;
  requestId?: string; environmentId?: string;
}
```

### Variables

- Syntax `{{var}}` (`VARIABLE_PATTERN`, `app/src/hooks/useVariableResolver.ts:37`). Priority: Environment > Collection chain (leaf overrides parent) > Global (`useVariableResolver.ts:64-108`).
- Interpolation is **app-side, before send**: `resolveString` / deep `resolveObject` (`:120-151`) — the latter is already used to resolve variables inside auth config bags.
- **Secrets are cosmetic**: `VariableValue.secret` is a UI masking hint only; "values are NOT encrypted at rest" (`domain.ts:41-48`, `:145-150`); Electron main comment confirms "Vayu keeps all secrets in plaintext SQLite" (`app/electron/main.ts:34`). OAuth client secrets and tokens would inherit this weakness — see the security section in [03-design.md](./03-design.md).

## 7. Importers already preserve oauth2 configs

- **Postman** (`app/src/services/importers/postman.ts` + `shared.ts`): `mapPostmanAuth` (`shared.ts:64-96`) maps bearer/basic/apikey to concrete auth; **`oauth2`/`digest`/`aws`/`ntlm` are preserved as `{ mode, config: <flat detail map> }`** (`shared.ts:84-88`), with Postman's key/value arrays flattened by `authDetail` (`:48-61`). Request-level mapping increments `ctx.nonExecutableAuth` for these modes (`postman.ts:92-93`).
- **Insomnia** (`insomnia-v4.ts:36-72`): same pattern — `oauth2`/`digest`/`ntlm`/`iam` preserved as config bags + nonExec counter.
- **OpenAPI v3 / Swagger v2** (`openapi-v3.ts:22-36`, `openapi-v2.ts:21-33`): `type === "oauth2"` → `{ mode: "oauth2", config: {} }` (empty config — flow details from `securitySchemes.flows` are currently discarded) + nonExec counter.
- Surfaced to the user in the import preview as "N auth not executed" (`app/src/modules/collections/ImportModal.tsx:348-357`; `ImportMeta.nonExecutableAuth` documented at `importers/types.ts:26-33`).

So the parse-side is done; the OAuth work is mapping the preserved Postman/Insomnia config-bag keys into Vayu's structured `OAuth2Config` and removing oauth2 from the non-executable count.

## 8. Electron main process capabilities

`app/electron/` (`main.ts`, `preload.ts`, `sidecar.ts`, `updater.ts`, …):

- **IPC pattern**: `ipcMain.handle`/`ipcMain.on` in `main.ts:341-425`, bridged via `contextBridge.exposeInMainWorld("electronAPI", …)` in `preload.ts:16-106`. `contextIsolation: true`, `nodeIntegration: false` (`main.ts:84-88`). Existing channels: engine restart/status, theme, window controls, app paths, updater, settings menu, quit-flush.
- **Single `BrowserWindow`** (`createWindow()`, `main.ts:50-138`); no child windows anywhere.
- **`shell.openExternal` is used** for docs/release links (`main.ts:265, 271, 277`) — the primitive to reuse for launching the system browser to an authorization URL.
- **No deep-link/protocol handler**: no `app.setAsDefaultProtocolClient`, no `open-url`/`second-instance` handlers, no electron-builder `protocols` config.
- **No loopback HTTP server**: the only `net.createServer` is a port-availability probe in `sidecar.ts:36-46`. (Note the engine occupies 9876; an OAuth callback listener must use an ephemeral port.)

**Implication:** every redirect-capture mechanism for the authorization-code flow (loopback listener, custom scheme, or embedded auth window) is new work in Electron main.

## 9. UI building blocks available

- shadcn-based primitives in `app/src/components/ui/` (`Select`, `Input`, `Button`, `Label`, `Badge`, `Switch`, `Dialog`, `Popover`, `Card`, `Textarea`, `Tooltip`, `Separator`, …).
- `VariableInput` (`app/src/modules/request-builder/shared/VariableInput/`) — variable-aware input already used throughout `AuthPanel.tsx`; every OAuth URL/ID/secret field should use it so `{{env}}` references work.
- State: Zustand for UI state (`app/src/stores/`), TanStack Query for server state (`app/src/queries/`, keys in `queries/keys.ts`).
- Design system: `docs/design-system.md` — 3-level elevation (`bg-background`/`bg-panel`/`bg-card`), HSL tokens in `app/src/index.css`, variable references rendered in `text-variable`. New OAuth forms must use tokens, not raw colors.

## 10. Summary of gaps OAuth must fill

| # | Gap | Where |
|---|-----|-------|
| 1 | `auth` is persisted and transmitted but **never applied** to outgoing requests (all modes, both paths) | `engine/src/utils/json.cpp:272` / `execution.cpp` / `run_manager.cpp` |
| 2 | No token acquisition machinery (no token endpoint client, no cache, no refresh) | engine + app |
| 3 | No browser/redirect plumbing for interactive flows (no loopback server, no protocol handler, no auth window) | `app/electron/main.ts` |
| 4 | Editor types/UI lack oauth2 (`AuthType`, `AuthConfigState`, AuthPanel form) | `app/src/modules/request-builder/` |
| 5 | Imported oauth2 config bags are unmapped and flagged non-executable | `app/src/services/importers/` |
| 6 | Secrets (incl. future tokens/client secrets) are plaintext in SQLite | engine DB / `app/electron/main.ts:34` |
