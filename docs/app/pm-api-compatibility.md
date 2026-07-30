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
| Merged variables    | `pm.variables.get(name)`, `.has(name)`, `.toObject()` - read-only, see below     |
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
- `replaceIn(...)` on any scope - `{{name}}` interpolation of an arbitrary string.
  The engine does no `{{var}}` interpolation at all (it is resolved app-side
  before the payload arrives), so there is nothing to expose
- `pm.environment.name` - the active environment's name
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
  **app-side, before** the payload reaches the engine
  (`app/src/modules/request-builder/index.tsx`, `resolveString(request.url)`), whereas the
  pre-request script runs **later, in the engine**. So `pm.environment.set("host", …)` with
  a `{{host}}` in the URL affects subsequent runs only - assign `pm.request.url` to change
  this one.
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
work, and cannot until variable resolution moves (or is duplicated) into the engine and runs
**after** the pre-request script instead of entirely app-side beforehand. That means sending
the _unresolved_ URL/headers plus the variable maps to the engine and interpolating `{{…}}`
in C++ post-script (and applying the same to the load-test path) - a deliberate change in
resolution ownership, deferred for now (`docs/plans/pending-backlog.md` → **A1**).

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

---

## Where it lives

| Concern                         | Location                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm` runtime (QuickJS bindings) | `engine/src/runtime/script_engine.cpp`                                                                                                                  |
| Completion metadata endpoint    | `engine/src/http/routes/scripting.cpp`                                                                                                                  |
| Completion fetch + cache        | `app/src/queries/script-completions.ts`                                                                                                                 |
| Monaco completion provider      | `app/src/hooks/useScriptCompletionProvider.ts`                                                                                                          |
| Shared editor wrapper           | `app/src/components/ui/code-editor.tsx`                                                                                                                 |
| Script editor panels            | `app/src/modules/request-builder/components/RequestTabs/panels/{Pre,Test}ScriptPanel.tsx`, `app/src/modules/collections/CollectionDetail/ScriptTab.tsx` |
