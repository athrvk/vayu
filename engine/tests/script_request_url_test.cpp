/**
 * @file tests/script_request_url_test.cpp
 * @brief `pm.request.url` as Postman's `Url` object (issue #991).
 *
 * The owner decision this ships is that Postman compatibility wins over the
 * string shape `pm.request.url` had. That trade has two halves and both are
 * pinned here, because only one of them is what the issue is *for*:
 *
 * - the compatibility half - a lifted Postman script reading `url.query.get`,
 *   `url.getPath()`, `url.host` runs unmodified;
 * - the mitigation half - concatenation, template literals, `==`, the generic
 *   `String.prototype` methods and `JSON.stringify` still behave as they did,
 *   because a change that quietly broke every script that treats the URL as a
 *   string would not be worth the compatibility it bought.
 *
 * The two things that genuinely changed - `===` and `typeof` - are asserted
 * **as** breaks. A documented break nothing pins is a break that comes
 * back as an accident later, and the docs would then be describing behaviour
 * the engine no longer has.
 *
 * Where an assertion could pass vacuously (an empty query list, a script that
 * threw before its `pm.test`), it is paired with something that fails if the
 * work did not happen - a count, or the value itself.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <array>
#include <string>
#include <vector>

#include "vayu/http/cookie_jar.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

#ifdef VAYU_HAS_QUICKJS

class ScriptRequestUrlTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::GET;
        request.url          = "https://api.example.com:8443/v2/"
                               "users%20list?page=2&sort=name&page=3#top";
        response.status_code = 200;
        response.status_text = "OK";
        response.body        = "{}";
    }

    /// Run @p script as a test script - the read-only view of what was sent.
    ScriptResult run_test_script (const std::string& script) {
        ScriptContext ctx;
        ctx.request     = &request;
        ctx.response    = &response;
        ctx.environment = &env;
        return engine.execute (script, ctx);
    }

    /// A single `pm.test` whose verdict is the assertion. The name is asserted
    /// too, so a script that threw before reaching its test - which produces no
    /// verdict at all - cannot read as a pass.
    void expect_script_passes (const std::string& body) {
        const ScriptResult result =
        run_test_script ("pm.test('assertion', function () {\n" + body + "\n});");
        ASSERT_TRUE (result.success) << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u) << body;
        EXPECT_EQ (result.tests[0].name, "assertion");
        EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    }
};

// ---------------------------------------------------------------------------
// The Url read surface - what a lifted Postman script reaches for.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestUrlTest, PresentsEveryPartOfTheUrl) {
    expect_script_passes (R"JS(
        var url = pm.request.url;
        pm.expect(url.protocol).to.equal('https');
        pm.expect(url.port).to.equal('8443');
        pm.expect(url.hash).to.equal('top');
        pm.expect(url.host.join('.')).to.equal('api.example.com');
        pm.expect(url.getHost()).to.equal('api.example.com');
    )JS");
}

// Decoded, and each segment on its own - "v2/users%20list" is two segments and
// the second one holds a space, not a percent escape.
TEST_F (ScriptRequestUrlTest, PathSegmentsAreDecoded) {
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.path.length).to.equal(2);
        pm.expect(pm.request.url.path[0]).to.equal('v2');
        pm.expect(pm.request.url.path[1]).to.equal('users list');
        pm.expect(pm.request.url.getPath()).to.equal('/v2/users list');
    )JS");
}

TEST_F (ScriptRequestUrlTest, QueryReadsFollowPostmansPropertyList) {
    expect_script_passes (R"JS(
        var query = pm.request.url.query;
        pm.expect(query.count()).to.equal(3);
        pm.expect(query.has('sort')).to.equal(true);
        pm.expect(query.has('nope')).to.equal(false);
        // First wins, matching PropertyList.one - `page` appears twice.
        pm.expect(query.get('page')).to.equal('2');
        pm.expect(query.get('missing')).to.equal(null);
        // Last wins is what a plain object can say, and toObject says it.
        pm.expect(query.toObject().page).to.equal('3');
    )JS");
}

// The canonicalization workhorse: wire order, duplicates kept. A map-shaped
// answer would silently drop the second `page` and sign a different string.
TEST_F (ScriptRequestUrlTest, QueryAllKeepsWireOrderAndDuplicates) {
    expect_script_passes (R"JS(
        var all = pm.request.url.query.all();
        pm.expect(all.length).to.equal(3);
        pm.expect(all.map(function (p) { return p.key + '=' + p.value; }).join('&'))
          .to.equal('page=2&sort=name&page=3');
    )JS");
}

TEST_F (ScriptRequestUrlTest, GetQueryStringIsByteExactAgainstTheWire) {
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.getQueryString()).to.equal('page=2&sort=name&page=3');
    )JS");
}

// `?flag` carries no value and `?flag=` carries an empty one. Collapsing them
// would make a rebuilt query string differ from the one that was sent.
TEST_F (ScriptRequestUrlTest, ABareQueryKeyReadsAsNullAndAnEmptyOneAsEmpty) {
    request.url = "https://example.com/s?flag&empty=";
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.query.get('flag')).to.equal(null);
        pm.expect(pm.request.url.query.has('flag')).to.equal(true);
        pm.expect(pm.request.url.query.get('empty')).to.equal('');
        pm.expect(pm.request.url.query.all()[0].value).to.equal(null);
    )JS");
}

// The query is the wire bytes. Decoding here would break every signature built
// from `all()`, which is the workflow the object exists for.
TEST_F (ScriptRequestUrlTest, QueryValuesAreNotDecoded) {
    request.url = "https://example.com/s?q=hello%20world";
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.query.get('q')).to.equal('hello%20world');
    )JS");
}

// A URL the parser cannot read still answers as a whole string; it just has no
// parts. Better than a plausible half, and better than throwing on a read.
TEST_F (ScriptRequestUrlTest, AnUnparseableUrlKeepsItsStringAndReportsNoParts) {
    request.url = "not a url at all";
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.toString()).to.equal('not a url at all');
        pm.expect(pm.request.url.host.length).to.equal(0);
        pm.expect(pm.request.url.query.count()).to.equal(0);
        pm.expect(pm.request.url.protocol).to.equal('');
    )JS");
}

/**
 * The compatibility proof this issue exists for: a script written against
 * Postman, pasted in unmodified.
 */
TEST_F (ScriptRequestUrlTest, APostmanScriptUsingTheUrlMembersRunsUnmodified) {
    const ScriptResult result = run_test_script (R"JS(
        pm.test("targets the right endpoint", function () {
            pm.expect(pm.request.url.getPath()).to.equal("/v2/users list");
            pm.expect(pm.request.url.host).to.include("example");
            pm.expect(pm.request.url.query.get("sort")).to.equal("name");
        });
        pm.test("query string is intact", function () {
            pm.expect(pm.request.url.getQueryString()).to.include("sort=name");
        });
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
}

/**
 * The payoff, end to end: a sorted canonical query of the kind an HMAC scheme
 * signs, built from `all()` alone. This is the workflow that used to need
 * hand-rolled string surgery.
 */
TEST_F (ScriptRequestUrlTest, CanonicalizesASortedQueryForSigning) {
    request.url =
    "https://api.example.com/pay?amount=10&Timestamp=99&currency=EUR";
    expect_script_passes (R"JS(
        var canonical = pm.request.url.query.all()
            .map(function (p) { return p.key + '=' + (p.value === null ? '' : p.value); })
            .sort()
            .join('&');
        pm.expect(canonical).to.equal('Timestamp=99&amount=10&currency=EUR');
        // And the signature over it is a real one, not a placeholder.
        pm.expect(pm.crypto.hmacSha256('key', canonical).length).to.equal(64);
    )JS");
}

// ---------------------------------------------------------------------------
// The string mitigations - what must NOT have changed.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestUrlTest, StillBehavesAsAStringInEveryContextItCan) {
    request.url = "https://api.example.com/users";
    expect_script_passes (R"JS(
        var url = pm.request.url;
        pm.expect('' + url).to.equal('https://api.example.com/users');
        pm.expect(`${url}`).to.equal('https://api.example.com/users');
        pm.expect(url == 'https://api.example.com/users').to.equal(true);
        pm.expect(url.startsWith('https://')).to.equal(true);
        pm.expect(url.includes('api.example.com')).to.equal(true);
        pm.expect(url.slice(0, 5)).to.equal('https');
        pm.expect(url.indexOf('/users')).to.equal(23);
        pm.expect(url.split('?')[0]).to.equal('https://api.example.com/users');
        pm.expect(url.toString()).to.equal('https://api.example.com/users');
        pm.expect(JSON.stringify({ u: url })).to.equal(
            '{"u":"https://api.example.com/users"}');
    )JS");
}

// The repo's own docs and tests spell it this way. #991 turned the target from
// a string into an object, and an assertion that silently started failing is
// the worst outcome a testing tool has.
TEST_F (ScriptRequestUrlTest, ExpectIncludeStillReadsItAsAString) {
    expect_script_passes (R"JS(
        pm.expect(pm.request.url).to.include('example.com');
        pm.expect(pm.request.url).to.not.include('nowhere.invalid');
    )JS");
}

/**
 * The two documented breaks, asserted as breaks.
 *
 * If a later change made either behave the old way again, this test fails - and
 * the docs that describe them would need rewriting, which is the point of
 * pinning them rather than leaving them to be rediscovered.
 */
TEST_F (ScriptRequestUrlTest, TheTwoDocumentedBreaksAreWhatTheDocsSay) {
    request.url = "https://api.example.com/users";
    expect_script_passes (R"JS(
        pm.expect(pm.request.url === 'https://api.example.com/users').to.equal(false);
        pm.expect(typeof pm.request.url).to.equal('object');
    )JS");
}

/**
 * `.length` is an own property, not an inherited one - and that is the whole
 * point of asserting it.
 *
 * `String.prototype` is a String exotic object holding "", so an object that
 * only inherits from it answers `0` here. Deleting the own definition makes
 * this test read 0 for a 29-character URL, which is exactly the silent wrong
 * answer the object is built to avoid.
 */
TEST_F (ScriptRequestUrlTest, LengthIsTheUrlsOwnLengthAndNotTheInheritedZero) {
    request.url = "https://api.example.com/users";
    expect_script_passes (R"JS(
        pm.expect(pm.request.url.length).to.equal(29);
        pm.expect(pm.request.url.length).to.equal(pm.request.url.toString().length);
    )JS");
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestUrlTest, StringAssignmentStillRetargetsTheRequest) {
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url = 'https://api.example.com/v3/orders?page=1';
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v3/orders?page=1");
}

// The reason `url` is an accessor rather than a plain member: a write leaves a
// Url object behind, so the parts reflect what was just assigned instead of the
// property becoming a bare string.
TEST_F (ScriptRequestUrlTest, AWriteReParsesSoThePartsFollowIt) {
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url = 'https://other.example.org/v3/orders?page=7';
        if (pm.request.url.getPath() !== '/v3/orders') {
            throw new Error('path did not follow the write: ' + pm.request.url.getPath());
        }
        if (pm.request.url.query.get('page') !== '7') {
            throw new Error('query did not follow the write');
        }
        if (pm.request.url.getHost() !== 'other.example.org') {
            throw new Error('host did not follow the write');
        }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://other.example.org/v3/orders?page=7");
}

TEST_F (ScriptRequestUrlTest, UpdateIsTheSameWriteWithPostmansSpelling) {
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.update('https://api.example.com/v3/orders');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v3/orders");
}

// Postman's update mutates in place, so a reference taken before it has to see
// it - otherwise a script and the write-back disagree about what is being sent.
TEST_F (ScriptRequestUrlTest, UpdateMutatesTheObjectAScriptAlreadyHolds) {
    const auto result = engine.execute_prerequest (R"JS(
        var url = pm.request.url;
        url.update('https://api.example.com/v3/orders');
        if (url.getPath() !== '/v3/orders') {
            throw new Error('the held reference did not follow update()');
        }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v3/orders");
}

TEST_F (ScriptRequestUrlTest, AnEmptyUrlIsStillRejectedAndAppliesNothing) {
    const std::string original = request.url;
    const auto result          = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        pm.request.url = '';
    )JS",
             request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.url"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.url, original);
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
}

// Loud at the assignment, not several lines later in the write-back: the script
// author is told which line was wrong. `[object Object]` reaching the wire is
// the silent-wrong-request class this whole program exists to close.
TEST_F (ScriptRequestUrlTest, AssigningSomethingThatIsNotAUrlThrowsAtTheAssignment) {
    const std::string original = request.url;
    for (const char* value : { "42", "{}", "null", "undefined", "['a']" }) {
        const auto result = engine.execute_prerequest (
        std::string ("pm.request.url = ") + value + ";", request, env);

        EXPECT_FALSE (result.success) << value;
        EXPECT_NE (result.error_message.find ("pm.request.url"), std::string::npos)
        << value << ": " << result.error_message;
        EXPECT_EQ (request.url, original) << value;
    }
}

// A test script's pm.request is a read-only record: the write is allowed to
// change what the script sees and must reach nothing that was sent.
TEST_F (ScriptRequestUrlTest, TestScriptWritesAreStillNotWrittenBack) {
    const std::string original = request.url;
    const ScriptResult result  = run_test_script (R"JS(
        pm.request.url = 'https://evil.example.com';
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, original);
}

// A script that replaces pm.request wholesale leaves a plain string there, and
// the write-back has to keep taking it - that shape predates the Url object.
TEST_F (ScriptRequestUrlTest, AReplacedRequestObjectMayStillCarryAPlainString) {
    const auto result = engine.execute_prerequest (R"JS(
        pm.request = { url: 'https://api.example.com/v9/ping', method: 'GET', headers: {} };
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v9/ping");
}

// ---------------------------------------------------------------------------
// Member mutation (issue #1040) - the edits that must reach the wire, and the
// untouched URL that must not be rebuilt.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestUrlTest, PushingAPathSegmentReachesTheWire) {
    request.url       = "https://api.example.com/v2/users";
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.path.push('active');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users/active");
}

// The reason the segment lists are proxies rather than arrays: every spelling
// of the mutation has to reach the URL, not just the one that was tested for.
TEST_F (ScriptRequestUrlTest, EverySpellingOfASegmentEditReachesTheWire) {
    struct Case {
        const char* script;
        const char* expected;
    };
    const std::array<Case, 5> CASES = { {
    { "pm.request.url.path[1] = 'admins';", "https://api.example.com/v2/admins" },
    { "pm.request.url.path.splice(0, 1);", "https://api.example.com/users" },
    { "pm.request.url.path.pop();", "https://api.example.com/v2" },
    { "pm.request.url.path.unshift('api');", "https://api.example.com/api/v2/users" },
    { "pm.request.url.path.length = 1;", "https://api.example.com/v2" },
    } };

    for (const auto& [script, expected] : CASES) {
        Request target    = request;
        target.url        = "https://api.example.com/v2/users";
        const auto result = engine.execute_prerequest (script, target, env);

        ASSERT_TRUE (result.success) << script << ": " << result.error_message;
        EXPECT_EQ (target.url, expected) << script;
    }
}

TEST_F (ScriptRequestUrlTest, ReplacingTheHostReachesTheWire) {
    request.url       = "https://api.example.com/v2/users";
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.host = ['api', 'staging', 'example', 'com'];
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.staging.example.com/v2/users");
}

TEST_F (ScriptRequestUrlTest, TheSingleStringPartsAreWritable) {
    request.url       = "https://api.example.com/v2/users";
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.protocol = 'http';
        pm.request.url.port = '8080';
        pm.request.url.hash = 'top';
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "http://api.example.com:8080/v2/users#top");
}

TEST_F (ScriptRequestUrlTest, TheQueryWritersReachTheWire) {
    request.url       = "https://api.example.com/s?page=2";
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.query.add({ key: 'sort', value: 'name' });
        pm.request.url.query.upsert({ key: 'page', value: '7' });
        pm.request.url.query.add({ key: 'flag' });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/s?page=7&sort=name&flag");
}

// upsert replaces in place, so a signature over the query does not silently
// change shape because a parameter moved to the end.
TEST_F (ScriptRequestUrlTest, UpsertKeepsWirePositionAndAddAppendsADuplicate) {
    request.url = "https://api.example.com/s?a=1&b=2";
    ASSERT_TRUE (engine
    .execute_prerequest ("pm.request.url.query.upsert({key:'a', value:'9'});", request, env)
    .success);
    EXPECT_EQ (request.url, "https://api.example.com/s?a=9&b=2");

    ASSERT_TRUE (engine
    .execute_prerequest ("pm.request.url.query.add({key:'a', value:'8'});", request, env)
    .success);
    EXPECT_EQ (request.url, "https://api.example.com/s?a=9&b=2&a=8");
}

// Every match, not the first: removing `page` and getting one of two back has
// removed nothing the caller can observe.
TEST_F (ScriptRequestUrlTest, RemoveTakesEveryParameterOfThatName) {
    request.url       = "https://api.example.com/s?page=1&sort=name&page=2";
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.query.remove('page');
        pm.request.url.query.remove('nothing-here');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/s?sort=name");
}

TEST_F (ScriptRequestUrlTest, ClearEmptiesTheQueryAndTheQuestionMarkWithIt) {
    request.url = "https://api.example.com/s?page=1&sort=name";
    const auto result =
    engine.execute_prerequest ("pm.request.url.query.clear();", request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/s");
}

// The reads have to follow the writes within the same script, or a script that
// edits and then signs would sign the pre-edit URL.
TEST_F (ScriptRequestUrlTest, TheReadsFollowAnEditWithinTheSameScript) {
    request.url = "https://api.example.com/v2/users?page=1";
    expect_script_passes (R"JS(
        pm.request.url.query.upsert({ key: 'page', value: '4' });
        pm.request.url.path.push('active');
        pm.expect(pm.request.url.query.get('page')).to.equal('4');
        pm.expect(pm.request.url.getPath()).to.equal('/v2/users/active');
        pm.expect(pm.request.url.getQueryString()).to.equal('page=4');
        pm.expect(pm.request.url.toString())
          .to.equal('https://api.example.com/v2/users/active?page=4');
        pm.expect(pm.request.url.length).to.equal(pm.request.url.toString().length);
    )JS");
}

/**
 * The regression the whole dirty-flag design exists to prevent.
 *
 * Composing on every read would put every URL through a split-and-join, and a
 * URL that survives that is not guaranteed byte-identical - which would quietly
 * break `getQueryString()` being byte-exact against the wire, the property the
 * signing workflows depend on. A script that only *reads* must leave the
 * request exactly as it found it.
 */
TEST_F (ScriptRequestUrlTest, AScriptThatOnlyReadsLeavesTheUrlByteIdentical) {
    for (const char* url :
    { "https://api.example.com/s?q=hello%20world&plus=a+b",
    "https://api.example.com/v2/users%20list?page=2&sort=name&page=3#top",
    "https://api.example.com/s?flag&empty=" }) {
        Request target    = request;
        target.url        = url;
        const auto result = engine.execute_prerequest (R"JS(
            var seen = pm.request.url.getQueryString() + pm.request.url.getPath() +
                       pm.request.url.query.count() + pm.request.url.host.length;
        )JS",
        target, env);

        ASSERT_TRUE (result.success) << url << ": " << result.error_message;
        EXPECT_EQ (target.url, url) << "a read-only script rewrote the URL";
    }
}

// A URL with no parts has no honest edit to make, and composing from empty
// pieces would send "://" plus whatever was pushed.
TEST_F (ScriptRequestUrlTest, EditingAnUnparseableUrlIsRefusedRatherThanComposed) {
    const std::array<const char*, 4> EDITS = { {
    "pm.request.url.path.push('x');",
    "pm.request.url.query.add({key:'a', value:'1'});",
    "pm.request.url.query.clear();",
    "pm.request.url.protocol = 'https';",
    } };

    for (const char* edit : EDITS) {
        Request target    = request;
        target.url        = "not a url at all";
        const auto result = engine.execute_prerequest (edit, target, env);

        EXPECT_FALSE (result.success) << edit;
        EXPECT_EQ (target.url, "not a url at all") << edit;
    }
}

// A segment that cannot be a path segment fails at the mutation rather than
// reaching the wire as "[object Object]".
TEST_F (ScriptRequestUrlTest, ASegmentThatIsNotAStringIsRefused) {
    const std::string original = request.url;
    const auto result          = engine.execute_prerequest (R"JS(
        pm.request.url.path.push({ a: 1 });
    )JS",
             request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("path"), std::string::npos) << result.error_message;
    EXPECT_EQ (request.url, original);
}

// A number is the one non-string taken: pushing an id onto a path is the
// obvious case, and there is no ambiguity about what it means.
TEST_F (ScriptRequestUrlTest, ANumericSegmentIsTakenAsItsDigits) {
    request.url = "https://api.example.com/v2/users";
    const auto result =
    engine.execute_prerequest ("pm.request.url.path.push(42);", request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users/42");
}

TEST_F (ScriptRequestUrlTest, AQueryWriterRefusesAnArgumentThatIsNotAKeyValueObject) {
    const std::string original = request.url;
    for (const char* edit : { "pm.request.url.query.add('sort=name');",
         "pm.request.url.query.add({ value: 'name' });", "pm.request.url.query.add({ key: '' });",
         "pm.request.url.query.add({ key: 'a', value: { b: 1 } });",
         "pm.request.url.query.remove(42);" }) {
        Request target    = request;
        const auto result = engine.execute_prerequest (edit, target, env);

        EXPECT_FALSE (result.success) << edit;
        EXPECT_EQ (target.url, original) << edit;
    }
}

// A test script's pm.request is a read-only record, so an edit there changes
// what the script sees and reaches nothing that was sent - the same rule the
// header mutators follow, now that the URL has mutators of its own.
TEST_F (ScriptRequestUrlTest, MemberEditsInATestScriptAreNotWrittenBack) {
    const std::string original = request.url;
    const ScriptResult result  = run_test_script (R"JS(
        pm.request.url.path.push('evil');
        pm.request.url.query.add({ key: 'leak', value: '1' });
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, original);
}

// ---------------------------------------------------------------------------
// The surfaces that used to require a string and are documented as taking
// pm.request.url.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestUrlTest, TheJarStillTakesPmRequestUrlAsItsScope) {
    std::vector<vayu::http::CookieWrite> writes;
    vayu::http::CookieJar jar;
    ScriptContext ctx = ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = "env_1";
    ctx.cookie_writes = &writes;

    // `unset` and `clear` record the URL they were scoped to, which is what
    // makes the scoping observable; `set` folds it into the cookie line.
    const ScriptResult result = engine.execute (R"JS(
        pm.cookies.jar().set(pm.request.url, { name: 'session', value: 'abc' });
        pm.cookies.jar().unset(pm.request.url, 'session');
        pm.cookies.jar().clear(pm.request.url);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (writes.size (), 3u);
    EXPECT_EQ (writes[0].kind, vayu::http::CookieWrite::Kind::Set);
    EXPECT_NE (writes[0].line.find ("session"), std::string::npos);
    EXPECT_EQ (writes[1].kind, vayu::http::CookieWrite::Kind::Unset);
    EXPECT_EQ (writes[1].url, request.url);
    EXPECT_EQ (writes[2].kind, vayu::http::CookieWrite::Kind::ClearUrl);
    EXPECT_EQ (writes[2].url, request.url);
}

TEST_F (ScriptRequestUrlTest, TheJarStillRefusesSomethingThatIsNotAUrl) {
    std::vector<vayu::http::CookieWrite> writes;
    vayu::http::CookieJar jar;
    ScriptContext ctx = ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = "env_1";
    ctx.cookie_writes = &writes;

    const ScriptResult result = engine.execute (R"JS(
        pm.cookies.jar().set(42, { name: 'session', value: 'abc' });
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_TRUE (writes.empty ());
}

#endif // VAYU_HAS_QUICKJS

} // namespace
