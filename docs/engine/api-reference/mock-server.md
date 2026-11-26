---
description: >-
  The mock-server routes: serve a collection's saved examples on a local port and read its routes and activity.
---

# Mock Server

A **mock server** is a listener that answers a collection's [saved examples](examples.md#request-examples) on the paths its requests describe.
It is what examples are *for*: import a spec, and the responses it documented become a running upstream you can build a frontend against, or point a Vayu load run at, without a cloud plan or a second machine.

**A mock serves the stored body verbatim, including a partial one.**
An example whose `bodyTruncated` is true holds only the first slice of the response it was captured from, and the mock answers with those bytes and the recorded headers as though they were a whole response - nothing on the wire says otherwise, and the flag deliberately does not change what is served.
It is disclosure, not behaviour: the app paints a "Partial body" chip on the row so the choice to serve it is a made one (issue #659).

**A `204` or `304` example is served with no body, no `Content-Length` and no `Content-Type`** (RFC 9110 §6.4.1), whatever its stored body says; the rest of its headers are kept.
The same holds for a `1xx` example stored before create began refusing them (#3117).
A real preflight's synthesized `204` carries no `Content-Length` either.

**Example bodies are served literally.**
A `{{variable}}` or a dynamic value such as `{{$guid}}` in a stored body or header is sent as those characters: the mock resolves no variables, unlike Postman's mock servers, which a collection moving from Postman may expect.
Resolving them would be a feature, not a docs fix.

**Lifetime is the engine process**, exactly as for an inbox and an issuer - a verb path starts it, ids are not restorable across restarts, and stopping one **drops its record**.
There is no stopped state to read: a mock holds nothing that outlives its listener, unlike an inbox and its captures.
Trashing the collection a mock serves, or any collection above it, stops the mock the same way ([`DELETE /collections/:id`](collections.md#delete-collectionsid)), and a restore does not start it again.
A mock an engine restart stopped is named in the app's restart notice, as an inbox is.

**Load-testing against a mock is a supported workflow**, and it is the one this listener exists for as much as frontend development: a mock is a known-latency, zero-cost upstream on the same machine, so a run against it measures the *generator* rather than someone else's service, and costs nobody a bill.
Start the mock, then point a run at one of its paths:

```bash
curl -s localhost:9876/mock/start -d '{"collectionId":"col_abc123","latencyMs":5}'
# -> {"mockId":"mock_5f2a","url":"http://127.0.0.1:43117", ...}

curl -s localhost:9876/runs -d '{
  "mode":"constant_rps","targetRps":500,"duration":"30s",
  "url":"http://127.0.0.1:43117/pets","method":"GET"
}'
```

`latencyMs` is what makes the baseline realistic rather than degenerate, and `errorRatePct` is how a run's error handling and [threshold verdict](load-runs.md#post-runs) get exercised without breaking a real service.

**Loopback only.**
There is no `bind` field.
Unlike an inbox - which serves capture-and-echo and nothing else, so a LAN-visible one is defensible - a mock re-serves stored response bodies verbatim, and a recorded response can carry whatever the real one did.
See [architecture.md](../architecture.md#listeners).

**The route table is a start-time snapshot.**
It is built once, from the collection and every collection under it (an OpenAPI import files its requests in a folder per tag, so the subtree is the only useful unit), and a running mock does not reload edits: stop it and start it again.
An example saved from the app's response viewer (issue #588) is an edit like any other - it is appended after the request's existing examples, so a restart keeps answering with the same first one, and the new row is only reachable once the mock is restarted.

**How a request is matched.**

- The stored URL is reduced to a path: scheme and host - or the `{{baseUrl}}` variable standing in for them - the query and the fragment are all dropped.
  A leading variable goes whole and is never resolved, so a path carried inside its *value* is lost: with `baseUrl` set to `https://x/v1`, a request stored as `{{baseUrl}}/pets` is mocked at `/pets`, not `/v1/pets`, and a caller that keeps `/v1` in its URL matches no route.
  Put the prefix in the stored URL (`{{baseUrl}}/v1/pets`) to have the mock serve it.
- All three template spellings are one wildcard segment: `{{petId}}` (Vayu and Postman), `{petId}` (OpenAPI) and `:petId` (Postman's other form).
  A wildcard matches exactly one non-empty segment.
  The normalization is pinned to the importers' own by `engine/tests/fixtures/path-template-conformance.json`, which both suites read - the app writes these URLs and the mock reads them back.
- **Specificity wins, not registration order**: `/pets/mine` answers `GET /pets/mine` even when `/pets/{{petId}}` was stored first.
- A trailing slash and a repeated `/` are the same route.
- **Requests that share a method and path are one route** (#3115).
  The query is dropped, so `GET /q?kind=a` and `GET /q?kind=b` (a Postman collection's "login ok" and "login fail") cannot be told apart: one of them answers both and the other shows `0` hits for good.
  Among routes of equal specificity the first **that has a saved example** answers, else the first in sidebar order, so an example-less request listed above one with an example no longer turns the path into a `501`.
  Two routes are duplicates only when they have the same method, the same number of segments and the same literals in the same positions (a wildcard's name does not count): `/a/{{x}}/b` and `/a/b/{{y}}` are equally specific but answer different paths, so neither is shadowed.
  The start response counts the shadowed requests (`duplicateRoutes`) and `GET /mock/:mockId/routes` marks each one and names the request that answers in its place.
- **A `HEAD` is answered by the `GET` route of that path** (#3118) when no `HEAD` request is stored for it: the GET's status and headers (its `Content-Length` included) and no body, so `curl -I` on a mocked path works.
  A stored `HEAD` request still wins.

**What a miss says.**
The message is most of the debugging value, so the three outcomes are distinct rather than one blanket 404:

| Case | Status | `code` | Message names |
|------|--------|--------|---------------|
| No request has that path | 404 | `mock_no_route` | The method and path, and how many routes are served |
| The path matches, the method does not | 404 | `mock_method_mismatch` | The matching path template and the methods it *is* served for |
| A route matched but its request has no saved example | 501 | `mock_no_example` | The request's name, and that an example must be saved or imported |

**CORS follows the mock's `allowedOrigins`** (issue #2367).
A mock server answers whatever calls it - most often a browser page on another origin, not only curl - and what it answers with is often a recorded response, so which pages may read it is the caller's to state:

- **None listed (the default)**: every response carries `Access-Control-Allow-Origin: *`, whatever the request's `Origin`, plus `Access-Control-Expose-Headers: *` so a page's `fetch` can read a header the example set, and never `Access-Control-Allow-Credentials` or `Vary`.
  Every page in the browser can read the mock; none can read a response sent with the user's cookies.
- **A list**: a request whose `Origin` is a listed origin gets that `Origin` echoed with `Access-Control-Allow-Credentials: true`, and `Access-Control-Expose-Headers` names the example's own headers, since the Fetch spec reads `*` there as a literal name, not a wildcard, once credentials are in play.
  Any other request - an unlisted origin, the literal `null` a sandboxed frame or `file://` page sends, no `Origin` at all - is still served, with no `Access-Control-*` header, so the browser keeps the response from the page.
  `Vary: Origin` is on every response under a list.
  Origins are compared canonically: scheme and host case-folded, a default port dropped, so `https://App.Example:443` matches a listed `https://app.example`.
  A list also pins the **`Host`**: the mock answers `403` to any request, a preflight included, whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` of its own port (the management API's rule), so a page that DNS rebinding has made same-origin with the mock cannot read it.
  A mock with no list answers any `Host`.

A header the example itself carries under `Access-Control-*` or `Vary` is dropped rather than echoed, since the engine already answered those and a replayed grant would undo a refusal.
The grant applies to a miss too - a 404 with no CORS headers reads in a browser as an opaque "CORS error" instead of the `mock_no_route` / `mock_method_mismatch` / `mock_no_example` body above.

A **real preflight** - a request carrying `Access-Control-Request-Method` - is always answered synthetically (`204`, with the grant above plus `Access-Control-Allow-Methods` / `-Allow-Headers` echoing what the browser asked for and `Access-Control-Max-Age: 600`, or under a list for an unlisted origin no CORS header at all), whether or not a route is stored for that path under `OPTIONS`:
breaking the preflight to surface a stored route's `404`/`501` would break the browser request behind it for nothing.
It does not count toward a route's `hits` or appear in `GET /mock/:mockId/activity`.
A plain `OPTIONS` request carrying neither header is ordinary traffic and is served or missed like any other verb.

**Bounds** (rails, not settings): at most **8** mock servers at once (a listener thread each), at most **2000** routes in one table, and `latencyMs` capped at **30000** - it holds a listener thread for its whole duration, until a stop ends it.

## POST /mock/start

**Request:**
```json
{
  "collectionId": "col_abc123",
  "port": 0,
  "latencyMs": 0,
  "errorRatePct": 0,
  "allowedOrigins": []
}
```

`collectionId` is required.
`port` 0 (the default) binds a free one.
`latencyMs` (0 - 30000) delays every answer; `errorRatePct` (0 - 100) replaces that share of answers with a synthesized `500` carrying `mock_injected_error`.
`allowedOrigins` (default `[]`) lists up to 32 origins granted credentialed CORS (see above), each `http://` or `https://` plus a host and an optional port, at most 512 bytes: no path (a trailing `/` included), query, fragment, user name or password, no `*` and not `null`.
It is stored and echoed canonical (scheme and host lowercased, a default port dropped).
Every out-of-range value is a `400` rather than a clamp, and an `allowedOrigins` entry that is not an origin is a `400` `bad_request` naming the entry (`allowedOrigins[1]`) and what is wrong with it.

**Response:**
```json
{
  "mockId": "mock_5f2a",
  "collectionId": "col_abc123",
  "collectionName": "Pet Store",
  "url": "http://127.0.0.1:43117",
  "port": 43117,
  "latencyMs": 0,
  "errorRatePct": 0,
  "routeCount": 12,
  "routesWithoutExample": 3,
  "duplicateRoutes": 0,
  "createdAt": 1735689600000,
  "allowedOrigins": []
}
```

`url` has **no trailing slash** - it is a base to concatenate a path onto.
`routesWithoutExample` is the number that explains an otherwise empty-looking mock, which is why it is reported rather than left to be discovered one `501` at a time.
`duplicateRoutes` is the number of requests shadowed by another with the same method and path (see above): rows that can never answer, whatever their query says.
It is `0` for a collection with none.

**Errors:** `404` for a collection that does not exist; `400` `mock_no_requests` when the collection and its subtree hold none (a listener that 404s everything is never what the caller meant);
`400` `mock_too_many_routes` past the table bound; `409` `mock_limit_reached` at the server budget; `409` `mock_bind_failed` when the requested port is taken, naming the holder when this engine is the one holding it.

## GET /mock

`{"data": [...]}` - every running mock, in the shape above.

## GET /mock/:mockId/routes

The table the mock is serving.
This is how "the mock 404s that path" gets diagnosed without sending a request per guess.

```json
{
  "data": [
    {
      "requestId": "req_1",
      "requestName": "Get pet",
      "method": "GET",
      "path": "/pets/{{petId}}",
      "hasExample": true,
      "mode": "first",
      "hits": 3,
      "status": 200,
      "exampleName": "200 OK"
    }
  ]
}
```

`status` is `0` when `hasExample` is false - there is no example whose status it could be.
`mode` is the request's `mock_response_mode` (`"first"` / `"fixed"` / `"random"`); `hits` is how many times this route has answered a request, since the mock started.
`exampleName` is the example that would answer for `"first"` or `"fixed"` - it is absent for `"random"`, since which one answers varies per request.
`404` for an unknown mock.

A request that shares its method and path with another (see "How a request is matched") is shadowed: its row carries `"shadowed": true` and `"shadowedBy": {"requestId": "req_2", "requestName": "login ok"}`, naming the request that answers for both.
Both members are **absent** - not `false` - on every row that is not shadowed, including the one that answers.
A shadowed row keeps `hits: 0`, and its `hasExample` / `status` describe its own examples, which are never served.

## GET /mock/:mockId/activity

What this mock has served, newest first: `{"data": [...]}`, at most `limit` entries (query param, default **50**, capped at **200**; a non-numeric value is a `400`).
Each entry is one inbound request, whichever of the three ways it was handled:

```json
{
  "data": [
    {
      "at": 1735689600123,
      "method": "GET",
      "path": "/pets/1",
      "requestId": "req_1",
      "requestName": "Get pet",
      "exampleId": "ex_1",
      "exampleName": "200 OK",
      "status": 200,
      "injectedError": false
    }
  ]
}
```

`requestId` / `requestName` are `null` when nothing in the route table matched the path at all, and also for an injected failure (`injectedError: true`): the error-rate roll happens before route resolution, so an injected 500 never reaches route matching, even when a route would have matched.
`exampleId` / `exampleName` are `null` alongside them, and also when the matched route had no saved example (`status: 501`).
`injectedError: true` marks a synthesized `errorRatePct` failure.
`404` for an unknown mock.
Like the route table, this log is discarded when the mock stops - there is nothing to read after that.

## POST /mock/:mockId/stop

Stops the listener and drops the record: `{"mockId": "...", "stopped": true}`, or `404`.
In-flight answers are joined before this returns; one inside its configured `latencyMs` is answered at once, without the rest of the delay.
