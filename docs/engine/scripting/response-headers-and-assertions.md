---
description: >-
  Reading response headers and cookies from `pm.response`, and the assertions written against a response.
---

# Response headers, cookies and assertions

## Reading response headers

```javascript
pm.response.headers.get('Content-Type');   // case-insensitive; undefined if absent
pm.response.headers.has('X-Request-Id');   // name present, boolean
pm.response.headers.has('Content-Type', 'application/json');
                                           // present and holding that exact value
pm.response.headers['content-type'];       // indexing: exact key only
pm.response.headers.all();                 // [{key, value}, ...] in map order
pm.response.headers.count();               // how many headers there are
pm.response.headers.one('Content-Type');   // {key, value}, or undefined
pm.response.headers.toObject();            // {'content-type': 'application/json', ...}
pm.response.headers.toObject(false, true); // same, keys keep the stored spelling
pm.response.headers.indexOf('Content-Type');
                                           // position in all(), or -1
pm.response.headers.each(function (header, index, all) {
  console.log(header.key, header.value, index, all.length);
});
```

`has()`'s optional second argument is compared strictly against the header's wire value - a number never matches, since the wire value is always a string.

`headers` is a plain object, not Postman's `HeaderList`, but the read half of a Postman `PropertyList` is on it: `get()`, `has()`, `each()`, `all()`, `count()`, `toObject()`, `one()` and `indexOf()`.
Every one of them that takes a header name matches it the way HTTP header names work - case-insensitively, and `toObject()`'s keys come back lower-cased for the same reason.
Indexing does not: the engine lower-cases every response header name as it parses it, so `headers['Content-Type']` is `undefined` while `headers.get('Content-Type')` works.
Prefer the methods unless you know the exact key.

The six beyond `get`/`has`:

- `all()` - every header as `{ key, value }`, in the object's own key order.
- `count()` - how many headers there are, i.e. `all().length`.
- `toObject(excludeDisabled?, caseSensitive?)` - a plain `{name: value}` object.
  **Keys are lower-cased by default**; pass a truthy second argument to keep the stored spelling instead.
  Postman's `toObject()` lower-cases whenever the list it is called on is indexed case-insensitively, which a header list always is.
- `one(name)` - the `{ key, value }` member rather than its value, case-insensitive, `undefined` when absent.
  `get` is the value half of the same lookup.
- `indexOf(name)` - the header's position in `all()`, case-insensitive, `-1` when absent.
  It also accepts a `{ key }` member (what `all()` / `one()` hand back) in place of a name.
- `each(fn, thisArg?)` - calls `fn(header, index, all)` for every header, the same three arguments Postman's iterator receives; `thisArg` becomes the callback's `this`.
  The member list is built once before the walk starts, so a callback that removes the header it was just handed does not shorten it.

All six are non-enumerable, exactly like `get()` and `has()`, so none of them ever appear in `Object.keys()` or `JSON.stringify()`.

The response object has **no** `add`/`upsert`/`remove` - the response has already arrived, so a mutator there would only appear to change something.

**A name the server sent twice reads as one value, folded with `", "`.**
Two `Set-Cookie` lines arrive as `"session=abc; Path=/, csrf=xyz; Path=/"`, and `get()` returns that whole string - there is no list form, because `headers` is a plain object.
Folding is the RFC 7230 §3.2.2 equivalence for comma-list headers; before it, only the **last** value of a repeated name survived at all.
If you need the parts, split on `", "` - but not for `Set-Cookie`, whose values contain commas of their own (`Expires=Wed, 21 Oct ...`).
Read `pm.response.cookies` instead: it is that header already parsed, boundaries and all.

**`all()` reports the object's key order, not wire order, and can never report a duplicate.**
Postman's `HeaderList` keeps both; this object cannot, because it is built from a single-valued case-insensitive map and a name sent twice has already been folded into the one entry above by the time any script sees it - there is only ever one member to report for it.

## Reading response cookies

```javascript
pm.response.cookies.get('session');    // value, or undefined if unset
pm.response.cookies.has('session');    // boolean
pm.response.cookies.toObject();        // { session: 'abc', tracker: 't1' }
pm.response.cookies.length;            // it is an array, in wire order
pm.response.cookies[0].name;           // 'session'
pm.response.cookies[0].value;          // 'abc'
pm.response.cookies[0].attrs;          // ['Path=/', 'HttpOnly'] - raw chunks
```

`cookies` is what the response's `Set-Cookie` header carried, parsed - an array of `{ name, value, attrs }` with `get()` / `has()` / `toObject()` over it.
Each received `Set-Cookie` line is parsed on its own, so a comma inside a value (`prefs=a=1, theme=dark`) stays in that cookie's value (#2460); the folded `", "` string is parsed only for a response that kept no lines, such as a load-run sample replayed into a script.
Attributes are the raw `;`-separated chunks in wire order; there are no `path` / `secure` / `expires` fields, because that is the header restated, and what the engine actually *holds* is [`pm.cookies`](cookies.md#the-cookie-jar-pmcookies).

Three things follow from that, and they are the ones worth knowing:

- **This is one response, not the session.**
  It reports what this response set, including a cookie the engine then discarded as expired.
  For what will be sent on the next request, read [`pm.cookies`](cookies.md#the-cookie-jar-pmcookies).
- **Cookie names are case-sensitive**, unlike header names: `get('SESSION')` does not answer the `session` cookie.
  That is what RFC 6265 says, and answering otherwise would be a wrong value dressed as a right one.
- **A name set twice answers with the last value** from `get()` and `toObject()` - the one a browser's jar would keep - while the array still lists both, because that is what came off the wire.

The parse is shared with the app's response Cookies tab through a conformance fixture (`engine/tests/fixtures/set-cookie-conformance.json`), so the value a script asserts on and the value shown in the UI cannot drift.
It handles the two cases a naive split corrupts: a comma inside `Expires=Wed, 21 Oct ...` is not a cookie boundary, and the `=` padding on a base64 value stays in the value.
The fixture's `singleLine` cases are the per-line parse.

## Response Assertions

```javascript
pm.response.to.have.status(200);                          // status code
pm.response.to.have.status('OK');                         // reason phrase, not a code
pm.response.to.have.statusCode(200);                      // the code only; '200' is fine too
pm.response.to.have.statusReason('OK');                   // the reason phrase, exactly
pm.response.to.have.statusCodeClass(2);                   // 2xx
pm.response.to.have.header('Content-Type');               // header exists
pm.response.to.have.header('Content-Type', 'text/plain'); // exact value, strict
pm.response.to.have.body();                               // there is a body
pm.response.to.have.body('{"ok":true}');                  // body equals this exactly
pm.response.to.have.body(/"ok":\s*true/);                 // regex run against the body
pm.response.to.have.body({ ok: true });                   // parsed JSON deep-equals this
pm.response.to.have.jsonBody();                           // body parses as JSON
pm.response.to.have.jsonBody('data.id');                  // that property exists
pm.response.to.have.jsonBody('data.id', 42);              // exists and deep-equals 42
pm.response.to.have.jsonBody('[0].id', 42);               // an array root, as lodash reads it
pm.response.to.have.jsonSchema({ type: 'object', required: ['id'] }); // draft-07
pm.response.to.have.responseTime.below(500);              // a pm.expect chain on the time
pm.response.to.have.responseTime(120);                    // ... and the equality call
pm.response.to.have.responseSize.below(2048);             // body and header bytes together
pm.response.to.not.have.status(500);                      // every member has a negated twin
```

`require('chai').expect(pm.response)` takes the same members after `to` (`expect(pm.response).to.have.status(200)`, `.to.not.be.ok`), forwarding each to the call above; see [`chai`](require-shelf.md#chai).

`have.status` means two different things depending on the argument's type: a number is the status code, a string is compared against the reason phrase `pm.response.reason()` answers.
**`status('200')` fails** - a string is always a reason phrase to compare, never a code coerced to one.
**A number that is not a whole finite code is refused**, not truncated: `status(200.5)` used to compare as `200` and pass against a 200, and no response carries a fractional code, so the `TypeError` names what was written rather than reporting a verdict about the status that did arrive (#1048).
`status(NaN)` is refused the same way.

`have.header`'s second argument is compared strictly against the header as it arrived on the wire.
`header('X-Count', 5)` fails rather than stringifying `5` into agreement; the expected value must already be the string form.

`have.body` accepts exactly three forms and, with no argument, asserts that there is a body at all.
A string must equal the body **exactly** - this used to be a substring search.
A regular expression is run against the body text.
An object is deep-equalled against the parsed JSON body.
Any other argument type - a number, a boolean - is a `TypeError` naming the three accepted forms rather than a verdict: Postman silently asserts nothing for those inputs, and Vayu refuses a silent non-assertion instead (#998).

`have.jsonBody` takes an optional path and an optional value.
No arguments checks only that the body parses as JSON.
A path checks that the property exists.
A path plus a value checks that the property exists **and** deeply equals it - before #998 the value argument was accepted but never compared, so a wrong expected value still passed.
The path is read the way lodash's `_.has` and `_.get` read it, which is how chai-postman reads it (#2528): `a.b[2].c`, `a['b'].c` and `a["b"]` all work, a key the root holds whole wins (`{"a.b": 1}` answers `a.b`), and an array root is `[0].id`.
Every step is an own property: an array's `length` is reachable and its `map` is not.

`have.statusCode(code)` compares the code (a number or a numeric string, as chai-postman's `Number(code)` does), `have.statusReason(reason)` compares the phrase exactly, and `have.statusCodeClass(digit)` the hundreds digit - which has to be a number, not `'2'`.
`have.jsonSchema(schema[, options])` is draft-07 by the engine's validator, the same call `pm.expect(value).to.have.jsonSchema` makes: the body is read as `JSON.parse` reads it, a failure names the first failing path, and a keyword the validator cannot evaluate fails the assertion naming it, in both polarities.
`options` is ajv's and is not read, and `format` is checked for `date`, `time`, `date-time`, `ipv4`, `email`, `uri`, `uuid`, `hostname` and `ipv6` (see [pm-api-compatibility.md](../../app/pm-api-compatibility.md#assertion-chains-pmexpect) and [`ajv`](require-shelf.md#ajv) for where the engine's checks differ from ajv's).

`have.responseTime` and `have.responseSize` are a call and a chain, as in chai-postman: `responseTime(120)` asserts the time equals 120, and `responseTime.below(200)` / `.within(100, 150)` are `pm.expect`'s matchers on the number; an unknown name after one is refused naming `pm.response.to.have.responseTime`, the chain the script wrote.
The size is the body and the header bytes added up; `pm.response.responseSize` is the body alone.

`pm.response.to.not` negates every one of these, and as in chai-postman it negates **each check on its own, in order**: `not.have.header('X', 'v')` fails as soon as the header exists, and `not.have.jsonBody('id', 2)` as soon as `id` does.
`not` sets the negation, so `not.not` is still negated.

Status-class assertions hang off `pm.response.to.be`.
They are **getters** - the paren-less form is the assertion:

```javascript
pm.response.to.be.ok;            // status 200 only
pm.response.to.be.success;       // 2xx
pm.response.to.be.info;          // 1xx
pm.response.to.be.redirection;   // 3xx
pm.response.to.be.clientError;   // 4xx
pm.response.to.be.serverError;   // 5xx
pm.response.to.be.error;         // 4xx or 5xx
pm.response.to.be.accepted;      // 202
pm.response.to.be.withoutContent; // 204
pm.response.to.be.badRequest;    // 400
pm.response.to.be.unauthorized;  // 401
pm.response.to.be.unauthorised;  // 401
pm.response.to.be.forbidden;     // 403
pm.response.to.be.notFound;      // 404
pm.response.to.be.notAcceptable; // 406
pm.response.to.be.rateLimited;   // 429
pm.response.to.be.json;          // body parses as JSON
pm.response.to.be.withBody;      // body is not empty
```

**`ok` is status 200 only, not any 2xx** (#998) - `success` is the 2xx one.
A script that meant "any 2xx" and asserted `.ok` needs `.success` instead.
Postman's named statuses (`accepted`, `withoutContent`, `badRequest`, ...) also match by reason phrase; Vayu's stay code-only. chai-postman's phrase for `unauthorised` is `Unauthorised` and for `notAcceptable` is `Acceptable`, which no server sends, so in Postman those two fail against a real 401 and 406 where Vayu passes on the code.

**Anything else under `pm.response.to` throws.**
A misspelled or unimplemented name - `pm.response.to.be.definitelyNotAMatcher` - raises a `TypeError` naming the chain rather than evaluating to `undefined`.
A paren-less assertion is an expression statement, so a silent `undefined` would report PASS against a broken API; failing loudly is the point.
