/**
 * @file tests/script_request_methods_test.cpp
 * @brief Postman's Request methods on `pm.request` (#3131).
 *
 * A lifted Postman script calls `pm.request.addHeader(...)` and the rest on the
 * request itself, not on its members. Each one either works or fails naming
 * itself; a bare "not a function" is the failure this suite exists to keep out.
 *
 * Every write is asserted against the request the write-back hands to the
 * send, never against the JS object: an alias that wrote a copy of the header
 * set would agree with itself in JS while nothing changed on the wire.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <string>

#include <nlohmann/json.hpp>

#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

#ifdef VAYU_HAS_QUICKJS

class ScriptRequestMethodsTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Environment env;

    void SetUp () override {
        request.method = HttpMethod::POST;
        request.url    = "https://api.example.com/v2/users?a=1";
        request.headers.add ("Authorization", "Bearer token123");
        request.headers.add ("Content-Type", "application/json");
        request.body.mode    = BodyMode::Json;
        request.body.content = R"({"n":1})";
    }

    /// What a pre-request script left in `pm.environment` under @p name.
    [[nodiscard]] std::string read_back (const std::string& name) const {
        const auto found = env.find (name);
        return found == env.end () ? std::string{} : found->second.value;
    }
};

// ---------------------------------------------------------------------------
// The header aliases reach the outgoing request.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestMethodsTest, AddHeaderReachesTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.addHeader({ key: 'X-Signature', value: 'abc123' });
        pm.request.addHeader('X-Retry', 2);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
    EXPECT_EQ (request.headers.at ("X-Retry"), "2");
}

/**
 * The choice the alias makes, pinned: `addHeader` is `upsert`, so a header the
 * request already carries is replaced - through its own spelling - rather than
 * refused the way `headers.add` refuses it. Mutation check: alias `addHeader`
 * to `add` and this fails on the refusal.
 */
TEST_F (ScriptRequestMethodsTest, AddHeaderReplacesAHeaderTheRequestAlreadyCarries) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.addHeader({ key: 'authorization', value: 'Bearer script' });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer script");
    EXPECT_EQ (request.headers.count ("Authorization"), 1u);
}

TEST_F (ScriptRequestMethodsTest, RemoveHeaderTakesItOffTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.removeHeader('authorization');
        pm.request.removeHeader('X-Never-Was');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

TEST_F (ScriptRequestMethodsTest, UpsertHeaderAndForEachHeaderAreTheHeaderMethods) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.upsertHeader({ key: 'X-Trace', value: 't-1' });
        var seen = [];
        pm.request.forEachHeader(function (header, index) {
            seen.push(index + ':' + header.key + '=' + header.value);
        });
        pm.environment.set('seen', seen.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Trace"), "t-1");
    EXPECT_EQ (read_back ("seen"), "0:Authorization=Bearer token123,1:Content-Type=application/json,2:X-Trace=t-1");
}

/// Postman's `getHeaders` keeps each name's spelling, and lower-cases only on
/// `ignoreCase` - `toObject`'s default the other way round.
TEST_F (ScriptRequestMethodsTest, GetHeadersKeepsTheSpellingUnlessAskedToIgnoreCase) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('kept', Object.keys(pm.request.getHeaders()).join(','));
        pm.environment.set('folded',
            Object.keys(pm.request.getHeaders({ ignoreCase: true })).join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("kept"), "Authorization,Content-Type");
    EXPECT_EQ (read_back ("folded"), "authorization,content-type");
}

TEST_F (ScriptRequestMethodsTest, TheQueryParamAliasesReachTheUrlThatIsSent) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.addQueryParams('b=2');
        pm.request.removeQueryParams('a');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users?b=2");
}

/**
 * The alias reads `pm.request.headers` when it is called, so a script that
 * replaced the object is told the method it reached for is gone - by name -
 * instead of writing to an object nothing reads back.
 */
TEST_F (ScriptRequestMethodsTest, AnAliasOverAReplacedMemberFailsByName) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers = { 'X-Plain': '1' };
        pm.request.addHeader('X-Signature', 'abc');
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.addHeader()"), std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("pm.request.headers.upsert()"), std::string::npos)
    << result.error_message;
    // What the script assigned before it threw is applied (script_engine.cpp
    // runs the write-back after a throw); the header the call named is not.
    EXPECT_TRUE (request.headers.contains ("X-Plain"));
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
}

TEST_F (ScriptRequestMethodsTest, ADetachedMethodFailsByName) {
    auto result = engine.execute_prerequest (R"JS(
        var add = pm.request.addHeader;
        add('X-Signature', 'abc');
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (
               "pm.request.addHeader must be called on pm.request"),
    std::string::npos)
    << result.error_message;
}

// ---------------------------------------------------------------------------
// toJSON.
// ---------------------------------------------------------------------------

/**
 * The plain request, read as it stands at the call - so after the script's own
 * writes - and what `JSON.stringify (pm.request)` writes too.
 */
TEST_F (ScriptRequestMethodsTest, ToJsonIsThePlainRequestAsTheScriptLeftIt) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.addHeader('X-Trace', 't-1');
        pm.request.body.update({ mode: 'raw', raw: '{"n":2}' });
        pm.environment.set('json', JSON.stringify(pm.request.toJSON()));
        pm.environment.set('same',
            String(JSON.stringify(pm.request) === JSON.stringify(pm.request.toJSON())));
        pm.environment.set('keys', Object.keys(pm.request).join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    const auto json = nlohmann::json::parse (read_back ("json"));
    EXPECT_EQ (json.at ("url"), "https://api.example.com/v2/users?a=1");
    EXPECT_EQ (json.at ("method"), "POST");
    EXPECT_EQ (json.at ("header"), nlohmann::json::parse (R"([{"key":"Authorization","value":"Bearer token123"},
        {"key":"Content-Type","value":"application/json"},
        {"key":"X-Trace","value":"t-1"}])"));
    EXPECT_EQ (json.at ("body"),
    nlohmann::json::parse (R"({"mode":"raw","raw":"{\"n\":2}"})"));
    EXPECT_EQ (read_back ("same"), "true");
    EXPECT_EQ (read_back ("keys"), "url,method,headers,body")
    << "the methods are not members a script would mistake for the request's";
}

TEST_F (ScriptRequestMethodsTest, ToJsonCarriesNoBodyForABodylessRequest) {
    request.body = Body{};
    auto result  = engine.execute_prerequest (R"JS(
        pm.environment.set('has', String('body' in pm.request.toJSON()));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("has"), "false");
}

/// A urlencoded body reads as Postman's pair list, and a description the script
/// assigned is already that shape.
TEST_F (ScriptRequestMethodsTest, ToJsonDescribesTheBodyInPostmansShape) {
    request.body      = Body{};
    request.body.mode = BodyMode::Form;
    request.body.fields.emplace_back ("grant_type", "client_credentials", true);
    auto result = engine.execute_prerequest (R"JS(
        var body = pm.request.toJSON().body;
        pm.environment.set('mode', body.mode);
        pm.environment.set('pair', body.urlencoded[0].key + '=' + body.urlencoded[0].value);
        pm.request.body = { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] };
        pm.environment.set('assigned', JSON.stringify(pm.request.toJSON().body));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("mode"), "urlencoded");
    EXPECT_EQ (read_back ("pair"), "grant_type=client_credentials");
    EXPECT_EQ (read_back ("assigned"),
    R"({"mode":"urlencoded","urlencoded":[{"key":"a","value":"1"}]})");
}

// ---------------------------------------------------------------------------
// What is not implemented says so.
// ---------------------------------------------------------------------------

/**
 * Each Postman Request method with no Vayu meaning throws naming itself and the
 * replacement, and the request goes out as it was. Mutation check: drop the
 * stubs and every one of these fails on QuickJS's bare "not a function".
 */
TEST_F (ScriptRequestMethodsTest, TheUnsupportedRequestMethodsFailByName) {
    for (const char* method : { "clone", "size", "update" }) {
        const auto before = request;
        auto result       = engine.execute_prerequest (
        std::string ("pm.request.") + method + "({ url: 'https://elsewhere.test' });",
        request, env);

        EXPECT_FALSE (result.success) << method;
        EXPECT_NE (result.error_message.find (
                   std::string ("pm.request.") + method + "() is not supported"),
        std::string::npos)
        << result.error_message;
        EXPECT_EQ (request.url, before.url) << method;
    }
}

#endif // VAYU_HAS_QUICKJS

} // namespace
