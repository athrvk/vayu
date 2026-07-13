# OAuth 2.0 for Vayu — In-Depth Implementation Plan (Engine + UI)

Companion to [03-design.md](./03-design.md). Where 03 decided the architecture, this document is prescriptive: it names files, signatures, JSON contracts, call-site placement, and PR slicing so implementation does not have to re-derive decisions. All line references were verified against the repo at the time of writing (2026-07).

---

## 0. Implementation status

> **PR 1 (engine static auth) + a structural refactor have landed** on `claude/vayu-oauth-2-support-hsqpau`. The sections below are the original plan; where the shipped code deviates, this section is authoritative.

**What exists now (engine):**

- `engine/include/vayu/utils/encoding.hpp` — `base64_encode`, `url_encode`, `form_encode` (as planned in §2.1).
- `engine/include/vayu/http/auth_resolver.{hpp,cpp}` — **typed auth**, not raw-JSON string matching. `parse_auth(json) → Auth` where `Auth = std::variant<NoAuth, BearerAuth, BasicAuth, ApiKeyAuth, OAuth2Auth, UnsupportedAuth>`; `apply_auth(Request&, const Auth&, Database*)` is an exhaustive `std::visit` with a `static_assert` (a new mode is a compile error until handled). A `apply_auth(Request&, const nlohmann::json&, Database*)` convenience overload parses then applies. Bearer/basic/apikey (header + query) are live; `OAuth2Auth` is the branch PR 2 fills in (it already receives `db`); digest/aws/ntlm are `UnsupportedAuth` no-ops.
- `engine/include/vayu/http/request_builder.{hpp,cpp}` — **single construction pipeline** `build_request(config, db, timeout_ms) → RequestBuild{ok, request, parse_failed, error_code, error_message, detail_code}` (deserialize + timeout + auth). Both `POST /request` and the load-test worker call it; the deserialize→timeout→auth triple is no longer duplicated. This is the seam PR 2's oauth2 resolution flows through.
- `vayu::ErrorCode::AuthRequired` / `AuthFailed` added (§ improvement 4).
- **Case-insensitive `Headers`** — `types.hpp` now defines `Headers = std::map<std::string, std::string, CaseInsensitiveLess>`, so a user-typed `authorization` and an injected `Authorization` can't both reach the wire. Auth injection skips when the target header already exists (`headers.count(name)`); the ad-hoc `has_header_ci` helper is gone.
- `vayu::json::sanitize_config_snapshot(body)` (**replaces the planned `redact_auth_snapshot`**) — an **allowlist**: it reduces the `auth` subtree to `{mode}` and keeps everything else, so no future credential field can leak (stronger than the blocklist §2.5 originally described). Used for `run.config_snapshot` in both handlers.
- Tests: `encoding_test`, `auth_resolver_test` (+ `parse_auth` variant mapping, ci-header precedence), `request_builder_test` (build + snapshot allowlist). Full suite green.

**Deviations from the plan below, and why:**

1. **Typed `Auth` variant** instead of `apply_auth` string-matching raw JSON (plan §2.4). Makes oauth2 impossible to forget — the `static_assert` forces the `OAuth2Auth` branch. PR 2 implements token acquisition inside that branch.
2. **`build_request` pipeline** — the plan wired `apply_auth` at each call site individually; a single builder removes the duplication and is the one place PR 2 touches.
3. **`sanitize_config_snapshot` (allowlist)** instead of `redact_auth_snapshot` (blocklist of known secret keys).
4. **Case-insensitive `Headers`** was promoted from an implicit assumption to a real comparator on the type.

Everything else below — the `oauth_tokens` table, `oauth_client`/`acquire_token`, the `POST /oauth2/token` route, the `POST /run` 409 pre-flight, and the entire app/Electron plan — is **unbuilt and still current**. Read §2.4/§2.5 signatures through the lens of the four deviations above.

**Design decisions (post-review, agreed with maintainer):**

1. **Loopback owner: the engine, not Electron.** The engine hosts the ephemeral `127.0.0.1:<port>/callback` listener, generates PKCE (S256 via a small vendored SHA-256 — no OpenSSL dependency) and `state`, and exchanges the code — the entire authorization-code flow lives in one process and is coverable by Google Test with a mock IdP. Flow: `POST /oauth2/authorize/start {config}` → engine binds the listener and returns `{attemptId, authorizeUrl}` → the app opens `authorizeUrl` in the system browser (a generic `shell:openExternal` IPC in Electron; plain `window.open` in browser dev) → the callback lands in the engine, which validates `state`, exchanges the code, and stores the token in the cache → the app observes completion by polling the token-status endpoint (fast interval during an active attempt). `DELETE /oauth2/authorize/:attemptId` cancels; attempts are single-flight per cache key with a hard 5-minute timeout. This supersedes §3.6's `electron/oauth.ts` design (kept below for reference).
2. **Embedded-window fallback ships in the same phase as the auth-code flow** (not deferred). It is the only path Vayu will ever have for https-only IdPs (Slack, Meta, fintech) since a hosted relay is ruled out. Scope: a hardened, opt-in Electron `BrowserWindow` that watches navigation for the registered redirect URL and returns the final callback URL to the renderer, which hands it to `POST /oauth2/authorize/complete` — PKCE/state validation and the exchange still happen in the engine. Electron never sees tokens.

---

## 1. Improvements over 03-design (found by reading the real code)

These are corrections/refinements discovered while grounding 03-design in the actual source. The architecture — engine-side auth resolution, engine token route + cache, Electron loopback + PKCE — is unchanged.

1. **`auth_resolver` must live in `vayu_core`, not the routes layer.** `engine/CMakeLists.txt` compiles route `.cpp` files only into the `vayu-engine` executable (lines 334–344), while `run_manager.cpp` is part of the `vayu_core` static library (line 253). Since `RunManager::execute_load_test` must call `apply_auth`, the resolver and the token client go into `vayu_core` (`src/http/auth_resolver.cpp`, `src/http/oauth_client.cpp`); only the route file `src/http/routes/oauth.cpp` goes into the `vayu-engine` (+ `vayu_tests`) target lists.
2. **No hash for `cache_key`.** The engine has no hash/base64 utility anywhere in `engine/src` (the only base64 lives in vendored quickjs/hdrhistogram and cpp-httplib's `detail::` namespace). The app must compute the same key for the GET/DELETE status endpoints, so use a plain delimiter-joined key (`"\x1f"` unit separator) instead of a hash — trivially reproducible in TypeScript, debuggable, and tokens are plaintext in SQLite anyway so an opaque key buys nothing.
3. **Base64 must be added, and cannot come from httplib.** `httplib::detail::base64_encode` exists in the vendored header but `vayu_core` does not link httplib (only the executables do). Add a small header-only `engine/include/vayu/utils/encoding.hpp` (base64 + RFC 3986 percent-encode + form-encode), unit-tested.
4. **Interactive-required rides the existing `errorCode` channel for `POST /request`.** The engine's status philosophy (`execution.cpp:12–17`) is "200 = engine handled it; errors live in the body", and curl failures already flow as `Response{status_code: 0, error_code, error_message}` → `SanityResult.errorCode` → `ResponseState.errorCode`. Add `ErrorCode::AuthRequired` / `ErrorCode::AuthFailed` to the enum (`engine/include/vayu/types.hpp:139–166`) instead of inventing a parallel error shape for the execute path. The dedicated `/oauth2/*` routes use HTTP statuses with a **nested** error object `{"error":{"code","message"}}` — `app/src/services/http-client.ts:88–92` already parses exactly that shape into `ApiError.errorCode` (the current flat `{"error":"msg"}` from `send_error` degrades to `UNKNOWN_ERROR`, so the nested shape is required for structured handling).
5. **`config_snapshot` will leak secrets — sanitize it.** Both `POST /request` and `POST /run` persist `req.body` verbatim into `runs.config_snapshot`, including the app-resolved `auth` object (soon containing `clientSecret`/`password`). `RunManager.start_run` receives the in-memory JSON directly, never re-reading the snapshot, so the stored snapshot can be sanitized safely. **Shipped as `sanitize_config_snapshot` (allowlist — auth reduced to `{mode}`), not the blocklist originally sketched in §2.5** — see §0.
6. **Postman minimal exports** (only `accessToken`/`tokenType`/`addTokenTo`) should import as `{mode:"bearer", token}` — immediately executable — rather than "optionally seed the cache" as 03 suggested.
7. **The shared `OAuth2Form` cannot use `VariableInput` directly.** `VariableInput` calls `useRequestBuilderContext()` (`app/src/modules/request-builder/shared/VariableInput/index.tsx`); the collection `AuthTab` (which uses plain `Input` + `text-variable` styling today) has no such provider. The shared form takes an injected `TextInput` component.
8. **Engine `POST /run` should pre-flight auth in the route handler** (before `create_run`, `execution.cpp:493`) and return `409` — the worker thread runs after the `202` has been sent, so a worker-only check would surface as a silently failed run.

---

## 2. Engine implementation

### 2.1 New utility header — `engine/include/vayu/utils/encoding.hpp`

Header-only, `namespace vayu::utils`:

```cpp
std::string base64_encode (std::string_view in);                       // RFC 4648, with padding
std::string url_encode (std::string_view in);                          // RFC 3986 unreserved set
std::string form_encode (const std::vector<std::pair<std::string, std::string>>& fields);
```

~50 lines total, no dependencies beyond `<string>`. Used by auth_resolver (Basic), oauth_client (token POST body; RFC 6749 §2.3.1 client-credential encoding), and the apikey/oauth2 query-placement URL mutation.

### 2.2 `oauth_tokens` table

**Struct** — `engine/include/vayu/types.hpp`, `namespace db` (append after `ConfigEntry`):

```cpp
struct OAuthToken {
    std::string cache_key;     // PK — see §2.3 derivation
    std::string access_token;
    std::string token_type;    // "Bearer" when provider omits it
    std::string refresh_token; // "" = none
    std::string scope;
    int64_t expires_in;        // seconds; 0 = non-expiring
    int64_t created_at;        // ms epoch (system_clock, like Run.start_time)
    std::string raw_response;  // provider JSON, truncated to 4 KiB; debugging only, never logged
};
```

**Schema** — `engine/src/db/database.cpp`, append one `make_table` inside `make_storage` (before the closing paren at ~line 264):

```cpp
make_table ("oauth_tokens",
    make_column ("cache_key", &OAuthToken::cache_key, primary_key ()),
    make_column ("access_token", &OAuthToken::access_token),
    make_column ("token_type", &OAuthToken::token_type),
    make_column ("refresh_token", &OAuthToken::refresh_token),
    make_column ("scope", &OAuthToken::scope),
    make_column ("expires_in", &OAuthToken::expires_in),
    make_column ("created_at", &OAuthToken::created_at),
    make_column ("raw_response", &OAuthToken::raw_response))
```

`sync_schema()` auto-creates it on next start; no migration script (matches the existing "add struct → add make_table → add accessors" recipe in [01 §4](./01-current-state.md)).

**Accessors** — `engine/include/vayu/db/database.hpp` (mirror the Globals trio), implemented in database.cpp with the standard `std::lock_guard<std::recursive_mutex>` + `impl_->storage` pattern:

```cpp
void save_oauth_token (const OAuthToken& t);                          // impl_->storage.replace (t)
std::optional<OAuthToken> get_oauth_token (const std::string& cache_key);
void delete_oauth_token (const std::string& cache_key);              // remove_all<OAuthToken>(where(...))
```

### 2.3 Token client — `engine/include/vayu/http/oauth_client.hpp` + `engine/src/http/oauth_client.cpp` (in `vayu_core`)

The single implementation of token acquisition, used by both the route and `apply_auth`:

```cpp
namespace vayu::http::oauth {

struct TokenError {
    int http_status;                       // 400 | 401 | 409 | 502 (engine-facing)
    std::string code;                      // "oauth2_invalid_config" | "oauth2_interactive_required"
                                           // | "oauth2_provider_error" | "oauth2_network_error"
    std::string message;
    int provider_status = 0;               // set for oauth2_provider_error
    std::string provider_error;            // RFC 6749 "error"
    std::string provider_error_description;
};

struct InteractiveExchange {               // filled from Electron's authorize result
    std::string code;
    std::string code_verifier;             // empty when pkce=false
    std::string redirect_uri;
};

// Deterministic, hash-free. MUST stay byte-identical with
// app/src/services/oauth/cache-key.ts (shared test vectors).
// accessTokenUrl \x1f clientId \x1f (credentialsId|"default") \x1f (grantType=="password" ? username : "")
std::string cache_key (const nlohmann::json& config);

bool is_expired (const vayu::db::OAuthToken& t, int64_t now_ms, int64_t skew_ms = 45'000);
// expired ⇔ expires_in > 0 && now_ms > created_at + expires_in*1000 - skew_ms

std::variant<vayu::db::OAuthToken, TokenError>
acquire_token (vayu::db::Database& db,
               const nlohmann::json& config,          // resolved OAuth2Config (camelCase keys, §3.1)
               bool force_refresh,
               const std::optional<InteractiveExchange>& interactive);

nlohmann::json serialize_token (const vayu::db::OAuthToken& t);       // §2.6 response body
} // namespace vayu::http::oauth
```

`acquire_token` algorithm (implement exactly):

1. **Validate**: `accessTokenUrl` (http/https scheme — mirror the check in `import.cpp:39`) and `clientId` required; `grantType ∈ {client_credentials, password, authorization_code}`. Else `TokenError{400, "oauth2_invalid_config", …}`.
2. **Cache**: `key = cache_key(config)`. If `!force_refresh` and `db.get_oauth_token(key)` exists and not expired → return it.
3. **Refresh**: if the cached token is expired, has a `refresh_token`, and `autoRefreshToken != false` → POST `grant_type=refresh_token&refresh_token=…` (to `refreshTokenUrl` if set, else `accessTokenUrl`). On success: persist (rotate `refresh_token` if the response contains a new one, else carry the old one forward), return. On provider rejection: `db.delete_oauth_token(key)` (Bruno's behavior, [02 §2.4](./02-postman-bruno.md)) and fall through to step 4.
4. **Fresh acquisition** by grant:
   - `client_credentials`: form fields `grant_type=client_credentials` [+ `scope`, `audience`, `resource`].
   - `password`: + `username`, `password`.
   - `authorization_code`: requires `interactive`; if absent → `TokenError{409, "oauth2_interactive_required", "OAuth 2.0 authorization required"}`. Form: `grant_type=authorization_code&code=…&redirect_uri=…` [+ `code_verifier`].
   - **Client authentication** (`credentialsPlacement`, default `basic_auth_header`): header `Authorization: Basic base64(url_encode(clientId) + ":" + url_encode(clientSecret))` per RFC 6749 §2.3.1. `"body"` → `client_id`/`client_secret` form fields. A missing `clientSecret` (public client) always goes in the body as `client_id` only.
   - **Send** via the existing `vayu::http::Client::post(url, body, headers)` (`client.hpp:75–76`; it sets `BodyMode::Text`, so pass `{"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}` explicitly). Transport failure (`result.is_error()` or `resp.has_error()`, cf. `import.cpp:44–54`) → `TokenError{502, "oauth2_network_error", …}`.
   - **Parse**: try JSON; if not JSON, try `k=v&k=v` form decoding (GitHub-style legacy). HTTP ≥ 400 or no `access_token` → `TokenError{401, "oauth2_provider_error"}` carrying `error`/`error_description` when present, else a ≤512-char body snippet. Accept `expires_in` as number **or** numeric string.
   - **Persist** `db::OAuthToken{key, access_token, token_type|"Bearer", refresh_token|"", scope, expires_in|0, now_ms(), raw≤4KiB}` via `save_oauth_token`, return it.

**Logging**: `log_info` the grant type and token URL only. Never log form bodies, `Authorization` headers, or response bodies.

### 2.4 Auth resolver — `engine/include/vayu/http/auth_resolver.hpp` + `engine/src/http/auth_resolver.cpp` (in `vayu_core`)

> **Shipped shape differs — see §0.** `apply_auth` takes the typed `const Auth&` variant (with a `nlohmann::json` convenience overload) and dispatches via an exhaustive `std::visit`; oauth2 is the `OAuth2Auth` branch, which already receives `db`. `AuthApplyResult` exists as below. The `preflight_auth` free function shown here is **not yet built** — PR 2 adds it for the `POST /run` 409 (§2.5). The mode-behavior table and rules below remain the spec for the oauth2 branch and the pre-flight.

```cpp
namespace vayu::http {

struct AuthApplyResult {
    bool ok = true;
    vayu::ErrorCode code = vayu::ErrorCode::None;   // AuthRequired | AuthFailed
    std::string message;
    std::string detail_code;                        // "oauth2_interactive_required" etc.
};

// SHIPPED: typed dispatch (see §0). oauth2 branch receives db (may be null →
// AuthFailed). The json overload parses then applies; used by build_request/tests.
AuthApplyResult apply_auth (vayu::Request& req, const Auth& auth, vayu::db::Database* db);
AuthApplyResult apply_auth (vayu::Request& req, const nlohmann::json& auth, vayu::db::Database* db);

// TODO (PR 2): route-level pre-flight for POST /run — for oauth2 runs
// acquire_token (cache-aware, warming the cache for the worker); no-op ok otherwise.
AuthApplyResult preflight_auth (const nlohmann::json& auth, vayu::db::Database& db);
}
```

Per-mode behavior of `apply_auth`:

| mode | action |
|---|---|
| absent / null / `none` / `inherit` | no-op ok (`inherit` should already be resolved app-side; log_debug if it reaches the engine) |
| `bearer` | `headers["Authorization"] = "Bearer " + token` |
| `basic` | `headers["Authorization"] = "Basic " + base64_encode(username + ":" + password)` (raw, no URL-encoding — this is HTTP Basic, not §2.3.1) |
| `apikey`, `in=header` | `headers[key] = value` |
| `apikey`, `in=query` | `append_query_param(req.url, key, value)` |
| `oauth2` | parse config; `acquire_token(db, config, false, nullopt)`; on token → placement `header` (default): `headers["Authorization"] = (headerPrefix\|"Bearer") + " " + access_token` (empty prefix → bare token); placement `query`: `append_query_param(url, queryParamName\|"access_token", token)`. `TokenError{409}` → `{ok:false, AuthRequired, msg, "oauth2_interactive_required"}`; other errors → `{ok:false, AuthFailed, msg, code}` |
| `digest` / `aws` / `ntlm` | no-op ok (stored-not-executed, unchanged) |

Rules:

- **User-typed header wins**: skip injection if the target header already exists. Since `Headers` is now case-insensitive (§0), this is a plain `req.headers.count(name) == 0` check — no dual-case scan. Document in the UI hint text.
- `append_query_param(url, k, v)` (file-local helper, unit-tested): split off `#fragment` if present; append `(url.contains('?') ? '&' : '?') + url_encode(k) + "=" + url_encode(v)`; re-attach fragment. Existing params with the same key are left in place.
- If `autoFetchToken == false` and there is no valid cached token → `AuthRequired` (no silent fetch).

**ErrorCode additions** — `engine/include/vayu/types.hpp:139–166`: add `AuthRequired, AuthFailed` to the enum and `"AUTH_REQUIRED"` / `"AUTH_FAILED"` cases to `to_string`.

### 2.5 Call sites

**`POST /request`** (`engine/src/http/routes/execution.cpp`) — insert after the timeout override (`:377–379`), **before** the pre-request script block (`:381`). Scripts see the final header set through read-only `pm.request` (they cannot mutate it anyway), and an interactive-required error short-circuits before user scripts run:

```cpp
auto auth_result = vayu::http::apply_auth (
    request, json.value ("auth", nlohmann::json ()), &ctx.db);
if (!auth_result.ok) {
    vayu::Response auth_resp;
    auth_resp.status_code   = 0;                       // client-side-failure convention (client.cpp:411)
    auth_resp.status_text   = vayu::http::status_text (0);
    auth_resp.error_code    = auth_result.code;        // AUTH_REQUIRED / AUTH_FAILED
    auth_resp.error_message = auth_result.message;
    store_result (ctx.db, run_id, request, auth_resp); // run ends Failed, visible in history
    nlohmann::json body = vayu::json::serialize (auth_resp);
    body["authErrorCode"] = auth_result.detail_code;   // machine hint for the app
    res.status = 200;
    res.set_content (body.dump (2), "application/json");
    return;
}
```

**Load path** (`engine/src/core/run_manager.cpp`, `execute_load_test`) — insert after `request.timeout_ms = timeout_ms;` (`:425`), before `LoadStrategy::create/execute` (`:431`), mirroring the deserialize-failure branch just above it (`:416–422`):

```cpp
auto auth_result = vayu::http::apply_auth (
    request, config.value ("auth", nlohmann::json ()), db_ptr);
if (!auth_result.ok) {
    vayu::utils::log_error ("Run auth resolution failed: " + auth_result.message);
    db.update_run_status (context->run_id, vayu::RunStatus::Failed);
    context->is_running = false;
    if (context->metrics_thread.joinable ()) context->metrics_thread.join ();
    manager.retain_run (context->run_id);
    return;
}
```

The event loop attaches `request.headers` per transfer (`curl_utils.cpp:136–150`), so one mutation before the strategy starts covers every request in the run. Token acquisition is **once per run** — never per-request ([03 §7](./03-design.md) blast-radius rule holds).

**`POST /run` route pre-flight** (`execution.cpp`, before `ctx.db.create_run (run)` at `:493`):

```cpp
auto pf = vayu::http::preflight_auth (json.value ("auth", nlohmann::json ()), ctx.db);
if (!pf.ok) {
    res.status = (pf.code == vayu::ErrorCode::AuthRequired) ? 409 : 400;
    res.set_content (nlohmann::json{ { "error",
        { { "code", pf.detail_code }, { "message", pf.message } } } }.dump (),
        "application/json");
    return;
}
```

This both rejects early (good UX; `ApiError.errorCode` carries the code) and warms the token cache so the worker's `apply_auth` is a cache hit.

**Snapshot sanitization** — **SHIPPED** in `engine/src/utils/json.cpp` as an allowlist (not the blocklist sketched here):

```cpp
// Reduces the top-level "auth" object to just {mode}, keeping all other fields.
// Allowlist, so no future credential field can leak. Non-JSON passes through.
std::string sanitize_config_snapshot (const std::string& body);
```

Used for `run.config_snapshot` in both `POST /request` and `POST /run`. `RunManager` keeps using the un-sanitized in-memory `json`, and the history UI reads only url/method/mode/duration (`RunConfigSnapshot`, `domain.ts:173–185`) — no behavior change.

`deserialize_request` (`json.cpp:272–353`) stays auth-agnostic, exactly as [03 §2](./03-design.md) specified.

### 2.6 Routes — `engine/src/http/routes/oauth.cpp`

Registration: add `void register_oauth_routes (RouteContext& ctx);` to `engine/include/vayu/http/routes.hpp` and the call in `Server::setup_routes` (`engine/src/http/server.cpp:120–130`). CORS needs no change — wildcard defaults + `OPTIONS .*` preflight (`server.cpp:105–111`) cover new paths and the DELETE method.

Follow import.cpp's **testable free-function pattern** (`import.cpp:27`, tested without a server in `import_route_test.cpp:16–19`):

```cpp
// Declared at namespace scope for oauth_route_test.cpp.
std::pair<int, nlohmann::json> oauth2_token_post (vayu::db::Database& db, const std::string& body);
std::pair<int, nlohmann::json> oauth2_token_get (vayu::db::Database& db, const std::string& key);
std::pair<int, nlohmann::json> oauth2_token_delete (vayu::db::Database& db, const std::string& key);
```

**`POST /oauth2/token`** — request:

```json
{
  "config":      { "...": "resolved OAuth2Config (variables already substituted app-side)" },
  "force":       false,
  "interactive": { "code": "...", "codeVerifier": "...", "redirectUri": "http://127.0.0.1:PORT/callback" }
}
```

`force` and `interactive` are optional. Success `200` (from `serialize_token`):

```json
{
  "cacheKey": "...", "accessToken": "...", "tokenType": "Bearer",
  "scope": "openid profile", "expiresIn": 3600,
  "createdAt": 1782800000000, "expiresAt": 1782803600000,
  "hasRefreshToken": true
}
```

(`expiresAt = createdAt + expiresIn*1000`, `null` when `expiresIn == 0`.) Errors map 1:1 from `TokenError` — status = `http_status`, body:

```json
{ "error": { "code": "oauth2_provider_error", "message": "...",
             "providerStatus": 400, "providerError": "invalid_client",
             "providerErrorDescription": "..." } }
```

Statuses: `400 oauth2_invalid_config`, `409 oauth2_interactive_required`, `401 oauth2_provider_error`, `502 oauth2_network_error`.

**`GET /oauth2/token?key=<cacheKey>`** → `200 {"found": false}` or `200 {"found": true, "expired": bool, "token": {…serialize_token…}}`. (The renderer masks the token for display; the engine is a localhost-trusted daemon and the renderer legitimately needs it for the status row.)

**`DELETE /oauth2/token?key=<cacheKey>`** → `200 {"deleted": true|false}`.

### 2.7 Build changes (`engine/CMakeLists.txt`)

- `vayu_core` sources (~line 237 list): add `src/http/auth_resolver.cpp`, `src/http/oauth_client.cpp`.
- `vayu-engine` sources (~line 331): add `src/http/routes/oauth.cpp`.
- `vayu_tests` sources (~line 362): add `src/http/routes/oauth.cpp` plus the new test files below (route sources are compiled into the test target — the existing precedent is `import.cpp`/`execution.cpp` at `:378–379`).

### 2.8 Engine tests (Google Test, `engine/tests/`)

| File | Coverage |
|---|---|
| `tests/encoding_test.cpp` | RFC 4648 base64 vectors, url_encode reserved chars, form_encode ordering/escaping |
| `tests/auth_resolver_test.cpp` | bearer/basic/apikey header + query (URL with existing `?`, with `#fragment`), none/inherit no-ops, user-`Authorization` precedence, oauth2 with `db == nullptr` → `AuthFailed`. Pure, no network |
| `tests/oauth_client_test.cpp` | `MockTokenServer` (httplib, modeled on `MockSpecServer` in `import_route_test.cpp:23–51` — `bind_to_any_port("127.0.0.1")` + wait-until-ready): `POST /token` asserts Content-Type, Basic header vs body creds, grant_type; canned responses. Cases: fetch+persist, cache hit, `force`, missing `expires_in` (non-expiring), expiry→refresh, refresh-token rotation, refresh failure deletes row, provider 400 `{"error":"invalid_client"}`, non-JSON body, connection failure (`http://127.0.0.1:1`, cf. `import_route_test.cpp:75`), auth-code without `interactive` → 409, exchange with `code_verifier`, `cache_key` **shared vectors** (see §3.1). Temp-file `Database` per the `db_test.cpp` pattern |
| `tests/oauth_route_test.cpp` | `oauth2_token_post/get/delete` free functions with raw JSON strings: 400 shapes, 409 shape, found/not-found, delete semantics |
| `tests/db_test.cpp` | extend with `OAuthToken` save/get/delete round-trip |

---

## 3. App implementation

### 3.1 Types

**`app/src/types/domain.ts`** — insert above `RequestAuth` (`:64`):

```ts
export type OAuth2GrantType = "authorization_code" | "client_credentials" | "password";

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  authorizationUrl?: string;      // authorization_code only
  accessTokenUrl: string;
  refreshTokenUrl?: string;       // defaults to accessTokenUrl
  callbackUrl?: string;           // empty = auto loopback
  clientId: string;
  clientSecret?: string;
  credentialsPlacement?: "basic_auth_header" | "body";   // default basic_auth_header
  username?: string;              // password grant
  password?: string;              // password grant
  pkce?: boolean;                 // default true (authorization_code)
  scope?: string;
  audience?: string;
  resource?: string;
  tokenPlacement?: "header" | "query";   // default header
  headerPrefix?: string;                 // default "Bearer"
  queryParamName?: string;               // default "access_token"
  autoFetchToken?: boolean;       // default true
  autoRefreshToken?: boolean;     // default true
  useEmbeddedBrowser?: boolean;   // default false
  credentialsId?: string;         // default "default"
}
```

Split the loose arm of `RequestAuth` (`:69`):

```ts
| { mode: "oauth2"; config: OAuth2Config }
| { mode: "digest" | "aws" | "ntlm"; config: Record<string, unknown> };
```

(Note: `state` is intentionally **not** in the config — it is always auto-generated per attempt; importers drop it.)

**`app/src/types/api.ts`** — add:

```ts
export interface OAuth2InteractiveExchange { code: string; codeVerifier: string; redirectUri: string; }
export interface OAuth2TokenRequest { config: OAuth2Config; force?: boolean; interactive?: OAuth2InteractiveExchange; }
export interface OAuth2TokenResponse {
  cacheKey: string; accessToken: string; tokenType: string; scope?: string;
  expiresIn: number; createdAt: number; expiresAt: number | null; hasRefreshToken: boolean;
}
export interface OAuth2TokenStatusResponse { found: boolean; expired?: boolean; token?: OAuth2TokenResponse; }
```

`ExecuteRequestRequest.auth` / `StartLoadTestRequest.auth` (`api.ts:139`, `:161`) stay `Record<string, unknown>` — no payload change.

**New `app/src/services/oauth/` module:**

- `defaults.ts` — `defaultOAuth2Config(): OAuth2Config` (grantType `client_credentials`, placement/prefix/toggles per defaults above).
- `cache-key.ts` — `computeOAuth2CacheKey(config: OAuth2Config): string` = `[accessTokenUrl, clientId, credentialsId ?? "default", grantType === "password" ? username ?? "" : ""].join("\x1f")` — the byte-for-byte twin of engine `oauth::cache_key`. Both test suites assert the same fixed vectors (document the vectors in both files).
- `authorize.ts` — Phase 2, see §3.4.

### 3.2 Editor state + mapping

**`app/src/modules/request-builder/types.ts`**: `AuthType` (`:48`) gains `"oauth2"`; `AuthConfigState` (`:55–62`) gains `oauth2?: OAuth2Config;` (nested — do not flatten ~20 fields).

**Extract the editor↔domain mapping into pure functions** (new `app/src/modules/request-builder/utils/auth-mapping.ts`) so it becomes unit-testable, replacing the inline blocks at `index.tsx:130–150` (load) and `:377–398` (save):

```ts
export function authToEditor(auth: RequestAuth): { authType: AuthType; authConfig: AuthConfigState };
export function editorToAuth(authType: AuthType, authConfig: AuthConfigState): RequestAuth;
```

New branches: `auth.mode === "oauth2"` → `{ authType: "oauth2", authConfig: { oauth2: auth.config } }`; save: `{ mode: "oauth2", config: authConfig.oauth2 ?? defaultOAuth2Config() }`.

### 3.3 Shared `OAuth2Form`

**Location**: `app/src/components/shared/OAuth2Form/` (new directory; `components/ui/` stays primitives-only). Files: `index.tsx`, `TokenStatusRow.tsx`, `grant-fields.ts`.

```ts
interface OAuth2FormProps {
  value: OAuth2Config;
  onChange: (next: OAuth2Config) => void;
  resolveString?: (s: string) => string;            // variable resolution for token actions
  TextInput?: React.ComponentType<{ value: string; onChange: (v: string) => void;
                                    placeholder?: string; type?: "text" | "password" }>;
}
```

- **Request builder** (`AuthPanel.tsx`): passes a `VariableInput` adapter (context available) and `resolveString` from the builder context (`RequestBuilderContextValue.resolveString`, `types.ts:192`).
- **Collection editor** (`AuthTab.tsx`): passes an `Input`-based adapter with the existing `text-variable` highlight (`cn("font-mono", v.includes("{{") && "text-variable")`, `AuthTab.tsx:221`) and `useVariableResolver({ collectionId }).resolveString`.

Layout (design-system tokens; `components/ui` primitives — `Select`, `Label`, `Input`, `Button`, `Badge`, `Collapsible` (exists: `ui/collapsible.tsx`), `Switch`, `Separator`, `Tooltip`):

1. **Grant type `Select`** — Phase 1: Client Credentials, Password; Phase 2 adds Authorization Code (PKCE).
2. **Per-grant fields** (visibility map in `grant-fields.ts`, mirroring [02 §1.2/§2.2](./02-postman-bruno.md)):
   - all: Access Token URL, Client ID, Client Secret (password-type input), Scope
   - `password`: + Username, Password
   - `authorization_code`: + Authorization URL, Callback URL (placeholder `auto — 127.0.0.1 loopback`), PKCE `Switch` (default on)
3. **Advanced `Collapsible`**: Client Authentication (`Select` basic header/body), Header Prefix, Token Placement (+ Query Param Name when `query`), Audience, Resource, Refresh Token URL, Credentials ID, Auto-fetch / Auto-refresh `Switch`es, Use Embedded Browser `Switch` (auth-code only).
4. **`TokenStatusRow`** — driven by `useOAuth2TokenStatusQuery(cacheKey)` where `cacheKey = computeOAuth2CacheKey(resolvedConfig)` (null when accessTokenUrl/clientId are blank). States:
   - *no token*: muted "No token cached" + **Get Token**
   - *valid*: status dot + masked token (`abcd…wxyz`) + "expires in 43m" countdown (or "does not expire") + **Refresh** + **Clear**
   - *expired*: amber + **Refresh** (falls back to Get Token when no refresh token)
   - *fetching*: spinner on the acting button (mutation `isPending`)
   - *error*: destructive-colored `ApiError.message` + retry
   - **Get Token / Refresh**: non-interactive grants → `useFetchOAuth2TokenMutation` with `{config: resolved config, force: true}`; `authorization_code` → `runInteractiveAuthorization` (§3.4). **Clear** → `useClearOAuth2TokenMutation`.

**Wiring:**

- `AuthPanel.tsx`: add `{ value: "oauth2", label: "OAuth 2.0", icon: ShieldCheck }` to `AUTH_TYPES` (`:34–40`); delete the "Coming Soon" block (`:201–206`); `handleTypeChange` (`:47–67`) initializes `{ oauth2: authConfig.oauth2 ?? defaultOAuth2Config() }`; render `<OAuth2Form value={authConfig.oauth2 ?? …} onChange={(oauth2) => updateConfig({ oauth2 })} …/>`.
- `AuthTab.tsx`: add `"oauth2"` to `CollectionAuthMode` + `AUTH_OPTIONS` (`:33–57`); include it in `asEditable` (`:60–71`); `defaultsFor` returns `{ mode: "oauth2", config: defaultOAuth2Config() }`; render `OAuth2Form` inside `AuthConfig` (`:198`). Keep the existing draft/save/reset pattern.
- `AuthInheritBanner.tsx` `describeAuth` (`:42–46`): `oauth2` → label `OAuth 2.0 · <grant label>`, secret hint = `clientId`.

### 3.4 Send-time flow

**`handleExecute`** (`app/src/modules/request-builder/index.tsx:173–352`) — payload unchanged (auth already resolved and sent, `:226–238`/`:260`). Add handling after `const result = await engineExecuteRequest(…)` (`:254–266`):

```ts
if (result?.errorCode === "AUTH_REQUIRED") {
  // Phase 1: toast only
  showToast("OAuth 2.0 token required — open the Auth tab and click Get Token", "warning");
  // Phase 2: if execAuth?.mode === "oauth2" && config.grantType === "authorization_code"
  //          && window.electronAPI && !retried:
  //   await runInteractiveAuthorization(execAuth.config as OAuth2Config);
  //   → single retry of the execute (guarded by a local boolean; never loop).
}
```

`runInteractiveAuthorization(resolvedConfig)` (new `app/src/services/oauth/authorize.ts`) encapsulates the shared sequence:

1. `const grant = await window.electronAPI!.oauthAuthorize({ authorizationUrl, clientId, scope, callbackUrl, pkce, audience, resource, useEmbeddedBrowser })` — all values pre-resolved.
2. `return apiService.fetchOAuth2Token({ config: resolvedConfig, interactive: { code: grant.code, codeVerifier: grant.codeVerifier, redirectUri: grant.redirectUri } })` — the **engine** performs the exchange and caches ([03 §3.2](./03-design.md) step 5 decision holds).

Non-Electron (`!window.electronAPI`): throw a friendly error → toast "Interactive OAuth requires the desktop app".

**`handleConfirmLoadTest`** (`index.tsx:435–586`) — after `loadTestAuth` is built (`:493–508`), pre-flight before `apiService.startLoadTest`:

```ts
if (loadTestAuth?.mode === "oauth2") {
  try {
    await apiService.fetchOAuth2Token({ config: loadTestAuth.config as OAuth2Config });
  } catch (e) {
    if (e instanceof ApiError && e.errorCode === "oauth2_interactive_required") {
      if (window.electronAPI) await runInteractiveAuthorization(loadTestAuth.config as OAuth2Config);
      else { showToast("Authorize this request in the Auth tab first", "error"); return; }
    } else {
      showToast(e instanceof Error ? e.message : "OAuth token acquisition failed", "error");
      return;
    }
  }
}
```

The engine's `POST /run` 409 pre-flight (§2.5) is the backstop; a run can never end up waiting on a browser mid-flight.

### 3.5 API client + queries

- **`app/src/config/api-endpoints.ts`**: `OAUTH2_TOKEN: "/oauth2/token"`.
- **`app/src/services/api.ts`** (uses `proxiedRequestTimeoutMs()` like `executeRequest`/`importFetch`, since the engine proxies an IdP call):

```ts
async fetchOAuth2Token(data: OAuth2TokenRequest): Promise<OAuth2TokenResponse> {
  return await httpClient.post(API_ENDPOINTS.OAUTH2_TOKEN, data, { timeout: proxiedRequestTimeoutMs() });
},
async getOAuth2TokenStatus(cacheKey: string): Promise<OAuth2TokenStatusResponse> {
  return await httpClient.get(API_ENDPOINTS.OAUTH2_TOKEN, { key: cacheKey });
},
async clearOAuth2Token(cacheKey: string): Promise<void> {
  await httpClient.delete(API_ENDPOINTS.OAUTH2_TOKEN, { key: cacheKey });
},
```

Small prerequisite: `HttpClient.delete` (`http-client.ts:124`) takes no params — extend to `delete<T>(path, params?)` (the underlying `request()` already supports `options.params`).

- **`app/src/queries/keys.ts`**: `oauth: { token: (cacheKey: string) => ["oauth2", "token", cacheKey] as const }`.
- **New `app/src/queries/oauth.ts`** (pattern: `queries/import.ts`):
  - `useOAuth2TokenStatusQuery(cacheKey: string | null)` — `enabled: !!cacheKey`, `refetchInterval: 30_000`, drives the status row.
  - `useFetchOAuth2TokenMutation()` / `useClearOAuth2TokenMutation()` — `onSuccess: invalidate queryKeys.oauth.token(cacheKey)`; errors surfaced by the form via `useToastStore.showToast(message, "error")` (`toast-store.ts:30`).
  - re-export from `queries/index.ts`.

### 3.6 Electron — `app/electron/oauth.ts`

> **SUPERSEDED by §0 decision 1 (engine-hosted loopback).** The engine now owns PKCE, state, the loopback listener, and the exchange via `/oauth2/authorize/*`. Electron's remaining OAuth surface is (a) a generic `shell:openExternal` IPC and (b) the embedded-window fallback (§0 decision 2), which returns the raw callback URL to the engine and never touches PKCE or tokens. The section below is retained as reference for the embedded window's hardening details (partition, navigation interception, cleanup) — those still apply to the fallback.

Registered via `setupOAuthIpcHandlers(() => mainWindow)` called inside `setupIpcHandlers()` (`main.ts:341–425`). Channel names follow the existing `namespace:verb` convention (`engine:restart`, `theme:get`, `window:minimize`):

- `ipcMain.handle("oauth:authorize", (_e, params: OAuthAuthorizeParams) => Promise<OAuthAuthorizeResult>)`
- `ipcMain.handle("oauth:cancel", () => void)` — tears down any in-flight flow (also invoked automatically when a new authorize starts; single-flight module state).

```ts
interface OAuthAuthorizeParams {
  authorizationUrl: string; clientId: string; scope?: string;
  callbackUrl?: string;                 // empty → auto loopback
  pkce?: boolean;                       // default true
  audience?: string; resource?: string;
  useEmbeddedBrowser?: boolean;         // default false
}
interface OAuthAuthorizeResult { code: string; codeVerifier: string; redirectUri: string; }
```

Implementation (helpers in `app/electron/oauth-helpers.ts`, kept pure for testing):

- **PKCE + state** (Node `crypto`): `codeVerifier = randomBytes(32).toString("base64url")`; `challenge = createHash("sha256").update(verifier).digest("base64url")`; `state = randomBytes(16).toString("base64url")`. Fresh per attempt; never taken from config.
- **`buildAuthorizationUrl(params, {state, challenge, redirectUri})`** (pure): `URL` + searchParams `response_type=code, client_id, redirect_uri, state` [+ `scope`, `audience`, `resource`, `code_challenge`, `code_challenge_method=S256`].
- **Loopback default** (RFC 8252): `http.createServer` bound to `127.0.0.1:0` (ephemeral — the engine owns 9876; `net` precedent in `sidecar.ts:36–46`). If `callbackUrl` is set it must be `http://127.0.0.1|localhost[:port]/…` (listen on that pinned port, clear error if occupied); any other host requires `useEmbeddedBrowser`. Handler: only the expected path; strict `state` equality; `?error=` → reject with the provider's `error: error_description`; success → respond with a minimal inline-HTML "Authorization received — you can close this tab", resolve, `server.close()`. Hard 5-minute timeout rejects and tears down. Launch with `shell.openExternal(url)` (precedent `main.ts:265`).
- **`parseCallbackUrl(rawUrl, expectedState)`** (pure): returns `{code}` or a typed error — shared by loopback and embedded paths.
- **Embedded fallback** (opt-in): hardened `BrowserWindow{ show:false, width:520, height:680, webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:true, partition: "oauth:" + cacheKey } }`; show on `ready-to-show`; funnel `will-redirect` / `did-navigate` / `did-start-navigation` into one handler; callback match = `url.href.startsWith(callback.href) && url.searchParams.has("code")` (Bruno's matcher, [02 §2.3](./02-postman-bruno.md)); user-closed window → reject "Authorization window closed"; full `removeAllListeners()` + destroy on settle.
- The main window never loads IdP URLs; main never sees tokens (only the `code`, which the engine exchanges).

**`app/electron/preload.ts`** (bridge at `:16–106`):

```ts
oauthAuthorize: (params: OAuthAuthorizeParams): Promise<OAuthAuthorizeResult> =>
    ipcRenderer.invoke("oauth:authorize", params),
oauthCancel: (): Promise<void> => ipcRenderer.invoke("oauth:cancel"),
```

**`app/src/types/electron.d.ts`** — add both methods (+ the two param/result interfaces, declared inline like `UpdateAvailableInfo`) to `ElectronAPI`. All call sites already feature-detect via `window.electronAPI?`.

### 3.7 Importers

- **`app/src/services/importers/shared.ts`** — split oauth2 out of the generic bag (`:84–88`): new `export function mapPostmanOAuth2(d: Record<string, string>): RequestAuth`, applying the [03 §6](./03-design.md) table: `grant_type` (`authorization_code_with_pkce` → `authorization_code` + `pkce:true`; `password_credentials` → `password`; `implicit` → `authorization_code` + `pkce:true`), `authUrl→authorizationUrl`, `accessTokenUrl`, `refreshTokenUrl`, `redirect_uri→callbackUrl`, `clientId/clientSecret/scope/username/password` verbatim, `client_authentication` (`header→basic_auth_header`, `body→body`), `challengeAlgorithm` (`plain` treated as S256 — the engine only does S256), `addTokenTo` (`queryParams→query`), `headerPrefix`, `useBrowser` → `useEmbeddedBrowser: !useBrowser`. **Minimal export** (only `accessToken`/`tokenType`) → `{ mode: "bearer", token: accessToken }`. All strings go through the existing `normalizeVars` pattern (`shared.ts:70`).
- **`postman.ts`** (`:92–93`): the counter becomes `["digest","aws","ntlm"].includes(auth.mode)` — oauth2 is now executable.
- **`insomnia-v4.ts`** `insomniaAuth` (`:56–62`): `case "oauth2"` → `mapInsomniaOAuth2(auth)` (near-1:1: `accessTokenUrl`, `authorizationUrl`, `clientId`, `clientSecret`, `grantType`, `scope`, `usePkce→pkce`, `redirectUrl→callbackUrl`, `username/password`, `credentialsInBody→credentialsPlacement`, `audience`, `resource`), no `nonExec` increment; `digest`/`ntlm`/`iam` unchanged.
- **`openapi-v3.ts`** `schemeToAuth` (`:35`): read `scheme.flows` — prefer `clientCredentials` (`tokenUrl→accessTokenUrl`, scopes joined by space, `clientId: "{{clientId}}"`, `clientSecret: "{{clientSecret}}"`), then `authorizationCode` (+ `authorizationUrl`), then `password`; no usable flow → `{ mode: "none" }`.
- **`openapi-v2.ts`** `swaggerSchemeToAuth` (`:21–33`): `flow: "application"→client_credentials`, `"accessCode"→authorization_code`, `"password"→password`, `"implicit"→authorization_code+pkce`; `tokenUrl`/`authorizationUrl`/`scopes` same mapping.
- **`ImportModal.tsx`** (`:348–357`): no code change — the "N auth not executed" counter simply drops for oauth2.

### 3.8 App tests (vitest, colocated `*.test.ts` — `pnpm test`)

- `services/oauth/cache-key.test.ts` — fixed vectors **shared verbatim with `tests/oauth_client_test.cpp`** (document the vectors in both files).
- `modules/request-builder/utils/auth-mapping.test.ts` — `authToEditor`/`editorToAuth` round-trips for all modes including oauth2 (precedent: `utils/loadTestValidation.test.ts`).
- `services/importers/shared.test.ts` — extend with the full-key Postman oauth2 fixture from [02 §1.5](./02-postman-bruno.md), PKCE variant, minimal-accessToken→bearer, implicit mapping, `client_authentication` both values.
- `insomnia-v4.test.ts`, `openapi-v3.test.ts`, `openapi-v2.test.ts` — oauth2 mapping + updated `nonExecutableAuth` expectations.
- `components/shared/OAuth2Form/OAuth2Form.test.tsx` — RTL (precedent: `ImportModal.test.tsx`): grant switch shows/hides fields, advanced collapse, token status states with mocked query/mutations.
- `app/electron/oauth-helpers` pure functions (`buildAuthorizationUrl`, `parseCallbackUrl`, PKCE derivation with the RFC 7636 appendix-B vector) — add the path to the vitest `include` if `app/electron` isn't covered (verify the vitest config during implementation).

---

## 4. Dependency-ordered task breakdown (PR slicing)

| PR | Contents | Depends on | Independently shippable? |
|---|---|---|---|
| ~~**PR 1 — engine: apply static auth**~~ **✅ DONE** (+ refactor) | `encoding.hpp`; typed `auth_resolver` (bearer/basic/apikey live; oauth2/digest/aws/ntlm no-ops); `request_builder` single pipeline; ci `Headers`; `ErrorCode::AuthRequired/AuthFailed`; call sites in `execution.cpp` + `run_manager.cpp`; `sanitize_config_snapshot` allowlist; CMake; `encoding_test`, `auth_resolver_test`, `request_builder_test` | — | Shipped — closed the pre-existing "auth never reaches the wire" gap. See §0 for deviations |
| **PR 2 — engine: OAuth core** | `db::OAuthToken` + accessors; `oauth_client`; `routes/oauth.cpp` + registration; oauth2 branch in `apply_auth`; `preflight_auth` + POST /run 409; `oauth_client_test`, `oauth_route_test`, db_test additions | PR 1 | Yes (API-only; UI still shows Coming Soon) |
| **PR 3 — app: types + non-interactive UI** | domain/api types; `services/oauth/{defaults,cache-key}.ts`; editor types + `auth-mapping.ts` extraction; `OAuth2Form` (client_credentials + password) + `AuthPanel`/`AuthTab`/`AuthInheritBanner` wiring; `api-endpoints`/`api.ts`/`queries/oauth.ts`; token status row; `AUTH_REQUIRED` toast in `handleExecute`; load-test pre-flight (non-interactive); app tests | PR 2 contract (can develop against mocks in parallel) | Yes — Phase 1 complete |
| **PR 4 — interactive flow (engine-hosted, per §0)** | Engine: vendored SHA-256 + PKCE/state generation; `/oauth2/authorize/start\|complete\|:attemptId` routes; ephemeral loopback listener (one-shot, state-checked, 5-min timeout, single-flight); auth-code exchange via `oauth_client`; Google Test with mock IdP covering the full flow. App: `shell:openExternal` IPC; Authorization Code in grant picker; authorize-and-poll in `handleExecute`; **embedded-window fallback (same phase)** — hardened BrowserWindow returning the callback URL to `POST /oauth2/authorize/complete` | PR 3 | Yes — Phase 2 complete, all IdPs incl. https-only |
| **PR 5 — importers** | `mapPostmanOAuth2`/`mapInsomniaOAuth2`; OpenAPI v2/v3 flows extraction; counter changes; fixtures/tests | PR 3 (types only) — parallelizable with PR 4 | Yes |
| **PR 6 — polish** | expiry countdown refinement; verbose-log redaction audit (the engine's debug header dump in `client.cpp`'s debug callback prints `Authorization` — redact); mid-run refresh design doc; export-time secret stripping; `safeStorage` (Phase 4) | PR 3/4 | Incremental |

---

## 5. Open questions / risks — with recommended answers

1. **Auth resolution before or after the pre-request script (`POST /request`)?** → **Before** (right after the timeout override at `execution.cpp:377–379`). Scripts cannot mutate the request (`pm.request` is read-only, `script_engine.cpp:883–918`), so ordering only affects visibility — before means `pm.request.headers` and the stored trace show the real outgoing set, and an interactive-required error short-circuits without executing user scripts. No regression risk: variables are resolved app-side before send ([01 §6](./01-current-state.md)).
2. **apikey/oauth2 query placement when the URL already contains that param** → append anyway (both values go on the wire; server semantics decide). Simple, predictable; revisit with replace-semantics only if users report issues. Fragment (`#`) is preserved by `append_query_param`.
3. **User-typed `Authorization` header vs auth mode** → the explicit header wins; `apply_auth` skips injection. Matches today's only working path and avoids surprising overwrites. Documented in the Auth panel hint.
4. **CORS for new routes** → already covered: server-wide wildcard default headers + `OPTIONS .*` preflight (`server.cpp:105–111`); `DELETE` is in the allowed-methods list.
5. **Engine restart / migration** → `sync_schema()` creates `oauth_tokens` on first boot after upgrade; a downgrade leaves a harmless orphan table; the backup/restore-on-corruption wrapper (`database.cpp:343–447`) is unaffected.
6. **Secrets at rest** → tokens, refresh tokens, and `raw_response` are plaintext in SQLite — the same posture as every other secret today (`app/electron/main.ts:34`). Accepted for v1; Phase 4 adds `safeStorage`. Mitigations shipped now: config_snapshot redaction (§2.5), no token logging, PKCE-public-client encouraged (clientSecret optional), `{{variable}}` support in every secret field.
7. **Postman `implicit` grant on import** → map to `authorization_code` + `pkce:true` and do **not** count it non-executable (`nonExecutableAuth` means "stored but won't execute"; after mapping it will execute — possibly failing at the IdP, which is the honest failure mode). Vayu's own picker never offers implicit.
8. **Lenient provider parsing** → accept `expires_in` as number or numeric string; accept form-encoded token responses (legacy GitHub) despite sending `Accept: application/json`.
9. **Concurrent refresh races** (two sends with an expired token) → both refresh; DB writes are serialized by the existing recursive mutex; last-write-wins is safe. A per-key in-flight guard is a later optimization, not v1.
10. **Mid-run token expiry in long load runs** → **explicitly deferred** (03 Phase 3). The run uses the token valid at start; the route pre-flight refreshes immediately before start, maximizing runway. Sketch for later: strategies read `request.headers` at each transfer setup (`curl_utils.cpp:136–150`) from a shared `Request`, so a run-scoped refresher could swap the header — but transfer setup is unsynchronized today, so this needs an atomic-snapshot design; do not bolt it on.
11. **Non-Electron (browser dev) builds** → the interactive flow is unavailable; feature-detect `window.electronAPI`, disable Get Token for auth-code with a tooltip. Non-interactive grants work everywhere.
12. **`HttpClient.delete` has no query-param support** (`http-client.ts:124`) → extend to `delete<T>(path, params?)`; the underlying `request()` already accepts `options.params`.
13. **`resolveObject` on the config** (`useVariableResolver.ts:131–151`) recurses strings only and preserves booleans/numbers — safe for `OAuth2Config` as designed; no change needed.
