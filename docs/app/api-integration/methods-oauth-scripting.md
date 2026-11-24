---
description: >-
  The API service's methods for the OAuth 2.0 token cache and flow, and for the scripting completions the editor reads.
---

# API methods: OAuth 2.0 and scripting

## Scripting

```typescript
apiService.getScriptCompletions(): Promise<ScriptCompletionsResponse>
```

## OAuth 2.0

```typescript
apiService.fetchOAuth2Token(data): Promise<OAuth2TokenResponse>        // POST   /oauth2/token
apiService.getOAuth2TokenStatus(cacheKey): Promise<OAuth2StatusResponse> // GET  /oauth2/token?key=
apiService.clearOAuth2Token(cacheKey): Promise<void>                   // DELETE /oauth2/token?key=

// Interactive Authorization Code flow (engine-hosted loopback + PKCE)
apiService.startOAuth2Authorize(data): Promise<OAuth2AuthorizeStartResponse>  // { attemptId, authorizeUrl, redirectUri, expiresAt, resolved? }
apiService.getOAuth2AuthorizeStatus(attemptId): Promise<OAuth2AuthorizeStatus>
apiService.completeOAuth2Authorize(attemptId, callbackUrl): Promise<OAuth2AuthorizeStatus>

// Is a 401/403's challenge a step-up? Classifies only (#3766)
apiService.classifyOAuth2StepUp({ wwwAuthenticate: string[], scope? }): Promise<OAuth2StepUpResponse>
// { stepUp, error, requiredScopes, scope, description }       // POST /oauth2/step-up
```

These back the OAuth 2.0 auth editor.
TanStack Query wraps the non-interactive ones in `queries/oauth.ts` (`useOAuth2TokenStatusQuery` - polls status ~30s; `useFetchOAuth2TokenMutation`, `useClearOAuth2TokenMutation`).
The token `cacheKey` is computed client-side by `services/oauth/cache-key.ts`, byte-identical to the engine so the app and engine agree on cache slots without a round-trip.
The key reads the config's `authorizationParams`, `tokenParams` and `refreshParams` rows (issue #2536) beside the token URL (trimmed of ASCII whitespace as the engine reads it, #3687), client id, credentials id,
the raw grant type (#3689, so one client's grants hold separate tokens) and the grant's identity (the password grant's username, the JWT bearer grant's subject), so two audiences sent as rows are two cached tokens;
a row whose key names a credential (`client_assertion`, `X-Api-Key`; `services/oauth/credential-params.ts`) is keyed by its key alone, so the key never carries the secret.
`scope`, `audience` and `resource` themselves are still not in it.

The JWT bearer grant (`grantType: "jwt_bearer"`, RFC 7523, #3632) adds `subject`, `assertionAudience`, `assertionClaims` (`{key, value, enabled}` rows, no `sendAs`), `assertionLifetimeSeconds` (1 to 3600, engine default 180), `signingAlgorithm` (`RS256` default or `ES256`), `keyId`, and the signing key as exactly one of `privateKey` and `privateKeyFile`.
`fallbackExpiresIn` (seconds a token that states no `expires_in` is kept, up to a year, absent keeps it until replaced) is a member of every grant.
The renderer sends everything but `privateKey` resolved: that member is one `{{variable}}` reference, left as written by every host that resolves a config (`keepSigningKeyReference`, `services/oauth/signing-key.ts`), and `OAuth2TokenRequest` carries `environmentId` and `collectionId` so the engine resolves it from the scopes a Send of the request reads.
The token row sends the active environment and the request's collection (the collection itself, from its own auth editor); the load-test guards do the same for a refresh, with the collection of the request a run's token was first seen on.
An id that is not known is omitted, and a key file needs neither.
A typed PEM never reaches the config: the form refuses it, and a file is picked through `useFilePick`, which records the engine's grant for it.

The interactive flow is orchestrated in `services/oauth/authorize.ts` (opens the system browser or an embedded Electron window, then polls the engine).
The engine owns the deadline and reports it as `expiresAt` (epoch ms) on the start answer; the app keeps no clock of its own.
The loopback poll runs until `expiresAt` plus `EXPIRY_GRACE_MS`, so the engine's own `failed` "Authorization timed out" answer arrives first, and the embedded window is handed the time remaining (`timeoutMs` on `oauthOpenWindow`, which the main process refuses unless it is a positive finite number).

**Discovered from a server URL (#3766).**
An `authorization_code` config may carry `discoverUrl`, the OAuth-protected MCP server's URL (`""` is the form's switch on with nothing typed yet).
The engine runs the discovery, and a client registration when no `clientId` is typed, inside `POST /oauth2/authorize/start`, so a start naming one gets `startOAuth2Authorize`'s longer budget (`discoveredStartTimeoutMs`: the `defaultTimeout` setting counted twice, plus the grace).
The answer's `resolved` (`OAuth2AuthorizeResolved`: `authorizationUrl`, `accessTokenUrl`, `clientId`, `resource`, `scope`, `issuer`; no secret) is what the attempt runs on.
Discovery is a **fill** step on both sides: the engine fills only the members the posted config left blank, and once the sign-in succeeds the form writes exactly those into the stored config (`discoveredValues` and `withDiscoveredValues`, `services/oauth/discovery.ts`) and names them in `discoveredFields`.
From then on the stored config holds ordinary endpoints and a client id, so the cache key, a refresh,
a Send and a run read it like any other and need no discovery (while `discoverUrl` stays on, a refresh and a run still refuse a token endpoint that is, or resolves to, a loopback or link-local address, #3800; choosing another grant in the form drops `discoverUrl` and `discoveredFields`); `cache-key.ts` is unchanged.
`issuer` is not stored.
A config with discovery on and no cache key yet (`awaitsDiscovery`) has no token to look up: the token row offers the sign-in under `oauth2SignInKey` (`discover:<url>`), and the load-test guards say to sign in first.
`missingOAuth2Fields` asks such a config for the server URL only.
`clearDiscovered` (the form's Discover again) removes what discovery wrote and keeps what was typed, so the next sign-in discovers, and registers, again.

`runInteractiveAuthorization(config, signal?)` resolves with `{ cacheKey, resolved? }`, `resolved` only for a discovered start; the embedded window's partition and a fallback `cacheKey` are computed from the config with the discovered values filled in, the values the engine exchanged the code with.
It stops on an `AbortSignal`: the poll delay and the embedded-window wait both end at once, every engine call is preceded by a check, and it rejects with `InteractiveAuthCancelledError` (a subclass of `InteractiveAuthError` that callers skip reporting).
The renderer cannot close the embedded window or the system browser tab, so an abort stops waiting and ignores whatever the window answers later.
`useOAuth2SignIn` (`components/shared/OAuth2Form/`) passes the signal from `stores/oauth-signin-store.ts`, which keys one sign-in per `oauth2SignInKey`, and hands a landed sign-in to its caller only while that caller still shows a config with the same key.

**Step-up (#3766).**
A 403 whose `WWW-Authenticate` the engine classifies as `insufficient_scope` is a step-up.
The response pane sends each received `WWW-Authenticate` line (`stepUpChallenges`, `ResponseViewer/step-up.ts`; a 403 only, and nothing is asked about any other status) with the scope the request's own OAuth 2.0 config requests, through `useOAuth2StepUpQuery`.
The answer's `scope` is the held scopes plus the required ones, and that is what the callout's Re-authorize signs in with (`useOAuth2SignIn`, the token row's path) and then writes into the config's `scope`.
The engine retries and re-authorizes nothing, and neither does the app on its own; a load run cannot take a browser step at all.

> **`HttpClient.delete`** takes an optional `params` argument so the token-clear
> call can pass `?key=`.
