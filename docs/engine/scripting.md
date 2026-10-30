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
its collection-run step from either script. **Every level asserts too**: the
collection's and each folder's scripts run before the request's own, and every
level's assertions are listed, each naming its level in `scope`
(`"collection"`, `"folder"` or `"request"`, #2522), so a collection-level
`pm.test` that fails fails the step even when the request's own tests pass.

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
divergence: Postman genuinely waits.** Vayu judges a done-style test when its
callback returns; a `done()` left for later (in a `.then`, or after an
`await`) runs only when the job queue drains after the script, once the row is
already written. A callback that declares `done` and returns without calling
it therefore **fails**, saying so - rather than being reported on a verdict
nothing ever gave. Calling `done()` twice is refused for the same reason the
first verdict is kept: the second call throws, and the throw fails the test
naming what happened.

**An `async` callback's test passes when it returns, as in Postman** (issue
#2531). postman-sandbox records the row without awaiting the promise, and so
does Vayu. What the promise does afterwards is still reported: the job queue is
drained before the script's results are read, so the code after an `await`
runs, and a rejection nothing handles is a **script error** on the step,
`Unhandled promise rejection in test "<name>": <reason>`, with the reason
written as a thrown error would be (an `AssertionError`'s message included). A
test's promise still pending after the drain can never settle, and is reported
as `A promise did not settle before the script ended (returned by test
"<name>")`. The same applies outside a test: `(async () => { throw new
Error("x"); })();` ends as `Unhandled promise rejection: Error: x`, while a
rejection the script catches, before or after it settles, is no error.

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
// fails with: user 42: Expected false to be true
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
because chai's is a property of the `chai` module rather than a global. The
shelf's [`require('chai')`](#chai) is that module, a separate object from
`pm.expect`, so a `pm.expect` failure is not an instance of
`require('chai').AssertionError`; test `e.name`. The same name comes off the
[response assertions](#response-assertions), which are chai in Postman too,
whether they are written `pm.response.to.have.status(200)` or as
`require('chai').expect(pm.response).to.have.status(200)` (the second forwards to
the first, so the error is the same native one, and not an instance of
`chai.AssertionError` either).
**A mistake in the script text is still a `TypeError`** - a matcher called with
no argument, a name nothing implements - because nothing was asserted: the call
itself was wrong.

**Anything the chain does not implement throws, called or not** (issue #999).
`pm.expect(x).to.be.NaN` is an expression statement, so before the chain was
armed a member nothing implemented evaluated to `undefined` and the test
reported PASS whatever the value was - a typo (`.to.be.trueish`) and a chai
member Vayu does not have (chai-postman's `.postmanResponse`)
were equally silent. Every unimplemented name now raises a `TypeError` naming
itself, the way `pm.response.to` has since #487. That holds for a name read off
a matcher or a chainable method too (#2528): a matcher is a call, so
`.within.foo` and `.equal.name` are refused, and after `include`, `length` or
`a` only the chain's own members resolve, so `.include.name` and `.a.foo` are
refused rather than answering a function's own `name` or `undefined`.

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
pm.expect(value).to.equal(expected);         // strict (===); aliases .eq, .equals
pm.expect(value).to.eql(expected);           // deep; alias .eqls
pm.expect(value).to.deep.equal(expected);    // same as .eql
pm.expect(value).to.be.oneOf([a, b]);
pm.expect(value).to.be.closeTo(expected, delta); // alias .approximately

// Booleans and existence (paren-less: accessing them asserts)
pm.expect(value).to.be.true;                 // strict: the boolean true, not 1 or 'true'
pm.expect(value).to.be.false;                // strict: the boolean false, not 0, '' or null
pm.expect(value).to.be.null;
pm.expect(value).to.be.undefined;
pm.expect(value).to.be.ok;                   // truthy (any value JavaScript reads as true)
pm.expect(value).to.be.empty;
pm.expect(value).to.exist;                   // alias .exists
pm.expect(value).to.be.NaN;
pm.expect(value).to.be.finite;               // a number, and finite: '1' is not
pm.expect(value).to.be.arguments;            // a function's own `arguments`; alias .Arguments
pm.expect(value).to.be.extensible;           // what Object.isExtensible answers
pm.expect(value).to.be.sealed;               // Object.isSealed
pm.expect(value).to.be.frozen;               // Object.isFrozen

// Numbers (a number or a Date on both sides - nothing is coerced)
pm.expect(value).to.be.above(n);             // aliases .gt, .greaterThan
pm.expect(value).to.be.below(n);             // aliases .lt, .lessThan
pm.expect(value).to.be.at.least(n);          // aliases .gte, .greaterThanOrEqual
pm.expect(value).to.be.at.most(n);           // aliases .lte, .lessThanOrEqual
pm.expect(value).to.be.within(start, finish); // both bounds are in

// Types
pm.expect(value).to.be.a('string');
pm.expect(value).to.be.an('array');          // also 'date', 'regexp', 'map', 'set', 'error', ...
pm.expect(value).to.be.an.instanceof(Array); // .a / .an also read as words
pm.expect(value).to.be.instanceOf(Array);    // alias .instanceof

// Strings, collections and objects
pm.expect(value).to.include(item);           // aliases .includes, .contain, .contains
pm.expect(value).to.include({ a: 1 });       // an object target: subset match
pm.expect(value).to.have.own.include({ a: 1 });          // own properties only
pm.expect(value).to.nested.include({ 'a.b[0].c': 1 });   // each key is a path
pm.expect(value).to.have.string(substring);  // string target only
pm.expect(value).to.match(/regex/);          // alias .matches
pm.expect(value).to.have.length(n);          // alias .lengthOf
pm.expect(value).to.have.length.above(n);    // a chain too: the length is compared
pm.expect(value).to.have.property('key');
pm.expect(value).to.have.property('key', expectedValue);
pm.expect(value).to.have.nested.property('a.b[0].c');
pm.expect(value).to.have.own.property('key'); // not an inherited one; alias .ownProperty
pm.expect(value).to.have.ownPropertyDescriptor('key', { value: 1, writable: true, enumerable: true, configurable: true });
pm.expect(value).to.have.property('id').that.is.a('number'); // name alone: the subject is now the value
pm.expect(value).to.have.keys('a', 'b');     // exactly these keys; alias .key
pm.expect(value).to.have.any.keys('a', 'b'); // at least one of them
pm.expect(value).to.include.keys('a');       // at least these; alias .contain.keys
pm.expect(value).to.have.members([1, 2, 3]); // same members, any order
pm.expect(value).to.include.members([1, 2]); // a superset is fine
pm.expect(value).to.have.ordered.members([1, 2, 3]); // same members, same order
pm.expect(value).to.contain.oneOf(['a', 'b']);       // holds one of these
pm.expect(value).to.respondTo('send');       // has a method; a function: its prototype's
pm.expect(Ctor).itself.to.respondTo('create'); // the function's own method
pm.expect(value).to.have.jsonSchema({ type: 'object', required: ['id'] }); // draft-07

// Functions
pm.expect(fn).to.throw();                    // aliases .throws, .Throw
pm.expect(fn).to.throw('message substring'); // matched against err.message
pm.expect(fn).to.throw(/pattern/);
pm.expect(fn).to.throw(TypeError);
pm.expect(fn).to.throw(TypeError, 'substring');
pm.expect(value).to.satisfy(function (v) { return v > 0; });   // alias .satisfies

// Functions that change something: the target is called once, and the subject
// - a function, or an object and a property name - is read before and after
pm.expect(fn).to.change(object, 'key');      // aliases .changes
pm.expect(fn).to.increase(object, 'key').by(2);   // .increases
pm.expect(fn).to.decrease(getCount).by(1);        // .decreases

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
- **`property(name)` moves the subject to the property's value** (#2524), as in
  chai: `expect({id: 1}).to.have.property('id').that.is.a('number')` types the
  value `1`, not the object, and `.and.equal(v)` compares the value. With
  `nested` the value is the one at the last path segment, and `deep`, `nested`
  and the failure message carry over to the new subject. The value is read
  once, so a getter runs once. Two forms keep the chain they were called on:
  `property(name, value)` (the value was already compared) and
  `.not.have.property(name)` (absence has no value to move to). A primitive is
  read through its wrapper, as chai reads it (#2582), so
  `expect('abc').to.have.ownProperty('length')` passes; `null` and `undefined`
  have no property.
- **`keys` means exactly these keys**, as in chai's `have.keys`. `include.keys`
  (alias `contain.keys`) asks for at least these, and `any.keys` for at least one
  of them whether or not `include` came first; `all` is the default quantifier
  and the later of `any` and `all` wins. Names may be listed, given as one
  array, or given as one plain object standing for its own keys (chai's
  `Object.keys`), and an empty list is a `TypeError`, because `include.keys([])`
  would hold for every target having compared nothing (#2528). A `Map`'s keys
  are its keys and a `Set`'s its members, compared as values rather than names
  (`new Map([[1, 1]])` has the key `1`, not `'1'`), deeply under `deep` (#2582).
- **`include`, `own`, `ordered` and `itself` are flags the matcher after them
  reads** (#2528). Reading `include` or `contain` - as `include(x)` or as a chain
  word - sets chai's `contains`: `keys` and `members` then accept a superset, and
  `oneOf` asks whether the target contains a candidate (a substring, an element).
  `ordered.members` compares by position, and with `include` a prefix. `own`
  makes `property` and `include({...})` look at own properties only, and
  `nested` together with `own` is refused. `.length` and `.lengthOf` are a call
  and a chain: after one, `above`, `below`, `least`, `most` and `within` compare
  the length (a Map's or Set's `size`). A target with no length fails as chai's
  `to.have.property('length')` does, an `AssertionError` in both polarities, so
  `expect(3).to.not.have.length.within(1, 2)` fails. `length` directly after a
  chainable method (`include`, `a`, `length` itself, `responseTime`) is a
  `TypeError`, as chai's length guard makes it; `lengthOf` is the spelling
  there. The ordering matchers are chai's whole
  family, `gt` / `gte` / `lt` / `lte` and the `greaterThan...` spellings
  included, and `within` takes both bounds in.
- **`.a()` and `.an()` use chai's type names**: `string`, `number`, `boolean`,
  `null`, `undefined`, `array`, `object`, `function`, and for anything else the
  lower-cased tag (`date`, `regexp`, `map`, `set`, `error`, `promise`, `symbol`,
  `bigint`). Both are chai's chainable methods: read without a call they hand
  the chain on, so `.to.be.an.instanceof(Array)` runs, and called they return
  it, so `.an('array').that.includes(1)` does too.
- **`jsonSchema(schema[, options])` is draft-07** and runs on the engine's
  validator rather than ajv. A failure names the first path that broke the
  schema; a constraint that records no detail (`propertyNames`, a `false`
  schema) yields one failure at the body root that names the schema path
  instead. A keyword it cannot evaluate - one from JSON Schema 2019-09 or 2020-12
  such as `unevaluatedProperties`, OpenAPI's `nullable`, or a `propertyNames`
  nested anywhere below the schema's root - fails the assertion
  in **both** polarities and is named, because ignoring it would make the schema
  looser (or, under `not`, stricter) and neither verdict could be trusted. A
  root `propertyNames` is evaluated; a nested one (in `properties`, `items`, an
  `allOf` member, a `$ref` target, ...) is not, because valijson builds it from
  its parent's node path and so never runs its own subschema (#2729), where
  ajv does evaluate it.
  A schema that refers to itself without describing any value (`A` is
  `{ "$ref": "#/components/schemas/A" }`, or loops through `allOf`, `anyOf`,
  `oneOf`, `not` or `if`) is refused: `jsonSchema` throws a `TypeError` that
  names the loop, as it does for any schema the validator cannot read. The validator would otherwise recurse until the engine
  died. A recursive schema that steps into a property or an item (a tree node)
  is fine.
  `options` is ajv's and is accepted and not read. `format` is checked for
  `date`, `time`, `date-time`, `ipv4`, `email`, `uri`, `uuid`, `hostname` and
  `ipv6`; any other name (`uri-reference`, `int64`, ...) is an annotation and
  passes any string, where ajv would reject some of them. `require('ajv')` is
  on [the shelf](#ajv) and is the real library; `jsonSchema` stays on the
  engine's validator, and [where the two answer differently](#ajv) is pinned.
- **Every public member of chai 4.4.1's `expect` API has a row** in
  `engine/tests/fixtures/chai-conformance.json`, with a snippet that passes and
  one that fails, each checked against the real package. The suite holds the
  rows to the member names read off chai and chai-postman in both directions, so
  a row deleted, renamed or added for a member neither publishes fails by name,
  and it fails on a member the docs claim is missing from the table. The members that differ from chai are named in
  [pm-api-compatibility.md](../app/pm-api-compatibility.md#assertion-chains-pmexpect).
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
- **`include` answers by the target's type**, as in chai: a substring of a
  string (a boxed `String` too), an element of an array, a member of a `Set`, a
  value (not a key) of a `Map`, and on any other object subset matching, every
  key of the argument present on the target holding an equal value. Comparison
  is strict unless the chain says `deep`; for a `Set` or a `Map` strict is
  SameValueZero, what `Set.prototype.has` answers. Any other pair is a
  combination chai refuses, as an `AssertionError` in both polarities, so
  `expect({a:1}).to.include('a')` and `expect(5).to.include('x')` fail with or
  without `.not` (#2582). Two edges are Vayu's own:
    - **An expectation with no own enumerable keys is refused**, where chai
      passes it in both directions. `expect(body).to.include({})` compares
      nothing, so a computed subset that came out empty would report green
      having asserted nothing; a `Date`, a `RegExp` and a function carry no key
      either and read as assertions. Each names itself instead.
    - **A getter that throws is reported, not compared.** The exception reaches
      the test rather than being read as "these differ", which under `.not`
      would have been a pass.
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
- **A type check chai makes as an assertion is an `AssertionError`**, in both
  polarities (#2582): a `members` target that is not an array, a `length` read
  off a target with none, an `include` pair chai has no rule for. **A malformed
  call stays a `TypeError`** where chai raises an `AssertionError`: a missing or
  wrong-typed argument (`members(1)`, `above()`), `keys()` with no names,
  `nested` with `own`, and the ordering matchers' refusal of a value that is
  not a number or a `Date` (`expect('5').to.be.above(3)`). Deliberate: nothing
  was asserted, and the response assertions refuse a wrong-typed argument the
  same way (#998). Both throw, so a test fails either way; what differs is
  `e.name`.
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
pm.response.responseTimeWire  // CURLINFO_TOTAL_TIME less any wait for a
                              // connection slot, in ms - DNS + TCP + TLS +
                              // send + recv. Matches the pre-v0.3 meaning of
                              // responseTime; use this to assert on server SLAs
                              // independent of generator load.
pm.response.responseTimeQueueWait // Wait before the wire in ms - generator
                              // queue plus libcurl's wait for a connection
                              // slot - i.e. responseTime − responseTimeWire
                              // (clamped to >= 0). ~0 for single-shot sends.
pm.response.headers           // Plain object, lower-cased keys, with
                              // case-insensitive get()/has() over it - see below
pm.response.text()            // Body as string
pm.response.json()            // Parse JSON (throws if invalid)
pm.response.reason()          // Status reason phrase ('OK', 'Not Found')
pm.response.size()            // { body, header, total } in bytes
pm.response.responseSize      // The body's bytes: size().body
pm.response.cookies           // Set-Cookie, parsed - see below
                              // (the stored session is pm.cookies)
pm.response.errorCode         // string | undefined - TIMEOUT, DNS_ERROR, ...
pm.response.errorMessage      // string | undefined - the same failure in words
pm.response.redirects         // The 3xx hops followed to get here (Vayu only) -
                              // see pm.response.redirects below
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

**Buffered, never live.** The script runs once the stream is over, and runs to
completion - its timers and promise jobs included, see
[Timers](#timers-settimeout-and-setinterval) - before anything is reported, so a
per-event callback is not a feature that was left out: there is no moment while
the stream arrives for one to run in. The script runs against what was
retained.

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

### `pm.response.redirects` - the hops a send followed

Vayu-specific: Postman scripts have no view of the redirects a request went
through, so nothing here is portable to or from Postman. `pm.response` is the
**last** response of a followed chain - its headers, cookies and body are the
final hop's alone - and `redirects` is the rest of the chain, in the order the
engine followed it:

```javascript
pm.test('no hop left https for http', function () {
    const downgraded = (pm.response.redirects || []).filter(function (hop) {
        return hop.schemeDowngrade;
    });
    pm.expect(downgraded).to.be.empty;
});

pm.test('the login redirect set the session', function () {
    const first = pm.response.redirects[0];
    pm.expect(first.code).to.equal(302);
    pm.expect(first.headers.get('Set-Cookie')).to.include('session=');
});
```

Each entry is `{ code, status, url, schemeDowngrade, headers }`:

| Field | |
|-------|--|
| `code` | The hop's status, a number (`301`, `302`, ...). Named as `pm.response.code` is. |
| `status` | The hop's reason phrase, as `pm.response.status` is - the wire phrase, or the registered text for the code on HTTP/2 and later. |
| `url` | The URL of the request **this hop answered**, so `redirects[0].url` is the URL that was requested and the next entry's is where the first one's `Location` pointed (resolved, when it was relative). The value of the request's auth query parameter is blanked, as it is in the stored trace. |
| `schemeDowngrade` | `true` when this hop's request went over `https` and the next one over `http`. libcurl withholds `Authorization` and a typed `Cookie` when the scheme, host or port changes, but an API-key *header* is sent on, so this is the one hop a credential can cross in clear text. |
| `headers` | The hop's own received headers, shaped as `pm.response.headers` is: lower-cased keys, case-insensitive `get()` / `has()` and the other read methods, a repeated name folded with `", "`. A hop's `Set-Cookie` lines therefore join into one string, as they do on `pm.response.headers`. |

**Empty means none, absent means not recorded.** A send that was not redirected,
or that ran with *Follow redirects* off, reads `[]` - the engine looked and saw no
hop. The property is **missing** where the engine follows redirects without
keeping the chain: a load run's deferred `tests` script and a streamed
request's script. `typeof pm.response.redirects === 'undefined'` is the guard
there, so an assertion that the length is `0` cannot pass over a chain nobody
recorded. A chain that ends in `too_many_redirects` still lists the hops it
made, at most the request's `maxRedirects`.

The same facts are on the run's stored trace as `response.redirects[]`, with
`status`/`statusText` and `headerLines` in place of the script's
`code`/`status`/`headers`.

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
of `{ name, value, attrs }` with `get()` / `has()` / `toObject()` over it. Each
received `Set-Cookie` line is parsed on its own, so a comma inside a value
(`prefs=a=1, theme=dark`) stays in that cookie's value (#2460); the folded
`", "` string is parsed only for a response that kept no lines, such as a
load-run sample replayed into a script.
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
cookie boundary, and the `=` padding on a base64 value stays in the value. The
fixture's `singleLine` cases are the per-line parse.

### Response Assertions

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

`require('chai').expect(pm.response)` takes the same members after `to`
(`expect(pm.response).to.have.status(200)`, `.to.not.be.ok`), forwarding each
to the call above; see [`chai`](#chai).

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

`have.body` accepts exactly three forms and, with no argument, asserts that
there is a body at all. A string must equal the body
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
so a wrong expected value still passed. The path is read the way lodash's `_.has`
and `_.get` read it, which is how chai-postman reads it (#2528): `a.b[2].c`,
`a['b'].c` and `a["b"]` all work, a key the root holds whole wins
(`{"a.b": 1}` answers `a.b`), and an array root is `[0].id`. Every step is an own
property: an array's `length` is reachable and its `map` is not.

`have.statusCode(code)` compares the code (a number or a numeric string, as
chai-postman's `Number(code)` does), `have.statusReason(reason)` compares the
phrase exactly, and `have.statusCodeClass(digit)` the hundreds digit - which has
to be a number, not `'2'`. `have.jsonSchema(schema[, options])` is draft-07 by
the engine's validator, the same call `pm.expect(value).to.have.jsonSchema`
makes: the body is read as `JSON.parse` reads it, a failure names the first
failing path, and a keyword the validator cannot evaluate fails the assertion
naming it, in both polarities. `options` is ajv's and is not read, and `format`
is checked for `date`, `time`, `date-time`, `ipv4`, `email`, `uri`, `uuid`,
`hostname` and `ipv6` (see
[pm-api-compatibility.md](../app/pm-api-compatibility.md#assertion-chains-pmexpect)
and [`ajv`](#ajv) for where the engine's checks differ from ajv's).

`have.responseTime` and `have.responseSize` are a call and a chain, as in
chai-postman: `responseTime(120)` asserts the time equals 120, and
`responseTime.below(200)` / `.within(100, 150)` are `pm.expect`'s matchers on
the number; an unknown name after one is refused naming
`pm.response.to.have.responseTime`, the chain the script wrote. The size is the body and the header bytes added up;
`pm.response.responseSize` is the body alone.

`pm.response.to.not` negates every one of these, and as in chai-postman it
negates **each check on its own, in order**: `not.have.header('X', 'v')` fails
as soon as the header exists, and `not.have.jsonBody('id', 2)` as soon as `id`
does. `not` sets the negation, so `not.not` is still negated.

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

**`ok` is status 200 only, not any 2xx** (#998) - `success` is the 2xx one. A
script that meant "any 2xx" and asserted `.ok` needs `.success` instead.
Postman's named statuses (`accepted`, `withoutContent`, `badRequest`, ...) also
match by reason phrase; Vayu's stay code-only. chai-postman's phrase for
`unauthorised` is `Unauthorised` and for `notAcceptable` is `Acceptable`,
which no server sends, so in Postman those two fail against a real 401 and 406
where Vayu passes on the code.

**Anything else under `pm.response.to` throws.** A misspelled or unimplemented
name - `pm.response.to.be.definitelyNotAMatcher` - raises a `TypeError`
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
`Content-Type` (`json`, `graphql` and `jsonrpc` -> `application/json`, `text`
-> `text/plain`, `xml` -> `application/xml`, `x-www-form-urlencoded` ->
`application/x-www-form-urlencoded`; a bodyless `POST` sends none, issue #2464)
and the
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
pm.request.body.mode         // 'urlencoded' | 'formdata' | 'graphql' | 'file' | 'raw'
pm.request.body.raw          // the body as a string, for every mode
pm.request.body.urlencoded   // [{key, value, disabled}, ...] or undefined
pm.request.body.formdata     // [{key, value?, type, fileName?, disabled}, ...] or undefined
pm.request.body.graphql      // {query, variables?} or undefined (unreadable, or nested past 128 levels)
pm.request.body.file         // {name, size?} or undefined
pm.request.body.length       // the body string's own length
```

`.mode` reads `raw` for every content mode without a Postman name of its own -
`json`, `text`, `xml` and `jsonrpc` all carry their body as one string, which
is what `raw` means.

A `binary` body - one file sent as the whole body - reads `file`, Postman's
name for it. `.file` answers `{ name, size? }`: `name` is the file name the
request declares, else the last part of its path, and `size` its length in
bytes, present once the send has read the file. Postman's `file.src`, the path,
is never answered - a local path is one machine's filesystem and is not
disclosed to a script, the rule a form-data file part already follows (issue
#411) - see [pm-api-compatibility.md](../app/pm-api-compatibility.md).

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
  So does an envelope **nested deeper than 128 levels**, its own root counted
  (issue #2672): the body is one string, the request-body depth bound never
  looks inside it, and the GET transport refuses it by the same bound.
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
| `binary` | `@` and the file name, as a form-data file part is named - never the file's bytes | refused with a named error: a script never chooses the file |
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

Both lists are **read-only**, and so are `.mode`, `.graphql`, `.file` and
`.length`. Assigning any of them throws naming the member, and so does `push`ing into a list, which is
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
- **A repeated header reads folded and survives untouched** (issue #2466).
  `pm.request.headers` holds one value per name, so two `X-Dup` rows read as
  `'one, two'` (a `Cookie` joined with `'; '`). A name the script leaves at the
  value it read keeps every line it had, in place and in its own spelling; a
  name the script writes goes out as the one line it wrote.
- **A script beats engine-applied auth.** Auth (bearer / basic / apikey /
  oauth2) is resolved into the request *before* the script runs, so the script
  sees the real `Authorization` header and can replace or remove it. The one
  exception is a credential still holding a `{{name}}` that no variable defined
  when the request was composed, or any `{{name}}` of a request a pre-request
  script runs before (#2473, #2521): that auth is applied *after* the script, so
  a value the script sets reaches it, and the header is not in
  `pm.request.headers` yet. A header the script sets still wins, because auth
  never replaces one the request already carries. The order is the same on a
  Send, on every step of a collection run, and under load after an `inline`
  `script.pre` (a single-request load run's through `requestElements`).
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
- **`pm.request.body = string` and `pm.request.body.raw = string` reach the
  wire the same way, but only the second is safe to read back.** Assigning to
  `pm.request.body` directly replaces the whole `RequestBody` object with the
  string, so a later `pm.request.body.raw` (or `.length`, or a hash of it) in
  the *same script* reads `undefined`, not the string just set - the object it
  lived on is gone. Assigning to `.raw` instead updates that object in place,
  so the new body stays readable for the rest of the script. Any script that
  signs, hashes, measures or re-parses the body it just wrote - the
  `hmacSha256(secret, pm.request.body.raw)` shape most webhook signing needs -
  must use `pm.request.body.raw = …`, not `pm.request.body = …`.
- **Setting a variable re-renders the URL of a scripted request.** A request
  a pre-request script runs before (its own, a folder's or the collection's)
  keeps every `{{placeholder}}` a scope answers written when `POST /compose`
  composes it (#2521, [decision D1](../app/variable-resolution.md), Postman's
  order), and so does a name composition could not answer (#1009). All of them
  are resolved after the pre-request script and before the send (#1008),
  against the scopes as the script left them. So `pm.environment.set('host', …)`
  reaches a `{{host}}` in this send's URL, on every run. Meanwhile
  `pm.request.url` holds the `{{host}}` as written, in the script. A request no
  pre-request script runs before is composed once, as it always was, and a
  `{{host}}` composition substituted is finished text - assign
  `pm.request.url` directly to change that. A collection run widens this to
  the whole plan: when any step's script or extractor writes a variable before
  a send (`script.teardown` aside), every step defers, so a token one step's
  test script stores reaches a later step's `Bearer {{token}}` on every run
  ([Scenario runs](api-reference.md#scenario-runs)).
- **A load run runs a pre-request script only inline.** A `script.pre`
  element runs under load, in a single-request run's `requestElements` and in
  a scenario step's elements, only when its `config.inline` is `true` or the
  run's `elements.scripts` override forces it (issues #1495, #1594). An
  unmarked one never runs there: it has no deferred pre-request replay to
  wait for; a scenario step it is left on is reported
  `preRequestScript: "skipped"` (see
  [Script elements](#script-elements-design-send-and-the-sequential-run)). A
  `script.post` that is not inline is replayed afterwards on a sample - see
  [Load Test Scripts](#load-test-scripts).

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

`addQueryParams()` and `removeQueryParams()` are Postman's `Url`-level spellings
of `add` and `remove` for several parameters at once:

```javascript
pm.request.url.addQueryParams('a=1&b=2');                // a query string
pm.request.url.addQueryParams(['c=3', { key: 'd', value: 4 }, { key: 'flag' }]);
pm.request.url.addQueryParams({ key: 'trace', value: 'abc' }); // or one object

pm.request.url.removeQueryParams('page');                // every match of a name
pm.request.url.removeQueryParams(['a', { key: 'b' }]);   // names and { key } objects
```

`addQueryParams` takes a query string (split on `&`, each segment at its first
`=`; `flag` is a bare key and `a=` an empty value), an array of one-param
strings and `{ key, value }` objects, or a single `{ key, value }` object.
Every item is checked before any is added, so a bad one throws a `TypeError`
and leaves the URL as it was, and an empty key is refused as in `query.add`.
Parameters are appended with duplicates kept, encoded by the rule `add` uses.
A string inside an array is **one** parameter, so `['a=1&b=2']` adds `a` with
the value `1&b=2` (the `&` encoded as `%26`). `removeQueryParams` takes a name,
or an array of names and `{ key }` objects, and removes every parameter of each;
a name that is not there is a no-op, and an empty or non-string item is a
`TypeError`. Two differences from Postman: a leading `?` on the query string is
dropped (Postman keeps it as part of the first key), and
`removeQueryParams({ key: 'page' })` outside an array throws where Postman's
removes nothing.

Five rules behind those, each the reason for a decision you might otherwise
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
- **`add` and `upsert` encode what they are given**, by the rule the send
  writes a query with ([Query encoding](api-reference.md#query-encoding)):
  `add({ key: 'k', value: 'a b' })` sends `k=a%20b`, and `get('k')`, `all()`
  and `getQueryString()` then read `a%20b`, because the query is the wire bytes.
  `%` is never encoded, so a value already encoded passes as it is; under
  `disableUrlEncoding` the pair is written as typed. Postman keeps the text as
  given and encodes it when it sends, so its `getQueryString()` answers
  `k=a b` here - Vayu answers what goes out. A name is still looked up as the
  script typed it: after `add({ key: 'a b', value: '1' })`, `get('a b')`,
  `has('a b')`, `remove('a b')` and `upsert({ key: 'a b', ... })` all find
  the stored `a%20b`, as they do in Postman.
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
pm.info.eventName      // 'prerequest' | 'test' | 'setup' | 'teardown'
pm.info.iteration      // number | undefined - 0-based, in a run of any shape
pm.info.vu             // number | undefined - 1-based, the virtual user that sent it
pm.info.iterationCount // number | undefined - the run's iteration total
pm.info.run            // object | undefined - a run summary, `script.teardown` only (see below)
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

## Setup and teardown scripts

`script.setup` and `script.teardown` are elements a collection carries directly
(never a request), run once each at the run's own boundary rather than at any
step - `run.start`, before the first step or submission of either run mode, and
`run.end`, after the last one. They exist for the same reason k6's `setup()` /
`teardown()` and JMeter's setUp / tearDown thread groups do: fetch a token or
seed data once for the whole run, and clean up once after, without a script
attached to every request paying for it. See
[`elements.md`](elements.md#kinds) for the element mechanics (dispatch, phases,
placement) - this section is what the two scripts see as scripts.

Both read and write the same three variable scopes every other script does
(`pm.environment`, `pm.globals`, `pm.collectionVariables`) - a name
`script.setup` sets is visible to the very first step or submission of the run,
because it writes through the same scopes object every other script of that
run shares, before either run mode's own work begins. `pm.info.eventName` reads
`'setup'` / `'teardown'`; neither script has a `pm.request` or a `pm.response`
to read, since neither runs against a particular step. `pm.execution` throws
the same "not available here" sentence a non-scenario script already gets:
there is no sequence position to redirect from a run's own boundary.

**`script.teardown` alone sees `pm.info.run`** - a summary of the run it is
cleaning up after, since it is the one script that runs after there is one to
report:

```javascript
pm.info.run.requestsSent      // number - completed submissions, whole run
pm.info.run.errorRate         // number - percent, whole run
pm.info.run.assertionsPassed  // number
pm.info.run.assertionsFailed  // number
```

On a load run `errorRate` is the figure the report prints, by the
[one error definition](api-reference.md#what-counts-as-an-error); on a
sequential collection run it is the share of steps that errored.

**A throwing `script.setup` fails the run before anything is sent.** Its
outcome is checked the same way any element's is (`"error"` fails the check);
the run reaches `Failed` before either run mode's strategy starts, so nothing
is sent and no duration is measured. **A throwing `script.teardown` is
recorded and does not change the run's status** - it appears under the
report's `lifecycle.teardown`, exactly as a passing one does, just with an
`"error"` outcome and the thrown message.

**Neither script's own time counts toward the run's duration figures.** Setup
runs, and is timed out of the way, before either run mode captures its own
`test_start`, which is also where a load run's live `elapsedSeconds` starts
counting (it reads `0` while setup runs); teardown runs after the load path's `test_end` is already
captured, and after the sequential run's own step loop has finished.

**`pm.sendRequest` follows the run's own gate, with no separate toggle.**
Vayu's MCP target allowlist is what makes every script-issued request refuse
by default (see [Sending a request from a script](#sending-a-request-from-a-script-pmsendrequest)); a
setup or teardown script is bound to the same `ScriptEngine` instance, and
therefore the same `allowScriptRequests` decision, every other script of the
run already answers to - there is no `script.setup`-only opt-in to reach for,
and the same **10 requests per script** cap applies. The fetch also inherits
what every other script of the run sends under (issue #2841): the run's
`timeout` (else `defaultTimeout`) when it names none of its own, the run's
response byte bound, transport policy and default headers - see the
[bounds](#sending-a-request-from-a-script-pmsendrequest) below.

## Environment Variables (`pm.environment`)

Access and modify environment variables:

```javascript
// Get variable
const token = pm.environment.get('auth_token');

// Set variable (persists to environment)
pm.environment.set('auth_token', 'new_token_value');

// Set a secret variable in one call
pm.environment.set('auth_token', 'new_token_value', { secret: true });
```

`set()` on an existing name replaces its value and keeps the variable's `secret`,
`type` and creation time, unless its third argument names one (below). It also
turns `enabled` on (#2479): a set is a write of a
value the script means to use, so a row unticked in the variables editor is ticked
again, and the script's own `get`, `has` and `replaceIn` and the `{{name}}` pass
before the send all see it. A name that does not exist yet is
created with the defaults and stamped with its creation time, so it appears at
the bottom of that scope in the variables editor rather than above the rows
that were already there.

A run reaches disk as a **delta**, not a copy of the scope (issue #1878). The
scopes are loaded when a send, stream or collection run starts and written
back once when it ends; at that point each scope's row is read again and only
what the run's scripts changed against what it loaded is applied to it, under
one database lock:

- a name the run set that it did not load is written whole, creation time
  included;
- a name whose value alone changed gets that value, and keeps whatever
  `enabled`, `secret` or `type` the row holds now; a name whose other fields
  changed too is written whole - an `extract.*` element writes a whole
  variable, and a `set()` that re-enabled an unticked row changed `enabled`
  as well as the value;
- a name the run loaded and no longer holds (`unset()`, `clear()`) is removed.

Everything else on the row is left as it is now, so an edit made in the
variables editor, a `POST /globals` or another send's own write while the run
was in flight survives it. A scope whose delta changes nothing is not written
at all, so its `updated_at` does not move, and a row deleted meanwhile is not
recreated.

### A value keeps its type for the run

`set()` keeps the JavaScript value it was given, and every later read in the
same run answers it as set (issue #2529), as Postman does:

```javascript
pm.environment.set('count', 0);
pm.environment.set('count', pm.environment.get('count') + 1);
pm.environment.get('count'); // 1, a number - not "01"

pm.collectionVariables.set('ids', [1, 2, 3]);
Array.isArray(pm.collectionVariables.get('ids')); // true
```

`get`, `toObject`, `pm.variables.get` and `pm.variables.toObject` all read it.
The run is the scripts of one send, the steps of a collection run, or one
virtual user's steps in a load run (the value rides that user's own write
layer, so one user's value never reaches another).

What the variable *stores* is the value's string form, and that is all
`{{name}}`, `pm.variables.replaceIn`, the wire and the persisted row ever see:
`1`, `true`, `1,2,3`, `[object Object]`, `null`, and `""` for `undefined` -
Postman's own substitution, so a `{{count}}` header goes out as `1` (a declared
`json` row is the one exception, below). A name the
run only loaded reads from that stored text, cast by its declared type. The
typed value is never written anywhere, and it is not an edit: setting the
number `5` on a row that holds `"5"` leaves the row unwritten.

Two limits:

- **A declared type wins.** A row whose `type` is `number`, `boolean` or
  `json` casts its stored text by that type, whatever was set. Vayu's default
  `"string"` doubles as Postman's `any`, so a row of that type answers what was
  set. On a `json` row, `set` of an object or an array stores its JSON text
  (`JSON.stringify(value)`, #2568), so it reads back as the object and
  `{{name}}` substitutes the document; a string set there stays as given. A
  value JSON cannot write (a function, a cycle) still stores its string form.
- **An object travels as JSON.** Each read is a fresh copy, as
  `JSON.parse(JSON.stringify(value))` would make it: a `Date` reads back as its
  ISO string and a nested `NaN` as `null`. A number on its own keeps every
  value, `NaN`, the infinities and `-0` included. What JSON cannot write at all
  (a function, a `BigInt`, a cycle) reads back as its string form.
- **A later write replaces it.** An `extract.*` element writes a whole new
  variable, so its text replaces a value a script set earlier.

### The third argument of `set` (#2664)

`set(name, value, options)` reads Postman's optional third argument
(postman-collection 5.3.0), in either of its two shapes:

- **a string** is a type: `set('n', 1, 'number')`;
- **an object** contributes `type` when it is a string and `secret` when it is a
  boolean: `set('token', t, { secret: true })`, `set('n', 1, { type: 'number' })`.

Anything else (`null`, a number, an object whose members are the wrong kind) is
ignored, as Postman ignores it. The type names map onto the four Vayu declares:
`string`, `number` and `boolean` are their own, `json`, `object` and `array` are
`json`, and any other name (`any`, `default`, a word Postman has no type for)
leaves the row's type as it was. **`"secret"` is not a Postman type**; as the
string, or as the object's `type`, it marks the variable secret and leaves the
type alone - the same reading the importer gives `type: "secret"`. An explicit
`secret` boolean beside it wins, so `{ type: 'secret', secret: false }` is not
secret, and `{ secret: false }` on its own clears the flag of a secret row.

Each field the argument names is set on a new row and on an existing one; a field
it does not name keeps what the row has, so `set(name, value)` is exactly what it
was before. The stored text follows the type the set declares, not the one the
row had: `set('filter', { a: 1 }, 'json')` stores the document `{"a":1}` (#2568),
where the same set on a default-type row stores `[object Object]`.

A changed flag or type is more than a value change, so the run's delta writes the
row whole and it reaches the stored scope. **The flag takes effect from the next
read of the scope**: `secret_variable_values`, which decides what a run snapshot
masks, reads the stored scopes when a run starts, so the value is masked from the
next run on and not inside the run that made it secret. The variables editor and
an MCP agent's withholding read the stored flag too.

`pm.variables.set` is the local scope and takes the argument like the others, but
that scope is never stored and never masked, so a `secret` flag on it has no
effect.

### The six methods every scope has

| Method | Returns | Notes |
|---|---|---|
| `get(name)` | the value a script set this run, as it was set; otherwise the stored text cast by its declared type; or `undefined` | a disabled variable reads as `undefined`; a declared `number` / `boolean` / `json` row always casts |
| `set(name, value, options?)` | `undefined` | stores the value's string form (`undefined` as `""`; an object or array on a declared `json` row as its JSON text); keeps `secret` / `type` / creation time unless `options` names one ([above](#the-third-argument-of-set-2664)); turns `enabled` on |
| `has(name)` | `boolean` | true only for the rows `get()` can read, so a disabled variable is `false` |
| `unset(name)` | `undefined` | removes the name; removing one that is not there is not an error |
| `clear()` | `undefined` | empties **this** scope only, disabled rows included |
| `toObject()` | plain object | every enabled variable, each value as `get()` answers it; a snapshot, not a live view |

```javascript
if (pm.environment.has('auth_token')) {
	pm.environment.unset('auth_token');
}

console.log(pm.environment.toObject());
```

`unset()` is not the same as `set(name, '')`. An emptied variable is still an
enabled row, so `{{auth_token}}` resolves to the empty string; an unset one is
gone, and the template resolves as it does for a name nobody defined. The
removal reaches disk as part of the run's delta: a name the run loaded and no
longer holds is removed from the stored scope, while a name another client
added meanwhile is not the run's to remove, so `clear()` empties only what the
run loaded.

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

`pm.variables` reads a name without naming its scope, resolving **the local
scope first, then the bound data row (if one is bound), then environment, then
collection, then global**, and stopping at the first tier that has it. Below
the local scope that is the same order `{{baseUrl}}` is resolved in before the
request is sent (see [Variable Resolution](../app/variable-resolution.md)), so
a script and a URL in the same request cannot read one name two different
ways. The local scope is what `pm.variables.set` writes; it is described
[below](#the-local-scope-pmvariablesset).

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
console.log(pm.variables.toObject()); // every tier, merged, the local scope winning
```

### The local scope (`pm.variables.set`)

`pm.variables.set(name, value, options?)` writes Postman's *local* scope (issue #2564):
the strongest tier of all, above a bound data row, and never stored anywhere.
It is for a value a script computes for this run and nothing after it - a
signature, a nonce, a counter - which no named scope can hold without the
value reaching disk at the run's end.

```javascript
pm.variables.set('nonce', Date.now());
pm.variables.get('nonce'); // the number as set
// a header written {{nonce}} goes out carrying its text
```

- **Every read sees it first.** `get`, `has`, `toObject`, `replaceIn` and
  `pm.sendRequest` read it above the row and the named scopes, and so does the
  pass that resolves what composition left after the pre-request script, so a
  `{{nonce}}` header goes out with the value. A name composition substituted
  for a request no pre-request script runs before, or the data-row bind
  already answered before the script ran, keeps that answer
  ([decision D1](../app/variable-resolution.md)).
  `{{data.column}}` is the row's own spelling and never reads the local scope.
- **The writes are the scoped ones.** `set` keeps the value's type for the
  run and stores its string form for `{{name}}`, exactly as
  [the named scopes' `set`](#a-value-keeps-its-type-for-the-run) does, and it
  reads [the third argument](#the-third-argument-of-set-2664) too, though a
  `secret` flag here is never stored or masked;
  `unset(name)` removes one local name, so the tiers below it answer again;
  `clear()` empties the local scope. None of the three touches the
  environment, the collections or the globals.
- **Nothing stores it.** The run's variable write-back never reads it, the
  Variables panel and the variable popover never show it, and a run's stored
  snapshot does not carry it.

How long it lives is the run that owns it:

| Where the script runs | The local scope lives for |
|---|---|
| A single Send or `POST /execute` (buffered or streaming) | that send: the pre-request script, the send and the test script |
| A collection run | the whole run - every step of every iteration, `script.setup` and `script.teardown` included - and is discarded when the run ends |
| A scenario load run | one virtual user's iteration: each user holds its own, empty at the start and cleared at its iteration boundary; the user's environment, collection and globals writes are not local and carry on (#3044) |
| A single-request load run with `requestElements` | one submission, starting empty |
| A load run's deferred `tests` replay | the replay pass: one scope, empty at the start and shared by every replayed sample of every step, as the replay's other writes are; never stored |

Under load, `script.setup` and `script.teardown` belong to no virtual user,
so what they set with `pm.variables.set` ends with them: setup's local scope is
discarded before the first submission, and a value every user should start
from belongs in a named scope instead.

**`pm.variables.replaceIn(template)`** - Postman's `{{name}}` interpolation of
an arbitrary string - runs the same resolver `POST /compose` uses
(`request_composer.cpp::resolve_template`), over the script's scopes in
`pm.variables`' precedence, at **call time** - so a variable the script set a
line earlier resolves at once, where the request's own `{{}}` in the URL waits
for the pre-request script to end (#2521). Dynamic variables generate per
occurrence:

```javascript
const id = pm.variables.replaceIn("{{$guid}}"); // fresh UUID v4
```

It exists only on the merged accessor - the scoped `replaceIn` variants stay
absent - and its argument must be a string (a non-string is a `TypeError`).
This is the one sanctioned way to `{{...}}` in a script: script *source* is
never interpolated (issue #226, D16 - a rewrite cannot tell code from a string
literal, and splicing values into source is an injection). The editor now
paints that difference rather than leaving it to this page alone: a
`replaceIn(...)` template's tokens get the full colour and popover a body
field's do, while a bare `{{name}}` written anywhere else paints muted and its
hover names this section and `pm.variables.replaceIn` as the fix (issue #1220
script support, `docs/app/COMPONENTS.md`).

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
cannot supply. `fetch` and `XMLHttpRequest` are absent; their hover points here.

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

The first argument is a URL string or an options object; the second, when
given, must be a function.

| Option | Shape |
| ------ | ----- |
| `url` | string, required, or `pm.request.url` - the Url object, so `pm.sendRequest(pm.request.url, cb)` reads as "send this again". A hand-built `{ host, path }` object is still not accepted |
| `method` | string, default `GET`; case-insensitive, an unknown verb throws |
| `header` / `headers` | `{ name: value }` or Postman's `[{ key, value }]`. Both names read; sending both at once throws |
| `body` | a string, or `{ mode, <mode>: ... }` for `raw` (`raw` string, sent as `text/plain`), `urlencoded` (`urlencoded` rows, sent as `application/x-www-form-urlencoded`) or `formdata` (`formdata` rows, sent as `multipart/form-data`). Rows are Postman's `[{ key, value, disabled? }]` or a `{ name: value }` object; a `disabled` row is skipped, and a `formdata` row may carry a `contentType`. A `type: 'file'` row and the `file` and `graphql` modes throw. A `header` naming a Content-Type wins over the one the mode implies, except for `formdata`, whose type carries the boundary |
| `auth` | Postman's `{ type, <type>: params }`. `basic`, `bearer`, `apikey`, `noauth`; any other type throws |
| `timeout` | milliseconds. Absent, the call takes the resolved timeout of the send or run the script belongs to - the request's or run's `timeout`, else the `defaultTimeout` setting; a sequential collection run's step scripts take their step's, which is the stored request's own `timeout` when it states one (#2937), and every other script of a run the run's - in every script that may send: a Send's scripts (buffered or streamed), a collection run's step, `script.setup` and `script.teardown` scripts, and every script of a load run, its inline step scripts, `script.setup` / `script.teardown` and the deferred `tests` script (issues #2833, #2841). Either is clamped to the script's remaining budget (below) |

**Synchronous, in both forms.** The send blocks and the callback runs inline,
before `pm.sendRequest` returns. Called without a callback, it returns a
promise instead (#2577), already settled when it comes back: resolved with
`res`, or rejected with the `err` the callback would have been given, so the
code after an `await` runs with the answer.

```javascript
const res = await pm.sendRequest("https://auth.example.com/token");
pm.environment.set("token", res.json().access_token);
```

**Which failures throw and which reach the callback.** Transport failures are
the network's answer, so they arrive as the callback's `err` - an `Error` with
a `.code` (`CONNECTION_FAILED`, `DNS_ERROR`, `TIMEOUT`, `TOO_MANY_REDIRECTS`, …)
and `res` null - or, without a callback, as the promise's rejection with that
`Error`. The script's own mistakes throw out of the call instead, in both
forms: an unusable argument, an unsupported body mode, exceeding the request
cap, and the capability being off.
A response over the byte bound below is the network's answer too, not a
mistake: it arrives as `err` with `.code` `RESPONSE_TOO_LARGE`. So does a URL
whose scheme is not `http` or `https` once its variables resolve
(`file:///...`, `ftp://...`): `err.code` is `INVALID_URL`, the message names
the scheme, and nothing is read - the same refusal a Send of that URL gets
([URL schemes](api-reference.md#url-schemes)).

**Vayu's own ports are never a target.** A URL naming the engine's own port or
the MCP port (9877) on this machine - `127.0.0.1`, any other `127.x.y.z`,
`localhost`, `[::1]` - throws `pm.sendRequest refused: Vayu does not send
requests to its own engine port ...`, before anything is dialled, because the
engine's API would take the script's request for the app's. A redirect that
leads there, or a host name that resolves there, is refused by the transport
instead and reaches the callback as `err` with `.code` `INVALID_URL` and the
same sentence. Every other local server is reachable as before. See
[Reserved local ports](api-reference.md#reserved-local-ports).

`res` carries `code`, `status` (the reason phrase, as on `pm.response`),
`responseTime`, `headers` with `get()`/`has()`/`each()`/`all()`/`count()`/
`toObject()`/`one()`/`indexOf()` - the same read methods documented under
[Reading response headers](#reading-response-headers) - `json()` and `text()`.
It is a subset of `pm.response` and has no `to.*` assertion chain.

**Three bounds, all hard.**

- *The script's deadline.* The wall-clock limit is enforced by a QuickJS
  interrupt handler, and QuickJS only calls it **between bytecode operations** -
  a blocking C function never yields to it. So the request's timeout - the
  `timeout` option, else the enclosing send's own resolved timeout (its
  `timeout`, else `defaultTimeout`) - is clamped to whatever is left of the
  script's budget; without that, a 5s script calling `pm.sendRequest` under a
  30s request timeout would hold its thread for 30s with no error and no way to
  interrupt it. A call made with the budget
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
  setting supplies `M` follows the path: a design-mode send's scripts (Send, and
  a collection run's step, setup and teardown scripts) take
  `maxDesignResponseBodyBytes`; every script of a load run (an inline step
  script, `script.setup` / `script.teardown`, the deferred `tests` script) takes
  `maxResponseBodyBytes`, because a script that runs once per submission or per
  sampled response belongs to the run's memory budget rather than to the one
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
send (a collection run's, for every script of that run), and every script of a
load run takes the one the run's own transfers left by - resolved once when the
run starts and kept for it, so a Settings edit made while the run was in flight
cannot send an assertion by a route the responses it is asserting on never took
(issues #1256, #2841). The [default headers](api-reference.md#default-request-headers)
the engine adds follow the same rule: a load run's scripts send the load
scope's set its transfers carried, a design-mode send's scripts the design
scope's.

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
name and value, a raw body, a form body's field names and values and each
credential of an `auth` block are resolved
once, against the local scope, the bound data row and the three named scopes
exactly as `pm.variables.replaceIn` reads them - so a value this same script set two lines
earlier is visible, which is Postman's rule and what makes an imported
token-refresh script work. It is not a second pass over the request being
sent: that request's own names resolve after the pre-request script ends
(#2521), and nothing here revisits them.
A name nothing defines keeps its braces (#1009), and a `{{data.column}}` the
bound row lacks throws naming the column, the same way `replaceIn` does.

**The URL goes out encoded as Postman sends it.** Once its variables resolve,
the URL is percent-encoded component by component as `postman-url-encoder`'s
`toNodeUrl` writes it (`core::encode_url_as_postman`): the path, query,
fragment and user info each by its own Postman set (listed under
[Query encoding](api-reference.md#query-encoding)), a backslash before the
query as `/`, the host lowercased. So `pm.sendRequest("https://x/a b?q=c d&r=\"x\"", cb)`
sends `/a%20b?q=c%20d&r=%22x%22`, where before the space made libcurl refuse
the URL. `&` and `=` in the query stay separators, and `%` is never encoded, so
an escape already written (or a URL composition already encoded, such as
`pm.request.url`) is sent unchanged. There is no way to turn this off: Postman
builds the call with a `protocolProfileBehavior` of its own, so neither the
enclosing request's `disableUrlEncoding` nor anything in the options reaches
it. A `{{name}}` nothing answered goes out as written, where Postman would
encode its braces in the path. A non-ASCII host is dialled by its punycode
name (`bücher.example` as `xn--bcher-kva.example`), as it is on every send
path; see [Non-ASCII hosts](api-reference.md#non-ascii-hosts).

Send writes the same request line for every URL with its Send URL without
encoding toggle off (#2465): the encoder is the same one.

Header **names** resolve too (#1067), under the collision rule composition owns
rather than a second one written here (#1051, `http/header_names.hpp`): two
names written differently that resolve to one name would send that header twice
where the script wrote two different ones, so the call throws naming both
spellings and the name they produced, and nothing goes out. Names are compared
without case. A name
that resolves to nothing at all is refused the same way, and it is the one thing
resolution can produce that nothing further down the send would catch: the
pre-send gate reads header text for the bytes that break a line, and what is
left of an empty name is the line `: value`, which libcurl sends. This call met
that rule first, a script writing header names of its own; since #1084
composition and the execute-time residual pass refuse it in the same words, so
one wording answers wherever a name is resolved. A resolved name is also
trimmed of the spaces and tabs around it and must then be an RFC 9110 token:
` X-Trace` goes out as `X-Trace`, and `X Trace` throws with the same wording as
the `invalid_header_name` refusal (#2467).

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
reason the body modes it cannot send whole (`file`, `graphql`, a file part) are
refused too.

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
- **Load runs mostly have no jar.** The jar is deliberately off the load path:
  sharing one across the event loop's workers would put a lock on the hot
  path. One exception (issue #1501): a scenario load run's own inline
  `script.*` element reads that one virtual user's own cookies through the
  flat surface above - the same per-user state the run already carries step
  to step outside any script (`docs/engine/architecture.md`'s Cookie Jar
  section, "Not on the load path"), with no lock, because that user's own
  completion is the only reader. A single-request run (no scenario, no
  virtual user) and a scenario step's deferred replay (a recorded response,
  not the user that fetched it) still throw there, each naming its own
  reason rather than the one sentence above.
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
this script has already staged with `set` is included - though only for a URL
inside the request's site (see
[Reads are limited to the request's site](#reads-are-limited-to-the-requests-site)).
Every method is **URL-scoped** - it takes the URL the cookie belongs to rather
than assuming this request's (`clear`'s URL is optional; see below) - and each accepts an
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
matching the read half respects. Nor is it a way around the site limit: a write
is held to the request's site and the hosts the script called, like a read (see
[Writes are limited the same way](#writes-are-limited-the-same-way)).

**When the write takes effect.** A write is *staged*, not applied where it is
made, and the next transfer of that execution carries it:

- A `set` in a **pre-request script** rides the request it was made before, and
  that request's own cookie capture is what writes it into the jar, as one of
  that transfer's own changes. That is the reason for the ordering: a capture
  folds back only what its transfer changed against what it was seeded with,
  so a write dropped into the jar beside an in-flight request would be
  undone by it.
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

Load runs have no jar for writes; `jar()` and every method on it throw there
under every load-run script, including a scenario's inline ones - only the
flat reads above have the one per-user exception described above.

#### Reads are limited to the request's site

`get` and `getAll` answer only for a URL whose host is the request's own site or
one this script has addressed through `pm.sendRequest`. The jar holds the
sessions of every host the environment has talked to, so without the limit a
script - an imported collection's, say - could name any host and read its
session cookie out.

"The same site" is RFC 6265's domain-match read in both directions: the hosts
are equal, or one is a dot-boundary subdomain of the other, ignoring case and a
trailing dot. For a request to `www.example.com`, `www.example.com` and
`example.com` are in scope and so is `shop.www.example.com`; `api.example.com`
(a sibling), `example.org` and `evilexample.com` are not. An IP address is in
scope only as itself. A non-ASCII host is compared as its punycode name, the one
the jar keys on.

**The request's site is its URL as the variables resolve it at the call.** A
request a pre-request script runs before still holds its `{{name}}`s in that
script (#2521), so its host is read the way `pm.variables.replaceIn` would read
the URL at that moment: a `{{host}}` the environment stores, or one the script
set a line earlier, names the site, and a write after the script moves
`host` is held to the new one. `pm.cookies.get` and its siblings match the
same resolved URL.

A host the script has called with `pm.sendRequest` joins the allowed set from
the moment of the call, whether or not the transfer succeeded, so "log in
through `pm.sendRequest`, then read the session it set" works. The set lasts
one execution of one script.

A read outside the allowed set does not throw. `get` answers `undefined` and
`getAll` answers `[]`, through the callback as well, and the script's console
gets one warning naming the host (never the full URL, which may carry a secret):

```
pm.cookies.jar().get read nothing for b.example: a jar read is limited to the request's own site (a.example) and to hosts this script has called through pm.sendRequest. See docs/engine/scripting.md.
```

**A redirect target is not seen.** Only the request's URL and the URLs given to
`pm.sendRequest` are compared. A request to `a.example` that a server redirects
to `b.example` does not put `b.example` in scope, so a script cannot read the
redirect's cookies unless it called that host itself.

#### Writes are limited the same way

`set`, `unset` and `clear(url)` are held to the same allowed set as reads: the
request's own site plus the hosts this script has addressed through
`pm.sendRequest`, compared by the same rule (the two share one definition, so
they cannot drift). A script - an imported collection's, say - therefore cannot
plant a cookie for another site, nor delete that site's session.

- **The URL** a write names must be in scope, for all three methods.
- **For `set`, the cookie's `domain` must be in scope too.** Without the check a
  cookie `{ domain: 'victim.example', path: '/' }` set through a URL of
  `a.example` would be stored for `victim.example` and sent on the next transfer
  to it (cookie fixation). RFC 6265 section 5.3 has a user agent ignore a
  `Domain` that does not domain-match the request host; the jar does not apply
  that rule itself, so the engine checks it here, and it reads the match in both
  directions like the rest of the scope. A leading dot is ignored for the
  comparison and the domain is compared as punycode, as the jar keys on it.
  `Domain=example.com` set from a request to `www.example.com` is in scope and
  still stores.
- **A single-label domain is refused** (`.com`, `test`) unless it is exactly the
  request's host or one the script called (a request to `localhost` may write
  `domain: 'localhost'`). A top-level domain is a parent of every host under it,
  so the site rule alone would admit it, and the cookie would then be sent to
  every site there. **No public-suffix list is applied** (#2731): `co.uk` or
  `github.io` still passes as a domain, because telling it from `example.co.uk`
  needs the list.
- `clear()` with no URL empties this environment's jar and is not subject to the
  site limit (see above).

A refused write does not throw and stages nothing. The call completes as an
accepted write would - `set` returns (and passes the callback) the cookie it
would have stored, `unset` the name - and the script's console gets one warning
naming the host or domain, never the full URL:

```
pm.cookies.jar().set wrote nothing for the domain victim.example: a jar write is limited to the request's own site (a.example) and to hosts this script has called through pm.sendRequest. See docs/engine/scripting.md.
```

A bad argument is still the error it was; the site check runs after the
arguments are validated. A redirect target is not in scope for writes either.
A Postman script that logs in across hosts by `set`ting a cookie with a foreign
`domain` stops working here; call the other host through `pm.sendRequest` first
and its jar entries, and writes naming it, are in scope.

The flat `pm.cookies` reads need no such rule - they only ever read the
request's own URL.

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

**A script that errored loses its instruction.** When either of a step's
scripts throws (or times out, or has its `pm.request` write-back refused), the
step is `errored` and the iteration carries on at the **next plan position**:
a `setNextRequest`, `setNextRequest(null)` or `skipRequest()` the script made
before failing is ignored, because it came from code that did not finish. A
skip the pre-request script asked for has still happened - nothing was sent -
but where the iteration goes next is the plan's order, not the script's.
`stopOnError: true` on the run ends the iteration at that step instead (see
[api-reference.md](api-reference.md#scenario-runs), Outcomes). A step that
errors this way runs no `step.between` element either, so a `timer.think` or
a `control.loop` decision after it does not happen for that step.

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
| Either method | A scenario load run's inline `script.pre` / `script.post` | Throws - a load run's sequence is redirected by `control.*` elements only, and the step counts as `errored` (#2947) |
| `skipRequest()` | A test script inside a collection run | Throws - the request has already gone out; there is nothing left to skip |
| `setNextRequest()` | Anywhere | `TypeError` - the argument is required. Omitting it is not a synonym for `null` |
| `setNextRequest(3)`, `setNextRequest('')` | Anywhere | `TypeError` - a target is a non-empty string, or `null` |

### Where the step fails instead

Two cases are the runner's to refuse, because only it can see the plan. Both end
the iteration with the step marked `errored` and the reason in its row, whatever
the run's `stopOnError` says - unlike a script that threw, which the iteration
continues past:

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

## Custom metrics (`pm.metrics`)

A script can record a named value beside the run's built-in phases (issue
#1500) - the scripted counterpart of the `metric.record` element
(`elements.md`):

```javascript
pm.metrics.trend('ttfb', pm.response.responseTime);      // one distribution sample
pm.metrics.counter('bytesOut', pm.response.size().total); // added to a running total
pm.metrics.counter('hits');                                // increment defaults to 1
pm.metrics.rate('cacheHit', pm.response.headers.get('X-Cache') === 'HIT'); // one true/false sample
```

`trend` reports as a distribution (`count`/`p50`/`p95`/`p99`/`max` in the report's
`customMetrics.<name>`); `counter` is a running total, added to on every call, reported as `value`
beside a `count` of calls (#1937), so a counter only ever given `0` is still recorded and is judged
by a `custom.<name>.value` threshold; `rate` is the percentage of calls whose value was true. All three share the same
32-distinct-name cap the
`metric.record` element does (`api-reference.md`'s `customMetrics` section), across every name
either surface records under - a script that introduces a 33rd name past what the collection's own
`metric.record` elements already declared has that call silently do nothing, since the cap is
enforced loudly only where it can be, at `POST /collections` / `POST /requests` validate time for a
*declared* `metric.record` name.

### Where it throws

The same false-success reasoning `pm.execution` documents: a call accepted and quietly dropped is
worse than one that says why it cannot run.

| Where | What happens |
|-------|--------------|
| A single Send (`POST /execute`) | Throws - there is no run to record into |
| A load run's deferred `tests` script, and a scenario load run's deferred per-step script | Throws - a replayed sample is not the run itself |
| `trend(name, value)` / `rate(name, value)` with fewer than two arguments, or an empty `name` | `TypeError` |
| `counter(name)` with an empty `name` | `TypeError` |
| `counter(name, increment)` with a negative, `NaN`, infinite or non-numeric `increment` (an explicit `undefined` is the default `1`) | `TypeError`, and nothing is recorded |

Everywhere else - the sequential run, a scenario load run's inline `step.before`/`step.after` hooks,
and design mode's `script.pre`/`script.post` - all three methods record into that run's own
collector, the same `MetricsCollector::record_custom_metric` the `metric.record` element writes
through.

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
file said - unless the file was picked with number reading on, which hands a
script an unquoted integer or decimal cell as a number (#2540).

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
was sent, never its position in a reservoir.) An **inline** `script.pre` or
`script.post` under load reads the same three as the request it runs beside,
on both shapes (#3124): the row through `pm.iterationData`, its bare columns
through `pm.variables.get` and `{{data.column}}` through
`pm.variables.replaceIn`, beside `pm.info.iteration` and `pm.info.vu` - so a
script that correlates under load sees the row its own URL was bound with.
Without rows `pm.iterationData` stays `undefined` there too, while
`iteration` and `vu` are still set.

That is deliberate, and it is the opposite treatment to `pm.execution`
above: flow control is a *capability*, and one that silently does nothing is a
false success, so it is always bound and explains itself. A data row is *data*,
and "this run is not data-driven" is a fact a script may legitimately branch on:

```javascript
const user = pm.iterationData ? pm.iterationData.get('username') : 'default-user';
```

A stashed reference (`globalThis.saved = pm.iterationData`) does not reach a
later script at all: every script runs in a context built for it (see
[Isolation between scripts](#isolation-between-scripts)), so `globalThis.saved`
is `undefined` there.

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
records the row count (`dataRowCount`) plus the file's name and content hash
(`dataFileName`, `dataFileHash`) and how it was read (`dataFileCastNumbers`),
never its path or rows.

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
`{ "source": "pre" | "test", "scope"?: "collection" | "folder" | "request",
"level": "log" | "info" | "warn" | "error", "message": "..." }` - see
[`consoleLogs` in the API reference](api-reference.md#post-execute). The four
methods are bound to one C function distinguished by QuickJS's `magic`
argument (`setup_console`), so the level is captured at the call; it cannot be
recovered from the text afterwards, which is why it used to be lost. The app's
Console tab draws `warn` and `error` in their status tokens and labels every
non-`log` line in a gutter. `level` is the console method; which collection,
folder or request script wrote the line is `scope` (#2522), absent on a line
stored before the field.

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
had none becomes a `text` body, which goes out as `text/plain`; for any other
type set the header yourself, as above.

### Replace engine-applied auth with a custom scheme

Auth is resolved into the request *before* the script runs, so the script sees
the real header and has the last word. Removing and re-adding is how you swap
schemes rather than stack them. (A credential still waiting on a `{{name}}` is
applied after the script instead, and only if the script left no header of that
name - set one rather than delete it.)

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

### Isolation between scripts

Every script runs in a QuickJS context built for it and discarded after it.
Globals it leaves behind (`globalThis.x = 1`, an implicit `x = 1`), a replaced
`pm`, `pm.test` or `console.log`, and patches to `String.prototype`,
`Array.prototype` or `Object.prototype` are gone before the next script on the
thread starts, including one from another collection. Only the QuickJS runtime
(memory limit, deadline, class registrations) is reused. A promise job the
script queued (a `.then` callback, the rest of an `async` function after an
`await`) runs before the script ends, inside its deadline; one still queued
when the deadline or the job cap stops that drain is discarded with the
runtime, never run, and the next script starts on a new one. A
[timer](#timers-settimeout-and-setinterval) still queued then is dropped unrun
too; the queue is the engine's to free, so it costs the runtime nothing. State that should
carry from one script to the next belongs in a variable scope
(`pm.environment`, `pm.collectionVariables`, `pm.globals`).

### What a script can compute

The sandbox is QuickJS plus `pm`, `console`, the two base64 globals, the
four timer functions, Postman's legacy globals (`postman`, `tests`,
`responseBody`, ...) and nine bundled libraries, `crypto-js`, `uuid`,
`lodash`, `moment`, `csv-parse/lib/sync`, `xml2js`, `chai`, `ajv` and `tv4`
([below](#the-require-shelf)).
Available: `JSON`, `Date`, `Math`, `RegExp`, `String`, `Array`, `Object`,
`Number`, `Uint8Array`, `Promise`, `BigInt`, `encodeURIComponent`, `parseInt`
and the rest of the ES2020 built-ins, plus:

| Name | Shape |
| ---- | ----- |
| `pm.crypto.sha256(data, encoding?)` | SHA-256; `data` is a string (UTF-8) or `Uint8Array` |
| `pm.crypto.hmacSha256(key, data, encoding?)` | HMAC-SHA256; key and data take the same types |
| `pm.sendRequest(urlOrOptions, callback?)` | Send an auxiliary request, synchronously; a promise without the callback - see [above](#sending-a-request-from-a-script-pmsendrequest) |
| `btoa(binaryString)` | base64-encode one byte per code unit |
| `atob(base64)` | decode to a binary string; throws on invalid base64 |
| `setTimeout(fn, delay?, ...args)` / `setInterval(...)` | queue `fn`, run before the script ends - see [Timers](#timers-settimeout-and-setinterval) |
| `clearTimeout(id)` / `clearInterval(id)` | cancel one; the two share their ids |
| `require(name)` | The [shelf](#the-require-shelf): `require('crypto-js')`, `require('uuid')`, `require('lodash')`, `require('moment')`, `require('csv-parse/lib/sync')`, `require('xml2js')` and `require('chai')` answer the library, any other name throws |
| `CryptoJS` | The same `crypto-js` module as a global, loaded on first read |
| `_` | The same `lodash` module as a global, loaded on first read |
| `xml2Json(xml)` | Postman's synchronous XML parse over the shelf's `xml2js`, loaded on first read - see [`xml2js`](#xml2js) |
| `postman.setEnvironmentVariable(name, value)` and ten more | Postman's pre-`pm.*` helper methods, each an alias of a `pm.*` method - see [The legacy `postman` object](#the-legacy-postman-object) |
| `tests`, `responseBody`, `responseCode`, `responseHeaders`, `responseCookies`, `responseTime`, `environment`, `globals`, `data`, `iteration`, `request` | Postman's pre-`pm.*` values, read off `pm` when the script starts - see [Postman's legacy globals](#postmans-legacy-globals) |

`encoding` is `'hex'` (the default), `'base64'`, `'base64url'` or `'bytes'`;
`'bytes'` returns a `Uint8Array`, and any other value throws rather than
silently falling back to hex.

**Not** available: `crypto` / `crypto.subtle`, `TextEncoder`, `URL`,
`URLSearchParams`, `fetch`, and any module other than the shelf's. The practical
consequences: no general URL constructor - the request's own URL is already
parsed for you, see [URL parts](#url-parts-pmrequesturl) - no asymmetric
algorithm and no cipher (the digests are `pm.crypto.sha256` and the
[`crypto-js` hashers](#the-require-shelf)), and no host I/O:
`Promise`, `async`/`await` (a [top-level `await`](#top-level-await) included)
and the timers run, on queues drained before the script ends, but nothing
settles a promise after it has.
There is no `fetch`, but there **is**
[`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest), which is
synchronous and bounded; without a callback it returns a promise that is
already settled, not one waiting on a transfer in flight.

Of the libraries Postman bundles, `CryptoJS`, `_` (lodash), `uuid`, `moment`,
`csv-parse/lib/sync`, `xml2js` with its `xml2Json` global, `chai`, `ajv` and
`tv4` run (`uuid`, `moment`, `csv-parse/lib/sync`, `chai` and `ajv` have no
global, they are `require` only, as in Postman; `tv4` is a global and a module,
one object). The others (`cheerio`, `Backbone`) are absent. The editor
declares each as unusable, so a use is underlined and the hover names the
replacement; [the compatibility page](../app/pm-api-compatibility.md#not-yet-supported)
lists them.

### The `require` shelf

`require(name)` answers a **fixed shelf** of libraries Vayu bundles and throws
`Cannot find module '<name>'` for any other name, listing what is on the shelf.
There is no loader behind it: nothing is read from disk, nothing is fetched, and
a relative path or a package name that is not on the shelf is the same refusal.
The argument must be a string (anything else is a `TypeError`), and it is
matched whole: `csv-parse/lib/sync` is on the shelf and `csv-parse` is not.
Today the shelf holds nine libraries, `crypto-js`, `uuid`, `lodash`, `moment`,
`csv-parse/lib/sync`, `xml2js`, `chai`, `ajv` and `tv4`. `CryptoJS` is the
`crypto-js` module bound as a global, `_` is `lodash` and `tv4` is the `tv4`
module, so both spellings of a Postman script work; `xml2Json` is not a module
but Postman's parse function over `xml2js`, bound the same lazy way:

```javascript
const CryptoJS = require('crypto-js');
const signature = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Hex);
pm.request.headers.upsert({ key: 'X-Signature', value: signature });
```

A library is evaluated under its own stack budget, not the script's
(`constants::script_engine::SHELF_LIBRARY_STACK_SIZE`, 768 KB; a script whose
`scriptStackSize` is larger keeps it). The library is Vayu's own vendored
source, and how much native stack QuickJS's parser needs for it depends on the
toolchain: MSVC at `/Od` under AddressSanitizer overflowed the default 256 KB
`scriptStackSize` evaluating lodash and moment (#2652), while GCC at `-O0` loads
them from 46 KB and 30 KB. The script's budget is put back as soon as the
library has loaded, so the script's own recursion is limited exactly as before.

#### `crypto-js`

**It is Vayu's own code with crypto-js's shape, not the crypto-js library.** The
source is a 6 KB JavaScript shim; the hashing runs in OpenSSL through
`vayu/utils/digest.hpp`, so a digest is exact. What it covers, and all of it:

- the hashers `MD5`, `SHA1`, `SHA224`, `SHA256`, `SHA384`, `SHA512` and their
  `Hmac*` forms (`HmacSHA256(message, key)`, the argument order crypto-js
  uses), each taking a string (read as UTF-8) or a `WordArray`;
- `enc.Hex`, `enc.Latin1`, `enc.Utf8` and `enc.Base64`, each with `parse` and
  `stringify`;
- `lib.WordArray` (`create`, `toString`, `concat`, `clone`; `words` and
  `sigBytes`).

A member outside that list reads as `undefined`, as it does in a crypto-js build
without that module, so calling it throws a `TypeError`: no ciphers (`AES`, `DES`,
...), no `PBKDF2` or `EvpKDF`, no progressive `algo.*` hashers, no `SHA3` or
`RIPEMD160`, no `WordArray.random`, no `enc.Utf16`.
A wrong argument type (a number where a string or `WordArray` belongs) throws
a `TypeError` rather than hashing something other than what was written.

The covered members are one list, `CRYPTO_JS_MEMBERS`
(`include/vayu/runtime/shelf_modules.hpp`), which the Postman import's script
scan reads: a collection that uses a `CryptoJS` member outside it is named
`CryptoJS` in `meta.unsupportedScriptApis`, and one that stays inside it is not.
The scan reads a member off `CryptoJS`, `require('crypto-js')`, a name declared
with `const`, `let` or `var` as either of them, or a destructure of one
(`CryptoJsReads` in `script_api_scan.cpp`); a reassignment or a name handed
through a parameter is not followed.
`script_completions_test.cpp` fails when the list and the shim, or the list and
the editor's completions, disagree.

**Cost.** The shim is evaluated on first use in an execution, never when a
context is built, so a script that does not touch `require` or `CryptoJS` pays
nothing. First use costs about 0.55 to 0.75 ms; the evaluated module then lives
for the rest of that execution (about 22 KB of the script's 64 MB limit) and is
freed with the context. Nothing is shared between executions, so the next script
that uses it pays the first-use cost again.

#### `uuid`

`require('uuid')` is **the npm `uuid` package itself**, version 8.3.2, vendored
unmodified (`engine/vendor/uuid/`, MIT; see
[Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
The module is callable, which is how Postman's own `uuid` works, and carries
npm's members on the same value:

```javascript
const uuid = require('uuid');
pm.environment.set('requestId', uuid());          // a v4, as in Postman
pm.environment.set('traceId', uuid.v4());         // the same, spelled npm's way
pm.environment.set('stable', uuid.v5('orders', uuid.v5.DNS));
uuid.validate(pm.environment.get('requestId'));   // true
```

`v1`, `v3`, `v4`, `v5`, `NIL`, `parse`, `stringify`, `validate` and `version`
are all there, with npm's signatures (`v3.DNS` / `v3.URL` and `v5.DNS` /
`v5.URL` included, and the optional output buffer). There is **no `uuid`
global** in Vayu: a script reads it with `require` only. Postman's
`uuid()` and `uuid.v4()` draw from `Math.random`; Vayu's draw from libsodium's
CSPRNG, so a script that works in Postman works here and the values are
unpredictable rather than merely unlikely to collide. The bytes reach the
library through a `crypto.getRandomValues` that exists only inside the
library's own scope, so no script sees a `crypto` global.

**Cost.** Like `crypto-js`, it is evaluated on first `require` in an execution
and not when a context is built. First use costs about 1.2 ms in a `-O2` build
and 2.8 ms in a Debug build, nearly all of it parsing the library's single 8 KB
line ([measured](building.md#first-load-cost)); a script that never requires it
pays nothing, and nothing is shared between executions.

The Postman import's script scan reads `require('uuid')` as the library it is,
so a collection that uses it is not named in `meta.unsupportedScriptApis`.

#### `lodash`

`require('lodash')` and the `_` global are **the npm `lodash` package itself**,
version 4.17.21, the full build (`lodash.min.js`, 73,015 bytes) vendored
unmodified (`engine/vendor/lodash/`, MIT; see
[Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
It is the whole library, not a subset, so every lodash 4 function is there,
chaining (`_(list).filter(f).sum()`) included:

```javascript
const items = pm.response.json().items;
pm.environment.set('firstId', _.get(items, '[0].id'));
pm.environment.set('pages', _.chunk(items, 10).length);
const byStatus = require('lodash').groupBy(items, 'status');
pm.test('every item is grouped', () => pm.expect(_.sumBy(_.values(byStatus), 'length')).to.equal(items.length));
```

`_` and `require('lodash')` are one object within an execution, whichever the
script reaches first. Assigning `_` (`_ = something`) replaces the global
without loading lodash, and a script's own `const _ = ...` is its own. lodash
takes its CommonJS branch inside the shelf's glue, so loading it adds no global
and finds no Node: the sandbox has no `module`, `exports`, `process` or
`global`.

**Cost.** Evaluated on first read of `_` or first `require('lodash')` in an
execution, never when a context is built, so a script that touches neither pays
nothing. First use costs about 10 ms in a `-O2` build and 24 ms in a Debug
build (QuickJS parsing and running the 73 KB library, measured in a fresh
context, best of 20); the evaluated module then holds about 800 KB of the
script's 64 MB limit until the execution ends. Nothing is shared between
executions, so the next script that uses it pays again.

The Postman import's script scan does not name `_` or `require('lodash')`.

#### `moment`

`require('moment')` is **the npm `moment` package itself**, version 2.31.0, its
`min/moment.min.js` (60,887 bytes) vendored unmodified (`engine/vendor/moment/`,
MIT; see
[Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
It is the build Postman's sandbox gives `require('moment')`: plain moment,
English only, no `moment-timezone` (Postman 6.8.0 ships 2.30.1). It is reached
only through `require`, as in Postman: **there is no `moment` global**, and a
bare `moment` in a script is a `ReferenceError` unless the script declares it.

```javascript
const moment = require('moment');
pm.environment.set('expires', moment.utc().add(1, 'hour').toISOString());
pm.environment.set('stamp', moment('2026-10-21').add(1, 'day').format('YYYY-MM-DD'));
const age = moment.utc(pm.response.json().createdAt).diff(moment.utc('2026-01-01'), 'days');
```

Parsing and formatting without `utc` use the engine host's time zone, as moment
does in Node, so a script that must give the same answer everywhere uses
`moment.utc`. The build carries no locale files: `moment.locale('fr')` asks the
shelf's `require` for `./locale/fr`, is refused, and moment keeps English, so
the call returns `'en'` and throws nothing. `moment.tz` does not exist.
moment takes its CommonJS branch inside the shelf's glue, so loading it adds no
global.

**Cost.** Evaluated on the first `require('moment')` in an execution, never
when a context is built, so a script that does not require it pays nothing.
First use costs about 8 ms in a `-O2` build and 17 ms in a Debug build (QuickJS
parsing and running the 61 KB library, measured in a fresh context, median of
101; [First-load cost](building.md#first-load-cost) has the method); the
evaluated module then holds about 550 KB of the script's 64 MB limit until the
execution ends. Nothing is shared between executions, so the next script that
requires it pays again.

The Postman import's script scan does not name `require('moment')`.

#### `csv-parse`

`require('csv-parse/lib/sync')` is **the npm `csv-parse` package, version
1.2.4**: its `lib/sync.js` and the `lib/index.js` it requires, bundled by
esbuild into one 11,679-byte file (`engine/vendor/csv-parse/`, BSD-3-Clause;
see [Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
It is the version and the path Postman's sandbox gives (sandbox 6.8.0 pins
1.2.4 and exposes only `csv-parse/lib/sync`), so the options and the error
messages are the ones a Postman script was written against. The module **is
the parse function**, `parse(input, options?)`, and answers the records; there
is no global.

```javascript
const parse = require('csv-parse/lib/sync');
const rows = parse(pm.response.text(), { columns: true, skip_empty_lines: true });
pm.test('every row has an id', () => rows.forEach((row) => pm.expect(row.id).to.not.be.empty));
```

The options are 1.2.4's: `delimiter`, `rowDelimiter`, `quote`, `escape`,
`columns`, `comment`, `objname`, `relax`, `relax_column_count`,
`skip_empty_lines`, `skip_lines_with_empty_values`, `trim`, `ltrim`, `rtrim`,
`auto_parse`, `auto_parse_date`, `from` and `to`. Later majors renamed some
(`auto_parse` is `cast` and `rowDelimiter` is `record_delimiter` by 4.x), so a
script written for a newer csv-parse needs these names here as it does in
Postman.

- The input is a string. A `Buffer` is not supported; the sandbox has none.
- A malformed record throws csv-parse's own `Error`, which a script can catch:
  `Quoted field not terminated at line 3`,
  `Number of columns is inconsistent on line 2`,
  `Invalid closing quote at line 3; found "y" instead of delimiter ","`. As in
  1.2.4 itself, and so in Postman, a last record with the wrong number of
  fields and no line ending after it is dropped rather than refused.
- Only the whole name loads it. `require('csv-parse')`, csv-parse 5's
  `csv-parse/sync` and every other path under the package are refused like any
  name off the shelf.
- The bundle carries the few Node pieces the sync path reaches (a `Transform`,
  `util.inherits`, a `StringDecoder`) inside itself, so loading it adds no
  global: there is still no `Buffer`, `process` or `module` in the sandbox.

**Cost.** Evaluated on the first `require('csv-parse/lib/sync')` in an
execution, never when a context is built, so a script that does not require it
pays nothing. First use costs about 1.3 ms in a `-O2` build and 2.6 ms in a
Debug build (QuickJS parsing and running the 12 KB library, measured in a fresh
context, median of 101; [First-load cost](building.md#first-load-cost) has the
method); the evaluated module then holds about 90 KB of the script's 64 MB
limit until the execution ends. Nothing is shared between executions, so the
next script that requires it pays again.

The Postman import's script scan does not name
`require('csv-parse/lib/sync')`; it still names `require('csv-parse')` and every
other path under the package.

#### `xml2js`

`require('xml2js')` is **the npm `xml2js` package, version 0.6.2**, bundled by
esbuild with the two packages it depends on, `sax` 1.2.4 and `xmlbuilder`
11.0.1, into one 98,939-byte file (`engine/vendor/xml2js/`; xml2js and
xmlbuilder MIT, sax ISC, all three licences beside it; see
[Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
These are the versions Postman's sandbox 6.8.0 ships, so a parse answers the
shape and the error messages a Postman script was written against. The module
is xml2js's whole export: `parseString`, `parseStringPromise`, `Parser`,
`Builder`, `ValidationError`, `defaults` and `processors`.

```javascript
const xml2js = require('xml2js');
xml2js.parseString(pm.response.text(), (err, doc) => {
    pm.test('the order parsed', () => pm.expect(err).to.equal(null));
    if (!err) pm.environment.set('orderId', doc.order.id[0]);
});
const body = xml2Json(pm.response.text());   // { order: { id: '7', ... } }
```

- With xml2js's defaults every child element is an array
  (`<a><b>1</b></a>` is `{ a: { b: ['1'] } }`), attributes sit under `$` and
  an element's text beside them under `_`; `explicitArray: false` gives a
  child read once as its value and one repeated as an array.
- A document the parser refuses reaches the callback as an `Error` carrying
  sax's message (`Unclosed root tag`, `Unexpected close tag`,
  `Non-whitespace before first tag.`, `Invalid character entity`), with the
  line and column after it. Empty input is not an error: the callback is
  handed `null`.
- **When the callback runs.** With `async: false`, xml2js's default, the
  callback has run before `parseString` returns. With `async: true` the parse
  is scheduled through a zero-delay `setTimeout`, one per 10,000 characters,
  and the sandbox runs every timer before the script ends
  ([Timers](#timers-settimeout-and-setinterval)), so the callback still runs
  inside the script and a `pm.test` in it is recorded. `parseStringPromise`
  settles the same way.
- `new xml2js.Builder(options).buildObject(object)` writes XML back.
- The input is a string. The bundle carries the Node pieces xml2js reaches (an
  `EventEmitter` with `on`, `emit` and `removeAllListeners`, a `setImmediate`
  standing on `setTimeout`, and two stubs for `stream` and `string_decoder`)
  inside itself, so loading it adds no global. What was cut is the rest of
  Node's emitter: a script that calls `once` or `off` on a `Parser` gets a
  `TypeError`. A `Buffer` is not supported; the sandbox has none.
- Only the whole name loads it: `xml2js/lib/parser`, `sax` and `xmlbuilder` are
  refused like any name off the shelf.

**`xml2Json(xml)`** is Postman's own helper, the call its sandbox makes:
`parseString` with `explicitArray: false`, `trim: true` and
`mergeAttrs: false`, answering what the callback was handed, synchronously.
`xml2Json('<a><b> 1 </b><b>2</b></a>')` is `{ a: { b: ['1', '2'] } }`. A
document the parser refuses answers `undefined` (Postman drops the error, so
reach for `require('xml2js')` to see it) and empty input answers `null`.
`xml2Json` is a function over the library, not the library: `xml2Json !==
require('xml2js')`, and the module carries nothing it does not ship with. Both
share one evaluation of the library, whichever the script reaches first.
Assigning `xml2Json` replaces the global without loading anything.

**Cost.** Evaluated on the first `require('xml2js')` or first read of
`xml2Json` in an execution, never when a context is built, so a script that
touches neither pays nothing. First use costs about 16 ms in a `-O2`
build and 42 ms in a Debug build (QuickJS parsing and running the 99 KB
bundle, measured in a fresh context, median of 101;
[First-load cost](building.md#first-load-cost) has the method); the evaluated
module then holds about 900 KB of the script's 64 MB limit until the
execution ends. Nothing is shared between executions, so the next script that
uses it pays again.

The Postman import's script scan names neither `xml2Json` nor
`require('xml2js')`; it still names `require('xml2js/lib/parser')` and every
other path under the package.

#### `chai`

`require('chai')` is **the npm `chai` package, version 4.4.1**, the version
Postman's sandbox pins, bundled by esbuild with the seven packages it depends on
(`assertion-error`, `check-error`, `deep-eql`, `get-func-name`, `loupe`,
`pathval`, `type-detect`, at the versions Postman's own bundle carries) into
one 68,034-byte file (`engine/vendor/chai/`; all eight MIT, each licence beside
it; see [Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
The module is chai's whole export: `expect`, `assert`, `should`, `use`,
`config`, `AssertionError`, `Assertion`, `util` and `version` (which reads
`'4.3.8'`: chai 4.4.1's source was never bumped, and Node answers the same).

```javascript
const { expect, assert } = require('chai');
pm.test('the order is complete', () => {
    const order = pm.response.json();
    expect(order.status).to.equal('complete');
    assert.deepEqual(order.items, [{ id: 7, qty: 1 }]);
});
```

- **It is not `pm.expect`.** `pm.expect` is Vayu's own implementation of
  chai's `expect` ([`pm.expect()`](#pmexpect)); `require('chai')` is the library
  itself, a separate object, and loading it changes nothing about `pm.expect`.
- **It carries chai-postman's response assertions** (#2751), as Postman's chai
  does, so `expect(pm.response).to.have.status(200)` runs as
  `pm.response.to.have.status(200)` does: `status`, `statusCode`,
  `statusReason`, `statusCodeClass`, `header`, `body`, `jsonBody` and
  `jsonSchema` as calls; `ok`, `success`, `info`, `redirection`, `clientError`,
  `serverError`, `error`, `accepted`, `withoutContent`, `badRequest`,
  `unauthorized`, `unauthorised`, `forbidden`, `notFound`, `notAcceptable`,
  `rateLimited`, `json` and `withBody` as properties; and `responseTime` and
  `responseSize` as a call and a chain. Each forwards to the
  [native chain](#response-assertions), so the verdict and the message are
  that chain's and `.not` is its `to.not`. The target must be `pm.response`
  itself: any other value throws `TypeError: chai.<name> expects pm.response as
  the target of expect()`, rather than asserting on the execution's response
  while the script wrote about something else. `expect()`'s second argument is
  not used, as on `pm.response.to`. chai's own `ok` keeps its meaning for every
  other target. The plugin adds no member to the module, no global, and nothing
  to `pm.expect`. A failure is a Vayu `AssertionError`, not an instance of
  `chai.AssertionError`, exactly as for `pm.expect`.
- **A failure inside `pm.test` is an ordinary failed test** with chai's
  message: `expect(1).to.equal(2)` records `AssertionError: expected 1 to
  equal 2`, as a `pm.expect` failure would. Outside a `pm.test` it aborts the
  script with the same message, as any uncaught throw does. The error is an
  instance of `require('chai').AssertionError` and carries chai's `actual`,
  `expected` and `showDiff`.
- `chai.should()` defines `should` on `Object.prototype` when it is called,
  not when the module loads, so `(5).should.equal(5)` runs only after the
  call. Each script gets a fresh context, so the next script starts without it.
- `chai.use(plugin)` installs a plugin on this module only; nothing reaches
  `pm.expect`.
- What the bundle leaves out is host lookups only: `loupe`, chai's value
  printer, finds no Node `util.inspect` hook and no `process`, so a promise in a
  failure message prints as `Promise{…}`.

**Cost.** Evaluated on the first `require('chai')` in an execution, never when
a context is built, so a script that does not require it pays nothing. First
use costs about 5.5 ms in a `-O2` build and 15 ms in a Debug build (QuickJS
parsing and running the 68 KB bundle, measured in a fresh context, median of
101; [First-load cost](building.md#first-load-cost) has the method); the
evaluated module then holds about 470 KB of the script's 64 MB limit until the
execution ends. Nothing is shared between executions.

The Postman import's script scan does not name `require('chai')`.

#### `ajv`

`require('ajv')` is **the npm `ajv` package, version 6.12.5**, the version
Postman's sandbox pins (not 6.6.2: its bundle carries `strictNumbers`, which
ajv added in 6.12.3), as its own `dist/ajv.min.js` browser bundle, 122,009
bytes, vendored unmodified with the four packages it carries (`engine/vendor/ajv/`;
MIT, and `uri-js` BSD-2-Clause, each licence beside it; see
[Vendored JavaScript libraries](building.md#vendored-javascript-libraries)).
The module is the `Ajv` constructor, callable with or without `new`, with
`ValidationError` and `MissingRefError` on it, and it has no global:

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

It validates draft-07 and adds no other meta-schema, so a `$schema` naming
draft-04 or draft-06 is refused until a script calls `addMetaSchema`, as in
Postman. `validate.errors` is ajv 6's array (`dataPath`, `schemaPath`,
`message`), `null` after a pass. ajv compiles each schema into a function with
`new Function`, which the sandbox allows. `require('ajv/lib/ajv')`, `ajv-formats`
and every other path throw like any name off the shelf.

**It is not what `jsonSchema` runs.** `pm.expect(x).to.have.jsonSchema` and
`pm.response.to.have.jsonSchema` stay on the engine's native validator, which
loads no library and compiles no schema. The two must give a script the
same verdict on the draft-07 vocabulary both cover, so a script ported from
Postman does not pass on one and fail on the other.
`engine/tests/script_json_schema_conformance_test.cpp` pins that: it runs
every datum of `engine/tests/fixtures/json-schema-conformance.json` through
ajv, tv4 (where the schema is in its draft-04 reach) and `jsonSchema`, and
fails on any disagreement. The fixture also records the data they answer
differently, and the test fails when a recorded answer changes, until the row
moves into the agreed cases:

- `format: 'date'` and `'time'`: ajv's default `fast` mode accepts
  `2024-13-01`, `2024-02-30` and `25:00:00Z`, and accepts a time with no offset
  (`03:04:05`) in both of its modes. `jsonSchema` checks the calendar and the
  range and requires the offset, as RFC 3339 does.
- `multipleOf` with a decimal: ajv divides in binary floating point, so
  `{"multipleOf": 0.01}` rejects `0.07` and `19.99` unless `multipleOfPrecision`
  is set. `jsonSchema` answers the decimal question and passes both.

The keywords `jsonSchema` refuses to pass on (2019-09 and later, and OpenAPI's
`nullable` and `discriminator`) are the ones ajv 6 ignores, so a schema that
uses one passes `ajv` with the keyword left out and fails `jsonSchema` naming
it. A `propertyNames` below the schema root is the one exception: ajv
evaluates it and `jsonSchema` does not, so ajv can reject a body that
`jsonSchema` only discloses.

**Cost.** Evaluated on an execution's first `require('ajv')`, never when a
context is built, so a script that does not require it pays nothing. The first
load costs about 21 ms in a `-O2` build and 55 ms in a Debug build, the
shelf's dearest ([First-load cost](building.md#first-load-cost) has the
method), and the first `compile` and a call 10 ms and 35 ms more, most of it
compiling the draft-07 meta-schema the schema is checked against. The evaluated
module holds about 1,000 KB of the script's 64 MB limit until the execution
ends. A compile runs on the script's own stack: the measured schema (four
levels of nesting, `allErrors` on) needed between 48 and 64 KB in a gcc `-O0`
build, inside the 256 KB default. MSVC at `/Od` under ASan needed more and
overflowed 512 KB in the test suite, which therefore gives its test engine more
stack (#2684 in [what the sanitizer matrix
found](building.md#what-the-matrix-found-and-where-it-stands)); the default is
unchanged. Nothing is shared between executions.

The Postman import's script scan does not name `require('ajv')`.

#### `tv4`

`require('tv4')` and the bare `tv4` global are **the npm `tv4` package, version
1.3.0**, the version Postman's sandbox pins, and one object, as in Postman.
Postman deprecates the global in favour of `require('ajv')`; it still runs
there, so it runs here. tv4 is released into the public domain (MIT as the
alternative). The package ships no minified build, so
`engine/vendor/tv4/tv4.min.js` is its `tv4.js` minified by esbuild, 28,767
bytes, and `engine/vendor/tv4/README.md` has the command that reproduces it byte
for byte.

```javascript
const body = pm.response.json();
pm.test('the body matches the schema', () => {
    pm.expect(tv4.validate(body, { type: 'object', required: ['id'] }), tv4.error && tv4.error.message).to.be.true;
});
```

tv4 is a draft-04 validator. A draft-06 or draft-07 keyword (`const`,
`contains`, `propertyNames`, `if`/`then`/`else`, a numeric `exclusiveMinimum`)
is ignored, and `format` is checked only for a name a script registers with
`addFormat`; use `require('ajv')` for those. tv4 keeps the last verdict on the
object (`tv4.error`, `tv4.missing`, `tv4.valid`), so the global and the module
share it, whichever is read first. The messages are English, as in Postman.

**One difference from Postman.** The shelf evaluates every library in strict
mode, and Postman's bundle runs sloppy. A method called detached from the
object (`const v = tv4.validate; v(data, schema)`) throws a `TypeError` here,
where Postman writes `error`, `missing` and `valid` onto the global object.
Called as `tv4.validate(...)` it behaves the same. Minification renames tv4's
internal constructors, so an error's stack names a minified function, as it
does in Postman's own bundle.

**Cost.** Evaluated on the first `require('tv4')` or read of `tv4` in an
execution, never when a context is built. The first load costs about 2.7 ms in
a `-O2` build and 6.5 ms in a Debug build, and a first `tv4.validate` of a
four-level schema 0.12 ms and 0.37 ms more; the evaluated module holds about
190 KB of the script's memory. `require('tv4/tv4.js')` and every other path
throw like any name off the shelf. The Postman import's script scan does not
name `require('tv4')` or `tv4`.

The libraries Postman also lets a script `require` or reach as a global -
`cheerio`, `Backbone`, Node's built-ins (`crypto`, `fs`, `buffer`, ...) and
`csv-parse` at any path but `csv-parse/lib/sync` - are **not** on the shelf, and
stay unshipped on purpose: `require` of one throws, the editor declares
`cheerio` and `Backbone` as unusable, and a Postman import names the script
that uses one. [The compatibility
page](../app/pm-api-compatibility.md#the-require-shelf) has the same list from
the Postman side.

**Why the hashing surface is not called `crypto`.** Web Crypto's `crypto.subtle`
is Promise-based and covers algorithms this sandbox does not implement, so a
script written against that name would meet a different surface. Vayu
therefore takes a name of its own and is honestly synchronous. `btoa` and
`atob` keep their standard names because they are synchronous on the web too,
and they keep the rest of their semantics with them: they operate on **binary
strings**, one byte per code unit, so `btoa` throws on a code point above U+00FF
rather than silently UTF-8 encoding it.

Both halves of this list are pinned by tests in
`engine/tests/script_engine_test.cpp`, so if a global is ever added or removed
this section is what needs rewriting.

### Timers (`setTimeout` and `setInterval`)

`setTimeout(fn, delay, ...args)` and `setInterval(fn, delay, ...args)` queue
`fn`, return an id, and `clearTimeout(id)` / `clearInterval(id)` cancel it (the
two share their ids, so either cancels either). Every timer runs **before the
script ends**: the request is not sent, and a test script's results are not
read, until the queue is empty (#2577). That is Postman's rule too - its
sandbox waits for every timer before it reports.

```javascript
setTimeout(function (label) {
    pm.test(label, function () {
        pm.expect(pm.response.code).to.equal(200);
    });
}, 100, "status, checked from a timer");
```

**The delay orders the callbacks; it is not waited out.** The queue runs on a
virtual clock: firing a timer moves the clock to its due time, so callbacks run
in due order (a tie to the one queued first) and the promise jobs each callback
queues run before the next timer, as on an event loop. Nothing sleeps:
`setTimeout(fn, 60000)` runs `fn` as soon as the work ahead of it has, and
`Date.now()` does not advance by the delay. A delay that is not a number from 1 to 2147483647
counts as 1, Node's rule. **A `setTimeout` written as a sleep therefore does not
delay the request** - in Postman it would, inside the script's deadline; in
Vayu that is a [Think time element](./elements.md) (`timer.think`), which
waits without holding a script open.

What runs in a timer is a script like any other. `pm.test` inside one records a
test, a promise a timer resolves settles before the script ends, and a callback
that throws is the script's error while the rest of the queue still runs - the
rule a throw in the script body follows. `fn` must be a function: a string is
refused with a `TypeError` rather than evaluated. One script may hold at most
10,000 pending timers (`MAX_PENDING_TIMERS`); the queue lives outside the
script's memory limit, so this is what bounds it.

**An interval nothing clears ends the script with an error.** Clear it from its
own callback when it is done. Otherwise it runs until the deadline stops it,
`Script execution timed out after <n>ms`. (Only an engine run with no deadline
at all, which no setting produces, falls to the cap on asynchronous work in
[Limitations](#limitations).)

### Top-level `await`

A script runs as the body of an async function, the wrapper Postman puts around
every script (#2577), so `await` works at the top level and a top-level
`return` still ends the script early:

```javascript
const code = await Promise.resolve(pm.response.code);
if (code !== 200) return;
pm.test('the lines after an await run', function () {
    pm.expect(pm.response.json()).to.be.an('object');
});
```

The lines after an `await` run when the queues drain, inside the script's
deadline, so a body awaiting a [timer](#timers-settimeout-and-setinterval)'s
promise resumes when that timer fires on the virtual clock, after the timers
due before it. A throw, before the first `await` or after one, is the script's
error and reads as the throw itself (`Error: x`), never as
`Unhandled promise rejection`; a timer callback's throw and the body's are
reported in the order they happened. A body still awaiting when both queues
are empty is waiting on a promise nothing can settle any more, so its
remaining lines never run, and the script ends with `The script did not
finish: it was still awaiting a promise that never settled`. The wrapper adds
no line, so a line number in a stack is the script's own.

### The legacy `postman` object

`postman` holds Postman's eleven pre-`pm.*` helper methods (#2577), bound in
`engine/src/runtime/pm/pm_legacy.cpp`. Each is an alias of the `pm.*` method
Postman names as its replacement (`LEGACY_GLOBS_ALTERNATIVES` in
postman-sandbox), and passes on exactly the arguments Postman's
`postman-legacy-interface.js` does:

| `postman.` | Calls |
| ---------- | ----- |
| `setEnvironmentVariable(name, value)`, `getEnvironmentVariable(name)`, `clearEnvironmentVariable(name)`, `clearEnvironmentVariables()` | `pm.environment.set`, `get`, `unset`, `clear` |
| `setGlobalVariable(name, value)`, `getGlobalVariable(name)`, `clearGlobalVariable(name)`, `clearGlobalVariables()` | `pm.globals.set`, `get`, `unset`, `clear` |
| `setNextRequest(name)` | `pm.execution.setNextRequest` |
| `getResponseHeader(name)` | `pm.response.headers.get` |
| `getResponseCookie(name)` | the cookie `pm.cookies.get` reads, as the object `pm.cookies.all()` lists |

```javascript
postman.setEnvironmentVariable("count", 5);
pm.test("the legacy setter stores a string", function () {
    pm.expect(pm.environment.get("count")).to.equal("5");
});
```

Three rules come from Postman's interface rather than from the `pm.*` method:

- The two setters store `value.toString()` for a truthy value that has one, so
  a number or an object reads back as its string; `false`, `0`, `""`, `null`
  and `undefined` reach `set` as they are.
- `getResponseHeader` and `getResponseCookie` are bound only when the execution
  has a response, so a pre-request script's `postman` lacks them.
- Each method's targets are read when `postman` is bound, so a script that
  reassigns `pm` or one of its members does not redirect a legacy call.

Every other behaviour, refusals included, is the `pm.*` method's:
`postman.setNextRequest` outside a collection run throws the
`pm.execution.setNextRequest is not available here` sentence, and
`postman.getResponseCookie` without a jar throws `pm.cookies.get`'s. Postman's
once-per-method deprecation warning is not written.

The `environment` and `globals` setters and clears also write through to the
snapshot of that name below, before calling the `pm.*` method, as
`postman-legacy-interface.js` writes through to its `__environment` and
`__globals`.

### Postman's legacy globals

The values postman-sandbox's legacy interface binds beside `postman` (#2577),
in the same file. Each is set on the global object per execution, once the
`pm.*` surfaces are refreshed, and read off the `pm.*` member Postman names as
its replacement, so the two spellings cannot answer differently:

| Global | Value | Read off |
| ------ | ----- | -------- |
| `tests` | `{}`; each property assigned becomes a test result | - |
| `environment`, `globals` | the scope's variables as a plain object, a snapshot | `pm.environment.toObject()`, `pm.globals.toObject()` |
| `data` | the iteration's row, `{}` without one | `pm.iterationData.toObject()` |
| `iteration` | `ScriptContext::iteration`, `0` without one | what `pm.info.iteration` reads |
| `request` | `{ id, name, headers, method, url, data }` in Postman's legacy shape | the request `pm.request` reads |
| `responseBody` | the body text | `pm.response.text()` |
| `responseCode` | `{ name, detail, code, standardName }` | the response `pm.response.code` and `reason()` read |
| `responseHeaders` | header name to value, as received | `Response::header_lines`, the folded map without them |
| `responseTime` | milliseconds | `pm.response.responseTime` |
| `responseCookies` | the jar's cookies for the URL, on first read | `pm.cookies.all()` |

```javascript
tests["Status code is 200"] = responseCode.code === 200;
var jsonData = JSON.parse(responseBody);
tests["Has an id"] = jsonData.id !== undefined;
```

The rules, each Postman's:

- **`tests` is read after the script.** `record_legacy_tests` runs once the
  queues have drained, before the results are copied, and appends a row per
  own enumerable key, in key order, after the `pm.test` rows: passed when the
  value is truthy, failed with `AssertionError: expected <value> to be truthy`
  otherwise. It reads the object it bound (`ContextData::legacy_tests`), not
  whatever the global names by then, and it runs after a throw too.
- **The five `response*` globals are bound only when the execution has a
  response.** A pre-request script has the other six.
- **`environment` and `globals` are snapshots** taken when the script starts.
  Writing to one changes no variable and `pm.*.set` does not update it; only
  the `postman` setters and clears write through, above.
- **`responseHeaders` keeps each name as received**, the last of a repeated
  one winning, from `Response::header_lines`. The load path keeps no lines, so
  there it is the folded, lower-cased map.
- **`responseCookies` is an accessor that replaces itself** with what
  `pm.cookies.all()` answers on its first read, as `pm.response.cookies` does,
  so a script that never reads it never reads the jar, and where there is no
  jar the read throws `pm.cookies`' refusal. An assignment replaces it as it
  would any global.
- **`request`** lower-cases each header name and holds a repeated one as an
  array (`toObject(true, false, true, true)` in Postman), over the header set
  `pm.request.headers` shows (`script_request_header_lines`). `data` is a form
  body's enabled fields (a repeated field as an array, an empty first value
  replaced, as Postman's form reader does), a text body's text, and `{}` for
  no body, an empty one, a file or GraphQL.
- **`responseCode.detail` is `""`.** Postman fills it from `http-reasons`, a
  paragraph per status that Vayu does not carry; the empty string is Postman's
  own fallback. `name` is the reason phrase `pm.response.reason()` answers and
  `standardName` the registered one.

The script runs inside a function, so a script's own `const data` or
`let responseBody` is a local that shadows the global, and an assignment with
no declaration (`data = ...`) writes the global, sloppy mode's rule.

### Visualizer (`pm.visualizer`)

`pm.visualizer.set(template, data, options)` and `pm.visualizer.clear()`
(#2577, `engine/src/runtime/pm/pm_visualizer.cpp`) are bound so a Postman
script that draws a visualization keeps running: Postman renders a Handlebars
template in its Visualize tab and Vayu has no such tab. A call is accepted,
pushes one `console.warn` line beginning `visualizer not rendered`, and returns
`undefined`. Nothing is stored: the template and data are not read, there is no
trace field for them, and the line in the script's console output is the only
record. `set` refuses a first argument that is not a string with a `TypeError`
and takes `data` and `options` as given. Both calls exist in a
pre-request and a test script alike. The import scan no longer names
`pm.visualizer`.

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
  `Array.prototype.at`, `Object.hasOwn`, `String.prototype.replaceAll`, the
  ES2023 copying methods (`toSorted`, `toReversed`, `with`), `findLast`,
  `Object.groupBy` and `Promise.withResolvers`. The script editor's type
  declarations use TypeScript's `esnext` library, so none of them is marked as
  an error. This section used to say the opposite, listing `?.` and `??` as
  "ES2021+" and unavailable - wrong on both counts, so any workaround written
  around that claim can go. What limits a script is the global list above, not the syntax.
- **No host globals**: no `fetch`, `URL`, `TextEncoder`,
  `structuredClone` or `crypto.subtle` - see the table above for what replaces
  the ones that have a replacement. The timers are there, and run before the
  script ends without waiting ([Timers](#timers-settimeout-and-setinterval)).
- **No Node.js APIs**: `require()` answers only the
  [shelf](#the-require-shelf) (`crypto-js`, `uuid`, `lodash`, `moment`); `fs`, `http`, `crypto`
  and every other module throw `Cannot find module`.
- **Sandboxed**: No filesystem access. The only network access is
  [`pm.sendRequest`](#sending-a-request-from-a-script-pmsendrequest) - capped at
  10 requests per script, bounded by the script's own deadline and by the
  response byte bound its path reads, and refused outright for agent-started
  runs.
- **Memory limit**: 64MB per script execution
- **Stack size**: 256KB per script execution (default), configurable through
  `scriptStackSize` from 64KB to 256KB, so it can only be lowered. QuickJS
  measures its ceiling from where the runtime is created, already some frames
  into the worker thread, and a secondary thread has 512KB on macOS (Windows
  gives 1MB) - no engine thread sets its own stack size - so a 512KB ceiling
  would overflow the native thread before QuickJS could refuse the recursion;
  256KB is the size proven on it. A value an older engine stored above it is
  read as 256KB.
- **Timeout**: 5 seconds per script (default), enforced by a wall-clock deadline - an
  infinite-loop script is aborted and reported as an error rather than hanging the
  engine. Configurable via the `scriptTimeout` setting (milliseconds, 1 to 60000);
  there is no way to turn the limit off, and a `0` stored by an older engine
  (it meant "no limit") is read as the 5s default. The deadline is checked *between bytecode operations*, so it cannot
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
  **The deadline covers the promise jobs and the timers too** (#2531,
  #2577): the queues a script leaves are drained inside the same budget,
  checked between jobs and timer callbacks as well as inside one, so a runaway
  `while (true) await null;` or an uncleared `setInterval` stops with the same
  `Script execution timed out after <n>ms`. The setting always yields a
  deadline (#2359), so the drain is bounded by it; only an engine started with
  no deadline at all (an embedder or a test) has none, and there the drain stops
  after 100,000 jobs and timer callbacks together
  (`MAX_ASYNC_JOBS_WITHOUT_TIMEOUT`) with its own message, `Script stopped
  after running 100000 promise jobs and timer callbacks: ...`. A job or timer
  left queued by either stop is never run.

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` - method, url, headers and body - and the edits are
  applied to the request that is sent
  ([rules](#mutating-the-request-pre-request-scripts))
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Cannot access `pm.response` (request hasn't been sent yet)
- `pm.info.eventName` is `"prerequest"` here
- Run in Design Mode / Send and in a collection run. Under load a pre-request
  script runs only when it is opted in inline (`config.inline: true`, or the
  run's `elements.scripts` override; see
  [Script elements](#script-elements-design-send-and-the-sequential-run) and
  [Load Test Scripts](#load-test-scripts)). A step that is not inlined is not
  silent about it (issue #1503): a load run reports each as
  `preRequestScript: "skipped"` in its `scenario.steps` breakdown, and the
  run's `warnings` array carries one line naming how many steps did (see
  [api-reference.md](api-reference.md#the-scenario-block-collection-runs)).

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
- The app tells the user this before Start: the load-test dialog's "Tests run
  afterwards, on a sample" notice names the defaults (1 in 100 responses, at most
  1,000) and that `assert.*` elements still check every response
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
- Results are aggregated and reported in the final report: `testsPassed` /
  `testsFailed` tally every `pm.test` call across every sampled response, so a
  script whose assertions are a mix of passing and failing reports both counts
  and names each failing assertion (`name: message`) rather than collapsing
  the sample to one opaque failure. Only a script that threw before any
  `pm.test` ran reports a single script-level failure, carrying the thrown
  message (issue #1502)
- `pm.info` reports the same identity a Send does: `eventName` is `"test"`, and
  `requestId` / `requestName` are the run's linked request when it has one. It
  also reports `iteration` - the index the sampled submission claimed before it
  was sent - and `vu`, which is `1` here because a single request repeated is
  one user's iterations (issue #994; see [`pm.info`](#script-identity-pminfo))
- `pm.response.redirects` is **absent** here, inline or deferred: a load run
  follows redirects without recording the chain, so there is no list to read and
  an empty one would claim there was nothing to find (see
  [`pm.response.redirects`](#pmresponseredirects---the-hops-a-send-followed))
- `POST /runs` no longer takes a `tests` field: it is refused with a `400`
  naming `requestElements`, like every legacy script field. The collection chain's
  test scripts arrive as `script.post` elements in `requestElements`, ahead of
  the request's own, so a collection-level assertion is checked under load, not
  only in design mode. Each element not running inline is folded into the one
  deferred replay, their texts joined in order; an inline one runs in its own
  context instead (see
  [Script elements](#script-elements-design-send-and-the-sequential-run)
  below)
- For a pre-request script that is **not** inlined, a value it would have set -
  a token fetched and written with `pm.environment.set` - never reaches a
  later step or request under load, because the script that would set it never
  runs (an inline one writes through the virtual user's own overlay, below).
  The `{{token}}` it
  was meant to fill goes on the wire literally instead of being refused, and
  since issue #1503 the run counts it: `unresolvedTokens` per step, and one
  line in the run's `warnings` array naming a few of the affected variables
  (see [api-reference.md](api-reference.md#the-scenario-block-collection-runs))

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
sequence that already happened - and a deferred step script never runs inline
(a step script marked `inline` ran during the run instead; see
[Script elements](#script-elements-design-send-and-the-sequential-run)).

## Script elements (design send and the sequential run)

Issue #1514 cut `POST /execute` and the stored resources (`POST`/`PUT
/collections`, `POST`/`PUT /requests`) over to `elements` for good - a clean
cut, not a transitional alias. `preRequestScript`, `preRequestScripts`,
`postRequestScript`, `postRequestScripts` and `tests` are all refused with a
`400` naming `elements` as the replacement (`null` is accepted as a no-op; a
real value is not). A script is now a `script.pre` or `script.post` **element**
- `{"kind": "script.pre" | "script.post", "config": {"script": "..."}}` -
compiled and run by `vayu::core::ElementPipeline` at `step.before` /
`step.after` alongside every other element kind. See
[elements.md](elements.md).

**Each script element runs its own script, independently - there is no more
joined-parts scope.** A design send's or a sequential step's compiled list
can carry more than one `script.pre` element (one folded from the collection,
one from the request, say), and the pipeline calls each one's `apply` in
list order, but every call opens a **fresh** `ScriptContext` - there is no
longer a blank-line join that ran the collection's and the request's text as
one script in one shared scope. A `const` or `let` one `script.pre` element
declares is **not** visible to the next one. State that is meant to carry
across them has to go through a store the elements share instead:
`pm.environment` / `pm.collectionVariables` / `pm.globals` / `pm.iterationData`
read back whatever an earlier element wrote, and a `pm.request` edit is
visible to a later `script.pre` element (and to the send itself) because
every element at a step shares the one `Request` object being sent - only the
JavaScript variable scope is per-element. The same holds for `script.post`
elements and `pm.response`.

**Every level is run and every level is reported (#2522).** The elements run
collection first, then each folder from the outermost in, then the request,
and each script's result is added to the step's rather than replacing the
level before it. Every `testResults` and `consoleLogs` entry carries `scope`
(`"collection"`, `"folder"` or `"request"`); a failing `pm.test` at any level
fails the step; an `assert.*` element's result survives a later level's script;
and a script that asked for no flow control does not cancel a skip or jump an
earlier level set (a later instruction does replace it). **A throw names its
level**: when the collection's or a folder's script throws, the collection-run
step error and the send's `preScriptError` / `postScriptError` read
"Collection pre-request script failed - <message>" or "Folder test script
failed - <message>"; the request's own throw reads as it always did. When
several levels throw, the first one is the step's error, and every level's own
message stays on its element's `elements[]` outcome.

**A single-request `POST /runs` runs the element pipeline too now (issue
#1594), and no longer joins.** It calls `refuse_legacy_script_fields` the
same as `POST /execute` - `tests` / `postRequestScripts` / `postRequestScript`
/ `preRequestScript(s)` are all refused with a `400` naming `elements` - and
reads its own step-level elements off a new field, `requestElements`, a
distinct key from this endpoint's own `elements` (the run-level
`timers`/`scripts` override, below). Each `script.pre` / `script.post`
element there runs its own script independently, opening a fresh
`ScriptContext` per element, exactly like a design send's or a sequential
step's compiled list above - there is no blank-line join here either.

**A scenario load run's `elements` run inline now (issue #1495), opt-in per
element.** `submit_one` (the producer, one virtual user at a time) runs
`step.before` before binding and submitting; the completion runs `step.after`
once the response is in hand. `extract.*`, `assert.*` and `metric.record` always run there. A
`script.pre` / `script.post` element runs there only when its own
`config.inline` is `true`, or the run's `elements.scripts` override
(`"allInline"` / `"allDeferred"`, beside the default `"asMarked"`) forces it
one way or the other - unmarked, a step's scripts still defer to the post-run
`tests` replay exactly as before this issue, and the replay itself now skips a
step whose script already ran inline rather than running it twice.

Every virtual user (VU) gets its own small write layer over the run's shared
variable scopes (`ScopeOverlay`, on the VU): what one VU's inline
`extract.*` or `script.*` writes on step 1 is visible to *that VU's* step 2,
and invisible to every other VU's concurrent step 2 - two VUs sharing one
name would otherwise read and overwrite each other's state, which is exactly
the correlation-under-load bug this issue exists to fix. `pm.execution` still
throws under load (`in_scenario` is `false`): an inline script can write
state and mutate the request, the same way `script.pre` always could, but it
cannot redirect the sequence - that stays the deferred replay's own script
and, eventually, a `control.*` element's job, neither of which runs inline.
What the overlay holds for the environment, collection and globals scopes
lives as long as the VU (#3044), so a `control.once` login's token reaches
every later iteration; only its run-local scope is emptied at the iteration
boundary, where `pm.cookies`' per-VU jar is. An inline script's `unset()` or
`clear()` of a name the run loaded hides that stored value from the same VU
alone, until a later write sets the name again (#3088).

**A single-request load run's `requestElements` dispatch the same way, per
submission rather than per VU (issue #1594) - there is no persistent VU
object on this path to hold state across submissions.** `submit_one_request`
runs `step.before` immediately before the transfer and `step.after` once the
response is in; `extract.*` / `assert.*` run there unconditionally, and a
`script.pre` / `script.post` element runs inline only when its own
`config.inline` is `true` or the run's `elements.scripts` override forces it,
`RunContext::script_element_runs_inline` deciding exactly as it does for a
scenario step. An unmarked `script.post` still defers - to this run's own
completion replay, not a scenario's - and an unmarked `script.pre` simply
never runs, because there is no pre-request replay to defer it to. Each
submission gets its own fresh `ScopeOverlay`, discarded after, so a
`pm.environment.set` one submission's inline script makes is visible to that
same submission's own residual-token pass and later steps, never to a
concurrent submission's. `timer.think` costs no new thread here either:
`RunContext::reserve_think_wait` folds its wait into the same
`maintain_concurrency` in-flight accounting every load strategy already
polls, rather than blocking a worker.

See [`elements.md`](elements.md#load-paths) for the full mechanics -
`ScopeOverlay`, the per-thread `ScriptEngine`, `elements.includeScriptTime`,
and what remains deliberately unwired on the single-request path
(`control.*` - a lone request has no sequence for a controller to jump or
gate).

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

In a collection run an uncaught error marks the step `errored`, with the message
on its row, and the iteration moves on to the next request, as Postman's runner
does; `stopOnError: true` on the run ends the iteration there instead. See
[Flow control](#flow-control-pmexecution) for what happens to a redirect the
script made before it threw.

## Best Practices

1. **Use descriptive test names**: `pm.test('Status code is 200', ...)`
2. **Validate structure before accessing**: Check if JSON exists before accessing properties
3. **Use environment variables**: Store sensitive data in environments, not scripts
4. **Keep scripts simple**: Complex logic should be in your application code
5. **Log debugging info**: Use `console.log()` to debug script issues

## API Reference

For complete API documentation, see the [Scripting Completions API](api-reference.md#scripting) which lists all available `pm.*` functions and properties.
