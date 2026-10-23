# lodash (vendored)

The npm package [`lodash`](https://www.npmjs.com/package/lodash), version
**4.17.21**, MIT (`LICENSE`, copied from the package's `LICENSE`).

- Provenance: the `lodash` entry of `engine/vendor/js-manifest.json` holds the
  tarball URL, the registry `dist.integrity`, the build and this file's SHA-256.
  `scripts/vendor-js/rebuild.sh lodash` fetches the tarball, checks the integrity
  and rebuilds the file; the `VendorJsManifest` tests hash it on every test run.
- File: `lodash.min.js` is the package's `lodash.min.js`, byte for byte
  (73,015 bytes, 140 lines, no trailing newline). Do not reformat or edit it.

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
`require('lodash')` or a first read of the `_` global evaluates it
(`src/runtime/require_shelf.cpp`, `src/runtime/lodash_glue.hpp`). To upgrade,
replace `lodash.min.js` and `LICENSE` from the new tarball, update the
version here and the manifest entry
(`docs/engine/building.md#upgrading-a-vendored-library`); the glue depends on
lodash taking its CommonJS branch (`freeModule`) when `module` and `exports`
are in scope. lodash reads the `_` global while it evaluates (its
`noConflict` value); the shelf answers that read with `undefined`.
