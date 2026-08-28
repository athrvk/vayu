/**
 * @file tests/script_request_body_test.cpp
 * @brief `pm.request.body` as Postman's `RequestBody` object (issue #1003).
 *
 * The sibling of `script_request_url_test.cpp`, pinning the same trade for the
 * same reason: Postman compatibility wins over the string shape the member had,
 * and both halves of that trade have to hold at once.
 *
 * - the compatibility half - a lifted Postman script reading `body.mode`,
 *   `body.raw`, `body.urlencoded` and `body.formdata` runs unmodified, and
 *   `JSON.parse(pm.request.body.raw)` is the idiom that has to work;
 * - the mitigation half - concatenation, template literals, `==`, the generic
 *   `String.prototype` methods and `JSON.stringify` still behave as they did,
 *   because a change that quietly broke every script treating the body as a
 *   string would not be worth the compatibility it bought.
 *
 * The three things that genuinely changed - `===`, `typeof`, and assigning the
 * body straight into a header value - are asserted **as** breaks, for the reason
 * #991 gives: a documented break nothing pins comes back as an accident later,
 * and the docs would then describe behaviour the engine no longer has.
 *
 * What this suite must *not* let move is the write surface, which #1003 keeps
 * exactly as it shipped: a whole-string assignment, the untouched rule that
 * keeps a read-only script from rewriting a form body, the urlencoded
 * parse-back, and the form-data refusal. Each is asserted here against the
 * request that would be sent rather than against the JS object, because the
 * object agreeing with itself proves nothing about the wire.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <string>

#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

#ifdef VAYU_HAS_QUICKJS

Body json_body () {
    Body body;
    body.mode    = BodyMode::Json;
    body.content = R"({"name":"Ada","count":2})";
    return body;
}

Body urlencoded_body () {
    Body body;
    body.mode   = BodyMode::Form;
    body.fields = { { "grant_type", "client_credentials", true },
        { "scope", "read write", true }, { "legacy", "off", false } };
    return body;
}

Body form_data_body () {
    Body body;
    body.mode = BodyMode::FormData;
    body.fields.push_back ({ "name", "Ada", true });
    FormField upload;
    upload.key       = "avatar";
    upload.type      = FormFieldType::File;
    upload.src       = "/home/ada/pictures/portrait.png";
    upload.file_name = "portrait.png";
    body.fields.push_back (upload);
    return body;
}

class ScriptRequestBodyTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::POST;
        request.url          = "https://api.example.com/v2/users";
        request.body         = json_body ();
        response.status_code = 200;
        response.status_text = "OK";
        response.body        = "{}";
    }

    /// A single `pm.test` whose verdict is the assertion. The name is asserted
    /// too, so a script that threw before reaching its test - which produces no
    /// verdict at all - cannot read as a pass.
    void expect_script_passes (const std::string& body) {
        ScriptContext ctx;
        ctx.request     = &request;
        ctx.response    = &response;
        ctx.environment = &env;
        const ScriptResult result =
        engine.execute ("pm.test('assertion', function () {\n" + body + "\n});", ctx);
        // The script's own failure first: `success` is also false when a verdict
        // failed, and reading that as a thrown error hides the assertion that
        // actually went red.
        ASSERT_TRUE (result.error_message.empty ()) << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u) << body;
        EXPECT_EQ (result.tests[0].name, "assertion");
        EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
        EXPECT_TRUE (result.success);
    }
};

// ---------------------------------------------------------------------------
// The RequestBody read surface.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestBodyTest, AContentBodyReadsAsPostmansRawMode) {
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('raw');
        pm.expect(pm.request.body.raw).to.equal('{"name":"Ada","count":2}');
        pm.expect(pm.request.body.urlencoded).to.equal(undefined);
        pm.expect(pm.request.body.formdata).to.equal(undefined);
    )JS");
}

/**
 * The idiom the issue exists for. It threw before #1003 - `.raw` was undefined,
 * so `JSON.parse` was handed the string "undefined" - which is the loud half of
 * the pair; the silent half is the `mode === 'raw'` guard above.
 */
TEST_F (ScriptRequestBodyTest, JsonParseOfRawIsTheImportedIdiomAndRoundTrips) {
    expect_script_passes (R"JS(
        var parsed = JSON.parse(pm.request.body.raw);
        pm.expect(parsed.name).to.equal('Ada');
        pm.expect(parsed.count).to.equal(2);
    )JS");
}

/**
 * Every content mode is `raw`, because each carries its body as one string.
 * Asserted over all of them rather than one, since the mapping is a switch whose
 * default arm is what answers for five of the six.
 */
TEST_F (ScriptRequestBodyTest, EveryContentModeAnswersRaw) {
    for (const BodyMode mode : { BodyMode::Json, BodyMode::Text, BodyMode::Binary,
         BodyMode::GraphQL, BodyMode::JsonRpc, BodyMode::Xml }) {
        request.body.mode    = mode;
        request.body.content = "payload";
        expect_script_passes (R"JS(
            pm.expect(pm.request.body.mode).to.equal('raw');
            pm.expect(pm.request.body.raw).to.equal('payload');
        )JS");
    }
}

TEST_F (ScriptRequestBodyTest, AUrlencodedBodyReadsAsItsPairsWithTheDisabledRowFlagged) {
    request.body = urlencoded_body ();
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('urlencoded');
        var pairs = pm.request.body.urlencoded;
        pm.expect(pairs.length).to.equal(3);
        pm.expect(pairs[0].key).to.equal('grant_type');
        pm.expect(pairs[0].value).to.equal('client_credentials');
        pm.expect(pairs[0].disabled).to.equal(false);
        // The value is the one the user wrote, not the percent-encoded wire
        // form - the encoding is `.raw`'s answer, and a signature built from
        // these pairs would double-encode if this were encoded too.
        pm.expect(pairs[1].value).to.equal('read write');
        // The disabled row is listed rather than dropped: the string view omits
        // it, and a script that could not see it would re-add it.
        pm.expect(pairs[2].key).to.equal('legacy');
        pm.expect(pairs[2].disabled).to.equal(true);
        pm.expect(pm.request.body.formdata).to.equal(undefined);
    )JS");
}

/**
 * `.raw` is the wire body for a urlencoded request, which is the one thing that
 * separates this mode from form-data: the string parses straight back.
 */
TEST_F (ScriptRequestBodyTest, AUrlencodedBodysRawIsTheStringThatGoesOnTheWire) {
    request.body = urlencoded_body ();
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.raw).to.equal(
            'grant_type=client_credentials&scope=read%20write');
    )JS");
}

TEST_F (ScriptRequestBodyTest, AFormDataBodyNamesItsFilePartAndNeverItsPath) {
    request.body = form_data_body ();
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('formdata');
        var parts = pm.request.body.formdata;
        pm.expect(parts.length).to.equal(2);
        pm.expect(parts[0].type).to.equal('text');
        pm.expect(parts[0].value).to.equal('Ada');
        pm.expect(parts[1].type).to.equal('file');
        pm.expect(parts[1].fileName).to.equal('portrait.png');
        // The two halves of issue #411's distinction, on the object this time:
        // a file part carries no `value` at all, so it cannot be read as a text
        // field that happens to be empty - and the local path is not disclosed.
        pm.expect(parts[1].value).to.equal(undefined);
        pm.expect(JSON.stringify(parts[1])).to.not.include('/home/ada');
        pm.expect(pm.request.body.urlencoded).to.equal(undefined);
    )JS");
}

TEST_F (ScriptRequestBodyTest, ABodylessRequestStillDefinesNoBodyAtAll) {
    request.body = Body{};
    expect_script_passes (R"JS(
        pm.expect(typeof pm.request.body).to.equal('undefined');
    )JS");
}

// ---------------------------------------------------------------------------
// The string mitigations - what must NOT have changed.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestBodyTest, StillBehavesAsAStringInEveryContextItCan) {
    request.body.content = "hello";
    expect_script_passes (R"JS(
        var body = pm.request.body;
        pm.expect('' + body).to.equal('hello');
        pm.expect(`${body}`).to.equal('hello');
        pm.expect(body == 'hello').to.equal(true);
        pm.expect(body.startsWith('he')).to.equal(true);
        pm.expect(body.includes('ell')).to.equal(true);
        pm.expect(body.slice(0, 2)).to.equal('he');
        pm.expect(body.indexOf('llo')).to.equal(2);
        pm.expect(body.split('l')[0]).to.equal('he');
        pm.expect(body.toString()).to.equal('hello');
        pm.expect(body.length).to.equal(5);
        pm.expect(JSON.stringify({ b: body })).to.equal('{"b":"hello"}');
    )JS");
}

// The repo's own docs and tests spell it this way, and the doc example that
// signs a request reads `pm.request.body || ''` before joining.
TEST_F (ScriptRequestBodyTest, ExpectIncludeAndTruthinessStillReadItAsAString) {
    request.body.content = "hello";
    expect_script_passes (R"JS(
        pm.expect(pm.request.body).to.include('ell');
        pm.expect(pm.request.body).to.not.include('nowhere');
        pm.expect([pm.request.body || ''].join('|')).to.equal('hello');
    )JS");
}

/**
 * A form body still reads as its fields rather than as `""` - the #411 decision
 * this object had to keep, and the reason `.raw` answers for every mode where
 * Postman leaves it undefined for the two form ones.
 */
TEST_F (ScriptRequestBodyTest, AFormBodyStillReadsAsItsFieldsInAStringContext) {
    request.body = form_data_body ();
    expect_script_passes (R"JS(
        pm.expect('' + pm.request.body).to.equal('name=Ada&avatar=@portrait.png');
        pm.expect(pm.request.body.raw).to.equal('name=Ada&avatar=@portrait.png');
    )JS");
}

/**
 * `.length` is an own property, not an inherited one - and that is the whole
 * point of asserting it.
 *
 * `String.prototype` is a String exotic object holding "", so an object that
 * only inherits from it answers `0` here. Deleting the own definition makes this
 * test read 0 for a 24-character body, which is the silent wrong answer the
 * object is built to avoid - and `docs/engine/scripting.md`'s worked example
 * sets Content-Length from exactly this.
 */
TEST_F (ScriptRequestBodyTest, LengthIsTheBodysOwnLengthAndNotTheInheritedZero) {
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.length).to.equal(24);
        pm.expect(pm.request.body.length).to.equal(pm.request.body.toString().length);
    )JS");
}

/**
 * The three documented breaks, asserted as breaks.
 *
 * The header one is the same refusal `pm.request.url` already gets: a value the
 * engine cannot send is refused rather than coerced, and an object is not a
 * header value. It is pinned here because it is the one break a script is likely
 * to *hit* - `headers['X-Body'] = pm.request.body` reads as ordinary code.
 */
TEST_F (ScriptRequestBodyTest, TheDocumentedBreaksAreWhatTheDocsSay) {
    request.body.content = "hello";
    expect_script_passes (R"JS(
        pm.expect(pm.request.body === 'hello').to.equal(false);
        pm.expect(typeof pm.request.body).to.equal('object');
    )JS");

    request.body        = json_body ();
    const Body before   = request.body;
    const auto rejected = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Body'] = pm.request.body;
    )JS",
    request, env);
    EXPECT_FALSE (rejected.success);
    EXPECT_NE (rejected.error_message.find ("must be a string"), std::string::npos)
    << rejected.error_message;
    EXPECT_EQ (request.body.content, before.content)
    << "a rejected write-back is all-or-nothing";
}

// ---------------------------------------------------------------------------
// Writes - unchanged by #1003, and asserted against the request that is sent.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestBodyTest, AssigningRawReachesTheBodyThatIsSent) {
    auto result = engine.execute_prerequest (R"JS(
        var parsed = JSON.parse(pm.request.body.raw);
        parsed.count = 7;
        pm.request.body.raw = JSON.stringify(parsed);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::Json)
    << "the mode is not the script's to change";
    EXPECT_EQ (request.body.content, R"({"name":"Ada","count":7})");
}

TEST_F (ScriptRequestBodyTest, AssigningRawOnAUrlencodedBodyParsesBackIntoTheFields) {
    request.body = urlencoded_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body.raw = pm.request.body.raw + '&audience=api';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), 3u)
    << "the disabled row is not in the wire string";
    EXPECT_EQ (request.body.fields[2].key, "audience");
    EXPECT_EQ (request.body.fields[2].value, "api");
    EXPECT_TRUE (request.body.content.empty ())
    << "exactly one of content and fields carries it";
}

TEST_F (ScriptRequestBodyTest, AssigningRawOnAFormDataBodyIsRefusedRatherThanDropped) {
    request.body      = form_data_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body.raw = 'name=Grace';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("form-data"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[1].src, before.fields[1].src)
    << "the upload survives";
}

/// The shipped whole-string write, unchanged - the object is only a second way
/// to reach it.
TEST_F (ScriptRequestBodyTest, AssigningTheWholeBodyAsAStringStillWorks) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'plain text';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, "plain text");
    EXPECT_EQ (request.body.mode, BodyMode::Json) << "an existing mode is kept";
}

/// Handing the object back where a string used to go is the shape a script that
/// rebuilds `pm.request` wholesale produces, and the untouched rule has to see
/// through it or every read-only script would rewrite its own form body.
TEST_F (ScriptRequestBodyTest, AssigningTheObjectToItselfChangesNothing) {
    request.body      = urlencoded_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[2].key, "legacy");
    EXPECT_FALSE (request.body.fields[2].enabled)
    << "the disabled row is still disabled";
}

TEST_F (ScriptRequestBodyTest, DeletingTheBodyStillSendsNone) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
    EXPECT_TRUE (request.body.content.empty ());
}

/**
 * The members that describe the body refuse a write instead of ignoring one.
 *
 * Each is checked against the request as well as the error, because "the script
 * failed" and "the script failed *and changed nothing*" are different outcomes
 * and only the second is the all-or-nothing rule the write-back promises.
 */
TEST_F (ScriptRequestBodyTest, TheDescribingMembersAreReadOnlyAndSaySo) {
    for (const char* member : { "mode", "urlencoded", "formdata" }) {
        request.body      = urlencoded_body ();
        const Body before = request.body;

        const std::string script = std::string ("pm.request.body.") + member + " = 'nonsense';";
        auto result = engine.execute_prerequest (script, request, env);

        EXPECT_FALSE (result.success) << member;
        EXPECT_NE (result.error_message.find ("read-only"), std::string::npos)
        << result.error_message;
        EXPECT_NE (result.error_message.find (member), std::string::npos)
        << result.error_message;
        ASSERT_EQ (request.body.fields.size (), before.fields.size ()) << member;
    }
}

/// A list that quietly grew would be a write nothing reads back, which is the
/// defect class this program closes rather than adds to.
TEST_F (ScriptRequestBodyTest, TheFieldListsRefuseAnEditRatherThanLoseIt) {
    request.body      = urlencoded_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body.urlencoded.push({ key: 'audience', value: 'api' });
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
}

TEST_F (ScriptRequestBodyTest, AssigningRawSomethingThatIsNotAStringIsRefusedAtTheLine) {
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body.raw = { a: 1 };
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.body.raw"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.body.content, before.content);
}

/// A test script has no write-back, so what it does to the body is discarded -
/// the same rule `pm.request.url` follows.
TEST_F (ScriptRequestBodyTest, ATestScriptsWritesAreNotWrittenBack) {
    const Body before = request.body;

    auto result = engine.execute_test (R"JS(
        pm.request.body.raw = 'ignored';
        pm.test('read it back', function () {
            pm.expect(pm.request.body.raw).to.equal('ignored');
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (request.body.content, before.content)
    << "the request that was sent is unchanged";
}

#endif // VAYU_HAS_QUICKJS

} // namespace
