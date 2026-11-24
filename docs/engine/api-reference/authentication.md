---
description: >-
  The OAuth 2.0 routes: the token cache, the interactive authorization flow and the local mock issuer.
---

# Authentication

The engine **resolves auth server-side**.
Every request's `auth` object (on `POST /execute` and `POST /runs`) is applied to the outgoing request before it hits the wire:

| `auth.mode` | Effect |
|-------------|--------|
| `none` / `inherit` | No-op (`inherit` is resolved by [`POST /compose`](compose.md#post-compose) before it reaches an execution endpoint; one arriving unresolved is a warning in the logs) |
| `bearer` | `Authorization: Bearer <token>`, the token trimmed of the spaces and tabs around it (#2467); a token empty once trimmed writes no header at all and the send carries an [`authNotice`](execute.md#post-execute) saying so (#3203) |
| `basic` | `Authorization: Basic <base64(user:pass)>`, as typed - a password may end in a space |
| `apikey` | Header `key: value`, or `?key=value` when `in: "query"`; the key and the value are trimmed of the spaces and tabs around them (#2467); a key empty once trimmed writes nothing and the send carries an [`authNotice`](execute.md#post-execute) saying so (#3203) |
| `oauth2` | Acquires/caches a token (below; the `client_credentials`, `password`, `authorization_code` and `jwt_bearer` grants) and injects it per `tokenPlacement`; a token placed in the header yields to an `Authorization` header the request carries, and is then not fetched at all (#3202, below) |
| any other mode (`digest`, `aws`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`, which an import can store) | Not executed: the request is sent without authentication, never refused, and the `/execute` answer and the stored trace carry an [`authNotice`](execute.md#post-execute) saying so (#2474) |

**When it is applied.**
As the request is built, before any pre-request script runs - so the script's `pm.request` holds the header - unless a credential (a `bearer` token, a `basic` username or password, an `apikey` key or value) still holds a `{{name}}` that is not a data column or the iteration identity.
Such a name is one composition found no variable for,
or any name a scope answers in a request a pre-request script runs before (it is listed in [`deferredVariables`](compose.md#deferredvariables)) or in a step of a collection run whose plan writes a variable ([Scenario runs](scenario-runs.md#scenario-runs)),
and that auth is applied **after** the pre-request script and the residual-token pass instead, each credential resolved against the scopes as the script left them (#2473, #2521), so `pm.environment.set("password", …)` reaches a basic pair before it is base64-encoded.
That is Postman's order; the script then does not see the header in `pm.request.headers`, and an `Authorization` it sets wins by the rule below.
A data column or the identity in the same credential is bound first.
A name nothing answers is encoded as written.
A script that assigns `pm.request.auth` replaces this block in either case: the credential applied before it is taken off, a waiting one is never applied (#3131, see [Mutating the request](../scripting/request-mutation.md#mutating-the-request-pre-request-scripts)).

**`oauth2` follows the same order on a single send and a collection run's step (#2521).**
A config in a request that a pre-request script runs before (on a sequential run, in any step of a plan that writes a variable), or holding a `{{name}}` that nothing defines,
is left as written by [`POST /compose`](compose.md#post-compose), resolved in every string after the pre-request script (a `jwt_bearer` `privateKey` excepted: compose leaves it a reference in both modes and it is resolved only into the config the token is acquired with, see [auth modes](resource-writes.md#auth-modes)), and only then is its token acquired;
the [token cache](#oauth-20-token-cache) key is computed from that resolved config, so a script that sets a `clientId` or an `accessTokenUrl` selects its own cached token, and a client secret or scope it sets reaches the token endpoint when a token is fetched (neither is part of the key, so a token already cached under the same key is reused).
The wait on the identity provider is left out of `engineMs`, as a fetch at the build is, and a token that cannot be acquired answers `authErrorCode` as it does at the build.
A **load** run acquires its token once, when it is planned and before any script runs, from the **stored** values: its composition (`deferDynamicVariables`) resolves the config, and a name nothing defines is refused with a `400` that names it (`invalid_run_config` for a single request, `invalid_scenario` for a collection).
A script that sets an OAuth 2.0 variable has no effect under load, however many iterations or virtual users run it, and nothing is re-acquired per iteration; the one change to a run's token after it starts is the mid-run refresh of [the token cache](#oauth-20-token-cache).
The same order holds wherever a script can run between the build and the send:

| Send | Applied after |
|------|---------------|
| `POST /execute` (buffered and `stream: true`) | the pre-request script |
| A collection run's step | that step's pre-request script, each iteration |
| A collection **load** run's step | that submission's `step.before` elements (an `inline` `script.pre`) and the residual pass over its virtual user's scope |
| A single-request load run declaring `requestElements` whose submissions are copied (a `step.before` kind, data rows, a bind token or deferred auth) | that submission's `step.before` elements and the residual pass over the run's scopes (a `script.setup` included) |

A single-request load run without `requestElements` has no such pass.
When it names an `environmentId` or a `requestId`, the build leaves such credentials alone and its start-of-run pass ([`POST /runs`](load-runs.md#post-runs)) resolves and applies them once, after the request's own names, so a basic pair and a query-placed api key are encoded with their values (#3288); without either, the build encodes the name as written.
Under load a name nothing answers is never a refusal: it is sent as written and counted like any other unresolved token (#1503), except inside a basic pair's base64, where it never was countable.

An `apikey` with `in: "header"` whose key is not a header name once trimmed (`X Key`) is refused, with nothing written: the failure is `AUTH_FAILED` with an `authErrorCode` of `invalid_header_name`.
The message names the offending byte and not the key, which arrives already resolved and may be a secret.
An `apikey` whose key is empty or only padding, in the header or the query, and a `bearer` token that is empty or only padding are not refused:
nothing is written (never `Authorization: Bearer ` with nothing after it), the request is sent without that credential, and the send carries an [`authNotice`](execute.md#post-execute) saying so (#3203), so a variable left unset on purpose does not fail a run.
A token or key that resolves empty after the pre-request script is judged the same way.
A `bearer` token with spaces *inside* it keeps them: only the ends are trimmed.

A user-supplied header always wins over the one auth would write: `Authorization` over `bearer`/`basic`/`oauth2`, and a header named like the API key's `key` over `apikey` (`in: "header"`; the key name is matched against the request's own headers).
Header names are matched case-insensitively, so `authorization` or `x-key` against `X-Key` counts.
A query-located API key is a URL parameter and is appended regardless.
The app's code snippets apply the same rule (`engine/tests/fixtures/auth-header-precedence.json`).

**An `oauth2` block whose token goes in the header fetches nothing when the request already carries an `Authorization` header** (#3202).
The header the request typed is sent, no token is acquired, and the token cache, the `targetPolicy` and the endpoint are not consulted, so a token endpoint that is down, refused by the policy or unreachable cannot fail the send.
The send says so: `authNotice` reads `the request's own Authorization header was sent; no OAuth 2.0 token was fetched` (see [`authNotice`](execute.md#post-execute)), and no `Authorization` is recorded as written by auth.
The rule holds wherever auth is applied: at the build, after a pre-request script, in a collection run's step, and in a load run, whose `POST /runs` pre-flight reads the payload's headers the way the run will and so does not fetch (or fail on) a token it would not send.
It applies to the `Authorization` header only: an `oauth2` block with `tokenPlacement: "query"` writes a URL parameter, has nothing to yield to, and is fetched and appended as before.
The header is read when auth is applied, so one a pre-request script sets spares the fetch only when the auth waits for that script ([When it is applied](#authentication)); otherwise the token was already fetched and the script's header replaces what auth wrote.

**Redirects.**
With `followRedirects` on, a redirect to a different scheme, host name or port drops the `Authorization` header and a typed `Cookie`, so `bearer`, `basic` and an `oauth2` token placed in the header stop at the first origin.
Nothing else is dropped: an `apikey` with `in: "header"` - and any other header the request carries - is sent to the origin the redirect leads to, **including over `http` after an `https` hop**.
That is a documented exception, not an oversight: it is the rule libcurl applied while it followed redirects, kept as it was.
A design send, a stream and a load run all run the engine's own redirect loop, so the three cannot disagree about what reaches the next origin.
A query-located key is part of the URL as sent; the next hop is whatever the response's `Location` names, so the key reaches it only if that URL repeats it.
Set `followRedirects: false` on a request whose key must not leave the origin it was sent to; the app says this beside the API Key fields.
A design send makes the downgrade visible: each entry of the answer's `redirects` records the `url` its request went to (a withheld credential in it reads `<redacted>`) and `schemeDowngrade`, true when that request was `https` and the next one `http` (see [`redirects`](execute.md#post-execute)) and `pm.response.redirects` shows them to a post-request script, with the credential blank.
A load run and a stream record no hops.
(`engine/tests/redirect_credentials_test.cpp`)

## OAuth 2.0 token cache

Tokens are acquired once and cached (SQLite `oauth_tokens`, keyed by a deterministic `cacheKey` = `trim(accessTokenUrl) \x1f clientId \x1f credentialsId \x1f grantType \x1f username-if-password-grant` (the raw `grantType` string, empty when absent; the `subject` for a `jwt_bearer` grant, so two subjects of one client hold two tokens;
the key never reads `privateKey`, `privateKeyFile`, the claims or the algorithm), then one segment per extra parameter list that has a row the engine would send, in the order `authorizationParams`, `tokenParams`, `refreshParams`: `\x1f <list>:<key>=<value>`, further rows joined by `\x1e`, the pairs sorted by key, then value, byte-wise).
A row whose key names a credential (`client_assertion`, `assertion`, an `X-Api-Key` or `Authorization` header, the names an export blanks: `core::vayu_ext::names_param_credential`) is written as `<key>=` with its value left out, because the key is returned as `cacheKey`, stored as the cache row's primary key and can reach a log; a rotated assertion therefore keeps the token it was cached under.
Row order and `sendAs` do not change the key; a config with no such row keys exactly as it did before the lists existed.
The `accessTokenUrl` slot holds the URL with its surrounding ASCII whitespace trimmed (#3687, see [`POST /oauth2/token`](#post-oauth2token)); the app's key trims the same six characters and no others.
`scope`, `audience` and `resource` are not read, so a distinct `credentialsId` (or an extra parameter row) is what separates two tokens that differ only in those.
The grant type is read (#3689), so one client at one token URL holds a separate token per grant: a `client_credentials` token is never answered for an `authorization_code` request, which still asks the user to sign in.
A token cached before that change sits under the old key, which no config produces any more, so it is orphaned: it is never reused and never pruned (nothing prunes `oauth_tokens` rows), a request re-fetches once, and an `authorization_code` user signs in once.
The recipe is `oauth::cache_key` (`engine/include/vayu/http/oauth_client.hpp`), and the app's `computeOAuth2CacheKey` matches it byte for byte against the shared vectors in `engine/tests/oauth_client_test.cpp`.
Expiry uses a skew of min(45s, lifetime/2), so a 30s token is reused for 15s; a missing `expires_in` means non-expiring unless the config sets `fallbackExpiresIn` (seconds, any grant, held to one year), which is then how long such a token is kept.
A response's own `expires_in` is held to one year too (31536000, `MAX_EXPIRES_IN_SECONDS`, #3645), whether it is an integer, a float or a numeric string: a provider stating more is stored as a year, and a value that is zero, negative or unreadable states no lifetime (a negative one is stored as 0).
One refresh is in flight per cache key (#3344): however many sends, runs and `POST /oauth2/token` calls find the same token expired at once, the provider sees one `grant_type=refresh_token` post, and the others wait for it, each under its own timeout and cancel, and answer with the row it wrote.
If that refresh fails (it timed out or was cancelled), a waiting call makes its own rather than reporting the other call's error.
A refresh whose refresh token the provider refuses (`invalid_grant` or `invalid_client`;
every other refresh failure keeps the row, see [POST /oauth2/token](#post-oauth2token)) deletes the cached row only while the row still holds the refresh token that was refused, so a rotating provider's `invalid_grant` for a spent token never deletes the token that replaced it; an `authorization_code` user is not sent back to sign in by a race.
A refresh that issues no new refresh token keeps the old one in the same write.
A load run also refreshes its token **during** the run: a watchdog re-acquires a header-placed, expiring token `oauth2RefreshLeadMs` (default 60s) before it expires and writes the new one into this same cache row (see [Load Test Mode](../architecture.md#load-test-mode)).
A collection load run does the same for the tokens its steps were planned with (#3199): one watchdog per distinct cache key, however many steps send it, and every such step sends the newest token from its first submission on.
It is skipped - the token is fetched once and reused for the whole run - for a query-placed token, `autoRefreshToken: false`, a non-expiring token, an `authorization_code` grant with no refresh token, and a send that carries its own `Authorization` header, for which no token was fetched (#3202).
That list is `plan_oauth2_refresh`'s plus the header check (`engine/src/http/auth_resolver.cpp`); the app's `isMidRunRefreshable` mirrors all of it but the header case - change one, change both.
A collection step is also skipped when its auth waited on its scripts, and when it writes the token under a different `headerPrefix` than the first step sharing its cache key (`plan_scenario_auth_refresh`, `engine/src/core/auth_refresh.cpp`).

### POST /oauth2/token

Acquire (or return a cached) token for an `OAuth2Config`.
Supports the `client_credentials`, `password`, `authorization_code` and `jwt_bearer` grants; the `authorization_code` grant requires an `interactive` code exchange (see below).

The four URL members, `accessTokenUrl`, `refreshTokenUrl`, `authorizationUrl` and `callbackUrl`, are read with the ASCII whitespace (space, tab, CR, LF, VT, FF) trimmed from both ends (#3687, `oauth::url_field`): a URL pasted with a trailing space or newline is the URL it looks like, not a `404` for `/token%20`.
The trim happens once, where the config is read, so the same text is validated, dialled, judged by a `targetPolicy` and keyed into the [`cacheKey`](#oauth-20-token-cache).
A member of whitespace alone is empty.
A byte above 127 is not whitespace here: a no-break space stays in the URL.
The `callbackUrl` of `POST /oauth2/authorize/complete` is the redirect the browser landed on, not a config member, and is read as sent.

The `jwt_bearer` grant (RFC 7523, #3632) posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and an `assertion` the engine signs with the client's key.
The config members (all strings unless noted):

| Member | Meaning |
|--------|---------|
| `subject` | The `sub` claim; required. Also the fifth slot of the [cache key](#oauth-20-token-cache) |
| `assertionAudience` | The `aud` claim; required |
| `clientId` | The `iss` claim. With no `clientSecret` it is sent in no other way: the assertion alone authenticates the client, so no `client_id` rides beside it |
| `assertionLifetimeSeconds` | A number, `exp` minus `iat`; 180 when absent or `null`, held to 1..3600, a non-number a `400` |
| `signingAlgorithm` | `RS256` (the default) or `ES256` |
| `keyId` | Written as the header's `kid` when not empty |
| `privateKey` | The signing key, as one `{{variable}}` reference to a secret variable holding the PEM (a literal key is refused on write, see [auth modes](resource-writes.md#auth-modes)). Resolved only where the token is acquired |
| `privateKeyFile` | A path to the PEM, read through the [file-trust rule](file-access.md#allowed-folders-file-roots); exactly one of `privateKey` and `privateKeyFile` is set |
| `assertionClaims` | `[{key, value, enabled}]`, further claims; a row naming a claim the engine wrote (`iss`, `sub`, `aud`, `exp`, `iat`) is skipped |
| `scope`, `audience`, `resource`, `tokenParams` | Sent as for any fresh grant |

A missing required member, both or neither key, an unresolved reference and a key that cannot sign are each a `400` `oauth2_invalid_config` naming the member; no message holds any part of the key.

`fallbackExpiresIn` (a number of seconds, any grant) is how long a token whose response states no `expires_in` is kept; absent, it never expires, as before.
A value above one year (31536000, `MAX_FALLBACK_EXPIRES_IN_SECONDS`) is kept for a year, and a value that is not a positive number leaves the token non-expiring.

**Request:**
```json
{
  "config": { "grantType": "client_credentials", "accessTokenUrl": "https://idp/token",
              "clientId": "...", "clientSecret": "...", "scope": "openid" },
  "force": false,
  "interactive": { "code": "...", "codeVerifier": "...", "redirectUri": "..." },
  "environmentId": "env_...",
  "collectionId": "col_..."
}
```

`environmentId` and `collectionId` (optional strings; another type is a `400` `oauth2_invalid_config` naming it) are the scopes a Send of the request reads: the route resolves the config's `privateKey` reference against that environment, that collection's chain and the globals, and nothing else in the config, which the caller sends resolved (#3632).
A `privateKey` reference with neither id is a `400` `oauth2_invalid_config` saying to send the saved request or name a key file in `privateKeyFile`; one no named scope defines is the same `400` naming the reference.
A `privateKeyFile` needs no id.

`force: true` bypasses the cache (refreshes via the refresh token when present, else re-acquires).
`interactive` is only used for the `authorization_code` grant, and it always exchanges the code and overwrites the cached row, whatever `force` says and whether the cached token is fresh, expired or refreshable (the old refresh token is not carried over).

Client credentials sent in the `Authorization: Basic` header are form-encoded before they are base64-encoded, as RFC 6749 section 2.3.1 specifies, so a secret holding `+`, `/` or `=` travels as `%2B`, `%2F`, `%3D`.
A provider that expects them raw (as Postman and `curl -u` send them) needs `credentialsPlacement: "body"`, which puts `client_id` and `client_secret` in the form instead.
The default is `basic_auth_header`.

`scope`, `audience` and `resource` are sent in the form of a fresh grant when set; a refresh sends none of them.
Three optional config lists add parameters of the user's own (issue #2536), each an array of `{key, value, enabled, sendAs?}`: `tokenParams` on a fresh grant, `refreshParams` on a refresh, and `authorizationParams` in the authorize URL's query (below).
`sendAs` puts a row in the form (`body`, the default), the token URL's query (`url`) or a request header (`header`).
A row is not sent when it is `enabled: false`, has no string `key`, has an unknown `sendAs`, or is named like a parameter the engine writes itself (`grant_type`, `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier`, `refresh_token`, `username`, `password`, `scope`, `state`, `code_challenge`, `code_challenge_method`, `response_type`);
a body or url row naming a form parameter already written (an `audience` the config sends) and a header row naming a header already set (`Authorization`, `Content-Type`, `Accept`, case-insensitively) are skipped too, so the engine's value wins and no name is sent twice.
A malformed list or row is skipped, never refused.
Values are resolved with the rest of the config, by `POST /compose` or after the pre-request script (see [When it is applied](#authentication)), and a `{{data.*}}` token in one is refused like one anywhere else in the config.

**Response (`200`):**
```json
{
  "cacheKey": "https://idp/token...",
  "accessToken": "ya29...",
  "tokenType": "Bearer",
  "scope": "openid",
  "expiresIn": 3600,
  "createdAt": 1234567890000,
  "expiresAt": 1234567893600,
  "hasRefreshToken": true
}
```

`expiresAt` is `null` for a non-expiring token; `scope` is omitted when empty.
Errors carry an `oauth2_*` code: `400` invalid config, `401` `oauth2_provider_error` when the token endpoint answered without a token, `409` interactive authorization required, `502` network error, `504` `oauth2_timeout` when the token endpoint did not answer in time.
A `401`'s message always names the endpoint's status (#3201): a 4xx JSON answer, or an RFC 6749 `error` under any status below 500, reads `Token endpoint refused the request (HTTP 400): invalid_client (bad secret)`; a 5xx, or a body nothing could read, reads `Token endpoint error (HTTP 503)`, with `: unparseable response` when the body was neither JSON nor a form.
The provider's reply rides inside the error as `providerStatus`, `providerError` and `providerErrorDescription`, each left out when absent.
A body that is not JSON is read as the legacy form-encoded token response only under an `application/x-www-form-urlencoded`, `text/plain` or absent `Content-Type`, and never when it opens with `<`, so a gateway's HTML page is not decoded as a form.
The token request is bounded by the `defaultTimeout` setting (this route takes no `timeout` of its own), and the bound covers the whole acquisition: a refresh the provider rejects falls back to a fresh grant that gets only what the refresh left (issue #2833).

Only a refusal of the refresh token itself clears the cached token: a refresh answered `400` or `401` with an RFC 6749 `error` of `invalid_grant` or `invalid_client` deletes the row (while it still holds that refresh token) and falls back to a fresh grant, which for `authorization_code` is the `409` above.
Every other refresh failure keeps the row, so the next call refreshes again (issue #3360).
A refresh the endpoint could not answer - a 5xx, a `429`, or a reply carrying no RFC 6749 `error`, an unparseable body included - is a `502` `oauth2_network_error` whose message reads `Token refresh failed: Token endpoint error (HTTP 503): unparseable response`, still carrying `providerStatus` and the rest of the provider's reply.
Any other refusal of a refresh (`invalid_scope`, say) answers as the `401` `oauth2_provider_error` above.
A fresh grant's failure is unaffected: it is always that `401`.
The same bound holds for the token exchange of the interactive flow below.
A token response nested past 100 levels is treated as unparseable (`401` `oauth2_provider_error`, "unparseable response"), never cached (issue #2413).

### GET /oauth2/token?key=&lt;cacheKey&gt;

Inspect the cached token for a key (used by the UI status row).
Always `200`.

```json
{ "found": true, "expired": false, "token": { "...": "serialized token" } }
```

Returns `{ "found": false }` when no token is cached.

### DELETE /oauth2/token?key=&lt;cacheKey&gt;

Clear a cached token.
`200 { "deleted": true }` (`false` if nothing was cached).

## Interactive Authorization Code flow

For the `authorization_code` grant the engine owns PKCE (S256), the `state` value, and the code exchange; the app only opens the browser.
In **loopback** mode the engine binds an ephemeral `127.0.0.1` listener; in **embedded** mode (providers that reject loopback redirects) the app captures the redirect URL and hands it back.

| Method / Path | Purpose |
|---------------|---------|
| `POST /oauth2/authorize/start` | `{config, mode?}` → `{attemptId, authorizeUrl, redirectUri, expiresAt, resolved?}` (`resolved` only for a [discovered](#discovered-from-an-mcp-server-url) config) |
| `GET /oauth2/authorize/:attemptId` | Poll status → `{state: "pending"\|"completed"\|"failed"\|"not_found", error?, cacheKey?}`; reads only |
| `POST /oauth2/authorize/complete` | `{attemptId, callbackUrl}` → status (embedded mode) |
| `DELETE /oauth2/authorize/:attemptId` | Cancel → `{cancelled: true}` |

The authorize URL carries `response_type`, `client_id`, `redirect_uri`, `state`, `scope`, `audience`, `resource` and the PKCE pair, then each `authorizationParams` row under the rules above, whatever its `sendAs` (a navigation has no body or headers); a row naming a parameter already in the URL is skipped.

An attempt times out 5 minutes after it starts.
`expiresAt` is that instant in epoch milliseconds, the one deadline a client waits on.
The engine enforces it whether or not anyone polls: within a second of `expiresAt` the attempt is failed with `Authorization timed out` and its loopback listener is closed, so an abandoned attempt never keeps its port.
On success the token is written to the cache and `cacheKey` is returned.
A settled result stays readable for 10 minutes from the start, then the attempt answers `not_found`.

`GET /oauth2/authorize/:attemptId` reads only: polling never settles, fails or tears down an attempt.
An attempt past `expiresAt` reads as `failed` with `Authorization timed out` from that instant on, and a callback or completion arriving after it cannot change that.

At most 16 attempts may be unsettled at once, embedded ones included; the next start is refused with `429` `oauth2_authorize_limit_reached`.
A settled attempt holds no listener and leaves the count.

Cancelling an attempt (`DELETE`), or the engine shutting down, cancels a token exchange still in flight for it, the loopback callback's and an embedded `POST /oauth2/authorize/complete`'s alike: the callback's tab is told the exchange failed, and the completion answers `404`.
A completion (the loopback callback and `POST /oauth2/authorize/complete` alike) always exchanges its code and replaces any token already cached under that key.

The loopback callback reads nothing before `state`, `error` included: a request with a missing or wrong `state` answers `400` and the attempt keeps waiting, so an IdP that omits `state` on its error redirect leaves the attempt pending until it times out.
A callback with the right `state` after `expiresAt` answers `410`.
A loopback attempt settles once, and the first settlement wins: a later callback with the right `state` answers `409` and changes nothing.

### Discovered from an MCP server URL

A config naming `discoverUrl` (#3766), the URL of an OAuth-protected MCP server, is completed from that server before the attempt starts, in the MCP authorization spec's order: the server's 401 challenge or its RFC 9728 well-known document, then its authorization server's RFC 8414 or OpenID Connect metadata (`discover_oauth_server`, see [architecture](../architecture.md)).
`discoverUrl` is read trimmed, like the URL members above.
Discovery **fills only what the config leaves blank**: a typed `authorizationUrl`, `accessTokenUrl`, `resource`, `scope` or `clientId` wins.
A discovered attempt always sends PKCE with `S256` and its verifier, whatever `pkce` says, because the MCP authorization spec requires it.

| Member | Filled from |
|--------|-------------|
| `authorizationUrl`, `accessTokenUrl` | The metadata's `authorization_endpoint` and `token_endpoint` |
| `resource` | The protected resource metadata's `resource`, the canonical server URL; sent on the authorize URL and the token request (RFC 8707) |
| `scope` | The 401 challenge's `scope`; without one, every `scopes_supported` entry of the protected resource metadata, space-joined; without those, no scope is sent (the MCP spec's scope selection) |
| `clientId` | A typed `clientId` (with its `clientSecret`) is used as it is and nothing is registered. Otherwise, when the metadata has a `registration_endpoint`, a client is registered there (RFC 7591) for this attempt, and its `client_id` is used; the typed `clientSecret`, if any, is not sent with it. Otherwise the start is refused with `400` `oauth2_client_id_required`, naming why |

The registration posts `{client_name: "Vayu", redirect_uris: [<redirectUri>], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native"}`: a public native client whose one redirect is the one this attempt uses, the loopback listener's ephemeral port (bound before the registration) or the embedded `callbackUrl`.
A 2xx answer must carry a string `client_id` and describe a public client; one whose `token_endpoint_auth_method` is not `none`, or that carries a `client_secret` and states no method, is refused, and the secret is never logged or repeated.
The discovery and the registration each go through the shared client and transport policy, are bounded by the request timeout setting, and end when the engine stops.

**A server that is not on this machine reaches nothing on it.**
When `discoverUrl` names neither a loopback nor a link-local host, a document that names such a URL is refused (`oauth_discovery_local_endpoint_refused`), and the discovery's fetches, the registration and every token request of the config connect to no loopback or link-local address, by the URL or by the address its name resolves to.
A token endpoint that resolves to one by the time the code arrives never receives the code or the PKCE verifier: the attempt fails with `Token request failed: Cannot send this request: Vayu does not send it to a loopback or link-local address - not when the URL names one and not when a host name resolves to one`.
A typed `accessTokenUrl` is held to the same rule, and a proxy you configured is still used.
A server on this machine may name anything on it.

The rule follows the config, not the attempt: every token request of a config that still names `discoverUrl` runs under it - a refresh, `client_credentials` and the other headless grants, `/execute`, `/runs` and `POST /oauth2/token` - so the refresh token goes to no loopback or link-local peer either, whatever `refreshTokenUrl` resolves to after sign-in (#3800).
Turning discovery off removes `discoverUrl` and with it the rule: the endpoints are then ones you typed, and a config with no `discoverUrl` is held to none.

**Two known limitations of a registered client.**

- A registered client is bound to the loopback redirect of the attempt that registered it, port included.
  The next sign-in reuses its `clientId` from the stored config on a new ephemeral port, so an authorization server that matches redirect URIs exactly refuses it (RFC 8252 section 7.3 asks a server to accept any port on a loopback redirect, and not every server does).
  The recovery is the app's **Discover again**, which clears what discovery wrote, `clientId` included, so the next sign-in registers a client for its own redirect.
- Every discovered sign-in that names no `clientId` registers a new client, and the app stores its `client_id` only once the sign-in succeeds, so an abandoned sign-in (cancelled, timed out or refused) leaves a client registered at the authorization server that nothing will use.
  Vayu does not delete it: it does not use RFC 7592 client management, which a server need not offer.

The answer's `resolved` holds what the attempt runs on, the values a client writes into its stored config so that a later refresh or run needs no discovery and keys the same [cached token](#oauth-20-token-cache) (no secret is ever in it):

```json
{
  "authorizationUrl": "https://auth.example/authorize",
  "accessTokenUrl": "https://auth.example/token",
  "clientId": "registered-or-typed-client",
  "resource": "https://mcp.example/mcp",
  "scope": "mcp:read",
  "issuer": "https://auth.example"
}
```

`scope` is `""` when none was chosen.
The callback (loopback or `POST /oauth2/authorize/complete`) exchanges its code with these values, not with the config as sent.

A start that cannot complete the config is refused before any attempt exists:

| Status | Code | When |
|--------|------|------|
| `400` | `oauth_discovery_invalid_server_url` | `discoverUrl` is not an absolute `http` or `https` URL |
| `504` | `oauth_discovery_timeout`, `oauth_registration_timeout` | The discovery or the registration ran out of time |
| `502` | any other `oauth_discovery_*` code | Discovery found no usable metadata: none answered, a document is invalid, its `resource` or `issuer` does not match, it lacks PKCE `S256`, or it names a local URL for a remote server |
| `502` | `oauth_registration_network_error` | The registration endpoint gave no answer |
| `502` | `oauth_registration_refused` | It answered outside 2xx; its RFC 7591 `error` and `error_description` are quoted |
| `502` | `oauth_registration_invalid_response` | Its 2xx answer names no string `client_id`, or a client that needs a secret |
| `400` | `oauth2_client_id_required` | No `clientId` and no `registration_endpoint` |

**`iss` (RFC 9207).**
A discovered attempt records the issuer, and every callback with the right `state` (and an embedded completion's IdP refusal, which is read without one) is checked against it before anything else in it is used, `error` included:

| Metadata `authorization_response_iss_parameter_supported` | `iss` in the callback | Result |
|--------|--------|--------|
| `true` | equal to the issuer | Proceeds |
| `true` | absent or different | Fails the attempt |
| `false` or absent | absent | Proceeds |
| `false` or absent | different | Fails the attempt |

The comparison is byte for byte on the decoded value, with no case folding or normalisation.
A failed check names the issuer it expected (and the one the callback named), never the response's `error` or `error_description`, and the code is never sent to a token endpoint.
An attempt that was not discovered records no issuer and reads no `iss`.

### POST /oauth2/step-up

Classifies the `WWW-Authenticate` of a `401` or `403` as a step-up or not (#3766, `classify_bearer_challenge`).
It **only classifies**: it sends nothing, retries nothing, re-authorizes nothing and caches nothing, so a client decides what follows (an interactive re-authorization is a [`POST /oauth2/authorize/start`](#interactive-authorization-code-flow) with the `scope` it answers; a load run cannot take that browser step and fails naming the scopes instead).

| Request member | Type | Meaning |
|----------------|------|---------|
| `wwwAuthenticate` | string or array of strings | Required. The response's `WWW-Authenticate` value, or each header line's when it carried several. An empty array or string is a response with no challenge |
| `scope` | string | The scopes already granted or requested, space-separated. Optional, default empty |

The first `Bearer` challenge, across the values in order, that names an `error` is read; a value that is not the RFC 9110 challenge grammar is passed over, never an error and never a step-up.
The answer is `200`:

| Member | Meaning |
|--------|---------|
| `stepUp` | `true` only when the challenge's `error` is exactly `insufficient_scope` (RFC 6750 codes are case-sensitive) |
| `error` | The challenge's `error` as written: `invalid_token` and any other are reported here with `stepUp` `false`. `""` when there is none |
| `requiredScopes` | The challenge's `scope` split on whitespace, repeats dropped, in the order written. `[]` unless `stepUp` |
| `scope` | What a re-authorization asks for: `scope` as sent, then the `requiredScopes` it did not hold, deduplicated and space-joined. `""` unless `stepUp`; a step-up whose challenge names no `scope` answers the held ones |
| `description` | The challenge's `error_description`, `""` when absent |

A body that is not JSON, not an object, lacks `wwwAuthenticate`, or whose `wwwAuthenticate` or `scope` has the wrong type answers `400` `oauth2_invalid_config`.

## Local mock issuer

A built-in OAuth 2.0 issuer for developing and testing auth flows **offline** - no real identity provider, so no 2FA prompts, provider rate limits or "suspicious login" mail in the dev loop.
Each issuer is an independent `127.0.0.1` listener serving `/token`, `/authorize`, `/register`, its RFC 8414 metadata and a protected resource (#3794); point any OAuth 2.0 config's `accessTokenUrl` at the `tokenUrl` it returns, or an MCP server's OAuth discovery at its `discoverUrl`.

It is **not an IdP**.
It serves RFC 8414 authorization server metadata and RFC 9728 protected resource metadata, but not the OIDC `openid-configuration` document; JWKS/RS256, token introspection, consent screens and multi-tenant realms are deliberate non-goals.

| Method / Path | Purpose |
|---------------|---------|
| `POST /mock-issuer/start` | Start one → `{issuerId, issuerUrl, tokenUrl, authorizeUrl, metadataUrl, discoverUrl, signingKey}` |
| `GET /mock-issuer` | List the running issuers → `{issuers: [{issuerId, issuerUrl, tokenUrl, authorizeUrl, metadataUrl, discoverUrl, signingKey, port, expiresInSeconds, failureMode, slowMs, issueRefreshTokens, resourceScope, clientCount, createdAt}]}`; the `PUT` answers one such object |
| `PUT /mock-issuer/:id` | Update `failureMode` / `slowMs` / `expiresInSeconds` live |
| `POST /mock-issuer/:id/stop` | Stop one → `{stopped: true}` (`404` if unknown) |

**Start body** (every field optional):

```json
{
  "port": 0,
  "expiresInSeconds": 3600,
  "claims": { "sub": "alice", "roles": ["admin"] },
  "clients": [{ "clientId": "cid", "clientSecret": "s3cret" }],
  "failureMode": "none",
  "slowMs": 2000,
  "issueRefreshTokens": true,
  "resourceScope": ""
}
```

`port: 0` (the default) binds an ephemeral port; an explicit `port` another engine listener already holds is a `500` with code `mock_issuer_bind_failed` naming that listener, for the [same `SO_REUSEPORT` reason](inbox.md#webhook-inbox) the inbox refuses one.
`clients` empty accepts **any** client id; with clients configured, an id must be one of them and, at `/token`, one carrying a secret must present it (Basic header or body - both RFC 6749 §2.3.1 placements); `/authorize` checks the id only.
A client `/register` issued is accepted beside them (below).
`resourceScope` is the space-separated scope `/resource` requires of a token (empty, the default, requires none): scope tokens of RFC 6749 §3.3 (visible ASCII but `"` and `\`) joined by single spaces, at most 512 bytes, fixed at start like `port`, `clients`, `claims` and `issueRefreshTokens`.
A field present with the wrong type or an out-of-range value is a `400` (`mock_issuer_invalid_config`) rather than a silent fallback to the default - a mock issuer running with an expiry other than the one asked for would defeat the purpose.
At most 8 issuers run at once (`429 mock_issuer_limit_reached`).

**The issuer's own endpoints:**

- `POST /token` - `client_credentials`, `password`, `authorization_code` and `refresh_token` grants, `application/x-www-form-urlencoded` as RFC 6749 §3.2 requires.
  Answers `{access_token, token_type: "Bearer", expires_in, refresh_token?, scope?}`.
  Authorization codes are single-use and expire after 5 minutes; a refresh grant **rotates** its token (the presented one is spent).
- `GET /authorize` - auto-approves and `302`s straight back to `redirect_uri` with `code` and `state`, so the interactive flow completes with zero human steps.
  PKCE is verified when a `code_challenge` is present; `code_challenge_method` must then be `S256` (`plain` is refused rather than quietly accepted).
  An unknown client or a missing `redirect_uri` answers in place rather than redirecting (RFC 6749 §4.1.2.1).
  The redirect also carries `iss`, the `issuerUrl` (RFC 9207); it answers no error by redirect, so no error redirect needs one.
- `POST /register` - RFC 7591 dynamic client registration, open (no credential).
  The JSON body's `redirect_uris` must be a non-empty array of at most 8 absolute URIs (a scheme, then `:`; no fragment, space or control byte; at most 2048 bytes each), else `400 invalid_redirect_uri`; a body that is not a JSON object is `400 invalid_client_metadata`.
  Answers `201 {client_id, client_id_issued_at, redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"]}` with no `client_secret`: every registered client is public, whatever the request asked for.
  `/authorize` then requires a registered client's `redirect_uri` to equal one it registered exactly (else `400`, answered in place) and a PKCE `code_challenge`; `/token` takes its id with no secret for those two grants and answers any other `400 unauthorized_client`.
  An issuer keeps its 64 newest registrations: the 65th forgets the oldest, and from then on that `client_id` is any other id the issuer was not given.
  With `clients` configured that is `400 invalid_client`; with none, it is accepted like any id, so `/authorize` takes any `redirect_uri` and no PKCE for it and `/token` takes it for every grant.
- `GET /.well-known/oauth-authorization-server` - RFC 8414 metadata at the `metadataUrl`:
  `issuer` (the `issuerUrl` byte for byte, no trailing `/`), `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported` (`client_secret_basic`, `client_secret_post`, `none`) and `authorization_response_iss_parameter_supported: true`.
- `GET /resource` - a protected resource, the `discoverUrl`.
  No bearer token is `401` with `WWW-Authenticate: Bearer resource_metadata="<issuerUrl>/.well-known/oauth-protected-resource"` (plus `scope="<resourceScope>"` when one is set); a token that is not an unexpired HS256 JWT signed with this issuer's `signingKey` is the same `401` with `error="invalid_token"` first;
  a good token whose `scope` lacks a word of `resourceScope` is `403` with `Bearer error="insufficient_scope", scope="<resourceScope>", resource_metadata="..."`; otherwise `200 {resource, scope}`.
- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/resource` - RFC 9728 metadata for it, at both section 3.1 locations (the second inserts the resource's path, the form a strict client probes): `{resource: "<issuerUrl>/resource", authorization_servers: ["<issuerUrl>"], bearer_methods_supported: ["header"]}`.

**MCP OAuth discovery against the mock.**
Discovery accepts a protected resource only for a server URL it covers (same origin, its path a prefix), so the URL to enter as an MCP server's `discoverUrl` is the issuer's own `discoverUrl` (`<issuerUrl>/resource`), which both `POST /mock-issuer/start` and `GET /mock-issuer` return.
Its unauthenticated `401` names the metadata, that names the issuer, and the issuer's metadata names the endpoints and registration, so a discovered sign-in completes with nothing else configured.
Both URLs are loopback, so the rule that refuses a loopback endpoint named by a server that is not on this machine does not apply.

The access token is an **HS256 JWT** signed with the per-issuer `signingKey` the start call returned - hand that key to the service under test as its shared secret and it can verify the mock's tokens.
The payload is the configured `claims` plus `iss`, `iat`, `exp` and `jti` (these four always win, since they describe the token being issued), with `sub`, `client_id` and `scope` filled in only when the claims did not set them.

`failureMode` is what makes retry and error handling testable, and can be flipped on a **running** issuer with the `PUT`.
Each mode changes one route; every other route answers normally (`slow` and `server_error` slow or fail `/token` only, never the metadata, registration or resource routes):

| Mode | What changes |
|------|--------------|
| `none` | Nothing |
| `slow` | `/token` answers normally, after `slowMs` (at once when the issuer stops first) |
| `server_error` | `/token` answers `500 {"error": "temporarily_unavailable"}` |
| `invalid_client` | `/token` answers `401 {"error": "invalid_client"}` |
| `metadata_not_found` | `GET /.well-known/oauth-authorization-server` answers `404`, so discovery fails with `oauth_discovery_authorization_server_metadata_not_found` |
| `registration_refused` | `POST /register` answers `400 {"error": "invalid_client_metadata"}` |
| `wrong_iss` | The `/authorize` redirect's `iss` is `<issuerUrl>/other`, which a discovered sign-in refuses (RFC 9207) |

Issuers bind `127.0.0.1` only - never configurable, because they mint bearer tokens and the engine has no route auth.
State is in-memory: a restart forgets every issuer, and stopping one drops its codes, refresh tokens and registered clients with it.
