# lodash (vendored)

The npm package [`lodash`](https://www.npmjs.com/package/lodash), version
**4.17.21**, MIT (`LICENSE`, copied from the package's `LICENSE`).

- Source: <https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz>
- Integrity (registry `dist.integrity`, checked against the tarball):
  `sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==`
- File: `lodash.min.js` is the package's `lodash.min.js`, byte for byte
  (73,015 bytes, 140 lines, no trailing newline). Do not reformat or edit it.

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
`require('lodash')` or a first read of the `_` global evaluates it
(`src/runtime/require_shelf.cpp`, `src/runtime/lodash_glue.hpp`). To upgrade,
replace `lodash.min.js` and `LICENSE` from the new tarball and update the
version and integrity here; the glue depends on lodash taking its CommonJS
branch (`freeModule`) when `module` and `exports` are in scope. lodash reads the
`_` global while it evaluates (its `noConflict` value); the shelf answers that
read with `undefined`.
