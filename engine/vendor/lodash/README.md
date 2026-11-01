# lodash (vendored)

The npm package [`lodash`](https://www.npmjs.com/package/lodash), version
**4.18.1**, MIT (`LICENSE`, copied from the package's `LICENSE`).

- Provenance: the `lodash` entry of `engine/vendor/js-manifest.json` holds the
  tarball URL, the registry `dist.integrity`, the build and this file's SHA-256.
  `scripts/vendor-js/rebuild.sh lodash` fetches the tarball, checks the integrity
  and rebuilds the file; the `VendorJsManifest` tests hash it on every test run.
- File: `lodash.min.js` is the package's `lodash.min.js`, byte for byte
  (73,234 bytes, 136 lines, no trailing newline). Do not reformat or edit it.

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
`require('lodash')` or a first read of the `_` global evaluates it
(`src/runtime/require_shelf.cpp`, `src/runtime/lodash_glue.hpp`). To upgrade,
replace `lodash.min.js` and `LICENSE` from the new tarball, update the
version here and the manifest entry
(`docs/engine/building.md#upgrading-a-vendored-library`); the glue depends on
lodash taking its CommonJS branch (`freeModule`) when `module` and `exports`
are in scope. lodash reads the `_` global while it evaluates (its
`noConflict` value); the shelf answers that read with `undefined`.

lodash 4.18.1 is what Postman's sandbox 6.8.0 pins. It is also the first
release carrying the fixes for GHSA-xxjr-mmjv-4gpg and GHSA-f23m-r3pf-42rh
(`_.unset` and `_.omit` deleting from a built-in prototype through a crafted
path) and GHSA-r5fr-rjxr-66jc (`_.template` code injection through
`options.imports` key names). Since 4.18.0 `_.unset` and `_.omit` refuse a
`constructor` or `prototype` key mid-path and leave the object untouched, and
`_.template` throws on an `imports` key that is not an identifier.
