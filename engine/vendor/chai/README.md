# chai (vendored)

The npm package [`chai`](https://www.npmjs.com/package/chai), version
**4.4.1**, with the seven packages it depends on, bundled into one file:

| Package | Version | Licence | Licence file |
|---------|---------|---------|--------------|
| `chai` | 4.4.1 | MIT | `LICENSE` |
| `assertion-error` | 1.1.0 | MIT | `LICENSE.assertion-error` |
| `check-error` | 1.0.3 | MIT | `LICENSE.check-error` |
| `deep-eql` | 4.1.3 | MIT | `LICENSE.deep-eql` |
| `get-func-name` | 2.0.2 | MIT | `LICENSE.get-func-name` |
| `loupe` | 2.3.7 | MIT | `LICENSE.loupe` |
| `pathval` | 1.1.1 | MIT | `LICENSE.pathval` |
| `type-detect` | 4.0.8 | MIT | `LICENSE.type-detect` |

Each licence file is the package's own `LICENSE`, copied unchanged.
`assertion-error` 1.1.0 ships no licence file, so `LICENSE.assertion-error` is
the licence section of its `README.md`, from `(The MIT License)` to the end.

- Sources and integrity (registry `dist.integrity`, each checked against the
  tarball):
  - <https://registry.npmjs.org/chai/-/chai-4.4.1.tgz>
    `sha512-13sOfMv2+DWduEU+/xbun3LScLoqN17nBeTLUsmDfKdoiC1fr0n9PU4guu4AhRcOVFk/sW8LyZWHuhWtQZiF+g==`
  - <https://registry.npmjs.org/assertion-error/-/assertion-error-1.1.0.tgz>
    `sha512-jgsaNduz+ndvGyFt3uSuWqvy4lCnIJiovtouQN5JZHOKCS2QuhEdbcQHFhVksz2N2U9hXJo8odG7ETyWlEeuDw==`
  - <https://registry.npmjs.org/check-error/-/check-error-1.0.3.tgz>
    `sha512-iKEoDYaRmd1mxM90a2OEfWhjsjPpYPuQ+lMYsoxB126+t8fw7ySEO48nmDg5COTjxDI65/Y2OWpeEHk3ZOe8zg==`
  - <https://registry.npmjs.org/deep-eql/-/deep-eql-4.1.3.tgz>
    `sha512-WaEtAOpRA1MQ0eohqZjpGD8zdI0Ovsm8mmFhaDN8dvDZzyoUMcYDnf5Y6iu7HTXxf8JDS23qWa4a+hKCDyOPzw==`
  - <https://registry.npmjs.org/get-func-name/-/get-func-name-2.0.2.tgz>
    `sha512-8vXOvuE167CtIc3OyItco7N/dpRtBbYOsPsXCz7X/PMnlGjYjSGuZJgM1Y7mmew7BKf9BqvLX2tnOVy1BBUsxQ==`
  - <https://registry.npmjs.org/loupe/-/loupe-2.3.7.tgz>
    `sha512-zSMINGVYkdpYSOBmLi0D1Uo7JU9nVdQKrHxC8eYlV+9YKK9WePqAlL7lSlorG/U2Fw1w0hTBmaa/jrQ3UbPHtA==`
  - <https://registry.npmjs.org/pathval/-/pathval-1.1.1.tgz>
    `sha512-Dp6zGqpTdETdR63lehJYPeIOqpiNBNtc7BpWSLrOje7UaIsE5aY92r/AunQA7rsXvet3lrJ3JnZX29UPTKXyKQ==`
  - <https://registry.npmjs.org/type-detect/-/type-detect-4.0.8.tgz>
    `sha512-0fr/mIH1dlO+x7TlcMy+bIDqKPsw/70tVyeHW787goQjhmqaZe10uwLujubK9q9Lg6Fiho1KUKDYz0Z7k7g5/g==`
- File: `chai.min.js` is `chai`'s `index.js` and `lib/` (32 files, 289,924
  bytes) with the seven dependencies' entry files (76,492 bytes), bundled and
  minified by esbuild (68,034 bytes, 5 lines, trailing newline, ASCII only;
  SHA-256 `4ab2c9e2db44e5e18a2bc1a1f8ec69165d5b89f6bddcf55ffc261d9841eab3e1`).
  It is build output: do not reformat or edit it, rebuild it.

chai 4.4.1 is what Postman's sandbox 6.8.0 pins. The dependency versions are
the ones in its published bundle (`.cache/bootcode.js`), read off the code
itself rather than taken from chai's ranges, which resolve later releases
today: its `deep-eql` compares a `Set`'s or `Map`'s `size` without the
`try` 4.1.4 added, its `type-detect` finds the global object through `self`
and `global` rather than 4.1.0's `globalThis` probe, and its `loupe` carries
the 512-character function-name guard 2.3.7 added. chai 4.4.1's own source
still says `version = '4.3.8'`, so `require('chai').version` answers that, as
it does in Node.

The package also ships a browser build, `chai.js`, which is not used: it is a
browserify bundle whose module loader falls back to the global `require` (in
the sandbox, the shelf's own) for the `util` module `loupe` asks for, and its
`loupe` is 2.3.6, not the 2.3.7 Postman ships.

## What the build does

Nothing of chai is cut: the module is chai's whole export (`expect`, `assert`,
`should`, `use`, `config`, `AssertionError`, `Assertion`, `util`, `version`,
`Should`). The bundle is wrapped in a function and assigns `module.exports`,
so it needs a `module` in scope and nothing else: no `window`, `process`,
`Buffer` or `require`. Two of the dependencies reach for a host, and the build
settles both inside the bundle:

- `loupe` (chai's value printer) tries `require('util')` for Node's
  `util.inspect.custom` hook. Its `browser` field maps `util` to nothing,
  which `--platform=browser` honours, so the lookup finds no hook, as in a
  browser. It also tries `process.binding('util')` inside a `try` to print a
  promise's state; with no `process` a promise prints as `Promise{…}`.
- `type-detect` 4.0.8 reads the global object as `self` or the free name
  `global`; `--define:global=globalThis` makes that name `globalThis`, so
  `type-detect` reports the sandbox's global object as `'global'`.

`chai.should()` defines `should` on `Object.prototype` when it is called, as
chai does everywhere; loading the module does not.

To reproduce, in an empty directory:

```bash
npm install --no-save chai@4.4.1 assertion-error@1.1.0 check-error@1.0.3 \
  deep-eql@4.1.3 get-func-name@2.0.2 loupe@2.3.7 pathval@1.1.1 \
  type-detect@4.0.8 esbuild@0.28.2
npx esbuild node_modules/chai/index.js --bundle --format=cjs \
  --platform=browser --minify --legal-comments=none \
  --define:global=globalThis \
  '--banner:js=(function(){' '--footer:js=})();' \
  --outfile=chai.min.js
```

`npm ls --all` must show one copy of each dependency, deduplicated under
`chai`. The result is byte-identical to the committed file. It was checked by
evaluating it the way the engine does (a strict-mode function with a local
`module`, in a Node `vm` context with no Node globals) and comparing
`expect` passes and failures, `assert.deepEqual`, `should()`, a custom
message, a `Map` comparison and the misspelled-property refusal with the
unbundled packages running on Node: every answer and every error message
matched, and the context's global object gained nothing.

## Cost

The engine embeds it with `vayu_embed_js` (`engine/cmake/embed_js.cmake`), and
the first `require('chai')` of an execution evaluates it
(`src/runtime/require_shelf.cpp`, `src/runtime/chai_glue.hpp`); a script that
does not require it pays nothing. First use costs about 5.5 ms at `-O2` and
15 ms in a Debug build, and the evaluated module holds about 470 KB of the
script's memory until the execution ends (method and the box it was measured
on: `docs/engine/building.md#first-load-cost`).

To upgrade, rebuild from the new tarballs, replace the licence files, and
update the versions, integrities, sizes and hash here. chai 4.x is the line
Postman ships; chai 5 is ESM only and drops the CommonJS export the glue
reads, so a move to it is a rewrite, not an upgrade.
