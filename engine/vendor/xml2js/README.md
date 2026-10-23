# xml2js (vendored)

The npm package [`xml2js`](https://www.npmjs.com/package/xml2js), version
**0.6.2**, with the two packages it depends on, bundled into one file:

| Package | Version | Licence | Licence file |
|---------|---------|---------|--------------|
| `xml2js` | 0.6.2 | MIT | `LICENSE` |
| `sax` | 1.2.4 | ISC (its `String.fromCodePoint` polyfill MIT) | `LICENSE.sax` |
| `xmlbuilder` | 11.0.1 | MIT | `LICENSE.xmlbuilder` |

Each licence file is the package's own `LICENSE`, copied unchanged except that
`xmlbuilder`'s CRLF line endings are LF here.

- Provenance: the `xml2js` entry of `engine/vendor/js-manifest.json` holds the
  tarball URLs, their registry `dist.integrity` values, the build and this file's SHA-256.
  `scripts/vendor-js/rebuild.sh xml2js` fetches the tarballs, checks each integrity
  and rebuilds the file; the `VendorJsManifest` tests hash it on every test run.
- File: `xml2js.min.js` is `xml2js`'s `lib/` (`xml2js.js` and the five
  modules it requires, 21,490 bytes), `sax`'s `lib/sax.js` (43,541 bytes) and
  `xmlbuilder`'s `lib/` (39 files, 133,660 bytes), bundled and minified by
  esbuild (98,939 bytes, 13 lines, trailing newline, ASCII only). It is
  build output: do not reformat or edit it, rebuild it.

These are the versions Postman's sandbox gives `require('xml2js')` and its
`xml2Json` global. Sandbox 6.8.0 pins `xml2js` 0.6.2; the `sax` in its
published bundle (`.cache/bootcode.js`) is 1.2.4, read off the code itself:
it has 1.2.4's `isNaN` check on a numeric entity, which 1.2.3 lacks, and none
of the `unparsedEntities` or `unquotedAttributeValues` options 1.3.0 and 1.4.0
added. `xmlbuilder` 11.0.1 is what xml2js's `~11.0.0` resolves to; its `lib/`
is identical to 11.0.0's. A later `sax` reads some documents differently
(1.4.0 reworks how a DOCTYPE's internal subset is read, and by 1.6.1 it
checks characters and the declared encoding), so it is pinned rather than
taken from xml2js's `>=0.6.0` range.

## What the build does

xml2js 0.6.2 is a Node build. Its `Parser` extends Node's `EventEmitter` and
schedules an `async: true` parse with `timers.setImmediate`, and `sax` reads
`stream` when it loads and `string_decoder` when a `SAXStream` is written a
`Buffer`. The four files in `shims/` (build input only, never embedded) supply
what those paths reach, and esbuild binds each inside the bundle; the file
defines no global. The output is wrapped in a function and assigns the
module's members to the free `exports`, so it needs `exports` in scope and
nothing else: no `Buffer`, `process`, `require` or `setImmediate`.

- `shims/events.cjs`: the module is the `EventEmitter` constructor (the parser
  extends the module itself), with `on` (and `addListener`), `emit` and
  `removeAllListeners`. `emit('error')` with nothing listening throws the
  error, as Node's does. `once`, `off`, `listeners` and the rest of Node's
  emitter are cut, so a script that calls them on a `Parser` gets a
  `TypeError`.
- `shims/timers.cjs`: `setImmediate(fn, ...args)` is a zero-delay
  `setTimeout`. The script sandbox runs every queued timer before the script
  ends, so an `async: true` parse still calls back inside the script.
- `shims/stream.cjs`: an empty `Stream` constructor, which `sax` builds
  `SAXStream.prototype` on. xml2js never creates a `SAXStream`.
- `shims/string_decoder.cjs`: a `StringDecoder` that throws. Only
  `SAXStream.write()` with a `Buffer` reaches it, which nothing here can.

Input is a string. A `Buffer` is not supported (the sandbox has none), and
what is cut changes nothing about `parseString`, `parseStringPromise`,
`Parser` or `Builder`.

To reproduce it, run `scripts/vendor-js/rebuild.sh xml2js`; the pinned esbuild and
its exact arguments are the manifest entry's `build`, and the four files in
`shims/` are listed there as inputs. The script extracts each tarball,
integrity-checked, to `node_modules/<name>`, so the one `sax` 1.2.4 is the one
bundled. The result is byte-identical to the committed file. It was checked by
evaluating it the way the engine does (a strict-mode function with a local
`module` and `exports`, in a context with no Node globals but `setTimeout`) and
comparing
27 `parseString` inputs (options, attributes, entities, CDATA, namespaces, a
byte-order mark, non-strict mode and seven malformed documents), nine
`Builder` outputs, an `async: true` parse and `parseStringPromise`'s resolve
and reject with the unbundled packages running on Node's own built-ins: every
result and every error message matched.

To upgrade, rebuild from the new tarballs, replace the licence files, and
update the versions and sizes here and the manifest entry
(`docs/engine/building.md#upgrading-a-vendored-library`). xml2js 0.6.x is the
line Postman ships; a move off it, or to another `sax`, is a behaviour change
for scripts, not an upgrade.
