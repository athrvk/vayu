/**
 * @file script_engine_request_test.cpp
 * @brief pm.request: write-back, bodies, header methods, the worked examples in
 *        scripting.md and pm.info.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "script_engine_fixture.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/diagnostics.hpp"

using namespace vayu;
using namespace vayu::runtime;

// ============================================================================
// pm.request write-back (#109)
// ============================================================================
//
// These pin the contract that a pre-request script can change what goes on the
// wire. Revert the write-back in ScriptEngine::Impl::execute and every one of
// them fails, because before it existed the JS object was built, mutated and
// thrown away - the codebase's "written but never read" pattern at the script
// boundary.

TEST_F (ScriptEngineTest, PreRequestScriptSetsHeaderOnTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
    // Untouched headers survive: the write-back replaces the set, and the set
    // the script saw already held these.
    EXPECT_EQ (request.headers.at ("Content-Type"), "application/json");
}

TEST_F (ScriptEngineTest, PreRequestScriptHeaderOverridesEngineAppliedAuth) {
    // The precedence rule, end to end: build_request resolves auth into the
    // request first, the script runs second, so the script wins.
    const nlohmann::json config = { { "method", "GET" },
        { "url", "https://api.example.com/v1" },
        { "auth", { { "mode", "bearer" }, { "token", "engine-token" } } } };
    auto built = vayu::http::build_request (config, nullptr, 1000);
    ASSERT_TRUE (built.ok);
    ASSERT_EQ (built.request.headers.at ("Authorization"), "Bearer engine-token");

    auto result = engine.execute_prerequest (R"JS(
        pm.expect(pm.request.headers['Authorization']).to.equal('Bearer engine-token');
        pm.request.headers['Authorization'] = 'Bearer script-token';
    )JS",
    built.request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (built.request.headers.at ("Authorization"), "Bearer script-token");
}

// `pm.request.headers` is single-valued and shows a repeated header folded
// (issue #2466). A script that leaves it as it read it leaves every line, in
// place and spelling; one that writes it leaves one line. Mutation check:
// rebuild the lines from the script's object alone in
// `apply_script_headers` and the untouched repeat collapses to one line.
TEST_F (ScriptEngineTest, APreRequestScriptKeepsTheRepeatedHeaderItDidNotChange) {
    request.headers.clear ();
    request.headers.add ("X-Dup", "one");
    request.headers.add ("Accept", "*/*");
    request.headers.add ("x-dup", "two");

    auto result = engine.execute_prerequest (R"JS(
        pm.expect(pm.request.headers['X-Dup']).to.equal('one, two');
        pm.request.headers['Accept'] = 'application/json';
        pm.request.headers['X-New'] = '1';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers,
    (vayu::HeaderList{ { "X-Dup", "one" }, { "Accept", "application/json" },
    { "x-dup", "two" }, { "X-New", "1" } }));

    auto rewrite = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Dup'] = 'only';
    )JS",
    request, env);

    EXPECT_TRUE (rewrite.success) << rewrite.error_message;
    EXPECT_EQ (request.headers,
    (vayu::HeaderList{
    { "X-Dup", "only" }, { "Accept", "application/json" }, { "X-New", "1" } }));
}

TEST_F (ScriptEngineTest, PreRequestScriptCanDeleteAHeader) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['Authorization'];
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

TEST_F (ScriptEngineTest, PreRequestScriptStringifiesNumberAndBooleanHeaderValues) {
    // `pm.request.headers['X-Timestamp'] = Date.now()` is the shape users
    // actually write; a number has one honest wire form, so it is converted
    // rather than refused.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Attempt'] = 3;
        pm.request.headers['X-Retry'] = true;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Attempt"), "3");
    EXPECT_EQ (request.headers.at ("X-Retry"), "true");
}

TEST_F (ScriptEngineTest, PreRequestScriptChangesUrlAndMethod) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.url = 'https://api.example.com/v2/users?page=2';
        pm.request.method = 'post';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users?page=2");
    EXPECT_EQ (request.method, HttpMethod::POST); // lower-case verb normalised
}

TEST_F (ScriptEngineTest, PreRequestScriptSettingBodyOnABodylessRequestGivesItTextMode) {
    ASSERT_EQ (request.body.mode, BodyMode::None);

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'ping';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, "ping");
    // Mode matters, not just content: apply_method_and_body ignores a body
    // whose mode is None, so leaving it None would send nothing.
    EXPECT_EQ (request.body.mode, BodyMode::Text);
}

TEST_F (ScriptEngineTest, PreRequestScriptEditingAJsonBodyKeepsItsMode) {
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1})";

    auto result = engine.execute_prerequest (R"JS(
        var body = JSON.parse(pm.request.body);
        body.n = 2;
        pm.request.body = JSON.stringify(body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, R"({"n":2})");
    EXPECT_EQ (request.body.mode, BodyMode::Json);
}

TEST_F (ScriptEngineTest, PreRequestScriptDeletingTheBodyDropsIt) {
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1})";

    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
    EXPECT_TRUE (request.body.content.empty ());
}

// ============================================================================
// Form bodies and pm.request.body
// ============================================================================
//
// The two form modes carry their content in `fields`, so a bridge that read
// `content` handed the script `""` - indistinguishable from a request with no
// body. Every read assertion below goes through a header the script sets from
// the body, so it is the sent `Request` being checked, not the JS object.

namespace {

Body urlencoded_body () {
    Body body;
    body.mode   = BodyMode::Form;
    body.fields = { { "grant_type", "client_credentials", true },
        { "scope", "read write", true } };
    return body;
}

Body form_data_body () {
    Body body;
    body.mode   = BodyMode::FormData;
    body.fields = { { "name", "Ada", true }, { "role", "admin", true } };
    return body;
}

} // namespace

TEST_F (ScriptEngineTest, ScriptReadsAUrlencodedBodyAsTheStringThatGoesOnTheWire) {
    request.body = urlencoded_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // Exactly what apply_method_and_body puts in the body frame - the space in
    // "read write" percent-encoded by the one shared encoder.
    EXPECT_EQ (request.headers["X-Seen-Body"], "grant_type=client_credentials&scope=read%20write");
}

TEST_F (ScriptEngineTest, ScriptReadsAFormDataBodyAsItsFieldsRatherThanEmpty) {
    request.body = form_data_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
        pm.request.headers['X-Body-Empty'] = String(pm.request.body === '');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // A rendering of the parts, not the multipart envelope: that carries a
    // boundary libcurl generates at transfer time.
    EXPECT_EQ (request.headers["X-Seen-Body"], "name=Ada&role=admin");
    EXPECT_EQ (request.headers["X-Body-Empty"], "false");
}

TEST_F (ScriptEngineTest, ScriptReadingAFormBodySeesOnlyTheEnabledFields) {
    request.body        = urlencoded_body ();
    request.body.fields = { { "kept", "1", true }, { "off", "2", false } };

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // A disabled row is stored but never sent, so a script signing the body
    // must not see it either.
    EXPECT_EQ (request.headers["X-Seen-Body"], "kept=1");
}

TEST_F (ScriptEngineTest, ScriptCanTellAFormBodyApartFromNoBody) {
    ASSERT_EQ (request.body.mode, BodyMode::None);

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Body-Type'] = typeof pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The bodyless case is still `undefined`, which is what makes the non-empty
    // string above meaningful.
    EXPECT_EQ (request.headers["X-Body-Type"], "undefined");
}

TEST_F (ScriptEngineTest, ScriptOnlyReadingAFormBodyLeavesItsFieldsAlone) {
    request.body        = urlencoded_body ();
    request.body.fields = { { "kept", "1", true }, { "off", "2", false } };

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The write-back reads `body` off the JS object whether or not the script
    // assigned it, so an unchanged string has to mean untouched. Applying it
    // regardless would parse the *view* back - and the view leaves disabled
    // rows out, so a script that only looked at the body would delete one.
    ASSERT_EQ (request.body.fields.size (), 2u);
    EXPECT_EQ (request.body.fields[1].key, "off");
    EXPECT_FALSE (request.body.fields[1].enabled);
}

TEST_F (ScriptEngineTest, ScriptWritingAUrlencodedBodyReachesTheFieldsThatAreSent) {
    request.body = urlencoded_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = pm.request.body + '&signature=abc';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::Form);
    // The edit lands in `fields`, which is what the transfer layer reads for a
    // form mode - a string parked in `content` would be ignored entirely.
    ASSERT_EQ (request.body.fields.size (), 3u);
    EXPECT_EQ (request.body.fields[0].key, "grant_type");
    EXPECT_EQ (request.body.fields[0].value, "client_credentials");
    EXPECT_EQ (request.body.fields[1].key, "scope");
    EXPECT_EQ (request.body.fields[1].value, "read write");
    EXPECT_EQ (request.body.fields[2].key, "signature");
    EXPECT_EQ (request.body.fields[2].value, "abc");
    EXPECT_TRUE (request.body.content.empty ());
    EXPECT_EQ (vayu::http::encode_urlencoded (request.body.fields),
    "grant_type=client_credentials&scope=read%20write&signature=abc");
}

TEST_F (ScriptEngineTest, ScriptWritingBackAnUnchangedUrlencodedBodyChangesNothing) {
    request.body      = urlencoded_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    for (size_t i = 0; i < before.fields.size (); ++i) {
        EXPECT_EQ (request.body.fields[i].key, before.fields[i].key);
        EXPECT_EQ (request.body.fields[i].value, before.fields[i].value);
        EXPECT_TRUE (request.body.fields[i].enabled);
    }
}

TEST_F (ScriptEngineTest, ScriptWritingAFormDataBodyIsRefusedRatherThanDropped) {
    request.body      = form_data_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'name=Grace';
    )JS",
    request, env);

    // The whole write-back is all-or-nothing, so the request goes out as it
    // stood - the one thing that must never happen is the edit being accepted
    // and then ignored by the transfer layer.
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("form-data"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::FormData);
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[0].value, "Ada");
    EXPECT_TRUE (request.body.content.empty ());
}

// ---------------------------------------------------------------------------
// File parts through the script bridge (#411). The rendering is unit-tested in
// form_body_test.cpp; these pin what a *script* can actually tell, which is the
// defect - an upload read as an empty field and nothing else in the sandbox
// exposed the parts.
// ---------------------------------------------------------------------------

namespace {

Body form_data_body_with_a_file (const std::string& src) {
    Body body   = form_data_body ();
    body.fields = { { "caption", "my avatar", true } };
    FormField up;
    up.key  = "avatar";
    up.type = FormFieldType::File;
    up.src  = src;
    body.fields.push_back (up);
    return body;
}

} // namespace

TEST_F (ScriptEngineTest, ScriptTellsAFilePartFromAnEmptyTextField) {
    request.body = form_data_body_with_a_file ("/home/ada/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // Before this, the upload rendered `avatar=` - the same string the empty
    // text part below produces, so a script could not tell them apart.
    EXPECT_EQ (request.headers["X-Seen-Body"], "caption=my%20avatar&avatar=@portrait.png");

    Request text_request = request;
    text_request.headers = {};
    text_request.body    = form_data_body ();
    text_request.body.fields = { { "caption", "my avatar", true }, { "avatar", "", true } };

    auto text_result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    text_request, env);

    EXPECT_TRUE (text_result.success) << text_result.error_message;
    EXPECT_EQ (text_request.headers["X-Seen-Body"], "caption=my%20avatar&avatar=");
    EXPECT_NE (request.headers["X-Seen-Body"], text_request.headers["X-Seen-Body"]);
}

TEST_F (ScriptEngineTest, ScriptSeesTheFilenameAndNotTheLocalPath) {
    request.body =
    form_data_body_with_a_file ("/home/ada/private/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Has-Path'] = String(pm.request.body.indexOf('/home/ada') !== -1);
        pm.request.headers['X-Has-Name'] = String(pm.request.body.indexOf('portrait.png') !== -1);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The filename is what the server is told; the path is this machine's and
    // would end up in anything the script logs.
    EXPECT_EQ (request.headers["X-Has-Path"], "false");
    EXPECT_EQ (request.headers["X-Has-Name"], "true");
}

TEST_F (ScriptEngineTest, ReadingABodyWithAFilePartRewritesNothing) {
    request.body      = form_data_body_with_a_file ("/home/ada/portrait.png");
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    // The write-back measures the string it gets back against the same view, so
    // a script that only *looked* leaves the parts exactly as they stood - the
    // file part included, which is the one a parse-it-back would have dropped.
    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[1].type, FormFieldType::File);
    EXPECT_EQ (request.body.fields[1].src, before.fields[1].src);
    EXPECT_TRUE (request.body.fields[1].value.empty ());
}

TEST_F (ScriptEngineTest, AssigningABodyWithAFilePartIsStillRefused) {
    request.body = form_data_body_with_a_file ("/home/ada/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'caption=my%20avatar&avatar=@other.png';
    )JS",
    request, env);

    // Naming the file in the view does not make the view applicable: parsing it
    // back would turn the upload into a text part reading "@other.png".
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("form-data"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (request.body.fields.size (), 2u);
    EXPECT_EQ (request.body.fields[1].type, FormFieldType::File);
    EXPECT_EQ (request.body.fields[1].src, "/home/ada/portrait.png");
}

TEST_F (ScriptEngineTest, ScriptDeletingAFormDataBodySendsNoBody) {
    request.body = form_data_body ();

    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.body;
    )JS",
    request, env);

    // The refusal above is about assigning a string, not about clearing the
    // body: dropping it altogether is expressible and stays allowed.
    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
    EXPECT_TRUE (request.body.fields.empty ());
}

TEST_F (ScriptEngineTest, TestScriptReadsAFormBodyToo) {
    request.body = urlencoded_body ();

    auto result = engine.execute_test (R"JS(
        pm.test('body is visible', function () {
            if (String(pm.request.body) !== 'grant_type=client_credentials&scope=read%20write') {
                throw new Error('got: ' + pm.request.body);
            }
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, PreRequestScriptEditsMadeBeforeAThrowStillApply) {
    // The request is sent whether or not the script threw, so a header it
    // already set is honoured. The failure is still reported.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        undefinedFunction();
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_FALSE (result.error_message.empty ());
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
}

TEST_F (ScriptEngineTest, TestScriptMutationsAreNotWrittenBack) {
    // A post-request script's request has already been sent; writing back
    // there would only misreport what went out.
    ScriptContext ctx;
    ctx.request     = &request;
    ctx.response    = &response;
    ctx.environment = &env;

    auto result = engine.execute (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        pm.request.url = 'https://evil.example.com';
    )JS",
    ctx);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

// ---------------------------------------------------------------------------
// Rejected write-backs: loud, and all-or-nothing.
// ---------------------------------------------------------------------------

TEST_F (ScriptEngineTest, PreRequestScriptUnknownMethodIsRejectedAndAppliesNothing) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        pm.request.method = 'FETCH';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.method"), std::string::npos)
    << result.error_message;
    // Transactional: the good header in the same script is not applied either.
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.method, HttpMethod::GET);
}

TEST_F (ScriptEngineTest, PreRequestScriptNonStringHeaderValueIsRejectedByName) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Meta'] = { a: 1 };
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("X-Meta"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Meta"));
}

TEST_F (ScriptEngineTest, PreRequestScriptEmptyUrlIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.url = '';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.url"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

TEST_F (ScriptEngineTest, PreRequestScriptNonStringBodyIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = { a: 1 };
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.body"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
}

TEST_F (ScriptEngineTest, PreRequestScriptReplacingPmRequestWithANonObjectIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request = 'oops';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

TEST_F (ScriptEngineTest, PreRequestScriptThatChangesNothingLeavesTheRequestIdentical) {
    const Request before = request;

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('touched', 'yes');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, before.url);
    EXPECT_EQ (request.method, before.method);
    EXPECT_EQ (request.headers, before.headers);
    EXPECT_EQ (request.body.mode, before.body.mode);
    EXPECT_EQ (request.body.content, before.body.content);
}

// ============================================================================
// Request header methods reach the wire
// ============================================================================
//
// The interaction most likely to break: the methods write the same JS object
// the write-back reads, so every assertion below is on the sent `Request`, not
// on the JS object. Install them on a copy of the header set instead and these
// all still pass in JS while nothing changes on the wire.

TEST_F (ScriptEngineTest, PreRequestHeaderUpsertReachesTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert({ key: 'X-Signature', value: 'abc123' });
        pm.request.headers.upsert('X-Retry', 2);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
    // (name, value) is Bruno's spelling and the two-arg form users reach for;
    // a number has one honest wire form, same rule as plain assignment.
    EXPECT_EQ (request.headers.at ("X-Retry"), "2");
}

TEST_F (ScriptEngineTest, PreRequestHeaderUpsertReplacesThroughADifferentCasing) {
    // `Headers` is case-insensitive, so writing 'authorization' as a second key
    // would leave the write-back with two spellings of one header - which it
    // refuses outright. upsert writes through the spelling already present.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert('authorization', 'Bearer script-token');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer script-token");
    EXPECT_EQ (request.headers.count ("Authorization"), 1u);
}

TEST_F (ScriptEngineTest, PreRequestHeaderAddRefusesAnExistingName) {
    // Postman's HeaderList holds duplicates and `add` appends one; a single
    // `Headers` map cannot, so the divergence is named rather than hidden
    // behind add-behaving-as-upsert.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.add({ key: 'authorization', value: 'Bearer second' });
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("use headers.upsert()"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer token123")
    << "a refused add must leave the request untouched";
}

TEST_F (ScriptEngineTest, PreRequestHeaderRemoveIsCaseInsensitiveAndIdempotent) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.remove('AUTHORIZATION');
        pm.request.headers.remove('X-Never-Was');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

TEST_F (ScriptEngineTest, PreRequestHeaderMethodsAndAssignmentShareOneSet) {
    // Two views of one header set is the failure this pins: a method call, a
    // plain assignment and a delete, interleaved, must compose into exactly the
    // set that goes on the wire.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert('X-One', '1');
        pm.request.headers['X-Two'] = '2';
        pm.expect(pm.request.headers['X-One']).to.equal('1');
        pm.expect(pm.request.headers.get('x-two')).to.equal('2');
        pm.request.headers.remove('X-One');
        delete pm.request.headers['Content-Type'];
        pm.expect(pm.request.headers.has('X-One')).to.be.false;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-One"));
    EXPECT_EQ (request.headers.at ("X-Two"), "2");
    EXPECT_FALSE (request.headers.contains ("Content-Type"));
    EXPECT_TRUE (request.headers.contains ("Authorization"));
}

TEST_F (ScriptEngineTest, PreRequestHeaderAddRefusesAValueItCannotSend) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.add({ key: 'X-Object', value: { nested: true } });
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (
    result.error_message.find ("must be a string, number or boolean"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Object"));
}

TEST_F (ScriptEngineTest, PreRequestAHeaderNamedLikeAMethodStillReachesTheWire) {
    // The methods are non-enumerable properties of the header object itself, so
    // a header field literally named `get` collides with one. Data wins: the
    // entry is defined over the method and is sent. Losing it silently would be
    // the exact defect this surface was added to avoid.
    request.headers["get"] = "not-a-method";

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('getType', typeof pm.request.headers.get);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["getType"].value, "string");
    EXPECT_EQ (request.headers.at ("get"), "not-a-method");
}

// ============================================================================
// The worked examples in scripting.md actually run
// ============================================================================
//
// This whole issue existed because the docs taught a pattern the runtime threw
// away, and the example they taught it with called a `computeHash` that has
// never existed. So the non-trivial examples are executed here against a real
// request, not eyeballed. If you edit the code in
// "Worked examples: rewriting a request", edit these with it.

TEST_F (ScriptEngineTest, DocExampleRewritesAJsonBodyThenDerivesFromIt) {
    request.method       = HttpMethod::POST;
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1,"debugOnly":true})";

    auto result = engine.execute_prerequest (R"JS(
        var body = JSON.parse(pm.request.body);
        body.metadata = { client: 'vayu' };
        delete body.debugOnly;
        pm.request.body = JSON.stringify(body);
        pm.request.headers['Content-Length'] = String(pm.request.body.length);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, R"({"n":1,"metadata":{"client":"vayu"}})");
    // Derived after the edit, so it describes what is sent - the ordering the
    // doc calls out.
    EXPECT_EQ (request.headers.at ("Content-Length"),
    std::to_string (request.body.content.size ()));
}

// Concatenating the script source onto a call line: GCC 13 reports the heap
// copy that follows as reading past the small-string buffer. See
// utils/diagnostics.hpp.
VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
TEST_F (ScriptEngineTest, DocExampleSetsAQueryParamAcrossItsThreeCases) {
    static constexpr const char* kSetQueryParam = R"JS(
        function setQueryParam(url, name, value) {
          var pair = encodeURIComponent(name) + '=' + encodeURIComponent(value);
          var hashAt = url.indexOf('#');
          var fragment = hashAt === -1 ? '' : url.slice(hashAt);
          var base = hashAt === -1 ? url : url.slice(0, hashAt);

          var re = new RegExp('([?&])' + name + '=[^&]*');
          if (re.test(base)) {
            return base.replace(re, '$1' + pair) + fragment;
          }
          return base + (base.indexOf('?') === -1 ? '?' : '&') + pair + fragment;
        }
    )JS";

    struct Case {
        const char* url;
        const char* expected;
    };
    const auto cases = std::to_array<Case> ({
    // No query at all.
    { "https://api.example.com/users", "https://api.example.com/users?traceId=t1" },
    // Query present, parameter absent.
    { "https://api.example.com/users?page=2", "https://api.example.com/users?page=2&traceId=t1" },
    // Parameter already present - replaced, not duplicated.
    { "https://api.example.com/users?traceId=old&page=2", "https://api.example.com/users?traceId=t1&page=2" },
    // Fragment is preserved and never searched for the parameter.
    { "https://api.example.com/users#section", "https://api.example.com/users?traceId=t1#section" },
    });

    for (const auto& c : cases) {
        Request req;
        req.method = HttpMethod::GET;
        req.url    = c.url;
        Environment scratch;
        auto result = engine.execute_prerequest (std::string (kSetQueryParam) +
        "\npm.request.url = setQueryParam(pm.request.url, 'traceId', 't1');",
        req, scratch);

        ASSERT_TRUE (result.success) << result.error_message;
        EXPECT_EQ (req.url, c.expected) << "input: " << c.url;
    }
}
VAYU_DIAGNOSTIC_POP

// scripting.md's "Sign a request" example, with the timestamp pinned so the
// signature is reproducible. Until #187 this section taught an FNV-1a checksum
// and said in as many words that a real HMAC was impossible.
TEST_F (ScriptEngineTest, DocExampleSignsWithHmac) {
    env["secret"] = Variable{ "s3cr3t", true, true };

    auto result = engine.execute_prerequest (R"JS(
        var timestamp = '1700000000000';
        var canonical = [
          pm.request.method,
          pm.request.url,
          timestamp,
          pm.request.body || ''
        ].join('\n');

        pm.request.headers['X-Timestamp'] = timestamp;
        pm.request.headers['X-Signature'] =
          pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Timestamp"), "1700000000000");
    // HMAC-SHA256("s3cr3t", "GET\nhttps://api.example.com/users\n1700000000000\n").
    EXPECT_EQ (request.headers.at ("X-Signature"),
    "01366dd94b411a4bf53f7785b38f5f1ce16bf2b47dfe8c26de150f475dc61509");
}

TEST_F (ScriptEngineTest, DocExampleSwapsAuthScheme) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['Authorization'];
        pm.request.headers['X-Api-Key'] = pm.environment.get('api_key');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_EQ (request.headers.at ("X-Api-Key"), "secret123");
}

// The trap the doc now warns about, and why it warns: `pm.request.headers` is a
// JS object, so its keys are case-sensitive even though HTTP header names are
// not. A lower-case delete of a capitalised header is a silent no-op - this
// caught a wrong sentence in the docs before it shipped.
TEST_F (ScriptEngineTest, AWrongCaseDeleteDoesNotRemoveTheHeader) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['authorization'];
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (request.headers.contains ("Authorization"));
}

TEST_F (ScriptEngineTest, DocExampleCaseInsensitiveDeleteLoopRemovesTheHeader) {
    auto result = engine.execute_prerequest (R"JS(
        Object.keys(pm.request.headers).forEach(function (name) {
          if (name.toLowerCase() === 'authorization') delete pm.request.headers[name];
        });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

// Two JS keys, one HTTP header. Whichever enumerated last would have won
// silently, and one of them is the Authorization header, so the write-back
// refuses the whole thing instead of guessing.
TEST_F (ScriptEngineTest, HeaderNamesDifferingOnlyInCaseAreRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['authorization'] = 'Bearer script-token';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("case-insensitive"), std::string::npos)
    << result.error_message;
    // Nothing applied: the original engine-applied header still stands.
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer token123");
}

// ============================================================================
// pm.info (issue #300)
// ============================================================================

// Identity, not data: what the script is attached to and which hook it is.
// Every field is optional, and "absent" has to mean `undefined` rather than
// an empty string - a script's `typeof` check is the whole point of the
// distinction.
TEST_F (ScriptEngineTest, PmInfoExposesTheFieldsThatWereSet) {
    auto ctx         = ScriptContext::for_test (request, response);
    ctx.environment  = &env;
    ctx.request_id   = "req_42";
    ctx.request_name = "Fetch users";

    auto result = engine.execute (R"JS(
        pm.test("identity", function() {
            pm.expect(pm.info.requestId).to.equal("req_42");
            pm.expect(pm.info.requestName).to.equal("Fetch users");
            pm.expect(pm.info.eventName).to.equal("test");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Asserted per field, not on the object: a single `pm.info === undefined`
// check would pass on an implementation that binds one field and forgets the
// other two.
TEST_F (ScriptEngineTest, PmInfoFieldsAreAbsentRatherThanEmpty) {
    ScriptContext ctx;
    ctx.response = &response;

    auto result = engine.execute (R"JS(
        pm.test("requestId absent", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
        });
        pm.test("requestName absent", function() {
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
        pm.test("eventName absent", function() {
            pm.expect(typeof pm.info.eventName).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 3);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// An empty name is not a name. Reporting "" would satisfy a `typeof` check
// while telling the script nothing, which is the binding-that-cannot-fail the
// whole field set is designed to avoid.
TEST_F (ScriptEngineTest, PmInfoTreatsAnEmptyNameAsAbsent) {
    auto ctx         = ScriptContext::for_test (request, response);
    ctx.request_id   = "";
    ctx.request_name = "";

    auto result = engine.execute (R"JS(
        pm.test("empty is absent", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// One case per hook: a single case would pass against an implementation that
// hard-codes either string.
enum class ScriptHook : std::uint8_t { Prerequest, Test };

struct PmInfoEventNameCase {
    std::string_view case_name;
    ScriptHook hook;
    std::string_view expected_event_name;
};

class ScriptEnginePmInfoEventNameTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<PmInfoEventNameCase> {};

TEST_P (ScriptEnginePmInfoEventNameTest, NamesTheHookItRunsUnder) {
    const auto& param = GetParam ();
    const std::string script =
    "pm.test('hook', function() { pm.expect(pm.info.eventName).to.equal('" +
    std::string (param.expected_event_name) + "'); });";

    auto result = param.hook == ScriptHook::Prerequest ?
    engine.execute_prerequest (script, request, env) :
    engine.execute_test (script, request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

INSTANTIATE_TEST_SUITE_P (PerHook,
ScriptEnginePmInfoEventNameTest,
::testing::Values (PmInfoEventNameCase{ "ExecutePrerequest", ScriptHook::Prerequest, "prerequest" },
PmInfoEventNameCase{ "ExecuteTest", ScriptHook::Test, "test" }),
[] (const ::testing::TestParamInfo<PmInfoEventNameCase>& info) {
    return std::string (info.param.case_name);
});

// QuickJS contexts are pooled and reused, so pm.info has to be rebuilt per
// execution exactly as pm.request and pm.response are. Bind it once at context
// setup instead and this fails: the second script reads the first script's
// request name.
TEST_F (ScriptEngineTest, PmInfoDoesNotSurviveIntoTheNextExecution) {
    auto first         = ScriptContext::for_test (request, response);
    first.request_id   = "req_first";
    first.request_name = "First";
    auto first_result  = engine.execute ("pm.info.requestName;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Pooled contexts must not carry one script's mutations into the next, which
// may belong to another collection (#1782). Each case leaks a different kind of
// state; the second script asserts all of it is gone.
TEST_F (ScriptEngineTest, AScriptsGlobalsAndPmOverridesDoNotSurviveIntoTheNextExecution) {
    auto first        = ScriptContext::for_test (request, response);
    auto first_result = engine.execute (R"JS(
        globalThis.leak = 1;
        implicitLeak = 2;
        pm.foo = 3;
        pm.test = function () {};
        console.log = function () {};
        String.prototype.leakedMethod = function () {};
        Array.prototype.leakedMethod = function () {};
        Object.prototype.leakedProp = 4;
    )JS",
    first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof globalThis.leak).to.equal("undefined");
            pm.expect(typeof implicitLeak).to.equal("undefined");
            pm.expect(typeof pm.foo).to.equal("undefined");
            pm.expect(typeof "".leakedMethod).to.equal("undefined");
            pm.expect(typeof [].leakedMethod).to.equal("undefined");
            pm.expect(({}).leakedProp).to.equal(undefined);
            pm.expect(String(console.log).indexOf("native code") >= 0).to.equal(true);
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1) << "pm.test must be the real one again";
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, AScriptThatReplacesPmDoesNotBreakTheNextExecution) {
    auto first        = ScriptContext::for_test (request, response);
    auto first_result = engine.execute ("globalThis.pm = null;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (
    R"JS(pm.test("pm is back", function() { pm.expect(pm.response.code).to.equal(200); });)JS",
    second);
    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A queued promise job pins its context, so a pooled runtime that only freed
// the context kept every one of them (#1823). One engine is one thread's pool.
// Each script claims half the memory limit, so the contexts a leaking runtime
// keeps fail that allocation within a few dozen scripts; without it the leak
// surfaces only as a slowdown, because a failed context rebuild discards the
// runtime instead of reporting anything.
TEST_F (ScriptEngineTest, PromiseJobsLeftBehindDoNotExhaustThePooledRuntime) {
    ScriptConfig cfg;
    cfg.memory_limit = size_t{ 8 } * 1024 * 1024;
    ScriptEngine pooled (cfg);

    constexpr int executions = 2000;
    for (int i = 0; i < executions; ++i) {
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = pooled.execute (R"JS(
            const headroom = new ArrayBuffer(4 * 1024 * 1024);
            Promise.resolve(1).then(function () {});
            pm.test("ran", function () {});
        )JS",
        ctx);
        ASSERT_TRUE (result.success) << "execution " << i << ": " << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u) << "execution " << i;
    }
}

// A drained queue leaves nothing pinning the context, so the runtime goes back
// to the pool; one cut off at the deadline still has jobs and is discarded.
TEST_F (ScriptEngineTest, ADrainedRuntimeIsPooledAgain) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine pooled (cfg);

    auto drained = ScriptContext::for_test (request, response);
    auto result  = pooled.execute (R"JS(
        (async () => { await null; await null; })();
        Promise.resolve(1).then(function () {});
    )JS",
    drained);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (pooled.idle_runtime_count (), 1U);

    auto cut_off = ScriptContext::for_test (request, response);
    result = pooled.execute ("(async () => { for (;;) { await null; } })();", cut_off);
    ASSERT_FALSE (result.success);
    EXPECT_EQ (pooled.idle_runtime_count (), 0U);
}

// The queue is drained within the script's deadline, never past it: a job
// still queued when the deadline stops the drain is dropped with its runtime,
// because running it in the next execution's drain would be user code past
// its budget against a context whose execution has ended. The loop needs
// 300ms and the budget is 200ms, so a leftover carried into the second
// execution would finish there and set `late`.
TEST_F (ScriptEngineTest, APromiseJobLeftAtTheDeadlineNeverRuns) {
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine bounded (cfg);

    auto first        = ScriptContext::for_test (request, response);
    first.environment = &env;
    auto first_result = bounded.execute (R"JS(
        (async () => {
            const until = Date.now() + 300;
            while (Date.now() < until) { await null; }
            pm.environment.set("late", "1");
        })();
    )JS",
    first);
    ASSERT_FALSE (first_result.success);

    auto second        = ScriptContext::for_test (request, response);
    second.environment = &env;
    auto second_result = bounded.execute ("pm.environment.set('next', '1');", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;

    EXPECT_EQ (env.count ("late"), 0U);
    EXPECT_EQ (env.count ("next"), 1U);
}
