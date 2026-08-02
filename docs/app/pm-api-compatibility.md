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
| Response assertions | `pm.response.to.have.status(code)`, `.header(name)`, `.jsonBody()`, and the `pm.response.to.be.*` status classes below |
| Request             | `pm.request.url`, `.method`, `.headers`, `.body`                                 |
| Request headers     | `pm.request.headers.get/has(name)`, `.upsert({key, value})`, `.add({key, value})`, `.remove(name)` |
| Environment         | `pm.environment.get/set/has/unset/clear/toObject`                                |
| Globals             | `pm.globals.get/set/has/unset/clear/toObject`                                    |
| Collection vars     | `pm.collectionVariables.get/set/has/unset/clear/toObject`                        |
| Merged variables    | `pm.variables.get(name)`, `.has(name)`, `.toObject()`, `.replaceIn(template)` - read-only, see below |
| Crypto              | `pm.crypto.sha256(data, encoding?)`, `.hmacSha256(key, data, encoding?)` - synchronous, see below |
| Base64              | `btoa(binaryString)`, `atob(base64)` - globals, standard web semantics           |
| Console             | `console.log/info/warn/error`                                                    |

`pm.response.headers` is a plain object keyed by the **lower-cased** header name, not
Postman's `HeaderList` - but it carries `get()` / `has()`, and those are
case-insensitive the way HTTP header names are. Indexing is not, so
`headers['Content-Type']` reads back `undefined` while
`headers.get('Content-Type')` works (see [Header methods](#header-methods)).

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

---

## Not (yet) supported

These Postman APIs are **not** implemented - scripts that rely on them will fail:

- `pm.sendRequest(...)` - sending auxiliary requests from a script
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
- `pm.iterationData.*` - data-file driven runs
- `pm.cookies.*`, and `pm.response.cookies`
- `pm.request.url.query` / `.path` / `.host` - and any other `url.*` accessor.
  `pm.request.url` is a writable **string** that the write-back requires to still
  be one, and a JS string primitive cannot carry properties; boxing it would
  reject every request. A separate accessor (`pm.request.getUrlParts()`-shaped)
  could work, but that shape has not been decided, so URL parsing is string work
  today. Deferred deliberately - see
  [scripting.md](../engine/scripting.md#url-parts-are-not-exposed-deferred).
- `pm.info`, `pm.execution`, `pm.visualizer`
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
