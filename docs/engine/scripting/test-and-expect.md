---
description: >-
  `pm.test()` and `pm.expect()`: how a test is declared and reported, and every assertion the Chai-style `expect` offers.
---

# The `pm` Object

## pm.test()

Define a test with assertions.

```javascript
pm.test('Test name', function() {
  // Assertions here
});
```

**Both scripts may assert.**
`pm.test` is available in a pre-request script as well as a test script - the response is not there yet, but a [`pm.sendRequest`](send-request.md#sending-a-request-from-a-script-pmsendrequest) the script just made is, and a token fetch that came back empty is worth catching before the request goes out.
Every assertion is reported with the script that made it: each entry in the response body's and the stored trace's `testResults` carries a `source` of `"pre"` or `"test"`, the same two spellings `consoleLogs` uses, and the app's Tests pane groups the list under the script's name (issue #810).
A failing assertion fails its collection-run step from either script.
**Every level asserts too**: the collection's and each folder's scripts run before the request's own, and every level's assertions are listed, each naming its level in `scope` (`"collection"`, `"folder"` or `"request"`, #2522), so a collection-level `pm.test` that fails fails the step even when the request's own tests pass.

**`pm.test` returns `pm`, so calls chain** - Postman's contract, and what an imported script written as one `pm.test(...).test(...)` expression relies on:

```javascript
pm.test('status', function() {
  pm.response.to.have.status(200);
}).test('body', function() {
  pm.expect(pm.response.json().id).to.equal(1);
});
```

**A callback that declares a parameter is handed `done`** (issue #1004). postman-sandbox reads the callback's arity to decide this and so does Vayu, so the zero-argument form above is untouched: `done()` completes the test, and `done(err)` fails it with `err` - any truthy argument, an `Error` being the documented one.

```javascript
pm.test('the token came back', function(done) {
  pm.sendRequest(tokenRequest, function(err, res) {
    if (err) { return done(err); }
    pm.expect(res.json().access_token).to.be.a('string');
    done();
  });
});
```

**`done()` must be called before the callback returns, and this is a divergence: Postman genuinely waits.**
Vayu judges a done-style test when its callback returns; a `done()` left for later (in a `.then`, or after an `await`) runs only when the job queue drains after the script, once the row is already written.
A callback that declares `done` and returns without calling it therefore **fails**, saying so - rather than being reported on a verdict nothing ever gave.
Calling `done()` twice is refused for the same reason the first verdict is kept: the second call throws, and the throw fails the test naming what happened.

**An `async` callback's test passes when it returns, as in Postman** (issue #2531). postman-sandbox records the row without awaiting the promise, and so does Vayu.
What the promise does afterwards is still reported: the job queue is drained before the script's results are read, so the code after an `await` runs, and a rejection nothing handles is a **script error** on the step, `Unhandled promise rejection in test "<name>": <reason>`, with the reason written as a thrown error would be (an `AssertionError`'s message included).
A test's promise still pending after the drain can never settle, and is reported as `A promise did not settle before the script ended (returned by test "<name>")`.
The same applies outside a test: `(async () => { throw new Error("x"); })();` ends as `Unhandled promise rejection: Error: x`, while a rejection the script catches, before or after it settles, is no error.

## pm.expect()

Create Chai-style expectations for assertions.

```javascript
pm.expect(value);                  // the usual form
pm.expect(value, 'context');       // chai's second argument, see below
```

**The optional second argument is prefixed to the failure.**
It is chai's `expect(value, message)`, and it exists for the moment the assertion fails: the matcher says *what* broke and the message says *which* value it was - the third item in a loop, the request that came from the MCP path rather than the app.

```javascript
pm.expect(user.active, 'user ' + user.id).to.be.true;
// fails with: user 42: Expected false to be true
```

The message is coerced like chai's, and `undefined` / `null` mean "no message", so a conditionally built one that came out absent leaves the failure text unchanged.
It prefixes assertion failures only - a call the script wrote wrong (`.to.be.above()` with no argument) reports the misuse on its own, since the message describes a value, not a typo.

**A failed assertion throws an `AssertionError`**, the name chai uses, so a script that inspects what it caught takes the same branch it does in Postman:

```javascript
try {
  pm.expect(1).to.equal(2);        // AssertionError: Expected 1 to equal 2
} catch (e) {
  e.name;                          // 'AssertionError'
  e instanceof Error;              // true
}
```

**`pm.expect.fail([message])` fails on the spot**, as an assertion rather than as an error (issue #1004).
It is chai's `expect.fail`, and it throws the same `AssertionError` every matcher does - so *outside* a `pm.test` it aborts the script, the way any uncaught throw does.
What it changes there is the shape of the verdict, not whether the script stops: the run is reported as a failed assertion carrying this message, rather than as the `TypeError` a misuse reports.

```javascript
pm.test('no branch reached the response', function() {
  if (!pm.response.json().items) {
    pm.expect.fail('the list was absent');   // AssertionError: the list was absent
  }
});

pm.expect.fail();                            // AssertionError: expect.fail()
```

chai's four-argument form (`fail(actual, expected, message, operator)`) is **not** supported: its `AssertionError` carries the two values it compared and this one has nowhere to put them, so more than one argument is refused by name rather than read as the message - which would report `actual` as the failure text.

QuickJS has no `AssertionError` class, so this is an `Error` with that `name` and the stack a native throw carries; no `AssertionError` global is exposed, because chai's is a property of the `chai` module rather than a global.
The shelf's [`require('chai')`](require-shelf.md#chai) is that module, a separate object from `pm.expect`, so a `pm.expect` failure is not an instance of `require('chai').AssertionError`; test `e.name`.
The same name comes off the [response assertions](response-headers-and-assertions.md#response-assertions), which are chai in Postman too, whether they are written `pm.response.to.have.status(200)` or as `require('chai').expect(pm.response).to.have.status(200)` (the second forwards to the first, so the error is the same native one, and not an instance of `chai.AssertionError` either).
**A mistake in the script text is still a `TypeError`** - a matcher called with no argument, a name nothing implements - because nothing was asserted: the call itself was wrong.

**Anything the chain does not implement throws, called or not** (issue #999).
`pm.expect(x).to.be.NaN` is an expression statement, so before the chain was armed a member nothing implemented evaluated to `undefined` and the test reported PASS whatever the value was - a typo (`.to.be.trueish`) and a chai member Vayu does not have (chai-postman's `.postmanResponse`) were equally silent.
Every unimplemented name now raises a `TypeError` naming itself, the way `pm.response.to` has since #487.
That holds for a name read off a matcher or a chainable method too (#2528): a matcher is a call, so `.within.foo` and `.equal.name` are refused, and after `include`, `length` or `a` only the chain's own members resolve, so `.include.name` and `.a.foo` are refused rather than answering a function's own `name` or `undefined`.

**`equal` is strict, `eql` is deep.**
`equal` is `===`, so two objects with the same contents are *not* equal - only the same reference is.
`eql` (and its alias `deep.equal`) compares contents recursively and does not care about key order.
This matches chai, which is what Postman scripts are written against; picking the wrong one is the most common porting mistake.

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

- **`not` sets the negation for the rest of the chain; it does not flip it.** chai's rule, and the flag is never reset between assertions in one chain, so a second `.not` is a no-op rather than a double negative: `expect(s).to.not.include("+").and.to.not.include("/")` asserts that `s` contains neither.
  It used to *toggle* (issue #883), which made that same line assert that `s` **does** include `/` - a silent inversion whose direction depended only on how many times the author had written `.not`.
- **`deep` changes the comparison, it is not a matcher.**
  `include`, `property`, `members` and `oneOf` compare strictly unless a `deep` appears in the chain.
- **The language chains assert nothing** (issue #1053).
  `that`, `which`, `is`, `has`, `been`, `with`, `does`, `but`, `also`, `of`, `same` and `still` are chai's words for making a chain read as English, and each hands the same expectation back with the chain's flags - `not` included - intact.
  They are accepted anywhere in a chain, so an imported collection written in the fluent style fails on the API under test rather than on the language.
  `any`, `own` and `itself` are **not** among them: each changes what the matcher after it asserts rather than reading as prose, so each still throws by name.
  One thing the editor cannot follow: the runtime carries every matcher on one object, while the declarations nest them under `be` and `have` as the completion labels spell them, so `.that.be.a('string')` type-checks where chai's `.that.is.a('string')` does not - both run.
- **`property(name)` moves the subject to the property's value** (#2524), as in chai: `expect({id: 1}).to.have.property('id').that.is.a('number')` types the value `1`, not the object, and `.and.equal(v)` compares the value.
  With `nested` the value is the one at the last path segment, and `deep`, `nested` and the failure message carry over to the new subject.
  The value is read once, so a getter runs once.
  Two forms keep the chain they were called on: `property(name, value)` (the value was already compared) and `.not.have.property(name)` (absence has no value to move to).
  A primitive is read through its wrapper, as chai reads it (#2582), so `expect('abc').to.have.ownProperty('length')` passes; `null` and `undefined` have no property.
- **`keys` means exactly these keys**, as in chai's `have.keys`.
  `include.keys` (alias `contain.keys`) asks for at least these, and `any.keys` for at least one of them whether or not `include` came first; `all` is the default quantifier and the later of `any` and `all` wins.
  Names may be listed, given as one array, or given as one plain object standing for its own keys (chai's `Object.keys`), and an empty list is a `TypeError`, because `include.keys([])` would hold for every target having compared nothing (#2528).
  A `Map`'s keys are its keys and a `Set`'s its members, compared as values rather than names (`new Map([[1, 1]])` has the key `1`, not `'1'`), deeply under `deep` (#2582).
- **`include`, `own`, `ordered` and `itself` are flags the matcher after them reads** (#2528).
  Reading `include` or `contain` - as `include(x)` or as a chain word - sets chai's `contains`: `keys` and `members` then accept a superset, and `oneOf` asks whether the target contains a candidate (a substring, an element).
  `ordered.members` compares by position, and with `include` a prefix.
  `own` makes `property` and `include({...})` look at own properties only, and `nested` together with `own` is refused.
  `.length` and `.lengthOf` are a call and a chain: after one, `above`, `below`, `least`, `most` and `within` compare the length (a Map's or Set's `size`).
  A target with no length fails as chai's `to.have.property('length')` does, an `AssertionError` in both polarities, so `expect(3).to.not.have.length.within(1, 2)` fails.
  `length` directly after a chainable method (`include`, `a`, `length` itself, `responseTime`) is a `TypeError`, as chai's length guard makes it; `lengthOf` is the spelling there.
  The ordering matchers are chai's whole family, `gt` / `gte` / `lt` / `lte` and the `greaterThan...` spellings included, and `within` takes both bounds in.
- **`.a()` and `.an()` use chai's type names**: `string`, `number`, `boolean`, `null`, `undefined`, `array`, `object`, `function`, and for anything else the lower-cased tag (`date`, `regexp`, `map`, `set`, `error`, `promise`, `symbol`, `bigint`).
  Both are chai's chainable methods: read without a call they hand the chain on, so `.to.be.an.instanceof(Array)` runs, and called they return it, so `.an('array').that.includes(1)` does too.
- **`jsonSchema(schema[, options])` is draft-07** and runs on the engine's validator rather than ajv.
  A failure names the first path that broke the schema; a constraint that records no detail (`propertyNames`, a `false` schema) yields one failure at the body root that names the schema path instead.
  A keyword it cannot evaluate - one from JSON Schema 2019-09 or 2020-12 such as `unevaluatedProperties`, OpenAPI's `nullable`, or a `propertyNames` nested anywhere below the schema's root - fails the assertion in **both** polarities and is named, because ignoring it would make the schema looser (or, under `not`, stricter) and neither verdict could be trusted.
  A root `propertyNames` is evaluated; a nested one (in `properties`, `items`, an `allOf` member, a `$ref` target, ...) is not, because valijson builds it from its parent's node path and so never runs its own subschema (#2729), where ajv does evaluate it.
  A schema that refers to itself without describing any value (`A` is `{ "$ref": "#/components/schemas/A" }`, or loops through `allOf`, `anyOf`, `oneOf`, `not` or `if`) is refused: `jsonSchema` throws a `TypeError` that names the loop, as it does for any schema the validator cannot read.
  The validator would otherwise recurse until the engine died.
  A recursive schema that steps into a property or an item (a tree node) is fine.
  `options` is ajv's and is accepted and not read.
  `format` is checked for `date`, `time`, `date-time`, `ipv4`, `email`, `uri`, `uuid`, `hostname` and `ipv6`; any other name (`uri-reference`, `int64`, ...) is an annotation and passes any string, where ajv would reject some of them.
  `require('ajv')` is on [the shelf](require-shelf.md#ajv) and is the real library; `jsonSchema` stays on the engine's validator, and [where the two answer differently](require-shelf.md#ajv) is pinned.
  The declarative [`assert.jsonschema`](../elements.md) element runs on the same validator, so it shares all of the above: the draft-07 limit, the named unevaluated keywords (which fail it rather than pass it), the refused loop and the `format` list.
  It is the choice when the check should be a step's assertion row or run on a load run's cheap path, which a script step is not.
- **Every public member of chai 4.4.1's `expect` API has a row** in `engine/tests/fixtures/chai-conformance.json`, with a snippet that passes and one that fails, each checked against the real package.
  The suite holds the rows to the member names read off chai and chai-postman in both directions, so a row deleted, renamed or added for a member neither publishes fails by name, and it fails on a member the docs claim is missing from the table.
  The members that differ from chai are named in [pm-api-compatibility.md](../../app/pm-api-compatibility.md#assertion-chains-pmexpect).
- **`eql` refuses containers it cannot inspect.**
  `Map`, `Set` and typed arrays keep their contents outside the property list, so two distinct ones report *not* equal rather than silently passing.
  `Date` compares by instant and `RegExp` by pattern.
- **A throw reached through a comparison is the verdict** (#1048).
  A key, an array element or an array `length` behind a getter that throws is a read that did not happen, so the error reaches the test instead of being reported as "these differ" - which under `.not` would have been a pass.
  That holds for the reads an assertion makes before comparing, too: `include`, `oneOf`, `members`, `keys`, `property` (its nested walk included), `empty` and `length` stop at the read rather than answering about it.
  And for the rendering the `Date` and `RegExp` comparisons run: an overridden `toJSON` or `toString` that throws used to leave both sides rendered as the empty string, which compared *equal*.
  When both sides throw, the first side's error is the one reported.
- **A cycle fails loudly, at the depth it closes** (#959).
  The walk carries the pairs of objects it is already comparing, so meeting one twice is a `RangeError` naming that repetition - not a wait for a depth limit to be reached.
  The 64-level cap is still there behind it, with a message of its own, as the backstop for a structure that is merely very deeply nested.
- **`eql` separates `+0` from `-0`; `equal` does not.**
  That is chai: `equal` is `===`, under which the two zeros are one value, while `eql` is deep-eql, whose number rule is `x === y && (x !== 0 || 1/x === 1/y)`.
  The [response assertions](response-headers-and-assertions.md#response-assertions) keep the other rule, because chai-postman compares them with lodash `_.isEqual` and lodash says equal.
- **`NaN` is chai's `value !== value`**, so only the number `NaN` satisfies it - `expect('foo').to.be.NaN` fails rather than reading the string as a number.
- **`include` answers by the target's type**, as in chai: a substring of a string (a boxed `String` too), an element of an array, a member of a `Set`, a value (not a key) of a `Map`, and on any other object subset matching, every key of the argument present on the target holding an equal value.
  Comparison is strict unless the chain says `deep`; for a `Set` or a `Map` strict is SameValueZero, what `Set.prototype.has` answers.
  Any other pair is a combination chai refuses, as an `AssertionError` in both polarities, so `expect({a:1}).to.include('a')` and `expect(5).to.include('x')` fail with or without `.not` (#2582).
  Two edges are Vayu's own:
    - **An expectation with no own enumerable keys is refused**, where chai passes it in both directions.
      `expect(body).to.include({})` compares nothing, so a computed subset that came out empty would report green having asserted nothing; a `Date`, a `RegExp` and a function carry no key either and read as assertions.
      Each names itself instead.
    - **A getter that throws is reported, not compared.**
      The exception reaches the test rather than being read as "these differ", which under `.not` would have been a pass.
- **The failure message names the argument.**
  `.to.throw(TypeError)` that caught a `RangeError` says so, rather than reporting that a function which threw did not throw.
- **The ordering matchers type-assert both sides.**
  `above`, `below`, `at.least` and `at.most` take a number or a `Date` and refuse anything else, which is chai's rule: `expect('5').to.be.above(3)` used to pass here through `ToNumber`, and now names what it was given.
  They compare like with like too - a `Date` read as milliseconds against a number is a comparison neither side wrote, so the mixed pair is refused.
- **`throw` reads the error's `message`.**
  A string or a regular expression is matched against `err.message` alone, never `String(err)` - so `.to.throw('Error')` no longer passes for every `Error` thrown.
  A constructor is accepted as the first argument (`instanceof`), with an optional message matcher after it.
  A thrown string is its own message and anything else has none, which is chai's rule: `.to.throw('4')` does not pass on `throw 42`.
- **A type check chai makes as an assertion is an `AssertionError`**, in both polarities (#2582): a `members` target that is not an array, a `length` read off a target with none, an `include` pair chai has no rule for.
  **A malformed call stays a `TypeError`** where chai raises an `AssertionError`: a missing or wrong-typed argument (`members(1)`, `above()`), `keys()` with no names, `nested` with `own`, and the ordering matchers' refusal of a value that is not a number or a `Date` (`expect('5').to.be.above(3)`).
  Deliberate: nothing was asserted, and the response assertions refuse a wrong-typed argument the same way (#998).
  Both throw, so a test fails either way; what differs is `e.name`.
- **`.and` carries the chain's flags**, `not` included, exactly as in chai.
  It is a language chain like `.that`, not a return to the start of one: a matcher may follow it directly (`.and.match(/x/)`), and so may `not`.
- **The grammar is chai's: any chain word before any matcher.**
  Every word above
  - `to`, `be`, `have`, `at`, `and`, `all`, `not`, `deep`, `nested` and the language chains - is installed on the same expectation and hands it back, so the editor's declarations describe one type rather than the paths this page happens to spell (#1209).
  The examples in this section are compiled against those declarations by the app's suite, so a chain that reads correctly here is one the editor accepts.
