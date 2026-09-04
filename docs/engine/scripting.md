---
description: >-
  Writing pre-request and test scripts in Vayu - the QuickJS sandbox, the pm API, script hooks, execution order and limits.
---

# Vayu Scripting Guide

Vayu uses QuickJS for JavaScript execution in pre-request and test scripts. The scripting API is compatible with Postman's `pm` object, making it easy to migrate tests from Postman.

## Quick Start

```javascript
// Test script example
pm.test('Status is 200', function() {
  pm.expect(pm.response.code).to.equal(200);
});

pm.test('Response has user data', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
});
```

## The `pm` Object

### pm.test()

Define a test with assertions.

```javascript
pm.test('Test name', function() {
  // Assertions here
});
```

**Both scripts may assert.** `pm.test` is available in a pre-request script as
well as a test script - the response is not there yet, but a
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest) the script
just made is, and a token fetch that came back empty is worth catching before
the request goes out. Every
assertion is reported with the script that made it: each entry in the response
body's and the stored trace's `testResults` carries a `source` of `"pre"` or
`"test"`, the same two spellings `consoleLogs` uses, and the app's Tests pane
groups the list under the script's name (issue #810). A failing assertion fails
its collection-run step from either script.

**`pm.test` returns `pm`, so calls chain** - Postman's contract, and what an
imported script written as one `pm.test(...).test(...)` expression relies on:

```javascript
pm.test('status', function() {
  pm.response.to.have.status(200);
}).test('body', function() {
  pm.expect(pm.response.json().id).to.equal(1);
});
```

**A callback that declares a parameter is handed `done`** (issue #1004).
postman-sandbox reads the callback's arity to decide this and so does Vayu, so
the zero-argument form above is untouched: `done()` completes the test, and
`done(err)` fails it with `err` - any truthy argument, an `Error` being the
documented one.

```javascript
pm.test('the token came back', function(done) {
  pm.sendRequest(tokenRequest, function(err, res) {
    if (err) { return done(err); }
    pm.expect(res.json().access_token).to.be.a('string');
    done();
  });
});
```

**`done()` must be called before the callback returns, and this is a
divergence: Postman genuinely waits.** The sandbox is synchronous and drains no
job queue (see [Limitations](#limitations)), so a `done()` left for later would
never run at all. A callback that declares `done` and returns without calling
it therefore **fails**, saying so - rather than being reported on a verdict
nothing ever gave. Calling `done()` twice is refused for the same reason the
first verdict is kept: the second call throws, and the throw fails the test
naming what happened.

### pm.expect()

Create Chai-style expectations for assertions.

```javascript
pm.expect(value);                  // the usual form
pm.expect(value, 'context');       // chai's second argument, see below
```

**The optional second argument is prefixed to the failure.** It is chai's
`expect(value, message)`, and it exists for the moment the assertion fails: the
matcher says *what* broke and the message says *which* value it was - the third
item in a loop, the request that came from the MCP path rather than the app.

```javascript
pm.expect(user.active, 'user ' + user.id).to.be.true;
// fails with: user 42: Expected value to be truthy
```

The message is coerced like chai's, and `undefined` / `null` mean "no message",
so a conditionally built one that came out absent leaves the failure text
unchanged. It prefixes assertion failures only - a call the script wrote wrong
(`.to.be.above()` with no argument) reports the misuse on its own, since the
message describes a value, not a typo.

**A failed assertion throws an `AssertionError`**, the name chai uses, so a
script that inspects what it caught takes the same branch it does in Postman:

```javascript
try {
  pm.expect(1).to.equal(2);        // AssertionError: Expected 1 to equal 2
} catch (e) {
  e.name;                          // 'AssertionError'
  e instanceof Error;              // true
}
```

**`pm.expect.fail([message])` fails on the spot**, as an assertion rather than
as an error (issue #1004). It is chai's `expect.fail`, and it throws the same
`AssertionError` every matcher does - so *outside* a `pm.test` it aborts the
script, the way any uncaught throw does. What it changes there is the shape of
the verdict, not whether the script stops: the run is reported as a failed
assertion carrying this message, rather than as the `TypeError` a misuse
reports.

```javascript
pm.test('no branch reached the response', function() {
  if (!pm.response.json().items) {
    pm.expect.fail('the list was absent');   // AssertionError: the list was absent
  }
});

pm.expect.fail();                            // AssertionError: expect.fail()
```

chai's four-argument form (`fail(actual, expected, message, operator)`) is
**not** supported: its `AssertionError` carries the two values it compared and
this one has nowhere to put them, so more than one argument is refused by name
rather than read as the message - which would report `actual` as the failure
text.

QuickJS has no `AssertionError` class, so this is an `Error` with that `name`
and the stack a native throw carries; no `AssertionError` global is exposed,
because chai's is a property of the `chai` module rather than a global and Vayu
does not ship that module. The same name comes off the
[response assertions](#response-assertions), which are chai in Postman too.
**A mistake in the script text is still a `TypeError`** - a matcher called with
no argument, a name nothing implements - because nothing was asserted: the call
itself was wrong.

**Anything the chain does not implement throws, called or not** (issue #999).
`pm.expect(x).to.be.NaN` is an expression statement, so before the chain was
armed a member nothing implemented evaluated to `undefined` and the test
reported PASS whatever the value was - a typo (`.to.be.trueish`) and a chai
matcher Vayu does not have (`.finite`, `.sealed`, `.frozen`, `.extensible`)
were equally silent. Every unimplemented name now raises a `TypeError` naming
itself, the way `pm.response.to` has since #487.

**`equal` is strict, `eql` is deep.** `equal` is `===`, so two objects with the
same contents are *not* equal - only the same reference is. `eql` (and its alias
`deep.equal`) compares contents recursively and does not care about key order.
This matches chai, which is what Postman scripts are written against; picking the
wrong one is the most common porting mistake.

```javascript
pm.expect({ a: 1 }).to.equal({ a: 1 });      // fails - different references
pm.expect({ a: 1 }).to.eql({ a: 1 });        // passes
pm.expect({ a: 1, b: 2 }).to.eql({ b: 2, a: 1 }); // passes - order is not part of it
```

The full matcher inventory:

```javascript
// Equality
pm.expect(value).to.equal(expected);         // strict (===)
pm.expect(value).to.eql(expected);           // deep; alias .eqls
pm.expect(value).to.deep.equal(expected);    // same as .eql
pm.expect(value).to.be.oneOf([a, b]);
pm.expect(value).to.be.closeTo(expected, delta);

// Truthiness and existence (paren-less: accessing them asserts)
pm.expect(value).to.be.true;
pm.expect(value).to.be.false;
pm.expect(value).to.be.null;
pm.expect(value).to.be.undefined;
pm.expect(value).to.be.ok;
pm.expect(value).to.be.empty;
pm.expect(value).to.exist;
pm.expect(value).to.be.NaN;

// Numbers (a number or a Date on both sides - nothing is coerced)
pm.expect(value).to.be.above(n);
pm.expect(value).to.be.below(n);
pm.expect(value).to.be.at.least(n);
pm.expect(value).to.be.at.most(n);

// Types
pm.expect(value).to.be.a('string');
pm.expect(value).to.be.an('array');
pm.expect(value).to.be.instanceOf(Array);

// Strings, collections and objects
pm.expect(value).to.include(item);           // alias .contain
pm.expect(value).to.include({ a: 1 });       // an object target: subset match
pm.expect(value).to.have.string(substring);  // string target only
pm.expect(value).to.match(/regex/);
pm.expect(value).to.have.length(n);          // alias .lengthOf
pm.expect(value).to.have.property('key');
pm.expect(value).to.have.property('key', expectedValue);
pm.expect(value).to.have.nested.property('a.b[0].c');
pm.expect(value).to.have.keys('a', 'b');     // exactly these keys; alias .key
pm.expect(value).to.have.members([1, 2, 3]); // same members, any order

// Functions
pm.expect(fn).to.throw();                    // alias .throws
pm.expect(fn).to.throw('message substring'); // matched against err.message
pm.expect(fn).to.throw(/pattern/);
pm.expect(fn).to.throw(TypeError);
pm.expect(fn).to.throw(TypeError, 'substring');
pm.expect(value).to.satisfy(function (v) { return v > 0; });

// Chainers
pm.expect(value).to.not.equal(expected);     // negates the rest of the chain
pm.expect(value).not.to.equal(expected);     // and reads either way round
pm.expect(value).to.be.above(0).and.to.be.below(10);
pm.expect(value).to.deep.include({ a: 1 });  // deep applies to include, property,
                                             // members and oneOf as well

// Any chain word may precede any matcher - `be` and `and` assert nothing, so a
// matcher follows either of them directly
pm.expect(code).to.be.equal(200);
pm.expect(token).to.be.a('string').and.match(/^prefix_/);
pm.expect(scope).to.be.a('string').and.not.empty;

// Language chains - they assert nothing, and make a chain read as English
pm.expect(value).to.be.an('array').that.include(item);
pm.expect(value).to.be.an('array').which.have.length(n);
pm.expect(value).to.be.above(0).and.still.be.below(10);
```

Notes on the edges:

- **`not` sets the negation for the rest of the chain; it does not flip it.**
  chai's rule, and the flag is never reset between assertions in one chain, so a
  second `.not` is a no-op rather than a double negative:
  `expect(s).to.not.include("+").and.to.not.include("/")` asserts that `s`
  contains neither. It used to *toggle* (issue #883), which made that same line
  assert that `s` **does** include `/` - a silent inversion whose direction
  depended only on how many times the author had written `.not`.
- **`deep` changes the comparison, it is not a matcher.** `include`, `property`,
  `members` and `oneOf` compare strictly unless a `deep` appears in the chain.
- **The language chains assert nothing** (issue #1053). `that`, `which`, `is`,
  `has`, `been`, `with`, `does`, `but`, `also`, `of`, `same` and `still` are
  chai's words for making a chain read as English, and each hands the same
  expectation back with the chain's flags - `not` included - intact. They are
  accepted anywhere in a chain, so an imported collection written in the fluent
  style fails on the API under test rather than on the language. `any`, `own`
  and `itself` are **not** among them: each changes what the matcher after it
  asserts rather than reading as prose, so each still throws by name. One thing
  the editor cannot follow: the runtime carries every matcher on one object,
  while the declarations nest them under `be` and `have` as the completion
  labels spell them, so `.that.be.a('string')` type-checks where chai's
  `.that.is.a('string')` does not - both run.
- **`keys` means exactly these keys**, as in chai's `have.keys`. The subset form
  (`include.keys`) is not implemented; `all` is accepted and changes nothing,
  `any` is not.
- **`eql` refuses containers it cannot inspect.** `Map`, `Set` and typed arrays
  keep their contents outside the property list, so two distinct ones report
  *not* equal rather than silently passing. `Date` compares by instant and
  `RegExp` by pattern.
- **A throw reached through a comparison is the verdict** (#1048). A key, an
  array element or an array `length` behind a getter that throws is a read that
  did not happen, so the error reaches the test instead of being reported as
  "these differ" - which under `.not` would have been a pass. That holds for the
  reads an assertion makes before comparing, too: `include`, `oneOf`, `members`,
  `keys`, `property` (its nested walk included), `empty` and `length` stop at the
  read rather than answering about it. And for the rendering the `Date` and
  `RegExp` comparisons run: an overridden `toJSON` or `toString` that throws used
  to leave both sides rendered as the empty string, which compared *equal*. When
  both sides throw, the first side's error is the one reported.
- **A cycle fails loudly, at the depth it closes** (#959). The walk carries the
  pairs of objects it is already comparing, so meeting one twice is a
  `RangeError` naming that repetition - not a wait for a depth limit to be
  reached. The 64-level cap is still there behind it, with a message of its own,
  as the backstop for a structure that is merely very deeply nested.
- **`eql` separates `+0` from `-0`; `equal` does not.** That is chai: `equal`
  is `===`, under which the two zeros are one value, while `eql` is deep-eql,
  whose number rule is `x === y && (x !== 0 || 1/x === 1/y)`. The
  [response assertions](#response-assertions) keep the other rule, because
  chai-postman compares them with lodash `_.isEqual` and lodash says equal.
- **`NaN` is chai's `value !== value`**, so only the number `NaN` satisfies it -
  `expect('foo').to.be.NaN` fails rather than reading the string as a number.
- **`include` on an object target is subset matching**, as in chai: every key of
  the argument must be present on the target holding an equal value, strictly
  unless the chain says `deep`. Any target other than a string or an array takes
  an *object* argument, so `expect({a:1}).to.include('a')` and
  `expect(5).to.include('x')` are both a `TypeError` - a combination chai
  refuses rather than a verdict. Three edges are Vayu's own:
    - **An expectation with no own enumerable keys is refused**, where chai
      passes it in both directions. `expect(body).to.include({})` compares
      nothing, so a computed subset that came out empty would report green
      having asserted nothing; a `Date`, a `RegExp` and a function carry no key
      either and read as assertions. Each names itself instead.
    - **A getter that throws is reported, not compared.** The exception reaches
      the test rather than being read as "these differ", which under `.not`
      would have been a pass.
    - **A `Map`, a `Set` or a boxed `String` target is refused** rather than
      answered: chai has membership rules for the first two that deep equality
      here deliberately does not (see the `eql` note above), and a quiet
      `false` was the previous answer.
- **The failure message names the argument.** `.to.throw(TypeError)` that caught
  a `RangeError` says so, rather than reporting that a function which threw did
  not throw.
- **The ordering matchers type-assert both sides.** `above`, `below`,
  `at.least` and `at.most` take a number or a `Date` and refuse anything else,
  which is chai's rule: `expect('5').to.be.above(3)` used to pass here through
  `ToNumber`, and now names what it was given. They compare like with like too -
  a `Date` read as milliseconds against a number is a comparison neither side
  wrote, so the mixed pair is refused.
- **`throw` reads the error's `message`.** A string or a regular expression is
  matched against `err.message` alone, never `String(err)` - so
  `.to.throw('Error')` no longer passes for every `Error` thrown. A constructor
  is accepted as the first argument (`instanceof`), with an optional message
  matcher after it. A thrown string is its own message and anything else has
  none, which is chai's rule: `.to.throw('4')` does not pass on `throw 42`.
- **A wrong-typed value is a `TypeError` here where chai raises an
  `AssertionError`** - `expect('5').to.be.above(3)`, `expect(5).to.include('x')`.
  Deliberate: this file's rule is that a mistake in the script text stays a
  `TypeError` because nothing was asserted, and the response assertions refuse
  a wrong-typed argument the same way (#998). Both throw, so a test fails
  either way; what differs is `e.name`.
- **`.and` carries the chain's flags**, `not` included, exactly as in chai. It
  is a language chain like `.that`, not a return to the start of one: a matcher
  may follow it directly (`.and.match(/x/)`), and so may `not`.
- **The grammar is chai's: any chain word before any matcher.** Every word above
  - `to`, `be`, `have`, `at`, `and`, `all`, `not`, `deep`, `nested` and the
  language chains - is installed on the same expectation and hands it back, so
  the editor's declarations describe one type rather than the paths this page
  happens to spell (#1209). The examples in this section are compiled against
  those declarations by the app's suite, so a chain that reads correctly here
  is one the editor accepts.

## Response Object (`pm.response`)

Access HTTP response data:

```javascript
pm.response.code              // Status code (number, e.g., 200)
pm.response.status            // Reason phrase (string, e.g., 'OK') - see below
pm.response.responseTime      // Perceived latency in ms (submit → completion).
                              // In load tests this includes generator-side
                              // queue wait. For pure server wire time, use
                              // responseTimeWire.
pm.response.responseTimeWire  // CURLINFO_TOTAL_TIME in ms - DNS + TCP + TLS +
                              // send + recv. Matches the pre-v0.3 meaning of
                              // responseTime; use this to assert on server SLAs
                              // independent of generator load.
pm.response.responseTimeQueueWait // Generator-side queue overhead in ms,
                              // i.e. responseTime − responseTimeWire (clamped
                              // to >= 0). For single-shot sends this is ~0.
pm.response.headers           // Plain object, lower-cased keys, with
                              // case-insensitive get()/has() over it - see below
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
pm.response.reason()          // Status reason phrase ('OK', 'Not Found')
pm.response.size()            // { body, header, total } in bytes
pm.response.cookies           // Set-Cookie, parsed - see below
                              // (the stored session is pm.cookies)
pm.response.errorCode         // string | undefined - TIMEOUT, DNS_ERROR, ...
pm.response.errorMessage      // string | undefined - the same failure in words
```

`errorCode` and `errorMessage` are present **only when the send failed before a
response arrived**, so `if (pm.response.errorCode)` is the test for a transport
failure - the status code in that case is vayu's synthetic `0`. A response that
reached the script from a server carries neither.

`reason()` reports the reason phrase from the status line. Where none was
received it falls back to the canonical text for the code, so a client-side
failure - vayu's synthetic status `0` - reads `"Error"` rather than an empty
string. (Postman returns `null` in that case; vayu always returns a string.)

### `status` is the reason phrase, `code` is the number

Postman spells the two apart: `code` is the number and `status` is the phrase
the status line carried. Vayu used to spell both as the number, so a lifted
`if (res.status === 'OK')` guard was always false and
`pm.expect(pm.response.status).to.eql('OK')` failed where Postman passes.
`status` is now the phrase - the same string `reason()` answers, wire phrase
where there was one and the registered text for the code where there was not -
on **both** objects that carry a status: the response a post-request script
reads, and the one a
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest) callback
receives. `code` is untouched on both.

That is a break for a script written against vayu's old spelling:

| Was | Reads now | Use instead |
|---|---|---|
| `pm.response.status` | `"OK"`, not `200` | `pm.response.code` |
| `pm.expect(pm.response.status).to.equal(200)` | fails - the phrase is not the code | `pm.expect(pm.response.code).to.equal(200)` |
| `if (pm.response.status >= 400)` | **never taken** - a phrase compares false against a number | `if (pm.response.code >= 400)` |
| `res.status` in a `pm.sendRequest` callback | the phrase | `res.code` |

The first two rows fail loudly: the comparison is always false, so the test
that made it goes red and names itself. **The third does not.** A guard
comparing `status` against a number is not an assertion, and JavaScript
answers `false` for it rather than throwing, so the branch simply stops being
entered and nothing reports that it stopped. Search a ported script for
arithmetic on `status` before trusting a green run.

`pm.response.to.have.status(...)` needs no migration - it has taken either
form since it learned the reason phrase, and decides by the argument's type.

`size()` counts the body the script can read through `text()`, so
`size().body === pm.response.text().length` for an ASCII body. `size().header`
is the serialised header block - `Name: Value\r\n` per header - reconstructed
from the parsed headers, so it is close to but not byte-exact with what came off
the wire. An empty body reports `0`, not an absent property.

### `pm.response.events` - a streamed run's events

A request sent with the **Event stream** setting on (`"stream": true` on
`POST /execute`) has no single response body; it has a list of events. The
post-request script runs **once, after the stream has terminated**, and reads
that list:

```javascript
const events = pm.response.events || [];

pm.test('the server said it was done', function () {
    pm.expect(events.some(function (e) { return e.event === 'done'; })).to.be.true;
});

pm.test('every token frame parsed', function () {
    events.forEach(function (e) {
        if (e.event === 'token') pm.expect(JSON.parse(e.data).text).to.be.a('string');
    });
});
```

Each entry is `{ event, id, data }`:

| Field | |
|-------|--|
| `event` | The frame's `event:` name, or `"message"` where it carried none - the SSE spec's default, resolved by the parser so no script has to. |
| `id` | The origin's `id:`, **absent** when it sent none. Not the relay's own frame id, which is a different number and would make a comparison silently wrong. |
| `data` | The `data:` payload as a string, multi-line frames joined with `\n`. `JSON.parse` it yourself - the wire says nothing about what it holds. |
| `dataTruncated` | `true` only when that one event hit `sseMaxEventBytes` and `data` is a prefix. Absent otherwise. |

**Buffered, never live.** The sandbox is synchronous and has no event loop (see
[Limitations](#limitations)), so a per-event callback is not a feature
that was left out - it is one the runtime cannot have. The script runs when the
stream is over, against what was retained.

**Check the markers before asserting over the whole stream.** The stored list is
bounded by `sseMaxStoredEvents`, and a script that counted a prefix would report
a wrong number with total confidence:

```javascript
if (!pm.response.eventsTruncated) {
    pm.test('exactly three events', function () {
        pm.expect((pm.response.events || []).length).to.equal(3);
    });
}
pm.test('the stream produced something', function () {
    pm.expect(pm.response.totalEvents || 0).to.be.above(0);
});
```

`pm.response.totalEvents` is every event the run received, including those
beyond the stored list; `pm.response.eventsTruncated` is the engine's own
comparison of the two, not something derived from a cap the script cannot see.
Both mirror the markers on the run's stored trace, because they are read from
the same node.

**Absent, not empty, on an ordinary response.** All three properties are missing
unless the run was a stream, so `typeof` separates "this was not a stream" from
"this stream produced nothing" - a distinction an empty array would erase:

```javascript
if (typeof pm.response.events === 'undefined') {
    console.log('not a streaming request');
}
```

**A load run's deferred script reads the same list** (0.17.2). `POST /runs` with
`"stream": true` samples its streaming responses like any other, and the
deferred `tests` script replays against those samples - so
`pm.response.events`, `pm.response.totalEvents` and `pm.response.eventsTruncated`
mean there exactly what they mean in design mode, and a script written for one
behaves the same in the other. Two differences follow from what a load sample
is, and both are visible to the script rather than assumed:

- The list is parsed back out of the sample's stored body, bounded by the same
  `sseMaxStoredEvents`. `totalEvents` is the count taken on the wire, so it
  stays truthful even where the body was cut.
- There is no `endReason` on this path. Under load a stream ends by server close
  or by one of the two caps, and nothing per sample records which - the run
  report's `stream.capped` carries that fact for the run as a whole.

A sample that did not stream still reads `undefined`, so the `typeof` check
above is the one guard on both paths.

A streaming send is answered `202` before its script has run, so the results go
to the run's trace rather than into a response body - the app's Tests and
Console panes show them when the stream finishes, and
[`GET /runs/:runId/report`](api-reference.md#get-runsrunidreport) carries them
under the trace's `scripts` node. A buffered send returns them *and* stores the
same object there (issue #725), so reopening either kind of run from History
shows the assertions it made.

A **collection run's step** is the same story with no live half at all: the run
was answered `202` when it started, so each step's results reach the app only on
its stored trace, under the same `scripts` node (issue #724). What a step
publishes while the run is still going is the count - `tests: {passed, failed}`
on its [`step` event](api-reference.md#get-runsrunidlive) - because the event
ring is fixed-size and a script may make hundreds of assertions. Both count
**both scripts'** assertions (issue #810), which is what fails the step in the
first place: a failing `pm.test` ends a step whichever script made it, and the
list used to hold the test script's alone, so a step could be `failed` and
named in its error line by an assertion its own Tests list did not contain.

### Reading response headers

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

`has()`'s optional second argument is compared strictly against the header's
wire value - a number never matches, since the wire value is always a string.

`headers` is a plain object, not Postman's `HeaderList`, but the read half of a
Postman `PropertyList` is on it: `get()`, `has()`, `each()`, `all()`, `count()`,
`toObject()`, `one()` and `indexOf()`. Every one of them that takes a header
name matches it the way HTTP header names work - case-insensitively, and
`toObject()`'s keys come back lower-cased for the same reason. Indexing does
not: the engine lower-cases
every response header name as it parses it, so `headers['Content-Type']` is
`undefined` while `headers.get('Content-Type')` works. Prefer the methods
unless you know the exact key.

The six beyond `get`/`has`:

- `all()` - every header as `{ key, value }`, in the object's own key order.
- `count()` - how many headers there are, i.e. `all().length`.
- `toObject(excludeDisabled?, caseSensitive?)` - a plain `{name: value}` object.
  **Keys are lower-cased by default**; pass a truthy second argument to keep
  the stored spelling instead. Postman's `toObject()` lower-cases whenever the
  list it is called on is indexed case-insensitively, which a header list
  always is.
- `one(name)` - the `{ key, value }` member rather than its value,
  case-insensitive, `undefined` when absent. `get` is the value half of the
  same lookup.
- `indexOf(name)` - the header's position in `all()`, case-insensitive, `-1`
  when absent. It also accepts a `{ key }` member (what `all()` / `one()` hand
  back) in place of a name.
- `each(fn, thisArg?)` - calls `fn(header, index, all)` for every header, the
  same three arguments Postman's iterator receives; `thisArg` becomes the
  callback's `this`. The member list is built once before the walk starts, so
  a callback that removes the header it was just handed does not shorten it.

All six are non-enumerable, exactly like `get()` and `has()`, so none of them
ever appear in `Object.keys()` or `JSON.stringify()`.

The response object has **no** `add`/`upsert`/`remove` - the response has
already arrived, so a mutator there would only appear to change something.

**A name the server sent twice reads as one value, folded with `", "`.** Two
`Set-Cookie` lines arrive as
`"session=abc; Path=/, csrf=xyz; Path=/"`, and `get()` returns that whole
string - there is no list form, because `headers` is a plain object. Folding is
the RFC 7230 §3.2.2 equivalence for comma-list headers; before it, only the
**last** value of a repeated name survived at all. If you need the parts, split
on `", "` - but not for `Set-Cookie`, whose values contain commas of their own
(`Expires=Wed, 21 Oct ...`). Read `pm.response.cookies` instead: it is that
header already parsed, boundaries and all.

**`all()` reports the object's key order, not wire order, and can never report
a duplicate.** Postman's `HeaderList` keeps both; this object cannot, because
it is built from a single-valued case-insensitive map and a name sent twice has
already been folded into the one entry above by the time any script sees
it - there is only ever one member to report for it.

### Reading response cookies

```javascript
pm.response.cookies.get('session');    // value, or undefined if unset
pm.response.cookies.has('session');    // boolean
pm.response.cookies.toObject();        // { session: 'abc', tracker: 't1' }
pm.response.cookies.length;            // it is an array, in wire order
pm.response.cookies[0].name;           // 'session'
pm.response.cookies[0].value;          // 'abc'
pm.response.cookies[0].attrs;          // ['Path=/', 'HttpOnly'] - raw chunks
```

`cookies` is what the response's `Set-Cookie` header carried, parsed - an array
of `{ name, value, attrs }` with `get()` / `has()` / `toObject()` over it.
Attributes are the raw `;`-separated chunks in wire order; there are no
`path` / `secure` / `expires` fields, because that is the header restated, and
what the engine actually *holds* is [`pm.cookies`](#the-cookie-jar-pmcookies).

Three things follow from that, and they are the ones worth knowing:

- **This is one response, not the session.** It reports what this response set,
  including a cookie the engine then discarded as expired. For what will be
  sent on the next request, read [`pm.cookies`](#the-cookie-jar-pmcookies).
- **Cookie names are case-sensitive**, unlike header names: `get('SESSION')`
  does not answer the `session` cookie. That is what RFC 6265 says, and
  answering otherwise would be a wrong value dressed as a right one.
- **A name set twice answers with the last value** from `get()` and
  `toObject()` - the one a browser's jar would keep - while the array still
  lists both, because that is what came off the wire.

The parse is shared with the app's response Cookies tab through a conformance
fixture (`engine/tests/fixtures/set-cookie-conformance.json`), so the value a
script asserts on and the value shown in the UI cannot drift. It handles the two
cases a naive split corrupts: a comma inside `Expires=Wed, 21 Oct ...` is not a
cookie boundary, and the `=` padding on a base64 value stays in the value.

### Response Assertions

```javascript
pm.response.to.have.status(200);                          // status code
pm.response.to.have.status('OK');                         // reason phrase, not a code
pm.response.to.have.header('Content-Type');               // header exists
pm.response.to.have.header('Content-Type', 'text/plain'); // exact value, strict
pm.response.to.have.body('{"ok":true}');                  // body equals this exactly
pm.response.to.have.body(/"ok":\s*true/);                 // regex run against the body
pm.response.to.have.body({ ok: true });                   // parsed JSON deep-equals this
pm.response.to.have.jsonBody();                           // body parses as JSON
pm.response.to.have.jsonBody('data.id');                  // that property exists
pm.response.to.have.jsonBody('data.id', 42);              // exists and deep-equals 42
```

`have.status` means two different things depending on the argument's type: a
number is the status code, a string is compared against the reason phrase
`pm.response.reason()` answers. **`status('200')` fails** - a string is always
a reason phrase to compare, never a code coerced to one. **A number that is not
a whole finite code is refused**, not truncated: `status(200.5)` used to compare
as `200` and pass against a 200, and no response carries a fractional code, so
the `TypeError` names what was written rather than reporting a verdict about the
status that did arrive (#1048). `status(NaN)` is refused the same way.

`have.header`'s second argument is compared strictly against the header as it
arrived on the wire. `header('X-Count', 5)` fails rather than stringifying `5`
into agreement; the expected value must already be the string form.

`have.body` accepts exactly three forms. A string must equal the body
**exactly** - this used to be a substring search. A regular expression is run
against the body text. An object is deep-equalled against the parsed JSON
body. Any other argument type - a number, a boolean - is a `TypeError` naming
the three accepted forms rather than a verdict: Postman silently asserts
nothing for those inputs, and Vayu refuses a silent non-assertion instead
(#998).

`have.jsonBody` takes an optional path and an optional value. No arguments
checks only that the body parses as JSON. A path checks that the property
exists. A path plus a value checks that the property exists **and** deeply
equals it - before #998 the value argument was accepted but never compared,
so a wrong expected value still passed.

Status-class assertions hang off `pm.response.to.be`. They are **getters** - the
paren-less form is the assertion:

```javascript
pm.response.to.be.ok;            // status 200 only
pm.response.to.be.success;       // 2xx
pm.response.to.be.info;          // 1xx
pm.response.to.be.redirection;   // 3xx
pm.response.to.be.clientError;   // 4xx
pm.response.to.be.serverError;   // 5xx
pm.response.to.be.error;         // 4xx or 5xx
pm.response.to.be.accepted;      // 202
pm.response.to.be.badRequest;    // 400
pm.response.to.be.unauthorized;  // 401
pm.response.to.be.forbidden;     // 403
pm.response.to.be.notFound;      // 404
pm.response.to.be.rateLimited;   // 429
pm.response.to.be.json;          // body parses as JSON
pm.response.to.be.withBody;      // body is not empty
```

**`ok` is status 200 only, not any 2xx** (#998) - `success` is the 2xx one. A
script that meant "any 2xx" and asserted `.ok` needs `.success` instead.
Postman's named statuses (`accepted`, `badRequest`, ...) also match by reason
phrase; Vayu's stay code-only.

**Anything else under `pm.response.to` throws.** A misspelled or unimplemented
name - `pm.response.to.be.definitelyNotAMatcher`, or the negated
`pm.response.to.not.be.ok`, which Vayu does not have - raises a `TypeError`
naming the chain rather than evaluating to `undefined`. A paren-less assertion
is an expression statement, so a silent `undefined` would report PASS against a
broken API; failing loudly is the point.

## Request Object (`pm.request`)

Access request data:

```javascript
pm.request.method            // HTTP method (string)
pm.request.url               // Full URL (Postman Url object - see below)
pm.request.headers           // Request headers (object, with the methods below)
pm.request.body              // Request body (Postman RequestBody object, if any - see below)
```

**`headers` is a different set in each hook, and that is the point.** A
pre-request script sees the **composed** headers - the set it is there to edit,
and the set the write-back applies back onto the request. A test script sees the
**sent record**: those same headers as the transfer actually issued them, which
means the ones the engine derives at send time are there too - the body-implied
`Content-Type` (`graphql` and `jsonrpc` -> `application/json`, `xml` ->
`application/xml`, `x-www-form-urlencoded` ->
`application/x-www-form-urlencoded`) and the
[default headers](api-reference.md#default-request-headers) the send added - the
`User-Agent`, a negotiated `Accept-Encoding`, and a correlation id where one is
switched on. So a test
asserting on the Content-Type a GraphQL request sent reads the header the engine
supplied, rather than the `undefined` it read before (#483) - with one exception
the method decides: a `graphql` body on a **GET** travels as query parameters
and sends no body at all, so there is nothing for a Content-Type to describe and
the engine derives none (issue #1228, see
[the `graphql` envelope](api-reference.md#the-graphql-envelope)).

Four consequences worth knowing:

- **An authored header is never overridden.** The engine only derives a
  Content-Type the request does not declare, so what a script reads back is what
  its author wrote.
- **A `form-data` Content-Type is absent, not blank.** libcurl writes that one
  itself, boundary and all, so the engine suppresses an authored one and does
  not report as sent what it did not send. The script's view matches the
  response pane's Headers tab exactly.
- **A header with an empty value is absent too.** A header line with nothing
  after the colon is libcurl's spelling for *remove this header*, so an enabled
  row whose value is empty (or only whitespace) never goes on the wire - and
  the sent record does not claim it did. A pre-request script that sets a
  header to `''` has removed it, not blanked it; give it a value to send one.
- **`Cookie` is not here.** It is wire-only by design; `pm.cookies` is the
  cookie surface, and the response's raw view is the full wire frame (which also
  carries libcurl's own `Accept`, `Host` and `Content-Length`).

`pm.request.body` is Postman's `RequestBody` object (issue #1003), present only
when the request has a body: a bodyless request still defines no `body`
property at all, so `typeof pm.request.body === 'undefined'` still separates
"no body" from "a body that happens to be empty", exactly as it did when this
was a string.

```javascript
pm.request.body.mode         // 'urlencoded' | 'formdata' | 'graphql' | 'raw'
pm.request.body.raw          // the body as a string, for every mode
pm.request.body.urlencoded   // [{key, value, disabled}, ...] or undefined
pm.request.body.formdata     // [{key, value?, type, fileName?, disabled}, ...] or undefined
pm.request.body.graphql      // {query, variables?} or undefined
pm.request.body.length       // the body string's own length
```

`.mode` reads `raw` for every content mode without a Postman name of its own -
`json`, `text`, `xml`, `binary` and `jsonrpc` all carry their body as one
string, which is what `raw` means.

Postman's fifth mode, `file`, is deliberately not answered: it promises
`file.src`, a path, and a `binary` body here carries **bytes**. The only path
this model holds belongs to a form-data file part, which is a different mode and
is never disclosed to a script (issue #411). A `binary` body therefore reads
`raw`, and that is a stated divergence rather than an omission - see
[pm-api-compatibility.md](../app/pm-api-compatibility.md).

### `graphql` bodies (issue #1111)

`.mode` reads `graphql` for a GraphQL body, and `.graphql` answers Postman's
`{query, variables}` pair. Vayu stores such a body as **one string** that is
allowed to be either the `{"query": …}` envelope the request builder writes or
the bare document an agent or a `curl` caller hands over; the pair is derived
from that string by the same classifier the send itself goes through, so
`.graphql.query` is the query that goes on the wire rather than a second reading
of the same bytes.

```javascript
// An enveloped body answers its own members.
pm.request.body.graphql.query        // 'query User($id: ID!) { user(id: $id) { name } }'
pm.request.body.graphql.variables.id // '42'

// A bare document answers as the query it would be wrapped and sent as.
pm.request.body.graphql.query        // 'query User { user { name } }'
```

Three things worth knowing before scripting against it:

- **`variables` is the JSON value the envelope carries**, where Postman's is the
  *text* of its variables editor. Vayu never stored that text, and serializing
  one here would invent whitespace and key order the user never wrote. Read it
  as an object; a lifted `JSON.parse(…variables)` is the one call to change.
- **A body that is envelope-shaped but does not parse answers `undefined`** - an
  unresolved `{{token}}`, or a mistyped envelope. The send passes such a body
  through untouched rather than wrapping something it could not read, and a pair
  invented here would be the guess it refuses. `.raw` still carries the string.
- **`.raw` stays the whole string in this mode too**, where Postman leaves it
  undefined - the same divergence `.raw` already carries for the two form modes,
  and for the same reason. Assigning `.raw` moves the pair with it.

A lifted `pm.request.body.mode === 'raw'` guard over a GraphQL body took the
true branch before this and takes the false one now. That is the break, and it
is the compatible answer: Postman names this mode too, so a script written
against Postman was already reading `graphql` there.

`.raw` is the string every mode reads as, including the two whose content is a
list of fields rather than text - and it is defined for both of those, where
Postman leaves it `undefined`, because a form body reading as nothing cannot be
told apart from a request with no body (issue #411). A form body's `.raw` reads
its **enabled** fields encoded `key=value&…`:

| Body mode | What `.raw` reads | Assigning a string (or `.raw`) |
|---|---|---|
| `json` / `text` / `xml` / `graphql` / … | the content, as stored | replaces it |
| `x-www-form-urlencoded` | the encoded fields - **exactly** the bytes sent | parses back into the fields |
| `form-data` | the encoded fields, file parts as `key=@filename` - a *rendering*, not the bytes sent | refused with a named error |
| none | the property is absent (`undefined`) | sends that string as raw text |

A **file part** reads `avatar=@portrait.png`, borrowing curl's `-F` spelling,
because it carries its content in a path rather than a value - encoded as a pair
it would read `avatar=`, indistinguishable from a text part whose value happens
to be empty. The name shown is the one the server is told (the part's declared
filename, else the basename of the chosen file), never the local path. A text
value starting with `@` cannot be confused with it: percent-encoding escapes
that to `%40`, and the marker is written unescaped.

The `form-data` split is not an oversight: a multipart body carries a boundary
libcurl generates at transfer time, so no faithful string exists before the send.
That makes the string safe to read and log, but a digest taken over it is **not**
a digest of the multipart body that goes out - and it is why an assignment is
refused there rather than accepted and then ignored by the transfer layer. To
change a multipart body, edit the request's form fields; `delete pm.request.body`
still drops it entirely.

`.urlencoded` and `.formdata` are the two field lists, present only in their own
mode and `undefined` in every other: `{ key, value, disabled }` per
x-www-form-urlencoded pair, or `{ key, value?, type, fileName?, disabled }` per
multipart part. Values are as the user wrote them, not percent-encoded - the
encoding is `.raw`'s answer, so a signature built from these pairs would
double-encode if this were encoded too. A disabled row is listed with
`disabled: true` rather than omitted, so a script can see the row it would
otherwise re-add. A file part carries no `value` at all, rather than the `""`
an empty text field would hold - an empty string there would read as a text
field that happens to be empty - and never the local path.

Both lists are **read-only**, and so are `.mode` and `.length`. Assigning any of
the four throws naming the member, and so does `push`ing into a list, which is
frozen. Writing to a field *inside* an entry is the one edit that does not throw
- a frozen object drops a write silently in non-strict code, which is
JavaScript's own rule rather than one this surface adds - and it reaches nothing
either way. Assign `pm.request.body` or `.raw` to change what is sent, or edit
the request's form fields directly.

Reading a form body never rewrites it. The write-back reads `body` off the
script's object whether or not the script assigned it, so an **unchanged**
value means untouched - without that, a script that only looked at the body
would delete the disabled rows the encoded view leaves out.

### The body was a string too, and mostly still behaves as one

This shape replaced a plain string (issue #1003: Postman compatibility over the
shipped string shape, the same trade issue #991 made for the
[URL](#url-parts-pmrequesturl)). The object keeps as much of the old behaviour
as JavaScript allows - it carries its own `toString`, `valueOf`, `toJSON` and
`Symbol.toPrimitive`, and inherits from `String.prototype`:

```javascript
'' + pm.request.body;                     // the body
`${pm.request.body}`;                     // the body
pm.request.body == 'plain text';          // compares as the body
pm.request.body.startsWith('{');          // String methods work
pm.request.body.length;                   // the body's own length
JSON.stringify({ b: pm.request.body });   // embeds the body string
```

Three things did change, and no mitigation can fix them:

| Was | Now | Use |
|-----|-----|-----|
| `pm.request.body === '...'` | `false` | `==`, or `.toString()` |
| `typeof pm.request.body` | `'object'` | - |
| `pm.request.headers['X-Body'] = pm.request.body` | refused | `pm.request.headers['X-Body'] = String(pm.request.body)` |

The third is the same refusal `pm.request.url` already gets: a value the engine
cannot send is refused rather than coerced, and an object is not a header
value.

`.length` is **not** one of them: it is defined on the object as the body's own
length. Inheriting it from `String.prototype` - which is a String object
holding `""` - would have answered `0` for a body that is not empty, and a
plausible wrong number is worse than a break you can see.

### Mutating the request (pre-request scripts)

In a **pre-request** script these four fields are writable, and what they hold
when the script returns is what goes on the wire. In a **test** script they are
a read-only record of what was already sent - writes there are discarded.

```javascript
pm.request.headers['X-Signature'] = 'abc123';   // add or replace a header
delete pm.request.headers['Authorization'];     // remove one
pm.request.url = 'https://api.example.com/v2';  // retarget
pm.request.method = 'POST';                     // case-insensitive
pm.request.body = JSON.stringify({ n: 2 });     // replace the body
delete pm.request.body;                         // send no body
```

Rules worth knowing before you rely on them:

- **The object is authoritative, not a diff.** The header set left in
  `pm.request.headers` is the header set that is sent, which is what makes
  `delete` work.
- **A script beats engine-applied auth.** Auth (bearer / basic / apikey /
  oauth2) is resolved into the request *before* the script runs, so the script
  sees the real `Authorization` header and can replace or remove it.
- **A bad value is refused, not coerced.** `method` must be a string (one of the
  seven HTTP verbs), `url` a URL string (assigning anything else throws at the
  assignment), header values must be strings, numbers or booleans, and `body`
  must be a string or the `RequestBody` object `pm.request.body` itself holds -
  handing the object straight back (`pm.request.body = pm.request.body`)
  changes nothing. Anything else fails the whole write-back - the request is
  sent unchanged and the reason is reported as the pre-request script error,
  visible in the response pane's Console tab. Assigning a string to a
  `form-data` body fails the same way, for the same reason: a value the engine
  cannot send is refused rather than dropped.
- **Setting a variable can re-render the URL, if composition left it
  unresolved.** `{{placeholders}}` are still resolved at compose time
  (`POST /compose`), strictly before any script runs (#226, D1 stands) - but a
  name composition could not answer keeps its braces (#1009) and is resolved
  again after the pre-request script and before the send (#1008), against the
  scopes as the script left them. So `pm.environment.set('host', …)` reaches a
  `{{host}}` in this send's URL as long as nothing already answered `host` at
  compose time; a `{{host}}` composition already substituted is finished text
  and this pass does not touch it - assign `pm.request.url` directly to change
  that.
- **Load tests do not run pre-request scripts** - only the `tests` (post-request)
  script runs there, so this applies to Send / Design Mode.

### Header methods (`pm.request.headers`)

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

These act on the **same object** as indexing and `delete`, so the two styles
mix freely and the write-back sees one header set either way. They are
non-enumerable properties of it, so they never appear in `Object.keys()`,
`JSON.stringify()` or on the wire.

Behaviours worth knowing:

- **The methods are case-insensitive; indexing is not.** `upsert('authorization', v)`
  replaces an existing `Authorization` rather than adding a second spelling -
  which matters, because the write-back refuses a header set holding two casings
  of one name.
- **`add` refuses a name that is already there**, and says to use `upsert`.
  Postman's `HeaderList` holds duplicates and `add` appends one; a request here
  carries a single value per name, so the difference is reported rather than
  silently collapsed into an `upsert`.
- **`remove` on an absent header is a no-op**, not an error.
- **`has`'s optional value argument is a strict string compare**, the same rule
  `pm.response.headers.has` follows - a number never matches, since the
  outgoing header is always a string.
- **`toObject()` lower-cases its keys by default.** `pm.request.headers` keeps
  whatever casing the request holds - which can be whatever the user typed -
  so copying its own keys would have answered `undefined` for
  `toObject()['content-type']` on a request carrying `Content-Type`. Pass a
  truthy second argument (`toObject(false, true)`) to keep the stored spelling
  instead.
- **`all()` reports this object's key order, not wire order, and can never
  report a duplicate** - unlike Postman's `HeaderList`, which keeps both. A
  name assigned twice already collapsed into one entry (the second write
  replaced the first), so there is only ever one member for `all()` to report.
- **`indexOf` matches a `{ key }` member by its `key`, not by identity.**
  Postman finds a member by identity in its own list; the members here are
  built fresh on every call, so identity would answer `-1` for a member of the
  very list it came from. Matching the key answers what Postman answers for
  that case, and `-1` for an object naming a header this list does not hold.

A bad argument fails loudly: a name must be a non-empty string and a value a
string, number or boolean - the same set plain assignment accepts. `each`
throws if its first argument is not a function. Detaching a method from its
object (`const get = pm.request.headers.get`) throws rather than answering as
though the header were missing. A throw out of an `each` callback propagates as
the script's own error.

### URL parts (`pm.request.url`)

`pm.request.url` is Postman's `Url` object, so a script lifted from Postman
reads its parts under the same names:

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
pm.request.url.toString();       // the whole URL
```

```javascript
pm.request.url.query.get('page');     // first value, or null
pm.request.url.query.has('page');     // boolean
pm.request.url.query.all();           // [{key, value}, ...] in wire order
pm.request.url.query.toObject();      // {page: '2'} - last wins
pm.request.url.query.count();         // 3
```

Four rules behind those answers:

- **Path segments are decoded, query values are not.** A path is what you want
  to read; a query is what you want to *sign*, and a canonical string has to be
  built from the bytes that were sent. `getQueryString()` is byte-exact against
  the wire.
- **`all()` keeps wire order and duplicates**, which is the whole reason it
  exists beside `toObject()`. `get(name)` answers the **first** match (Postman's
  `PropertyList.one`); `toObject()` is last-wins and says so.
- **A bare `?flag` reads as `null`, an empty `?flag=` as `''`.** Both are
  `has()`-true.
- **A URL the parser cannot read has no parts.** `toString()` still answers the
  whole string, and every part is empty rather than a plausible half.

#### Writing

The whole URL - assign a string, or call `update()`, which is Postman's
spelling of the same write:

```javascript
pm.request.url = 'https://api.example.com/v3/orders';   // re-parses in place
pm.request.url.update('https://api.example.com/v3/orders'); // the same write
```

Or one member at a time. `path` and `host` are live arrays, and the query has
Postman's `PropertyList` writers beside its reads:

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

Four rules behind those, each the reason for a decision you might otherwise
undo:

- **A URL nobody edited is sent exactly as it arrived.** The parts are
  recomposed only when a member was actually written to, so a read-only script
  cannot change a single byte - which is what keeps `getQueryString()`
  byte-exact against the wire.
- **`upsert` keeps wire position**, `add` appends. A parameter that quietly
  moved to the end would change the shape of any signature computed over the
  query.
- **`remove(name)` takes every match.** Removing `page` from `?page=1&page=2`
  and getting one back has removed nothing the caller can observe.
- **An edit that cannot reach the wire is an error, never a no-op.** A URL the
  parser could not read has no parts to edit, so a write is refused rather than
  composing `://` out of empty pieces, and a path segment that is not a string
  or a number is refused rather than becoming `[object Object]`. `path` and
  `host` are ordinary arrays that are **read back** when the URL is needed - the
  same rule `pm.request.headers` follows - so a bad segment surfaces as a
  rejected write-back, with the member and the index named, rather than at the
  `push`.

In a **test** script these behave like every other `pm.request` write: they
change what the script sees and reach nothing, because the request has already
gone out.

#### It was a string, and mostly still behaves as one

This shape replaced a plain string (issue #991: Postman compatibility over the
shipped string shape). The object keeps as much of the old behaviour as
JavaScript allows - it carries its own `toString`, `valueOf`, `toJSON` and
`Symbol.toPrimitive`, and inherits from `String.prototype`:

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

`.length` is **not** one of them: it is defined on the object as the URL's own
length. Inheriting it from `String.prototype` - which is a String object holding
`""` - would have answered `0` for every URL, and a plausible wrong number is
worse than a break you can see.

## Script Identity (`pm.info`)

What the script is attached to, and which hook is running it. Six fields,
each **optional** - `pm.info` is always an object, but a field with no truthful
value is absent rather than `""`, so `typeof` is how a script tests for one:

```javascript
pm.info.requestId      // string | undefined - the saved request this send is filed under
pm.info.requestName    // string | undefined - its name, as the client sent it
pm.info.eventName      // 'prerequest' in a pre-request script, 'test' in a test script
pm.info.iteration      // number | undefined - 0-based, in a run of any shape
pm.info.vu             // number | undefined - 1-based, the virtual user that sent it
pm.info.iterationCount // number | undefined - the run's iteration total
```

`eventName` is stamped by the engine at each hook (`ScriptContext::for_prerequest`
/ `for_test`), never by the caller, so it cannot disagree with the hook that is
actually running. The other two are supplied per send:

- `requestId` is the payload's `requestId`, which is also what files the run in
  History. Absent for an ad-hoc send (MCP's `run_request` without one, a load
  run started from a URL).
- `requestName` comes from the payload's `requestName`, falling back to the
  stored row's name when only an id was sent. The client sends it because Send
  executes *editor state*: an unsaved request has a name and no row to read it
  from, and a name edited but not yet saved should read as what the user sees.
  `POST /compose` fills it in on its by-id path, so a composed payload arrives
  carrying it.

**`iteration` is reported wherever a real one exists, and nowhere else.** In a
design-mode scenario run (`POST /runs` with a `scenario` block and no `mode`)
every step's scripts read the real index - `iteration` counts from 0, and it
reads as `0`, not as absent, on the first pass. A **scenario load run**'s
deferred per-step script reads it too: each sampled response carries the virtual
user's iteration it was actually sent in, so the number is a fact about that
response rather than its position in a reservoir.

**A single-request load run reports one too, since issue #994.** It used to read
`undefined` there, on the rule that a *reservoir position* is not an iteration -
and that rule is intact, because this is not one: each submission claims its
index before it is sent, and the index travels with the response into the
sample, exactly as `dataRowIndex` does. It is the same counter the run's data
rows are claimed from, so a script grading a sampled response can say which
iteration produced it and which row it carried, and the two agree. An ordinary
Send still reads `undefined`: one request is not a pass of anything.

**`vu` is the virtual user that sent the request, 1-based.** It spans the run's
concurrency in a scenario load run, where each user walks the sequence with its
own cookies and its own iteration counter. Everywhere else it is `1`, and that
is a statement rather than a placeholder: a single request repeated under load
is one user's iterations however many are in flight, and so is a collection run
in design mode. `undefined` on an ordinary Send, beside `iteration`.

**`iterationCount` is set by the collection runner, and by a send that bound a
row.** The runner reports the run's total; a send-with-row reports `1`, since
that send is row 0 of 1 and says so about `iteration` already (see
[Data rows](#data-rows-pmiterationdata)). A **load run** is where it stays
`undefined`: a duration-bounded run has no iteration total to report, and a
field readable from one load run and not another is worse than one that is
never readable there at all.

## Environment Variables (`pm.environment`)

Access and modify environment variables:

```javascript
// Get variable
const token = pm.environment.get('auth_token');

// Set variable (persists to environment)
pm.environment.set('auth_token', 'new_token_value');
```

`set()` on an existing name replaces only its value - the variable's `secret`,
`enabled`, `type` and creation time are kept. A name that does not exist yet is
created with the defaults and stamped with its creation time, so it appears at
the bottom of that scope in the variables editor rather than above the rows
that were already there. A scope no script wrote is not persisted at all.

### The six methods every scope has

| Method | Returns | Notes |
|---|---|---|
| `get(name)` | the value, cast by its declared type, or `undefined` | a disabled variable reads as `undefined` |
| `set(name, value)` | `undefined` | keeps `secret` / `enabled` / `type` / creation time |
| `has(name)` | `boolean` | true only for the rows `get()` can read, so a disabled variable is `false` |
| `unset(name)` | `undefined` | removes the name; removing one that is not there is not an error |
| `clear()` | `undefined` | empties **this** scope only, disabled rows included |
| `toObject()` | plain object | every enabled variable, values cast by type; a snapshot, not a live view |

```javascript
if (pm.environment.has('auth_token')) {
	pm.environment.unset('auth_token');
}

console.log(pm.environment.toObject());
```

`unset()` is not the same as `set(name, '')`. An emptied variable is still an
enabled row, so `{{auth_token}}` resolves to the empty string; an unset one is
gone, and the template resolves as it does for a name nobody defined. The
removal reaches disk the same way any other write does - the scope is rewritten
after the run because the map the script left differs from the stored one.

A scope the run was not given (a design run with no active environment, say)
behaves as an empty one: `get` is `undefined`, `has` is `false`, `toObject` is
`{}`, and writes go nowhere. A script cannot see which scopes a run carries, so
this is deliberately not an error.

## Collection and Global Variables

The other two scopes are reached the same way as the environment, each through
its own accessor, and answer the same six methods:

```javascript
const value = pm.collectionVariables.get('baseUrl');
pm.collectionVariables.set('baseUrl', 'https://api.example.com');

const runId = pm.globals.get('run_id');
pm.globals.set('run_id', '42');
```

Each `set()` persists to the scope it names, with the same
keep-the-flags behaviour described for `pm.environment` above.

`pm.collectionVariables` reads the request's **whole collection chain**, the
same merge `{{name}}` resolution uses: `get`, `has` and `toObject` take the
nearest enabled definition, walking from the request's own collection up to the
root. A variable defined on a parent collection therefore reads the same in a
script as it substitutes in a URL.

**Writes stay on the request's own collection.** `set`, `unset` and `clear`
never reach an ancestor, so `set` on a descendant *shadows* an inherited name
and `unset` un-shadows it - the ancestor's value comes back rather than being
deleted. A disabled row is looked past wherever it sits in the chain. The full
rule, and why ancestors are read-only, is in
[Variable Resolution](../app/variable-resolution.md).

## Variables (`pm.variables`)

`pm.variables` reads a name without naming its scope, resolving **the bound
data row first (if one is bound), then environment, then collection, then
global**, and stopping at the first tier that has it. That is the same order
`{{baseUrl}}` is resolved in before the request is sent (see
[Variable Resolution](../app/variable-resolution.md)), so a script and a URL in
the same request cannot read one name two different ways.

**While a data row is bound, its bare column names answer first** (issue
#1007) - above environment, collection and globals. Postman binds a dataset's
columns bare, so an imported data-driven collection is written
`{{username}}` rather than `{{data.username}}`, and `pm.variables.get`,
`.has` and `.toObject` read the row before any scope for exactly that reason:

```javascript
// In a data-driven run, with a row carrying username and city:
pm.variables.get('username');   // this iteration's `username` cell, typed
pm.variables.has('username');   // true, even if an environment var of the
                                 // same name exists - the row wins
```

`get` and `toObject` hand the row's cell back **typed**, exactly as
`pm.iterationData.get` does - a number column reads as a number, not a
stringified one. A name the bound row does **not** carry is not a miss on this
tier alone; it falls through to environment, collection and globals precisely
as it would with no data file at all, which is what lets one script run both
in a data-driven run and a plain Send. With no row bound, this tier is simply
absent and `pm.variables` behaves exactly as it always has. The reserved
`data.` prefix is not part of this tier at all - `pm.variables.get("data.userId")`
still answers `undefined` regardless of what row is bound (see below).

```javascript
const baseUrl = pm.variables.get('baseUrl'); // wherever it is defined
if (pm.variables.has('debug')) { /* ... */ }
console.log(pm.variables.toObject()); // the bound row, then all three scopes, merged
```

It has `get`, `has` and `toObject` - and no `unset` or `clear`, because it owns
no scope to remove a name from (the row is read-only too - see
[`pm.iterationData`](#data-rows-pmiterationdata) below).

**`pm.variables.set()` throws.** In Postman it writes to a *local* scope that
lives for one request and is never stored; Vayu has no such scope. Writing to
the environment instead would persist a value the script author expects to
vanish, and quietly dropping the call would lose a write they believe happened,
so it fails loudly and names the three scopes that do exist:

```
TypeError: pm.variables.set is not supported: Vayu has no local variable scope.
Use pm.environment.set(), pm.collectionVariables.set() or pm.globals.set() to
choose where the value is stored.
```

**`pm.variables.replaceIn(template)`** - Postman's `{{name}}` interpolation of
an arbitrary string - runs the same resolver `POST /compose` uses
(`request_composer.cpp::resolve_template`), over the script's scopes in
`pm.variables`' precedence, at **call time** - so a variable the script set a
line earlier resolves, unlike `{{}}` in the URL, which was composed before the
script started. Dynamic variables generate per occurrence:

```javascript
const id = pm.variables.replaceIn("{{$guid}}"); // fresh UUID v4
```

It exists only on the merged accessor - the scoped `replaceIn` variants stay
absent - and its argument must be a string (a non-string is a `TypeError`).
This is the one sanctioned way to `{{...}}` in a script: script *source* is
never interpolated (issue #226, D16 - a rewrite cannot tell code from a string
literal, and splicing values into source is an injection).

**It resolves the reserved data namespace too** (issue #890), which composition
deliberately does not: `resolve_template` leaves `{{data.column}}` written as it
stands because a plan is composed once, before any row is bound, while this runs
per step with the iteration's row in hand. A column the row does not carry is a
`TypeError` naming the token and the row's columns - the bind-time rule
(`apply_iteration_template`) in a shape a script can catch - and with no row bound at
all the token keeps its braces.

**The reserved `data.` prefix is still not a variable scope, though.**
`pm.variables.get("data.userId")` and `.has(...)` answer `undefined` / `false`
regardless of what row is bound - `data.` is disjoint from the variable scopes
by design (`core/scenario_data.hpp`), and `pm.iterationData` remains its only
accessor. That is a different question from the **bare** column names above:
`pm.variables.get("userId")` *does* read the bound row (issue #1007), so only
the prefixed spelling stays outside `pm.variables` entirely. `replaceIn`
resolves both spellings because it renders a *template*, and `{{data.userId}}`
is a token template syntax has - `get` and `.has` are lookups by name, and
`data.userId` was never a name any scope, or now the row, answers to.

**The identity namespace resolves from `replaceIn` too** (issue #1057).
`{{$vu}}` and `{{$iteration}}` render to numbers, the same way `{{data.column}}`
does above: the resolver takes the identity the request beside the script was
bound with, ahead of every scope and ahead of the row, so `replaceIn` and the
request cannot disagree about one send. Which numbers those are is the run's
own question, answered per shape in
[the binding table](../app/variable-resolution.md#vu-and-iteration-are-reserved-too-for-the-same-reason):
a collection run in design mode is one user walking the sequence, so `{{$vu}}`
renders `1` while `{{$iteration}}` advances with the pass. On a plain Send the
numbers are `1` and `0`, because `POST /execute` binds exactly those into every
send that carries no row of its own (a single send is a run of one, issue
#994) - and it binds them before the pre-request script runs, so they are what
the request the script is handed already carries.

That is not the same fact [`pm.info.vu` and `pm.info.iteration`](#script-identity-pminfo)
carry, and the two staying different is not a contradiction to resolve: `pm.info`
answers which iteration of which run this script is running in, and reads
`undefined` on that same plain Send because there is no run to be an iteration
of. A token in a template answers what it resolves to *here*, and here it
resolves to what the request beside it carried - a run of one has an identity
even though it has no `pm.info`.

**Dynamic variables are otherwise not readable from a script.** `{{$guid}}`,
`{{$timestamp}}` and the rest of the set in
[variable resolution](../app/variable-resolution.md#dynamic-variables) are
generated while the payload is composed; by the time a script runs, that
payload holds the generated *value* and no scope has ever heard of the name.
`pm.variables.get("$guid")` reads as any other undefined name does - reach the
generators through `replaceIn`.

## Sending a request from a script (`pm.sendRequest`)

The one part of the sandbox that touches the network. Its reason for existing is
the token fetch: a pre-request script that needs a credential the request itself
cannot supply.

```javascript
pm.sendRequest(
  {
    url: "https://auth.example.com/token",
    method: "POST",
    header: { "Content-Type": "application/json" },
    body: { mode: "raw", raw: JSON.stringify({ client_id: "abc" }) },
  },
  function (err, res) {
    if (err) {
      console.error("token fetch failed: " + err.message);
      return;
    }
    pm.environment.set("token", res.json().access_token);
  }
);
```

The first argument is a URL string or an options object; the second is required
and must be a function.

| Option | Shape |
| ------ | ----- |
| `url` | string, required, or `pm.request.url` - the Url object, so `pm.sendRequest(pm.request.url, cb)` reads as "send this again". A hand-built `{ host, path }` object is still not accepted |
| `method` | string, default `GET`; case-insensitive, an unknown verb throws |
| `header` / `headers` | `{ name: value }` or Postman's `[{ key, value }]`. Both names read; sending both at once throws |
| `body` | a string, or `{ mode: 'raw', raw }`. Only `raw` - other modes throw |
| `auth` | Postman's `{ type, <type>: params }`. `basic`, `bearer`, `apikey`, `noauth`; any other type throws |
| `timeout` | milliseconds, clamped to the script's remaining budget (below) |

**Synchronous, and callback-shaped for that reason.** The send blocks and the
callback runs inline, before `pm.sendRequest` returns. There is no promise
overload: `Promise` exists in the sandbox but nothing drains its job queue, so
one could only never resolve - the same reason hashing is `pm.crypto` rather
than `crypto.subtle`.

**Which failures throw and which reach the callback.** Transport failures are
the network's answer, so they arrive as the callback's `err` - an `Error` with
a `.code` (`CONNECTION_FAILED`, `DNS_ERROR`, `TIMEOUT`, …) and `res` null. The
script's own mistakes throw out of the call instead: an unusable argument, an
unsupported body mode, exceeding the request cap, and the capability being off.
A response over the byte bound below is the network's answer too, not a
mistake: it arrives as `err` with `.code` `RESPONSE_TOO_LARGE`.

`res` carries `code`, `status` (the reason phrase, as on `pm.response`),
`responseTime`, `headers` with `get()`/`has()`/`each()`/`all()`/`count()`/
`toObject()`/`one()`/`indexOf()` - the same read methods documented under
[Reading response headers](#reading-response-headers) - `json()` and `text()`.
It is a subset of `pm.response` and has no `to.*` assertion chain.

**Three bounds, all hard.**

- *The script's deadline.* The wall-clock limit is enforced by a QuickJS
  interrupt handler, and QuickJS only calls it **between bytecode operations** -
  a blocking C function never yields to it. So the request's timeout is clamped
  to whatever is left of the script's budget; without that, a 5s script calling
  `pm.sendRequest` at the default 30s request timeout would hold its thread for
  30s with no error and no way to interrupt it. When `scriptTimeout` is `0`
  there is no budget and nothing to clamp to. A call made with the budget
  already spent is refused by name - `pm.sendRequest was called with none of
  the script's time budget left` - and that sentence is what the script's error
  reports, since the handler never ran and so never stopped anything.
- *A request cap.* One script execution may issue at most **10** requests, then
  throws. A load run's `tests` script runs once per *sampled* response, serially,
  on the run's worker thread, so an uncapped loop would turn post-run validation
  into minutes of apparent hang.
- *A response byte bound.* The fetch reads at most what the enclosing execution
  reads, and **refuses** past it - the callback's `err` says
  `Response is N bytes, over the M byte limit`, and `res` is null. Which
  setting supplies `M` follows the path: a design-mode send's scripts (Send, a
  collection-run step) take `maxDesignResponseBodyBytes`, a load run's deferred
  `tests` script takes `maxResponseBodyBytes`, because a script that runs once
  per sampled response belongs to the run's memory budget rather than to the one
  sized for a body a person is about to look at. Refusing rather than handing
  over a prefix is the deliberate half: `res` has no truncation flag - nor does
  `pm.response` - so a cut body would reach `JSON.parse` as corrupt input with
  nothing to say why. Before issue #1188 this fetch was the one read in the
  engine with no bound at all.

**It leaves the way its execution leaves.** The fetch takes the transport policy
its enclosing execution resolved - the proxy mode and URL, the bypass list, the
custom CA bundle and the client-certificate registry - rather than whatever the
daemon's own environment would pick up. A script that authenticates through
`pm.sendRequest` and then lets the real request carry the session has to take the
same route out of the machine, or one of the two is unreachable behind a
corporate proxy (issue #705). Which policy that is follows the path, as the byte
bound above does: a design-mode send's scripts take the one resolved for that
send, and a load run's deferred `tests` script takes the one the run's own
transfers left by - resolved once when the run starts and kept for it, so a
Settings edit made while the run was in flight cannot send an assertion by a
route the responses it is asserting on never took (issue #1256).

**Not available to agents.** Vayu's MCP target allowlist is checked in the MCP
server, against the composed URL, before it calls the engine - so a script-issued
request never passes that gate. The engine therefore refuses script-issued
requests unless the caller explicitly asks for them (`allowScriptRequests` on
`POST /execute` / `POST /runs`); Vayu's own Send and load runs ask, and the MCP
server never does. Calling it from an agent-started run throws a message saying
so. See [MCP](mcp.md#the-script-sandbox-surface).

The flag is a property of **who asked for the execution**, not of the shape its
answer comes back in: `POST /execute` reads it before it branches on `stream`,
so a streaming send's pre- and post-request scripts are governed by exactly the
bit a buffered send's are (issue #653). Pressing Send with the **Event stream**
setting on and off gives `pm.sendRequest` the same answer.

**`{{variables}}` resolve as the call is made** (#1001). The URL, each header
name and value, a raw body and each credential of an `auth` block are resolved
once, against the three scopes and the bound data row exactly as
`pm.variables.replaceIn` reads them - so a value this same script set two lines
earlier is visible, which is Postman's rule and what makes an imported
token-refresh script work. It is not a second pass over the composed request:
that payload was resolved before the script ran and nothing here revisits it.
A name nothing defines keeps its braces (#1009), and a `{{data.column}}` the
bound row lacks throws naming the column, the same way `replaceIn` does.

Header **names** resolve too (#1067), under the collision rule composition owns
rather than a second one written here (#1051, `http/header_names.hpp`): two
names that resolve to one name would send the request a header short, so the
call throws naming both spellings and the name they produced, and nothing goes
out. Names are compared without case, the way the header map keys them. A name
that resolves to nothing at all is refused the same way, and it is the one thing
resolution can produce that nothing further down the send would catch: the
pre-send gate reads header text for the bytes that break a line, and what is
left of an empty name is the line `: value`, which libcurl sends. This call met
that rule first, a script writing header names of its own; since #1084
composition and the execute-time residual pass refuse it in the same words, so
one wording answers wherever a name is resolved.

```javascript
pm.environment.set("tenant", "acme");
pm.sendRequest(
  {
    url: "{{baseUrl}}/{{tenant}}/token",
    method: "POST",
    auth: { type: "basic", basic: { username: "{{id}}", password: "{{secret}}" } },
  },
  function (err, res) {
    if (err) {
      return;
    }
    pm.environment.set("token", res.json().access_token);
  }
);
```

**`auth` is composed, or refused by name.** The block takes Postman's
`{ type, <type>: params }` shape, with the parameters in either spelling Postman
writes - the exported `[{ key, value }]` array, or a plain object. `basic`,
`bearer` and `apikey` (`in: 'header'` by default, `'query'` for a parameter) go
through `vayu::http::apply_auth`, the engine's one auth composer, so the header
or the percent-encoded query parameter is the one every other send would have
written, and an `Authorization` header the script set itself still wins. Every
other type throws naming it - `oauth2` included, because acquiring its token
needs the database this path deliberately does not carry. So does a type whose
block is not there: `{ type: 'basic' }` with no `basic` beside it, or the key
misspelled, is refused rather than composed as the empty credential `basic`'s two
optional halves would otherwise make of it. Dropping the option would send an
unauthenticated request that looks like the script's own mistake, which is the
reason the body modes are refused too.

## The cookie jar (`pm.cookies`)

```javascript
pm.cookies.get('session');      // value, or undefined
pm.cookies.has('session');      // boolean
pm.cookies.toObject();          // { session: 'abc' }
pm.cookies.each(function (cookie) { console.log(cookie.name); });
pm.cookies.all();               // array of cookie objects
pm.cookies.count();             // number
```

`pm.cookies` is what the engine is holding *for this request's URL* - matched on
domain, path, `Secure` and expiry, exactly as it will be sent. It is what makes
"log in once, reuse the session" work: a `Set-Cookie` on one request is carried
to the next one automatically, with no header to set by hand.

**`each`, `all()` and `count()`** are Postman's CookieList reads, over the same
matched set `get`/`has`/`toObject` answer over - what this request's URL would
carry. Each call reads the jar afresh, so a `jar().set` earlier in the script is
visible by the time one of these runs. `each(fn, context?)` calls `fn` once per
cookie with the whole cookie object (below), `context` becoming the iterator's
`this`; a throw from `fn` - a failed `pm.expect` inside it, most likely - ends
the walk and is the script's error rather than being swallowed. `all()` returns
an array of cookie objects, `count()` the number of them.

A cookie object - what `each`, `all()`, `jar().getAll()` (below) and
`jar().set`'s callback all hand back - carries:

| Field | Value |
|-------|-------|
| `name`, `key` | the cookie's name, under both spellings. Postman's `Cookie` calls it `key`; both are present, same value |
| `value` | the cookie's value |
| `domain`, `path` | where it is scoped |
| `secure`, `httpOnly` | booleans |
| `hostOnly` | `true` when the cookie answers for that host only, `false` when it answers for subdomains too |
| `session` | `true` for a session cookie |
| `expires` | a `Date`, or `null` for a session cookie |

Postman's `maxAge` and its unmodelled `extensions` are deliberately absent: the
jar does not keep them, and a field with nothing behind it is a value a script
would read and act on.

- **One jar per environment**, plus one for requests sent with no environment
  selected. A staging session therefore cannot ride along on a production call
  even when both point at the same host - which cookies alone would not prevent,
  since they ignore the port and the scheme.
- **In memory only**, for as long as the engine runs. Nothing is written to
  disk: a stored jar is credential-grade material. Settings → General → Cookies
  shows every jar and clears them.
- **`pm.sendRequest` shares the jar** of the request it runs inside. A
  pre-request script that logs in through it leaves the session where the real
  request will find it.
- **Load runs have no jar.** Every one of these reads throws there rather than
  answering `undefined`, which would read as "the cookie is gone". The jar is
  deliberately off the load path: sharing one across the event loop's workers
  would put a lock on the hot path, and a load run repeats a single request
  anyway.
- **Writing goes through `jar()`**, below. There is deliberately no flat
  `pm.cookies.set(name, value)`: a written cookie needs a URL to take its
  domain and path from, which is exactly why Postman's write half hangs off
  the jar object.

The jar is libcurl's own cookie engine underneath: matching, expiry and
replacement are its rules, not a second implementation of RFC 6265.

### Writing to the jar (`pm.cookies.jar()`)

```javascript
const jar = pm.cookies.jar();

jar.set(pm.request.url, { name: 'session', value: token });
jar.set(pm.request.url, 'session', token);            // the same, flat
jar.get('https://api.example.com/', 'session');        // value, or undefined
jar.getAll('https://api.example.com/');                 // every cookie that URL would carry
jar.unset('https://api.example.com/', 'session');
jar.clear('https://api.example.com/');                 // that URL's cookies
jar.clear();                                           // this environment's jar
```

Postman's jar object, whole - **`getAll`** is new, Postman's "dump the session"
read: every cookie a request to that URL would carry, as an array, whole. It is
exactly what `get(url, name)` matches, without a name to narrow it - the same
domain/path/`Secure`/expiry rules, the same per-environment jar, and a cookie
this script has already staged with `set` is included. Every method is
**URL-scoped** - it takes the URL the cookie belongs to rather than assuming
this request's (`clear`'s URL is optional; see below) - and each accepts an
optional trailing callback, invoked inline the way
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest)'s is, since
the work has already happened by the time it is called. What the callback
carries, and what the call itself returns, is what that call did - there is no
longer one shape for all five:

| Method | Callback / return |
|--------|--------------------|
| `get(url, name)` | the value, or `undefined` |
| `getAll(url)` | every matching cookie, as an array of cookie objects |
| `set(url, cookie)` | the **stored** cookie object - the one thing this call knows and the script does not, since it carries the domain and path derived from the URL where `cookie` left them out |
| `unset(url, name)` | the removed name |
| `clear(url?)` | `undefined` - there is nothing left to describe |

The cookie object needs `name` and `value`; everything else is optional and
defaults from the URL:

| Field | Default |
|-------|---------|
| `domain` | the URL's host, host-only. A leading dot (`.example.com`) means subdomains too |
| `path` | RFC 6265 default-path - the URL's path with its last segment removed, so `/v1/orders/42` gives `/v1/orders` |
| `secure`, `httpOnly` | `false` |
| `expires` | `0`, a session cookie. Otherwise a `Date`, a date string, or a whole number of seconds since the epoch |

**`expires` takes three spellings**, matching Postman: a `Date`; a date string -
anything JavaScript's own `Date.parse` accepts, an ISO 8601 or an HTTP date; or
a whole number of seconds since the epoch, `0` still meaning a session cookie.
The Date and the string are read by asking QuickJS's own `Date` (`getTime` and
`Date.parse`) rather than a date parser written into the engine, so the answer
here is the one the same script's own `new Date(s)` would give. Because a
stored cookie reads back with `expires` as a `Date` (above), and `set` now
takes a `Date`, a cookie can be read and written back with nothing to convert.

Anything else is refused with an error rather than guessed at: a non-string
`value`, a `secure: "yes"`, a field carrying a tab or newline (the separators
of the format the jar stores), or a URL that cannot be parsed. `expires` has
its own refusals, loud ones: an Invalid Date, a string `Date.parse` cannot
read, a **fractional** number of seconds - `date.getTime() / 1000` without the
floor, which the message names both cures for (pass the `Date` itself, or keep
the `Math.floor`) - a value before the epoch, and one further in the future than
the jar can store. A cookie stored under the
wrong domain reads as "the session did not stick" three requests later, which
is a much worse afternoon than a thrown error.

**A written cookie is matched by the same rules a received one is.** Setting it
for one host does not send it to another, `/admin` does not reach `/`, and the
jar's per-environment isolation holds - the write half is not a way around the
matching the read half respects.

**When the write takes effect.** A write is *staged*, not applied where it is
made, and the next transfer of that execution carries it:

- A `set` in a **pre-request script** rides the request it was made before, and
  that request's own cookie capture is what writes it into the jar. It cannot
  be discarded by that capture, which is the reason for the ordering: the
  engine replaces a scope's contents with what the finishing transfer held, so
  a write dropped into the jar beside an in-flight request would vanish with it.
- A `set` followed by **`pm.sendRequest`** is carried by that auxiliary
  request. A `set` *inside* a `sendRequest` callback is a sequential write -
  `pm.sendRequest` is synchronous, so the callback runs after its transfer
  finished and the write lands on the next one.
- A `set` in a **post-request script** has no transfer left to ride, so it is
  applied to the jar when the script ends.

`unset` and `clear` are staged by the same rule and on the same queue - the
bullets say `set` because it is the one that reads as immediate, not because
the other two are. So `jar.clear(url)` followed by `jar.getAll(url)` in one
script sees the clear, because a read is answered over the staged writes as
well as the jar; the stored jar itself is not emptied until that execution's
next transfer carries the write.

**`clear` has two forms.** `clear(url)` is Postman's: it removes every cookie a
request to that URL would have carried - `unset` with no name to narrow it, and
the same matching, so a cookie stored for another host or under `/admin` when
you cleared `/` is left alone. `clear()` with no URL empties **this
environment's jar and no other**. Nothing is on disk either way, so the cost is
a re-login; other environments, and the no-environment jar, are untouched.
There is no confirmation gate for scripts - "reset my session" is a legitimate
thing for a script to want, and Settings → General → Cookies shows the result.

A URL the engine cannot parse is **refused** rather than cleared as a wipe that
happens to match nothing: `clear` is destructive, so "cleared no cookies" and
"that was not a URL" must not read the same to the script. Pass no argument at
all for the whole-jar form.

Load runs have no jar, so these throw there exactly as the read half does.

## Flow control (`pm.execution`)

Inside a collection run (`POST /runs` with a `scenario` block), a script can say
where the sequence goes next:

```javascript
pm.execution.setNextRequest('Checkout');  // run that request next, after this one finishes
pm.execution.setNextRequest(pm.info.requestId); // the same jump, by id
pm.execution.setNextRequest(null);        // end this iteration; the next one still runs
pm.execution.setNextRequest('null');      // the quoted form Postman reads the same way
pm.execution.skipRequest();               // pre-request only: do not send this request
```

**The script records an intent; the runner acts on it.** Neither method reaches
into the run - they set a value on the script's result, and the runner, the only
thing that knows what a sequence is, reads it once the step has finished. So
`setNextRequest` does not abort the current request: it completes, its tests run,
and the jump happens afterwards. The last call in a script wins, across the
pre-request and test scripts alike.

`setNextRequest` takes a request's **name** or its **id** - the one a script
reads off `pm.info.requestId` - never its URL, and jumping backwards is allowed:
that is how a retry loop is written. A target is resolved against the names
first and the ids second, so a request whose *name* happens to be another
request's id sends the jump to the request you can see in the sidebar.

The string `'null'` is the stop form, exactly as the real `null` above is -
Postman's runner reads it that way, and the quoted spelling is common in
collections written against it. The one exception is a run that carries a
request actually **named** `null`: a name the run carries is the more specific
answer and wins, so that request stays reachable.

### Where it throws

Every one of these is a thrown error naming the reason, not a call that is
accepted and quietly dropped. A binding that cannot fail is worse than a missing
one: `setNextRequest('checkout')` ignored in a single send is a script that
reports success for something that never happened.

| Call | Where | What happens |
|------|-------|--------------|
| Either method | A single Send (`POST /execute`) | Throws - there is no next request |
| Either method | A load run's deferred `tests` script, and a scenario load run's deferred per-step script | Throws - the script runs after the run finished, against a recorded response, and cannot redirect a sequence that already happened |
| `skipRequest()` | A test script inside a collection run | Throws - the request has already gone out; there is nothing left to skip |
| `setNextRequest()` | Anywhere | `TypeError` - the argument is required. Omitting it is not a synonym for `null` |
| `setNextRequest(3)`, `setNextRequest('')` | Anywhere | `TypeError` - a target is a non-empty string, or `null` |

### Where the step fails instead

Two cases are the runner's to refuse, because only it can see the plan. Both end
the iteration with the step marked `errored` and the reason in its row:

- **A target no request in the run answers to**, by name or by id. The message
  names the target and says both were searched.
- **A name two or more requests share.** The message names every step that
  answers to it, so the fix - rename one - is obvious. Resolving to the first
  match would run a sequence nobody asked for.

### The cycle bound

`setNextRequest` makes an infinite loop a two-line script, so an iteration has a
ceiling: **`maxStepsPerIteration`** (config, `limits`). Its default of
`0` derives the bound from the collection - ten times its request count, and
never fewer than 100 - so a straight-through iteration can never trip it, and a
legitimate retry loop in a short collection has room. Exceeding it fails that
step with a message naming the steps that were looping; the run continues with
the next iteration and still reaches a terminal status.

### Skipped is never passed

A skipped step is stored and reported as `skipped` - its own count in the run
summary, its own outcome on the step's `results` row and on the SSE `step` event.
Its row carries the request it would have sent and **no response**, because there
was none; the app's step list shows that rather than an empty `200`.

## Data rows (`pm.iterationData`)

A run can be given a set of rows - a CSV, TSV, JSON or JSONL file the app parses
and sends inline on the run payload ([the file
format](../app/data-driven-runs.md)). A collection run states them as
`scenario.data` and a single-request load run as the top-level `data` (issue
#993). **Row `i % rows` binds to iteration `i`** - for a single request an
iteration is one submission - and that row is what `pm.iterationData` reads:

```javascript
pm.iterationData.get('username');  // this iteration's value for that column
pm.iterationData.has('coupon');    // whether the row carries that column
pm.iterationData.toObject();       // the whole row as a plain object
```

`get` on a column the row does not carry returns `undefined`, as every other
`pm` scope reader does. Values keep their JSON type: a JSON file's `3` arrives
as a number, and a CSV column arrives as a string, because that is what the
file said.

**The row reaches a request through a different channel, with a different type
story.** `pm.iterationData` hands a script the cell as the value it is - a
number stays a number, a `null` stays `null`, and a branch can read either.
`{{data.column}}` (see
[api-reference.md](api-reference.md#scenario-runs)) hands
the *request* the cell as **text**, because a URL, a header and a body are text;
its type only survives where the surrounding document has types of its own,
which is why placement inside or outside a JSON string literal is what decides
whether `{{data.n}}` arrives as `2` or `"2"`. The two also disagree about
`null` on purpose: a script may branch on it, while a token that substituted it
would write nothing where a value belonged, so the bind errors instead. An
optional column belongs on this side of the line.

`has` answers presence, the same way `pm.environment.has` and its siblings do.
A column whose value is `null` is `true` - the row carries it - which is the
fact `get` alone cannot state without the reader knowing that an absent column
comes back as `undefined` while a null one comes back as `null`.

**A single send can bind one row too** - `POST /execute` takes an optional
`data` object (one row, not the array a run sends), which is what the request
builder's **Send with row** does and what MCP's `run_request` exposes as `data`.
Both scripts then read it as `pm.iterationData`, and `pm.info.iteration` is `0`
with `pm.info.iterationCount` `1` - the send *is* row 0 of 1. This is how a
script that reads a row gets an edit loop that is not "start a run, find the
step, read the result"; the row binds `{{data.column}}` in the request as well.
See [api-reference.md](api-reference.md#post-execute).

**`pm.iterationData` is `undefined` where there is no row** - an ordinary Send,
and any run started without a data set. Where a run *was* given rows, its
deferred script reads one whichever shape the run took: a sampled response
carries the row the submission or iteration that produced it was bound to, so
the row is a fact about that response rather than a guess. (`pm.info.iteration` and
`pm.info.vu` travel the same way and are populated on both shapes since issue
#994 - what a sample carries is the identity its submission claimed before it
was sent, never its position in a reservoir.) That is deliberate, and it is the opposite treatment to `pm.execution`
above: flow control is a *capability*, and one that silently does nothing is a
false success, so it is always bound and explains itself. A data row is *data*,
and "this run is not data-driven" is a fact a script may legitimately branch on:

```javascript
const user = pm.iterationData ? pm.iterationData.get('username') : 'default-user';
```

A stashed reference (`globalThis.saved = pm.iterationData`) read from a later
script throws rather than answering with the finished run's row.

**To put the row into the request itself, use `{{data.column}}` - or, while a
row is bound, the bare column name - instead.** A script reads
`pm.iterationData` *after* its step's request was composed, so it cannot
change where the request goes without editing `pm.request` by hand. The
reserved `data.*` namespace does that directly: a URL, header, body, form field
or **credential** carrying `{{data.email}}` has it substituted with the
iteration's row immediately before the send. It is a namespace, not a variable
scope - it cannot be read or written through `pm.variables` - and it is
documented under
[Scenario runs](api-reference.md#scenario-runs). **A bare `{{email}}` binds the
same way while a row is bound** (issue #1007), and unlike the prefixed
spelling it *is* readable through `pm.variables.get("email")` too - see
[`pm.variables`](#variables-pmvariables) above.

The substitution is written for the place it lands in: a token inside a JSON or
XML body is escaped for that document, and a cell carrying a line break bound
into a **header** - a header name, a header value, or a credential written into
a header line - is refused rather than allowed to end the header line and forge
one of its own.

### It is read-only

`set`, `unset` and `clear` are bound and **throw**. The rows are an input to the
run, not a variable scope: there is no destination a write could land in, the
next iteration binds a different row regardless, and accepting the value would
report success for something that vanished. Carry a value forward with
`pm.environment`, `pm.collectionVariables` or `pm.globals`.

### How many iterations, and which row

With `data` present and `iterations` absent, the run performs **one iteration per
row** (Postman's default). With both given the explicit count wins and the row
index wraps - five iterations over three rows read rows 0, 1, 2, 0, 1.

The wrap is not silent: every step's `results` row and every `step` SSE event
carries **`dataRowIndex`**, and the app's step list shows it beside the iteration
("Iteration 4 · Row 1"). `pm.info.iteration` reports the pass; `dataRowIndex`
reports the row, and with a wrap the two deliberately disagree.

Rows are validated before the run row exists: a `data` that is present and empty,
a row that is not an object (the message names its index), or a set over
`maxScenarioDataRows` is a `400`. Rows are never persisted - the run's snapshot
records `dataRowCount` and nothing else.

## Console Output

Log messages that appear in test results:

```javascript
console.log('Response:', pm.response.json());
console.info('Info message');
console.warn('Warning message');
console.error('Error message');
```

Objects and arrays are pretty-printed with `JSON.stringify(value, null, 2)`
rather than `[object Object]`; a value that cannot be serialized (a circular
reference, say) becomes `[Object: unserializable]`.

**The level travels with the line.** Each entry on the wire is
`{ "source": "pre" | "test", "level": "log" | "info" | "warn" | "error",
"message": "..." }` - see
[`consoleLogs` in the API reference](api-reference.md#post-execute). The four
methods are bound to one C function distinguished by QuickJS's `magic`
argument (`setup_console`), so the level is captured at the call; it cannot be
recovered from the text afterwards, which is why it used to be lost. The app's
Console tab draws `warn` and `error` in their status tokens and labels every
non-`log` line in a gutter.

## Examples

### Validate JSON Response

```javascript
pm.test('User has correct fields', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
  pm.expect(json.email).to.include('@');
});
```

### Check Status Codes

```javascript
pm.test('Success response', function() {
  pm.expect(pm.response.code).to.be.below(400);
});
```

### Set Variables from Response

```javascript
// Extract token from response and save to environment
const json = pm.response.json();
pm.environment.set('userId', json.id);
pm.environment.set('token', json.token);
```

### Pre-request Script

Modify request before sending:

```javascript
// Add timestamp and correlation headers
pm.request.headers['X-Timestamp'] = Date.now().toString();
pm.request.headers['X-Request-Id'] = 'req-' + Math.random().toString(36).slice(2, 10);
```

Both headers are on the request that is actually sent - see
[Mutating the request](#mutating-the-request-pre-request-scripts) for the rules
and [Worked examples](#worked-examples-rewriting-a-request) for harder cases.

### Response Time Assertion

```javascript
pm.test('Response time is acceptable', function() {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});
```

### Array Validation

```javascript
pm.test('Returns array of users', function() {
  const users = pm.response.json();
  pm.expect(users).to.be.an('array');
  pm.expect(users.length).to.be.above(0);
  pm.expect(users[0]).to.have.property('id');
});
```

### Header Validation

```javascript
pm.test('Has Content-Type header', function() {
  pm.response.to.have.header('Content-Type');
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');
});
```

## Worked examples: rewriting a request

Everything below runs in a **pre-request** script and changes what goes on the
wire. The rules these rely on are in
[Mutating the request](#mutating-the-request-pre-request-scripts); read the
[sandbox note](#what-a-script-can-compute) first if you are here to sign a
request, because what is missing decides the shape of most of these.

### Rewrite a JSON body, then fix the headers that describe it

The body is a string in and a string out, so a structural edit is
parse - mutate - stringify. Anything derived from the body (a length, a digest,
a checksum) has to be computed *after* the edit, or it describes the old one.

```javascript
var body = JSON.parse(pm.request.body.raw);
body.metadata = { client: 'vayu', sentAt: new Date().toISOString() };
delete body.debugOnly;
pm.request.body.raw = JSON.stringify(body);

// Recomputed from the final body, not the original.
pm.request.headers['Content-Length'] = String(pm.request.body.length);
```

`Content-Length` is illustrative - libcurl sets it from the body it is given, so
you do not need to. Any header you derive yourself works the same way.

### Add or replace a query parameter

`pm.request.url.query` reads the parameters; the write is the whole URL, so
rebuild the query string and assign it back.

```javascript
function withQueryParam(url, name, value) {
  var pair = { key: encodeURIComponent(name), value: encodeURIComponent(value) };
  var kept = url.query.all().filter(function (p) { return p.key !== pair.key; });
  kept.push(pair);

  var query = kept
    .map(function (p) { return p.value === null ? p.key : p.key + '=' + p.value; })
    .join('&');

  return url.protocol + '://' + url.getHost() + (url.port ? ':' + url.port : '') +
    url.getPath() + (query ? '?' + query : '') + (url.hash ? '#' + url.hash : '');
}

pm.request.url = withQueryParam(pm.request.url, 'traceId', 'run-' + Date.now());
```

### Switch method and body together

Changing the verb and the payload in one script is fine - the write-back applies
all of it or none of it, so the request never goes out as a POST that still
carries the GET's shape.

```javascript
if (pm.environment.get('mode') === 'bulk') {
  pm.request.method = 'POST';
  pm.request.url = pm.request.url.replace('/items/1', '/items/bulk');
  pm.request.body = JSON.stringify({ ids: [1, 2, 3] });
  pm.request.headers['Content-Type'] = 'application/json';
}
```

Two edges worth knowing. A **HEAD** request that carries a body is refused by
the send path with a clear error rather than silently stripped, so do not switch
to HEAD without also `delete pm.request.body`. And a body set on a request that
had none is sent as raw text - Vayu does not infer a `Content-Type`, so set it
yourself as above.

### Replace engine-applied auth with a custom scheme

Auth is resolved into the request *before* the script runs, so the script sees
the real header and has the last word. Removing and re-adding is how you swap
schemes rather than stack them.

```javascript
delete pm.request.headers['Authorization'];
pm.request.headers['X-Api-Key'] = pm.environment.get('apiKey');
```

**Use the exact name, capitals included.** `pm.request.headers` is a plain JS
object, and JS property names are case-sensitive, so
`delete pm.request.headers['authorization']` deletes nothing and the header
survives - even though HTTP itself treats the two as one name. The engine
applies auth as `Authorization`. When in doubt, look before you delete:

```javascript
Object.keys(pm.request.headers).forEach(function (name) {
  if (name.toLowerCase() === 'authorization') delete pm.request.headers[name];
});
```

For the same reason, **do not leave two names that differ only in case** -
setting `authorization` while `Authorization` is still there is two JS
properties but one HTTP header, so the write-back rejects it rather than
picking a winner, and the request is sent unchanged with the reason in
`preScriptError`.

### Sign a request

`pm.crypto` gives a pre-request script a real HMAC, so the request it rewrites
can be signed for what it actually became:

```javascript
var timestamp = Date.now().toString();

// The sorted-query canonicalization every HMAC scheme wants. `all()` is the
// view that keeps duplicates and wire-order values, so what is signed is what
// was sent.
var sortedQuery = pm.request.url.query.all()
  .map(function (p) { return p.key + '=' + (p.value === null ? '' : p.value); })
  .sort()
  .join('&');

var canonical = [
  pm.request.method,
  pm.request.url.getPath(),
  sortedQuery,
  timestamp,
  pm.request.body || ''
].join('\n');

pm.request.headers['X-Timestamp'] = timestamp;
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);
```

Note the ordering: the canonical string is built from `pm.request` *after* the
other edits, so it covers what is actually sent. If you sign first and rewrite
the body second, the signature describes a request that never existed.

**Signatures compared as base64** - Shopify's, for instance - only need a
different last argument:

```javascript
pm.request.headers['X-Signature'] =
  pm.crypto.hmacSha256(pm.environment.get('secret'), canonical, 'base64');
```

#### Derived signing keys (AWS SigV4)

A scheme that chains HMACs cannot be expressed with text output alone: each
round is keyed by the **raw digest** of the previous one, and hex or base64 is a
different byte string. That is what the `'bytes'` encoding is for - it returns a
`Uint8Array`, which is also accepted as a key or as data:

```javascript
var secret  = pm.environment.get('aws_secret_key');
var date    = '20150830';

var kDate    = pm.crypto.hmacSha256('AWS4' + secret, date, 'bytes');
var kRegion  = pm.crypto.hmacSha256(kDate, 'us-east-1', 'bytes');
var kService = pm.crypto.hmacSha256(kRegion, 'iam', 'bytes');
var kSigning = pm.crypto.hmacSha256(kService, 'aws4_request', 'bytes');

// stringToSign is built per the SigV4 spec, hashing the canonical request with
// pm.crypto.sha256(canonicalRequest) - hex, which is what the spec asks for.
pm.request.headers['Authorization'] =
  'AWS4-HMAC-SHA256 Credential=…, Signature=' +
  pm.crypto.hmacSha256(kSigning, stringToSign);
```

#### What is hashed

A string contributes its **UTF-8** bytes - the same bytes the engine puts on the
wire, so a digest computed here matches one computed by `sha256sum` over the
same text. A `Uint8Array` contributes its bytes unchanged; that is the only way
to key an HMAC with bytes that are not valid UTF-8. Passing anything else (an
object, a number, `null`) throws rather than being stringified: hashing the text
`[object Object]` would return a digest that looks perfectly valid.

### Hand a value to the test script

A pre-request script and its test script share the variable scopes, not their
local state. Stash what the assertion needs:

```javascript
// Pre-request
var nonce = 'n-' + Math.random().toString(36).slice(2);
pm.request.headers['X-Nonce'] = nonce;
pm.environment.set('lastNonce', nonce);
```

```javascript
// Tests
pm.test('server echoed our nonce', function () {
  pm.expect(pm.response.headers['x-nonce']).to.equal(pm.environment.get('lastNonce'));
});
```

### What a script can compute

The sandbox is QuickJS plus `pm`, `console`, and the two base64 globals.
Available: `JSON`, `Date`, `Math`, `RegExp`, `String`, `Array`, `Object`,
`Number`, `Uint8Array`, `Promise`, `BigInt`, `encodeURIComponent`, `parseInt`
and the rest of the ES2020 built-ins, plus:

| Name | Shape |
| ---- | ----- |
| `pm.crypto.sha256(data, encoding?)` | SHA-256; `data` is a string (UTF-8) or `Uint8Array` |
| `pm.crypto.hmacSha256(key, data, encoding?)` | HMAC-SHA256; key and data take the same types |
| `pm.sendRequest(urlOrOptions, callback)` | Send an auxiliary request, synchronously - see [above](#sending-a-request-from-a-script-pmsendrequest) |
| `btoa(binaryString)` | base64-encode one byte per code unit |
| `atob(base64)` | decode to a binary string; throws on invalid base64 |

`encoding` is `'hex'` (the default), `'base64'`, `'base64url'` or `'bytes'`;
`'bytes'` returns a `Uint8Array`, and any other value throws rather than
silently falling back to hex.

**Not** available: `crypto` / `crypto.subtle`, `TextEncoder`, `URL`,
`URLSearchParams`, `setTimeout`, `require`, `fetch`. The practical
consequences: no general URL constructor - the request's own URL is already
parsed for you, see [URL parts](#url-parts-pmrequesturl) - no hash
other than SHA-256 (no MD5, no SHA-1, nothing asymmetric), and nothing
asynchronous. There is no `fetch`, but there **is**
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest), which is
synchronous and bounded rather than a Promise-returning stand-in.

**Why the hashing surface is not called `crypto`.** Web Crypto's `crypto.subtle`
is Promise-based. `Promise` exists here, but nothing drains the job queue - there
is no event loop and no `setTimeout` - so an `await crypto.subtle.digest(...)`
would never resume and the script would report a timeout rather than a result.
Vayu therefore takes a name of its own and is honestly synchronous. `btoa` and
`atob` keep their standard names because they are synchronous on the web too,
and they keep the rest of their semantics with them: they operate on **binary
strings**, one byte per code unit, so `btoa` throws on a code point above U+00FF
rather than silently UTF-8 encoding it.

Both halves of this list are pinned by tests in
`engine/tests/script_engine_test.cpp`, so if a global is ever added or removed
this section is what needs rewriting.

## What the editor offers, and where it comes from

Everything the script editor advertises - completions, hover documentation and
the insertable templates listed under the editor - is generated by the engine
and served at `GET /scripting/completions`
(`engine/src/http/routes/scripting.cpp`). There is no second list in the app,
which is why a member documented here and offered there cannot drift apart.

An entry whose `kind` is `28` is a **template** rather than a member, and it
carries two fields no other entry does:

| Field | Values | What it decides |
|-------|--------|-----------------|
| `context` | `pre`, `test`, `both` | Which script kind the template belongs in. A template that reads `pm.response` is `test`, because a pre-request script has no response to read; one that writes `pm.request` is `pre`, because a test script's writes go nowhere. |
| `group` | `Variables`, `Request`, `Response`, `Tests`, `Signing`, `Logging` | The heading it is listed under. |

The app's snippets surface under each script editor is built from those two:
it shows the templates for the editor it sits under, grouped by heading, and
inserts one at the cursor with its `${1:placeholders}` intact. Adding a
template to the table is therefore all it takes to offer it in the app - see
[`pm-api-compatibility`](../app/pm-api-compatibility.md#editor-autocomplete)
for the payload itself.

## Limitations

The **language** is current; what is missing is the **host environment**:

- **Modern syntax works.** Optional chaining (`?.`) and nullish coalescing
  (`??`) are ES2020 and supported, as are later additions like
  `Array.prototype.at`, `Object.hasOwn` and `String.prototype.replaceAll`. This
  section used to say the opposite, listing `?.` and `??` as "ES2021+" and
  unavailable - wrong on both counts, so any workaround written around that
  claim can go. What limits a script is the global list above, not the syntax.
- **No host globals**: no `setTimeout`, `fetch`, `URL`, `TextEncoder`,
  `structuredClone` or `crypto.subtle` - see the table above for what replaces
  the ones that have a replacement.
- **No Node.js APIs**: No `require()`, `fs`, `http`, etc.
- **Sandboxed**: No filesystem access. The only network access is
  [`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest) - capped at
  10 requests per script, bounded by the script's own deadline and by the
  response byte bound its path reads, and refused outright for agent-started
  runs.
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script (default), enforced by a wall-clock deadline - an
  infinite-loop script is aborted and reported as an error rather than hanging the
  engine. Configurable via the `scriptTimeout` setting (milliseconds); `0` disables
  the limit. The deadline is checked *between bytecode operations*, so it cannot
  interrupt a blocking call - which is why `pm.sendRequest` clamps its own
  timeout to the budget that is left rather than relying on it. **A script is
  reported as timed out when the deadline actually stopped it**, not whenever
  its error happens to land past the deadline: a script that throws its own
  error at the buzzer reports *that* error, and `pm.sendRequest` refusing a
  spent budget reports its own sentence rather than a generic timeout line.
  A function an
  assertion calls - `pm.expect(fn).to.throw()`, `.to.satisfy(fn)` - is stopped
  by the same deadline, and that is **reported as the abort it is**, never as a
  satisfied assertion: the engine stopped `fn`, `fn` did not throw. Inside a
  `pm.test` that is a failed test, since `pm.test` reports what its callback
  threw; outside one it ends the script. A later assertion in the same script is
  still judged on its own, and a stack overflow inside such a function is a
  `RangeError` the script could have caught, so that still counts as a throw.

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` - method, url, headers and body - and the edits are
  applied to the request that is sent
  ([rules](#mutating-the-request-pre-request-scripts))
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Cannot access `pm.response` (request hasn't been sent yet)
- `pm.info.eventName` is `"prerequest"` here
- Run in Design Mode / Send only, not in load tests

### Test Scripts (Post-request)

- Execute after receiving the HTTP response
- Can access `pm.request` (read-only here - it has already been sent) and `pm.response`
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- `pm.info.eventName` is `"test"` here
- Test results are included in the response

### Load Test Scripts

- Test scripts in load tests are executed **deferred** (after test completion)
- Only a sample of responses are validated: 1 in `response_sample_rate`
  completions, retained up to `max_response_samples`. The retained set is a
  **uniform sample of the whole run**, not its opening - past the bound a later
  response displaces a uniformly chosen incumbent, so a target that starts
  failing halfway through is graded on those failures rather than on the healthy
  window before them
- A second bound applies to the same store: `max_response_sample_bytes`
  (`maxResponseSampleBytes`, 256 MiB by default) is the whole-run budget for the
  retained bodies, because each is kept **whole** and a target answering 1 MiB
  responses would otherwise put ~1 GB in that store. Past it a sample is dropped
  entire rather than truncated - a script reading a cut body would fail a
  response the target got right - and the drop is counted the same way, in
  `sampling.responseSamplesDropped`
- **A run that spends that budget is graded on the part of it that fit**, not on
  a uniform sample: the count cap displaces incumbents and stays uniform, while
  an exhausted byte budget simply stops admitting. Only a target whose retained
  bodies average more than ~256 KiB reaches it at the defaults; raise
  `maxResponseSampleBytes`, or lower `max_response_samples` so fewer, later
  responses share the budget, if that matters for the run you are grading. The
  report says which one happened: `sampling.responseSampleBudgetSpent`
- `samplesTested` in the report (`TestsSampled`) is the **size of that sample**,
  not the run's request count, and `sampling.responseSamplesDropped` beside it
  says how many responses the bound thinned away
- Results are aggregated and reported in the final report
- `pm.info` reports the same identity a Send does: `eventName` is `"test"`, and
  `requestId` / `requestName` are the run's linked request when it has one. It
  also reports `iteration` - the index the sampled submission claimed before it
  was sent - and `vu`, which is `1` here because a single request repeated is
  one user's iterations (issue #994; see [`pm.info`](#script-identity-pminfo))
- `POST /runs`'s `tests` field carries the collection chain's test scripts as
  well as the request's own, composed the same way as `POST /execute` (see
  [Script Parts](#script-parts) below) - a collection-level assertion is now
  checked under load, not only in design mode

**All three variable scopes are readable, and none of them is written back.** A
deferred replay reads the run's own environment (the `environmentId` the run was
started with), the globals, and the collection chain - the leaf plus its
ancestors, exactly as a Send does, so an inherited name answers the same in both
modes. A scenario load run's collection scope is the collection being *run*; a
single-request run's is the collection of its linked request. Earlier engines
bound an empty environment and no other scope at all, so
`pm.environment.get('region')` read `undefined` under load and the same test
gave opposite verdicts on Send and under load.

Writes are the deliberate exception. A `set()`, `unset()` or `clear()` in a
deferred script is visible to the samples replayed after it - one set of scopes
serves the whole pass - but **nothing is persisted**: only design mode writes
variables back. A sampled response is not an iteration, so there is no ordering
under which "whichever replay ran last wins" would be a defensible thing to
store. If a load run's scripts must leave a value behind, write it in design
mode instead.

**A scenario load run validates per step instead.** It has no run-level `tests`
field: each plan step carries its own post-request script, and after the run
drains each is replayed against the responses *that step* produced. The tallies
land on `scenario.steps[].tests` in the report - a whole-run pass/fail count
over a sequence says something failed, not which step - while the aggregate
still appears as `testValidation`. Three differences from the single-request
shape:

- `pm.request` is the step's own request, and `pm.info.requestId` /
  `requestName` are that step's, not a run-level one.
- `pm.info.iteration` is the virtual user's own iteration index and
  `pm.info.vu` is that user's number, so a script can tell two users' responses
  apart - beside the `pm.iterationData` a single-request run's rows also
  provide, so a script asserting on `{{data.*}}`-driven behaviour grades the
  right row either way.
- The sample budget is split across the steps that carry a script rather than
  spent run-wide, so the last step of a long plan is validated instead of being
  crowded out by the first. A step with no script is never sampled.

`pm.execution` still throws throughout - a deferred script cannot redirect a
sequence that already happened - and no step script runs inline.

## Script Parts

A script's effective source is composed of parts: the collection chain's own
script, then the request's own script, in that order. Each route accepts its
own field(s), each in either of two forms:

- `POST /execute` takes `preRequestScript` / `postRequestScript` (legacy
  single string, already-joined text) or `preRequestScripts` /
  `postRequestScripts` (a list of parts). The load path (`POST /runs`) does not
  read either of these two keys.
- `POST /runs` takes `tests` (the deferred validation script), either as a
  legacy single string or as a list of parts. `POST /execute` does not read
  `tests`.

A list of parts is an array of objects, each recording where it came from -
`{ "origin": "collection" | "request", "id": "...", "name": "...", "script":
"..." }` - so a stored run can say which part is whose.

When both the list and the legacy string are sent for the same field, **the
list wins**; they are never merged. Parts that are empty or only whitespace are
dropped.

**The parts are joined with a blank line (`"\n\n"`) and run as a single script
in one shared JavaScript scope** - one call to the script engine per field
(`engine.execute()` for `preRequestScript(s)` / `postRequestScript(s)`,
`engine.execute_test()` for `tests`), not one call per part. That means a
`const` or `let` declared in the collection's part is visible to the
request's part, exactly as if one person had typed the whole thing into one
editor. It also means a syntax error's reported line number is counted from
the start of the joined text, not from the start of whichever part actually
has the mistake.

## Error Handling

Script errors are caught and reported:

```javascript
// If script throws, error is captured
try {
  const json = pm.response.json();
} catch (e) {
  // Error is reported in test results
}
```

Test failures don't stop script execution - all tests run and results are collected.

## Best Practices

1. **Use descriptive test names**: `pm.test('Status code is 200', ...)`
2. **Validate structure before accessing**: Check if JSON exists before accessing properties
3. **Use environment variables**: Store sensitive data in environments, not scripts
4. **Keep scripts simple**: Complex logic should be in your application code
5. **Log debugging info**: Use `console.log()` to debug script issues

## API Reference

For complete API documentation, see the [Scripting Completions API](api-reference.md#scripting) which lists all available `pm.*` functions and properties.
