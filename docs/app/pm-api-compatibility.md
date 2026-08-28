---
description: >-
  Which Postman pm.* scripting APIs Vayu supports - pm.test, pm.expect, pm.environment, pm.response and the rest, with the gaps named.
---

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
| Core                | `pm`, `pm.test(name, fn)` - in either script, each result naming the one that made it (see below), `pm.expect(value[, message])` - the message prefixes the failure, as in chai |
| Response            | `pm.response.code`, `.status`, `.responseTime`, `.headers`, `.json()`, `.text()`, `.reason()`, `.size()` |
| Response headers    | `pm.response.headers.get(name)`, `.has(name[, value])` - case-insensitive; the value compare is strict; `.each(fn, thisArg?)`, `.all()`, `.count()`, `.toObject(excludeDisabled?, caseSensitive?)`, `.one(name)`, `.indexOf(name)` - the read half of a Postman `PropertyList`, see [Header methods](#header-methods) |
| Response cookies    | `pm.response.cookies` (array of `{ name, value, attrs }`), `.get(name)`, `.has(name)`, `.toObject()` - read-only, see below |
| Streamed events     | `pm.response.events` (array of `{ event, id, data }`), `.totalEvents`, `.eventsTruncated` - a streaming request only, see below. **Vayu-specific** |
| Cookie jar          | `pm.cookies.get(name)`, `.has(name)`, `.toObject()`, `.each(fn)`, `.all()`, `.count()` - the stored session for this URL; `pm.cookies.jar()` for `get`/`getAll`/`set`/`unset`/`clear(url?)`, see below |
| Response assertions | `pm.response.to.have.status(code \| reason)`, `.header(name[, value])`, `.body(expected)`, `.jsonBody(path?[, value])`, and the `pm.response.to.be.*` status classes below |
| Request             | `pm.request.url` (Postman's `Url` object - `protocol`/`host`/`port`/`path`/`hash`/`query`, `getHost()`, `getPath()`, `getQueryString()`, `update()`), `.method`, `.headers`, `.body` |
| Request headers     | `pm.request.headers.get(name)`, `.has(name[, value])`, `.upsert({key, value})`, `.add({key, value})`, `.remove(name)`, `.each(fn, thisArg?)`, `.all()`, `.count()`, `.toObject(excludeDisabled?, caseSensitive?)`, `.one(name)`, `.indexOf(name)` |
| Environment         | `pm.environment.get/set/has/unset/clear/toObject`                                |
| Globals             | `pm.globals.get/set/has/unset/clear/toObject`                                    |
| Collection vars     | `pm.collectionVariables.get/set/has/unset/clear/toObject`                        |
| Merged variables    | `pm.variables.get(name)`, `.has(name)`, `.toObject()`, `.replaceIn(template)` - read-only, a bound row's bare column names first, see below |
| Script identity     | `pm.info.requestId`, `.requestName`, `.eventName`, `.iteration`, `.vu`, `.iterationCount` - each optional, see below |
| Crypto              | `pm.crypto.sha256(data, encoding?)`, `.hmacSha256(key, data, encoding?)` - synchronous, see below |
| Send from script    | `pm.sendRequest(urlOrOptions, callback)` - synchronous, callback only, refused for agent-started runs, see below |
| Flow control        | `pm.execution.setNextRequest(name \| null)`, `.skipRequest()` - collection runs only, see below |
| Data rows           | `pm.iterationData.get(name)`, `.has(name)`, `.toObject()` - read-only, a data-driven collection run, a send-with-row, or a scenario load run's deferred per-step script, see below |
| Base64              | `btoa(binaryString)`, `atob(base64)` - globals, standard web semantics           |
| Console             | `console.log/info/warn/error`                                                    |

`pm.response.headers` is a plain object keyed by the **lower-cased** header name, not
Postman's `HeaderList` - but it carries `get()` / `has()` plus the read half of a
Postman `PropertyList`: `each()`, `all()`, `count()`, `toObject()`, `one()` and
`indexOf()`. Every one of them that takes a header name matches it the way HTTP
header names work - case-insensitively. Indexing is not, so
`headers['Content-Type']` reads back `undefined` while
`headers.get('Content-Type')` works (see [Header methods](#header-methods)).

A header name the server sent **twice** reads as a single value with the two
folded together by `", "` (RFC 7230 §3.2.2) - Postman's `HeaderList` would give
you two entries. That matters most for `Set-Cookie`, which servers routinely
send once per cookie: both cookies are there, in one string. Do not split that
string yourself - an `Expires=` value contains a comma of its own. Read
`pm.response.cookies`, which is the same header already parsed.

**`all()` reports the object's key order, not wire order, and can never report
a duplicate** the way Postman's `HeaderList` does - a name sent twice is
already the one folded entry above by the time any script sees it, so there is
only ever one member for `all()` to report for it.

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
global - the same order `{{name}}` uses. **While a data row is bound, that row's bare
column names answer first, above all three scopes** (issue #1007): `get`, `has` and
`toObject` check the row before the environment, so `pm.variables.get("username")` reads
the current iteration's `username` cell rather than a same-named environment variable -
Postman's own precedence for a dataset's columns. `get` and `toObject` hand back the
row's value **typed**, exactly as `pm.iterationData.get` does (a number column reads as a
number); a column the row does not carry falls through to the three scopes as an ordinary
name, not a failed bind. With no row bound, `pm.variables` behaves exactly as before. It
is read-only: **`pm.variables.set()` throws**,
because Postman writes it to a per-request *local* scope that Vayu does not have, and both
alternatives (persisting to the environment, or dropping the write) would misrepresent
what happened. The error names the three scoped setters. See
[scripting.md](../engine/scripting.md#variables-pmvariables).

### `{{templates}}` in scripts (`pm.variables.replaceIn`)

`pm.variables.replaceIn(template)` resolves `{{name}}` placeholders in a string
with the exact semantics the request's own URL/headers/body get at compose
time: scopes first (in `pm.variables`' precedence), then the dynamic-variable
table - so `{{$guid}}`, `{{$timestamp}}` and the `{{$random*}}` set generate a
fresh value **per occurrence**, a name nothing defines keeps its braces
(`$name` and ordinary alike, issue #1009), and a value that itself holds
`{{tokens}}` resolves through them to a bounded depth, cycles left literal.
Always over the raw stored strings.

```javascript
const id      = pm.variables.replaceIn("{{$guid}}");
const payload = pm.variables.replaceIn('{"user": "{{userId}}", "trace": "{{$guid}}"}');
```

**`{{data.column}}` resolves here too** (issue #890), against the row bound to
this iteration - the same row `pm.iterationData` reads. It did not before, and
that made this the one template resolver in the product that disagreed with the
others about what the token means: a URL, a header and a body all bind it, and
handing the same string to `replaceIn` returned it with its braces still on.

```javascript
// In a data-driven run, with a row carrying userId and city:
pm.variables.replaceIn("/users/{{data.userId}}"); // "/users/1001"
```

**A bare column name resolves here too** (issue #1007), at the same
above-the-environment position `pm.variables.get` reads it at:
`pm.variables.replaceIn("{{userId}}")` reads the bound row's `userId` cell
before it reads any scope. Unlike the reserved spelling, a bare name the row
does not carry is **not** an error here either - it falls through to the
scopes exactly as `pm.variables.get` does, which is what keeps one script's
`replaceIn` calls working whether or not a request happens to share a name
with a column.

Three rules come with `{{data.column}}` specifically, all of them the ones the
request binding already follows:

- **A column the row does not have is a `TypeError`**, naming the token and the
  columns the row does have - not `""` and not the token verbatim. The token
  says the value came from the file, so a name no column answers is a mistake
  about the column, and both quiet answers hide it. This refusal is the
  prefixed spelling's alone - a bare name that misses falls through instead, as
  above.
- **With no row bound the token keeps its braces**, unchanged - true of both
  spellings. A plain design send has no row by design, so a shared script that
  guards with `pm.iterationData` still runs in both modes.
- **The prefixed `data.` spelling is still not a variable scope.**
  `pm.variables.get("data.userId")` and `.has(...)` remain `undefined` / `false`;
  the row's accessor for it is `pm.iterationData`. `replaceIn` is different in
  kind - it resolves a template, and `{{data.userId}}` is a token template
  syntax has. **A bare column name is not the same question** (issue #1007):
  `pm.variables.get("userId")` *does* read the bound row - see above - so
  `replaceIn("{{userId}}")` and `pm.variables.get("userId")` agree with each
  other the same way `replaceIn("{{data.userId}}")` and `pm.iterationData` do.

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

### Script identity (`pm.info`) - six fields, all optional

`pm.info` is always an object; each field is present only when there is a
truthful value for it, so a script tests with `typeof` rather than assuming:

| Field | What it is | When it is `undefined` |
|---|---|---|
| `requestId` | The saved request the send is filed under | An ad-hoc request (MCP's `run_request` with no `requestId`, a load run started from a URL) |
| `requestName` | The request's name **as the client sent it** - the name in the editor, which for an unsaved edit differs from the stored row | A request with no name, and an ad-hoc one |
| `eventName` | `"prerequest"` in the Pre-request tab, `"test"` in the Tests tab | Never, for a script Vayu runs - both hooks set it |
| `iteration` | The 0-based pass this response was sent in - a collection run's pass, or the iteration a load run's sampled response carried | A single Send, which is one request rather than a pass of anything |
| `vu` | The 1-based virtual user that sent it. Spans the concurrency in a collection load run; `1` everywhere else, because one request repeated is one user's iterations | A single Send |
| `iterationCount` | How many passes that run will make | Anywhere but a collection run |

```javascript
if (pm.info.eventName === "prerequest") {
    // one shared collection-level script, branching on where it runs
}
console.log("running " + (pm.info.requestName || "an unnamed request"));
```

`iterationCount` is set by the **collection runner and by nothing else**: a
duration-bounded load run has no total to report, and a field readable from one
mode and not another is worse than one that is never readable at all.

`iteration` and `vu` are reported by every run, load runs included (issue #994).
That is not a reversal of issue #300's ruling but the case it excluded: what
#300 refused was reporting a *reservoir position* as an iteration number, and
neither of these is one - a load run's submission claims its iteration and its
virtual user before it is sent, and both travel with the response into the
sample, exactly as the bound data row does. A single Send reads `undefined` for
both.

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
`headers` with `get()`/`has()`/`each()`/`all()`/`count()`/`toObject()`/`one()`/
`indexOf()` - the same read methods as `pm.response.headers` - `json()` and
`text()`, a subset of `pm.response` with no assertion chain. `status` is the
numeric code there too, so the two objects called a response do not disagree
inside one sandbox.

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

`{{variables}}` in the script-supplied URL, header values, a raw body and an
`auth` credential **are** resolved, as the call is made (issue #1001) - so a
value the same script set two lines earlier is visible, which is Postman's rule
and the reason an imported token-refresh script works. This is not a second pass
over the composed payload: those fields were composed once, before the script
ran, and nothing here revisits them. A name nothing defines keeps its braces
rather than becoming empty, as everywhere else. Header *names* are sent as
written - two that resolve to one name are a collision rule composition owns
(issue #1051), and a second answer to it invented here would be one more place
for the two to drift.

`auth` takes Postman's `{ type, <type>: params }` shape, with the parameter block
in either spelling - the exported `[{ key, value }]` array or a plain object.
`basic`, `bearer` and `apikey` are composed by the engine's own auth resolver,
the same one `POST /execute` sends through, so an api key sent as a query
parameter is percent-encoded onto the URL exactly as it would be on the main
request and an `Authorization` header the script set itself still wins. Every
other type - `oauth2` included, whose token acquisition needs a database this
path deliberately does not carry - is refused by name rather than dropped, and so
is a type whose parameter block is absent or misspelled, since `basic` requires
neither of its halves and would otherwise compose an empty credential and send
it. A request that goes out unauthenticated because the sandbox skipped an option
is the same silent wrong request the body modes are refused to prevent.

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

### `pm.test` runs in either script, and every result says which

Postman's does, and so does Vayu's: a pre-request script may assert, and the
usual reason is a
[`pm.sendRequest`](#pmsendrequest-is-synchronous-callback-only-and-not-available-to-agents)
it just made - a token fetch that answered `401`, a fixture that is not there -
which is worth catching before the request goes out.

Both phases' assertions are reported together, in execution order, each entry
carrying `source: "pre" | "test"` (issue #810). The Tests pane groups the list
under the script's name, because an assertion made *before* the request is a
different claim from one about the response. A failing assertion fails its
collection-run step whichever script made it, which was already true while the
list showed the test script's alone - the step was failed by an assertion
nothing named. A result restored from a run stored before that carries no
`source` and reads as the test script's.

**A load test runs no pre-request script** (only the `tests` one), so there is
nothing to assert there before the request.

### Assertion chains (`pm.expect`)

Chai-style chains on a `pm.expect(value)` expectation, implemented in the QuickJS
runtime. `pm.response.to` is a **separate** object: it answers only to the
response assertions in the table above and the status classes below, not to
these:

```
.to.equal(v)      .to.eql(v) / .to.eqls(v)             .to.deep.equal(v)
.to.exist         .to.be.true       .to.be.false
.to.be.null       .to.be.undefined  .to.be.ok          .to.be.empty
.to.be.NaN
.to.be.above(n)   .to.be.below(n)   .to.be.at.least(n) .to.be.at.most(n)
                  (each takes a number or a Date on both sides, never a coercion)
.to.be.closeTo(v, delta)            .to.be.oneOf([…])
.to.be.a(type)    .to.be.an(type)   .to.be.instanceOf(Ctor)
.to.have.property(name[, v])        .to.have.nested.property('a.b[0].c'[, v])
.to.have.length(n)                  .to.have.lengthOf(n)
.to.have.keys(…) / .to.have.key(k)  .to.have.members([…])
.to.include(v)    .to.contain(v)    .to.have.string(sub)
.to.match(/regex/)                  .to.satisfy(fn)
.to.throw([Ctor | msg | /regex/][, msg | /regex/]) / .to.throws(…)
                  (a string or pattern is matched against err.message)
.to.not …         (sets the negation for the rest of the chain; a second
                   .not in one chain is a no-op, not a double negative)
.deep …           (deep comparison for equal / include / property / members / oneOf)
.nested …         (dotted or indexed path for property)
.and …            (continues a chain; flags, `not` included, carry over)
.all …            (accepted before .keys, chai's default, changes nothing)
.that … .which … .is … .has … .been … .with …
.does … .but … .also … .of … .same … .still …
                  (chai's language chains: they assert nothing and read as
                   English, and carry the chain's flags like .and)
```

**`equal` is `===`; `eql` (and `deep.equal`) is deep.** So
`expect({a:1}).to.equal({a:1})` **fails** - different references - and
`expect({a:1,b:2}).to.eql({b:2,a:1})` **passes**: key order is not part of deep
equality. `include`, `property(name, value)`, `members` and `oneOf` compare
strictly too, unless a `deep` appears in the chain. The one place the two
libraries Vayu answers for disagree is the pair `+0` / `-0`: `eql` separates
them (deep-eql's `1/x` rule) while the response assertions in the table above
compare them equal, because chai-postman runs on lodash `_.isEqual`.

**`include` on an object target is a subset match**, as in chai: every key of
the argument must be on the target with an equal value. Any target other than a
string or an array takes an *object* argument, so `expect({a:1}).to.include('a')`
and `expect(5).to.include('x')` are both a `TypeError` - the combination chai
refuses rather than answers. Vayu is stricter than chai in three places, each
because chai's answer there is a silent non-assertion or a quiet wrong verdict:
an expectation carrying no own enumerable keys is refused (`to.include({})`, a
`Date`, a `RegExp`, a function - chai passes all of them, in both directions,
having compared nothing); a getter that throws is reported rather than read as
"these differ"; and a `Map`, `Set` or boxed `String` target is refused rather
than answered, since deep equality here does not inspect the first two.

**A wrong-typed value is a `TypeError` where chai raises an `AssertionError`** -
`expect('5').to.be.above(3)`, `expect(5).to.include('x')`. Deliberate, and the
same choice `pm.response.to.have.body` made for a wrong-typed argument (#998):
the rule below is that a mistake in the script text stays a `TypeError` because
nothing was asserted. Both throw, so a test fails either way; `e.name` is what
differs.

**The second argument is chai's failure message.** `pm.expect(value, 'context')`
prefixes `context: ` to whatever the failing matcher reports, so an assertion
that runs more than once says which value it was about:

```javascript
pm.expect(user.active, 'user ' + user.id).to.be.true;
// user 42: Expected value to be truthy
```

Non-strings are coerced and `undefined` / `null` mean no message, both as in
chai. Assertion failures carry it; a malformed call (`.to.be.above()` with no
argument) reports its own misuse unprefixed.

**A failed assertion is an `AssertionError`**, as in chai - both from
`pm.expect` and from `pm.response.to`:

```javascript
pm.expect(1).to.equal(2);
// AssertionError: Expected 1 to equal 2
try { pm.response.to.have.status(200); } catch (e) { e.name === 'AssertionError'; }
```

QuickJS has no `AssertionError` class, so this is an `Error` carrying that
`name`: `instanceof Error` holds, `e.stack` is the same one a native throw
gets, and there is no `AssertionError` global to reference (chai's lives on the
`chai` module, which Vayu does not ship). **A mistake in the script text stays a
`TypeError`** - a matcher called with no argument, a name nothing implements -
because nothing was asserted, the call itself was wrong. That covers
**property-style members too** (issue #999): `pm.expect(x).to.be.NaN` is an
expression statement, so an unimplemented name used to evaluate to `undefined`
and report PASS whatever the value was. Every name the chain does not carry -
a typo, or a chai matcher Vayu lacks (`.finite`, `.sealed`, `.frozen`,
`.extensible`) - now raises a `TypeError` naming itself.

`have.keys` asserts *exactly* those keys. `Map` / `Set` / typed arrays are
reported unequal by `eql` rather than compared (their contents are not
properties); `Date` compares by instant, `RegExp` by pattern; a cyclic value
raises a `RangeError` after 64 levels rather than hanging. **A throw the
comparison runs into is the verdict** (#1048) - a key, an array element or an
array `length` behind a getter that throws, an overridden `toJSON` / `toString`
on the `Date` and `RegExp` sides, and the values `include`, `oneOf`, `members`,
`keys`, `property`, `empty` and `length` read before they compare, all reach the
test as the script's own error rather than as a difference. Chai reports a
difference for some of these, which under `.not` is a pass; a test that cannot
read its subject has not passed.

### Response status classes (`pm.response.to.be`)

Getters, so the paren-less form is the assertion:

```
.to.be.ok          (200 only)           .to.be.success       (2xx)
.to.be.info        (1xx)                .to.be.redirection   (3xx)
.to.be.clientError (4xx)                .to.be.serverError   (5xx)
.to.be.error       (4xx or 5xx)
.to.be.accepted    (202)                .to.be.badRequest    (400)
.to.be.unauthorized(401)                .to.be.forbidden     (403)
.to.be.notFound    (404)                .to.be.rateLimited   (429)
.to.be.json        (body parses as JSON)
.to.be.withBody    (body is not empty)
```

**`ok` narrowed to status 200 only (#998)** - it used to match any 2xx, the same
class `success` still matches. A script that asserted `.ok` meaning "any 2xx"
should assert `.success` instead; a script that meant "200 exactly" needed no
change. Postman's own named statuses (`accepted`, `badRequest`, `notFound`, ...)
match by reason phrase as well as by code; Vayu's stay code-only.

**`have.body`'s substring form is gone (#998).** A string argument now has to
equal the body exactly, not merely appear in it - `.to.have.body(sub)` written
for "the body contains `sub`" should become `.to.have.body(new RegExp(sub))`.
`.have.jsonBody(path, value)` also started comparing `value`, which it used to
accept and ignore - a script relying on the old no-op should not pass an
argument it does not want checked.

**`have.status` refuses a code that is not a whole finite number (#1048).**
`status(200.5)` used to be truncated to `200` and pass against a 200; a
fractional or `NaN` expectation is a mistake in the script text - no response
can carry such a code - so it raises a `TypeError` naming what was written
rather than a verdict naming the status that arrived. Postman would report a
failure here too, so no assertion that passes there fails here.

**Every other name under `pm.response.to` throws a `TypeError`** naming the
chain - a misspelling, or an idiom Vayu does not implement such as the negated
`pm.response.to.not.be.ok`. This is deliberate: a paren-less assertion is an
expression statement, so a name that merely evaluated to `undefined` would
report PASS against a broken API.

### Streamed events (`pm.response.events`) - Vayu-specific

Postman has no equivalent: it has no streaming request type, so nothing in its
`pm` surface names one. A request sent with the **Event stream** setting on gets
three extra properties on `pm.response`, and the post-request script runs once,
after the stream has terminated:

```javascript
const events = pm.response.events || [];
pm.test('the stream said done', function () {
    pm.expect(events.some(function (e) { return e.event === 'done'; })).to.be.true;
});
```

**Buffered, not live, and that is structural rather than a limitation of this
release.** The sandbox is synchronous with no event loop - `setTimeout` and
friends are declared absent for exactly that reason - so there is no "later" for
a per-event callback to run in. A script sees the retained list, once.

`pm.response.totalEvents` and `pm.response.eventsTruncated` come with it. The
list is bounded by the engine's `sseMaxStoredEvents`, so a script that means to
assert over the *whole* stream has to check `eventsTruncated` first; counting a
prefix would otherwise report a wrong number with complete confidence.

All three are **absent** on an ordinary response rather than empty, so
`typeof pm.response.events === 'undefined'` distinguishes "not a stream" from "a
stream that produced nothing" - the same absent-not-empty rule
`pm.iterationData` follows. Full reference in
[scripting.md](../engine/scripting.md#pmresponseevents---a-streamed-runs-events).

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
pm.cookies.each(function (cookie) { /* ... */ });  // whole cookie objects
pm.cookies.all();            // array of cookie objects
pm.cookies.count();          // number
```

The read half of Postman's `pm.cookies`, over a jar the engine keeps for
design-mode requests: a `Set-Cookie` on one request is sent on the next one
automatically. What these answer is matched against **this request's URL** -
domain, path, `Secure` and expiry - so they report what will go on the wire and
not everything stored. `each`, `all()` and `count()` are Postman's CookieList
reads, over that same matched set, read fresh on every call.

A cookie object - what `each`, `all()`, `jar().getAll()` and `jar().set`'s
callback all hand back - carries `name` and `key` (same value, both spellings),
`value`, `domain`, `path`, `secure`, `httpOnly`, `hostOnly`, `session`
(booleans), and `expires` (a `Date`, or `null` for a session cookie). Postman's
`maxAge` and its unmodelled `extensions` are not modelled - the jar does not
keep them. Full field list in
[scripting.md](../engine/scripting.md#the-cookie-jar-pmcookies).

The write half is `pm.cookies.jar()`, Postman's own jar object:

```javascript
const jar = pm.cookies.jar();
jar.set(pm.request.url, { name: 'session', value: token });  // or (url, name, value)
jar.get('https://api.example.com/', 'session');              // value, or undefined
jar.getAll('https://api.example.com/');                      // every cookie that URL would carry
jar.unset('https://api.example.com/', 'session');
jar.clear('https://api.example.com/');                       // that URL's cookies
jar.clear();                                                 // this environment's jar
```

Every method is URL-scoped and takes an optional trailing callback, invoked
inline, that carries what the call did: `get` the value, `getAll` the array,
`set` the **stored** cookie object (domain/path filled in from the URL), `unset`
the removed name, `clear` nothing. Each is also the method's return value. A
written cookie's `domain` and `path` default from the URL, and it is then
matched by exactly the rules a received cookie is.

Divergences from Postman:

- **No flat `pm.cookies.set(name, value)`.** Only the `jar()` form ships: a
  written cookie needs a URL to take its domain and path from, which is why
  Postman's own write half lives on the jar object.
- **A write is applied after the transfer it was made before**, not the moment
  it is called - so it rides that request and cannot be lost when the response's
  cookies are captured. Details in
  [scripting.md](../engine/scripting.md#writing-to-the-jar-pmcookiesjar).
- **`jar.clear(url)` matches Postman** - it removes every cookie that URL would
  have carried, which is `unset` with no name to narrow it. **`jar.clear()`
  with no URL is Vayu's own** and empties this environment's jar, because the
  environment is Vayu's scope unit. A URL the engine cannot parse is refused
  rather than cleared as a wipe matching nothing.
- **`getAll` and `pm.cookies.all()` return a plain array**, not Postman's
  `CookieList` - the same divergence `pm.response.cookies` already makes, for
  the same reason: an array is what every other cookie surface here, and a
  plain `for (const c of ...)`, treats it as.
- **`expires` takes a `Date`, a date string, or a whole number of seconds
  since the epoch** - all three read the way the same script's own
  `new Date(...)` would, since the Date and the string are parsed by QuickJS's
  own `Date` rather than a parser written into the engine.
- **Scope is the environment**, not the domain-with-permission model Postman
  uses. One jar per environment plus one for "no environment", in memory only,
  clearable in Settings → General → Cookies.
- **`pm.sendRequest` shares the jar** with the request around it, so logging in
  from a pre-request script leaves the session where the real request finds it.
- **Load runs have no jar**, and every read and write here throws there rather
  than answering `undefined` - see
  [scripting.md](../engine/scripting.md#the-cookie-jar-pmcookies).

---

### Flow control (`pm.execution`)

```javascript
pm.execution.setNextRequest('Checkout');  // run that request next
pm.execution.setNextRequest(pm.info.requestId); // the same jump, by id
pm.execution.setNextRequest(null);        // end this iteration, start the next
pm.execution.setNextRequest('null');      // the quoted stop form, read the same way
pm.execution.skipRequest();               // pre-request only: do not send this one
```

Both are available **only inside a collection run**, and outside one they throw a
sentence naming why rather than being ignored - a single Send has no next
request, and a load run's test scripts run after the run has finished, against
responses already recorded.

Both target spellings Postman accepts work: a request's name, and the id a
script reads off `pm.info.requestId`. So does the quoted stop form
`setNextRequest('null')` - with one stated precedence, which is a divergence
only in the sense that Postman has no answer for it: a run that carries a
request actually named `null` jumps to that request rather than stopping.

Divergences from Postman:

- **An unresolvable target fails the step**, naming it. A target no request in
  the run answers to by name or by id, and a name two of them share, are both
  errors that end the iteration; Postman resolves an ambiguous name to whichever
  it finds.
- **A cycle is bounded.** Two requests pointing at each other run forever in
  Postman's runner; here the iteration is cut off by `maxStepsPerIteration` and
  the failure names the steps that were looping.
- **A skipped step is reported as `skipped`**, never as a pass, in the step list
  and in the run summary alike.

Details, including every case that throws, are in
[scripting.md](../engine/scripting.md#flow-control-pmexecution).

### Data rows (`pm.iterationData`)

```javascript
pm.iterationData.get('username');  // this iteration's value for that column
pm.iterationData.has('coupon');    // whether the row carries that column
pm.iterationData.toObject();       // the whole row
```

A collection run can be given rows - the app parses the CSV or JSON file and
sends them inline on the run payload; the engine never opens a file. Row
`i % rows` binds to iteration `i`, so `iterations` above the row count wraps.

A **single send** can bind one row as well: the request builder's Send-with-row
caret and MCP's `run_request` both take one row on `POST /execute`, which is
what makes a script that reads `pm.iterationData` testable without starting a
run. `pm.info.iteration` is then `0` of `1` - the send is row 0 of 1.

A **scenario load run's deferred per-step script** reads one too: the sampled
response carries the row its iteration was bound to. Those three - a
data-driven collection run, a send-with-row, and that deferred script - are
every surface that binds a row, and they are what a stashed
`pm.iterationData` names when it refuses a later call.

Divergences from Postman:

- **It is `undefined` when the run has no data**, rather than an empty scope
  that answers `undefined` to every column. Absence is a fact worth being able
  to test: `pm.iterationData ? pm.iterationData.get('user') : 'default'`. This
  is the opposite treatment to `pm.execution` above, deliberately - flow control
  is a capability, and one that silently does nothing is a false success.
- **It is read-only**: `set`, `unset` and `clear` throw. The rows are a run
  input, not a scope, so a write has nowhere to land and the next iteration
  binds a different row regardless.
- **Which row was used is recorded.** Every step's stored row and live event
  carries `dataRowIndex`, and the step list shows it beside the iteration, so a
  wrapped run says which row a pass re-used.

**The same row is also readable by column name through `pm.variables`** while
it is bound (issue #1007) - see [above](#supported-surface) and
[scripting.md](../engine/scripting.md#variables-pmvariables) - but
`pm.iterationData` stays the accessor that reads *only* the row, with none of
the three scopes behind it.

Details are in
[scripting.md](../engine/scripting.md#data-rows-pmiterationdata).

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
- `pm.cookies.set(...)` / `.unset(...)` / `.clear()` - the *flat* write half.
  Writing goes through `pm.cookies.jar()`, which ships whole - see
  [above](#the-cookie-jar-pmcookies)
- The rest of postman-collection's `PropertyList` on a header object - `map`,
  `filter`, `find`, `idx`, `insert`, the list-level `has(item, value)`,
  `assimilate`, `populate`, `clear`, `eachParent`, `toString`. Only the read
  half and the three mutators named under [Header methods](#header-methods)
  ship
- `pm.visualizer`
- The `tests["name"] = bool` legacy assertion style (use `pm.test`)
- Chai matchers outside the list above: `.include.keys` (the subset form),
  `.any.keys`, `.change`/`.increase`/`.decrease`, `.own.property`, `.respondTo`,
  the property-style `.finite` / `.sealed` / `.frozen` / `.extensible`, and the
  `require()`-able libraries (`chai`, `lodash`, `moment`, …). Each throws
  a `TypeError` rather than reporting a pass. `.any`, `.own` and `.itself` are
  deliberately absent from the language chains above for that reason: each
  changes what the matcher after it asserts - `.any` quantifies `.keys`, and
  the other two change what `.property` looks at - so accepting one as a no-op
  would assert something other than what the script wrote

---

## Request mutation & URL variables

A **pre-request** script can change the outgoing request. `pm.request`'s `url` /
`method` / `headers` / `body` are copied out of the C++ `Request` into a plain JS object
(`script_engine.cpp`, `setup_pm_request`), and after the script returns that object is read
back and applied to the same `Request` before `client.send()`
(`apply_pm_request_writeback`). In a **test** script it stays a read-only record: the
request has already gone out, so nothing is written back and a mutation there is discarded.

The two hooks therefore read **different header sets**, matching Postman: a pre-request
script sees the composed headers it is there to edit, and a test script sees the ones that
were actually sent - including the `Content-Type` the engine derives from the body mode and
the default `User-Agent`, neither of which exists yet when the pre-request script runs
(#483). A `form-data` `Content-Type` appears in neither, because libcurl writes that one
itself with the boundary.

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
- **A value the engine cannot send is refused, not coerced.** `method`/`body` must be
  strings (`method` one of the seven verbs); a header value may be a string, number or
  boolean. Anything else rejects the whole write-back - all or nothing - and surfaces as
  `preScriptError`, which the response pane's Console tab shows. `url` is refused a step
  earlier: assigning anything that is not a URL string throws at the assignment, so the
  script author is told which line was wrong rather than reading it off the write-back.
- **`url` is Postman's `Url` object, not a string** (#991 - the owner decision that
  compatibility wins over the shipped string shape). `protocol`, `host`, `port`, `path`,
  `hash`, `query` with `get`/`has`/`all`/`toObject`/`count`, plus `getHost()`,
  `getPath()`, `getQueryString()`, `toString()` and `update()`. It still behaves as a
  string in every context JavaScript allows - concatenation, template literals, `==`,
  `String.prototype` methods, `JSON.stringify`, `.length` - and two things changed:
  `===` and `typeof`. The full surface and the migration note are in
  [scripting.md](../engine/scripting.md#url-parts-pmrequesturl).
- **The URL is writable a member at a time, not only whole** (#1040). `path` and
  `host` are arrays a script mutates in place (`push`, `splice`, index assignment,
  a `length` truncation); `protocol` / `port` / `hash` take an assignment; and the
  query carries Postman's `PropertyList` writers - `add`, `upsert`, `remove`,
  `clear`. A URL nobody edited is sent as the exact bytes it arrived as, because
  the parts are recomposed only when a member actually changed.
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
- **Setting a variable now re-renders whatever composition left unresolved.**
  `{{…}}` placeholders are still resolved at **compose time** (`POST /compose`,
  engine-side since #226) before the pre-request script runs - #226's decision
  D1 stands, composition is not being moved. What changed (#1008) is that a
  name composition could not answer keeps its braces (#1009) instead of
  becoming `""`, and gets resolved a second time after the pre-request script
  and before the send, against the scopes as the script left them. So
  `pm.environment.set("host", …)` reaches a `{{host}}` in the same request's
  URL, as long as nothing already defined `host` at compose time. A value
  composition *did* substitute is finished text - that pass reads the request,
  not composition's decisions, so it is not re-resolved - and `pm.request.url`
  is still how a script changes a value composition already substituted.
- **Load tests do not run pre-request scripts** at all, so this is a Send / Design Mode
  capability.

This goes **further than Postman** on the URL, method and body, which Postman's docs mark
immutable or provide no mutators for.

### Header methods

Both header objects carry `get(name)`, `has(name)`, and the read half of a Postman
`PropertyList` - `each(fn, thisArg?)`, `all()`, `count()`, `toObject(excludeDisabled?,
caseSensitive?)`, `one(name)` and `indexOf(name)`; `pm.request.headers` also carries the
three mutators, `upsert`, `add` and `remove`. They are **non-enumerable properties of the
header object itself**, which is what makes them safe: `apply_pm_request_writeback` reads
that object's own *enumerable* string properties as the outgoing header set, so an
enumerable method would be read as a header whose value is a function and would fail the
whole write-back. Being on the same object is also what makes a method call and a plain
assignment agree - there is one property set, not two views of one.

```javascript
pm.request.headers.get('authorization');                  // case-insensitive
pm.request.headers.has('Authorization');
pm.request.headers.upsert({ key: 'X-Trace', value: id }); // or ('X-Trace', id)
pm.request.headers.add({ key: 'X-New', value: '1' });     // throws if already set
pm.request.headers.remove('Authorization');               // no-op if absent
pm.request.headers.all();                                 // [{key, value}, ...]
pm.request.headers.count();                               // how many there are
pm.request.headers.one('Content-Type');                   // {key, value}, or undefined
pm.request.headers.toObject();                            // lower-cased keys
pm.request.headers.indexOf('Content-Type');               // position in all(), or -1
pm.request.headers.each(function (header, index, all) {
  console.log(header.key, header.value, index, all.length);
});
```

`toObject()` lower-cases every key, which is what Postman does whenever the list
it is called on is indexed case-insensitively - a header list always is - so
`toObject()['content-type']` reads the header whatever casing it was set with.
A truthy second argument (`toObject(false, true)`) keeps the stored spelling.
The first argument is Postman's `excludeDisabled` and decides nothing here, as
do the two it does not take: these objects hold no disabled row, no duplicate
name and no empty one.

Five deliberate divergences from Postman:

- **The methods are case-insensitive, indexing is not.** `upsert('authorization', v)`
  replaces an existing `Authorization` instead of adding a second spelling - which the
  write-back would refuse as a clash, since `Headers` is a case-insensitive map.
- **`add` refuses a name that is already present** and names `upsert` in the error.
  Postman's `HeaderList` holds duplicates and `add` appends one; a single-valued
  `Headers` map cannot represent that, and silently behaving as `upsert` would hide the
  difference rather than report it.
- **A header field literally named after one of the methods wins.** Entries are
  *defined* over the method, attributes included, so the header still reaches the wire
  and the shadowed method throws loudly. A dropped header would be the worse failure.
- **`all()` reports this object's key order, not wire order, and can never report a
  duplicate.** Postman's `HeaderList` keeps both; a `Headers` map cannot, because it is
  single-valued and case-insensitive, so a name set twice already collapsed into one
  entry before any script runs.
- **`indexOf` matches a `{ key }` member by its `key`, not by identity.** Postman finds a
  member by identity in its own list; the members handed out here are built fresh on
  every call, so identity would answer `-1` for a member of the very list it came from.
  Matching the key answers what Postman answers for that case, and `-1` for an object
  naming a header this list does not hold.

Bad input fails loudly: a name must be a non-empty string, a value a string, number or
boolean (the set plain assignment already accepts), `each` throws if its first argument
is not a function, and calling a method detached from its object throws rather than
answering as though the header were missing.

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

#### Every `pm.*` example on this page is compiled against those declarations

`script-typedefs.docs-compile.test.ts` takes the 54 `pm.*` blocks in this page and
[`docs/engine/scripting.md`](../engine/scripting.md), compiles each against the generated
`.d.ts`, and requires zero errors - with `SCRIPT_COMPILER_OPTIONS` and
`SUPPRESSED_DIAGNOSTICS` read from `useScriptTypeDefinitions.ts` rather than restated, so
it checks them the way the editor does. Four defects had survived the engine's
substring-based guards, because a declaration can carry every right name and still not
type-check (#463).

The declarations reach it as `engine/tests/fixtures/script-typedefs.d.ts`, checked in and
pinned to the generator by the engine suite - vitest cannot run the C++ generator, and
ctest has no TypeScript compiler, so the two halves meet at one artifact. See
[`api-reference.md`](../engine/api-reference.md#the-declarations-are-compiled-not-just-grepped)
for the regeneration command.

A consequence worth knowing before editing either page: a `pm.*` example here is now
**checked**, so an example that is wrong fails CI rather than misleading a reader.

#### Optional members, and why the editor states them without enforcing them

A completion entry says a member may be absent by ending its `detail` in
` | undefined`. The generator reads that one convention in two places: a leaf keeps the
union (`iteration: number | undefined`), and a surface that has members of its own has no
union to carry it, so the optionality moves onto the property name -
`pm.iterationData` is declared **`iterationData?: { ... }`**, because it is `undefined`
outside a data-driven run or a send-with-row.

That marker shows in hover, and deliberately does **not** produce a squiggle: the worker
runs with `strictNullChecks` **off**, and without it an optional property is
indistinguishable from a required one at a use site. So a plain request script calling
`pm.iterationData.get('x')` gets no editor error for something that throws at run time -
the guard the docs recommend (`pm.iterationData ? ... : ...`) is advice, not a rule the
type system enforces.

That is a decision (#443), not an oversight, and `useScriptTypeDefinitions` now sets
`strictNullChecks: false` explicitly rather than relying on the default, so a `strict:
true` arriving through the spread of Monaco's existing options cannot turn it on as a side
effect. It was taken on a count. Compiling **57 scripts** against the real generated
declarations - the 54 `pm.*` examples in this page and
[`docs/engine/scripting.md`](../engine/scripting.md), plus three realistic ones - turning
the flag on adds **13 diagnostics**:

| What | Count | Verdict |
|------|------:|---------|
| `pm.iterationData.get/has/toObject` unguarded | 7 | Correct inside the data-driven run those examples are about |
| An optional string used straight - `pm.environment.get(...)` into `.trim()` and `pm.crypto.hmacSha256`, `pm.request.body` into `JSON.parse` | 4 | A real crash when the value is absent, and the idiom every script uses |
| `pm.info.iteration > 0` | 1 | Works: the comparison is `false` outside a run |
| `pm.response.errorMessage` after a truthy `pm.response.errorCode` | 1 | Correlated siblings, which no narrowing can see |

Eight of the thirteen land on lines these docs publish as the way to use the API. Nor can
the noise be suppressed away while the catch is kept: `18048` is the code for
`pm.iterationData.get(...)` - the case the flag was wanted for - *and* for `token.trim()`,
and the remaining code is `2345`, which is the argument checking the whole feature exists
to provide. A script editor is JavaScript, so there is no `!` for an author to say "I know
it is set"; the escape is restructuring the code.

So the trade is the one the suppression list above already makes, one level up: a real
mistake goes unreported in exchange for not crying wolf on correct code. Revisiting it
means re-running that count, not re-arguing it.

`pm.execution` has the mirror-image limitation and no fix at all: it is always bound, and
its methods throw outside a collection run, which no type can express.

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
| Generated declarations (pinned) | `engine/tests/fixtures/script-typedefs.d.ts`                                                                                                            |
| Docs-compile guard              | `app/src/hooks/script-typedefs.docs-compile.test.ts`                                                                                                    |
| Type declaration fetch + cache  | `app/src/queries/script-types.ts`                                                                                                                       |
| Monaco type registration        | `app/src/hooks/useScriptTypeDefinitions.ts`                                                                                                             |
| Completion fetch + cache        | `app/src/queries/script-completions.ts`                                                                                                                 |
| Monaco completion provider      | `app/src/hooks/useScriptCompletionProvider.ts`                                                                                                          |
| Shared editor wrapper           | `app/src/components/ui/code-editor.tsx`                                                                                                                 |
| Script editor panels            | `app/src/modules/request-builder/components/RequestTabs/panels/{Pre,Test}ScriptPanel.tsx`, `app/src/modules/collections/CollectionDetail/ScriptTab.tsx` |
