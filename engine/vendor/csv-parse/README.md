# csv-parse (vendored)

The npm package [`csv-parse`](https://www.npmjs.com/package/csv-parse), version
**1.2.4**, BSD-3-Clause (`LICENSE`, copied from the package's `LICENSE`).

- Source: <https://registry.npmjs.org/csv-parse/-/csv-parse-1.2.4.tgz>
- Integrity (registry `dist.integrity`, checked against the tarball):
  `sha512-Mv4Ly6mshOHEIlnVGB/PZtDCT+vyvyCs5Qae/lLeAIlKNR4W7TkmSGmB10uPm7aJQYcTO/rswLzUcYu6wFlAYg==`
- File: `csv-parse-sync.min.js` is the package's `lib/sync.js` (865 bytes) and
  the `lib/index.js` it requires (17,868 bytes), bundled and minified by
  esbuild (11,679 bytes, 7 lines, trailing newline; SHA-256
  `af59d0d02b63b3c65b9bc31aa36ec83bdf1fab8a4fa413a4c3e3015ae2040f64`). It is
  build output: do not reformat or edit it, rebuild it.

This is the version Postman's sandbox gives `require('csv-parse/lib/sync')`
(sandbox 6.8.0 pins `csv-parse` 1.2.4 and exposes only that path), so scripts
written for Postman see the same options and the same error messages. Later
majors renamed options (`auto_parse` is `cast` and `rowDelimiter` is
`record_delimiter` by 4.x) and export an object rather than the function.

## What the build does

1.2.4 is a Node build: `lib/index.js` subclasses `stream.Transform` and reads
`util`, `string_decoder` and `Buffer`. The sync API never streams (it replaces
the parser's `push()` and calls `__write()` and `_flush()` itself), so
`node-shims.mjs` (build input only, never embedded) supplies only what that
path reaches, and esbuild binds it inside the bundle; the file defines no
global. The output is wrapped in a
function and assigns `module.exports` the parse function, `(input, options) ->
records`, so it needs `module` in scope and nothing else: no `Buffer`,
`process`, `require`, `setImmediate` or `TextDecoder`.

- Input is a string. A `Buffer` is not supported (nothing is an instance of
  the shim's `Buffer`).
- `lib/index.js`'s callback API is bundled too, because `lib/sync.js` requires
  the module for its `Parser`. It is not exported and is the one place
  `process.nextTick` is still named; nothing reachable from the export calls
  it.
- A malformed record throws the library's own `Error` (for example
  `Quoted field not terminated at line 2`, or
  `Number of columns is inconsistent on line 2`). The unterminated-quote case
  reaches the caller through `emit('error')`, which the shim throws as Node
  does when nothing listens.

To reproduce, with `<repo>` this checkout:

```bash
curl -O https://registry.npmjs.org/csv-parse/-/csv-parse-1.2.4.tgz
tar -xzf csv-parse-1.2.4.tgz
npm install --no-save esbuild@0.28.2
SHIMS=<repo>/engine/vendor/csv-parse/node-shims.mjs
npx esbuild package/lib/sync.js --bundle --format=cjs --platform=neutral \
  --minify --legal-comments=none \
  --alias:stream=$SHIMS --alias:util=$SHIMS --alias:string_decoder=$SHIMS \
  --inject:$SHIMS '--banner:js=(function(){' '--footer:js=})();' \
  --outfile=csv-parse-sync.min.js
```

The result is byte-identical to the committed file. It was checked by
evaluating it the way the engine does (a strict-mode function with a local
`module` and `exports`, in a context with no Node globals) and comparing 27
inputs, the error cases included, with the unbundled package running on
Node's own built-ins: every output and every error message matched.

To upgrade within 1.x, rebuild from the new tarball, replace `LICENSE`, and
update the version, integrity, sizes and hash here. A move to a later major is
a behaviour change for scripts (the option renames above), not an upgrade.
