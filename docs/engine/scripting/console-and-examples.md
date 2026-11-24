---
description: >-
  What `console` prints and where, and worked examples of tests and of pre-request scripts that rewrite a request.
---

# Console output and examples

## Console Output

Log messages that appear in test results.
A `script.setup` or `script.teardown` has no step to show them under, so a run's report keeps them on that script's `lifecycle` row instead (see [Setup and teardown scripts](info-and-setup.md#setup-and-teardown-scripts)):

```javascript
console.log('Response:', pm.response.json());
console.info('Info message');
console.warn('Warning message');
console.error('Error message');
```

Objects and arrays are pretty-printed with `JSON.stringify(value, null, 2)` rather than `[object Object]`; a value that cannot be serialized (a circular reference, say) becomes `[Object: unserializable]`.

**`scriptEnableConsole` off keeps `console` defined** (#3461).
The setting is the recommended one for a load test, where recording and storing output nobody reads costs throughput.
With it off, `console.log`, `console.info`, `console.warn` and `console.error` are still bound, to a function that formats nothing and records nothing, so a script that logs keeps running and its later `pm.test` calls still execute; the result's console output is empty.
The two settings bind the same four names (`setup_console`), so no script can tell them apart by a thrown `ReferenceError`.
`console.debug`, `console.table` and the rest stay undefined either way, as [pm API compatibility](../../app/pm-api-compatibility.md) lists.

Four built-in objects have no useful JSON form and print the way Node prints them (#3130):

| Value | Printed as |
|-------|------------|
| `new Error('boom')` | `Error: boom`, then the stack on the following lines (the message line is not repeated when the stack already begins with it) |
| `new Map([[1, 2]])` | `Map(1) {1 => 2}` |
| `new Set([1])` | `Set(1) {1}` |
| `new Date(0)` | `1970-01-01T00:00:00.000Z`, unquoted; an invalid date prints `Invalid Date` |

Map and Set members are written as compact JSON (a string keeps its quotes), so an object inside a Map prints on one line, and a Map or Set nested inside another prints `{}`.

**The level travels with the line.**
Each entry on the wire is `{ "source": "pre" | "test", "scope"?: "collection" | "folder" | "request", "level": "log" | "info" | "warn" | "error", "message": "...", "scriptRequest"?: <index> }` - `scriptRequest` only on a `pm.sendRequest` summary line, naming the call's record (#3633) - see [`consoleLogs` in the API reference](../api-reference/execute.md#post-execute).
The four methods are bound to one C function distinguished by QuickJS's `magic` argument (`setup_console`), so the level is captured at the call; it cannot be recovered from the text afterwards, which is why it travels with the line.
The app's Console tab draws `warn` and `error` in their status tokens and labels every non-`log` line in a gutter.
`level` is the console method; which collection, folder or request script wrote the line is `scope` (#2522), absent on a line stored before the field.

**Console output is bounded per script execution** (#3134), because the lines outlive the script: they ride the result, are folded across the collection, folder and request levels and are stored on the run's trace, so the memory limit that bounds the script does not bound them.
Three caps, the constants `CONSOLE_LINE_MAX_BYTES` (64 KiB), `CONSOLE_TOTAL_MAX_BYTES` (1 MiB) and `CONSOLE_MAX_ENTRIES` (1000) in `script_engine` (`core/constants.hpp`):

- A line over 64 KiB is cut there, never inside a UTF-8 character, and ends in `...[truncated: console line limit]`.
- A line that would take the kept text past 1 MiB, or the kept lines past 1000, is dropped, as is every line after it.
  Exactly one final `warn` entry, `[console output limit reached: further output of this script is dropped]`, says so; a script that stops at a cap without exceeding it gets none.
- The lines the engine writes for a script (`pm.cookies.jar()` refusals, `pm.visualizer`, and the [`info` line each `pm.sendRequest` leaves](send-request.md#sending-a-request-from-a-script-pmsendrequest)) count against the same caps.
  Nothing is thrown into the script.

The caps are per execution: each level's script has its own, so a request with a collection, a folder and a request script can show up to three times as much, plus a marker each.

**Under a load test, a script that runs inline keeps a sample instead** (#3127).
A load run stores no trace per request, so an inline `script.pre` or `script.post` reports on its element row of the report (a scenario step's `elements`, or a single-request run's `summary.elements`): a `console` list of `{ level, text }` beside a `messages` list of `{ kind: "error" | "test", text }` (the error it threw, and each failing `pm.test` as `name: message`).
Each list keeps the first 10 distinct entries the run produced, however many iterations repeated one, each cut to 500 bytes (`MAX_ELEMENT_MESSAGES` and `MAX_ELEMENT_MESSAGE_BYTES` in `script_validation`, `core/constants.hpp`).
An entry seen more than once carries `count`, how many times; one seen once has no `count`.
What a full list turned away is counted, in occurrences, in `consoleDropped` / `messagesDropped`.
The lists are apart so a script that logs on every iteration cannot crowd out why it failed.

**A script left to the deferred replay keeps its console lines the same way.**
Every line a replayed `script.post` logged, whatever its verdict (a script that threw keeps what it logged first), goes into one `console` list under the same caps and with the same `count`, with `consoleDropped` beside it: a single-request run keeps one list for the run, on the report's `testValidation`;
a scenario load run keeps one per step, on that step's `tests` (`scenario.steps[].tests`), so the same line from two steps appears under each and the run's own `testValidation` carries none.
The replay's failures are its validation row and `testValidation`'s counts; see [Load Test Scripts](execution-context.md#load-test-scripts) and the [API reference](../api-reference/runs.md#get-runsrunidreport).

## Examples

### Validate JSON Response

```javascript
pm.test('User has correct fields', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
  pm.expect(json.email).to.include('@');
});
```

### Check Status Codes

```javascript
pm.test('Success response', function() {
  pm.expect(pm.response.code).to.be.below(400);
});
```

### Set Variables from Response

```javascript
// Extract token from response and save to environment
const json = pm.response.json();
pm.environment.set('userId', json.id);
pm.environment.set('token', json.token);
```

### Pre-request Script

Modify request before sending:

```javascript
// Add timestamp and correlation headers
pm.request.headers['X-Timestamp'] = Date.now().toString();
pm.request.headers['X-Request-Id'] = 'req-' + Math.random().toString(36).slice(2, 10);
```

Both headers are on the request that is actually sent - see [Mutating the request](request-mutation.md#mutating-the-request-pre-request-scripts) for the rules and [Worked examples](#worked-examples-rewriting-a-request) for harder cases.

### Response Time Assertion

```javascript
pm.test('Response time is acceptable', function() {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});
```

### Array Validation

```javascript
pm.test('Returns array of users', function() {
  const users = pm.response.json();
  pm.expect(users).to.be.an('array');
  pm.expect(users.length).to.be.above(0);
  pm.expect(users[0]).to.have.property('id');
});
```

### Header Validation

```javascript
pm.test('Has Content-Type header', function() {
  pm.response.to.have.header('Content-Type');
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');
});
```

## Worked examples: rewriting a request

Everything below runs in a **pre-request** script and changes what goes on the wire.
The rules these rely on are in [Mutating the request](request-mutation.md#mutating-the-request-pre-request-scripts); read the [sandbox note](sandbox.md#what-a-script-can-compute) first if you are here to sign a request, because what is missing decides the shape of most of these.

### Rewrite a JSON body, then fix the headers that describe it

The body is a string in and a string out, so a structural edit is parse - mutate - stringify.
Anything derived from the body (a length, a digest, a checksum) has to be computed *after* the edit, or it describes the old one.

```javascript
var body = JSON.parse(pm.request.body.raw);
body.metadata = { client: 'vayu', sentAt: new Date().toISOString() };
delete body.debugOnly;
pm.request.body.raw = JSON.stringify(body);

// Recomputed from the final body, not the original.
pm.request.headers['Content-Length'] = String(pm.request.body.length);
```

`Content-Length` is illustrative - libcurl sets it from the body it is given, so you do not need to.
Any header you derive yourself works the same way.

### Add or replace a query parameter

`pm.request.url.query.upsert` replaces the first parameter of that name where it stands, or appends one when there is none.
It encodes the value it is given when the request sends its query encoded and leaves the rest of the URL as written, a `{{baseUrl}}` host included, so the same line works on a literal URL and on an imported Postman request:

```javascript
pm.request.url.query.upsert({ key: 'traceId', value: 'run-' + Date.now() });
// {{baseUrl}}/orders?page=2  ->  {{baseUrl}}/orders?page=2&traceId=run-1700000000000
```

`query.add` appends even when the name is already there, and `query.remove` takes every match; [Writing](request-mutation.md#writing) has the rest.

### Switch method and body together

Changing the verb and the payload in one script is fine - the write-back applies all of it or none of it, so the request never goes out as a POST that still carries the GET's shape.

```javascript
if (pm.environment.get('mode') === 'bulk') {
  pm.request.method = 'POST';
  pm.request.url = pm.request.url.replace('/items/1', '/items/bulk');
  pm.request.body = JSON.stringify({ ids: [1, 2, 3] });
  pm.request.headers['Content-Type'] = 'application/json';
}
```

Two edges worth knowing.
A **HEAD** request that carries a body is refused by the send path with a clear error rather than silently stripped, so do not switch to HEAD without also `delete pm.request.body`.
And a body set on a request that had none becomes a `text` body, which goes out as `text/plain`; for any other type set the header yourself, as above.

### Replace engine-applied auth with a custom scheme

Auth is resolved into the request *before* the script runs, so the script sees the real header and has the last word.
Removing and re-adding is how you swap schemes rather than stack them.
(A credential still waiting on a `{{name}}` is applied after the script instead, and only if the script left no header of that name - set one rather than delete it.)

```javascript
delete pm.request.headers['Authorization'];
pm.request.headers['X-Api-Key'] = pm.environment.get('apiKey');
```

For a scheme the engine composes, assigning `pm.request.auth` does the swap in one write, a waiting credential included:

```javascript
pm.request.auth = { type: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}' } };
```

**Use the exact name, capitals included.**
`pm.request.headers` is a plain JS object, and JS property names are case-sensitive, so `delete pm.request.headers['authorization']` deletes nothing and the header survives - even though HTTP itself treats the two as one name.
The engine applies auth as `Authorization`.
When in doubt, look before you delete:

```javascript
Object.keys(pm.request.headers).forEach(function (name) {
  if (name.toLowerCase() === 'authorization') delete pm.request.headers[name];
});
```

For the same reason, **do not leave two names that differ only in case** - setting `authorization` while `Authorization` is still there is two JS properties but one HTTP header, so the write-back rejects it rather than picking a winner, and the request is sent unchanged with the reason in `preScriptError`.

### Sign a request

`pm.crypto` gives a pre-request script a real HMAC, so the request it rewrites can be signed for what it actually became:

```javascript
var timestamp = Date.now().toString();

// The sorted-query canonicalization every HMAC scheme wants. `all()` is the
// view that keeps duplicates and wire-order values, so what is signed is what
// was sent.
var sortedQuery = pm.request.url.query.all()
  .map(function (p) { return p.key + '=' + (p.value === null ? '' : p.value); })
  .sort()
  .join('&');

var canonical = [
  pm.request.method,
  pm.request.url.getPath(),
  sortedQuery,
  timestamp,
  pm.request.body || ''
].join('\n');

pm.request.headers['X-Timestamp'] = timestamp;
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);
```

On a bodiless `GET {{baseUrl}}/echo?b=2&a=1`, `canonical` is `"GET\n/echo\na=1&b=2\n1700000000000\n"`: the path and query are read past the `{{baseUrl}}` the script still sees, and the server receives that path and query once the variable is resolved after the script.

Note the ordering: the canonical string is built from `pm.request` *after* the other edits, so it covers what is actually sent.
If you sign first and rewrite the body second, the signature describes a request that never existed.

**Signatures compared as base64** - Shopify's, for instance - only need a different last argument:

```javascript
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical, 'base64');
```

#### Derived signing keys (AWS SigV4)

A scheme that chains HMACs cannot be expressed with text output alone: each round is keyed by the **raw digest** of the previous one, and hex or base64 is a different byte string.
That is what the `'bytes'` encoding is for - it returns a `Uint8Array`, which is also accepted as a key or as data:

```javascript
var secret  = pm.environment.get('aws_secret_key');
var date    = '20150830';

var kDate    = pm.crypto.hmacSha256('AWS4' + secret, date, 'bytes');
var kRegion  = pm.crypto.hmacSha256(kDate, 'us-east-1', 'bytes');
var kService = pm.crypto.hmacSha256(kRegion, 'iam', 'bytes');
var kSigning = pm.crypto.hmacSha256(kService, 'aws4_request', 'bytes');

// stringToSign is built per the SigV4 spec, hashing the canonical request with
// pm.crypto.sha256(canonicalRequest) - hex, which is what the spec asks for.
pm.request.headers['Authorization'] =
  'AWS4-HMAC-SHA256 Credential=…, Signature=' +
  pm.crypto.hmacSha256(kSigning, stringToSign);
```

#### What is hashed

A string contributes its **UTF-8** bytes - the same bytes the engine puts on the wire, so a digest computed here matches one computed by `sha256sum` over the same text.
A `Uint8Array` contributes its bytes unchanged; that is the only way to key an HMAC with bytes that are not valid UTF-8.
Passing anything else (an object, a number, `null`) throws rather than being stringified: hashing the text `[object Object]` would return a digest that looks perfectly valid.

### Hand a value to the test script

A pre-request script and its test script share the variable scopes, not their local state.
Stash what the assertion needs:

```javascript
// Pre-request
var nonce = 'n-' + Math.random().toString(36).slice(2);
pm.request.headers['X-Nonce'] = nonce;
pm.environment.set('lastNonce', nonce);
```

```javascript
// Tests
pm.test('server echoed our nonce', function () {
  pm.expect(pm.response.headers['x-nonce']).to.equal(pm.environment.get('lastNonce'));
});
```
