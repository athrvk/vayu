---
description: >-
  The webhook inbox routes: start a local listener, read what it captured and stop it.
---

# Webhook Inbox

An **inbox** is a second HTTP listener the engine opens on request.
It accepts any method on any path, records what arrived, and answers a canned response - nothing else.
That is what makes testing the *receiving* side of a webhook a local operation: point the sender at the inbox URL instead of a cloud tunnel, and the payload never leaves the machine.

**Lifetime is the engine process.**
An inbox is not a stored resource: there is no create/update split ([POST creates, PUT updates](resource-writes.md#resource-writes-create-vs-update) applies to collections, requests and environments), ids are not restorable across restarts, and `POST /inbox/start` is a verb path for that reason.
Stopping an inbox frees its listener but keeps the record - and therefore its captures - readable until the engine exits; `DELETE /inbox/:inboxId` is what removes both.
After an engine restart the app names the inboxes, issuers and mocks that stopped with it in one notice (`app/src/lib/services-stopped-by-restart.ts`).

**Binding is a trust decision.**
The default is `127.0.0.1`.
Any other address is refused unless the caller also sends `"confirmNonLoopback": true`, and the inbox reports `loopback: false` from then on so a client can badge it.
See [architecture.md](../architecture.md#listeners) for why only the inbox listener may bind wide and the management API never may.
An inbox holds at most 96 connections at once: 32 being served (a canned `delayMs` wait occupies one for its whole duration) and 64 waiting for one.
A connection past that is closed at accept, which the sender sees as a reset, so an inbox bound past loopback cannot be held open by idle connections until the engine runs out of file descriptors.
Every other on-demand listener (mock server, mock issuer, OAuth callback) has the same bound.

**Bounds.**
Three are settings (`GET`/`POST /config`, category *Services*), read once when an inbox starts - so a change applies to the next inbox started, and a running listener keeps what it was started with:

| Setting | Default | Range | What it bounds |
|---------|---------|-------|----------------|
| `inboxMaxBodyBytes` | 65536 | 256 - 8388608 | Stored body per capture. Past it the body is kept as a prefix with `bodyTruncated: true`, cut on a character boundary so a prefix of text is still text; `bodyBytes` is always the size as received |
| `inboxMaxCaptures` | 500 | 1 - 10000 | Captures retained per inbox, oldest evicted first. Also the ceiling on one `limit` of the capture list |
| `inboxLivePollIntervalMs` | 250 | 25 - 5000 | How often a watched inbox checks for new captures - the delay between a webhook landing and its event |

Three are **not** settings, deliberately.
A request over **8 MiB** is refused at the transport with a `413` and recorded nowhere: that bounds what an unauthenticated remote caller can make the engine buffer, which is not the local user's preference to spend.
The canned response's **`delayMs` is capped at 30000**: it holds a listener thread for its whole duration.
A stop, a delete or the engine shutting down ends the delay at once, and the canned answer then goes out without the rest of it.
The **request target** - path and query together - is capped at **8192 bytes** by the transport, past which it answers `414`.

The transport also answers `400`, closes the connection and records nothing for a request it cannot read unambiguously (RFC 9112 §3): a request line whose parts are not separated by single spaces, a request target holding a `#`, an HTTP/1.1 request with no `Host`, a request with more than one `Host` or with a byte outside `uri-host [ ":" port ]` in it.
A request carrying both `Transfer-Encoding` and `Content-Length` is captured and answered, and then the connection is closed.
The request line and headers together must arrive within 5 seconds.

Below that cap the path's length does not matter, and "any path" is meant literally: an inbox routes every request to its capture without matching the path against anything, so a signed callback URL, a per-delivery token in the path or a deeply nested tenant route is recorded like any other (issue #1140).

A `multipart/form-data` body (a file upload, `curl -F`) is captured raw, as sent, with its boundaries and parts, and is cut at `inboxMaxBodyBytes` like any other body (issue #3110).
An `application/x-www-form-urlencoded` body is captured the same way up to the 8 MiB transport ceiling rather than refused at 8192 bytes with an empty `413` (issue #3111).
The capture's `Content-Type` header is the sender's.

A **compressed body is stored as sent**.
A sender that declares `Content-Encoding: gzip`, `deflate`, `br` or `zstd` (an OpenTelemetry or Sentry exporter, a log shipper) is captured and answered with the canned response like any other;
the inbox does not decompress, so `body` holds the compressed bytes (base64, as any non-text body is), `bodyBytes` is their compressed size, the cut at `inboxMaxBodyBytes` applies to them, and the capture's `Content-Encoding` header is the sender's.
Only the inbox listener does this: the management API refuses a compressed request body, and an unrecognised coding such as `identity` was always passed through.

**CORS follows the inbox's `allowedOrigins`** (issue #2367), the same policy a mock server applies (see [Mock Server](mock-server.md#mock-server)), so a browser-hosted sender can read the canned response:

- **None listed (the default)**: every answer carries `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: *`, whatever the request's `Origin`, and never `Access-Control-Allow-Credentials` or `Vary`.
  Every page in the browser can read the canned response; none can read one sent with the user's cookies.
- **A list**: a request whose `Origin` is a listed origin gets that `Origin` echoed, `Access-Control-Allow-Credentials: true` and the rest of the answer below.
  Any other request - an unlisted origin, the literal `null` a sandboxed frame or `file://` page sends, no `Origin` at all - is still captured and answered, with no `Access-Control-*` header, so the browser keeps the answer from the page.
  `Vary: Origin` is on every answer under a list.
  Origins are compared canonically: scheme and host case-folded, a default port dropped, so `https://App.Example:443` matches a listed `https://app.example`.

A real preflight (a request carrying `Access-Control-Request-Method`) is answered `204` and never reaches the capture, the canned delay or the canned status - a preflight must get a 2xx or the browser aborts before the real request arrives, so a canned response configured with a non-2xx status (to exercise a sender's retry path) would otherwise break every browser-hosted sender silently.
It carries the grant above (and `Access-Control-Allow-Methods` / `-Allow-Headers` echoing what was asked, `Access-Control-Max-Age: 600`), or under a list for an unlisted origin no CORS header at all.
A header the canned response sets that names `Access-Control-*` or `Vary` is dropped rather than echoed, since the engine already answered those and a replayed grant would undo a refusal;
a credentialed answer (a listed origin) rewrites the wildcard `Access-Control-Expose-Headers` into the canned response's own header names, per the Fetch spec's rule that `*` there is a literal name, not a wildcard, under credentials.

## POST /inbox/start

Start a listener.
Every field is optional - an empty body starts a loopback inbox on a free port that answers `200` with no body.

**Request:**
```json
{
  "port": 0,
  "bind": "127.0.0.1",
  "confirmNonLoopback": false,
  "allowedOrigins": [],
  "response": {
    "status": 200,
    "body": "",
    "headers": {},
    "delayMs": 0
  }
}
```

| Field | Meaning |
|-------|---------|
| `port` | `0` (default) picks a free port |
| `bind` | Default `127.0.0.1`; anything outside 127.0.0.0/8 and `::1` needs `confirmNonLoopback`. Loopback is decided by parsing the *address*, so a hostname that merely starts `127.` (or `localhost.example.com`) is not loopback and needs the confirmation. `0.0.0.0`, `::` and `[::]` bind every interface; the response then names where to send (`reachableAt`, below) |
| `response.status` | 100-599 |
| `response.headers` | String values only; a `Content-Type` here is used verbatim |
| `response.delayMs` | 0-30000, applied before every reply |
| `allowedOrigins` | Default `[]` (CORS `*`, no credentials). Up to 32 origins granted credentialed CORS, each `http://` or `https://` plus a host and an optional port, at most 512 bytes: no path (a trailing `/` included), query, fragment, user name or password, no `*` and not `null`. Stored and echoed canonical (scheme and host lowercased, a default port dropped); fixed for the inbox's life, `PUT` does not change it |

An out-of-range value is a `400` naming the field rather than a fallback to the default: a listener quietly answering something other than what it was asked to is invisible on both sides of the wire.
A bind that fails is a `409` with code `inbox_bind_failed`; a non-loopback bind without confirmation is a `400` with code `inbox_non_loopback_bind`.
An `allowedOrigins` that is not an array, holds too many entries, or holds one that is not an origin is a `400` `bad_request` naming the entry (`allowedOrigins[1]`) and what is wrong with it.

A `port` another engine listener is already running on - an inbox or a mock issuer - is refused with that same `409`, naming the holder ("`inbox inbox_2f1c` is already listening there").
The engine checks that itself rather than letting the bind report it: listeners are bound with `SO_REUSEPORT`, so on Linux a second bind on the same address and port *succeeds* and the kernel then splits arriving connections between the two listeners, each capturing an effectively random half.
A port held by a process outside the engine is still reported by the bind (`Couldn't bind <address> - the address may be in use or unavailable`); `port: 0` is never refused this way, since the kernel does not hand out a port it is already using.

**Response:**
```json
{
  "inboxId": "inbox_2f1c...",
  "url": "http://127.0.0.1:41235/",
  "bind": "127.0.0.1",
  "port": 41235,
  "running": true,
  "loopback": true,
  "captureCount": 0,
  "allowedOrigins": [],
  "response": { "status": 200, "body": "", "headers": {}, "delayMs": 0 }
}
```

`captureCount` is how many captures the inbox is holding right now - what a `DELETE /inbox/:inboxId` would destroy with it.
Every route that returns an inbox fills it, so a client can word a confirmation without a second round trip.

`url` is where a sender sends, which is the bind address unless the inbox is bound to every address (`0.0.0.0`, `::` or `[::]`, each needing `confirmNonLoopback`): that is no address a sender can use, so `url` is the first non-loopback IPv4 address of the machine, and `reachableAt` lists a URL for every one (the machine has several; `url` is only the first the OS names):

```json
{
  "url": "http://192.168.1.20:41235/",
  "bind": "0.0.0.0",
  "reachableAt": ["http://192.168.1.20:41235/", "http://10.0.0.7:41235/"]
}
```

`reachableAt` is on the wire for a wildcard bind only, and lists IPv4 addresses only.
A machine with no non-loopback IPv4 address reports `reachableAt: []` and a `url` on `127.0.0.1`.
It is read from the interfaces each time the inbox is read, not fixed at start, so it follows a change of network.

## GET /inbox

Every inbox this process has started, running or stopped: `{"data": [ ... ]}`, each entry the object above.

## PUT /inbox/:inboxId

Update the canned response, live - the next caller receives the new one, with no restart and no captures lost.
Merge-patch: an absent field keeps what the inbox is serving.
The body may be the response object itself or `{"response": {...}}`, so a client can send back what `start` handed it.
`404` for an unknown id.

**Atomic against a concurrent update**, the same guarantee the resource `PUT`s above give (issue #1454): the read, the merge and the write are one acquisition of the inbox's own lock, not the database's - the canned response lives in memory - so two clients patching one inbox at the same moment each merge onto what the other just committed rather than onto the response as both of them found it.

## POST /inbox/:inboxId/stop

Stop the listener.
Returns the inbox with `running: false`.
Captures survive; `404` for an unknown id.
A stop is not a delete - `DELETE /inbox/:inboxId` is.

## DELETE /inbox/:inboxId

Stop the listener, drop the record, and delete its captures with it: `{"inboxId": "...", "capturesDeleted": 12}`.
`404` for an unknown id.

**A running inbox is stopped rather than refused** - one call, because the caller's intent is that the inbox be gone.
That is safe rather than racy because the teardown joins every in-flight handler before returning, so nothing can still be capturing when the rows are cleared.
The order is stop, then clear, then drop the record: a database failure therefore leaves the inbox in place - stopped, and deletable again - rather than orphaning captures no inbox could list.

The captures dying *with* the record is the point, and is why `stop` keeps them: they go by explicit user intent here, instead of the record living to the end of the process to protect them.
**There is deliberately no restart route**: delete and start a new inbox.
A restart would have to decide what happens to the existing captures, and this way the user decides.

## GET /inbox/:inboxId/requests

The captures, **newest first**, in the standard `{data, pagination}` envelope.

**Query parameters:** `limit` (default 50, capped at 500), `offset` (default 0).

```json
{
  "data": [
    {
      "id": 12,
      "inboxId": "inbox_2f1c...",
      "receivedAt": 1767225600000,
      "method": "POST",
      "path": "/hooks/order",
      "query": "attempt=2",
      "headers": { "Content-Type": "application/json" },
      "body": "{\"id\":7}",
      "bodyEncoding": "utf8",
      "bodyBytes": 8,
      "bodyTruncated": false,
      "remoteAddr": "127.0.0.1"
    }
  ],
  "pagination": { "total": 1, "limit": 50, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`id` is the capture's storage id and also its SSE event id (see below).
`headers` joins a repeated name with `, `.
`query` is the raw query string without the `?`.

**`bodyEncoding` says how to read `body`** (issue #3109).
A JSON string holds only UTF-8 and a sender can post any bytes, so `"utf8"` means `body` is the stored text itself, and `"base64"` means the stored bytes were not valid UTF-8 text (or held a NUL) and `body` is their standard, padded base64.
It is decided when the capture is read, so every capture carries it, and `bodyBytes` is the size as received in both cases, never the length of the encoded string.
A body the byte cap cut is first trimmed back to a character boundary, so a cut inside a multi-byte character leaves `utf8` text rather than turning the whole prefix into `base64`; `bodyTruncated` still says it was cut.
`path` and `query` are recorded raw, exactly as the sender spelled them: percent-escapes such as `%2F` and `%20` are kept, so a signature over the path or a copied capture URL still matches the request received.
Neither is classified: a byte in either that is not UTF-8 is answered as U+FFFD.

## GET /inbox/:inboxId/requests/:captureId

One capture of an inbox by its `id`, without paging the list to find it.
The answer is the bare object a [list](#get-inboxinboxidrequests) `data[]` entry carries, `bodyEncoding` included and with no envelope; both are built by the same function, so the two cannot disagree.
Reads only.

`captureId` is digits only; anything else matches no route.
A **404** answers an unknown inbox (`Inbox not found`) and a capture that is not in that inbox (`Capture not found`): an id that belongs to another inbox, one the ring bound has since evicted, `0`, and one too large for the table to have assigned are all the same answer.

**Response:**
```json
{
  "id": 12,
  "inboxId": "inbox_2f1c...",
  "receivedAt": 1767225600000,
  "method": "POST",
  "path": "/hooks/order",
  "query": "attempt=2",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"id\":7}",
  "bodyEncoding": "utf8",
  "bodyBytes": 8,
  "bodyTruncated": false,
  "remoteAddr": "127.0.0.1"
}
```

## DELETE /inbox/:inboxId/requests

Clear the captures, keeping the listener: `{"inboxId": "...", "cleared": 12}`.

## GET /inbox/:inboxId/live

Server-Sent Events, one event per capture, each carrying the same object as the list above (`bodyEncoding` included) and an SSE `id:` equal to the capture's `id`.
A reconnect that sends `Last-Event-ID` resumes after that capture, so nothing is missed across a drop.
The stream ends when the inbox is stopped.

**`?lastEventId=<id>` is the same resume point as a query parameter**, for a client that reconnects by hand: browser `EventSource` sets `Last-Event-ID` only on its *own* retry and exposes no way to set a header on a fresh connection.
The header wins when both are given, being the more recent of the two.
A value that is not a non-negative capture id is refused with `400` and code `invalid_last_event_id` rather than resumed from the start, which would replay every retained capture as though it had just arrived.

**One stream per inbox.**
A second concurrent watcher is refused with `409` and code `inbox_live_in_use`: each SSE handler occupies a cpp-httplib pool thread for its whole life, so N watchers on one inbox is N parked threads.

**A claim whose holder stopped writing is taken over, not refused.**
A stream learns its socket died only when its next write fails, up to one `inboxLivePollIntervalMs` later, so a client reconnecting inside that window used to meet a `409` it could not recover from.
A holder that has not written successfully for two poll intervals (at least 100ms) is not writing, and its slot goes to the newcomer; the evicted stream ends on its next write.
Every live stream writes at least a keep-alive each interval, so a genuinely live watcher is never evicted and a second concurrent one is still refused.
