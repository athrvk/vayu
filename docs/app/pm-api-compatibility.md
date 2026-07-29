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
| Response            | `pm.response.code`, `.status`, `.responseTime`, `.headers`, `.json()`, `.text()` |
| Response assertions | `pm.response.to.have.status(code)`, `.header(name)`, `.jsonBody()`               |
| Request             | `pm.request.url`, `.method`, `.headers`, `.body`                                 |
| Environment         | `pm.environment.get(name)`, `pm.environment.set(name, value)`                    |
| Globals             | `pm.globals.get(name)`, `pm.globals.set(name, value)`                            |
| Collection vars     | `pm.collectionVariables.get(name)`, `pm.collectionVariables.set(name, value)`    |
| Console             | `console.log/info/warn/error`                                                    |

`pm.response.headers` is a plain object keyed by the **lower-cased** header name -
`pm.response.headers['content-type']`, not Postman's `HeaderList` (see below).

Variable writes persist to the scope they target (environment / collection / globals) and
participate in [variable resolution](./variable-resolution.md). Calling `set(name, value)`
on a variable that already exists updates only its value - the existing `secret` flag,
`enabled` flag and `type` are preserved. A `set` on a new name creates it with the defaults
(not secret, enabled, `type: "string"`).

### Assertion chains (`pm.expect` / `pm.response.to`)

Chai-style chains, implemented in the QuickJS runtime:

```
.to.equal(v)      .to.eql(v)        .to.exist
.to.be.true       .to.be.false      .to.be.null      .to.be.undefined
.to.be.ok         .to.be.empty
.to.be.above(n)   .to.be.below(n)   .to.be.at.least(n)   .to.be.at.most(n)
.to.have.property(name)             .to.have.length(n)   .to.have.lengthOf(n)
.to.include(v)    .to.contain(v)
.to.be.a(type)    .to.be.an(type)   .to.match(/regex/)
.to.not …         (negates the chain)
```

---

## Not (yet) supported

These Postman APIs are **not** implemented - scripts that rely on them will fail:

- `pm.sendRequest(...)` - sending auxiliary requests from a script
- `pm.variables.*` - the merged/resolved variable accessor (use the scoped
  `pm.environment` / `pm.collectionVariables` / `pm.globals` instead)
- `pm.response.headers.get/has(...)` - Postman's `headers` is a `HeaderList`;
  Vayu's is a plain object keyed by the **lower-cased** header name, so read it
  as `pm.response.headers['content-type']`. The engine's HTTP client lower-cases
  every response header name as it parses it (`client.cpp`), so a mixed-case key
  reads back `undefined`.
- `pm.iterationData.*` - data-file driven runs
- `pm.cookies.*`
- Postman's header *methods* - `pm.request.headers.add/upsert/remove(...)`. Vayu's
  `pm.request.headers` is a plain object, so assignment and `delete` do the same
  job (see below)
- `pm.info`, `pm.execution`, `pm.visualizer`
- The `tests["name"] = bool` legacy assertion style (use `pm.test`)

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
immutable or provide no mutators for, and reaches the same end as its
`pm.request.headers.add/upsert/remove` by plain-object assignment and `delete`.

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
