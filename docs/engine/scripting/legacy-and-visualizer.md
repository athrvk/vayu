---
description: >-
  The legacy `postman` object, Postman's legacy globals and `pm.visualizer`.
---

# Legacy postman objects and the visualizer

## The legacy `postman` object

`postman` holds Postman's eleven pre-`pm.*` helper methods (#2577), bound in `engine/src/runtime/pm/pm_legacy.cpp`.
Each is an alias of the `pm.*` method Postman names as its replacement (`LEGACY_GLOBS_ALTERNATIVES` in postman-sandbox), and passes on exactly the arguments Postman's `postman-legacy-interface.js` does:

| `postman.` | Calls |
| ---------- | ----- |
| `setEnvironmentVariable(name, value)`, `getEnvironmentVariable(name)`, `clearEnvironmentVariable(name)`, `clearEnvironmentVariables()` | `pm.environment.set`, `get`, `unset`, `clear` |
| `setGlobalVariable(name, value)`, `getGlobalVariable(name)`, `clearGlobalVariable(name)`, `clearGlobalVariables()` | `pm.globals.set`, `get`, `unset`, `clear` |
| `setNextRequest(name)` | `pm.execution.setNextRequest` |
| `getResponseHeader(name)` | `pm.response.headers.get` |
| `getResponseCookie(name)` | the cookie `pm.cookies.get` reads, as the object `pm.cookies.all()` lists |

```javascript
postman.setEnvironmentVariable("count", 5);
pm.test("the legacy setter stores a string", function () {
    pm.expect(pm.environment.get("count")).to.equal("5");
});
```

Three rules come from Postman's interface rather than from the `pm.*` method:

- The two setters store `value.toString()` for a truthy value that has one, so a number or an object reads back as its string; `false`, `0`, `""`, `null` and `undefined` reach `set` as they are.
- `getResponseHeader` and `getResponseCookie` are bound only when the execution has a response, so a pre-request script's `postman` lacks them.
- Each method's targets are read when `postman` is bound, so a script that reassigns `pm` or one of its members does not redirect a legacy call.

Every other behaviour, refusals included, is the `pm.*` method's: `postman.setNextRequest` outside a collection run throws the `pm.execution.setNextRequest is not available here` sentence, and `postman.getResponseCookie` without a jar throws `pm.cookies.get`'s.
Postman's once-per-method deprecation warning is not written.

The `environment` and `globals` setters and clears also write through to the snapshot of that name below, before calling the `pm.*` method, as `postman-legacy-interface.js` writes through to its `__environment` and `__globals`.

## Postman's legacy globals

The values postman-sandbox's legacy interface binds beside `postman` (#2577), in the same file.
Each is set on the global object per execution, once the `pm.*` surfaces are refreshed, and read off the `pm.*` member Postman names as its replacement, so the two spellings cannot answer differently:

| Global | Value | Read off |
| ------ | ----- | -------- |
| `tests` | `{}`; each property assigned becomes a test result | - |
| `environment`, `globals` | the scope's variables as a plain object, a snapshot | `pm.environment.toObject()`, `pm.globals.toObject()` |
| `data` | the iteration's row, `{}` without one | `pm.iterationData.toObject()` |
| `iteration` | `ScriptContext::iteration`, `0` without one | what `pm.info.iteration` reads |
| `request` | `{ id, name, headers, method, url, data }` in Postman's legacy shape | the request `pm.request` reads |
| `responseBody` | the body text | `pm.response.text()` |
| `responseCode` | `{ name, detail, code, standardName }` | the response `pm.response.code` and `reason()` read |
| `responseHeaders` | header name to value, as received | `Response::header_lines`, the folded map without them |
| `responseTime` | milliseconds | `pm.response.responseTime` |
| `responseCookies` | the jar's cookies for the URL, on first read | `pm.cookies.all()` |

```javascript
tests["Status code is 200"] = responseCode.code === 200;
var jsonData = JSON.parse(responseBody);
tests["Has an id"] = jsonData.id !== undefined;
```

The rules, each Postman's:

- **`tests` is read after the script.**
  `record_legacy_tests` runs once the queues have drained, before the results are copied, and appends a row per own enumerable key, in key order, after the `pm.test` rows: passed when the value is truthy, failed with `AssertionError: expected <value> to be truthy` otherwise.
  It reads the object it bound (`ContextData::legacy_tests`), not whatever the global names by then, and it runs after a throw too.
- **The five `response*` globals are bound only when the execution has a response.**
  A pre-request script has the other six.
- **`environment` and `globals` are snapshots** taken when the script starts.
  Writing to one changes no variable and `pm.*.set` does not update it; only the `postman` setters and clears write through, above.
- **`responseHeaders` keeps each name as received**, the last of a repeated one winning, from `Response::header_lines`.
  The load path keeps no lines, so there it is the folded, lower-cased map.
- **`responseCookies` is an accessor that replaces itself** with what `pm.cookies.all()` answers on its first read, as `pm.response.cookies` does, so a script that never reads it never reads the jar, and where there is no jar the read throws `pm.cookies`' refusal.
  An assignment replaces it as it would any global.
- **`request`** lower-cases each header name and holds a repeated one as an array (`toObject(true, false, true, true)` in Postman), over the header set `pm.request.headers` shows (`script_request_header_lines`).
  `data` is a form body's enabled fields (a repeated field as an array, an empty first value replaced, as Postman's form reader does), a text body's text, and `{}` for no body, an empty one, a file or GraphQL.
- **`responseCode.detail` is `""`.**
  Postman fills it from `http-reasons`, a paragraph per status that Vayu does not carry; the empty string is Postman's own fallback.
  `name` is the reason phrase `pm.response.reason()` answers and `standardName` the registered one.

The script runs inside a function, so a script's own `const data` or `let responseBody` is a local that shadows the global, and an assignment with no declaration (`data = ...`) writes the global, sloppy mode's rule.

## Visualizer (`pm.visualizer`)

`pm.visualizer.set(template, data, options)` and `pm.visualizer.clear()` (#2577, `engine/src/runtime/pm/pm_visualizer.cpp`) are bound so a Postman script that draws a visualization keeps running: Postman renders a Handlebars template in its Visualize tab and Vayu has no such tab.
A call is accepted, pushes one `console.warn` line beginning `visualizer not rendered`, and returns `undefined`.
Nothing is stored: the template and data are not read, there is no trace field for them, and the line in the script's console output is the only record.
`set` refuses a first argument that is not a string with a `TypeError` and takes `data` and `options` as given.
Both calls exist in a pre-request and a test script alike.
The import scan no longer names `pm.visualizer`.
