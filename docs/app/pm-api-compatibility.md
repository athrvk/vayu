# `pm` Scripting API Compatibility

Vayu exposes a **Postman-compatible** `pm` scripting API for pre-request and test
scripts. Scripts run in the engine's QuickJS runtime
(`engine/src/runtime/script_engine.cpp`); the global `pm` object is bound there. The
intent is that the most common Postman scripts paste in and run unchanged.

> "Postman" is a trademark of Postman, Inc. Vayu is not affiliated with or endorsed by
> Postman. Vayu re-implements a compatible API surface (method names and behaviour);
> it does not ship Postman's code or documentation. References to Postman in code and
> docs are nominative ("compatible with…") only.

---

## Supported surface

| Group               | API                                                                              |
| ------------------- | -------------------------------------------------------------------------------- |
| Core                | `pm`, `pm.test(name, fn)`, `pm.expect(value)`                                    |
| Response            | `pm.response.code`, `.status`, `.responseTime`, `.headers`, `.json()`, `.text()`, `.reason()`, `.size()` |
| Response headers    | `pm.response.headers.get(name)`, `.has(name)` - case-insensitive              |
| Response cookies    | `pm.response.cookies` (array of `{ name, value, attrs }`), `.get(name)`, `.has(name)`, `.toObject()` - read-only, see below |
| Cookie jar          | `pm.cookies.get(name)`, `.has(name)`, `.toObject()` - the stored session for this URL; `pm.cookies.jar()` for `get`/`set`/`unset`/`clear`, see below |
| Response assertions | `pm.response.to.have.status(code)`, `.header(name)`, `.jsonBody()`, and the `pm.response.to.be.*` status classes below |
| Request             | `pm.request.url`, `.method`, `.headers`, `.body`                                 |
| Request headers     | `pm.request.headers.get/has(name)`, `.upsert({key, value})`, `.add({key, value})`, `.remove(name)` |
| Environment         | `pm.environment.get/set/has/unset/clear/toObject`                                |
| Globals             | `pm.globals.get/set/has/unset/clear/toObject`                                    |
| Collection vars     | `pm.collectionVariables.get/set/has/unset/clear/toObject`                        |
| Merged variables    | `pm.variables.get(name)`, `.has(name)`, `.toObject()`, `.replaceIn(template)` - read-only, see below |
| Script identity     | `pm.info.requestId`, `.requestName`, `.eventName` - each optional, see below     |
| Crypto              | `pm.crypto.sha256(data, encoding?)`, `.hmacSha256(key, data, encoding?)` - synchronous, see below |
| Send from script    | `pm.sendRequest(urlOrOptions, callback)` - synchronous, callback only, refused for agent-started runs, see below |
| Base64              | `btoa(binaryString)`, `atob(base64)` - globals, standard web semantics           |
| Console             | `console.log/info/warn/error`                                                    |

`pm.response.headers` is a plain object keyed by the **lower-cased** header name, not
Postman's `HeaderList` - but it carries `get()` / `has()`, and those are
case-insensitive the way HTTP header names are. Indexing is not, so
`headers['Content-Type']` reads back `undefined` while
`headers.get('Content-Type')` works (see [Header methods](#header-methods)).

A header name the server sent **twice** reads as a single value with the two
folded together by `", "` (RFC 7230 §3.2.2) - Postman's `HeaderList` would give
you two entries. That matters most for `Set-Cookie`, which servers routinely
send once per cookie: both cookies are there, in one string. Do not split that
string yourself - an `Expires=` value contains a comma of its own. Read
`pm.response.cookies`, which is the same header already parsed.

Variable writes persist to the scope they target (environment / collection / globals) and
participate in [variable resolution](./variable-resolution.md). Calling `set(name, value)`
on a variable that already exists updates only its value - the existing `secret` flag,
`enabled` flag and `type` are preserved. A `set` on a new name creates it with the defaults
(not secret, enabled, `type: "string"`). `unset(name)` removes it outright, which is not
the same as setting it to `""`: an emptied variable is still an enabled row that
`{{name}}` resolves to.

`get`, `has` and `toObject` read only **enabled** variables, so a row unticked in the
variables editor is invisible to a script; `unset` and `clear` remove it regardless.

`pm.variables` resolves a name across the scopes - environment, then collection, then
global - the same order `{{name}}` uses. It is read-only: **`pm.variables.set()` throws**,
because Postman writes it to a per-request *local* scope that Vayu does not have, and both
alternatives (persisting to the environment, or dropping the write) would misrepresent
what happened. The error names the three scoped setters. See
[scripting.md](../engine/scripting.md#variables-pmvariables).

### `{{templates}}` in scripts (`pm.variables.replaceIn`)

`pm.variables.replaceIn(template)` resolves `{{name}}` placeholders in a string
with the exact semantics the request's own URL/headers/body get at compose
time: scopes first (in `pm.variables`' precedence), then the dynamic-variable
table - so `{{$guid}}`, `{{$timestamp}}` and the `{{$random*}}` set generate a
fresh value **per occurrence**, an unknown `$name` keeps its braces, an
ordinary unknown name becomes `""`, and resolution is a single pass over the
raw stored strings.

```javascript
const id      = pm.variables.replaceIn("{{$guid}}");
const payload = pm.variables.replaceIn('{"user": "{{userId}}", "trace": "{{$guid}}"}');
```

This is the **only** way `{{...}}` works inside a script, and that is
deliberate (issue #226, decision D16): script *source* is never interpolated,
because a rewrite cannot tell code from a string literal and splicing variable
values into JavaScript is an injection. `replaceIn` keeps values as data the
script explicitly asked to resolve.

Two timing consequences worth knowing: the map is built **at call time**, so a
variable the script set a line earlier resolves (unlike `{{}}` in the URL,
which was composed before the script started); and the collection scope is the
script context's - the request's whole collection chain, leaf shadowing
ancestor, the same walk `pm.collectionVariables` does (#234). The argument must
be a string; anything else is a `TypeError` rather than a silently coerced
`"undefined"`.

### Script identity (`pm.info`) - three fields, all optional

`pm.info` is always an object; each field is present only when there is a
truthful value for it, so a script tests with `typeof` rather than assuming:

| Field | What it is | When it is `undefined` |
|---|---|---|
| `requestId` | The saved request the send is filed under | An ad-hoc request (MCP's `run_request` with no `requestId`, a load run started from a URL) |
| `requestName` | The request's name **as the client sent it** - the name in the editor, which for an unsaved edit differs from the stored row | A request with no name, and an ad-hoc one |
| `eventName` | `"prerequest"` in the Pre-request tab, `"test"` in the Tests tab | Never, for a script Vayu runs - both hooks set it |

```javascript
if (pm.info.eventName === "prerequest") {
    // one shared collection-level script, branching on where it runs
}
console.log("running " + (pm.info.requestName || "an unnamed request"));
```

`iteration` and `iterationCount` are **not** exposed, and that is a decision
rather than an omission (issue #300). Vayu has no collection runner: a load
test's Tests script runs **once per sampled response, after the run
finishes**, and samples are a reservoir rather than the first N iterations, so
any number reported there would not be an iteration count. They return when
there is a runner to count (issue #303).

### `pm.sendRequest` is synchronous, callback-only, and not available to agents

Three divergences from Postman, each for a reason the sandbox forces.

**No promise form.** Postman offers both a callback and a promise-returning
overload. Vayu ships only the callback, for the same reason `pm.crypto` is not
`crypto.subtle`: nothing drains the job queue, so the promise could only never
resolve. The callback is honoured **synchronously** - the send blocks and the
callback runs inline, before `pm.sendRequest` returns - so the call shape a
Postman user writes is unchanged and the semantics are honest.

```javascript
// Pre-request: fetch a token and put it where the request will find it.
pm.sendRequest(
	{
		url: "https://auth.example.com/token",
		method: "POST",
		header: { "Content-Type": "application/json" },
		body: { mode: "raw", raw: JSON.stringify({ client_id: "abc" }) },
	},
	function (err, res) {
		if (err) {
			return; // refused, DNS, or timeout - res is null
		}
		pm.environment.set("token", res.json().access_token);
	}
);
```

The callback receives `(err, res)`. A transport failure - connection refused, a
host that does not resolve, a timeout - is the network's answer rather than the
script's mistake, so it arrives as `err` (an `Error` carrying `.code`, e.g.
`TIMEOUT`) with `res` null. The script's own mistakes throw instead: an
unreadable argument, an unsupported body mode, the request cap, and the
capability being off. `res` carries `code`, `status`, `responseTime`,
`headers.get()/has()`, `json()` and `text()` - a subset of `pm.response`, with
no assertion chain. `status` is the numeric code there too, so the two objects
called a response do not disagree inside one sandbox.

**It is bounded, and both bounds throw.** The request's timeout is clamped to
whatever is left of the script's own time budget (`scriptTimeout`, 5s by
default), because QuickJS only checks its deadline *between* bytecode
operations - a blocking call never yields to it, so without the clamp a 5s
script would hold its thread for the request's 30s timeout. One script may
issue at most **10** requests; a load run's Tests script runs once per sampled
response, so an uncapped loop would turn post-run validation into minutes of
apparent hang.

**Agents cannot use it.** Vayu's MCP target allowlist is enforced in the MCP
server, against the composed URL, *before* it calls the engine - so a request
issued from inside a script never passes that gate. Rather than leave a hole in
a control the user configured in Settings, the engine refuses script-issued
requests unless the caller explicitly asks for them: Vayu's own Send and load
runs ask, and the MCP server never does. See
[`docs/engine/mcp.md`](../engine/mcp.md#the-script-sandbox-surface).

Only `raw` bodies are supported. Postman's `formdata` / `urlencoded` modes are
refused by name rather than sent as an empty body - serialise the payload
yourself and set the `Content-Type` header, which is the header that goes out
either way since no content type is inferred from the mode. Headers may be
Postman's `header` array of `{ key, value }` or a plain object under either
`header` or `headers`; sending both spellings at once is refused rather than
resolved by precedence.

`{{variables}}` in a script-supplied URL are **not** resolved. Interpolation
happens strictly before the pre-request script and a payload is resolved exactly
once; a second pass inside the script would break that. Use
`pm.variables.replaceIn(template)`.

### Hashing (`pm.crypto`) is Vayu's own name, and it is synchronous

Postman exposes **Web Crypto** globally (`crypto.subtle`), whose every method
returns a Promise. Vayu's sandbox has no event loop and no `setTimeout`, so
nothing drains the job queue: an `await crypto.subtle.digest(...)` would never
resume and the script would report a timeout rather than a result. Rather than
wear a familiar name with unfamiliar behaviour, the surface is `pm.crypto` and
it returns its result directly.

```javascript
pm.crypto.sha256('abc');                        // hex, 64 chars
pm.crypto.sha256('abc', 'base64');              // 'hex' | 'base64' | 'base64url' | 'bytes'
pm.crypto.hmacSha256(secret, canonicalString);  // hex by default
```

Strings are hashed as their **UTF-8** bytes. Pass a `Uint8Array` to hash bytes
directly, and ask for `'bytes'` to get one back - that is what multi-round key
derivation (AWS SigV4) needs, since each round is keyed by the raw digest of the
previous one. Anything that is neither a string nor a byte-sized typed array
throws: stringifying an object would hash the text `[object Object]` and return
a digest that looks perfectly valid.

`btoa` / `atob` keep their web semantics deliberately - they operate on **binary
strings**, one byte per code unit, so `btoa` throws on a code point above U+00FF
instead of silently UTF-8 encoding it. A signature over quietly-substituted
bytes verifies nowhere.

Not provided: `crypto`/`crypto.subtle` under those names, `TextEncoder`, MD5,
SHA-1, and any asymmetric algorithm. The engine-side detail is in
[scripting.md](../engine/scripting.md#what-a-script-can-compute).

### Assertion chains (`pm.expect`)

Chai-style chains on a `pm.expect(value)` expectation, implemented in the QuickJS
runtime. `pm.response.to` is a **separate** object: it answers only to the
response assertions in the table above and the status classes below, not to
these:

```
.to.equal(v)      .to.eql(v) / .to.eqls(v)             .to.deep.equal(v)
.to.exist         .to.be.true       .to.be.false
.to.be.null       .to.be.undefined  .to.be.ok          .to.be.empty
.to.be.above(n)   .to.be.below(n)   .to.be.at.least(n) .to.be.at.most(n)
.to.be.closeTo(v, delta)            .to.be.oneOf([…])
.to.be.a(type)    .to.be.an(type)   .to.be.instanceOf(Ctor)
.to.have.property(name[, v])        .to.have.nested.property('a.b[0].c'[, v])
.to.have.length(n)                  .to.have.lengthOf(n)
.to.have.keys(…) / .to.have.key(k)  .to.have.members([…])
.to.include(v)    .to.contain(v)    .to.have.string(sub)
.to.match(/regex/)                  .to.satisfy(fn)
.to.throw([msg | /regex/]) / .to.throws(…)
.to.not …         (negates the chain)
.deep …           (deep comparison for equal / include / property / members / oneOf)
.nested …         (dotted or indexed path for property)
.and …            (continues a chain; flags, `not` included, carry over)
.all …            (accepted before .keys, chai's default, changes nothing)
```

**`equal` is `===`; `eql` (and `deep.equal`) is deep.** So
`expect({a:1}).to.equal({a:1})` **fails** - different references - and
`expect({a:1,b:2}).to.eql({b:2,a:1})` **passes**: key order is not part of deep
equality. `include`, `property(name, value)`, `members` and `oneOf` compare
strictly too, unless a `deep` appears in the chain.

`have.keys` asserts *exactly* those keys. `Map` / `Set` / typed arrays are
reported unequal by `eql` rather than compared (their contents are not
properties); `Date` compares by instant, `RegExp` by pattern; a cyclic value
raises a `RangeError` after 64 levels rather than hanging.

### Response status classes (`pm.response.to.be`)

Getters, so the paren-less form is the assertion:

```
.to.be.ok          .to.be.success       (2xx)
.to.be.info        (1xx)                .to.be.redirection   (3xx)
.to.be.clientError (4xx)                .to.be.serverError   (5xx)
.to.be.error       (4xx or 5xx)
.to.be.accepted    (202)                .to.be.badRequest    (400)
.to.be.unauthorized(401)                .to.be.forbidden     (403)
.to.be.notFound    (404)                .to.be.rateLimited   (429)
.to.be.json        (body parses as JSON)
.to.be.withBody    (body is not empty)
```

**Every other name under `pm.response.to` throws a `TypeError`** naming the
chain - a misspelling, or an idiom Vayu does not implement such as the negated
`pm.response.to.not.be.ok`. This is deliberate: a paren-less assertion is an
expression statement, so a name that merely evaluated to `undefined` would
report PASS against a broken API.

### Response cookies (`pm.response.cookies`)

```javascript
pm.response.cookies.get('session');   // value, or undefined
pm.response.cookies.has('session');   // boolean
pm.response.cookies.toObject();       // { session: 'abc' }
pm.response.cookies[0].attrs;         // ['Path=/', 'HttpOnly'] - raw chunks
```

An array of `{ name, value, attrs }` in wire order, parsed from that one
response's `Set-Cookie`. It is **not** Postman's `CookieList` and its entries
are not `postman-collection` `Cookie` objects: there is no `key`, no `path`,
no `secure`, no `expires`, because those fields would restate the attribute
string rather than report what the engine holds - the jar itself is
[`pm.cookies`](#the-cookie-jar-pmcookies). `attrs` is that string, split on `;`
and untouched otherwise.

Three divergences worth knowing before porting a script:

- **This is the response, not the session.** What will actually be sent next
  time is `pm.cookies`; this reports what this one response set, expired
  cookies included.
- **Names are case-sensitive**, unlike header names - `get('SESSION')` does not
  find the `session` cookie. RFC 6265 says they differ, and answering anyway
  would be a wrong value dressed as a right one.
- **A repeated name answers with its last value** from `get()` / `toObject()`,
  which is the one a browser's jar would keep, while the array still lists both.

The parse is shared with the response Cookies tab in the UI through
`engine/tests/fixtures/set-cookie-conformance.json`, so a cookie cannot read one
way on screen and another in a script.

### The cookie jar (`pm.cookies`)

```javascript
pm.cookies.get('session');   // value, or undefined
pm.cookies.has('session');   // boolean
pm.cookies.toObject();       // { session: 'abc' }
```

The read half of Postman's `pm.cookies`, over a jar the engine keeps for
design-mode requests: a `Set-Cookie` on one request is sent on the next one
automatically. What these answer is matched against **this request's URL** -
domain, path, `Secure` and expiry - so they report what will go on the wire and
not everything stored.

The write half is `pm.cookies.jar()`, Postman's own jar object:

```javascript
const jar = pm.cookies.jar();
jar.set(pm.request.url, { name: 'session', value: token });  // or (url, name, value)
jar.get('https://api.example.com/', 'session');              // value, or undefined
jar.unset('https://api.example.com/', 'session');
jar.clear();                                                 // this environment's jar
```

Every method is URL-scoped and takes an optional trailing `callback(err, value)`,
invoked inline. A written cookie's `domain` and `path` default from the URL, and
it is then matched by exactly the rules a received cookie is.

Divergences from Postman:

- **No flat `pm.cookies.set(name, value)`.** Only the `jar()` form ships: a
  written cookie needs a URL to take its domain and path from, which is why
  Postman's own write half lives on the jar object.
- **A write is applied after the transfer it was made before**, not the moment
  it is called - so it rides that request and cannot be lost when the response's
  cookies are captured. Details in
  [scripting.md](../engine/scripting.md#writing-to-the-jar-pmcookiesjar).
- **`jar.clear()` takes no URL** and empties this environment's jar. Postman's
  clears per URL; Vayu's scope is the environment, so that is the unit here.
- **`expires` is seconds since the epoch**, not a date string.
- **Scope is the environment**, not the domain-with-permission model Postman
  uses. One jar per environment plus one for "no environment", in memory only,
  clearable in Settings → General → Cookies.
- **`pm.sendRequest` shares the jar** with the request around it, so logging in
  from a pre-request script leaves the session where the real request finds it.
- **Load runs have no jar**, and these throw there rather than answering
  `undefined` - see [scripting.md](../engine/scripting.md#the-cookie-jar-pmcookies).

---

## Not (yet) supported

These Postman APIs are **not** implemented - scripts that rely on them will fail:

- `pm.variables.set(...)` - throws; Vayu has no local scope to write to, so name
  one of the three scoped setters instead. The read half (`get`/`has`/`toObject`)
  is supported - see above
- `replaceIn(...)` on the **scoped** accessors (`pm.environment.replaceIn`,
  `pm.globals.replaceIn`, `pm.collectionVariables.replaceIn`) - only the merged
  `pm.variables.replaceIn(template)` exists (see below), and it answers with
  the same precedence `{{name}}` uses, which is what a template means everywhere
  else in Vayu
- `pm.environment.name` - the active environment's name
- **Dynamic variables via `pm.variables.get("$guid")`** - the *getter* does not
  fall through to the generator table; only `{{…}}` templates reach it. A script
  wanting a generated value uses `pm.variables.replaceIn("{{$guid}}")` (see
  below) or writes the JavaScript for it. The supported set and the reasoning
  are in [variable resolution](./variable-resolution.md#dynamic-variables)
- `pm.iterationData.*` - data-file driven runs, and with them
  `pm.info.iteration` / `pm.info.iterationCount` (see
  [above](#script-identity-pminfo---three-fields-all-optional))
- `pm.cookies.set(...)` / `.unset(...)` / `.clear()` - the *flat* write half.
  Writing goes through `pm.cookies.jar()`, which ships whole - see
  [above](#the-cookie-jar-pmcookies)
- `pm.request.url.query` / `.path` / `.host` - and any other `url.*` accessor.
  `pm.request.url` is a writable **string** that the write-back requires to still
  be one, and a JS string primitive cannot carry properties; boxing it would
  reject every request. A separate accessor (`pm.request.getUrlParts()`-shaped)
  could work, but that shape has not been decided, so URL parsing is string work
  today. Deferred deliberately - see
  [scripting.md](../engine/scripting.md#url-parts-are-not-exposed-deferred).
- `pm.execution` (flow control), `pm.visualizer`
- The `tests["name"] = bool` legacy assertion style (use `pm.test`)
- Chai matchers outside the list above: `.include.keys` (the subset form),
  `.any.keys`, `.change`/`.increase`/`.decrease`, `.own.property`, `.respondTo`,
  and the `require()`-able libraries (`chai`, `lodash`, `moment`, …). Each throws
  a `TypeError` rather than reporting a pass

---

## Request mutation & URL variables

A **pre-request** script can change the outgoing request. `pm.request`'s `url` /
`method` / `headers` / `body` are copied out of the C++ `Request` into a plain JS object
(`script_engine.cpp`, `setup_pm_request`), and after the script returns that object is read
back and applied to the same `Request` before `client.send()`
(`apply_pm_request_writeback`). In a **test** script it stays a read-only record: the
request has already gone out, so nothing is written back and a mutation there is discarded.

```javascript
pm.request.headers['X-Signature'] = sign(pm.request.body);
delete pm.request.headers['Authorization'];
pm.request.url = 'https://api.example.com/v2/users';
pm.request.method = 'POST';
pm.request.body = JSON.stringify({ n: 2 });
```

- **The object is authoritative, not a diff.** Whatever `pm.request.headers` holds at the
  end is the header set that is sent, which is what makes `delete` remove a header the
  engine applied.
- **The script wins over engine-applied auth.** `build_request` resolves auth into the
  request before the script runs, so a script-set `Authorization` replaces the resolved one.
- **A value the engine cannot send is refused, not coerced.** `url`/`method`/`body` must be
  strings (`method` one of the seven verbs); a header value may be a string, number or
  boolean. Anything else rejects the whole write-back - all or nothing - and surfaces as
  `preScriptError`, which the response pane's Console tab shows.
- **`body` is a string for every mode, including the two that store fields.** A
  `x-www-form-urlencoded` or `form-data` body reads as its **enabled** fields encoded
  `key=value&…` rather than as `""` - the empty string a `content`-only read used to give,
  which no script could tell apart from a request with no body. For urlencoded that string
  *is* the wire body and an assignment parses back into the fields; for `form-data` it is a
  rendering of the parts, because the multipart bytes carry a boundary libcurl generates at
  transfer time - so an assignment there is **refused with a named error** rather than
  written to a body the transfer layer would ignore. Full table in
  [scripting.md](../engine/scripting.md#request-object-pmrequest). Reading a form body
  never rewrites it: an unchanged string means untouched.
- **Setting a variable still does not re-render the URL.** `{{…}}` placeholders are resolved
  at **compose time** (`POST /compose`, engine-side since #226), whereas the
  pre-request script runs **later**, at execute. So `pm.environment.set("host", …)` with
  a `{{host}}` in the URL affects subsequent runs only - assign `pm.request.url` to change
  this one. Keeping this order (rather than adopting Postman's script-first one) was
  #226's decision D1: today's semantics preserved, divergence documented.
- **Load tests do not run pre-request scripts** at all, so this is a Send / Design Mode
  capability.

This goes **further than Postman** on the URL, method and body, which Postman's docs mark
immutable or provide no mutators for.

### Header methods

Both header objects carry `get(name)` and `has(name)`; `pm.request.headers` also carries
`upsert`, `add` and `remove`. They are **non-enumerable properties of the header object
itself**, which is what makes them safe: `apply_pm_request_writeback` reads that object's
own *enumerable* string properties as the outgoing header set, so an enumerable method
would be read as a header whose value is a function and would fail the whole write-back.
Being on the same object is also what makes a method call and a plain assignment agree -
there is one property set, not two views of one.

```javascript
pm.request.headers.get('authorization');                  // case-insensitive
pm.request.headers.has('Authorization');
pm.request.headers.upsert({ key: 'X-Trace', value: id }); // or ('X-Trace', id)
pm.request.headers.add({ key: 'X-New', value: '1' });     // throws if already set
pm.request.headers.remove('Authorization');               // no-op if absent
```

Three deliberate divergences from Postman:

- **The methods are case-insensitive, indexing is not.** `upsert('authorization', v)`
  replaces an existing `Authorization` instead of adding a second spelling - which the
  write-back would refuse as a clash, since `Headers` is a case-insensitive map.
- **`add` refuses a name that is already present** and names `upsert` in the error.
  Postman's `HeaderList` holds duplicates and `add` appends one; a single-valued
  `Headers` map cannot represent that, and silently behaving as `upsert` would hide the
  difference rather than report it.
- **A header field literally named `get`/`has`/`add`/`upsert`/`remove` wins.** Entries are
  *defined* over the method, attributes included, so the header still reaches the wire
  and the shadowed method throws loudly. A dropped header would be the worse failure.

Bad input fails loudly: a name must be a non-empty string, a value a string, number or
boolean (the set plain assignment already accepts), and calling a method detached from
its object throws rather than answering as though the header were missing.

### TODO (future)

"Set a variable in a pre-request script and have it change the outgoing URL" still does not
work. Resolution ownership *did* move into the engine (#226 - `POST /compose`
interpolates), but interpolation deliberately stayed **before** the pre-request
script (decision D1: today's semantics, not Postman's script-first order).
Adopting Postman's order is now an engine-side re-ordering rather than an
ownership change - possible, but a separate, deliberate compatibility decision
with its own tests.

---

## Editor autocomplete

The full completion set (labels, snippets, signatures, docs) is generated server-side by
the engine and served at `GET /scripting/completions`
(`engine/src/http/routes/scripting.cpp`). This endpoint is the **single source of truth**
for what the editor advertises, and it is fetched once on startup and cached
(`app/src/queries/script-completions.ts`).

The script editors are mounted via the shared `CodeEditor`
(`app/src/components/ui/code-editor.tsx`) with `language="javascript"`.
`useScriptCompletionProvider` (`app/src/hooks/useScriptCompletionProvider.ts`, called once
in `App`) registers the cached completions with Monaco's JavaScript language via
`registerCompletionItemProvider` (trigger character `.`), so typing `pm.` surfaces the
`pm.*` entries and snippets alongside Monaco's built-in JavaScript IntelliSense. The
registration is global per language, so one call covers every script editor instance.

> The `kind` field on each completion uses `monaco.languages.CompletionItemKind` numeric
> values (Function = 1, Field = 3, Variable = 4, Snippet = 28); changing the engine
> constants requires an engine rebuild for new icons to take effect.

### Type declarations (hover, signature help)

A completion list can only fill a dropdown. Hover documentation over an existing call and
signature help while typing arguments come from Monaco's **TypeScript worker**, which
wants a `.d.ts` - served at `GET /scripting/types` and **generated from the same
completion table**, so the surface stays declared once. `useScriptTypeDefinitions`
(`app/src/hooks/useScriptTypeDefinitions.ts`, called once in `App`) registers it with
`addExtraLib`.

It also configures the worker to match the sandbox: `lib: ["es2022"]` with **no `dom`**,
because the runtime has no `fetch`, `setTimeout` or `URL` and the editor must not offer
them; and `target: ESNext`, because ES2020 would flag `Object.hasOwn` and
`Array.prototype.at`, which quickjs-ng runs fine (see `docs/engine/scripting.md`).

**Semantic diagnostics are on**, which is what makes `pm.response.staus` squiggle with a
"Did you mean 'status'?" - and, through the same analysis, what makes quick fixes, rename,
find-references and go-to-definition work inside a script. Those providers all default to
enabled in Monaco; `useScriptTypeDefinitions` sets them explicitly so a changed default
cannot remove them silently.

Exactly two diagnostics are suppressed (`diagnosticCodesToIgnore`), because a *correct*
script in this editor produces them. Both follow from the editor holding a fragment while
the engine runs something larger:

| Code | Message | Why it is wrong here |
|------|---------|----------------------|
| `1108` | A `return` statement can only be used within a function body | The engine wraps every script in an IIFE before running it, so a top-level `return` to bail out early is legal |
| `2304` | Cannot find name `x` | A collection-level script part is joined to the request's (with `\n\n`) before the engine runs the result, so a name declared there is undeclared as far as this model can see |

Suppressing `2304` would normally cost the best diagnostic of all - `fetch` and
`setTimeout`, which the sandbox does not have. It does not, because the engine **declares
the globals it lacks** as `never` (`ABSENT_GLOBALS` in `script_types.cpp`): calling one is
"not callable" rather than "cannot find name", and hover explains why. That list is held
to the runtime by a test that executes `typeof <name>` in the real script engine for every
entry - it caught `queueMicrotask`, which quickjs-ng does provide, on its first run.

Narrow that suppression list rather than widening it: each code on it is a real mistake
going unreported in exchange for not crying wolf on correct code.

### The second consumer: MCP agents

The completion set is no longer only an editor concern. An MCP agent writes scripts too -
`run_request` takes a `preRequestScript` and both it and `start_load_run` take a
`postRequestScript` - and it reaches the same sandbox, since the sandbox belongs to the
engine and has no per-client gate.

So the MCP server re-serves this endpoint as the `vayu://scripting/completions` resource
(`app/electron/mcp/resources.ts`), trimmed to `label` / `detail` / `documentation` - see
[`docs/engine/mcp.md`](../engine/mcp.md#the-script-sandbox-surface). The reason it reads
the endpoint rather than describing the surface in its own prose is the one this page
already demonstrates: a hand-written copy drifts, and the app's own pre-request quick
reference had drifted into claiming "No crypto, base64 or `URL` in the sandbox" before
`pm.crypto` landed. Adding a name to the completion table therefore reaches Monaco, the
`.d.ts` and every agent at once - do not add a fourth place that lists `pm.*` names.

---

## Where it lives

| Concern                         | Location                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm` runtime (QuickJS bindings) | `engine/src/runtime/script_engine.cpp`                                                                                                                  |
| Completion metadata endpoint    | `engine/src/http/routes/scripting.cpp`                                                                                                                  |
| Type declaration generator      | `engine/src/http/routes/script_types.cpp`                                                                                                               |
| Type declaration fetch + cache  | `app/src/queries/script-types.ts`                                                                                                                       |
| Monaco type registration        | `app/src/hooks/useScriptTypeDefinitions.ts`                                                                                                             |
| Completion fetch + cache        | `app/src/queries/script-completions.ts`                                                                                                                 |
| Monaco completion provider      | `app/src/hooks/useScriptCompletionProvider.ts`                                                                                                          |
| Shared editor wrapper           | `app/src/components/ui/code-editor.tsx`                                                                                                                 |
| Script editor panels            | `app/src/modules/request-builder/components/RequestTabs/panels/{Pre,Test}ScriptPanel.tsx`, `app/src/modules/collections/CollectionDetail/ScriptTab.tsx` |
