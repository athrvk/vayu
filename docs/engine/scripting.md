# Vayu Scripting Guide

Vayu uses QuickJS for JavaScript execution in pre-request and test scripts. The scripting API is compatible with Postman's `pm` object, making it easy to migrate tests from Postman.

## Quick Start

```javascript
// Test script example
pm.test('Status is 200', function() {
  pm.expect(pm.response.code).to.equal(200);
});

pm.test('Response has user data', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
});
```

## The `pm` Object

### pm.test()

Define a test with assertions.

```javascript
pm.test('Test name', function() {
  // Assertions here
});
```

### pm.expect()

Create Chai-style expectations for assertions.

**`equal` is strict, `eql` is deep.** `equal` is `===`, so two objects with the
same contents are *not* equal - only the same reference is. `eql` (and its alias
`deep.equal`) compares contents recursively and does not care about key order.
This matches chai, which is what Postman scripts are written against; picking the
wrong one is the most common porting mistake.

```javascript
pm.expect({ a: 1 }).to.equal({ a: 1 });      // fails - different references
pm.expect({ a: 1 }).to.eql({ a: 1 });        // passes
pm.expect({ a: 1, b: 2 }).to.eql({ b: 2, a: 1 }); // passes - order is not part of it
```

The full matcher inventory:

```javascript
// Equality
pm.expect(value).to.equal(expected);         // strict (===)
pm.expect(value).to.eql(expected);           // deep; alias .eqls
pm.expect(value).to.deep.equal(expected);    // same as .eql
pm.expect(value).to.be.oneOf([a, b]);
pm.expect(value).to.be.closeTo(expected, delta);

// Truthiness and existence (paren-less: accessing them asserts)
pm.expect(value).to.be.true;
pm.expect(value).to.be.false;
pm.expect(value).to.be.null;
pm.expect(value).to.be.undefined;
pm.expect(value).to.be.ok;
pm.expect(value).to.be.empty;
pm.expect(value).to.exist;

// Numbers
pm.expect(value).to.be.above(n);
pm.expect(value).to.be.below(n);
pm.expect(value).to.be.at.least(n);
pm.expect(value).to.be.at.most(n);

// Types
pm.expect(value).to.be.a('string');
pm.expect(value).to.be.an('array');
pm.expect(value).to.be.instanceOf(Array);

// Strings, collections and objects
pm.expect(value).to.include(item);           // alias .contain
pm.expect(value).to.have.string(substring);  // string target only
pm.expect(value).to.match(/regex/);
pm.expect(value).to.have.length(n);          // alias .lengthOf
pm.expect(value).to.have.property('key');
pm.expect(value).to.have.property('key', expectedValue);
pm.expect(value).to.have.nested.property('a.b[0].c');
pm.expect(value).to.have.keys('a', 'b');     // exactly these keys; alias .key
pm.expect(value).to.have.members([1, 2, 3]); // same members, any order

// Functions
pm.expect(fn).to.throw();                    // alias .throws
pm.expect(fn).to.throw('message substring');
pm.expect(fn).to.throw(/pattern/);
pm.expect(value).to.satisfy(function (v) { return v > 0; });

// Chainers
pm.expect(value).to.not.equal(expected);     // negates the rest of the chain
pm.expect(value).to.be.above(0).and.to.be.below(10);
pm.expect(value).to.deep.include({ a: 1 });  // deep applies to include, property,
                                             // members and oneOf as well
```

Notes on the edges:

- **`deep` changes the comparison, it is not a matcher.** `include`, `property`,
  `members` and `oneOf` compare strictly unless a `deep` appears in the chain.
- **`keys` means exactly these keys**, as in chai's `have.keys`. The subset form
  (`include.keys`) is not implemented; `all` is accepted and changes nothing,
  `any` is not.
- **`eql` refuses containers it cannot inspect.** `Map`, `Set` and typed arrays
  keep their contents outside the property list, so two distinct ones report
  *not* equal rather than silently passing. `Date` compares by instant and
  `RegExp` by pattern.
- **A cycle fails loudly.** Deep equality gives up after 64 levels with a
  `RangeError` naming the cause.
- **`.and` carries the chain's flags**, `not` included, exactly as in chai.

## Response Object (`pm.response`)

Access HTTP response data:

```javascript
pm.response.code              // Status code (number, e.g., 200)
pm.response.status            // Alias for code
pm.response.responseTime      // Perceived latency in ms (submit → completion).
                              // In load tests this includes generator-side
                              // queue wait. For pure server wire time, use
                              // responseTimeWire.
pm.response.responseTimeWire  // CURLINFO_TOTAL_TIME in ms - DNS + TCP + TLS +
                              // send + recv. Matches the pre-v0.3 meaning of
                              // responseTime; use this to assert on server SLAs
                              // independent of generator load.
pm.response.responseTimeQueueWait // Generator-side queue overhead in ms,
                              // i.e. responseTime − responseTimeWire (clamped
                              // to >= 0). For single-shot sends this is ~0.
pm.response.headers           // Plain object, lower-cased keys. Read it with
                              // pm.response.headers['content-type'] - it is not
                              // Postman's HeaderList, so there is no .get()/.has().
pm.response.body              // Raw body string
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
```

### Response Assertions

```javascript
pm.response.to.have.status(200);
pm.response.to.have.header('Content-Type');
pm.response.to.have.jsonBody();
```

Status-class assertions hang off `pm.response.to.be`. They are **getters** - the
paren-less form is the assertion:

```javascript
pm.response.to.be.ok;            // 2xx
pm.response.to.be.success;       // 2xx
pm.response.to.be.info;          // 1xx
pm.response.to.be.redirection;   // 3xx
pm.response.to.be.clientError;   // 4xx
pm.response.to.be.serverError;   // 5xx
pm.response.to.be.error;         // 4xx or 5xx
pm.response.to.be.accepted;      // 202
pm.response.to.be.badRequest;    // 400
pm.response.to.be.unauthorized;  // 401
pm.response.to.be.forbidden;     // 403
pm.response.to.be.notFound;      // 404
pm.response.to.be.rateLimited;   // 429
pm.response.to.be.json;          // body parses as JSON
pm.response.to.be.withBody;      // body is not empty
```

**Anything else under `pm.response.to` throws.** A misspelled or unimplemented
name - `pm.response.to.be.definitelyNotAMatcher`, or the negated
`pm.response.to.not.be.ok`, which Vayu does not have - raises a `TypeError`
naming the chain rather than evaluating to `undefined`. A paren-less assertion
is an expression statement, so a silent `undefined` would report PASS against a
broken API; failing loudly is the point.

## Request Object (`pm.request`)

Access request data:

```javascript
pm.request.method            // HTTP method (string)
pm.request.url               // Full URL (string)
pm.request.headers           // Request headers (object)
pm.request.body              // Request body (string, if any)
```

### Mutating the request (pre-request scripts)

In a **pre-request** script these four fields are writable, and what they hold
when the script returns is what goes on the wire. In a **test** script they are
a read-only record of what was already sent - writes there are discarded.

```javascript
pm.request.headers['X-Signature'] = 'abc123';   // add or replace a header
delete pm.request.headers['Authorization'];     // remove one
pm.request.url = 'https://api.example.com/v2';  // retarget
pm.request.method = 'POST';                     // case-insensitive
pm.request.body = JSON.stringify({ n: 2 });     // replace the body
delete pm.request.body;                         // send no body
```

Rules worth knowing before you rely on them:

- **The object is authoritative, not a diff.** The header set left in
  `pm.request.headers` is the header set that is sent, which is what makes
  `delete` work.
- **A script beats engine-applied auth.** Auth (bearer / basic / apikey /
  oauth2) is resolved into the request *before* the script runs, so the script
  sees the real `Authorization` header and can replace or remove it.
- **A bad value is refused, not coerced.** `url` and `method` must be strings
  (`method` one of the seven HTTP verbs), header values must be strings,
  numbers or booleans, and `body` must be a string. Anything else fails the
  whole write-back - the request is sent unchanged and the reason is reported
  as the pre-request script error, visible in the response pane's Console tab.
- **Setting a variable does not re-render the URL.** `{{placeholders}}` are
  resolved app-side before the payload reaches the engine, so
  `pm.environment.set('host', …)` affects later runs only. To change this
  request's URL, assign `pm.request.url` directly.
- **Load tests do not run pre-request scripts** - only the `tests` (post-request)
  script runs there, so this applies to Send / Design Mode.

## Environment Variables (`pm.environment`)

Access and modify environment variables:

```javascript
// Get variable
const token = pm.environment.get('auth_token');

// Set variable (persists to environment)
pm.environment.set('auth_token', 'new_token_value');
```

`set()` on an existing name replaces only its value - the variable's `secret`,
`enabled`, `type` and creation time are kept. A name that does not exist yet is
created with the defaults and stamped with its creation time, so it appears at
the bottom of that scope in the variables editor rather than above the rows
that were already there. A scope no script wrote is not persisted at all.

### The six methods every scope has

| Method | Returns | Notes |
|---|---|---|
| `get(name)` | the value, cast by its declared type, or `undefined` | a disabled variable reads as `undefined` |
| `set(name, value)` | `undefined` | keeps `secret` / `enabled` / `type` / creation time |
| `has(name)` | `boolean` | true only for the rows `get()` can read, so a disabled variable is `false` |
| `unset(name)` | `undefined` | removes the name; removing one that is not there is not an error |
| `clear()` | `undefined` | empties **this** scope only, disabled rows included |
| `toObject()` | plain object | every enabled variable, values cast by type; a snapshot, not a live view |

```javascript
if (pm.environment.has('auth_token')) {
	pm.environment.unset('auth_token');
}

console.log(pm.environment.toObject());
```

`unset()` is not the same as `set(name, '')`. An emptied variable is still an
enabled row, so `{{auth_token}}` resolves to the empty string; an unset one is
gone, and the template resolves as it does for a name nobody defined. The
removal reaches disk the same way any other write does - the scope is rewritten
after the run because the map the script left differs from the stored one.

A scope the run was not given (a design run with no active environment, say)
behaves as an empty one: `get` is `undefined`, `has` is `false`, `toObject` is
`{}`, and writes go nowhere. A script cannot see which scopes a run carries, so
this is deliberately not an error.

## Collection and Global Variables

The other two scopes are reached the same way as the environment, each through
its own accessor, and answer the same six methods:

```javascript
const value = pm.collectionVariables.get('baseUrl');
pm.collectionVariables.set('baseUrl', 'https://api.example.com');

const runId = pm.globals.get('run_id');
pm.globals.set('run_id', '42');
```

Each `set()` persists to the scope it names, with the same
keep-the-flags behaviour described for `pm.environment` above.

`pm.collectionVariables` is the request's **immediate parent collection**, not
the whole collection chain. `{{name}}` resolution merges every ancestor
root-first before the payload reaches the engine, so a variable defined on a
parent collection resolves in a URL and is *not* readable from a script. Define
it on the request's own collection, or in the environment, if a script needs it.

## Variables (`pm.variables`)

`pm.variables` reads a name without naming its scope, resolving
**environment, then collection, then global** and stopping at the first scope
that has it enabled. That is the same order `{{baseUrl}}` is resolved in before
the request is sent (see
[Variable Resolution](../app/variable-resolution.md)), so a script and a URL in
the same request cannot read one name two different ways.

```javascript
const baseUrl = pm.variables.get('baseUrl'); // wherever it is defined
if (pm.variables.has('debug')) { /* ... */ }
console.log(pm.variables.toObject()); // all three scopes, merged
```

It has `get`, `has` and `toObject` - and no `unset` or `clear`, because it owns
no scope to remove a name from.

**`pm.variables.set()` throws.** In Postman it writes to a *local* scope that
lives for one request and is never stored; Vayu has no such scope. Writing to
the environment instead would persist a value the script author expects to
vanish, and quietly dropping the call would lose a write they believe happened,
so it fails loudly and names the three scopes that do exist:

```
TypeError: pm.variables.set is not supported: Vayu has no local variable scope.
Use pm.environment.set(), pm.collectionVariables.set() or pm.globals.set() to
choose where the value is stored.
```

`replaceIn()` - Postman's `{{name}}` interpolation of an arbitrary string - is
still absent from every scope. The engine deliberately does no `{{var}}`
interpolation at all (it is resolved app-side before the payload arrives), so
there is nothing for it to call.

## Console Output

Log messages that appear in test results:

```javascript
console.log('Response:', pm.response.json());
console.info('Info message');
console.warn('Warning message');
console.error('Error message');
```

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

Both headers are on the request that is actually sent - see
[Mutating the request](#mutating-the-request-pre-request-scripts) for the rules
and [Worked examples](#worked-examples-rewriting-a-request) for harder cases.

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
  pm.expect(pm.response.headers['content-type']).to.include('application/json');
});
```

## Worked examples: rewriting a request

Everything below runs in a **pre-request** script and changes what goes on the
wire. The rules these rely on are in
[Mutating the request](#mutating-the-request-pre-request-scripts); read the
[sandbox note](#what-a-script-can-compute) first if you are here to sign a
request, because what is missing decides the shape of most of these.

### Rewrite a JSON body, then fix the headers that describe it

The body is a string in and a string out, so a structural edit is
parse - mutate - stringify. Anything derived from the body (a length, a digest,
a checksum) has to be computed *after* the edit, or it describes the old one.

```javascript
var body = JSON.parse(pm.request.body);
body.metadata = { client: 'vayu', sentAt: new Date().toISOString() };
delete body.debugOnly;
pm.request.body = JSON.stringify(body);

// Recomputed from the final body, not the original.
pm.request.headers['Content-Length'] = String(pm.request.body.length);
```

`Content-Length` is illustrative - libcurl sets it from the body it is given, so
you do not need to. Any header you derive yourself works the same way.

### Add or replace a query parameter

There is no `URL` or `URLSearchParams` in the sandbox, so this is string work.
Handle three cases - no query, parameter absent, parameter already present -
and encode the value.

```javascript
function setQueryParam(url, name, value) {
  var pair = encodeURIComponent(name) + '=' + encodeURIComponent(value);
  var hashAt = url.indexOf('#');
  var fragment = hashAt === -1 ? '' : url.slice(hashAt);
  var base = hashAt === -1 ? url : url.slice(0, hashAt);

  var re = new RegExp('([?&])' + name + '=[^&]*');
  if (re.test(base)) {
    return base.replace(re, '$1' + pair) + fragment;
  }
  return base + (base.indexOf('?') === -1 ? '?' : '&') + pair + fragment;
}

pm.request.url = setQueryParam(pm.request.url, 'traceId', 'run-' + Date.now());
```

### Switch method and body together

Changing the verb and the payload in one script is fine - the write-back applies
all of it or none of it, so the request never goes out as a POST that still
carries the GET's shape.

```javascript
if (pm.environment.get('mode') === 'bulk') {
  pm.request.method = 'POST';
  pm.request.url = pm.request.url.replace('/items/1', '/items/bulk');
  pm.request.body = JSON.stringify({ ids: [1, 2, 3] });
  pm.request.headers['Content-Type'] = 'application/json';
}
```

Two edges worth knowing. A **HEAD** request that carries a body is refused by
the send path with a clear error rather than silently stripped, so do not switch
to HEAD without also `delete pm.request.body`. And a body set on a request that
had none is sent as raw text - Vayu does not infer a `Content-Type`, so set it
yourself as above.

### Replace engine-applied auth with a custom scheme

Auth is resolved into the request *before* the script runs, so the script sees
the real header and has the last word. Removing and re-adding is how you swap
schemes rather than stack them.

```javascript
delete pm.request.headers['Authorization'];
pm.request.headers['X-Api-Key'] = pm.environment.get('apiKey');
```

**Use the exact name, capitals included.** `pm.request.headers` is a plain JS
object, and JS property names are case-sensitive, so
`delete pm.request.headers['authorization']` deletes nothing and the header
survives - even though HTTP itself treats the two as one name. The engine
applies auth as `Authorization`. When in doubt, look before you delete:

```javascript
Object.keys(pm.request.headers).forEach(function (name) {
  if (name.toLowerCase() === 'authorization') delete pm.request.headers[name];
});
```

For the same reason, **do not leave two names that differ only in case** -
setting `authorization` while `Authorization` is still there is two JS
properties but one HTTP header, so the write-back rejects it rather than
picking a winner, and the request is sent unchanged with the reason in
`preScriptError`.

### Sign a request with a checksum you can actually compute

**There is no crypto in the sandbox** - no `crypto`, no `TextEncoder`, no
`btoa`. A real HMAC is therefore not possible in-script today, and any example
claiming otherwise is wrong. What *is* possible is a pure-JS digest over a
canonical string, which is enough for a checksum, a cache key, or a test double
of a signing scheme:

```javascript
// FNV-1a, 32-bit. Not a cryptographic hash - do not use it as one.
function fnv1a(text) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ('00000000' + hash.toString(16)).slice(-8);
}

var timestamp = Date.now().toString();
var canonical = [
  pm.request.method,
  pm.request.url,
  timestamp,
  pm.request.body || ''
].join('\n');

pm.request.headers['X-Timestamp'] = timestamp;
pm.request.headers['X-Checksum'] = fnv1a(canonical + pm.environment.get('secret'));
```

Note the ordering: the canonical string is built from `pm.request` *after* the
other edits, so it covers what is actually sent. If you sign first and rewrite
the body second, the signature describes a request that never existed.

### Hand a value to the test script

A pre-request script and its test script share the variable scopes, not their
local state. Stash what the assertion needs:

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

### What a script can compute

The sandbox is QuickJS plus exactly two globals, `pm` and `console`. Available:
`JSON`, `Date`, `Math`, `RegExp`, `String`, `Array`, `Object`, `Number`,
`Promise`, `BigInt`, `encodeURIComponent`, `parseInt` and the rest of the ES2020
built-ins. **Not** available: `crypto`, `btoa` / `atob`, `TextEncoder`, `URL`,
`URLSearchParams`, `setTimeout`, `require`, `fetch`.

The practical consequences: no HMAC or SHA signing, no base64 (so no
hand-rolled Basic auth header - use the request's Auth tab, which the engine
applies), no URL parsing helper, and nothing asynchronous. Both halves of this
list are pinned by tests in `engine/tests/script_engine_test.cpp`, so if a
global is ever added this section is what needs rewriting.

## Limitations

QuickJS supports ES2020 features with some limitations:

- **No ES2021+ features**: No optional chaining (`?.`), nullish coalescing (`??`), etc.
- **No Node.js APIs**: No `require()`, `fs`, `http`, etc.
- **Sandboxed**: No filesystem or network access
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script (default), enforced by a wall-clock deadline - an
  infinite-loop script is aborted and reported as an error rather than hanging the
  engine. Configurable via the `scriptTimeout` setting (milliseconds); `0` disables
  the limit.

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` - method, url, headers and body - and the edits are
  applied to the request that is sent
  ([rules](#mutating-the-request-pre-request-scripts))
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Cannot access `pm.response` (request hasn't been sent yet)
- Run in Design Mode / Send only, not in load tests

### Test Scripts (Post-request)

- Execute after receiving the HTTP response
- Can access `pm.request` (read-only here - it has already been sent) and `pm.response`
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Test results are included in the response

### Load Test Scripts

- Test scripts in load tests are executed **deferred** (after test completion)
- Only a sample of responses are validated (configurable)
- Results are aggregated and reported in the final report
- `POST /runs`'s `tests` field carries the collection chain's test scripts as
  well as the request's own, composed the same way as `POST /execute` (see
  [Script Parts](#script-parts) below) - a collection-level assertion is now
  checked under load, not only in design mode

## Script Parts

A script's effective source is composed of parts: the collection chain's own
script, then the request's own script, in that order. Each route accepts its
own field(s), each in either of two forms:

- `POST /execute` takes `preRequestScript` / `postRequestScript` (legacy
  single string, already-joined text) or `preRequestScripts` /
  `postRequestScripts` (a list of parts). The load path (`POST /runs`) does not
  read either of these two keys.
- `POST /runs` takes `tests` (the deferred validation script), either as a
  legacy single string or as a list of parts. `POST /execute` does not read
  `tests`.

A list of parts is an array of objects, each recording where it came from -
`{ "origin": "collection" | "request", "id": "...", "name": "...", "script":
"..." }` - so a stored run can say which part is whose.

When both the list and the legacy string are sent for the same field, **the
list wins**; they are never merged. Parts that are empty or only whitespace are
dropped.

**The parts are joined with a blank line (`"\n\n"`) and run as a single script
in one shared JavaScript scope** - one call to the script engine per field
(`engine.execute()` for `preRequestScript(s)` / `postRequestScript(s)`,
`engine.execute_test()` for `tests`), not one call per part. That means a
`const` or `let` declared in the collection's part is visible to the
request's part, exactly as if one person had typed the whole thing into one
editor. It also means a syntax error's reported line number is counted from
the start of the joined text, not from the start of whichever part actually
has the mistake.

## Error Handling

Script errors are caught and reported:

```javascript
// If script throws, error is captured
try {
  const json = pm.response.json();
} catch (e) {
  // Error is reported in test results
}
```

Test failures don't stop script execution - all tests run and results are collected.

## Best Practices

1. **Use descriptive test names**: `pm.test('Status code is 200', ...)`
2. **Validate structure before accessing**: Check if JSON exists before accessing properties
3. **Use environment variables**: Store sensitive data in environments, not scripts
4. **Keep scripts simple**: Complex logic should be in your application code
5. **Log debugging info**: Use `console.log()` to debug script issues

## API Reference

For complete API documentation, see the [Scripting Completions API](api-reference.md#scripting) which lists all available `pm.*` functions and properties.
