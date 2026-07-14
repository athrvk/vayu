# OAuth 2.0 for Vayu — Proposed Design

This is the recommended implementation/integration design, derived from [01-current-state.md](./01-current-state.md) and [02-postman-bruno.md](./02-postman-bruno.md). It is a design document, not a spec frozen in stone — field names and endpoint shapes may shift during implementation, but the architectural decisions below should hold.

---

## 1. Goals and non-goals

**Goals (v1):**

- Grant types: **Client Credentials**, **Password**, **Authorization Code + PKCE** (PKCE on by default), **Refresh Token** (as a lifecycle mechanism, not a picker entry).
- OAuth config at **request and collection level** with the existing `inherit` chain.
- Tokens acquired once and **injected as headers** into both single sends and load-test runs.
- Token caching with expiry tracking and auto-refresh.
- **Postman/Insomnia import** of oauth2 configs becomes executable.
- While we're in there: **fix the general auth gap** so bearer/basic/apikey actually reach the wire too.

**Non-goals (v1):** Implicit grant (deprecated by OAuth 2.1; import maps it but the UI won't offer it for new configs), Device Code grant (roadmap), OAuth 1.0, token revocation calls, `safeStorage` encryption (Phase 4), multi-token-per-config management UI à la Postman's token list (start with one cached token per config identity).

## 2. The one architectural decision that matters: where auth is applied

Today the app sends `auth` to the engine and the engine drops it (see [01-current-state.md §2](./01-current-state.md)). Two candidate fixes:

**Option A — app-side injection.** The renderer resolves `{mode:"oauth2"}` (and bearer/basic/apikey) into an `Authorization` header before calling `POST /request` / `POST /run`, at the existing seam in `app/src/modules/request-builder/index.tsx` (`handleExecute` header assembly, `:182-193`).

**Option B — engine-side resolution.** Teach the engine to resolve the `auth` object it already receives and persists into `Request.headers` before curl, in a single helper called from both execution paths.

**Recommendation: Option B (engine-side) for auth application, with token *acquisition* split by flow type (see §3).** Reasons:

- The engine already receives and stores `auth` on every request/collection and on every execute payload — the contract exists; only the engine half is missing.
- Load-test runs replay the request from `config_snapshot` inside the engine (`run_manager.cpp:67/415`). App-side injection would bake a token into the snapshot; a long soak run would then fail when the token expires mid-run. Engine-side resolution lets the run's worker refresh mid-run (Phase 3).
- It fixes bearer/basic/apikey everywhere in one move, including any future non-UI clients of the engine API (CLI, CI).
- Auth resolution is pure header math (base64 for basic, prefix concat for bearer/oauth2) — no browser needed, so nothing forces it into Electron.

Concretely:

- New `engine/src/http/auth_resolver.{hpp,cpp}`: `void apply_auth(vayu::Request& req, const nlohmann::json& auth, TokenProvider& tokens)` handling `bearer`, `basic`, `apikey` (header or query), `oauth2` (lookup/fetch token via §3, then place per config). Called from `POST /request` handling (`execution.cpp`, after `deserialize_request`) and from `RunManager` request construction.
- `deserialize_request` stays auth-agnostic; the route/run layer owns resolution (auth needs DB access for token cache, which the deserializer shouldn't have).
- The app keeps sending resolved-variable `auth` exactly as it already does — **no payload change**. Variable interpolation stays app-side (unchanged); the engine sees literal values.

## 3. Token acquisition: split by interactivity

### 3.1 Non-interactive flows → engine (`client_credentials`, `password`, `refresh_token`)

These are a single HTTPS POST — the engine already has the outbound client and a precedent route (`POST /import/fetch`, `import.cpp:27-78`).

New route group `engine/src/http/routes/oauth.cpp`, registered via the standard `register_oauth_routes(RouteContext&)` pattern (`routes.hpp`, `server.cpp:120-130`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/oauth2/token` | Fetch (or return cached) token for a given config. Body: the `OAuth2Config` JSON (§4) + `{"force": bool}`. Returns the cached/stored token record. |
| `GET` | `/oauth2/token?key=<cacheKey>` | Inspect cached token (for UI status display). |
| `DELETE` | `/oauth2/token?key=<cacheKey>` | Clear cached token. |

The token request itself: `application/x-www-form-urlencoded` POST via `vayu::http::Client`, with client auth per `credentialsPlacement` (Basic header default, body fallback — RFC 6749 §2.3.1 URL-encoding). Parse the JSON response (`access_token`, `token_type`, `expires_in`, `refresh_token`, `scope`), stamp `created_at`, persist.

Auto-fetch during execution: when `apply_auth` (§2) meets an oauth2 config whose cached token is missing/expired, it runs the same acquisition inline for non-interactive grants (and refresh), so "just hit Send" works without a separate button press. For `authorization_code` configs with no valid cached token and no usable refresh token, the engine returns a structured error (`{"error":"oauth2_interactive_required", ...}`) that the app turns into a "Get token" prompt.

### 3.2 Interactive flow → Electron main (`authorization_code` + PKCE)

The C++ sidecar cannot own a browser. New module `app/electron/oauth.ts`:

1. Renderer invokes IPC `oauth:authorize` with the resolved config (following the existing `ipcMain.handle` + `preload.ts` contextBridge pattern).
2. Main generates `state` + PKCE `code_verifier`/`code_challenge` (S256; Node `crypto`).
3. **Default: loopback + system browser** (RFC 8252). Start a one-shot `http.createServer` on `127.0.0.1:0` (ephemeral port — engine owns 9876), build the authorization URL with `redirect_uri=http://127.0.0.1:<port>/callback`, open it with the existing `shell.openExternal`. The listener validates `state`, captures `code` (or `error`/`error_description`), responds with a tiny "You can close this tab" page, and closes. Timeout (e.g. 5 min) tears the server down.
4. **Fallback: embedded auth window** (per-config opt-in, for IdPs that reject loopback redirect URIs) — a hardened `BrowserWindow` copying Bruno's mechanics: `nodeIntegration:false`, `contextIsolation:true`, isolated `partition` keyed by config identity, interception via `will-redirect`/`did-navigate`/`did-start-navigation`, callback matching = URL-prefix **and** (`code` param or hash present), full listener cleanup on close.
5. Main exchanges the code at the token URL (including `code_verifier`) — or, to keep all token-endpoint logic in one place, hands `{code, code_verifier, redirect_uri}` to the engine's `/oauth2/token` with `grantType:"authorization_code_exchange"`. **Recommended: engine does the exchange**, so caching/refresh live in exactly one implementation.
6. Result is returned to the renderer; the token is now in the engine cache and subsequent Sends just work.

No custom URI scheme in v1 (registration friction + hijack risk; loopback covers desktop).

## 4. Config schema: `OAuth2Config`

Replace the loose `config: Record<string, unknown>` with a typed shape (stored in the exact same place — the `auth` JSON column — so **no DB migration**). Field names are camelCase, superset-compatible with Postman/Bruno imports:

```ts
// app/src/types/domain.ts
export type OAuth2GrantType =
  | "authorization_code"   // PKCE controlled by `pkce` flag, default true
  | "client_credentials"
  | "password";

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  // endpoints
  authorizationUrl?: string;      // auth code only
  accessTokenUrl: string;
  refreshTokenUrl?: string;       // defaults to accessTokenUrl
  callbackUrl?: string;           // auth code; empty = auto loopback
  // client
  clientId: string;
  clientSecret?: string;          // optional (public client + PKCE)
  credentialsPlacement?: "basic_auth_header" | "body";  // default basic_auth_header
  // grant-specific
  username?: string;              // password grant
  password?: string;              // password grant
  pkce?: boolean;                 // default true for authorization_code
  // request shaping
  scope?: string;                 // space-separated
  state?: string;                 // empty = auto-generate (recommended)
  audience?: string;              // common extension (Auth0 etc.)
  resource?: string;              // RFC 8707
  // token placement
  tokenPlacement?: "header" | "query";   // default header
  headerPrefix?: string;                 // default "Bearer"
  queryParamName?: string;               // default "access_token"
  // lifecycle
  autoFetchToken?: boolean;       // default true
  autoRefreshToken?: boolean;     // default true
  useEmbeddedBrowser?: boolean;   // default false (system browser + loopback)
  credentialsId?: string;         // default "default"; allows multiple identities per config
}
```

`RequestAuth` gains a concrete arm — `{ mode: "oauth2"; config: OAuth2Config }` — while `digest`/`aws`/`ntlm` keep the loose bag. Every string field accepts `{{variables}}` (resolved app-side at execute time, exactly like bearer/basic today).

**Token cache record & key.** New engine table `oauth_tokens` (struct in `types.hpp` `namespace db`, `make_table` in `database.cpp`, auto-created by `sync_schema()`):

```
cache_key TEXT PK   -- hash(accessTokenUrl + clientId + credentialsId [+ username])
access_token TEXT, token_type TEXT, refresh_token TEXT,
scope TEXT, expires_in INTEGER, created_at INTEGER (ms epoch), raw_response TEXT
```

Expiry check: `now > created_at + expires_in*1000 - 45_000` (45 s skew); missing `expires_in` → non-expiring. On refresh: rotate `refresh_token` if the response contains a new one; on refresh failure: delete the row (Bruno's behavior).

> **Cache-key scope caveat.** The key intentionally omits `scope` (and `audience`/`resource`), matching Postman's keying. Two configs for the same endpoint + client + identity that differ only in requested scope therefore share one cached token, so a token minted with a narrow scope can be reused for a request that asks for a broader one (and vice-versa). Set a distinct `credentialsId` to force separate cache slots when the same client is used with different scopes. The final derivation is implemented byte-identically in `vayu::http::oauth::cache_key` (engine) and `computeOAuth2CacheKey` (app), pinned by shared test vectors.

## 5. UI plan

All forms follow `docs/design-system.md` tokens and reuse `components/ui/` primitives + `VariableInput`.

- **`AuthPanel.tsx`** (`app/src/modules/request-builder/components/RequestTabs/panels/AuthPanel.tsx`): replace the "Coming Soon" badge (`:201-206`) with an `OAuth2Form` sub-component. Add `"oauth2"` to `AUTH_TYPES` (`:34-40`). The form: grant-type `Select`, then conditional fields per grant (mirroring the Postman/Bruno field tables in [02-postman-bruno.md](./02-postman-bruno.md)), an advanced `Collapsible` (placement, prefix, audience/resource, embedded-browser toggle), and a token status row: current token (masked) + expiry countdown + **Get New Token** / **Refresh** / **Clear** buttons wired to `/oauth2/token` (and `oauth:authorize` IPC for auth-code).
- **Editor types** (`app/src/modules/request-builder/types.ts`): add `"oauth2"` to `AuthType` (`:48`); rather than flattening ~20 OAuth fields into `AuthConfigState` (`:55-62`), add a nested `oauth2?: OAuth2Config` member. Extend the editor↔domain mapping (`index.tsx:130-150` load, `:377-398` save).
- **Collection editor** (`app/src/modules/collections/CollectionDetail/AuthTab.tsx`): same `OAuth2Form`, shared component.
- **`AuthInheritBanner.tsx`**: already has oauth2 display cases (`:42-46`) — extend the description with grant type.
- **Send-time UX**: when the engine returns `oauth2_interactive_required`, surface a toast/dialog with a "Authorize now" action that runs the interactive flow and retries. Before a **load test** starts, `handleConfirmLoadTest` should ensure a valid token exists (prompt if interactive) — a run must never block on a browser mid-flight.

## 6. Importer mapping

Parse-side preservation already exists; the work is mapping bags → `OAuth2Config` and un-flagging oauth2 from `nonExecutableAuth`.

**Postman** (`app/src/services/importers/shared.ts:84-88`) — key mapping:

| Postman key | `OAuth2Config` field |
|---|---|
| `grant_type` | `grantType` (`authorization_code_with_pkce` → `authorization_code` + `pkce:true`; `password_credentials` → `password`; `implicit` → import as `authorization_code` + warning, or keep non-executable) |
| `authUrl` | `authorizationUrl` |
| `accessTokenUrl` | `accessTokenUrl` |
| `refreshTokenUrl` | `refreshTokenUrl` |
| `redirect_uri` | `callbackUrl` |
| `clientId` / `clientSecret` | `clientId` / `clientSecret` |
| `scope` / `state` | `scope` / `state` |
| `username` / `password` | `username` / `password` |
| `client_authentication` | `credentialsPlacement` (`header`→`basic_auth_header`, `body`→`body`) |
| `challengeAlgorithm` | `pkce` (`S256`→true; `plain` unsupported → warn) |
| `addTokenTo` | `tokenPlacement` (`header`→`header`, `queryParams`→`query`) |
| `headerPrefix` | `headerPrefix` |
| `useBrowser` | `useEmbeddedBrowser` (inverted) |
| `tokenName`, `accessToken`, `tokenType` | ignore config-wise; optionally seed the token cache from `accessToken` |

**Insomnia** (`insomnia-v4.ts:56-62`): camelCase keys (`accessTokenUrl`, `authorizationUrl`, `clientId`, `clientSecret`, `grantType`, `scope`, `usePkce`…) map near-1:1.

**OpenAPI** (`openapi-v3.ts:22-36`): currently emits `config: {}` — extend to read `securityScheme.flows.{clientCredentials,authorizationCode,password}` → `tokenUrl`/`authorizationUrl`/`scopes` (client ID/secret left blank as `{{variables}}` for the user to fill).

Un-count executable oauth2 configs from `nonExecutableAuth` (`postman.ts:92-93`, `insomnia-v4.ts`, `openapi-*.ts`, surfaced in `ImportModal.tsx:348-357`); keep counting `digest`/`aws`/`ntlm` and any oauth2 the mapper couldn't make executable (e.g. implicit-only).

## 7. Security considerations

- **Plaintext at rest (known limitation, unchanged in v1):** Vayu already stores all secrets plaintext in SQLite (`app/electron/main.ts:34`); OAuth client secrets and cached tokens initially share that posture. Phase 4 wraps secret-bearing columns with Electron `safeStorage` (main process encrypts/decrypts; ciphertext on disk) or OS keychain. Until then, docs and UI should not claim secrets are protected.
- **Encourage secretless configs:** default PKCE public-client; `clientSecret` optional; every secret field accepts `{{variable}}` so secrets can live in environments rather than exported collections. Vayu's collection **export** should offer to strip `clientSecret`/`password` values.
- **PKCE + state always:** S256 challenge and random `state` generated per authorization attempt in Electron main; strict state validation on callback; structured error propagation for `?error=`.
- **Loopback listener hygiene:** bind `127.0.0.1` only, one-shot, random port, hard timeout, ignore requests that don't match the expected path+state.
- **Embedded window hardening (fallback only):** `nodeIntegration:false`, `contextIsolation:true`, no preload, isolated `partition` per config identity, strict callback matching, full listener cleanup — per Bruno's implementation and RFC 8252's caveats.
- **Header over query:** default token placement is the `Authorization` header; query placement exists for compatibility but is documented as leaky (logs/referrers).
- **Load-test blast radius:** a misconfigured load test can hammer a token endpoint. Token acquisition happens **once per run** (before start) with mid-run refresh only on expiry — never per-request.
- **Never log tokens:** engine verbose logging and the app's response console must redact `Authorization` request headers and token-endpoint response bodies.

## 8. Phased roadmap

**Phase 1 — foundation + non-interactive grants (no browser work)**
1. Engine: `auth_resolver` applying bearer/basic/apikey/oauth2 headers on both execution paths (closes the pre-existing gap; ship independently testable).
2. Engine: `oauth_tokens` table + `/oauth2/token` route (client_credentials, password, refresh) + inline auto-fetch in `apply_auth`.
3. App: typed `OAuth2Config`, `AuthPanel`/`AuthTab` OAuth form (client credentials + password grants only), token status row.
4. Tests: engine Google Test for auth resolution + token client (mock token server under `scripts/test/`); app unit tests for editor mapping.

**Phase 2 — authorization code + PKCE**
5. Electron `oauth.ts`: loopback listener + `shell.openExternal`, PKCE + state, IPC channels, engine-side code exchange; embedded `BrowserWindow` fallback.
6. UI: grant-type picker gains authorization_code; `oauth2_interactive_required` → authorize-and-retry UX; load-test pre-flight token check.

**Phase 3 — lifecycle polish**
7. Auto-refresh with skew; refresh-token rotation; mid-run refresh for long load tests; Clear/Refresh token management in UI; redaction in logs/console.

**Phase 4 — import executability + secure storage**
8. Importer mapping tables (§6) + drop oauth2 from non-executable counts; OpenAPI flows extraction.
9. `safeStorage` encryption for `clientSecret`/tokens; export-time secret stripping.
10. Roadmap beyond: Device Code grant (RFC 8628), multiple named tokens per config, token revocation.

## 9. Extension-point index (from the exploration)

| Change | File(s) |
|---|---|
| Auth → header resolution (engine) | new `engine/src/http/auth_resolver.{hpp,cpp}`; call sites `engine/src/http/routes/execution.cpp` (~`:288` post-deserialize), `engine/src/core/run_manager.cpp` (`:67`, `:415`) |
| Token route | new `engine/src/http/routes/oauth.cpp`; register in `engine/include/vayu/http/routes.hpp:62-72` + `engine/src/http/server.cpp:120-130`; model on `import.cpp:27-78` |
| Token cache table | `engine/include/vayu/types.hpp` (`namespace db`), `engine/src/db/database.cpp` (`make_storage` ~`:264`, accessors), auto-migrated by `sync_schema()` |
| Domain types | `app/src/types/domain.ts:64-69` (`OAuth2Config`, concrete oauth2 arm) |
| Editor types + mapping | `app/src/modules/request-builder/types.ts:48,55-62`; `index.tsx:130-150`, `:377-398` |
| OAuth form UI | `AuthPanel.tsx:34-40,201-206`; `modules/collections/CollectionDetail/AuthTab.tsx`; shared `OAuth2Form` component; `AuthInheritBanner.tsx:42-46` |
| Send-time UX | `app/src/modules/request-builder/index.tsx:173-352` (execute), `:435-586` (load test pre-flight) |
| Electron interactive flow | new `app/electron/oauth.ts`; IPC registration `app/electron/main.ts:341-425`; bridge `app/electron/preload.ts:16-106`; `shell.openExternal` precedent `main.ts:265` |
| Importers | `app/src/services/importers/shared.ts:64-96`, `postman.ts:92-93`, `insomnia-v4.ts:36-72`, `openapi-v3.ts:22-36`, `openapi-v2.ts:21-33`; preview counter `ImportModal.tsx:348-357` |
