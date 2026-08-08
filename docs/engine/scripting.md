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
pm.response.headers           // Plain object, lower-cased keys, with
                              // case-insensitive get()/has() over it - see below
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
pm.response.reason()          // Status reason phrase ('OK', 'Not Found')
pm.response.size()            // { body, header, total } in bytes
pm.response.cookies           // Set-Cookie, parsed - see below
                              // (the stored session is pm.cookies)
```

`reason()` reports the reason phrase from the status line. Where none was
received it falls back to the canonical text for the code, so a client-side
failure - vayu's synthetic status `0` - reads `"Error"` rather than an empty
string. (Postman returns `null` in that case; vayu always returns a string.)

`size()` counts the body the script can read through `text()`, so
`size().body === pm.response.text().length` for an ASCII body. `size().header`
is the serialised header block - `Name: Value\r\n` per header - reconstructed
from the parsed headers, so it is close to but not byte-exact with what came off
the wire. An empty body reports `0`, not an absent property.

### Reading response headers

```javascript
pm.response.headers.get('Content-Type');   // case-insensitive; undefined if absent
pm.response.headers.has('X-Request-Id');   // boolean
pm.response.headers['content-type'];       // indexing: exact key only
```

`headers` is a plain object, not Postman's `HeaderList`, but `get()` and `has()`
are on it and behave the way HTTP header names do - case-insensitively. Indexing
does not: the engine lower-cases every response header name as it parses it, so
`headers['Content-Type']` is `undefined` while `headers.get('Content-Type')`
works. Prefer the methods unless you know the exact key.

The response object has **no** `add`/`upsert`/`remove` - the response has
already arrived, so a mutator there would only appear to change something.

**A name the server sent twice reads as one value, folded with `", "`.** Two
`Set-Cookie` lines arrive as
`"session=abc; Path=/, csrf=xyz; Path=/"`, and `get()` returns that whole
string - there is no list form, because `headers` is a plain object. Folding is
the RFC 7230 §3.2.2 equivalence for comma-list headers; before it, only the
**last** value of a repeated name survived at all. If you need the parts, split
on `", "` - but not for `Set-Cookie`, whose values contain commas of their own
(`Expires=Wed, 21 Oct ...`). Read `pm.response.cookies` instead: it is that
header already parsed, boundaries and all.

### Reading response cookies

```javascript
pm.response.cookies.get('session');    // value, or undefined if unset
pm.response.cookies.has('session');    // boolean
pm.response.cookies.toObject();        // { session: 'abc', tracker: 't1' }
pm.response.cookies.length;            // it is an array, in wire order
pm.response.cookies[0].name;           // 'session'
pm.response.cookies[0].value;          // 'abc'
pm.response.cookies[0].attrs;          // ['Path=/', 'HttpOnly'] - raw chunks
```

`cookies` is what the response's `Set-Cookie` header carried, parsed - an array
of `{ name, value, attrs }` with `get()` / `has()` / `toObject()` over it.
Attributes are the raw `;`-separated chunks in wire order; there are no
`path` / `secure` / `expires` fields, because that is the header restated, and
what the engine actually *holds* is [`pm.cookies`](#the-cookie-jar-pmcookies).

Three things follow from that, and they are the ones worth knowing:

- **This is one response, not the session.** It reports what this response set,
  including a cookie the engine then discarded as expired. For what will be
  sent on the next request, read [`pm.cookies`](#the-cookie-jar-pmcookies).
- **Cookie names are case-sensitive**, unlike header names: `get('SESSION')`
  does not answer the `session` cookie. That is what RFC 6265 says, and
  answering otherwise would be a wrong value dressed as a right one.
- **A name set twice answers with the last value** from `get()` and
  `toObject()` - the one a browser's jar would keep - while the array still
  lists both, because that is what came off the wire.

The parse is shared with the app's response Cookies tab through a conformance
fixture (`engine/tests/fixtures/set-cookie-conformance.json`), so the value a
script asserts on and the value shown in the UI cannot drift. It handles the two
cases a naive split corrupts: a comma inside `Expires=Wed, 21 Oct ...` is not a
cookie boundary, and the `=` padding on a base64 value stays in the value.

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
pm.request.headers           // Request headers (object, with the methods below)
pm.request.body              // Request body (string, if any)
```

`body` is a string for every mode, including the two whose content is a list of
fields rather than text. A form body reads as its **enabled** fields encoded
`key=value&…`:

| Body mode | What `pm.request.body` reads | Assigning a string |
|---|---|---|
| `json` / `text` / `xml` / `graphql` / … | the content, as stored | replaces it |
| `x-www-form-urlencoded` | the encoded fields - **exactly** the bytes sent | parses back into the fields |
| `form-data` | the encoded fields - a *rendering*, not the bytes sent | refused with a named error |
| none | the property is absent (`undefined`) | sends that string as raw text |

The `form-data` split is not an oversight: a multipart body carries a boundary
libcurl generates at transfer time, so no faithful string exists before the send.
That makes the string safe to read and log, but a digest taken over it is **not**
a digest of the multipart body that goes out - and it is why an assignment is
refused there rather than accepted and then ignored by the transfer layer. To
change a multipart body, edit the request's form fields; `delete pm.request.body`
still drops it entirely.

Reading a form body never rewrites it. The write-back reads `body` off the
script's object whether or not the script assigned it, so an **unchanged** string
means untouched - without that, a script that only looked at the body would
delete the disabled rows the encoded view leaves out.

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
  Assigning a string to a `form-data` body fails the same way, for the same
  reason: a value the engine cannot send is refused rather than dropped.
- **Setting a variable does not re-render the URL.** `{{placeholders}}` are
  resolved at compose time (`POST /compose`), strictly before any script runs,
  so `pm.environment.set('host', …)` affects later runs only - a deliberate
  divergence from Postman's script-first order (#226, D1). To change this
  request's URL, assign `pm.request.url` directly.
- **Load tests do not run pre-request scripts** - only the `tests` (post-request)
  script runs there, so this applies to Send / Design Mode.

### Header methods (`pm.request.headers`)

```javascript
pm.request.headers.get('authorization');                  // case-insensitive
pm.request.headers.has('Authorization');                  // boolean
pm.request.headers.upsert({ key: 'X-Trace', value: id }); // add or replace
pm.request.headers.upsert('X-Trace', id);                 // same, two-arg form
pm.request.headers.add({ key: 'X-New', value: '1' });     // add; throws if present
pm.request.headers.remove('Authorization');               // case-insensitive
```

These act on the **same object** as indexing and `delete`, so the two styles
mix freely and the write-back sees one header set either way. They are
non-enumerable properties of it, so they never appear in `Object.keys()`,
`JSON.stringify()` or on the wire.

Three behaviours worth knowing:

- **The methods are case-insensitive; indexing is not.** `upsert('authorization', v)`
  replaces an existing `Authorization` rather than adding a second spelling -
  which matters, because the write-back refuses a header set holding two casings
  of one name.
- **`add` refuses a name that is already there**, and says to use `upsert`.
  Postman's `HeaderList` holds duplicates and `add` appends one; a request here
  carries a single value per name, so the difference is reported rather than
  silently collapsed into an `upsert`.
- **`remove` on an absent header is a no-op**, not an error.

A bad argument fails loudly: a name must be a non-empty string and a value a
string, number or boolean - the same set plain assignment accepts. Detaching a
method from its object (`const get = pm.request.headers.get`) throws rather than
answering as though the header were missing.

### URL parts are not exposed (deferred)

Postman has `pm.request.url.query` / `.path` / `.host`. Vayu does not, and it is
not an oversight: `pm.request.url` is a **writable string**, and the write-back
requires it to still be one when the script returns. A JS string primitive
cannot carry properties, and boxing it into a `String` object to hang them off
would make the write-back reject every request. Any URL-parts accessor therefore
has to be a separate member (something like `pm.request.getUrlParts()`) rather
than `url.*`; that shape has not been decided, so parsing the URL remains string
work - see [Add or replace a query parameter](#add-or-replace-a-query-parameter).

## Script Identity (`pm.info`)

What the script is attached to, and which hook is running it. Five fields,
each **optional** - `pm.info` is always an object, but a field with no truthful
value is absent rather than `""`, so `typeof` is how a script tests for one:

```javascript
pm.info.requestId      // string | undefined - the saved request this send is filed under
pm.info.requestName    // string | undefined - its name, as the client sent it
pm.info.eventName      // 'prerequest' in a pre-request script, 'test' in a test script
pm.info.iteration      // number | undefined - 0-based, in a collection run only
pm.info.iterationCount // number | undefined - the run's iteration total
```

`eventName` is stamped by the engine at each hook (`ScriptContext::for_prerequest`
/ `for_test`), never by the caller, so it cannot disagree with the hook that is
actually running. The other two are supplied per send:

- `requestId` is the payload's `requestId`, which is also what files the run in
  History. Absent for an ad-hoc send (MCP's `run_request` without one, a load
  run started from a URL).
- `requestName` comes from the payload's `requestName`, falling back to the
  stored row's name when only an id was sent. The client sends it because Send
  executes *editor state*: an unsaved request has a name and no row to read it
  from, and a name edited but not yet saved should read as what the user sees.
  `POST /compose` fills it in on its by-id path, so a composed payload arrives
  carrying it.

**`iteration` and `iterationCount` are set by the collection runner and by
nothing else.** In a scenario run (`POST /runs` with a `scenario` block) every
step's scripts read the real index - `iteration` counts from 0, and it reads as
`0`, not as absent, on the first pass. Everywhere else both are `undefined`,
which is the honest answer rather than an omission: a load test's test script
runs once per *sampled* response after the run has finished, and the sample is a
reservoir over the whole run rather than the first N iterations, so an index
reported there would not be an iteration number. A binding that cannot fail is
worse than a missing one.

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

`pm.collectionVariables` reads the request's **whole collection chain**, the
same merge `{{name}}` resolution uses: `get`, `has` and `toObject` take the
nearest enabled definition, walking from the request's own collection up to the
root. A variable defined on a parent collection therefore reads the same in a
script as it substitutes in a URL.

**Writes stay on the request's own collection.** `set`, `unset` and `clear`
never reach an ancestor, so `set` on a descendant *shadows* an inherited name
and `unset` un-shadows it - the ancestor's value comes back rather than being
deleted. A disabled row is looked past wherever it sits in the chain. The full
rule, and why ancestors are read-only, is in
[Variable Resolution](../app/variable-resolution.md).

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

**`pm.variables.replaceIn(template)`** - Postman's `{{name}}` interpolation of
an arbitrary string - runs the same single-pass resolver `POST /compose` uses
(`request_composer.cpp::resolve_template`), over the script's scopes in
`pm.variables`' precedence, at **call time** - so a variable the script set a
line earlier resolves, unlike `{{}}` in the URL, which was composed before the
script started. Dynamic variables generate per occurrence:

```javascript
const id = pm.variables.replaceIn("{{$guid}}"); // fresh UUID v4
```

It exists only on the merged accessor - the scoped `replaceIn` variants stay
absent - and its argument must be a string (a non-string is a `TypeError`).
This is the one sanctioned way to `{{...}}` in a script: script *source* is
never interpolated (issue #226, D16 - a rewrite cannot tell code from a string
literal, and splicing values into source is an injection).

**Dynamic variables are otherwise not readable from a script.** `{{$guid}}`,
`{{$timestamp}}` and the rest of the set in
[variable resolution](../app/variable-resolution.md#dynamic-variables) are
generated while the payload is composed; by the time a script runs, that
payload holds the generated *value* and no scope has ever heard of the name.
`pm.variables.get("$guid")` reads as any other undefined name does - reach the
generators through `replaceIn`.

## Sending a request from a script (`pm.sendRequest`)

The one part of the sandbox that touches the network. Its reason for existing is
the token fetch: a pre-request script that needs a credential the request itself
cannot supply.

```javascript
pm.sendRequest(
  {
    url: "https://auth.example.com/token",
    method: "POST",
    header: { "Content-Type": "application/json" },
    body: { mode: "raw", raw: JSON.stringify({ client_id: "abc" }) },
  },
  function (err, res) {
    if (err) {
      console.error("token fetch failed: " + err.message);
      return;
    }
    pm.environment.set("token", res.json().access_token);
  }
);
```

The first argument is a URL string or an options object; the second is required
and must be a function.

| Option | Shape |
| ------ | ----- |
| `url` | string, required. Postman's URL-object form is not accepted |
| `method` | string, default `GET`; case-insensitive, an unknown verb throws |
| `header` / `headers` | `{ name: value }` or Postman's `[{ key, value }]`. Both names read; sending both at once throws |
| `body` | a string, or `{ mode: 'raw', raw }`. Only `raw` - other modes throw |
| `timeout` | milliseconds, clamped to the script's remaining budget (below) |

**Synchronous, and callback-shaped for that reason.** The send blocks and the
callback runs inline, before `pm.sendRequest` returns. There is no promise
overload: `Promise` exists in the sandbox but nothing drains its job queue, so
one could only never resolve - the same reason hashing is `pm.crypto` rather
than `crypto.subtle`.

**Which failures throw and which reach the callback.** Transport failures are
the network's answer, so they arrive as the callback's `err` - an `Error` with
a `.code` (`CONNECTION_FAILED`, `DNS_ERROR`, `TIMEOUT`, …) and `res` null. The
script's own mistakes throw out of the call instead: an unusable argument, an
unsupported body mode, exceeding the request cap, and the capability being off.

`res` carries `code`, `status` (the numeric code, as on `pm.response`),
`responseTime`, `headers` with `get()`/`has()`, `json()` and `text()`. It is a
subset of `pm.response` and has no `to.*` assertion chain.

**Two bounds, both hard.**

- *The script's deadline.* The wall-clock limit is enforced by a QuickJS
  interrupt handler, and QuickJS only calls it **between bytecode operations** -
  a blocking C function never yields to it. So the request's timeout is clamped
  to whatever is left of the script's budget; without that, a 5s script calling
  `pm.sendRequest` at the default 30s request timeout would hold its thread for
  30s with no error and no way to interrupt it. When `scriptTimeout` is `0`
  there is no budget and nothing to clamp to.
- *A request cap.* One script execution may issue at most **10** requests, then
  throws. A load run's `tests` script runs once per *sampled* response, serially,
  on the run's worker thread, so an uncapped loop would turn post-run validation
  into minutes of apparent hang.

**Not available to agents.** Vayu's MCP target allowlist is checked in the MCP
server, against the composed URL, before it calls the engine - so a script-issued
request never passes that gate. The engine therefore refuses script-issued
requests unless the caller explicitly asks for them (`allowScriptRequests` on
`POST /execute` / `POST /runs`); Vayu's own Send and load runs ask, and the MCP
server never does. Calling it from an agent-started run throws a message saying
so. See [MCP](mcp.md#the-script-sandbox-surface).

**No `{{variable}}` resolution.** A script-supplied URL is sent as written.
Interpolation happens strictly before the pre-request script and a payload is
resolved exactly once; a second pass here would break that invariant. Use
`pm.variables.replaceIn(template)`.

## The cookie jar (`pm.cookies`)

```javascript
pm.cookies.get('session');      // value, or undefined
pm.cookies.has('session');      // boolean
pm.cookies.toObject();          // { session: 'abc' }
```

`pm.cookies` is what the engine is holding *for this request's URL* - matched on
domain, path, `Secure` and expiry, exactly as it will be sent. It is what makes
"log in once, reuse the session" work: a `Set-Cookie` on one request is carried
to the next one automatically, with no header to set by hand.

- **One jar per environment**, plus one for requests sent with no environment
  selected. A staging session therefore cannot ride along on a production call
  even when both point at the same host - which cookies alone would not prevent,
  since they ignore the port and the scheme.
- **In memory only**, for as long as the engine runs. Nothing is written to
  disk: a stored jar is credential-grade material. Settings → General → Cookies
  shows every jar and clears them.
- **`pm.sendRequest` shares the jar** of the request it runs inside. A
  pre-request script that logs in through it leaves the session where the real
  request will find it.
- **Load runs have no jar.** These three throw there rather than answering
  `undefined`, which would read as "the cookie is gone". The jar is deliberately
  off the load path: sharing one across the event loop's workers would put a
  lock on the hot path, and a load run repeats a single request anyway.
- **Writing goes through `jar()`**, below. There is deliberately no flat
  `pm.cookies.set(name, value)`: a written cookie needs a URL to take its
  domain and path from, which is exactly why Postman's write half hangs off
  the jar object.

The jar is libcurl's own cookie engine underneath: matching, expiry and
replacement are its rules, not a second implementation of RFC 6265.

### Writing to the jar (`pm.cookies.jar()`)

```javascript
const jar = pm.cookies.jar();

jar.set(pm.request.url, { name: 'session', value: token });
jar.set(pm.request.url, 'session', token);            // the same, flat
jar.get('https://api.example.com/', 'session');        // value, or undefined
jar.unset('https://api.example.com/', 'session');
jar.clear();                                           // this environment's jar
```

Postman's jar object, whole. Every method is **URL-scoped** - it takes the URL
the cookie belongs to rather than assuming this request's - and each accepts an
optional trailing `callback(err, value)`, invoked inline the way
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest)'s is,
since the work has already happened by the time it is called. `get` also
*returns* the value, which a synchronous implementation can do honestly.

The cookie object needs `name` and `value`; everything else is optional and
defaults from the URL:

| Field | Default |
|-------|---------|
| `domain` | the URL's host, host-only. A leading dot (`.example.com`) means subdomains too |
| `path` | RFC 6265 default-path - the URL's path with its last segment removed, so `/v1/orders/42` gives `/v1/orders` |
| `secure`, `httpOnly` | `false` |
| `expires` | `0`, a session cookie. Otherwise **seconds since the epoch** - `Math.floor(date.getTime() / 1000)` |

Anything else is refused with an error rather than guessed at: a non-string
`value`, a `secure: "yes"`, a date string in `expires`, a field carrying a tab
or newline (the separators of the format the jar stores), or a URL that cannot
be parsed. A cookie stored under the wrong domain reads as "the session did not
stick" three requests later, which is a much worse afternoon than a thrown
error.

**A written cookie is matched by the same rules a received one is.** Setting it
for one host does not send it to another, `/admin` does not reach `/`, and the
jar's per-environment isolation holds - the write half is not a way around the
matching the read half respects.

**When the write takes effect.** A write is *staged*, not applied where it is
made, and the next transfer of that execution carries it:

- A `set` in a **pre-request script** rides the request it was made before, and
  that request's own cookie capture is what writes it into the jar. It cannot
  be discarded by that capture, which is the reason for the ordering: the
  engine replaces a scope's contents with what the finishing transfer held, so
  a write dropped into the jar beside an in-flight request would vanish with it.
- A `set` followed by **`pm.sendRequest`** is carried by that auxiliary
  request. A `set` *inside* a `sendRequest` callback is a sequential write -
  `pm.sendRequest` is synchronous, so the callback runs after its transfer
  finished and the write lands on the next one.
- A `set` in a **post-request script** has no transfer left to ride, so it is
  applied to the jar when the script ends.

`clear()` empties **this environment's jar and no other**. Nothing is on disk,
so the cost is a re-login; other environments, and the no-environment jar, are
untouched. There is no confirmation gate for scripts - "reset my session" is a
legitimate thing for a script to want, and Settings → General → Cookies shows
the result.

Load runs have no jar, so these throw there exactly as the read half does.

## Console Output

Log messages that appear in test results:

```javascript
console.log('Response:', pm.response.json());
console.info('Info message');
console.warn('Warning message');
console.error('Error message');
```

Objects and arrays are pretty-printed with `JSON.stringify(value, null, 2)`
rather than `[object Object]`; a value that cannot be serialized (a circular
reference, say) becomes `[Object: unserializable]`.

**The level travels with the line.** Each entry on the wire is
`{ "source": "pre" | "test", "level": "log" | "info" | "warn" | "error",
"message": "..." }` - see
[`consoleLogs` in the API reference](api-reference.md#post-execute). The four
methods are bound to one C function distinguished by QuickJS's `magic`
argument (`setup_console`), so the level is captured at the call; it cannot be
recovered from the text afterwards, which is why it used to be lost. The app's
Console tab draws `warn` and `error` in their status tokens and labels every
non-`log` line in a gutter.

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
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');
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

### Sign a request

`pm.crypto` gives a pre-request script a real HMAC, so the request it rewrites
can be signed for what it actually became:

```javascript
var timestamp = Date.now().toString();
var canonical = [
  pm.request.method,
  pm.request.url,
  timestamp,
  pm.request.body || ''
].join('\n');

pm.request.headers['X-Timestamp'] = timestamp;
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);
```

Note the ordering: the canonical string is built from `pm.request` *after* the
other edits, so it covers what is actually sent. If you sign first and rewrite
the body second, the signature describes a request that never existed.

**Signatures compared as base64** - Shopify's, for instance - only need a
different last argument:

```javascript
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical, 'base64');
```

#### Derived signing keys (AWS SigV4)

A scheme that chains HMACs cannot be expressed with text output alone: each
round is keyed by the **raw digest** of the previous one, and hex or base64 is a
different byte string. That is what the `'bytes'` encoding is for - it returns a
`Uint8Array`, which is also accepted as a key or as data:

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

A string contributes its **UTF-8** bytes - the same bytes the engine puts on the
wire, so a digest computed here matches one computed by `sha256sum` over the
same text. A `Uint8Array` contributes its bytes unchanged; that is the only way
to key an HMAC with bytes that are not valid UTF-8. Passing anything else (an
object, a number, `null`) throws rather than being stringified: hashing the text
`[object Object]` would return a digest that looks perfectly valid.

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

The sandbox is QuickJS plus `pm`, `console`, and the two base64 globals.
Available: `JSON`, `Date`, `Math`, `RegExp`, `String`, `Array`, `Object`,
`Number`, `Uint8Array`, `Promise`, `BigInt`, `encodeURIComponent`, `parseInt`
and the rest of the ES2020 built-ins, plus:

| Name | Shape |
| ---- | ----- |
| `pm.crypto.sha256(data, encoding?)` | SHA-256; `data` is a string (UTF-8) or `Uint8Array` |
| `pm.crypto.hmacSha256(key, data, encoding?)` | HMAC-SHA256; key and data take the same types |
| `pm.sendRequest(urlOrOptions, callback)` | Send an auxiliary request, synchronously - see [above](#sending-a-request-from-a-script-pmsendrequest) |
| `btoa(binaryString)` | base64-encode one byte per code unit |
| `atob(base64)` | decode to a binary string; throws on invalid base64 |

`encoding` is `'hex'` (the default), `'base64'`, `'base64url'` or `'bytes'`;
`'bytes'` returns a `Uint8Array`, and any other value throws rather than
silently falling back to hex.

**Not** available: `crypto` / `crypto.subtle`, `TextEncoder`, `URL`,
`URLSearchParams`, `setTimeout`, `require`, `fetch`. The practical
consequences: no URL parsing helper - which is why `pm.request.url` has no
`.query` / `.path` accessors either, see
[URL parts are not exposed](#url-parts-are-not-exposed-deferred) - no hash
other than SHA-256 (no MD5, no SHA-1, nothing asymmetric), and nothing
asynchronous. There is no `fetch`, but there **is**
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest), which is
synchronous and bounded rather than a Promise-returning stand-in.

**Why the hashing surface is not called `crypto`.** Web Crypto's `crypto.subtle`
is Promise-based. `Promise` exists here, but nothing drains the job queue - there
is no event loop and no `setTimeout` - so an `await crypto.subtle.digest(...)`
would never resume and the script would report a timeout rather than a result.
Vayu therefore takes a name of its own and is honestly synchronous. `btoa` and
`atob` keep their standard names because they are synchronous on the web too,
and they keep the rest of their semantics with them: they operate on **binary
strings**, one byte per code unit, so `btoa` throws on a code point above U+00FF
rather than silently UTF-8 encoding it.

Both halves of this list are pinned by tests in
`engine/tests/script_engine_test.cpp`, so if a global is ever added or removed
this section is what needs rewriting.

## Limitations

The **language** is current; what is missing is the **host environment**:

- **Modern syntax works.** Optional chaining (`?.`) and nullish coalescing
  (`??`) are ES2020 and supported, as are later additions like
  `Array.prototype.at`, `Object.hasOwn` and `String.prototype.replaceAll`. This
  section used to say the opposite, listing `?.` and `??` as "ES2021+" and
  unavailable - wrong on both counts, so any workaround written around that
  claim can go. What limits a script is the global list above, not the syntax.
- **No host globals**: no `setTimeout`, `fetch`, `URL`, `TextEncoder`,
  `structuredClone` or `crypto.subtle` - see the table above for what replaces
  the ones that have a replacement.
- **No Node.js APIs**: No `require()`, `fs`, `http`, etc.
- **Sandboxed**: No filesystem access. The only network access is
  [`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest) - capped at
  10 requests per script, bounded by the script's own deadline, and refused
  outright for agent-started runs.
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script (default), enforced by a wall-clock deadline - an
  infinite-loop script is aborted and reported as an error rather than hanging the
  engine. Configurable via the `scriptTimeout` setting (milliseconds); `0` disables
  the limit. The deadline is checked *between bytecode operations*, so it cannot
  interrupt a blocking call - which is why `pm.sendRequest` clamps its own
  timeout to the budget that is left rather than relying on it.

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` - method, url, headers and body - and the edits are
  applied to the request that is sent
  ([rules](#mutating-the-request-pre-request-scripts))
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Cannot access `pm.response` (request hasn't been sent yet)
- `pm.info.eventName` is `"prerequest"` here
- Run in Design Mode / Send only, not in load tests

### Test Scripts (Post-request)

- Execute after receiving the HTTP response
- Can access `pm.request` (read-only here - it has already been sent) and `pm.response`
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- `pm.info.eventName` is `"test"` here
- Test results are included in the response

### Load Test Scripts

- Test scripts in load tests are executed **deferred** (after test completion)
- Only a sample of responses are validated: 1 in `response_sample_rate`
  completions, retained up to `max_response_samples`. The retained set is a
  **uniform sample of the whole run**, not its opening - past the bound a later
  response displaces a uniformly chosen incumbent, so a target that starts
  failing halfway through is graded on those failures rather than on the healthy
  window before them
- `samplesTested` in the report (`TestsSampled`) is the **size of that sample**,
  not the run's request count, and `sampling.responseSamplesDropped` beside it
  says how many responses the bound thinned away
- Results are aggregated and reported in the final report
- `pm.info` reports the same identity a Send does: `eventName` is `"test"`, and
  `requestId` / `requestName` are the run's linked request when it has one. There
  is no `iteration` - the script runs per sampled response, not per iteration
  (a collection run does report one; see [`pm.info`](#script-identity-pminfo))
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
