---
description: >-
  The scripting completions and type-declaration routes the editor reads.
---

# Scripting

## GET /scripting/completions

Get script engine API completions for UI autocomplete.

**Response:**
```json
{
  "version": "1.0.0",
  "engine": "quickjs",
  "completions": [
    {
      "label": "pm.test",
      "kind": 1,
      "insertText": "pm.test(\"${1:test name}\", function() {\n\t${2:// assertions}\n});",
      "detail": "pm.test(name: string, fn: () => void)",
      "documentation": "Define a test with assertions..."
    }
  ]
}
```

An entry whose `kind` is `28` (Monaco's Snippet kind) carries two extra members no other entry does: `context`, one of `"pre"`, `"test"` or `"both"`, which script kind the template belongs in; and `group`, one of `"Variables"`, `"Request"`, `"Response"`, `"Tests"`, `"Signing"` or `"Logging"`, the heading it is listed under.
A client uses the pair to build a filtered, grouped snippets picker for whichever panel - Pre-request or Tests - the author has open, rather than offering the whole table regardless of where it would run.
Neither field is present on a non-snippet entry.

## GET /scripting/types

The same `pm.*` surface as TypeScript declarations, for Monaco's TypeScript worker.
A completion list can only populate a dropdown; the declarations are what give hover documentation over an existing call, signature help while typing arguments, and go-to-definition within the surface.

The declarations are **generated from the completion table above**, not maintained separately - a hand-written `pm.d.ts` in the app would be a second declaration of a surface the engine owns, and the two would drift the first time a method was added to one and not the other.
The derivation works because a completion entry already carries its type: a function's `detail` is its signature, a field's `detail` is its type.
See `engine/src/http/routes/script_types.cpp`.

Output is deterministic - the same table always produces byte-identical text, so a client may cache on `version`.

**Response:**
```json
{
  "version": "1.0.0",
  "engine": "quickjs",
  "libUri": "ts:vayu/pm.d.ts",
  "typeDefinitions": "interface VayuExpectation {\n\tequal(expected: any): VayuExpectation;\n…"
}
```

| Field | Description |
|-------|-------------|
| `libUri` | Model URI the app registers the declarations under (`addExtraLib`) |
| `typeDefinitions` | The `.d.ts` source |

The file also declares the names a script may reach for that the sandbox **lacks**, with the reason as documentation: the host globals of a browser or Node (`fetch`, `URL`, `Buffer`, ...), and the libraries Postman bundles that the `require()` shelf does not carry (`cheerio`, `Backbone`), whose hover names the replacement Postman itself gives.
`require`, `CryptoJS`, `_`, `tv4` and `xml2Json` are declared as what they are, with a `declare module` for each name on the `require()` shelf (`crypto-js` #2578, `uuid` #2650, `lodash` #2651, `moment` #2652, `csv-parse/lib/sync` #2653, `xml2js` #2654, `chai` #2655, `ajv` and `tv4` #2656) and one `require` signature keyed on those names, so a name off the shelf is a type error.
Postman's `postman` object and its pre-`pm.*` globals (`tests`, `responseBody`, `responseCode`, ...) are not among them: they run (#2577), and are declared from the completion table like `pm` itself, each as the value it is.

It also carries interface augmentations for standard-library members the runtime runs but the TypeScript bundled with the editor does not declare yet (`RegExp.escape`, `Math.sumPrecise`, `JSON.rawJSON`, `Uint8Array.fromBase64` and `toHex`, and their siblings), under their own banner; a row retires when that TypeScript declares its members (#3485).

That is not padding: the app suppresses "Cannot find name" (2304), so a name that is merely undeclared draws nothing.
A name typed `never` makes the call, member access or assignment that follows an error ("not callable", "property does not exist").
`never` is assignable to everything, so a bare read passes (`console.log(cheerio)`).

Declaring a name does not reserve it: the app compiles each script as a module (`moduleDetection`), so a script's own `const data = ...` shadows the declared `data` instead of redeclaring it.
A test executes `typeof <name>` in the real script engine for every root, so the list cannot drift from the runtime, and an entry leaves the table in the commit that makes the runtime provide it.

**The assertion chain is one interface, read by leaf rather than by path** (#1209).
A completion label is a dotted spelling - `to.have.deep.property` is what someone types - and not the shape of the object: `create_expectation` installs `to`, `have`, `deep` and `property` on the same expectation, and every one of them hands that expectation back.
So the generator takes each label's last segment as the member and every earlier segment as evidence that word is a chainer, and emits a single `VayuExpectation` where every chain word is a property of that type and every matcher a method returning it - chai's own model.
Read as a path tree it emitted two interfaces instead, and a matcher was reachable only along the one route some label happened to spell, so `.to.be.a('string').and.match(/x/)` was an editor error on a chain the engine runs.
Where two labels share a leaf (`to.have.property`, `to.have.deep.property`, `to.have.nested.property`), the plainest spelling declares the member and the longer ones fold their documentation into its hover under their own labels.

The guard is set equality rather than a list of names: `TheDeclaredChainIsTheObjectTheRuntimeBuilds` reads the interface's members out of the generated text and the expectation's out of the real script engine (`Object.getOwnPropertyNames`, so no terminal getter is triggered) and fails on a member either side has alone.
A matcher added to the runtime and not to the table now reddens instead of being missing.

Two things the generated file still cannot get from the table, both handled in `script_types.cpp` and guarded by `script_types_test.cpp`:

- **Which label roots open the chain.**
  `that.is.not.empty` is a chain and `console.log` is a global, and nothing in either entry says which; the chain roots (`to`, `and`, and chai's twelve language chains) are named in the generator, so a label rooted at one is filed under the chain rather than declaring a top-level `that` nothing binds.
- **Unparseable parameter lists.**
  Two entries document an overload in prose TypeScript cannot parse (`upsert({ key, value }) | (name, value)`).
  Those fall back to `(...args: any[])`, keeping the member callable rather than emitting a file that does not compile.

### The declarations are compiled, not just grepped

`script_types_test.cpp` asserts on substrings of the generated text - every listed member appears, the chain returns the chain, an optional field keeps its type.
That cannot catch the class of defect where a declaration contains every right name and still does not type-check, and four of those shipped (#463):
`pm.cookies.jar()` emitted twice with the `object` overload winning, every jar method's signature emptied by the `()` inside its own label, `pm.info.eventName` read as prose and typed `void`, and two `pm.expect` chains shorter than the documentation beside them.

So the durable guard compiles **every ` ```javascript ` block mentioning `pm.`** in [`scripting.md`](../scripting.md) and [`pm-api-compatibility.md`](../../app/pm-api-compatibility.md) against the real declarations and requires zero errors,
with the app's own compiler options and suppressed codes. The same suite compiles scripts that use the absent names and requires the error each should draw, and scripts that declare one themselves and requires none. The documentation and the declarations then hold each other up:
an example the editor would squiggle fails the suite, and so does a declaration that stops describing what the docs recommend.

It needs a TypeScript compiler, which ctest does not have, and the generator needs the engine, which vitest cannot run.
The two halves meet at one checked-in artifact - the same shape as `variable-resolution-conformance.json`:

| Where | What |
|-------|------|
| `engine/tests/fixtures/script-typedefs.d.ts` | The generated declarations, checked in |
| `ScriptTypesTest.TheCheckedInDeclarationsMatchTheGenerator` | Pins that file to the generator byte-for-byte, so the copy cannot drift |
| `app/src/hooks/script-typedefs.docs-compile.test.ts` | Compiles the docs' blocks against it |

A change to the surface therefore shows up as a diff in the declarations the editor will serve.
Regenerate deliberately:

```bash
VAYU_UPDATE_SCRIPT_TYPEDEFS=1 ctest --preset linux-dev -R ScriptTypes
```
