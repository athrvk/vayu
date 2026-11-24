---
description: >-
  The variable scopes a script reaches: `pm.environment`, collection and global variables, and `pm.variables`.
---

# Variables and environments

## Environment Variables (`pm.environment`)

Access and modify environment variables:

```javascript
// Get variable
const token = pm.environment.get('auth_token');

// Set variable (persists to environment)
pm.environment.set('auth_token', 'new_token_value');

// Set a secret variable in one call
pm.environment.set('auth_token', 'new_token_value', { secret: true });
```

`set()` on an existing name replaces its value and keeps the variable's `secret`, `type` and creation time, unless its third argument names one (below).
It also turns `enabled` on (#2479): a set is a write of a value the script means to use, so a row unticked in the variables editor is ticked again, and the script's own `get`, `has` and `replaceIn` and the `{{name}}` pass before the send all see it.
A name that does not exist yet is created with the defaults and stamped with its creation time, so it appears at the bottom of that scope in the variables editor rather than above the rows that were already there.

A run reaches disk as a **delta**, not a copy of the scope (issue #1878).
The scopes are loaded when a send, stream or collection run starts and written back once when it ends; at that point each scope's row is read again and only what the run's scripts changed against what it loaded is applied to it, under one database lock:

- a name the run set that it did not load is written whole, creation time included;
- a name whose value alone changed gets that value, and keeps whatever `enabled`, `secret` or `type` the row holds now; a name whose other fields changed too is written whole - an `extract.*` element writes a whole variable, and a `set()` that re-enabled an unticked row changed `enabled` as well as the value;
- a name the run loaded and no longer holds (`unset()`, `clear()`) is removed.

Everything else on the row is left as it is now, so an edit made in the variables editor, a `POST /globals` or another send's own write while the run was in flight survives it.
A scope whose delta changes nothing is not written at all, so its `updated_at` does not move, and an environment or collection row deleted meanwhile is not recreated.
The globals singleton is the exception: no row there means none was ever saved, not that one was deleted, so the first global a run sets creates it (#3453).

### A value keeps its type for the run

`set()` keeps the JavaScript value it was given, and every later read in the same run answers it as set (issue #2529), as Postman does:

```javascript
pm.environment.set('count', 0);
pm.environment.set('count', pm.environment.get('count') + 1);
pm.environment.get('count'); // 1, a number - not "01"

pm.collectionVariables.set('ids', [1, 2, 3]);
Array.isArray(pm.collectionVariables.get('ids')); // true
```

`get`, `toObject`, `pm.variables.get` and `pm.variables.toObject` all read it.
The run is the scripts of one send, the steps of a collection run, or one virtual user's steps in a load run (the value rides that user's own write layer, so one user's value never reaches another).

What the variable *stores* is the value's string form, and that is all `{{name}}`, `pm.variables.replaceIn`, the wire and the persisted row ever see: `1`, `true`, `1,2,3`, `[object Object]`, `null`, and `""` for `undefined` - Postman's own substitution, so a `{{count}}` header goes out as `1` (a declared `json` row is the one exception, below).
A name the run only loaded reads from that stored text, cast by its declared type.
The typed value is never written anywhere, and it is not an edit: setting the number `5` on a row that holds `"5"` leaves the row unwritten.

Two limits:

- **A declared type wins.**
  A row whose `type` is `number`, `boolean` or `json` casts its stored text by that type, whatever was set.
  Vayu's default `"string"` doubles as Postman's `any`, so a row of that type answers what was set.
  On a `json` row, `set` of an object or an array stores its JSON text (`JSON.stringify(value)`, #2568), so it reads back as the object and `{{name}}` substitutes the document; a string set there stays as given.
  A value JSON cannot write (a function, a cycle) still stores its string form.
- **An object travels as JSON.**
  Each read is a fresh copy, as `JSON.parse(JSON.stringify(value))` would make it: a `Date` reads back as its ISO string and a nested `NaN` as `null`.
  A number on its own keeps every value, `NaN`, the infinities and `-0` included.
  What JSON cannot write at all (a function, a `BigInt`, a cycle) reads back as its string form.
- **A later write replaces it.**
  An `extract.*` element writes a whole new variable, so its text replaces a value a script set earlier.

### The third argument of `set` (#2664)

`set(name, value, options)` reads Postman's optional third argument (postman-collection 5.3.0), in either of its two shapes:

- **a string** is a type: `set('n', 1, 'number')`;
- **an object** contributes `type` when it is a string and `secret` when it is a boolean: `set('token', t, { secret: true })`, `set('n', 1, { type: 'number' })`.

Anything else (`null`, a number, an object whose members are the wrong kind) is ignored, as Postman ignores it.
The type names map onto the four Vayu declares: `string`, `number` and `boolean` are their own, `json`, `object` and `array` are `json`, and any other name (`any`, `default`, a word Postman has no type for) leaves the row's type as it was.
**`"secret"` is not a Postman type**; as the string, or as the object's `type`, it marks the variable secret and leaves the type alone - the same reading the importer gives `type: "secret"`.
An explicit `secret` boolean beside it wins, so `{ type: 'secret', secret: false }` is not secret, and `{ secret: false }` on its own clears the flag of a secret row.

Each field the argument names is set on a new row and on an existing one; a field it does not name keeps what the row has, so `set(name, value)` is exactly what it was before.
The stored text follows the type the set declares, not the one the row had: `set('filter', { a: 1 }, 'json')` stores the document `{"a":1}` (#2568), where the same set on a default-type row stores `[object Object]`.

A changed flag or type is more than a value change, so the run's delta writes the row whole and it reaches the stored scope.
**The flag takes effect from the next read of the scope**: `secret_variable_values`, which decides what a run snapshot masks, reads the stored scopes when a run starts, so the value is masked from the next run on and not inside the run that made it secret.
The variables editor and an MCP agent's withholding read the stored flag too.

`pm.variables.set` is the local scope and takes the argument like the others, but that scope is never stored and never masked, so a `secret` flag on it has no effect.

### The seven methods every scope has

| Method | Returns | Notes |
|---|---|---|
| `get(name)` | the value a script set this run, as it was set; otherwise the stored text cast by its declared type; or `undefined` | a disabled variable reads as `undefined`; a declared `number` / `boolean` / `json` row always casts |
| `set(name, value, options?)` | `undefined` | stores the value's string form (`undefined` as `""`; an object or array on a declared `json` row as its JSON text); keeps `secret` / `type` / creation time unless `options` names one ([above](#the-third-argument-of-set-2664)); turns `enabled` on; a name no `{{name}}` could read back (blank, starting or ending in whitespace, or containing `{` or `}`) is a `TypeError` naming the call, and nothing is stored ([below](#a-name-a-token-cannot-read-back-is-refused-3461)) |
| `has(name)` | `boolean` | true only for the rows `get()` can read, so a disabled variable is `false` |
| `unset(name)` | `undefined` | removes the name; removing one that is not there is not an error |
| `clear()` | `undefined` | empties **this** scope only, disabled rows included |
| `toObject()` | plain object | every enabled variable, each value as `get()` answers it; a snapshot, not a live view |
| `replaceIn(template)` | string | resolves `{{name}}` against **this scope's** enabled values alone, so a name only another scope defines stays `{{name}}`; `{{$guid}}` and the other generators, `{{$vu}}` / `{{$iteration}}` and a bound row's columns answer as they do on `pm.variables.replaceIn` ([below](#the-local-scope-pmvariablesset)); a non-string is a `TypeError` naming the call |

```javascript
if (pm.environment.has('auth_token')) {
	pm.environment.unset('auth_token');
}

console.log(pm.environment.toObject());
```

#### A name a token cannot read back is refused (#3461)

`{{ name }}` is looked up with the spaces, tabs and line breaks cut from both ends, and a reference stops at a brace.
A variable stored as `''`, `' pad '` or `'a}}b'` could therefore never be referenced, and the next save of that scope through the API would answer `400` for the key.
So `set` on any scope (`pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`, and the legacy `postman.setEnvironmentVariable` / `setGlobalVariable`, which delegate to them) throws a `TypeError` for such a name, naming the call and the reason, and stores nothing.
An extractor's `variable` is refused for the same names, in the same words (`variable_name_refusal`).
Spaces inside a name (`my var`), Unicode and dots are fine.
`unset` does not check, so a bad name that is already stored can still be removed.
Postman stores such a name; Vayu refuses it because nothing could ever read it.

`unset()` is not the same as `set(name, '')`.
An emptied variable is still an enabled row, so `{{auth_token}}` resolves to the empty string; an unset one is gone, and the template resolves as it does for a name nobody defined.
The removal reaches disk as part of the run's delta: a name the run loaded and no longer holds is removed from the stored scope, while a name another client added meanwhile is not the run's to remove, so `clear()` empties only what the run loaded.

A scope the run was not given (a design run with no active environment, say) behaves as an empty one: `get` is `undefined`, `has` is `false`, `toObject` is `{}`, and writes go nowhere.
A script cannot see which scopes a run carries, so this is deliberately not an error.

## Collection and Global Variables

The other two scopes are reached the same way as the environment, each through its own accessor, and answer the same seven methods:

```javascript
const value = pm.collectionVariables.get('baseUrl');
pm.collectionVariables.set('baseUrl', 'https://api.example.com');

const runId = pm.globals.get('run_id');
pm.globals.set('run_id', '42');
```

Each `set()` persists to the scope it names, with the same keep-the-flags behaviour described for `pm.environment` above.

`pm.collectionVariables` reads the request's **whole collection chain**, the same merge `{{name}}` resolution uses: `get`, `has` and `toObject` take the nearest enabled definition, walking from the request's own collection up to the root.
A variable defined on a parent collection therefore reads the same in a script as it substitutes in a URL.
A step of a collection run reads its own request's chain too, sequential or under load, so a step in a sub-folder of the collection being run reads and writes that sub-folder, as a Send of it does (#3248), and a value one step writes into a folder is what later steps in that folder and below it read (under load, that virtual user's later steps).
A sibling folder does not see it.
A `script.setup` or `script.teardown` reads and writes the collection that declares it, which on a sub-folder run can be an ancestor of the collection being run, or on a run with nested collections a folder beneath it (#3456).

A request sent inline with no saved row linked (MCP's ad-hoc `run_request` with a `collectionId`, a direct API caller) reads the chain of the collection it was composed in: `POST /compose` writes that `collectionId` on its answer and `POST /execute` and `POST /runs` read the scope from it, so the script sees the same chain the request's `{{names}}` resolve against (issue #3461).
A linked saved request's own collection comes first; a collection that no longer exists is an empty scope.

**Writes stay on the request's own collection.**
`set`, `unset` and `clear` never reach an ancestor, so `set` on a descendant *shadows* an inherited name and `unset` un-shadows it - the ancestor's value comes back rather than being deleted.
A disabled row is looked past wherever it sits in the chain.
The full rule, and why ancestors are read-only, is in [Variable Resolution](../../app/variable-resolution.md).

## Variables (`pm.variables`)

`pm.variables` reads a name without naming its scope, resolving **the local scope first, then the bound data row (if one is bound), then environment, then collection, then global**, and stopping at the first tier that has it.
Below the local scope that is the same order `{{baseUrl}}` is resolved in before the request is sent (see [Variable Resolution](../../app/variable-resolution.md)), so a script and a URL in the same request cannot read one name two different ways.
The local scope is what `pm.variables.set` writes; it is described [below](#the-local-scope-pmvariablesset).

**While a data row is bound, its bare column names answer first** (issue #1007) - above environment, collection and globals.
Postman binds a dataset's columns bare, so an imported data-driven collection is written `{{username}}` rather than `{{data.username}}`, and `pm.variables.get`, `.has` and `.toObject` read the row before any scope for exactly that reason:

```javascript
// In a data-driven run, with a row carrying username and city:
pm.variables.get('username');   // this iteration's `username` cell, typed
pm.variables.has('username');   // true, even if an environment var of the
                                 // same name exists - the row wins
```

`get` and `toObject` hand the row's cell back **typed**, exactly as `pm.iterationData.get` does - a number column reads as a number, not a stringified one.
A name the bound row does **not** carry is not a miss on this tier alone; it falls through to environment, collection and globals precisely as it would with no data file at all, which is what lets one script run both in a data-driven run and a plain Send.
With no row bound, this tier is simply absent and `pm.variables` behaves exactly as it always has.
The reserved `data.` prefix is not part of this tier at all - `pm.variables.get("data.userId")` still answers `undefined` regardless of what row is bound (see below).

```javascript
const baseUrl = pm.variables.get('baseUrl'); // wherever it is defined
if (pm.variables.has('debug')) { /* ... */ }
console.log(pm.variables.toObject()); // every tier, merged, the local scope winning
```

### The local scope (`pm.variables.set`)

`pm.variables.set(name, value, options?)` writes Postman's *local* scope (issue #2564): the strongest tier of all, above a bound data row, and never stored anywhere.
It is for a value a script computes for this run and nothing after it - a signature, a nonce, a counter - which no named scope can hold without the value reaching disk at the run's end.

```javascript
pm.variables.set('nonce', Date.now());
pm.variables.get('nonce'); // the number as set
// a header written {{nonce}} goes out carrying its text
```

- **Every read sees it first.**
  `get`, `has`, `toObject`, `replaceIn` and `pm.sendRequest` read it above the row and the named scopes, and so does the pass that resolves what composition left after the pre-request script, so a `{{nonce}}` header goes out with the value.
  A name composition substituted for a request no pre-request script runs before, or the data-row bind already answered before the script ran, keeps that answer ([decision D1](../../app/variable-resolution.md)).
  `{{data.column}}` is the row's own spelling and never reads the local scope.
- **The writes are the scoped ones.**
  `set` keeps the value's type for the run and stores its string form for `{{name}}`,
  exactly as [the named scopes' `set`](#a-value-keeps-its-type-for-the-run) does, and it reads [the third argument](#the-third-argument-of-set-2664) too, though a `secret` flag here is never stored or masked; `unset(name)` removes one local name, so the tiers below it answer again; `clear()` empties the local scope.
  None of the three touches the environment, the collections or the globals.
- **Nothing stores it.**
  The run's variable write-back never reads it, the Variables panel and the variable popover never show it, and a run's stored snapshot does not carry it.

How long it lives is the run that owns it:

| Where the script runs | The local scope lives for |
|---|---|
| A single Send or `POST /execute` (buffered or streaming) | that send: the pre-request script, the send and the test script |
| A collection run | the whole run - every step of every iteration, `script.setup` and `script.teardown` included - and is discarded when the run ends |
| A scenario load run | one virtual user's iteration: each user holds its own, empty at the start and cleared at its iteration boundary; the user's environment, collection and globals writes are not local and carry on (#3044) |
| A single-request load run with `requestElements` | one submission, starting empty |
| A load run's deferred `tests` replay | the replay pass: one scope, empty at the start and shared by every replayed sample of every step, as the replay's other writes are; never stored |

Under load, `script.setup` and `script.teardown` belong to no virtual user, so what they set with `pm.variables.set` ends with them: setup's local scope is discarded before the first submission, and a value every user should start from belongs in a named scope instead.

**`pm.variables.replaceIn(template)`** - Postman's `{{name}}` interpolation of an arbitrary string - runs the same resolver `POST /compose` uses (`request_composer.cpp::resolve_template`), over the script's scopes in `pm.variables`' precedence, at **call time** -
so a variable the script set a line earlier resolves at once, where the request's own `{{}}` in the URL waits for the pre-request script to end (#2521).
Dynamic variables generate per occurrence:

```javascript
const id = pm.variables.replaceIn("{{$guid}}"); // fresh UUID v4
```

Its argument must be a string (a non-string is a `TypeError`).
The three scopes have their own `replaceIn` (issue #3133): `pm.environment.replaceIn`, `pm.globals.replaceIn` and `pm.collectionVariables.replaceIn` run this same resolver over that one scope's enabled values only (the collection scope with its ancestors), so a name another scope defines stays `{{name}}`, and the run-local scope is read by the merged form alone.
The generators, the identity and the bound row below answer on all four, and each refusal names the call written.
This is the one sanctioned way to `{{...}}` in a script: script *source* is never interpolated (issue #226, D16 - a rewrite cannot tell code from a string literal, and splicing values into source is an injection).
The editor now paints that difference rather than leaving it to this page alone: a `replaceIn(...)` template's tokens get the full colour and popover a body field's do, while a bare `{{name}}` written anywhere else paints muted and its hover names this section and `pm.variables.replaceIn` as the fix (issue #1220 script support, `docs/app/COMPONENTS/shared-variable-input.md`).

**It resolves the reserved data namespace too** (issue #890), which composition deliberately does not: `resolve_template` leaves `{{data.column}}` written as it stands because a plan is composed once, before any row is bound, while this runs per step with the iteration's row in hand.
A column the row does not carry is a `TypeError` naming the token and the row's columns - the bind-time rule (`apply_iteration_template`) in a shape a script can catch - and with no row bound at all the token keeps its braces.

**The reserved `data.` prefix is still not a variable scope, though.**
`pm.variables.get("data.userId")` and `.has(...)` answer `undefined` / `false` regardless of what row is bound - `data.` is disjoint from the variable scopes by design (`core/scenario_data.hpp`), and `pm.iterationData` remains its only accessor.
That is a different question from the **bare** column names above: `pm.variables.get("userId")` *does* read the bound row (issue #1007), so only the prefixed spelling stays outside `pm.variables` entirely.
`replaceIn` resolves both spellings because it renders a *template*, and `{{data.userId}}` is a token template syntax has - `get` and `.has` are lookups by name, and `data.userId` was never a name any scope, or now the row, answers to.

**The identity namespace resolves from `replaceIn` too** (issue #1057).
`{{$vu}}` and `{{$iteration}}` render to numbers, the same way `{{data.column}}` does above: the resolver takes the identity the request beside the script was bound with, ahead of every scope and ahead of the row, so `replaceIn` and the request cannot disagree about one send.
Which numbers those are is the run's own question, answered per shape in [the binding table](../../app/variable-resolution.md#vu-and-iteration-are-reserved-too-for-the-same-reason): a collection run in design mode is one user walking the sequence, so `{{$vu}}` renders `1` while `{{$iteration}}` advances with the pass.
On a plain Send the numbers are `1` and `0`, because `POST /execute` binds exactly those into every send that carries no row of its own (a single send is a run of one, issue #994) - and it binds them before the pre-request script runs, so they are what the request the script is handed already carries.

That is not the same fact [`pm.info.vu` and `pm.info.iteration`](info-and-setup.md#script-identity-pminfo) carry, and the two staying different is not a contradiction to resolve: `pm.info` answers which iteration of which run this script is running in, and reads `undefined` on that same plain Send because there is no run to be an iteration of.
A token in a template answers what it resolves to *here*, and here it resolves to what the request beside it carried - a run of one has an identity even though it has no `pm.info`.

**Dynamic variables are otherwise not readable from a script.**
`{{$guid}}`, `{{$timestamp}}` and the rest of the set in [variable resolution](../../app/variable-resolution.md#dynamic-variables) are generated while the payload is composed; by the time a script runs, that payload holds the generated *value* and no scope has ever heard of the name.
`pm.variables.get("$guid")` reads as any other undefined name does - reach the generators through `replaceIn`.
