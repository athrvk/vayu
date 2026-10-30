/**
 * @file tests/script_request_auth_test.cpp
 * @brief `pm.request.auth` and `pm.request.authorizeUsing` (#3131).
 *
 * A lifted Postman script sets the request's auth by assigning Postman's
 * `{ type, <type>: params }` block. It was ignored: the request went out with
 * no credential and no error. Every case is asserted on the request the
 * write-back hands to the send, never on the JS object, because the defect was
 * an object that held the assignment while nothing reached the wire.
 *
 * Auth applied before the script is set up through `apply_auth` itself, so
 * the provenance the write-back reads is the provenance a real send records.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <string>

#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

#ifdef VAYU_HAS_QUICKJS

constexpr const char* BASE_URL = "https://api.example.com/v2/users?a=1";

class ScriptRequestAuthTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Environment env;

    void SetUp () override {
        request.method = HttpMethod::GET;
        request.url    = BASE_URL;
        request.headers.add ("Accept", "application/json");
    }

    /// @p auth applied to the request as the engine applies a request's own
    /// before its pre-request script runs.
    void apply_engine_auth (const vayu::http::Auth& auth) {
        const auto applied = vayu::http::apply_auth (request, auth, nullptr);
        ASSERT_TRUE (applied.ok) << applied.message;
    }

    ScriptResult run (const std::string& script) {
        return engine.execute_prerequest (script, request, env);
    }

    [[nodiscard]] std::string authorization () const {
        const auto found = request.headers.find ("Authorization");
        return found == request.headers.end () ? std::string{} : found->value;
    }

    /// What a pre-request script left in `pm.environment` under @p name.
    [[nodiscard]] std::string read_back (const std::string& name) const {
        const auto found = env.find (name);
        return found == env.end () ? std::string{} : found->second.value;
    }
};

std::string basic (const std::string& pair) {
    return "Basic " + vayu::utils::base64_encode (pair);
}

// ---------------------------------------------------------------------------
// An assignment reaches the request, each type where Postman puts it.
// ---------------------------------------------------------------------------

// The issue's own script. Mutation check: drop the `apply_script_auth` call
// from `apply_pm_request_writeback` and this sends no Authorization.
TEST_F (ScriptRequestAuthTest, ABasicAssignmentReachesTheRequest) {
    auto result = run (R"JS(
        pm.request.auth = { type: 'basic', basic: [
            { key: 'username', value: 'alice' },
            { key: 'password', value: 's3cret' } ] };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), basic ("alice:s3cret"));
    EXPECT_TRUE (request.auth_from_script);
}

// The object spelling of the block, and a token resolved against what the
// same script set, as pm.sendRequest resolves its credentials.
TEST_F (ScriptRequestAuthTest, ABearerTokenResolvesAgainstWhatTheScriptSet) {
    auto result = run (R"JS(
        pm.environment.set('tok', 'tok_123');
        pm.request.auth = { type: 'bearer', bearer: { token: '{{tok}}' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Bearer tok_123");
}

TEST_F (ScriptRequestAuthTest, AnApiKeyGoesInAHeaderByDefault) {
    auto result = run (R"JS(
        pm.request.auth = { type: 'apikey', apikey: { key: 'X-Api-Key', value: 'k123' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Api-Key"));
    EXPECT_EQ (request.headers.at ("X-Api-Key"), "k123");
    EXPECT_EQ (request.secret_header_names, std::vector<std::string>{ "X-Api-Key" });
}

// Encoded by the query rule every other send writes a query credential with,
// and named for the reader that masks it.
TEST_F (ScriptRequestAuthTest, AnApiKeyInTheQueryIsAppendedAndNamed) {
    auto result = run (R"JS(
        pm.request.auth = { type: 'apikey', apikey: [
            { key: 'key', value: 'api_key' },
            { key: 'value', value: 'k 1&2' },
            { key: 'in', value: 'query' } ] };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, std::string (BASE_URL) + "&api_key=k%201%262");
    EXPECT_EQ (request.auth_query_param, "api_key");
}

// ---------------------------------------------------------------------------
// It replaces the credential the engine applied, and only that one.
// ---------------------------------------------------------------------------

// Mutation check: drop `drop_engine_credential` from `apply_script_auth` and
// `apply_auth` keeps the engine's header, because it never replaces one.
TEST_F (ScriptRequestAuthTest, AnAssignmentReplacesTheEngineAppliedAuthorization) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });
    ASSERT_EQ (request.auth_header, "Authorization");

    auto result = run (R"JS(
        pm.environment.set('seen', pm.request.headers['Authorization']);
        pm.request.auth = { type: 'basic', basic: { username: 'alice', password: 'pw' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("seen"), "Bearer engine-token");
    EXPECT_EQ (authorization (), basic ("alice:pw"));
    EXPECT_EQ (request.headers.count ("Authorization"), 1u);
}

TEST_F (ScriptRequestAuthTest, AnAssignmentReplacesAnEngineAppliedQueryKey) {
    apply_engine_auth (vayu::http::ApiKeyAuth{ "api_key", "engine-key", true });
    ASSERT_EQ (request.url, std::string (BASE_URL) + "&api_key=engine-key");

    auto result = run (R"JS(
        pm.request.auth = { type: 'bearer', bearer: { token: 'mine' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, BASE_URL);
    EXPECT_TRUE (request.auth_query_param.empty ());
    EXPECT_EQ (authorization (), "Bearer mine");
}

// The engine's pair is found by its wire bytes, so a URL the script edited a
// member at a time - recomposed from its parts - still gives it up, whether
// the assignment sends nothing or a query key of its own, which is then the
// one name the trace masks. Mutation check: skip the query pair's removal in
// `drop_engine_credential` and both halves keep `api_key=a%20b%26c`.
TEST_F (ScriptRequestAuthTest, AnEngineQueryKeyIsTakenOffAUrlTheScriptEditedFirst) {
    apply_engine_auth (vayu::http::ApiKeyAuth{ "api_key", "a b&c", true });
    ASSERT_EQ (request.url, std::string (BASE_URL) + "&api_key=a%20b%26c");
    const Request engine_applied = request;

    auto result = run (R"JS(
        pm.request.url.addQueryParams('page=2');
        pm.request.auth = { type: 'noauth' };
    )JS");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, std::string (BASE_URL) + "&page=2");
    EXPECT_TRUE (request.auth_query_param.empty ());

    request = engine_applied;
    result  = run (R"JS(
        pm.request.url.addQueryParams([{ key: 'page', value: '2' }]);
        pm.request.url.path.push('me');
        pm.request.auth = { type: 'apikey', apikey: { key: 'token', value: 'n e w', in: 'query' } };
    )JS");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users/me?a=1&page=2&token=n%20e%20w");
    EXPECT_EQ (request.auth_query_param, "token");
}

// The keep half. A header the engine did not write - here, one the request
// carried, so `apply_auth` wrote none - wins over the assigned auth as it wins
// over the request's own. Mutation check: drop the `auth_header` emptiness
// test so the header is dropped whoever wrote it, and this sends Basic.
TEST_F (ScriptRequestAuthTest, AHeaderTheEngineDidNotWriteIsKept) {
    request.headers.add ("Authorization", "Custom typed");
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });
    ASSERT_TRUE (request.auth_header.empty ());

    auto result = run (R"JS(
        pm.request.auth = { type: 'basic', basic: { username: 'alice', password: 'pw' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Custom typed");
}

// And a value the script wrote itself under the engine's name is the
// script's. Mutation check: drop the value comparison in
// `drop_engine_credential` and this sends Basic.
TEST_F (ScriptRequestAuthTest, AHeaderTheScriptRewroteIsKept) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });

    auto result = run (R"JS(
        pm.request.headers['Authorization'] = 'Custom mine';
        pm.request.auth = { type: 'basic', basic: { username: 'alice', password: 'pw' } };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Custom mine");
}

TEST_F (ScriptRequestAuthTest, NoauthStripsTheEngineAppliedCredential) {
    apply_engine_auth (vayu::http::ApiKeyAuth{ "X-Api-Key", "engine-key", false });
    ASSERT_TRUE (request.headers.contains ("X-Api-Key"));

    auto result = run ("pm.request.auth = { type: 'noauth' };");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Api-Key"));
    EXPECT_TRUE (request.secret_header_names.empty ());
    EXPECT_TRUE (request.auth_from_script);
}

// Undefined and null both mean "no auth of the script's own", which is what an
// absent request auth means in Postman: the request's own still goes out.
TEST_F (ScriptRequestAuthTest, ADeletedOrNullAuthKeepsTheRequestsOwn) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });

    auto result = run (R"JS(
        pm.request.auth = { type: 'basic', basic: { username: 'alice', password: 'pw' } };
        delete pm.request.auth;
    )JS");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Bearer engine-token");
    EXPECT_FALSE (request.auth_from_script);

    result = run ("pm.request.auth = null;");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Bearer engine-token");
}

// ---------------------------------------------------------------------------
// Refused by name, all or nothing.
// ---------------------------------------------------------------------------

// The silent drop this issue exists to close, for the type the sandbox cannot
// compose: the request keeps the auth it had, and nothing else the script
// wrote is applied either.
TEST_F (ScriptRequestAuthTest, Oauth2IsRefusedByNameAndNothingIsApplied) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });

    auto result = run (R"JS(
        pm.request.headers['X-Trace'] = 't-1';
        pm.request.auth = { type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'x' }] };
    )JS");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.auth type \"oauth2\""), std::string::npos)
    << result.error_message;
    EXPECT_EQ (authorization (), "Bearer engine-token");
    EXPECT_FALSE (request.headers.contains ("X-Trace"));
    EXPECT_FALSE (request.auth_from_script);
}

// Basic has no required parameter, so a misspelled block would otherwise be
// sent as `Basic Og==`.
TEST_F (ScriptRequestAuthTest, ATypeWithNoBlockToReadIsRefused) {
    auto result =
    run ("pm.request.auth = { type: 'basic', Basic: { username: 'alice' } };");

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("no pm.request.auth.basic block"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
}

// A parameter the type does not take, in either spelling, is named with the
// ones it does take: read past, `user` / `pass` composed `Basic Og==` and sent
// it. Mutation check: let `read_auth_parameter` skip an unaccepted name
// instead of refusing it, and every case here sends.
TEST_F (ScriptRequestAuthTest, AParameterTheTypeDoesNotTakeIsRefusedNamingTheOnesItDoes) {
    const auto expect_refused = [this] (const std::string& script, const std::string& named) {
        request.headers.erase ("Authorization");
        const auto result = run (script);

        EXPECT_FALSE (result.success) << script;
        EXPECT_NE (result.error_message.find (named), std::string::npos)
        << result.error_message;
        EXPECT_FALSE (request.headers.contains ("Authorization")) << script;
        EXPECT_FALSE (request.auth_from_script) << script;
    };

    expect_refused (R"JS(
        pm.request.auth = { type: 'basic', basic: { user: 'a', pass: 'b' } };
    )JS",
    "pm.request.auth.basic has no parameter 'user' - basic takes username, "
    "password");
    expect_refused (R"JS(
        pm.request.auth = { type: 'basic', basic: [{ key: 'user', value: 'a' }] };
    )JS",
    "pm.request.auth.basic has no parameter 'user'");
    expect_refused (R"JS(
        pm.request.auth = { type: 'bearer', bearer: { token: 't', prefix: 'Token' } };
    )JS",
    "pm.request.auth.bearer has no parameter 'prefix' - bearer takes token");
    expect_refused (R"JS(
        pm.request.auth = { type: 'apikey', apikey: [
            { key: 'key', value: 'X-K' }, { key: 'addTo', value: 'header' } ] };
    )JS",
    "pm.request.auth.apikey has no parameter 'addTo' - apikey takes key, "
    "value, in");
}

// What Postman's own export writes beside the credential reads: each entry's
// `type`, and the basic helper's `showPassword`, which sends nothing.
// Mutation check: drop `showPassword` from the basic type's ignored names and
// this is refused as an unknown parameter.
TEST_F (ScriptRequestAuthTest, AnExportedBlockWithPostmansHelperStateReads) {
    auto result = run (R"JS(
        pm.request.auth = { type: 'basic', basic: [
            { key: 'password', value: 's3cret', type: 'string' },
            { key: 'username', value: 'alice', type: 'string' },
            { key: 'showPassword', value: false, type: 'boolean' } ] };
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), basic ("alice:s3cret"));
}

// Either half of basic may be empty, as in Postman; both is no credential.
// Mutation check: drop the both-empty refusal and the first case sends
// `Basic Og==`.
TEST_F (ScriptRequestAuthTest, ABasicBlockWithNeitherHalfIsRefused) {
    for (const char* script :
    { "pm.request.auth = { type: 'basic', basic: { showPassword: false } };",
    "pm.request.authorizeUsing('basic', { username: '', password: '' });" }) {
        const auto result = run (script);

        EXPECT_FALSE (result.success) << script;
        EXPECT_NE (
        result.error_message.find ("needs a 'username' or a 'password'"), std::string::npos)
        << result.error_message;
        EXPECT_FALSE (request.headers.contains ("Authorization")) << script;
    }

    const auto result =
    run ("pm.request.auth = { type: 'basic', basic: { username: 'alice' } };");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), basic ("alice:"));
}

TEST_F (ScriptRequestAuthTest, AnApiKeyWhoseNameIsNotAHeaderNameIsRefused) {
    auto result = run (R"JS(
        pm.request.auth = { type: 'apikey', apikey: { key: 'X Key', value: 'v' } };
    )JS");

    EXPECT_FALSE (result.success);
    EXPECT_NE (
    result.error_message.find ("pm.request.auth could not be applied"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.auth_from_script);
}

// ---------------------------------------------------------------------------
// authorizeUsing, and reading the assignment back.
// ---------------------------------------------------------------------------

TEST_F (ScriptRequestAuthTest, AuthorizeUsingTakesATypeAndItsOptions) {
    auto result = run (R"JS(
        pm.request.authorizeUsing('basic', { username: 'alice', password: 'pw' });
        pm.environment.set('type', pm.request.auth.type);
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), basic ("alice:pw"));
    EXPECT_EQ (read_back ("type"), "basic");
}

// Postman's one-argument form, `{ type, ...options }`, and the
// `pm.request.auth` shape, which a lifted script hands over just as often.
TEST_F (ScriptRequestAuthTest, AuthorizeUsingTakesEitherObjectForm) {
    auto result =
    run ("pm.request.authorizeUsing({ type: 'bearer', token: 'one' });");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Bearer one");

    request.headers.erase ("Authorization");
    result = run (R"JS(
        pm.request.authorizeUsing({ type: 'bearer', bearer: [{ key: 'token', value: 'two' }] });
    )JS");
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (authorization (), "Bearer two");
}

// Thrown at the call, so the script's own try/catch and line number see it,
// where Postman ignores an unknown type and sends the request bare.
TEST_F (ScriptRequestAuthTest, AuthorizeUsingThrowsNamingATypeItCannotCompose) {
    auto result = run (R"JS(
        try {
            pm.request.authorizeUsing('oauth2', { accessToken: 'x' });
        } catch (e) {
            pm.environment.set('caught', e.message);
        }
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    const std::string caught = read_back ("caught");
    EXPECT_NE (caught.find ("pm.request.authorizeUsing"), std::string::npos) << caught;
    EXPECT_NE (caught.find ("oauth2"), std::string::npos) << caught;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
}

TEST_F (ScriptRequestAuthTest, AuthorizeUsingNullRemovesAnAssignedAuth) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });

    auto result = run (R"JS(
        pm.request.authorizeUsing('noauth');
        pm.request.authorizeUsing(null);
        pm.environment.set('auth', typeof pm.request.auth);
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("auth"), "undefined");
    EXPECT_EQ (authorization (), "Bearer engine-token");
}

// Unassigned it reads undefined, and the engine's credential is visible as the
// header it wrote; assigned, it reads back and toJSON carries it.
TEST_F (ScriptRequestAuthTest, AnAssignedAuthReadsBackAndToJsonCarriesIt) {
    apply_engine_auth (vayu::http::BearerAuth{ "engine-token" });

    auto result = run (R"JS(
        var before = typeof pm.request.auth;
        pm.request.auth = { type: 'bearer', bearer: { token: 'mine' } };
        pm.environment.set('read', before + '|' + pm.request.auth.bearer.token + '|' +
            pm.request.toJSON().auth.type + '|' + Object.keys(pm.request).join(','));
    )JS");

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (read_back ("read"), "undefined|mine|bearer|url,method,headers,auth");
}

#endif

} // namespace
