---
description: >-
  The tables that hold client certificates, the folders and files the engine may read, and the cached OAuth tokens.
---

# Certificates, file access and OAuth tokens

## `client_certificates`

The registry that maps a host to the client certificate Vayu presents to it (issue #707).
Read into the transport policy at the point of use - once per run on the load and collection paths - and applied by the shared applier every outbound transfer goes through.
See [api-reference/cookies-and-certificates.md](../api-reference/cookies-and-certificates.md#client-certificates) for the routes and the matching rule.

| Column       | Type    | Notes                                                     |
|--------------|---------|-----------------------------------------------------------|
| `id`         | TEXT PK | `cert_` + UUID                                            |
| `host`       | TEXT    | Hostname, lower-cased, no scheme/port/path, or `*.example.com` for every subdomain of it (issue #803). IPv6 without brackets |
| `port`       | INTEGER | NULL = answers for the host on every port                 |
| `cert_path`  | TEXT    | Path to the certificate file                              |
| `key_path`   | TEXT    | Path to the private key file; `""` for a `p12` entry, which carries its own |
| `cert_format`| TEXT    | `pem` or `p12` (issue #833). NOT NULL, default `pem` - what a row written before this column existed is |
| `passphrase` | TEXT    | The key's passphrase, `""` when it has none. **Plaintext** - see below |
| `created_at` | INTEGER | Unix ms                                                   |
| `updated_at` | INTEGER | Unix ms                                                   |
| `deleted_at` | INTEGER | Nullable, Unix ms. NULL while live; the delete's instant once it is in the trash (#2973) |

**The private key never enters this database.**
`cert_path` and `key_path` are paths, and the engine opens the files at send time - the strongest storage decision available without a keystore, and the reason a registry entry survives being copied between machines only if the files do.

**`cert_format` is stored rather than sniffed per send.**
The applier runs on every handle of every load run, so reading the file each time would pay for the same answer thousands of times - and a format nothing recorded is one the Settings card cannot print back for the user to correct.
It is written once, at the moment the entry is registered, from the body or from the file's own first bytes; `client_cert_rejection` refuses a row whose bytes contradict it.

**The passphrase is stored in plaintext, and that is disclosed rather than hidden.**
It is the same treatment every other credential in this file already gets - request auth, and `oauth_tokens.access_token` / `refresh_token` - and libsodium, though linked, encrypts nothing here.
OS-keychain storage is explicitly out of scope for the transport epic (#704, decision 6); it would be its own change, touching every stored credential rather than this one column.
The wire is narrower than the file: reads never echo the passphrase, answering `hasPassphrase` instead.

**A trashed row is never presented.**
`DELETE /client-certificates/:id` stamps `deleted_at`, and both reads (`get_client_certificates`, `get_client_certificate`) filter `deleted_at IS NULL`.
The first is what `resolve_transport_policy` reads, so the stamp takes the entry off every send at once.
An entry owns no rows, so, as with [`environments`](environments-and-globals.md#environments), its stamp is no cohort key: it is always its own trash root, a restore clears the stamp alone, and a purge (`DELETE /trash/:id`, or retention) removes the row.
**The passphrase stays on a trashed row, in plaintext, until that purge** - a restore gives the entry back exactly as it was, and nothing short of the purge removes the value from the file.

`port` is nullable rather than a sentinel because "every port" is the *absence* of a port, the same distinction `result_bodies.stream_events` draws.
At most one row may claim a given `host` + `port` pair - the routes answer `409` on the second, and a wildcard pattern is a `host` like any other, so the rule covers it unchanged.
Several rows may still *match* one transfer once patterns overlap (#803), and they are ranked rather than tie-broken: closest host, then port.
A tie would need the same host and port twice, which is the pair the `409` forbids.
The rule counts live rows only (`client_certificate_for_target`, the one definition the routes and the trash share): a trashed entry frees its target, and restoring it while a live row has taken that target is the restore's `409`.

---

## `file_roots`

The folders a request-body file may be read from without being picked file by file (schema version 3).
A file reference (see [`requests.body`](collections-and-requests.md#requests)) is sent when its canonical path lies under one of these or is a [`file_grants`](#file_grants) row; both are read once per design send and once per run.
See [api-reference/file-access.md](../api-reference/file-access.md#allowed-folders-file-roots) for the routes.

| Column       | Type         | Notes                                                    |
|--------------|--------------|----------------------------------------------------------|
| `id`         | TEXT PK      | `froot_` + UUID                                          |
| `path`       | TEXT UNIQUE  | Canonical absolute folder path, no trailing separator    |
| `created_at` | INTEGER      | Unix ms                                                  |

`path` is canonical when written (symlinks resolved, `.` and `..` folded), so two spellings of one folder are one row, and the `409` the route answers for a second is backed by the constraint.
A filesystem or drive root and the home folder itself are never stored: the route refuses them, and the [schema version 4 migration](startup-and-recovery.md#the-file-trust-restatement-schema-version-4) removed any stored before.

---

## `file_grants`

The files a person picked, each of which may be sent from wherever it lies (schema version 6, #2356): the per-file half of the trust rule beside [`file_roots`](#file_roots), read with it once per design send and once per run (`FileAccessPolicy::from_database`).

| Column       | Type         | Notes                                                    |
|--------------|--------------|----------------------------------------------------------|
| `id`         | TEXT PK      | `fgrant_` + UUID                                         |
| `path`       | TEXT UNIQUE  | Canonical absolute path of a regular file                |
| `created_at` | INTEGER      | Unix ms                                                  |

`path` is the file's canonical form when it was picked (`grantable_file_path`: every symlink resolved, never a `{{` template), and a send compares the canonical form of what it is about to read with it exactly, never resolving the stored path again: a link re-pointed after the pick resolves to another file and is refused.
The [schema version 6 migration](startup-and-recovery.md#the-file-grants-migration-schema-version-6) wrote the first rows, one per file a stored body marked chosen.
See [api-reference/file-access.md](../api-reference/file-access.md#picked-files-file-grants) for the routes; like `file_roots`, this table is written only by a caller holding the engine's grant secret.

---

## `oauth_tokens`

Cached OAuth 2.0 access/refresh tokens, keyed by config identity.
Written by the token client (`engine/src/http/oauth_client.cpp`); struct is `db::OAuthToken`.
Auto-created by `sync_schema()`.

| Column          | Type    | Notes                                                             |
|-----------------|---------|-------------------------------------------------------------------|
| `cache_key`     | TEXT PK | `accessTokenUrl \x1f clientId \x1f credentialsId \x1f grantType \x1f username?`, then one `\x1f <list>:<key>=<value>(\x1e ...)` segment per extra parameter list with a sendable row, a credential-named row's value left out ([recipe](../api-reference/authentication.md#oauth-20-token-cache)) - byte-identical to the app's `computeOAuth2CacheKey` (omits scope/audience/resource). A row keyed before `grantType` joined the key (#3689) is orphaned, never reused and never pruned |
| `access_token`  | TEXT    | Bearer token (plaintext at rest)                                  |
| `token_type`    | TEXT    | Defaults to `"Bearer"` when the provider omits it                 |
| `refresh_token` | TEXT    | `""` when none                                                    |
| `scope`         | TEXT    | Granted scope, if returned                                        |
| `expires_in`    | INTEGER | Seconds; `0` = non-expiring                                       |
| `created_at`    | INTEGER | Unix ms                                                           |

Expiry is `now > created_at + expires_in*1000 − skew`, with skew = min(45s, `expires_in`/2), so a token living less than 90s is still valid for the first half of its life.
On refresh the `refresh_token` rotates when the provider issues a new one; a rejected refresh token (`invalid_grant` or `invalid_client`) clears the row, only while the row still holds that refresh token (`Database::delete_oauth_token_if_refresh_matches`, one lock acquisition, #3344), and falls back to a fresh grant.
Any other refresh failure, an unavailable token endpoint included, keeps the row (#3360).

A load run **does** refresh mid-run: a run whose auth resolves to a header-placed, expiring oauth2 token gets a watchdog thread (a collection load run one per distinct cache key its steps send, #3199) that re-acquires `oauth2RefreshLeadMs` (default 60s) before expiry, writes the new row here and republishes the header onto every later transfer.
That lead, the floor between two renewals (`oauth2RefreshMinIntervalMs`), the retry backoff after a refused renewal (`oauth2RefreshRetryMs` doubling to `oauth2RefreshRetryMaxMs`) and how often the watchdog wakes to notice the run ended (`oauth2RefreshPollIntervalMs`, which bounds how long a finished run waits to join it) are all settings under **Services**,
read once when a run arms its watchdog, so a change applies to the next run started.
It stays out of the way for the shapes it cannot renew - `tokenPlacement: "query"` (the credential is in the URL every transfer copies), `autoRefreshToken: false`, an `authorization_code` grant with no refresh token, a non-expiring token, a token that lost to a user-supplied `Authorization` header, and a collection step whose auth waited on its scripts.
Each refresh, and any failure, is reported in the run's `auth` section; a failed refresh never fails the run.
See `plan_oauth2_refresh` and `plan_auth_refresh` (`engine/src/http/auth_resolver.cpp`), and `plan_scenario_auth_refresh` and `run_auth_refresh` (`engine/src/core/auth_refresh.cpp`).

Tokens are plaintext at rest (v1 posture), in a database file only its owner can read (`0600` in a `0700` directory on POSIX); the row is cleared via `DELETE /oauth2/token`.
The provider's raw response (refresh and id tokens included) is not stored: the column was dropped at schema version `5`.
