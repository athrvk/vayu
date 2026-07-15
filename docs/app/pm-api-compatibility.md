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

Variable writes persist to the scope they target (environment / collection / globals) and
participate in [variable resolution](./variable-resolution.md).

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
- `pm.iterationData.*` - data-file driven runs
- `pm.cookies.*`
- Request mutation - `pm.request.headers.add/upsert/remove(...)`, and editing the URL,
  method, or body from a script (see below)
- `pm.info`, `pm.execution`, `pm.visualizer`
- The `tests["name"] = bool` legacy assertion style (use `pm.test`)

---

## Request mutation & URL variables

A pre-request script **cannot change the outgoing request** in Vayu today.

- `pm.request` is a read-only snapshot. Its `url` / `method` / `headers` / `body` are copied
  out of the C++ `Request` into a plain JS object (`script_engine.cpp`,
  `setup_pm_request`); there are no setters and the object is never read back after the
  script runs (only `tests` and console output are). Assigning `pm.request.url = …` mutates
  the throwaway JS object and is discarded.
- Setting a variable that the URL references (`pm.environment.set("host", …)` with a
  `{{host}}` in the URL) also has no effect on the current request: `{{…}}` placeholders are
  resolved **app-side, before** the payload reaches the engine
  (`app/src/modules/request-builder/index.tsx`, `resolveString(request.url)`), whereas the
  pre-request script runs **later, in the engine**. The variable write only affects
  subsequent runs.

This matches Postman's behaviour for the URL/method/body (its docs mark the body immutable
and provide no URL mutators) but **diverges on headers** - Postman _does_ support
`pm.request.headers.add/upsert/remove`, which Vayu does not yet implement.

### TODO (future)

To make the full Postman pattern work - "set a variable in a pre-request script and have it
change the outgoing URL/headers" - variable resolution has to move (or be duplicated) into
the engine and run **after** the pre-request script, instead of entirely app-side beforehand.
That means sending the _unresolved_ URL/headers plus the variable maps to the engine and
interpolating `{{…}}` in C++ post-script (and applying the same to the load-test path). This
is a deliberate architectural change in resolution ownership, deferred for now. A smaller
intermediate step is mutable headers (`pm.request.headers.*`) with write-back from the JS
request object to the C++ `Request` before `client.send()`.

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
