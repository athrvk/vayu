# How Postman and Bruno Implement OAuth 2.0

Research into the two most relevant reference implementations, plus RFC-level best practices. Field names below were verified against official docs, the Postman collection v2.1 schema, real collection exports, and Bruno's source (`usebruno/bruno` @ `5346a72`).

---

## 1. Postman

### 1.1 Grant types

Five in the picker (no device code, no standalone refresh-token grant):

1. Authorization Code
2. Authorization Code (With PKCE)
3. Implicit (still offered; Postman itself recommends PKCE instead)
4. Password Credentials
5. Client Credentials

Source: [Postman Docs — Authenticate with OAuth 2.0](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20), [Postman blog — Implicit Flow is Dead, Try PKCE](https://blog.postman.com/pkce-oauth-how-to/).

### 1.2 Configuration fields per grant type

Common to all grant types: **Token Name**, **Grant Type**, **Scope** (space-separated), **State**, **Client Authentication** (*Send as Basic Auth header* vs *Send client credentials in body*), **Header Prefix** (default `Bearer`), and advanced options: **Refresh Token URL** plus custom auth/token/refresh request parameters.

| Field | Auth Code | Auth Code + PKCE | Implicit | Password | Client Creds |
|---|---|---|---|---|---|
| Callback URL | ✓ | ✓ | ✓ | — | — |
| Auth URL | ✓ | ✓ | ✓ | — | — |
| Access Token URL | ✓ | ✓ | — | ✓ | ✓ |
| Client ID | ✓ | ✓ | ✓ | optional | ✓ |
| Client Secret | ✓ | ✓ | — | optional | ✓ |
| Username / Password | — | — | — | ✓ | — |
| Code Challenge Method (S256 / plain) | — | ✓ | — | — | — |
| Code Verifier (43–128 chars, optional) | — | ✓ | — | — | — |
| "Authorize using browser" toggle | ✓ | ✓ | ✓ | — | — |

Token placement: **Headers** (`Authorization: <prefix> <token>`, prefix default `Bearer`) or **query params** (`access_token`).

### 1.3 Auth inheritance

Auth can be set at **collection**, **folder**, and **request** level; the default at folder/request level is **"Inherit auth from parent"**, which walks up request → folder → collection to the nearest explicitly-set auth. (Vayu's existing `inherit` + `resolveInheritedAuth` chain matches this model.)

### 1.4 Token lifecycle & the "Get New Access Token" flow

- **Get New Access Token** opens either an app-controlled window or — with **"Authorize using browser"** — the system browser.
- **Default callback URL**: `https://oauth.pstmn.io/v1/callback` (browser mode: `https://oauth.pstmn.io/v1/browser-callback`) — a Postman-hosted relay that users register with their provider. (Vayu should *not* copy this: it requires hosted infrastructure; a loopback listener is simpler and more private.)
- **Token list / Manage Tokens**: fetched tokens accumulate in a named list per request/collection; users pick one, can delete (note: deletion does not revoke at the provider).
- **Auto-refresh**: if a `refresh_token` is present, Postman refreshes an expired token automatically before use; a manual Refresh button exists.
- **Sync Token**: opt-in cloud sync — needed because Newman/CLI/monitors can't do interactive flows. (Not relevant to Vayu, but the same constraint applies to Vayu load runs: a load run can't pause for a browser flow, so tokens must be acquired before the run starts.)

### 1.5 Collection Format v2.1 `auth` JSON — the import contract

The `auth` object appears on the collection, on folders (`item` groups), and on requests. Type enum: `apikey, awsv4, basic, bearer, digest, edgegrid, hawk, noauth, oauth1, oauth2, ntlm`. Each type key holds an **array of auth-attribute objects** `{ "key", "value", "type" }` — **order-independent; index by `key`**.

```json
"auth": {
  "type": "oauth2",
  "oauth2": [
    { "key": "grant_type",      "value": "authorization_code", "type": "string" },
    { "key": "authUrl",         "value": "{{AUTH_URL}}",        "type": "string" },
    { "key": "accessTokenUrl",  "value": "{{TOKEN_URL}}",       "type": "string" },
    { "key": "redirect_uri",    "value": "{{CALLBACK_URL}}",    "type": "string" },
    { "key": "clientId",        "value": "client-id",           "type": "string" },
    { "key": "clientSecret",    "value": "{{CLIENT_SECRET}}",   "type": "string" },
    { "key": "scope",           "value": "scope1 scope2",       "type": "string" },
    { "key": "state",           "value": "xyz",                 "type": "string" },
    { "key": "headerPrefix",    "value": "Bearer",              "type": "string" },
    { "key": "addTokenTo",      "value": "header",              "type": "string" },
    { "key": "useBrowser",      "value": false,                 "type": "boolean" }
  ]
}
```

**Exact key names to parse on import** (union across grant types):

| Postman key | Meaning / values |
|---|---|
| `grant_type` | `authorization_code`, `authorization_code_with_pkce`, `implicit`, `password_credentials`, `client_credentials` |
| `authUrl` | authorization endpoint |
| `accessTokenUrl` | token endpoint |
| `redirect_uri` | callback URL |
| `clientId` / `clientSecret` | client credentials |
| `scope` / `state` | as in RFC 6749 |
| `username` / `password` | password grant |
| `client_authentication` | `header` (Basic auth header) or `body` |
| `challengeAlgorithm` | PKCE: `S256` or `plain` |
| `code_verifier` | optional pinned PKCE verifier |
| `refreshTokenUrl` | override for refresh calls |
| `tokenName` / `headerPrefix` | display name; header prefix (default `Bearer`) |
| `addTokenTo` | `header` or `queryParams` |
| `useBrowser` | boolean — system browser vs embedded window |
| `accessToken` / `tokenType` | a pre-fetched token (minimal exports may contain *only* these) |

Importer quirks to handle:

- Values are frequently `{{variables}}` — keep them as-is; Vayu resolves variables at execution time anyway.
- Minimal exports with only `accessToken`/`tokenType`/`addTokenTo` represent a pre-fetched token with no flow config.
- `addTokenTo=queryParams` appends `access_token` to the URL.

Sources: [collection v2.1 schema](https://schema.postman.com/json/collection/v2.1.0/collection.json), [real export exercising all keys (httpiness test collection)](https://raw.githubusercontent.com/bognikol/httpiness/63e99477c2176a23196d64b8f4b3ee7931edde06/test/manual/postman-test-conversion-collection.postman_collection.json), [Xero OAuth 2.0 collection](https://github.com/XeroAPI/xero-postman-oauth2/blob/master/Xero%20OAuth%202.0.postman_collection.json).

---

## 2. Bruno

Key source files (`usebruno/bruno` @ `5346a72`):

- `packages/bruno-electron/src/ipc/network/authorize-user-in-window.js` — interactive window flow
- `packages/bruno-electron/src/utils/oauth2.js` — token store, expiry, refresh, injection
- `packages/bruno-lang/v2/src/jsonToBru.js` / `bruToJson.js` — `.bru` serialization

### 2.1 Grant types

Authorization Code (with optional PKCE), Client Credentials, Password, Implicit — configurable at collection/folder/request level. ([Bruno docs](https://docs.usebruno.com/auth/oauth2-2.0/overview))

### 2.2 `.bru` format — `auth:oauth2` block

Snake_case on disk, camelCase in the in-memory JSON model (mapped in `bruToJson.js`). Authorization-code example:

```
auth:oauth2 {
  grant_type: authorization_code
  callback_url: {{callback}}
  authorization_url: {{auth_url}}
  access_token_url: {{token_url}}
  refresh_token_url: {{refresh_url}}
  client_id: {{client_id}}
  client_secret: {{client_secret}}
  scope: openid profile
  state: {{state}}
  pkce: true
  credentials_placement: basic_auth_header   # or: body
  credentials_id: credentials
  token_source: idp                          # or: custom
  token_placement: header                    # or: url
  token_header_prefix: Bearer
  token_query_key: access_token              # when token_placement=url
  auto_fetch_token: true
  auto_refresh_token: true
}
```

Client credentials drops the authorization/callback fields; password adds `username`/`password`; implicit keeps only `callback_url`, `authorization_url`, `client_id`, `scope`, `state`, `auto_fetch_token`.

Full field union: `grant_type`, `callback_url`, `authorization_url`, `access_token_url`, `refresh_token_url`, `client_id`, `client_secret`, `username`, `password`, `scope`, `state`, `pkce`, `credentials_placement`, `credentials_id`, `token_source`, `token_placement`, `token_header_prefix`, `token_query_key`, `auto_fetch_token`, `auto_refresh_token`.

Bruno's field set is a good template for Vayu's config schema — it is the cleanest of the surveyed formats (explicit booleans for PKCE/auto-fetch/auto-refresh, explicit placement enums).

### 2.3 Authorization-code flow in Electron (`authorize-user-in-window.js`)

The mechanics worth copying (and hardening notes):

- `new BrowserWindow({ webPreferences: { nodeIntegration: false, partition: session }, show: false })` — hidden until `ready-to-show`. The **`partition`** isolates cookies/storage per collection + token URL, so different logins don't collide and "log out" is just clearing the partition.
- Redirect interception via **`will-redirect`**, **`did-navigate`**, and **`did-start-navigation`**, all funneling into one `onWindowRedirect(url)` handler. `webRequest` hooks (`onBeforeRequest`, `onBeforeSendHeaders` — used to inject optional extra headers, `onHeadersReceived`, `onCompleted`, `onErrorOccurred`) collect debug info shown in the UI.
- **Callback matching** (`matchesCallbackUrl`):

  ```js
  url.href.startsWith(callbackUrl.href) && (url.searchParams.has('code') || url.hash.length > 1)
  ```

  Prefix-match **and** require an OAuth indicator (`code` param, or a hash fragment for implicit) — this avoids firing on intermediate IdP login pages that happen to share the prefix.
- **Code extraction**: `new URL(finalUrl).searchParams.get('code')`.
- **State validation**: rejects when `!expectedState || returnedState !== expectedState`.
- **Error handling**: `?error=...` on the callback → reject with `error` + `error_description`, close the window.
- **Cleanup**: on close, `removeAllListeners()` and null out every `webRequest` handler.

Source: [authorize-user-in-window.js](https://raw.githubusercontent.com/usebruno/bruno/5346a72b2dccfb93236d11fd4de0092bdbfd66d4/packages/bruno-electron/src/ipc/network/authorize-user-in-window.js).

### 2.4 Token cache, expiry, refresh, injection (`utils/oauth2.js`)

- **Store**: persistent `Oauth2Store` (an electron-store file, survives restarts), keyed by `collectionUid` + token `url` + `credentialsId`. API: `updateCredentialsForCollection`, `getCredentialsForCollection`, `clearCredentialsForCollection`, `getSessionIdOfCollection` (derives the BrowserWindow partition).
- **Persist guard**: only stores when `access_token` is present and there's no `error`; stamps `created_at: Date.now()`.
- **Expiry**: `Date.now() > created_at + expires_in * 1000`; missing either field → treated as non-expiring.
- **Refresh**: when expired + `auto_refresh_token` + stored `refresh_token` → POST `grant_type=refresh_token`; on failure, clear the cached credentials (forcing a fresh interactive fetch next time).
- **Injection**: `token_placement=header` → `Authorization: <token_header_prefix> <access_token>`; `url` → query param named `token_query_key` (default `access_token`).
- Scripts can read tokens (`{{$oauth2.<id>.access_token}}`, `bru.getOauth2CredentialVar()`) and reset them (`bru.resetOauth2Credential()`).

Source: [utils/oauth2.js](https://raw.githubusercontent.com/usebruno/bruno/5346a72b2dccfb93236d11fd4de0092bdbfd66d4/packages/bruno-electron/src/utils/oauth2.js), fixtures in `packages/bruno-tests/keycloak-client-credentials/`.

---

## 3. Best-practice notes (RFC-level)

### 3.1 PKCE and state — always

- Default interactive flow should be **Authorization Code + PKCE** ([RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)): `code_verifier` of 43–128 unreserved chars, `code_challenge = BASE64URL(SHA-256(verifier))`, `code_challenge_method=S256` (`plain` only as fallback). [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) says authorization servers SHOULD reject native-app auth-code requests without PKCE.
- Always generate and strictly validate a random **`state`** (CSRF / code-injection defense), as Bruno does.

### 3.2 Redirect strategy for a desktop app — RFC 8252 order of preference

1. **Loopback redirect** `http://127.0.0.1:{ephemeral_port}/callback`: spin up a one-shot localhost listener, open the **system browser**, capture the code. RFC 8252 explicitly permits plain `http` on loopback and requires desktop-OS support for it. Best security and UX: real browser means existing IdP sessions, password managers, and verifiable URL/TLS.
2. **Custom URI scheme** (`vayu://oauth/callback`): works, but scheme-hijacking risk and per-OS registration friction (electron-builder `protocols`, `open-url`/`second-instance` handlers).
3. **Embedded/app-controlled window** (what Postman's non-browser mode and Bruno do): full interception control and no port juggling, but RFC 8252 discourages it — the app can observe credentials and users can't verify the URL. If shipped, harden it: `nodeIntegration:false`, `contextIsolation:true`, isolated `partition`, no preload, strict callback matching (prefix **and** `code`/hash present).

Recommended posture (matching Postman's toggle): **default to loopback + system browser; offer the embedded window as an opt-in fallback** for IdPs that refuse `127.0.0.1` redirect URIs.

### 3.3 Client credentials specifics

Two client-auth placements — make it configurable (Postman `client_authentication`, Bruno `credentials_placement`):

- **HTTP Basic header** (default): `Authorization: Basic base64(urlencode(client_id):urlencode(client_secret))` per RFC 6749 §2.3.1.
- **Body params**: `client_id` / `client_secret` in the `application/x-www-form-urlencoded` body.

No user interaction, no browser, no refresh token — POST to the token endpoint and cache.

### 3.4 Refresh & expiry

- Stamp `created_at` at fetch; expired when `now > created_at + expires_in*1000` minus a **skew of 30–60 s** (refresh slightly early). Missing `expires_in` → treat as non-expiring (Bruno's choice; reasonable).
- Refresh responses may rotate the `refresh_token` — persist the new one when present. On refresh failure, clear the cache and fall back to a fresh acquisition.
- **Token placement**: header strongly preferred; query-param tokens leak into server logs, browser history, and `Referer` headers. Support query placement only for compatibility.

### 3.5 Secrets & token storage

- Plaintext persistence (Bruno's electron-store; Postman's optional cloud sync) is pragmatic but weak. Prefer **Electron `safeStorage`** (`encryptString`/`decryptString`, backed by macOS Keychain / Windows DPAPI / libsecret) so only ciphertext hits disk; keep decrypted tokens in main-process/engine memory, never in renderer localStorage.
- Support `{{variable}}` references in secret fields so secrets can live in environments rather than in exported/committed collections. Offer a "don't persist token" option.
- Prefer **public-client PKCE without a secret** where the provider allows it — no secret to store at all.
- **Device Authorization Grant (RFC 8628)**: neither Postman nor Bruno exposes it in the standard picker, but it's the cleanest browserless option (relevant for CI/headless) — roadmap material, not v1.
