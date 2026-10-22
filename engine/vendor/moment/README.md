# moment (vendored)

The npm package [`moment`](https://www.npmjs.com/package/moment), version
**2.31.0**, MIT (`LICENSE`, copied from the package's `LICENSE`).

- Source: <https://registry.npmjs.org/moment/-/moment-2.31.0.tgz>
- Integrity (registry `dist.integrity`, checked against the tarball):
  `sha512-0acOTfMiWOheYS4eoWb80yYMb/JLvVv9SHbs2PehaDzfUG0Bw855SKyk0IKTnPGa5+U2bmi3W68l1+sGLX/pvw==`
- File: `moment.min.js` is the package's `min/moment.min.js`, byte for byte
  (60,887 bytes, 8 lines, no trailing newline). Do not reformat or edit it.

This is the English-only build, with no locale files and no `moment-timezone`,
which is what Postman's sandbox gives `require('moment')` (it bundles
`moment/min/moment.min`, 2.30.1 in sandbox 6.8.0).

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
`require('moment')` evaluates it (`src/runtime/require_shelf.cpp`,
`src/runtime/moment_glue.hpp`). There is no `moment` global, as in Postman. To
upgrade, replace `moment.min.js` and `LICENSE` from the new tarball and update
the version and integrity here; the glue depends on moment taking its CommonJS
branch (`module.exports`) when `module` and `exports` are in scope.
