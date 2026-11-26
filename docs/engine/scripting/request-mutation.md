---
description: >-
  How a pre-request script changes the request: header methods, request methods, URL parts and the rules each follows.
---

# Mutating the request

## Mutating the request (pre-request scripts)

In a **pre-request** script these five fields are writable, directly or through the Request methods that write them, and what they hold when the script returns is what goes on the wire.
In a **test** script they are a read-only record of what was already sent - writes there are discarded.

```javascript
pm.request.headers['X-Signature'] = 'abc123';   // add or replace a header
delete pm.request.headers['Authorization'];     // remove one
pm.request.url = 'https://api.example.com/v2';  // retarget
pm.request.method = 'POST';                     // case-insensitive
pm.request.body.update('{"n":3}');              // Postman's setter, in place
pm.request.body = JSON.stringify({ n: 2 });     // replace the body
pm.request.body = { mode: 'raw', raw: '{}' };   // Postman's description of one
delete pm.request.body;                         // send no body
pm.request.auth = { type: 'basic', basic: [     // replace the request's auth
  { key: 'username', value: 'alice' },
  { key: 'password', value: '{{password}}' },
] };
pm.request.authorizeUsing('bearer', { token: 'abc' }); // Postman's setter for it
pm.request.auth = { type: 'noauth' };           // send no credential
```

The [Request methods](#request-methods-pmrequestaddheader-and-the-rest) are Postman's other spelling of the same writes.

Rules worth knowing before you rely on them:

- **The object is authoritative, not a diff.**
  The header set left in `pm.request.headers` is the header set that is sent, which is what makes `delete` work.
- **A repeated header reads folded and survives untouched** (issue #2466).
  `pm.request.headers` holds one value per name, so two `X-Dup` rows read as `'one, two'` (a `Cookie` joined with `'; '`).
  A name the script leaves at the value it read keeps every line it had, in place and in its own spelling; a name the script writes goes out as the one line it wrote.
- **A script beats engine-applied auth.**
  Auth (bearer / basic / apikey / oauth2) is resolved into the request *before* the script runs, so the script sees the real `Authorization` header and can replace or remove it.
  The one exception is a credential still holding a `{{name}}` that no variable defined when the request was composed, or any `{{name}}` of a request a pre-request script runs before (#2473, #2521): that auth is applied *after* the script, so a value the script sets reaches it, and the header is not in `pm.request.headers` yet.
  A header the script sets still wins, because auth never replaces one the request already carries.
  The order is the same on a Send, on every step of a collection run, and under load after an `inline` `script.pre` (a single-request load run's through `requestElements`).
- **An assigned `pm.request.auth` replaces the request's own auth** (#3131).
  It takes Postman's block, `{ type, <type>: params }`, the params as `[{ key, value }]` (an exported collection's shape) or `{ name: value }`: `basic` (`username`, `password`), `bearer` (`token`), `apikey` (`key`, `value`, `in: 'header' | 'query'`) and `noauth`, which sends no credential.
  A parameter name the type does not take, or a block with no credential in it, fails naming the accepted ones, as in [`pm.sendRequest`](send-request.md#sending-a-request-from-a-script-pmsendrequest); a block Postman exported reads as it is.
  Any other type, `oauth2` included, fails the write-back naming it, since acquiring a token needs state the sandbox does not hold - build that header yourself.
  A `{{name}}` in a credential resolves against the scopes as the script left them, as in `pm.sendRequest`, and the engine's own composer (`apply_auth`) writes the credential, so an api key in the query is encoded by the same rule.
  The credential the engine applied before the script - the header it wrote, or the query pair - is taken off first, unless the script rewrote it, in which case the script's value is its own and stays.
  A header the engine did not write (typed on the Headers tab, or one the script added) is never removed and still wins over the assigned auth, exactly as it wins over the Auth tab; delete it to let the assigned auth through.
  Auth that waits on the script is not applied at all once the script assigns one, so no deferred credential lands beside the script's and no OAuth 2.0 token is fetched.
  `pm.request.auth` reads `undefined` until the script assigns it (the engine's credential is visible as the header it wrote), so a lifted read of the request's own auth - `pm.request.auth.type`, `pm.request.auth.bearer.get('token')` - throws an ordinary `TypeError` before an assignment.
  The assignment reads back as the plain object written, not Postman's `RequestAuth`, so its blocks have no `get()` either.
  `delete pm.request.auth` or `null` leaves the request's own auth in force.
  `pm.request.authorizeUsing(type, options)` is Postman's setter for it: `('basic', { username, password })`, `({ type: 'bearer', token })` or the block itself; `null` removes an assigned auth, and a type `pm.request.auth` would refuse throws at the call, where Postman ignores it and sends the request bare.
- **A refused `pm.request.auth` still sends the request, with its own credential.**
  When the write-back refuses the assignment - an `oauth2` type, a parameter the type does not take, or a `{{name}}` naming a column the bound data row does not carry - nothing the script wrote to `pm.request` is applied, and the request goes out with the Auth tab's credential exactly as it would have without the script (applied before it, or after it when it waits on the script).
  The reason is the pre-request script error, in the Console.
  `authorizeUsing` throws at the call for the same refusals, so its assignment never happens and the request keeps its own credential the same way.
  This is unlike `pm.sendRequest`, which refuses to send a request whose `auth` it cannot compose, because that block is the only credential the request has.
- **A bad value is refused, not coerced.**
  `method` must be a string (one of the seven HTTP verbs), `url` a URL string (assigning anything else throws at the assignment), header values must be strings, numbers or booleans, and `body` must be a string, the `RequestBody` object `pm.request.body` itself holds - handing the object straight back (`pm.request.body = pm.request.body`) changes nothing - or a Postman body description (below);
  an object without a `mode`, `{}` included, is never sent as `[object Object]`.
  Anything else fails the whole write-back - the request is sent unchanged and the reason is reported as the pre-request script error, visible in the response pane's Console tab.
  Assigning a string to a `form-data` body fails the same way, for the same reason: a value the engine cannot send is refused rather than dropped.
- **`pm.request.body = string` and `pm.request.body.raw = string` reach the wire the same way, but only the second is safe to read back.**
  Assigning to `pm.request.body` directly replaces the whole `RequestBody` object with the string, so a later `pm.request.body.raw` (or `.length`, or a hash of it) in the *same script* reads `undefined`, not the string just set - the object it lived on is gone.
  Assigning to `.raw` instead updates that object in place, so the new body stays readable for the rest of the script.
  Any script that signs, hashes, measures or re-parses the body it just wrote - the `hmacSha256(secret, pm.request.body.raw)` shape most webhook signing needs - must use `pm.request.body.raw = …`, not `pm.request.body = …`.
  `pm.request.body.update(…)` is the third spelling and the Postman one; it too updates the object in place, but it takes Postman's body description, so it is held to the mode rule below: on a urlencoded or GraphQL body a string `update('…')` is refused by name, where `.raw` takes the same string.
- **A Postman body description names the body's own mode** (#3131).
  `body.update()` and an assignment to `pm.request.body` both take `{ mode: 'raw', raw: '…' }` and `{ mode: 'urlencoded', urlencoded: [{ key, value, disabled? }] }`, and `update()` takes a string as `{ mode: 'raw', raw: string }`, as Postman does.
  Each means exactly what assigning its string to `.raw` would: the pairs are encoded as the wire body, a disabled pair left out.
  Every other member of the description is ignored, Postman's `options` included: nothing is derived from `options.raw.language`, so the `Content-Type` is the one the request's own body type implies (`text/plain` for a body added to a request that had none) unless the script sets the header.
  The mode has to be the one the body already has - a `raw` body (json, text, xml, jsonrpc, mcp) takes `raw`, a urlencoded body `urlencoded`, a request with no body `raw`, which it sends as text - because the write-back keeps a request's body mode, and `{ mode: 'raw' }` on a urlencoded body would otherwise be parsed back into form fields.
  Another mode is refused by name, and so are `formdata`, `file` and `graphql`.
  A GraphQL body therefore refuses every `update()`, a string included (it is `{ mode: 'raw' }`), and the refusal says to assign the envelope to `.raw`, which keeps the mode.
- **Setting a variable re-renders the URL of a scripted request.**
  A request a pre-request script runs before (its own, a folder's or the collection's) keeps every `{{placeholder}}` a scope answers written when `POST /compose` composes it (#2521, [decision D1](../../app/variable-resolution.md), Postman's order), and so does a name composition could not answer (#1009).
  All of them are resolved after the pre-request script and before the send (#1008), against the scopes as the script left them.
  So `pm.environment.set('host', …)` reaches a `{{host}}` in this send's URL, on every run.
  Meanwhile `pm.request.url` holds the `{{host}}` as written, in the script, and reads a token in the scheme or host as the host itself, as Postman does: on `{{baseUrl}}/users?page=2`, `getHost()` is `'{{baseUrl}}'`, `protocol` is `''`, and `getPath()`, the query and every member edit work, the token written back verbatim for this same pass to resolve (#3454).
  A request no pre-request script runs before is composed once, as it always was, and a `{{host}}` composition substituted is finished text - assign `pm.request.url` directly to change that.
  A collection run widens this to the whole plan: when any step's script or extractor writes a variable before a send (`script.teardown` aside), every step defers, so a token one step's test script stores reaches a later step's `Bearer {{token}}` on every run ([Scenario runs](../api-reference/scenario-runs.md#scenario-runs)).
- **A load run runs a pre-request script only inline.**
  A `script.pre` element runs under load, in a single-request run's `requestElements` and in a scenario step's elements, only when its `config.inline` is `true` or the run's `elements.scripts` override forces it (issues #1495, #1594).
  An unmarked one never runs there: it has no deferred pre-request replay to wait for; a scenario step it is left on is reported `preRequestScript: "skipped"` (see [Script elements](execution-context.md#script-elements-design-send-and-the-sequential-run)).
  A `script.post` that is not inline is replayed afterwards on a sample - see [Load Test Scripts](execution-context.md#load-test-scripts).

## Header methods (`pm.request.headers`)

```javascript
pm.request.headers.get('authorization');                  // case-insensitive
pm.request.headers.has('Authorization');                  // name present, boolean
pm.request.headers.has('Authorization', 'Bearer abc');    // present with that value
pm.request.headers.upsert({ key: 'X-Trace', value: id }); // add or replace
pm.request.headers.upsert('X-Trace', id);                 // same, two-arg form
pm.request.headers.add({ key: 'X-New', value: '1' });     // add; throws if present
pm.request.headers.remove('Authorization');               // case-insensitive
pm.request.headers.all();                                 // [{key, value}, ...]
pm.request.headers.count();                               // how many there are
pm.request.headers.one('Content-Type');                   // {key, value} or undefined
pm.request.headers.toObject();                            // lower-cased keys
pm.request.headers.toObject(false, true);                 // keys kept as typed
pm.request.headers.indexOf('Content-Type');               // position in all(), or -1
pm.request.headers.each(function (header, index, all) {
  console.log(header.key, header.value, index, all.length);
});
```

These act on the **same object** as indexing and `delete`, so the two styles mix freely and the write-back sees one header set either way.
They are non-enumerable properties of it, so they never appear in `Object.keys()`, `JSON.stringify()` or on the wire.

Behaviours worth knowing:

- **The methods are case-insensitive; indexing is not.**
  `upsert('authorization', v)` replaces an existing `Authorization` rather than adding a second spelling - which matters, because the write-back refuses a header set holding two casings of one name.
- **`add` refuses a name that is already there**, and says to use `upsert`.
  Postman's `HeaderList` holds duplicates and `add` appends one; a request here carries a single value per name, so the difference is reported rather than silently collapsed into an `upsert`.
- **`remove` on an absent header is a no-op**, not an error.
- **`has`'s optional value argument is a strict string compare**, the same rule `pm.response.headers.has` follows - a number never matches, since the outgoing header is always a string.
- **`toObject()` lower-cases its keys by default.**
  `pm.request.headers` keeps whatever casing the request holds - which can be whatever the user typed - so copying its own keys would have answered `undefined` for `toObject()['content-type']` on a request carrying `Content-Type`.
  Pass a truthy second argument (`toObject(false, true)`) to keep the stored spelling instead.
- **`all()` reports this object's key order, not wire order, and can never report a duplicate** - unlike Postman's `HeaderList`, which keeps both.
  A name assigned twice already collapsed into one entry (the second write replaced the first), so there is only ever one member for `all()` to report.
- **`indexOf` matches a `{ key }` member by its `key`, not by identity.**
  Postman finds a member by identity in its own list; the members here are built fresh on every call, so identity would answer `-1` for a member of the very list it came from.
  Matching the key answers what Postman answers for that case, and `-1` for an object naming a header this list does not hold.

A bad argument fails loudly: a name must be a non-empty string and a value a string, number or boolean - the same set plain assignment accepts.
`each` throws if its first argument is not a function.
Detaching a method from its object (`const get = pm.request.headers.get`) throws rather than answering as though the header were missing.
A throw out of an `each` callback propagates as the script's own error.

## Request methods (`pm.request.addHeader` and the rest)

A script lifted from Postman calls some writes on the request itself rather than on its members (#3131).
Each is the member method it names, so it reaches the wire the same way and refuses bad input with that method's own error:

```javascript
pm.request.addHeader({ key: 'X-Trace', value: 't-1' }); // headers.upsert, or ('X-Trace', 't-1')
pm.request.upsertHeader('X-Trace', 't-2');              // headers.upsert
pm.request.removeHeader('Authorization');               // headers.remove
pm.request.forEachHeader(function (header, index) {     // headers.each
  console.log(index, header.key, header.value);
});
pm.request.getHeaders();                    // { 'Content-Type': ... }, spelling kept
pm.request.getHeaders({ ignoreCase: true }); // { 'content-type': ... }
pm.request.addQueryParams('page=2');        // url.addQueryParams
pm.request.removeQueryParams(['sort']);     // url.removeQueryParams
var copy = pm.request.toJSON();             // { url, method, header: [...], body? }
console.log(copy.header.length, JSON.stringify(pm.request) === JSON.stringify(copy));
```

- **`addHeader` replaces a header the request already carries**, whatever its casing, because it is `headers.upsert`.
  Postman's appends a second line; a request here holds one value per name, and a lifted `addHeader` is usually called on a header the Headers tab may already set.
  `headers.add` keeps its refusal - the two are different calls.
- **`removeHeader` matches case-insensitively**, as every header method here does; Postman's matches the case unless told to ignore it.
- **`getHeaders` keeps each name's spelling** and lower-cases only with `{ ignoreCase: true }` - Postman's default, which is `toObject`'s the other way round.
- **`toJSON` describes `pm.request` as the script has left it**: `url` (the string, as `url.toJSON()` answers - Postman's is its Url object's parts), `method`, `header` as `[{ key, value }]` in the object's own key order, and `body` as Postman's `{ mode, raw | urlencoded | formdata | graphql | file }`, absent for a request with no body, and `auth` when the script assigned one.
  It is what `JSON.stringify(pm.request)` writes.
  The result is a copy; writing to it sends nothing.
- **`authorizeUsing` assigns `pm.request.auth`** - see [Mutating the request](#mutating-the-request-pre-request-scripts).
- **Each method is looked up on its member when it is called**, so after `pm.request.headers = { ... }` a call to `addHeader` throws saying the object it reached for is gone, rather than writing to one nothing sends.
- **`clone()`, `size()` and `update()` throw by name**, each with what to use instead.
  They are Postman Request methods with no Vayu meaning, and a bare `not a function` would not say which call failed.

The methods are non-enumerable, so `Object.keys(pm.request)` still lists `url`, `method`, `headers` and `body` and nothing else, until the script assigns `auth`.

## URL parts (`pm.request.url`)

`pm.request.url` is Postman's `Url` object, so a script lifted from Postman reads its parts under the same names:

```javascript
pm.request.url.protocol          // 'https'          - scheme, no colon
pm.request.url.host              // ['api','example','com'] - segments
pm.request.url.port              // '8443'           - '' when unstated
pm.request.url.path              // ['v2','users']   - decoded segments
pm.request.url.hash              // 'top'            - fragment, no '#'
pm.request.url.query             // the query, with the reads below

pm.request.url.getHost();        // 'api.example.com'
pm.request.url.getPath();        // '/v2/users'
pm.request.url.getQueryString(); // 'page=2&sort=name' - no '?'
pm.request.url.getPathWithQuery(); // '/v2/users?page=2&sort=name'
pm.request.url.getRemote();      // 'api.example.com:8443' - ':port' only when stated
pm.request.url.getRaw();         // the whole URL, as toString() gives it
pm.request.url.toString();       // the whole URL
```

```javascript
pm.request.url.query.get('page');     // first value, or null
pm.request.url.query.has('page');     // boolean
pm.request.url.query.all();           // [{key, value}, ...] in wire order
pm.request.url.query.toObject();      // {page: '2'} - last wins
pm.request.url.query.count();         // 3

pm.request.url.query.each((p) => console.log(p.key, p.value)); // (member, index, list), thisArg?
pm.request.url.query.map((p) => p.key);                        // ['page', 'sort', 'page']
pm.request.url.query.filter((p) => p.key === 'page');          // every match, duplicates kept
pm.request.url.query.find((p) => p.key === 'page');            // first match, or undefined
pm.request.url.query.one('page');     // {key: 'page', value: '2'} - first match, or undefined
pm.request.url.query.indexOf('page'); // 0 - the position in all(), -1 when absent
pm.request.url.query.idx(2);          // {key: 'page', value: '3'}, or undefined past the end
```

Six rules behind those answers:

- **A `{{variable}}` in the scheme or host is opaque host text**, as in Postman.
  A scripted request's URL reaches its script with its scope names still written (see [Mutating the request](#mutating-the-request-pre-request-scripts)), so `{{baseUrl}}/echo?b=2&a=1` reads `host` `['{{baseUrl}}']`, `protocol` and `port` `''`, `getPath()` `'/echo'` and `getQueryString()` `'b=2&a=1'`; `http://{{h}}:8/p` reads `protocol` `'http'`, `port` `'8'`.
  A separator inside a token is part of its name (`{{api.host}}` is one host segment), and a token with no path after it has no path segments, so `getPath()` is `''` there where Postman answers `'/'`: an edit then writes no `/` that the variable's own value may already end in.
- **Path segments are decoded, query values are not.**
  A path is what you want to read; a query is what you want to *sign*, and a canonical string has to be built from the bytes that were sent.
  `getQueryString()` is byte-exact against the wire.
- **`all()` keeps wire order and duplicates**, which is the whole reason it exists beside `toObject()`.
  `get(name)` and `one(name)` answer the **first** match (Postman's `PropertyList.one`); `toObject()` is last-wins and says so.
- **The walks (`each`, `map`, `filter`, `find`) take a function and run over a list taken once.**
  The callback gets `(member, index, list)` and the optional second argument as its `this`, as `headers.each` does, so a callback that adds or removes a parameter, or calls `url.update()`, edits the URL without changing the walk in progress.
  A `false` answer does not stop `each`; `filter` and `find` read the answer as truthy or falsy; a throw out of the callback reaches the script as thrown.
  Postman also takes an object or a property name as `filter`'s and `find`'s rule and `map`'s iterator - here anything that is not a function is a `TypeError`.
  `indexOf(item)` takes a name or a `{key, value}`: a member is matched on both, so the second `page` of `page=2&page=3` is `1`, where Postman's identity match cannot hold across two calls that each build their members.
- **A bare `?flag` reads as `null`, an empty `?flag=` as `''`.**
  Both are `has()`-true.
- **A URL the parser cannot read has no parts.**
  `toString()` still answers the whole string, and every part is empty rather than a plausible half: `getRaw()` is the text, `getPathWithQuery()` and `getRemote()` are `''`, and the query reads find nothing.
  `getRemote()` takes no `forcePort` argument, since a scheme's default port is never filled in.
  A URL with no scheme and no token before its path (`example.com/users`) is one: no scheme is guessed.

### Writing

The whole URL - assign a string, or call `update()`, which is Postman's spelling of the same write:

```javascript
pm.request.url = 'https://api.example.com/v3/orders';   // re-parses in place
pm.request.url.update('https://api.example.com/v3/orders'); // the same write
```

Or one member at a time.
`path` and `host` are live arrays, and the query has Postman's `PropertyList` writers beside its reads:

```javascript
pm.request.url.path.push('active');          // .../v2/users/active
pm.request.url.path[0] = 'v3';               // index assignment, splice, pop,
pm.request.url.path.length = 1;              //   unshift and length all work
pm.request.url.host = ['api', 'staging', 'example', 'com'];
pm.request.url.protocol = 'http';            // and port / hash likewise

pm.request.url.query.add({ key: 'trace', value: id });  // appends, duplicates ok
pm.request.url.query.add({ key: 'flag' });              // a bare ?flag
pm.request.url.query.upsert({ key: 'page', value: 4 }); // replaces in place
pm.request.url.query.remove('page');                    // every match, not the first
pm.request.url.query.clear();                           // and the '?' with them
```

`addQueryParams()` and `removeQueryParams()` are Postman's `Url`-level spellings of `add` and `remove` for several parameters at once:

```javascript
pm.request.url.addQueryParams('a=1&b=2');                // a query string
pm.request.url.addQueryParams(['c=3', { key: 'd', value: 4 }, { key: 'flag' }]);
pm.request.url.addQueryParams({ key: 'trace', value: 'abc' }); // or one object

pm.request.url.removeQueryParams('page');                // every match of a name
pm.request.url.removeQueryParams(['a', { key: 'b' }]);   // names and { key } objects
```

`addQueryParams` takes a query string (split on `&`, each segment at its first `=`; `flag` is a bare key and `a=` an empty value), an array of one-param strings and `{ key, value }` objects, or a single `{ key, value }` object.
Every item is checked before any is added, so a bad one throws a `TypeError` and leaves the URL as it was, and an empty key is refused as in `query.add`.
Parameters are appended with duplicates kept, encoded by the rule `add` uses.
A string inside an array is **one** parameter, so `['a=1&b=2']` adds `a` with the value `1&b=2` (the `&` encoded as `%26`).
`removeQueryParams` takes a name, or an array of names and `{ key }` objects, and removes every parameter of each; a name that is not there is a no-op, and an empty or non-string item is a `TypeError`.
Two differences from Postman: a leading `?` on the query string is dropped (Postman keeps it as part of the first key), and `removeQueryParams({ key: 'page' })` outside an array throws where Postman's removes nothing.

Five rules behind those, each the reason for a decision you might otherwise undo:

- **A URL nobody edited is sent exactly as it arrived.**
  The parts are recomposed only when a member was actually written to, so a read-only script cannot change a single byte - which is what keeps `getQueryString()` byte-exact against the wire.
  An edit writes every `{{variable}}` back as written, a path segment's included, so the names still waiting are resolved after the script as they would have been without the edit.
- **`upsert` keeps wire position**, `add` appends.
  A parameter that quietly moved to the end would change the shape of any signature computed over the query.
- **`remove(name)` takes every match.**
  Removing `page` from `?page=1&page=2` and getting one back has removed nothing the caller can observe.
- **`add` and `upsert` encode what they are given**, by the rule the send writes a query with ([Query encoding](../api-reference/compose.md#query-encoding)): `add({ key: 'k', value: 'a b' })` sends `k=a%20b`, and `get('k')`, `all()` and `getQueryString()` then read `a%20b`, because the query is the wire bytes.
  `%` is never encoded, so a value already encoded passes as it is; under `disableUrlEncoding` the pair is written as typed.
  Postman keeps the text as given and encodes it when it sends, so its `getQueryString()` answers `k=a b` here - Vayu answers what goes out.
  A name is still looked up as the script typed it: after `add({ key: 'a b', value: '1' })`, `get('a b')`, `has('a b')`, `remove('a b')` and `upsert({ key: 'a b', ... })` all find the stored `a%20b`, as they do in Postman.
- **An edit that cannot reach the wire is an error, never a no-op.**
  A URL the parser could not read has no parts to edit, so a write is refused rather than composing `://` out of empty pieces, and a path segment that is not a string or a number is refused rather than becoming `[object Object]`.
  `path` and `host` are ordinary arrays that are **read back** when the URL is needed - the same rule `pm.request.headers` follows - so a bad segment surfaces as a rejected write-back, with the member and the index named, rather than at the `push`.

In a **test** script these behave like every other `pm.request` write: they change what the script sees and reach nothing, because the request has already gone out.

### It was a string, and mostly still behaves as one

This shape replaced a plain string (issue #991: Postman compatibility over the shipped string shape).
The object keeps as much of the old behaviour as JavaScript allows - it carries its own `toString`, `valueOf`, `toJSON` and `Symbol.toPrimitive`, and inherits from `String.prototype`:

```javascript
'' + pm.request.url;                    // the URL
`${pm.request.url}`;                    // the URL
pm.request.url == 'https://a/b';        // compares as the URL
pm.request.url.startsWith('https://');  // String methods work
pm.request.url.split('?')[0];           //   ... including this one
JSON.stringify({ u: pm.request.url });  // embeds the URL string
```

Two things did change, and no mitigation can fix them:

| Was | Now | Use |
|-----|-----|-----|
| `pm.request.url === 'https://a/b'` | `false` | `==`, or `.toString()` |
| `typeof pm.request.url` | `'object'` | - |

`.length` is **not** one of them: it is defined on the object as the URL's own length.
Inheriting it from `String.prototype` - which is a String object holding `""` - would have answered `0` for every URL, and a plausible wrong number is worse than a break you can see.
