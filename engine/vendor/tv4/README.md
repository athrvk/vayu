# tv4 (vendored)

The npm package [`tv4`](https://www.npmjs.com/package/tv4), version **1.3.0**,
released into the public domain by its author, with MIT as the alternative
its `package.json` names (`LICENSE`, copied from the package's `LICENSE.txt`
with its CRLF line endings made LF, as `.gitattributes` stores every file; it
is the public-domain dedication, and the MIT text is only linked from the
package, at <http://jsonary.com/LICENSE.txt>).

- Source: <https://registry.npmjs.org/tv4/-/tv4-1.3.0.tgz>
- Integrity (registry `dist.integrity`, checked against the tarball):
  `sha512-afizzfpJgvPr+eDkREK4MxJ/+r8nEEHcmitwgnPUqpaP+FpwQyadnxNoSACbgc/b1LsZYtODGoPiFxQrgJgjvw==`
- File: `tv4.min.js` is the package's `tv4.js` (56,187 bytes) minified by
  esbuild (28,767 bytes, 1 line, trailing newline, ASCII only; SHA-256
  `c28d10ce8ed73805a50f32f630177c75d1a079223d17342615af255ec4fcda9a`). The
  package ships no minified build. It is build output: do not reformat or edit
  it, rebuild it.

tv4 1.3.0 is what Postman's sandbox 6.8.0 pins, and Postman binds it as the
`tv4` global as well as `require('tv4')`, one object. Postman deprecates the
global in favour of `require('ajv')`; it still runs there, so it runs here.

## What the module is

tv4 is a draft-04 validator. A draft-06 or draft-07 keyword (`const`,
`contains`, `propertyNames`, `if`/`then`/`else`, a numeric
`exclusiveMinimum`) is ignored, and `format` is checked only for a name a
script registers with `addFormat`. It keeps the last verdict on the object
(`tv4.error`, `tv4.missing`, `tv4.valid`), so the global and `require('tv4')`
share it. The package's `lang/` message files are not included: the messages
are English, as in Postman.

The minification only renames tv4's locals and shortens its code; no member
changes. It renames tv4's internal constructors, so an error's stack names a
minified function, as it does in Postman's own minified bundle. The shelf
evaluates the file in strict mode, as it does every library: a method called
detached from the object (`const v = tv4.validate; v(data, schema)`) throws a
`TypeError` where Postman's sloppy-mode bundle would write `error`, `missing`
and `valid` onto the global object. Called as `tv4.validate(...)` it behaves
the same.

To reproduce, in an empty directory:

```bash
curl -O https://registry.npmjs.org/tv4/-/tv4-1.3.0.tgz
tar -xzf tv4-1.3.0.tgz
npm install --no-save esbuild@0.28.2
npx esbuild package/tv4.js --minify --legal-comments=none --outfile=tv4.min.js
```

The result is byte-identical to the committed file. It was checked by
evaluating it the way the engine does (a strict-mode function with a local
`module` and `exports`, in a Node `vm` context with no Node globals) and
comparing 140 verdicts and the first error's message with the unminified
package on Node: every one matched, and the context's global object gained
nothing.

## Cost

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
the first `require('tv4')` or read of the `tv4` global in an execution
evaluates it (`src/runtime/require_shelf.cpp`, `src/runtime/tv4_glue.hpp`); a
script that touches neither pays nothing. Measured as
`docs/engine/building.md#first-load-cost` describes, on the box where
csv-parse read 1.3 ms and 3.5 ms: 2.7 ms at `-O2` and 6.5 ms in a Debug build,
and a first `tv4.validate` of a four-level schema 0.12 ms and 0.37 ms more.
The evaluated module holds about 190 KB of the script's memory until the
execution ends.

To upgrade, rebuild from the new tarball, replace `LICENSE`, and update the
version, integrity, sizes and hash here. tv4 has had no release since 1.3.0.
