# uuid (vendored)

The npm package [`uuid`](https://www.npmjs.com/package/uuid), version
**8.3.2**, MIT (`LICENSE`, copied from the package's `LICENSE.md`).

- Source: <https://registry.npmjs.org/uuid/-/uuid-8.3.2.tgz>
- Integrity (registry `dist.integrity`, checked against the tarball):
  `sha512-+NYs2QeMWy+GWFOEm9xnn6HCDp0l7QBD7ml8zLUmJ+93Q5NF0NocErnwkTkXVFNiX3/fpC6afS8Dhb/gz7R7eg==`
- File: `uuid.min.js` is the package's `dist/umd/uuid.min.js`, byte for byte
  (8,160 bytes, one line, no trailing newline). Do not reformat or edit it.

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`) and
`require('uuid')` evaluates it on first use (`src/runtime/require_shelf.cpp`,
`src/runtime/uuid_glue.hpp`). To upgrade, replace `uuid.min.js` and `LICENSE`
from the new tarball and update the version and integrity here; the glue
depends on the UMD wrapper taking its CommonJS branch.
