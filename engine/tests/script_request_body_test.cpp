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
#include <string_view>

#include <nlohmann/json.hpp>

#include "vayu/http/graphql_body.hpp"
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
    body.fields.emplace_back ("name", "Ada", true);
    FormField upload;
    upload.key       = "avatar";
    upload.type      = FormFieldType::File;
    upload.src       = "/home/ada/pictures/portrait.png";
    upload.file_name = "portrait.png";
    body.fields.push_back (upload);
    return body;
}

/// The envelope the request builder writes, carrying variables and an operation
/// name a server has agreed with its clients.
constexpr std::string_view GRAPHQL_ENVELOPE =
R"({"query":"query User($id: ID!) { user(id: $id) { name } }","operationName":"User","variables":{"id":"42"}})";

/// The bare document an agent or a `curl` caller hands over.
constexpr std::string_view GRAPHQL_DOCUMENT = "query User { user { name } }";

/// Envelope-shaped, and not readable: the `{{token}}` that went unresolved.
constexpr std::string_view GRAPHQL_UNRESOLVED = R"({"query":"{{savedQuery}},)";

/// The same envelope behind a UTF-8 byte-order mark, which an editor or a
/// PowerShell redirect can leave on a saved document. The classifier reads it
/// and the send carries it, so the pair has to answer about it too.
constexpr std::string_view GRAPHQL_BOM_ENVELOPE = "\xEF\xBB\xBF"
                                                  R"({"query":"query Ping { ping }"})";

Body graphql_body (std::string_view content) {
    Body body;
    body.mode    = BodyMode::GraphQL;
    body.content = content;
    return body;
}

/// The query the send would carry, read back out of `graphql_wire_body`'s own
/// answer rather than restated here. That is the whole point of the member: a
/// `.graphql.query` disagreeing with this describes a request nothing sends.
std::string wire_query (std::string_view content) {
    const std::string wire = vayu::http::graphql_wire_body (std::string{ content });
    return nlohmann::json::parse (wire).at ("query").get<std::string> ();
}

/// A C++ string as a JavaScript string literal, for a script built around one.
std::string js_literal (const std::string& text) {
    return nlohmann::json (text).dump ();
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
 * Every content mode without a Postman name of its own is `raw`, because each
 * carries its body as one string. Asserted over all of them rather than one,
 * since the mapping is a switch whose default arm is what answers for them.
 *
 * `graphql` left this list in #1111, which is a *break* for a lifted
 * `body.mode === 'raw'` guard over a GraphQL body - and the compatible answer,
 * since Postman names that mode too. `binary` stays here: Postman's `file` mode
 * promises the path `file.src`, and this one carries bytes.
 */
TEST_F (ScriptRequestBodyTest, EveryContentModeAnswersRaw) {
    for (const BodyMode mode : { BodyMode::Json, BodyMode::Text,
         BodyMode::Binary, BodyMode::JsonRpc, BodyMode::Xml }) {
        request.body.mode    = mode;
        request.body.content = "payload";
        expect_script_passes (R"JS(
            pm.expect(pm.request.body.mode).to.equal('raw');
            pm.expect(pm.request.body.raw).to.equal('payload');
            pm.expect(pm.request.body.graphql).to.equal(undefined);
        )JS");
    }
}

// ---------------------------------------------------------------------------
// The `graphql` mode and its pair (issue #1111).
// ---------------------------------------------------------------------------

/// The envelope case: the members are the envelope's own, not a re-derivation.
TEST_F (ScriptRequestBodyTest, AGraphqlEnvelopeReadsAsItsQueryAndVariables) {
    request.body = graphql_body (GRAPHQL_ENVELOPE);
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('graphql');
        pm.expect(pm.request.body.graphql.query).to.equal(
            'query User($id: ID!) { user(id: $id) { name } }');
        pm.expect(pm.request.body.graphql.variables.id).to.equal('42');
        pm.expect(pm.request.body.urlencoded).to.equal(undefined);
        pm.expect(pm.request.body.formdata).to.equal(undefined);
    )JS");
}

/**
 * The bare document case. `query` is the document itself, because that is what
 * the envelope the engine wraps it in carries - the point at which this member
 * stops being a restatement of `.raw` and starts answering what is *sent*.
 */
TEST_F (ScriptRequestBodyTest, ABareGraphqlDocumentReadsAsTheQueryItWouldBeSentAs) {
    request.body = graphql_body (GRAPHQL_DOCUMENT);
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('graphql');
        pm.expect(pm.request.body.graphql.query).to.equal('query User { user { name } }');
        pm.expect('variables' in pm.request.body.graphql).to.equal(false);
    )JS");
}

/**
 * The pin the member exists to keep: whatever `.graphql.query` answers is the
 * query `graphql_wire_body` would put on the wire, for every readable shape.
 * Reverting the classifier reuse - deriving the pair from a second local rule -
 * is what this fails on, since only the shared classifier decides the same way
 * the send does.
 *
 * The byte-order-marked envelope is here because it is the shape where reading
 * the body *twice* stops being harmless: nlohmann skips a BOM and `JSON.parse`
 * rejects one, so a version of this member that parsed the raw bytes with
 * QuickJS answered `undefined` for a body the send carries intact. Handing
 * QuickJS what nlohmann read is what this case fails without.
 */
TEST_F (ScriptRequestBodyTest, TheQueryIsTheOneTheSendWouldCarry) {
    for (const std::string_view content :
    { GRAPHQL_ENVELOPE, GRAPHQL_DOCUMENT, GRAPHQL_BOM_ENVELOPE }) {
        request.body = graphql_body (content);
        expect_script_passes (
        "pm.expect(pm.request.body.graphql.query).to.equal(" +
        js_literal (wire_query (content)) + ");");
    }
}

/**
 * Envelope-shaped and unreadable: an unresolved `{{token}}`, or a typo.
 * `graphql_wire_body` passes such a body through untouched rather than wrapping
 * something it failed to understand, so there is no pair to answer and none is
 * invented. `.raw` still carries the string, which is what keeps the body
 * described as unreadable rather than hidden.
 */
TEST_F (ScriptRequestBodyTest, AnUnreadableEnvelopeIsNotGuessedAt) {
    request.body = graphql_body (GRAPHQL_UNRESOLVED);
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('graphql');
        pm.expect(pm.request.body.graphql).to.equal(undefined);
        pm.expect(pm.request.body.raw).to.include('{{savedQuery}}');
    )JS");
}

/// An empty body has no query, and inventing one would give a bodiless request
/// an operation - the rule `graphql_wire_body` states as empty in, empty out.
TEST_F (ScriptRequestBodyTest, AnEmptyGraphqlBodyAnswersNoPair) {
    request.body = graphql_body ("");
    expect_script_passes (R"JS(
        pm.expect(pm.request.body.mode).to.equal('graphql');
        pm.expect(pm.request.body.graphql).to.equal(undefined);
    )JS");
}

/**
 * The pair is read off the string `.raw` answers with, so a script that rewrote
 * the body reads the query it just wrote rather than the one it replaced.
 */
TEST_F (ScriptRequestBodyTest, AssigningRawMovesTheGraphqlPairWithIt) {
    request.body = graphql_body (GRAPHQL_ENVELOPE);
    expect_script_passes (R"JS(
        pm.request.body.raw = 'query Rewritten { ping }';
        pm.expect(pm.request.body.graphql.query).to.equal('query Rewritten { ping }');
        pm.expect('variables' in pm.request.body.graphql).to.equal(false);
    )JS");
}

/// Frozen like the field lists, and for the same reason: a write into the pair
/// reaches nothing, so accepting one would be a write nothing reads back.
TEST_F (ScriptRequestBodyTest, TheGraphqlPairIsFrozenLikeTheFieldLists) {
    request.body = graphql_body (GRAPHQL_ENVELOPE);
    expect_script_passes (R"JS(
        var pair = pm.request.body.graphql;
        try { pair.query = 'query Injected { ping }'; } catch (e) { /* strict mode */ }
        pm.expect(pm.request.body.graphql.query).to.equal(
            'query User($id: ID!) { user(id: $id) { name } }');
    )JS");
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
        pm.expect(pm.request.body.graphql).to.equal(undefined);
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
        pm.expect(pm.request.body.graphql).to.equal(undefined);
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
    for (const char* member : { "mode", "urlencoded", "formdata", "graphql", "length" }) {
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

/**
 * The one edit that is dropped rather than refused, pinned so the docs describe
 * what the engine does.
 *
 * The entries are frozen objects, and JavaScript's own rule for a write to a
 * non-writable property in non-strict code is a silent no-op - not something
 * this surface adds, and not something a C++ setter could change without giving
 * every field of every entry an accessor. What matters is that the write
 * reaches nothing: the request is sent with the fields it was composed with.
 */
TEST_F (ScriptRequestBodyTest, WritingIntoAFieldListEntryReachesNothing) {
    request.body      = urlencoded_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body.urlencoded[0].value = 'stolen';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[0].value, before.fields[0].value);
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
