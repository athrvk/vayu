# uuid (vendored)

The npm package [`uuid`](https://www.npmjs.com/package/uuid), version
**8.3.2**, MIT (`LICENSE`, copied from the package's `LICENSE.md`).

- Provenance: the `uuid` entry of `engine/vendor/js-manifest.json` holds the
  tarball URL, the registry `dist.integrity`, the build and this file's SHA-256.
  `scripts/vendor-js/rebuild.sh uuid` fetches the tarball, checks the integrity
  and rebuilds the file; the `VendorJsManifest` tests hash it on every test run.
- File: `uuid.min.js` is the package's `dist/umd/uuid.min.js`, byte for byte
  (8,160 bytes, one line, no trailing newline). Do not reformat or edit it.

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`) and
`require('uuid')` evaluates it on first use (`src/runtime/require_shelf.cpp`,
`src/runtime/uuid_glue.hpp`). To upgrade, replace `uuid.min.js` and `LICENSE`
from the new tarball, update the version here and the manifest entry
(`docs/engine/building.md#upgrading-a-vendored-library`); the glue depends on
the UMD wrapper taking its CommonJS branch.
