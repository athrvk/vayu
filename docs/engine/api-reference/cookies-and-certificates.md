---
description: >-
  The cookie jar routes, the client-certificate routes and the connection probe that reports what a transfer to a host would negotiate.
---

# Cookies, client certificates and transport diagnostics

## Cookies

The engine keeps a cookie jar for design-mode requests (`POST /execute` and the `pm.sendRequest` calls inside it), so a session set by one request is sent on the next.
**One jar per environment**, plus one for requests sent with no environment selected; in memory only, for the life of the engine process, and never written to disk.
Load runs neither read nor write it.

A cookie set *during* a redirect chain stays with the origin that set it: it is stored in the jar as any other, and a later hop of the same send carries it only when that hop goes to the same origin - see [POST /execute](execute.md#post-execute) for what a redirect that changes origin does to cookies.
The `Set-Cookie` lines of those intermediate hops are reported on the answer's `redirects` member, whether or not a later hop carried them.

libcurl caps what it attaches: 150 jar cookies, and a `Cookie` line of 8190 bytes.
A send that hits either still succeeds and says so in its `warnings` (`cookie_limit_reached`, `cookie_not_sent`; see [POST /execute](execute.md#post-execute)): the answer's, or for a streaming send, whose `202` carries none, the stored trace's.
The 8190-byte cap also drops the request's typed `Cookie` rows, which share the line; the 150 cap does not.

libcurl also silently discards what a response sets past three limits: a `Set-Cookie` line over 5000 bytes, a cookie whose name and value together pass 4096 bytes, and every cookie after the first 50 of one response.
The answer (a stream's stored trace) says so under `warnings` (`cookie_dropped_oversized`, `cookie_dropped_too_many`), naming a dropped cookie and never its value.
A request sent with `disableCookies` has no jar and so no warning: libcurl's cookie engine is off and drops nothing.

Under load the same three limits apply to a scenario load run's per-virtual-user cookies, and what they drop is counted across the run in one `cookies_dropped` [run warning](runs.md#get-runsrunidreport) that names no cookie.
A single-request load run keeps no cookies, so it drops none.
The two outgoing caps above are not detected under load.

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

`SameSite` is parsed and ignored, on purpose: an API client has no cross-site initiator to restrict, so every cookie whose domain, path and `Secure` flag match is sent whatever its `SameSite` value (`Strict`, `Lax` or `None`).

### GET /cookies

Every jar that holds anything, one entry per scope, in scope-key order (the no-environment jar first), each jar's cookies in its own line order.

A jar whose environment is in the [Trash](trash.md#trash) is left out of both forms (issue #3349).
The jar is kept, so [`POST /trash/:id/restore`](trash.md#post-trashidrestore) brings the environment's session back with it and it is listed again; a purge ([`DELETE /trash/:id`](trash.md#delete-trashid)) drops it.
The same goes for a jar keyed by an `environmentId` that names no stored environment.
The no-environment jar is always listed.

**Query Parameters:**
- `q`, `limit`, `offset` (optional): one page of the cookies whose `name` or `domain` holds `q`, in the `{data, pagination}` envelope - see [Paged lists](resource-writes.md#paged-lists).
  A page is **flat**: the scopes are walked in the order above and each cookie row carries its scope's `environmentId` beside the cookie fields (`{environmentId, name, value, domain, path, secure, httpOnly, expires}`).
  A bad `limit` or `offset` is a `400` (`invalid_limit`, `invalid_offset`).

**Response** (none of the three):
```json
{
  "scopes": [
    {
      "environmentId": "env_staging",
      "cookies": [
        {
          "name": "session",
          "value": "abc123",
          "domain": ".staging.example.com",
          "path": "/",
          "secure": true,
          "httpOnly": true,
          "expires": 1767225600
        }
      ]
    }
  ]
}
```

`environmentId` is `null` for the no-environment jar - null rather than `""` so a client cannot mistake it for an id.
`expires` is unix seconds, or `0` for a session cookie (one that lives until the engine exits).
A scope with no cookies left is not reported.

This route lists what a jar holds, not what a URL would carry.
The URL-scoped reads of the script API (`pm.cookies`, `jar().getAll(url)`) match a `secure` cookie over `https://`, and over `http://` only for `localhost`, `127.0.0.1` and `::1`, which libcurl sends it to as trustworthy origins.

### DELETE /cookies

Clear one jar, or all of them.

**Query parameters:**

| Parameter | Meaning |
|-----------|---------|
| *(none)* | Clear every jar |
| `environmentId=<id>` | Clear that environment's jar |
| `environmentId=` | Clear the no-environment jar |

The three cases are the [null-vs-absent rule](resource-writes.md#the-null-vs-absent-rule) in a query string: an empty value is a real scope - the one no id can name - and not a mistake.

**Response:**
```json
{
  "cleared": 3
}
```

`cleared` counts the cookies dropped; clearing a scope that holds nothing is a `200` with `0`, not an error.
Clearing every jar also clears the ones `GET /cookies` leaves out because their environment is in the trash, and `cleared` counts their cookies too: clearing everything leaves no credentials behind.

## Client certificates

An mTLS endpoint asks the client to present a certificate, and a certificate is a property of **where you are calling**, not of one request - the transfer that needs it is as often an OAuth token fetch, a redirect or a script's `pm.sendRequest` as it is the request you are looking at.
So the engine keeps a registry of host to certificate and applies the matching entry itself, on every outbound path: design sends, load runs, SSE streams, `pm.sendRequest`, the OAuth token endpoint, `POST /import/fetch` and the monitor scrape.
Nothing on a request names a certificate.

Rows are read into the [transport policy](health-config.md#proxy-settings) at the point of use, so a change reaches the next transfer without a restart - and, exactly like the proxy, a load run and a collection run read the registry **once at run start** and hold it, because libcurl reuses a pooled connection only when its TLS identity matches.

**A redirect is matched hop by hop on a design send, a stream and a load run.**
`POST /execute` (buffered or `stream: true`), the `pm.sendRequest` calls inside it, the OAuth token fetch, a typed `POST /import/fetch` and every request of a load run follow a redirect one transfer per hop, and the registry is asked about each hop's own host and port:
a send that starts at `http://host` and is redirected to an mTLS `https://host` presents the entry that answers for the second, and a hop no entry answers for presents nothing.

**Matching is by host, and most specific wins.**
A `host` is either an exact name (`api.example.com`) or the one wildcard form, `*.example.com`, which is read as a label suffix: it answers for `api.example.com` and `a.b.example.com`, never for `example.com` itself and never for `notexample.com`.
That is the whole syntax - a `*` anywhere else is a `400` naming the form, rather than a row stored as a hostname no transfer can ever equal - and a wildcard never answers for an address literal (`127.0.0.1`), which only an exact entry matches.

Three tiers decide which entry answers, closest host first:

| Tier | Beats | Example against `api.eu.example.com:8443` |
|------|-------|-------------------------------------------|
| 1 | An exact host beats every wildcard | `api.eu.example.com` wins over `*.eu.example.com`, even if only the wildcard names the port |
| 2 | A longer wildcard beats a shorter one | `*.eu.example.com` wins over `*.example.com` |
| 3 | Within one host, the port beats the catch-all | `*.example.com` + `port: 8443` wins over `*.example.com` + `port: null` |

The order is total, so the answer never depends on the order rows were added: two entries can only rank equally by naming the same host *and* the same port, and the second such write is a `409`.
Host comparison is case-insensitive (rows are stored lower-cased), and an IPv6 host is registered without its brackets (`::1`).

**Paths, not contents.**
The row holds the *paths* of the certificate and key files and the engine opens them at send time, so the private key never enters the database.
The passphrase is the one exception - it is stored, in plaintext, the same as every other saved credential (see [db-schema/credentials-and-files.md](../db-schema/credentials-and-files.md#client_certificates)) - and it is **never sent back**: reads carry `hasPassphrase` instead.

Both file paths are checked when the entry is written, and an unreadable one is a `400` naming the file.
That is deliberate: a path that is not there otherwise fails at handshake time as an SSL error against the endpoint, which reads as "the API is broken" rather than "this setting is wrong".

A cert-authenticated exchange says so.
`POST /execute` returns `clientCertificate` on the response, the entry the **final** hop presented (`""` when none matched it), and the stored trace carries the same value under the same name, so a restored response names the entry a live one named.
A certificate is presented in a TLS handshake only, so the field is `""` for an `http://` final hop whatever the registry holds for that host (#3260).

**The row says what format its certificate is in, and the engine tells libcurl so.**
`certFormat` is `pem` - a PEM certificate with its key in a second file - or `p12`, a PKCS#12 bundle carrying both, and it becomes `CURLOPT_SSLCERTTYPE` on every transfer.
Which formats work is a property of the build's TLS backend:

| Backend | Builds | Presents |
|---------|--------|----------|
| OpenSSL | Linux, macOS, Windows | `pem` and `p12` |
| Schannel | none (issue #851) | `p12` only |

**Mutual TLS works on all three platforms** because no build uses Schannel (issue #851).
curl's Schannel client-certificate path cannot complete the handshake - it imports the bundle with `PKCS12_NO_PERSIST_KEY` and the key that yields is one Schannel's credential path cannot use, so the transfer fails with `SEC_E_INTERNAL_ERROR ... The Local Security Authority cannot be contacted` (issue #842).

**Before moving any leg back to Schannel, read closed issue #842.**
The defect above is open upstream: curl carries **two** entries for it in its own `KNOWN_BUGS` (curl issues 17626 and 3145), one of them naming the exact call, and #842 is the measurement record - every driver, with a legacy-PBE and a PBES2 bundle alike.
A change that returns to Schannel has to re-instate the wire skip #851 deleted.
Schannel also takes no PEM pair at all, so a `pem` entry would fail at handshake time and a Windows build could present nothing a user registered (issue #833).

Both formats are asserted on a wire on every leg (a design send, an SSE stream, a load run and a `pm.sendRequest` against a listener that demands a client certificate).

**A PKCS#12 entry names no key file**, because the bundle carries the key: a row that names one is a `400` rather than a stored path nothing would read, and `keyPath` comes back `""`.
The `passphrase` field covers both formats - libcurl reads it as the PEM key's passphrase and as the bundle's import password.

**The format is checked against the file, and defaulted from it.**
Leave `certFormat` out and the engine reads the first bytes of `certPath` - a PEM marker or the ASN.1 `SEQUENCE` a DER bundle opens with - and stores what it found, falling back to `pem` for a file it cannot classify.
Name it and it is kept, but a *contradiction* (a bundle registered as `pem`, or the reverse) is a `400`: the alternative is libcurl's parse error against the endpoint, which is the misdiagnosis this registry exists to end.
A file the engine cannot classify is left for the backend to judge rather than refused here.

### GET /client-certificates

Every registered entry; a trashed one is not listed.

**Response:**
```json
[
  {
    "id": "cert_7f3c1a2b",
    "host": "api.example.com",
    "port": 8443,
    "certPath": "/home/ada/certs/client.pem",
    "keyPath": "/home/ada/certs/client.key",
    "certFormat": "pem",
    "hasPassphrase": true,
    "createdAt": 1767225600000,
    "updatedAt": 1767225600000,
    "usable": true
  },
  {
    "id": "cert_2b9d4e60",
    "host": "internal.example.com",
    "port": null,
    "certPath": "/home/ada/certs/moved.pem",
    "keyPath": "/home/ada/certs/moved.key",
    "certFormat": "pem",
    "hasPassphrase": false,
    "createdAt": 1767225600000,
    "updatedAt": 1767225600000,
    "usable": false,
    "problem": "certificate file '/home/ada/certs/moved.pem' is not a readable file"
  }
]
```

`port` is `null` - not `0` and not omitted - for an entry that answers on every port.
`keyPath` is `""` for a `p12` entry, which stores no key path at all.

**`usable` is whether the engine would present the entry**, judged by the check a write runs (and the transport policy re-runs on every row it reads) against the files as they are now.
A row can fail it after being written: a file moved or deleted, or a row edited around the routes.
The engine then leaves that entry out of every send, and `problem` says why - the failed check's own sentence, or for a `certFormat` the engine does not know, a sentence naming it.
`problem` is absent on a usable row.
Only this list carries the two fields; the `POST` and `PUT` responses do not, since those refuse an unusable row.

### POST /client-certificates

Register a certificate for a host.
**Create only** - the engine owns the id, so a body carrying one is a `400` (see [the engine owns every id](resource-writes.md#the-engine-owns-every-id)).

**Body:**

| Field | Required | Meaning |
|-------|----------|---------|
| `host` | yes | Hostname, no scheme, port or path - or `*.example.com` for every subdomain of it. Stored lower-cased. |
| `port` | no | The port this entry is specific to; `null` or absent means every port. |
| `certPath` | yes | Path to the certificate file. Must be readable now. |
| `certFormat` | no | `pem` or `p12`. Absent or `null` reads it off `certPath`, falling back to `pem`. |
| `keyPath` | for `pem` | Path to the private key file. Must be readable now, and must be **absent** for `p12`. |
| `passphrase` | no | The key's passphrase, or a PKCS#12 bundle's import password. Write-only. |

**The uniqueness check and the write are one lock scope.**
Proving no other row already claims this `host` + `port` and writing the new row happen under one acquisition of the database lock, so two creates for the same target racing each other cannot both pass the check before either writes - the second is answered with the `409` below rather than landing beside the first.

**Errors:**

| Status | When |
|--------|------|
| `400` | A host that could never match (carries a scheme, a path, a port, or brackets, or a `*` outside the `*.example.com` form), a port outside `1..65535`, a non-integer `port`, a missing `host` / `certPath`, a `pem` entry with no `keyPath`, a `p12` entry that names one, a `certFormat` outside `pem` / `p12`, a `certFormat` the file's own bytes contradict, a file that is not readable, or a body `id`. |
| `409` | Another entry already claims this `host` + `port`. Two rows for one target would make the certificate presented depend on row order, so the second is refused with the id of the first rather than silently shadowing it. |

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### PUT /client-certificates/:id

Update an entry.
**Update only** - a missing id is a `404`, never a silent create.
Merge-patch under the [null-vs-absent rule](resource-writes.md#the-null-vs-absent-rule): an absent field keeps its value, `port: null` widens the entry to every port, `passphrase: null` clears a stored one, and `keyPath: null` clears the key path - which is how an entry moves from `pem` to `p12`, since a bundle may not name one.
`certFormat: null` re-reads the format off `certPath`.

Validation runs on the **merged** row, not on the body, so a `PUT` that moves only `keyPath` still proves the pair works together - and a `PUT` that names `certFormat: "p12"` without clearing `keyPath` is a `400`, because the merged row would be a bundle naming a key file.

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### DELETE /client-certificates/:id

Delete an entry.
**The delete is soft** (#2973): the row is stamped `deleted_at` and [`GET /trash`](trash.md#get-trash) lists it, named by its target, until a purge.
From then on it is **never presented**: the transport policy reads live entries only, so the next design send, stream, collection run or load run to its host goes without it.
Every route here treats the id as missing - `GET /client-certificates` leaves it out, `PUT` and a second `DELETE` are a `404` - and its `host` + `port` is free for a new entry.
The certificate and key files themselves are never touched - the registry only ever held the way to find them.
The stored passphrase stays on the trashed row until it is purged.

Restore it with [`POST /trash/:id/restore`](trash.md#post-trashidrestore), which is a `409` while a live entry claims the same `host` + `port`; destroy it for good with [`DELETE /trash/:id`](trash.md#delete-trashid), which is also what the startup sweep does once `trashRetentionDays` has passed.

**Response:**
```json
{
  "success": true
}
```

**Errors:** `404` if no live entry has that id, a trashed one included.
A storage failure answers `507`, `503` or `500` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

## Transport diagnostics

### POST /diagnostics/connection

Send one request under the transport policy in force and report **which hop answered**.
Proxy, custom CAs and the client-certificate registry all fail at the first real request otherwise, and libcurl's message there names the endpoint rather than the setting - which is how "my API is down" gets filed against a proxy that was never configured correctly.

```json
{ "url": "https://api.example.com/" }
```

The probe is a `HEAD`, with verification **on** (that is the subject of the test), redirects **off** (a redirect would move the test to a host the caller never named and report its proxy and certificate as this one's) and a fixed 10-second deadline.

```json
{
  "url": "https://api.example.com/",
  "outcome": "proxy_failed",
  "errorCode": "PROXY_ERROR",
  "detail": "Received HTTP code 407 from proxy after CONNECT",
  "proxy": { "mode": "manual", "url": "http://corp.example:8080" },
  "clientCertificate": ""
}
```

| Field | Meaning |
|-------|---------|
| `outcome` | `ok`, `proxy_failed`, `tls_failed`, `timed_out` or `failed`. Deliberately coarser than `ErrorCode`: these are the answers that lead a reader to a different setting. `proxy_failed` covers every `PROXY_ERROR`: an unresolvable or down proxy, a refused `CONNECT`, and a forwarding proxy's `407` on an `http://` target. |
| `proxy.mode` | The `proxyMode` in force. Always present. |
| `proxy.url` | The proxy the probe went through, **with its `user:password@` removed** (the body reaches a screen and an agent's context). Absent when the probe went direct. Under `manual`, and `system` with a resolved URL, it is the setting in force, left out when the probe completed without a proxy (a `proxyBypass` entry); a probe that failed still names it, since a failure at the proxy hop may not read as proxied. Under `environment`, and `system` with nothing resolved, it is what libcurl read from `http_proxy` / `https_proxy` / `all_proxy` for the target's scheme - reported only when libcurl really proxied the probe (`CURLINFO_USED_PROXY`), so a `no_proxy` exemption reads as direct. |
| `proxy.source` | `"environment"` when `proxy.url` is not a Vayu setting: libcurl chose the proxy from the process environment. Absent otherwise. With `source` set and no `url`, the probe was proxied but the variable could not be read back. |
| `clientCertificate` | The registry entry that answered for this host, `""` when none did - always so for an `http://` probe, since a certificate is presented in a TLS handshake only (#3260). Always present, like `POST /execute`'s. |
| `status` | The status line. Present only on `ok`. |
| `errorCode` / `detail` | The engine's `ErrorCode` spelling and the message: libcurl's own, or for a forwarding proxy's `407` on an `http://` target (#3257) the engine's sentence naming the proxy. Absent on `ok`. |

**A failed connection is a `200`.**
The test succeeded in answering; only a malformed body or a URL that is not `http`/`https` is a `400`.

**It never returns the response body, headers or redirect chain**, and a test asserts that.
This is a diagnostics surface on the localhost API, not a general fetch proxy - that is `POST /import/fetch`, behind its own byte bound.
