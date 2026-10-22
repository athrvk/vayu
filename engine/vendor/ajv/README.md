# ajv (vendored)

The npm package [`ajv`](https://www.npmjs.com/package/ajv), version
**6.12.5**, with the four packages its browser bundle carries:

| Package | Version | Licence | Licence file |
|---------|---------|---------|--------------|
| `ajv` | 6.12.5 | MIT | `LICENSE` |
| `fast-deep-equal` | 3.1.x | MIT | `LICENSE.fast-deep-equal` |
| `fast-json-stable-stringify` | 2.x | MIT | `LICENSE.fast-json-stable-stringify` |
| `json-schema-traverse` | 0.4.1 | MIT | `LICENSE.json-schema-traverse` |
| `uri-js` | 4.4.0 | BSD-2-Clause | `LICENSE.uri-js` |

Each licence file is the package's own `LICENSE`, copied unchanged, from the
tarballs below. The minified file drops the `@license` banner `uri-js`
carries, so `LICENSE.uri-js` is the notice its BSD-2-Clause licence requires.

- Sources and integrity (registry `dist.integrity`, each checked against the
  tarball):
  - <https://registry.npmjs.org/ajv/-/ajv-6.12.5.tgz>
    `sha512-lRF8RORchjpKG50/WFf8xmg7sgCLFiYNNnqdKflk63whMQcWR5ngGjiSXkL9bjxy6B2npOK2HSMN49jEBMSkag==`
  - <https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz>
    `sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==`
  - <https://registry.npmjs.org/fast-json-stable-stringify/-/fast-json-stable-stringify-2.1.0.tgz>
    `sha512-lhd/wF+Lk98HZoTCtlVraHtfh5XYijIjalXck7saUtuanSDyLMxnHhSXEDJqHxD7msR8D0uCmqlkwjCV8xvwHw==`
  - <https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-0.4.1.tgz>
    `sha512-xbbCH5dCYU5T8LcEhhuh7HJ88HXuW3qsI3Y0zOZFKfZEHcpWiHU/Jxzk629Brsab/mMiHQti9wMP+845RPe3Vg==`
  - <https://registry.npmjs.org/uri-js/-/uri-js-4.4.0.tgz>
    `sha512-B0yRTzYdUCCn9n+F4+Gh4yIDtMQcaJsmYBDsTSG8g/OejKBodLQ2IHfN3bM7jUsRXndopT7OIXWdYqc1fjmV6g==`
- File: `ajv.min.js` is the ajv tarball's `dist/ajv.min.js`, byte for byte
  (122,009 bytes, 2 lines, no trailing newline, ASCII only; SHA-256
  `5d335583bc50d693080b5ec9f4d9f7e83090bcb92bb3421ad103e4dbebaab49a`). Do not
  reformat or edit it. Its last line names a source map the package ships and
  this directory does not; nothing reads it.

ajv 6.12.5 is what Postman's sandbox 6.8.0 pins, and the fingerprint of its
published bundle (`.cache/bootcode.js`) agrees: it carries the
`strictNumbers` option, which ajv added in 6.12.3. The dependency versions
inside `dist/ajv.min.js` are the ones ajv's own build bundled, read off the
code: `uri-js` names itself v4.4.0, `json-schema-traverse` matches 0.4.1, and
`fast-deep-equal` and `fast-json-stable-stringify` match every release of the
3.1 and 2.x lines from 3.1.1 and 2.0.0 on, whose code is identical; the
licence files come from the newest of those, 3.1.3 and 2.1.0. Postman bundles
`lib/ajv.js` with its own resolution of the same ranges, so its `uri-js` can
be a later 4.x.

## What the module is

The module is the `Ajv` constructor, callable with or without `new`, with
`ValidationError`, `MissingRefError` and `$dataMetaSchema` on it, as on Node.
It validates draft-07 and adds no other meta-schema: a `$schema` naming
draft-04 or draft-06 is refused until a script adds that meta-schema with
`addMetaSchema`, as in Postman. Its default logger is `console`, the
sandbox's. The bundle is a browserify build behind a UMD wrapper; given a
`module` and `exports` it takes the CommonJS branch and assigns no global.
Every module it requires is in its own map, so its loader never falls back to
the global `require`.

ajv compiles each schema into JavaScript and builds a function from it with
`new Function`, which the sandbox allows.

The vendored file was checked by evaluating it the way the engine does (a
strict-mode function with a local `module` and `exports`, in a Node `vm`
context with no Node globals) and comparing 140 verdicts and their `errors`
arrays, with `allErrors` on, against the unbundled package running on Node:
every one matched, and the context's global object gained nothing.

Where ajv and `pm.response.to.have.jsonSchema` (the engine's native draft-07
validator) agree and where they do not is pinned by
`tests/script_json_schema_conformance_test.cpp` and its fixture.

## Cost

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
the first `require('ajv')` of an execution evaluates it
(`src/runtime/require_shelf.cpp`, `src/runtime/ajv_glue.hpp`); a script that
does not require it pays nothing. Measured as
`docs/engine/building.md#first-load-cost` describes (medians of 101 runs after
three warm-ups, pinned to one core, gcc 13), on a box where csv-parse read
1.3 ms and 3.5 ms, chai 8.0 ms and 22 ms and xml2js 13 ms and 33 ms:

| | `-O2` | Debug (`-O0`) |
|---|---|---|
| First `require('ajv')` | 21 ms | 55 ms |
| Then the first `new Ajv().compile(schema)` and a call | 10 ms | 35 ms |

The first load is the shelf's dearest, past xml2js. The first compile also
compiles the draft-07 meta-schema the schema is checked against, which is
most of its cost; a later compile in the same execution costs what its own
schema does. The evaluated module holds about 1,000 KB of the script's memory
until the execution ends (the same harness reads chai at about 720 KB). A
compile runs on the script's own stack budget, not the library's: the
measured schema (four levels of nesting, `allErrors` on) needed between 48 and
64 KB in a gcc `-O0` build, inside the 256 KB default.

To upgrade within 6.x, replace `ajv.min.js` and `LICENSE` from the new
tarball, re-read the dependency versions its bundle carries and replace their
licence files, and update the versions, integrities, size and hash here. ajv
7 and later ship no `dist/ajv.min.js`, validate draft-04 only through a
separate package and report `instancePath` where 6 reports `dataPath`, so a
move to one is a behaviour change for scripts, not an upgrade.
