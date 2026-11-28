---
description: >-
  `pm.response`: status and code, the events of a streamed run, an mcp reply's failure class and the redirects a send followed.
---

# Response Object (`pm.response`)

Access HTTP response data:

```javascript
pm.response.code              // Status code (number, e.g., 200)
pm.response.status            // Reason phrase (string, e.g., 'OK') - see below
pm.response.responseTime      // Perceived latency in ms (submit → completion).
                              // In load tests this includes generator-side
                              // queue wait. For pure server wire time, use
                              // responseTimeWire.
pm.response.responseTimeWire  // CURLINFO_TOTAL_TIME less any wait for a
                              // connection slot, in ms - DNS + TCP + TLS +
                              // send + recv. Matches the pre-v0.3 meaning of
                              // responseTime; use this to assert on server SLAs
                              // independent of generator load.
pm.response.responseTimeQueueWait // Wait before the wire in ms - generator
                              // queue plus libcurl's wait for a connection
                              // slot - i.e. responseTime − responseTimeWire
                              // (clamped to >= 0). ~0 for single-shot sends.
pm.response.headers           // Plain object, lower-cased keys, with
                              // case-insensitive get()/has() over it - see below
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid). Takes no
                              // reviver: an argument is ignored, and a Postman
                              // import names a call that passes one
pm.response.reason()          // Status reason phrase ('OK', 'Not Found')
pm.response.size()            // { body, header, total } in bytes
pm.response.responseSize      // The body's bytes: size().body
pm.response.cookies           // Set-Cookie, parsed - see below
                              // (the stored session is pm.cookies)
pm.response.errorCode         // string | undefined - TIMEOUT, DNS_ERROR, ...
pm.response.errorMessage      // string | undefined - the same failure in words
pm.response.redirects         // The 3xx hops followed to get here (Vayu only) -
                              // see pm.response.redirects below
```

`errorCode` and `errorMessage` are present **only when the send failed before a response arrived**, so `if (pm.response.errorCode)` is the test for a transport failure - the status code in that case is vayu's synthetic `0`.
A response that reached the script from a server carries neither.

`reason()` reports the reason phrase from the status line.
Where none was received it falls back to the canonical text for the code, so a client-side failure - vayu's synthetic status `0` - reads `"Error"` rather than an empty string.
(Postman returns `null` in that case; vayu always returns a string.)

## `status` is the reason phrase, `code` is the number

Postman spells the two apart: `code` is the number and `status` is the phrase the status line carried.
Spelling both as the number would make a lifted `if (res.status === 'OK')` guard always false and `pm.expect(pm.response.status).to.eql('OK')` fail where Postman passes.
`status` is the phrase - the same string `reason()` answers, wire phrase where there was one and the registered text for the code where there was not - on **both** objects that carry a status: the response a post-request script reads, and the one a [`pm.sendRequest`](send-request.md#sending-a-request-from-a-script-pmsendrequest) callback receives.
`code` is untouched on both.

That is a break for a script written against vayu's old spelling:

| Was | Reads now | Use instead |
|---|---|---|
| `pm.response.status` | `"OK"`, not `200` | `pm.response.code` |
| `pm.expect(pm.response.status).to.equal(200)` | fails - the phrase is not the code | `pm.expect(pm.response.code).to.equal(200)` |
| `if (pm.response.status >= 400)` | **never taken** - a phrase compares false against a number | `if (pm.response.code >= 400)` |
| `res.status` in a `pm.sendRequest` callback | the phrase | `res.code` |

The first two rows fail loudly: the comparison is always false, so the test that made it goes red and names itself.
**The third does not.**
A guard comparing `status` against a number is not an assertion, and JavaScript answers `false` for it rather than throwing, so the branch simply stops being entered and nothing reports that it stopped.
Search a ported script for arithmetic on `status` before trusting a green run.

`pm.response.to.have.status(...)` needs no migration - it has taken either form since it learned the reason phrase, and decides by the argument's type.

`size()` counts the body the script can read through `text()`, so `size().body === pm.response.text().length` for an ASCII body.
`size().header` is the serialised header block - `Name: Value\r\n` per header - reconstructed from the parsed headers, so it is close to but not byte-exact with what came off the wire.
An empty body reports `0`, not an absent property.

## `pm.response.events` - a streamed run's events

A request sent with the **Event stream** setting on (`"stream": true` on `POST /execute`) keeps the bytes the server delivered as its body, whatever their type, up to `maxDesignResponseBodyBytes` (issues #3238, #3770):
for a `text/event-stream` reply `pm.response.text()` is the stream's `event:`/`data:` bytes, as it is on a collection or load run, and a JSON error or NDJSON reply reads through `text()` and `json()` as on a buffered send.
Beside the bytes it has a list of events, parsed from those same bytes.
The post-request script runs **once, after the stream has terminated**, and reads the event list:

```javascript
const events = pm.response.events || [];

pm.test('the server said it was done', function () {
    pm.expect(events.some(function (e) { return e.event === 'done'; })).to.be.true;
});

pm.test('every token frame parsed', function () {
    events.forEach(function (e) {
        if (e.event === 'token') pm.expect(JSON.parse(e.data).text).to.be.a('string');
    });
});
```

Each entry is `{ event, id, data, receivedAt }`:

| Field | |
|-------|--|
| `event` | The frame's `event:` name, or `"message"` where it carried none - the SSE spec's default, resolved by the parser so no script has to. |
| `id` | The origin's `id:`, **absent** when it sent none. Not the relay's own frame id, which is a different number and would make a comparison silently wrong. |
| `data` | The `data:` payload as a string, multi-line frames joined with `\n`. `JSON.parse` it yourself - the wire says nothing about what it holds. |
| `dataTruncated` | `true` only when that one event hit `sseMaxEventBytes` and `data` is a prefix. Absent otherwise. |
| `isError` | `true` only when the engine judged the event a reported failure ([the rule](../api-reference/execute.md#post-execute)). Absent otherwise. |
| `text` | What the request's `streamTextPath` read off this event (issue #3773). [Details](#the-text-of-an-event-in-full) |
| `receivedAt` | When the engine received the event, in milliseconds since the Unix epoch (the clock `Date.now()` reads)... [Details](#the-receivedat-of-an-event-in-full) |

**`pm.response.streamText` is the reply, assembled.**
A stream whose request declares a `streamTextPath` (a JSONPath such as `$.choices[0].delta.content` for an OpenAI-compatible chat completion or `$.delta.text` for an Anthropic-style one, see [`POST /execute`](../api-reference/execute.md#post-execute)) gets every event's `text` joined in order, the events the path missed skipped (a role-only chunk, a ping, the `[DONE]` sentinel).
It covers every event the body kept, past `sseMaxStoredEvents` too, so it is the whole reply unless the body itself was cut at `maxDesignResponseBodyBytes`.
It is a string whenever a path was declared, `""` when the path read nothing, and **absent** without one:

```javascript
pm.test('the model answered in French', function () {
    pm.expect(pm.response.streamText || '').to.include('Bonjour');
});
```

Every run that streams reads the same: a collection run's streaming step through its saved request's `streamTextPath`, a single-request load run through the one its payload carries (a by-id compose fills it from the saved request), inline and in the deferred replay alike.

**Buffered, never live.**
The script runs once the stream is over, and runs to completion - its timers and promise jobs included, see [Timers](sandbox.md#timers-settimeout-and-setinterval) - before anything is reported, so a per-event callback is not a feature that was left out: there is no moment while the stream arrives for one to run in.
The script runs against what was retained.

**Check the markers before asserting over the whole stream.**
The stored list is bounded by `sseMaxStoredEvents`, and by the bytes the body kept (a stream past `maxDesignResponseBodyBytes` is a prefix), and a script that counted a prefix would report a wrong number with total confidence:

```javascript
if (!pm.response.eventsTruncated) {
    pm.test('exactly three events', function () {
        pm.expect((pm.response.events || []).length).to.equal(3);
    });
}
pm.test('the stream produced something', function () {
    pm.expect(pm.response.totalEvents || 0).to.be.above(0);
});
```

`pm.response.totalEvents` is every event the run received, including those beyond the stored list; `pm.response.eventsTruncated` is the engine's own comparison of the two, not something derived from a cap the script cannot see.
Both mirror the markers on the run's stored trace, because the script's list and the one a restored response reads are parsed from the same bytes by the same rule (issue #3770).

**Absent, not empty, on an ordinary response.**
All three properties are missing unless the run was a stream, so `typeof` separates "this was not a stream" from "this stream produced nothing" - a distinction an empty array would erase:

```javascript
if (typeof pm.response.events === 'undefined') {
    console.log('not a streaming request');
}
```

**Every run that streams reads the same list.**
A post-request script sees `pm.response.events`, `pm.response.totalEvents` and `pm.response.eventsTruncated` wherever the response it runs against was a stream, so a script written for a design Send behaves the same in each of these:

- a **collection run's** streaming step (a stored request with `stream` set, issue #3235), sequential or under load;
- a **load run's** post-request script, whether it runs **inline** (marked `inline`, or the run's Scripts = All inline override) on a single-request run with `"stream": true` or on a collection load run's streaming step (issue #3769), or **deferred**, replayed after the run against its sampled responses (0.17.2).

On every path the list is parsed back out of the response's body, bounded by the same `sseMaxStoredEvents`, and `totalEvents` is the count taken on the wire, so it stays truthful even where the body was cut.
Two differences follow from where those responses come from, and both are visible rather than assumed:

- Only a design Send watched its events arrive, so only its entries carry a `receivedAt` (milliseconds since the epoch) on the stored trace a History entry restores.
- There is no `endReason` on these paths.
  A buffered stream ends by server close or by one of the two caps, and nothing per response records which - the run report's `stream.capped` carries that fact for the run as a whole.

A response that did not stream still reads `undefined`, so the `typeof` check above is the one guard on every path.

### The `text` of an event in full

**Absent** when no path was declared, when the path matched nothing, `null`, an array or an object, when `data` is not JSON, and when the event was cut (`dataTruncated`).

### The `receivedAt` of an event in full

...so `events[0].receivedAt` against the send time is the time to first event.
A **number on a design Send**, **absent** wherever the list is parsed back out of a buffered body - a load run's inline or deferred script, where it is not measured.

## `pm.response.mcp` - an mcp reply's failure class

A request whose body mode is `mcp` is answered with one JSON object or with an event stream ending in the final JSON-RPC response ([the `mcp` reply](../api-reference/request-body.md#the-mcp-reply)).
A script reads that reply **as it arrived**, on every path: `pm.response.json()` and `text()` are the body exactly as for any other request (the JSON object, or for an event stream its `event:`/`data:` bytes, on a streamed send as on a buffered one), and the frames themselves are `pm.response.events`.
It is the declarative elements, not scripts, that read the final response in place of the body.
What a script adds is the engine's judgement of the reply:

```javascript
pm.test('the tool call succeeded', function () {
    pm.expect(pm.response.mcp.errorClass).to.be.undefined;
});
```

`pm.response.mcp` is `{}` when the call succeeded and `{ errorClass, code, message }` when it failed: `errorClass` is `transport`, `protocol` or `tool`, `code` the JSON-RPC `error.code` (absent when the reply carried none) and `message` the sentence the failed `MCP reply` test carries.
It is absent for every other body mode, so `typeof pm.response.mcp` tells an `mcp` request apart.
A load run's deferred replay reads it off the sample's stored bytes by the same rule.

A streaming send is answered `202` before its script has run, so the results go to the run's trace rather than into a response body - the app's Tests and Console panes show them when the stream finishes, and [`GET /runs/:runId/report`](../api-reference/runs.md#get-runsrunidreport) carries them under the trace's `scripts` node.
A buffered send returns them *and* stores the same object there (issue #725), so reopening either kind of run from History shows the assertions it made.

A **collection run's step** is the same story with no live half at all: the run was answered `202` when it started, so each step's results reach the app only on its stored trace, under the same `scripts` node (issue #724).
What a step publishes while the run is still going is the count - `tests: {passed, failed}` on its [`step` event](../api-reference/live-metrics.md#get-runsrunidlive) - because the event ring is fixed-size and a script may make hundreds of assertions.
Both count **both scripts'** assertions (issue #810), which is what fails the step in the first place: a failing `pm.test` ends a step whichever script made it, and a list of the test script's alone would let a step be `failed` and named in its error line by an assertion its own Tests list did not contain.

## `pm.response.redirects` - the hops a send followed

Vayu-specific: Postman scripts have no view of the redirects a request went through, so nothing here is portable to or from Postman.
`pm.response` is the **last** response of a followed chain - its headers, cookies and body are the final hop's alone - and `redirects` is the rest of the chain, in the order the engine followed it:

```javascript
pm.test('no hop left https for http', function () {
    const downgraded = (pm.response.redirects || []).filter(function (hop) {
        return hop.schemeDowngrade;
    });
    pm.expect(downgraded).to.be.empty;
});

pm.test('the login redirect set the session', function () {
    const first = pm.response.redirects[0];
    pm.expect(first.code).to.equal(302);
    pm.expect(first.headers.get('Set-Cookie')).to.include('session=');
});
```

Each entry is `{ code, status, url, schemeDowngrade, headers }`:

| Field | |
|-------|--|
| `code` | The hop's status, a number (`301`, `302`, ...). Named as `pm.response.code` is. |
| `status` | The hop's reason phrase, as `pm.response.status` is - the wire phrase, or the registered text for the code on HTTP/2 and later. |
| `url` | The URL of the request **this hop answered**, so `redirects[0].url` is the URL that was requested... [Details](#the-url-of-a-redirect-hop-in-full) |
| `schemeDowngrade` | `true` when this hop's request went over `https` and the next one over `http`. [Details](#the-schemedowngrade-of-a-redirect-hop-in-full) |
| `headers` | The hop's own received headers, shaped as `pm.response.headers` is... [Details](#the-headers-of-a-redirect-hop-in-full) |

**Empty means none, absent means not recorded.**
A send that was not redirected, or that ran with *Follow redirects* off, reads `[]` - the engine looked and saw no hop.
The property is **missing** where the engine follows redirects without keeping the chain: a load run's deferred `tests` script and a streamed request's script.
`typeof pm.response.redirects === 'undefined'` is the guard there, so an assertion that the length is `0` cannot pass over a chain nobody recorded.
A chain that ends in `too_many_redirects` still lists the hops it made, at most the request's `maxRedirects`.

The same facts are on the run's stored trace as `response.redirects[]`, with `status`/`statusText` and `headerLines` in place of the script's `code`/`status`/`headers`, and with `<redacted>` where the script's `url` reads blank.

### The `url` of a redirect hop in full

...and the next entry's is where the first one's `Location` pointed (resolved, when it was relative).
The value of the request's auth query parameter, and of any credential-named one, is **blank** (`?client_secret=&page=2`).
The stored trace's `response.redirects[].url` and the `/execute` answer's carry `<redacted>` there instead, as their request `url` does; a script's copy stays blank, the form an export writes.

### The `schemeDowngrade` of a redirect hop in full

The engine withholds `Authorization` and a typed `Cookie` when the scheme, host or port changes, but an API-key *header* is sent on, so this is the one hop a credential can cross in clear text.

### The `headers` of a redirect hop in full

...lower-cased keys, case-insensitive `get()` / `has()` and the other read methods, a repeated name folded with `", "`.
A hop's `Set-Cookie` lines therefore join into one string, as they do on `pm.response.headers`.
