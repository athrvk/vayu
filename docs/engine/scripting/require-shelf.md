---
description: >-
  The modules a script can `require`, and what each provides.
---

# The `require` shelf

`require(name)` answers a **fixed shelf** of libraries Vayu bundles and throws `Cannot find module '<name>'` for any other name, listing what is on the shelf.
There is no loader behind it: nothing is read from disk, nothing is fetched, and a relative path or a package name that is not on the shelf is the same refusal.
The argument must be a string (anything else is a `TypeError`), and it is matched whole: `csv-parse/lib/sync` is on the shelf and `csv-parse` is not.
Today the shelf holds nine libraries, `crypto-js`, `uuid`, `lodash`, `moment`, `csv-parse/lib/sync`, `xml2js`, `chai`, `ajv` and `tv4`.
`CryptoJS` is the `crypto-js` module bound as a global, `_` is `lodash` and `tv4` is the `tv4` module, so both spellings of a Postman script work; `xml2Json` is not a module but Postman's parse function over `xml2js`, bound the same lazy way:

```javascript
const CryptoJS = require('crypto-js');
const signature = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Hex);
pm.request.headers.upsert({ key: 'X-Signature', value: signature });
```

A library is evaluated under its own stack budget, not the script's (`constants::script_engine::SHELF_LIBRARY_STACK_SIZE`, 768 KB; a script whose `scriptStackSize` is larger keeps it).
The library is Vayu's own vendored source, and how much native stack QuickJS's parser needs for it depends on the toolchain: MSVC at `/Od` under AddressSanitizer overflowed the default 256 KB `scriptStackSize` evaluating lodash and moment (#2652), while GCC at `-O0` loads them from 46 KB and 30 KB.
The script's budget is put back as soon as the library has loaded, so the script's own recursion is limited exactly as before.

## `crypto-js`

**It is Vayu's own code with crypto-js's shape, not the crypto-js library.**
The source is a 6 KB JavaScript shim; the hashing runs in OpenSSL through `vayu/utils/digest.hpp`, so a digest is exact.
What it covers, and all of it:

- the hashers `MD5`, `SHA1`, `SHA224`, `SHA256`, `SHA384`, `SHA512` and their `Hmac*` forms (`HmacSHA256(message, key)`, the argument order crypto-js uses), each taking a string (read as UTF-8) or a `WordArray`;
- `enc.Hex`, `enc.Latin1`, `enc.Utf8` and `enc.Base64`, each with `parse` and `stringify`;
- `lib.WordArray` (`create`, `toString`, `concat`, `clone`; `words` and `sigBytes`).

A member outside that list reads as `undefined`, as it does in a crypto-js build without that module, so calling it throws a `TypeError`: no ciphers (`AES`, `DES`, ...), no `PBKDF2` or `EvpKDF`, no progressive `algo.*` hashers, no `SHA3` or `RIPEMD160`, no `WordArray.random`, no `enc.Utf16`.
A wrong argument type (a number where a string or `WordArray` belongs) throws a `TypeError` rather than hashing something other than what was written.

The covered members are one list, `CRYPTO_JS_MEMBERS` (`include/vayu/runtime/shelf_modules.hpp`), which the Postman import's script scan reads: a collection that uses a `CryptoJS` member outside it is named `CryptoJS` in `meta.unsupportedScriptApis`, and one that stays inside it is not.
The scan reads a member off `CryptoJS`, `require('crypto-js')`, a name declared with `const`, `let` or `var` as either of them, or a destructure of one (`CryptoJsReads` in `script_api_scan.cpp`); a reassignment or a name handed through a parameter is not followed.
`script_completions_test.cpp` fails when the list and the shim, or the list and the editor's completions, disagree.

**Cost.**
The shim is evaluated on first use in an execution, never when a context is built, so a script that does not touch `require` or `CryptoJS` pays nothing.
First use costs about 0.55 to 0.75 ms; the evaluated module then lives for the rest of that execution (about 22 KB of the script's 64 MB limit) and is freed with the context.
Nothing is shared between executions, so the next script that uses it pays the first-use cost again.

## `uuid`

`require('uuid')` is **the npm `uuid` package itself**, version 8.3.2, vendored unmodified (`engine/vendor/uuid/`, MIT; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
The module is callable, which is how Postman's own `uuid` works, and carries npm's members on the same value:

```javascript
const uuid = require('uuid');
pm.environment.set('requestId', uuid());          // a v4, as in Postman
pm.environment.set('traceId', uuid.v4());         // the same, spelled npm's way
pm.environment.set('stable', uuid.v5('orders', uuid.v5.DNS));
uuid.validate(pm.environment.get('requestId'));   // true
```

`v1`, `v3`, `v4`, `v5`, `NIL`, `parse`, `stringify`, `validate` and `version` are all there, with npm's signatures (`v3.DNS` / `v3.URL` and `v5.DNS` / `v5.URL` included, and the optional output buffer).
There is **no `uuid` global** in Vayu: a script reads it with `require` only.
Postman's `uuid()` and `uuid.v4()` draw from `Math.random`; Vayu's draw from libsodium's CSPRNG, so a script that works in Postman works here and the values are unpredictable rather than merely unlikely to collide.
(`Math.random` stays a PRNG, seeded per thread from the same source: see [Isolation between scripts](sandbox.md#isolation-between-scripts).)
The bytes reach the library through a `crypto.getRandomValues` that exists only inside the library's own scope, so no script sees a `crypto` global.

**Cost.**
Like `crypto-js`, it is evaluated on first `require` in an execution and not when a context is built.
First use costs about 1.2 ms in a `-O2` build and 2.8 ms in a Debug build, nearly all of it parsing the library's single 8 KB line ([measured](../building.md#first-load-cost)); a script that never requires it pays nothing, and nothing is shared between executions.

The Postman import's script scan reads `require('uuid')` as the library it is, so a collection that uses it is not named in `meta.unsupportedScriptApis`.

## `lodash`

`require('lodash')` and the `_` global are **the npm `lodash` package itself**, version 4.18.1, the full build (`lodash.min.js`, 73,234 bytes) vendored unmodified (`engine/vendor/lodash/`, MIT; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
It is the whole library, not a subset, so every lodash 4 function is there, chaining (`_(list).filter(f).sum()`) included:

```javascript
const items = pm.response.json().items;
pm.environment.set('firstId', _.get(items, '[0].id'));
pm.environment.set('pages', _.chunk(items, 10).length);
const byStatus = require('lodash').groupBy(items, 'status');
pm.test('every item is grouped', () => pm.expect(_.sumBy(_.values(byStatus), 'length')).to.equal(items.length));
```

`_` and `require('lodash')` are one object within an execution, whichever the script reaches first.
Assigning `_` (`_ = something`) replaces the global without loading lodash, and a script's own `const _ = ...` is its own. lodash takes its CommonJS branch inside the shelf's glue, so loading it adds no global and finds no Node: the sandbox has no `module`, `exports`, `process` or `global`.

**Cost.**
Evaluated on first read of `_` or first `require('lodash')` in an execution, never when a context is built, so a script that touches neither pays nothing.
First use costs about 10 ms in a `-O2` build and 24 ms in a Debug build (QuickJS parsing and running the 73 KB library, measured in a fresh context, best of 20); the evaluated module then holds about 800 KB of the script's 64 MB limit until the execution ends.
Nothing is shared between executions, so the next script that uses it pays again.

The Postman import's script scan does not name `_` or `require('lodash')`.

## `moment`

`require('moment')` is **the npm `moment` package itself**, version 2.31.0, its `min/moment.min.js` (60,887 bytes) vendored unmodified (`engine/vendor/moment/`, MIT; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
It is the build Postman's sandbox gives `require('moment')`: plain moment, English only, no `moment-timezone` (Postman 6.8.0 ships 2.30.1).
It is reached only through `require`, as in Postman: **there is no `moment` global**, and a bare `moment` in a script is a `ReferenceError` unless the script declares it.

```javascript
const moment = require('moment');
pm.environment.set('expires', moment.utc().add(1, 'hour').toISOString());
pm.environment.set('stamp', moment('2026-10-21').add(1, 'day').format('YYYY-MM-DD'));
const age = moment.utc(pm.response.json().createdAt).diff(moment.utc('2026-01-01'), 'days');
```

Parsing and formatting without `utc` use the engine host's time zone, as moment does in Node, so a script that must give the same answer everywhere uses `moment.utc`.
The build carries no locale files: `moment.locale('fr')` asks the shelf's `require` for `./locale/fr`, is refused, and moment keeps English, so the call returns `'en'` and throws nothing.
`moment.tz` does not exist. moment takes its CommonJS branch inside the shelf's glue, so loading it adds no global.

**Cost.**
Evaluated on the first `require('moment')` in an execution, never when a context is built, so a script that does not require it pays nothing.
First use costs about 8 ms in a `-O2` build and 17 ms in a Debug build (QuickJS parsing and running the 61 KB library, measured in a fresh context, median of 101; [First-load cost](../building.md#first-load-cost) has the method); the evaluated module then holds about 550 KB of the script's 64 MB limit until the execution ends.
Nothing is shared between executions, so the next script that requires it pays again.

The Postman import's script scan does not name `require('moment')`.

## `csv-parse`

`require('csv-parse/lib/sync')` is **the npm `csv-parse` package, version 1.2.4**: its `lib/sync.js` and the `lib/index.js` it requires, bundled by esbuild into one 11,679-byte file (`engine/vendor/csv-parse/`, BSD-3-Clause; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
It is the version and the path Postman's sandbox gives (sandbox 6.8.0 pins 1.2.4 and exposes only `csv-parse/lib/sync`), so the options and the error messages are the ones a Postman script was written against.
The module **is the parse function**, `parse(input, options?)`, and answers the records; there is no global.

```javascript
const parse = require('csv-parse/lib/sync');
const rows = parse(pm.response.text(), { columns: true, skip_empty_lines: true });
pm.test('every row has an id', () => rows.forEach((row) => pm.expect(row.id).to.not.be.empty));
```

The options are 1.2.4's: `delimiter`, `rowDelimiter`, `quote`, `escape`, `columns`, `comment`, `objname`, `relax`, `relax_column_count`, `skip_empty_lines`, `skip_lines_with_empty_values`, `trim`, `ltrim`, `rtrim`, `auto_parse`, `auto_parse_date`, `from` and `to`.
Later majors renamed some (`auto_parse` is `cast` and `rowDelimiter` is `record_delimiter` by 4.x), so a script written for a newer csv-parse needs these names here as it does in Postman.

- The input is a string.
  A `Buffer` is not supported; the sandbox has none.
- A malformed record throws csv-parse's own `Error`, which a script can catch: `Quoted field not terminated at line 3`, `Number of columns is inconsistent on line 2`, `Invalid closing quote at line 3; found "y" instead of delimiter ","`.
  As in 1.2.4 itself, and so in Postman, a last record with the wrong number of fields and no line ending after it is dropped rather than refused.
- Only the whole name loads it.
  `require('csv-parse')`, csv-parse 5's `csv-parse/sync` and every other path under the package are refused like any name off the shelf.
- The bundle carries the few Node pieces the sync path reaches (a `Transform`, `util.inherits`, a `StringDecoder`) inside itself, so loading it adds no global: there is still no `Buffer`, `process` or `module` in the sandbox.

**Cost.**
Evaluated on the first `require('csv-parse/lib/sync')` in an execution, never when a context is built, so a script that does not require it pays nothing.
First use costs about 1.3 ms in a `-O2` build and 2.6 ms in a Debug build (QuickJS parsing and running the 12 KB library, measured in a fresh context, median of 101; [First-load cost](../building.md#first-load-cost) has the method); the evaluated module then holds about 90 KB of the script's 64 MB limit until the execution ends.
Nothing is shared between executions, so the next script that requires it pays again.

The Postman import's script scan does not name `require('csv-parse/lib/sync')`; it still names `require('csv-parse')` and every other path under the package.

## `xml2js`

`require('xml2js')` is **the npm `xml2js` package, version 0.6.2**, bundled by esbuild with the two packages it depends on, `sax` 1.2.4 and `xmlbuilder` 11.0.1, into one 98,939-byte file (`engine/vendor/xml2js/`; xml2js and xmlbuilder MIT, sax ISC, all three licences beside it; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
These are the versions Postman's sandbox 6.8.0 ships, so a parse answers the shape and the error messages a Postman script was written against.
The module is xml2js's whole export: `parseString`, `parseStringPromise`, `Parser`, `Builder`, `ValidationError`, `defaults` and `processors`.

```javascript
const xml2js = require('xml2js');
xml2js.parseString(pm.response.text(), (err, doc) => {
    pm.test('the order parsed', () => pm.expect(err).to.equal(null));
    if (!err) pm.environment.set('orderId', doc.order.id[0]);
});
const body = xml2Json(pm.response.text());   // { order: { id: '7', ... } }
```

- With xml2js's defaults every child element is an array (`<a><b>1</b></a>` is `{ a: { b: ['1'] } }`), attributes sit under `$` and an element's text beside them under `_`; `explicitArray: false` gives a child read once as its value and one repeated as an array.
- A document the parser refuses reaches the callback as an `Error` carrying sax's message (`Unclosed root tag`, `Unexpected close tag`, `Non-whitespace before first tag.`, `Invalid character entity`), with the line and column after it.
  Empty input is not an error: the callback is handed `null`.
- **When the callback runs.**
  With `async: false`, xml2js's default, the callback has run before `parseString` returns.
  With `async: true` the parse is scheduled through a zero-delay `setTimeout`, one per 10,000 characters, and the sandbox runs every timer before the script ends ([Timers](sandbox.md#timers-settimeout-and-setinterval)), so the callback still runs inside the script and a `pm.test` in it is recorded.
  `parseStringPromise` settles the same way.
- `new xml2js.Builder(options).buildObject(object)` writes XML back.
- The input is a string.
  The bundle carries the Node pieces xml2js reaches (an `EventEmitter` with `on`, `emit` and `removeAllListeners`, a `setImmediate` standing on `setTimeout`, and two stubs for `stream` and `string_decoder`) inside itself, so loading it adds no global.
  What was cut is the rest of Node's emitter: a script that calls `once` or `off` on a `Parser` gets a `TypeError`.
  A `Buffer` is not supported; the sandbox has none.
- Only the whole name loads it: `xml2js/lib/parser`, `sax` and `xmlbuilder` are refused like any name off the shelf.

**`xml2Json(xml)`** is Postman's own helper, the call its sandbox makes: `parseString` with `explicitArray: false`, `trim: true` and `mergeAttrs: false`, answering what the callback was handed, synchronously.
`xml2Json('<a><b> 1 </b><b>2</b></a>')` is `{ a: { b: ['1', '2'] } }`.
A document the parser refuses answers `undefined` (Postman drops the error, so reach for `require('xml2js')` to see it) and empty input answers `null`.
`xml2Json` is a function over the library, not the library: `xml2Json !== require('xml2js')`, and the module carries nothing it does not ship with.
Both share one evaluation of the library, whichever the script reaches first.
Assigning `xml2Json` replaces the global without loading anything.

**Cost.**
Evaluated on the first `require('xml2js')` or first read of `xml2Json` in an execution, never when a context is built, so a script that touches neither pays nothing.
First use costs about 16 ms in a `-O2` build and 42 ms in a Debug build (QuickJS parsing and running the 99 KB bundle, measured in a fresh context, median of 101; [First-load cost](../building.md#first-load-cost) has the method); the evaluated module then holds about 900 KB of the script's 64 MB limit until the execution ends.
Nothing is shared between executions, so the next script that uses it pays again.

The Postman import's script scan names neither `xml2Json` nor `require('xml2js')`; it still names `require('xml2js/lib/parser')` and every other path under the package.

## `chai`

`require('chai')` is **the npm `chai` package, version 4.4.1**, the version Postman's sandbox pins,
bundled by esbuild with the seven packages it depends on (`assertion-error`, `check-error`, `deep-eql`, `get-func-name`, `loupe`, `pathval`, `type-detect`, at the versions Postman's own bundle carries) into one 68,034-byte file (`engine/vendor/chai/`; all eight MIT, each licence beside it; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
The module is chai's whole export: `expect`, `assert`, `should`, `use`, `config`, `AssertionError`, `Assertion`, `util` and `version` (which reads `'4.3.8'`: chai 4.4.1's source was never bumped, and Node answers the same).

```javascript
const { expect, assert } = require('chai');
pm.test('the order is complete', () => {
    const order = pm.response.json();
    expect(order.status).to.equal('complete');
    assert.deepEqual(order.items, [{ id: 7, qty: 1 }]);
});
```

- **It is not `pm.expect`.**
  `pm.expect` is Vayu's own implementation of chai's `expect` ([`pm.expect()`](test-and-expect.md#pmexpect)); `require('chai')` is the library itself, a separate object, and loading it changes nothing about `pm.expect`.
- **It carries chai-postman's response assertions** (#2751), as Postman's chai does, so `expect(pm.response).to.have.status(200)` runs as `pm.response.to.have.status(200)` does: `status`, `statusCode`, `statusReason`, `statusCodeClass`, `header`, `body`, `jsonBody` and `jsonSchema` as calls;
  `ok`, `success`, `info`, `redirection`, `clientError`, `serverError`, `error`, `accepted`, `withoutContent`, `badRequest`, `unauthorized`, `unauthorised`, `forbidden`, `notFound`, `notAcceptable`, `rateLimited`, `json` and `withBody` as properties; and `responseTime` and `responseSize` as a call and a chain.
  Each forwards to the [native chain](response-headers-and-assertions.md#response-assertions), so the verdict and the message are that chain's and `.not` is its `to.not`.
  The target must be `pm.response` itself: any other value throws `TypeError: chai.<name> expects pm.response as the target of expect()`, rather than asserting on the execution's response while the script wrote about something else.
  `expect()`'s second argument is not used, as on `pm.response.to`. chai's own `ok` keeps its meaning for every other target.
  The plugin adds no member to the module, no global, and nothing to `pm.expect`.
  A failure is a Vayu `AssertionError`, not an instance of `chai.AssertionError`, exactly as for `pm.expect`.
- **A failure inside `pm.test` is an ordinary failed test** with chai's message: `expect(1).to.equal(2)` records `AssertionError: expected 1 to equal 2`, as a `pm.expect` failure would.
  Outside a `pm.test` it aborts the script with the same message, as any uncaught throw does.
  The error is an instance of `require('chai').AssertionError` and carries chai's `actual`, `expected` and `showDiff`.
- `chai.should()` defines `should` on `Object.prototype` when it is called, not when the module loads, so `(5).should.equal(5)` runs only after the call.
  Each script gets a fresh context, so the next script starts without it.
- `chai.use(plugin)` installs a plugin on this module only; nothing reaches `pm.expect`.
- What the bundle leaves out is host lookups only: `loupe`, chai's value printer, finds no Node `util.inspect` hook and no `process`, so a promise in a failure message prints as `Promise{…}`.

**Cost.**
Evaluated on the first `require('chai')` in an execution, never when a context is built, so a script that does not require it pays nothing.
First use costs about 5.5 ms in a `-O2` build and 15 ms in a Debug build (QuickJS parsing and running the 68 KB bundle, measured in a fresh context, median of 101; [First-load cost](../building.md#first-load-cost) has the method); the evaluated module then holds about 470 KB of the script's 64 MB limit until the execution ends.
Nothing is shared between executions.

The Postman import's script scan does not name `require('chai')`.

## `ajv`

`require('ajv')` is **the npm `ajv` package, version 6.12.5**, the version Postman's sandbox pins (not 6.6.2: its bundle carries `strictNumbers`, which ajv added in 6.12.3), as its own `dist/ajv.min.js` browser bundle,
122,009 bytes, vendored unmodified with the four packages it carries (`engine/vendor/ajv/`; MIT, and `uri-js` BSD-2-Clause, each licence beside it; see [Vendored JavaScript libraries](../building.md#vendored-javascript-libraries)).
The module is the `Ajv` constructor, callable with or without `new`, with `ValidationError` and `MissingRefError` on it, and it has no global:

```javascript
const Ajv = require('ajv');
const validate = new Ajv({ allErrors: true }).compile({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
});
pm.test('the body matches the schema', () => {
    pm.expect(validate(pm.response.json()), JSON.stringify(validate.errors)).to.be.true;
});
```

It validates draft-07 and adds no other meta-schema, so a `$schema` naming draft-04 or draft-06 is refused until a script calls `addMetaSchema`, as in Postman.
`validate.errors` is ajv 6's array (`dataPath`, `schemaPath`, `message`), `null` after a pass. ajv compiles each schema into a function with `new Function`, which the sandbox allows.
`require('ajv/lib/ajv')`, `ajv-formats` and every other path throw like any name off the shelf.

**It is not what `jsonSchema` runs.**
`pm.expect(x).to.have.jsonSchema` and `pm.response.to.have.jsonSchema` stay on the engine's native validator, which loads no library and compiles no schema.
The two must give a script the same verdict on the draft-07 vocabulary both cover, so a script ported from Postman does not pass on one and fail on the other.
`engine/tests/script_json_schema_conformance_test.cpp` pins that: it runs every datum of `engine/tests/fixtures/json-schema-conformance.json` through ajv, tv4 (where the schema is in its draft-04 reach) and `jsonSchema`, and fails on any disagreement.
The fixture also records the data they answer differently, and the test fails when a recorded answer changes, until the row moves into the agreed cases:

- `format: 'date'` and `'time'`: ajv's default `fast` mode accepts `2024-13-01`, `2024-02-30` and `25:00:00Z`, and accepts a time with no offset (`03:04:05`) in both of its modes.
  `jsonSchema` checks the calendar and the range and requires the offset, as RFC 3339 does.
- `multipleOf` with a decimal: ajv divides in binary floating point, so `{"multipleOf": 0.01}` rejects `0.07` and `19.99` unless `multipleOfPrecision` is set.
  `jsonSchema` answers the decimal question and passes both.

The keywords `jsonSchema` refuses to pass on (2019-09 and later, and OpenAPI's `nullable` and `discriminator`) are the ones ajv 6 ignores, so a schema that uses one passes `ajv` with the keyword left out and fails `jsonSchema` naming it.
A `propertyNames` below the schema root is the one exception: ajv evaluates it and `jsonSchema` does not, so ajv can reject a body that `jsonSchema` only discloses.

**Cost.**
Evaluated on an execution's first `require('ajv')`, never when a context is built, so a script that does not require it pays nothing.
The first load costs about 21 ms in a `-O2` build and 55 ms in a Debug build, the shelf's dearest ([First-load cost](../building.md#first-load-cost) has the method), and the first `compile` and a call 10 ms and 35 ms more, most of it compiling the draft-07 meta-schema the schema is checked against.
The evaluated module holds about 1,000 KB of the script's 64 MB limit until the execution ends.
A compile runs on the script's own stack: the measured schema (four levels of nesting, `allErrors` on) needed between 48 and 64 KB in a gcc `-O0` build, inside the 256 KB default.
MSVC at `/Od` under ASan needed more and overflowed 512 KB in the test suite, which therefore gives its test engine more stack (#2684 in [what the sanitizer matrix found](../building.md#what-the-matrix-found-and-where-it-stands)); the default is unchanged.
Nothing is shared between executions.

The Postman import's script scan does not name `require('ajv')`.

## `tv4`

`require('tv4')` and the bare `tv4` global are **the npm `tv4` package, version 1.3.0**, the version Postman's sandbox pins, and one object, as in Postman.
Postman deprecates the global in favour of `require('ajv')`; it still runs there, so it runs here. tv4 is released into the public domain (MIT as the alternative).
The package ships no minified build, so `engine/vendor/tv4/tv4.min.js` is its `tv4.js` minified by esbuild, 28,767 bytes, and `engine/vendor/tv4/README.md` has the command that reproduces it byte for byte.

```javascript
const body = pm.response.json();
pm.test('the body matches the schema', () => {
    pm.expect(tv4.validate(body, { type: 'object', required: ['id'] }), tv4.error && tv4.error.message).to.be.true;
});
```

tv4 is a draft-04 validator.
A draft-06 or draft-07 keyword (`const`, `contains`, `propertyNames`, `if`/`then`/`else`, a numeric `exclusiveMinimum`) is ignored, and `format` is checked only for a name a script registers with `addFormat`; use `require('ajv')` for those. tv4 keeps the last verdict on the object (`tv4.error`, `tv4.missing`, `tv4.valid`), so the global and the module share it, whichever is read first.
The messages are English, as in Postman.

**One difference from Postman.**
The shelf evaluates every library in strict mode, and Postman's bundle runs sloppy.
A method called detached from the object (`const v = tv4.validate; v(data, schema)`) throws a `TypeError` here, where Postman writes `error`, `missing` and `valid` onto the global object.
Called as `tv4.validate(...)` it behaves the same.
Minification renames tv4's internal constructors, so an error's stack names a minified function, as it does in Postman's own bundle.

**Cost.**
Evaluated on the first `require('tv4')` or read of `tv4` in an execution, never when a context is built.
The first load costs about 2.7 ms in a `-O2` build and 6.5 ms in a Debug build, and a first `tv4.validate` of a four-level schema 0.12 ms and 0.37 ms more; the evaluated module holds about 190 KB of the script's memory.
`require('tv4/tv4.js')` and every other path throw like any name off the shelf.
The Postman import's script scan does not name `require('tv4')` or `tv4`.

The libraries Postman also lets a script `require` or reach as a global - `cheerio`, `Backbone`, Node's built-ins (`crypto`, `fs`, `buffer`, ...) and `csv-parse` at any path but `csv-parse/lib/sync` - are **not** on the shelf, and stay unshipped on purpose: `require` of one throws, the editor declares `cheerio` and `Backbone` as unusable, and a Postman import names the script that uses one.
[The compatibility page](../../app/pm-api-compatibility.md#the-require-shelf) has the same list from the Postman side.

**Why the hashing surface is not called `crypto`.**
Web Crypto's `crypto.subtle` is Promise-based and covers algorithms this sandbox does not implement, so a script written against that name would meet a different surface.
Vayu therefore takes a name of its own and is honestly synchronous.
`btoa` and `atob` keep their standard names because they are synchronous on the web too, and they keep the rest of their semantics with them: they operate on **binary strings**, one byte per code unit, so `btoa` throws on a code point above U+00FF rather than silently UTF-8 encoding it.

Both halves of this list are pinned by tests in `engine/tests/script_engine_test.cpp`, so if a global is ever added or removed this section is what needs rewriting.
