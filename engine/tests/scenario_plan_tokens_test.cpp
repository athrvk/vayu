/**
 * @file tests/scenario_plan_tokens_test.cpp
 * @brief Scenario plan resolution of `{{data.*}}` tokens: refused with no data set
 * (issue #415), bound per iteration inside a step's credentials (issue #591), and held
 * for the scripts when only a script can answer a credential (issue #2473).
 *
 * The `ScenarioPlanTest` fixture is in `scenario_plan_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/encoding.hpp"

#include "scenario_plan_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_plan::ScenarioPlanTest;

namespace {

// --- A data token with no data set (issue #415) -------------------------------

TEST_F (ScenarioPlanTest, ADataTokenWithNoDataSetIsRefusedNamingTheStepAndTheToken) {
    // Composition leaves `{{data.id}}` written as it stands on purpose, so a run
    // started without rows has nothing to bind it and would put the literal text
    // on the wire. Revert the scan in `resolve_scenario` and this resolves,
    // which is the shipped-through-to-the-server behaviour the issue reports.
    seed_collection ("col", "");
    seed_request ("clean", "col", /*order=*/0, "https://example.test/health");
    seed_request ("bound", "col", /*order=*/1, "https://example.test/u/{{data.id}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    // The step it names is the offending one, not the first one composed.
    EXPECT_NE (resolved.error.find ("step 1"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("Request bound"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("{{data.id}}"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("scenario.data"), std::string::npos)
    << resolved.error;
    // No partial plan, exactly as every other resolution failure leaves none.
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

// The identity shares the data namespace's template, and the refusal above must
// not follow it there: `{{$vu}}` needs no rows behind it, so a plan carrying
// only identity tokens is perfectly runnable (issue #994). Point the refusal's
// scan at `first_token` again instead of `first_data_token` and this reddens,
// with a run refused for lacking a data set it never needed.
TEST_F (ScenarioPlanTest, AnIdentityTokenNeedsNoDataSetAndIsNotRefusedForLackingOne) {
    seed_collection ("col", "");
    seed_request ("identity", "col", /*order=*/0,
    "https://example.test/u/{{$vu}}/i/{{$iteration}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    // Split for the bind and left written for it: the executor substitutes
    // them, so the plan still carries the tokens as composed.
    EXPECT_FALSE (resolved.plan.steps[0].data_template.empty ())
    << "the step's identity tokens were not split, so nothing would bind them";
    EXPECT_FALSE (resolved.plan.steps[0].data_template.first_data_token ().has_value ())
    << "an identity token must not read as a data token - that is what the "
       "no-data refusal scans for";
    EXPECT_NE (resolved.plan.steps[0].request.url.find ("{{$vu}}"), std::string::npos);
}

TEST_F (ScenarioPlanTest, TheSameCollectionResolvesWhenTheRunCarriesADataSet) {
    // The other half of the rule: the refusal is about the *absent* data set, not
    // about the token. A run with rows still resolves, and the token still
    // survives composition - the runner binds it per iteration, not here.
    seed_collection ("col", "");
    seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "id", "7" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    EXPECT_NE (resolved.plan.steps[0].request.url.find ("{{data.id}}"), std::string::npos)
    << resolved.plan.steps[0].request.url;
}

TEST_F (ScenarioPlanTest, ADataTokenOutsideTheUrlIsRefusedToo) {
    // The scan walks what `bind_data_row` substitutes, so every field the binder
    // would have bound must be a field the refusal sees. One field per case, so a
    // hole names itself instead of hiding behind the URL.
    const auto refused = [&] (const std::string& headers, const std::string& body) {
        reset_database ();
        seed_collection ("col", "");
        seed_request ("req", "col", /*order=*/0, "https://example.test/ok",
        /*auth=*/"", /*post_script=*/"", /*created_at=*/1, headers, body);

        const auto resolved =
        vayu::core::resolve_scenario (*db_, block ("col"), options ());
        EXPECT_FALSE (resolved.ok) << headers << " | " << body;
        EXPECT_NE (resolved.error.find ("{{data.id}}"), std::string::npos)
        << resolved.error;
    };

    refused (R"([{"key":"X-Id","value":"{{data.id}}","enabled":true}])", "");
    refused (R"([{"key":"{{data.id}}","value":"x","enabled":true}])", "");
    refused ("", R"({"mode":"json","content":"{\"id\":\"{{data.id}}\"}"})");
    refused ("", R"({"mode":"form-data","fields":[{"key":"id","value":"{{data.id}}","enabled":true}]})");
}

TEST_F (ScenarioPlanTest, TheNoDataRefusalCitesTheCollectionsDeclaredColumns) {
    // The reader that makes storing a contract worth anything (issue #599).
    // `resolve_scenario` already loaded this collection and threw it away;
    // capturing it is what lets the refusal say which file to run with rather
    // than only that one is missing. Revert the capture and this reddens.
    seed_collection ("col", "", /*order=*/0, /*auth=*/"", /*pre_script=*/"",
    /*created_at=*/1, R"({"columns":["id","email"],"declaredAt":1700000000000})");
    seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("declared columns: id, email"), std::string::npos)
    << resolved.error;
}

TEST_F (ScenarioPlanTest, TheNoDataRefusalStaysUnchangedWithoutAContract) {
    // The other half: a collection that declares nothing must not grow an empty
    // parenthetical, and a schema that is not one degrades to no tail at all
    // rather than to a message about columns that are not column names.
    for (const char* schema :
    { "{}", "", "not json", R"({"columns":"id"})", R"({"columns":[7]})" }) {
        reset_database ();
        seed_collection ("col", "", /*order=*/0, /*auth=*/"", /*pre_script=*/"",
        /*created_at=*/1, schema);
        seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

        const auto resolved =
        vayu::core::resolve_scenario (*db_, block ("col"), options ());

        EXPECT_FALSE (resolved.ok) << schema;
        EXPECT_EQ (resolved.error.find ("declared columns"), std::string::npos)
        << schema << " -> " << resolved.error;
    }
}

TEST_F (ScenarioPlanTest, ThePrefixAloneDoesNotBlockARunWithoutData) {
    // `{{data.}}` names no column, so composition treats it as any other
    // unknown name - since #1009 that means the token is left written as it
    // stands, and the scan for *columns* still finds nothing. Refusing the run
    // would block it over a token that binds to nothing either way.
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://example.test/u/{{data.}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://example.test/u/{{data.}}");
}

// --- Data tokens in the credentials (issue #591) ------------------------------

namespace {

/// The `Authorization` a step is carrying, or "" when it carries none.
std::string authorization_of (const vayu::Request& request) {
    const auto header = request.headers.find ("Authorization");
    return header == request.headers.end () ? std::string{} : header->value;
}

/// `bind_step_iteration` for row @p row_index, for a step whose auth the plan
/// did not hold for the scripts: what these cases assert is what the bind
/// applies.
vayu::core::DataBindResult bind_step (vayu::Request& request,
const vayu::core::ScenarioStep& step,
const std::vector<json>& rows,
size_t row_index) {
    std::optional<vayu::http::Auth> late_auth;
    auto bound = vayu::core::bind_step_iteration (
    request, step, rows, row_index, vayu::core::IterationIdentity{}, late_auth);
    EXPECT_FALSE (late_auth.has_value ())
    << "the bind held auth for the scripts";
    return bound;
}

} // namespace

TEST_F (ScenarioPlanTest, BasicAuthCredentialsBindPerIterationRatherThanEncodingTheToken) {
    // The canonical data-driven run: a credentials file behind basic auth. Bind
    // the credentials after `apply_auth` and every iteration sends
    // `base64("{{data.user}}:{{data.pass}}")` - the literal token text - as an
    // ordinary-looking 401. Nothing in the plan can see it once it is encoded,
    // which is why the plan must not encode it.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{data.pass}}"})");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" }, { "pass", "s3cret" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    const auto& step = resolved.plan.steps[0];

    // Deferred: the plan carries no credential at all for this step, so there
    // is nothing on it for the token text to have been baked into.
    EXPECT_FALSE (step.auth_template.empty ())
    << "the step's credentials carry a data token, so its auth must be "
       "deferred";
    EXPECT_EQ (authorization_of (step.request), "")
    << "auth was applied at plan time, which is what hid the token";

    vayu::Request request = step.request;
    const auto bound = bind_step (request, step, resolved.data_rows, /*row_index=*/0);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request),
    "Basic " + vayu::utils::base64_encode ("alice:s3cret"));
}

TEST_F (ScenarioPlanTest, EachRowGetsItsOwnCredentialsFromTheSamePlan) {
    // The plan is resolved once and shared by every iteration and virtual user,
    // so a bind that leaked into it would give every row the first row's
    // credentials. Two rows through one step is what shows it does not.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" } }, json{ { "user", "bob" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    std::vector<std::string> sent;
    for (size_t row = 0; row < resolved.data_rows.size (); ++row) {
        vayu::Request request = step.request;
        const auto bound = bind_step (request, step, resolved.data_rows, row);
        ASSERT_TRUE (bound.ok) << bound.error;
        sent.push_back (authorization_of (request));
    }

    EXPECT_EQ (sent[0], "Basic " + vayu::utils::base64_encode ("alice:pw"));
    EXPECT_EQ (sent[1], "Basic " + vayu::utils::base64_encode ("bob:pw"));
}

TEST_F (ScenarioPlanTest, BearerAndApiKeyCredentialsBindByContract) {
    // These two passed before this existed, but only by accident: their values
    // land verbatim in header text, so the request-side binder happened to walk
    // them. An api key in the *query* did not even manage that - `apply_auth`
    // percent-encoded the token's braces before the binder ever saw it. Pinned
    // so the accident cannot regress and the query placement stays fixed.
    const auto bound_request = [&] (const std::string& auth,
                               const std::string& url, const json& row) {
        reset_database ();
        seed_collection ("col", "");
        seed_request ("req", "col", /*order=*/0, url, auth);

        json scenario    = block ("col");
        scenario["data"] = json::array ({ row });

        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_TRUE (resolved.ok) << resolved.error;
        vayu::Request request = resolved.plan.steps[0].request;
        const auto result     = bind_step (
        request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
        EXPECT_TRUE (result.ok) << result.error;
        return request;
    };

    EXPECT_EQ (authorization_of (bound_request (R"({"mode":"bearer","token":"{{data.token}}"})",
               "https://example.test/x", json{ { "token", "t0ken" } })),
    "Bearer t0ken");

    const auto api_key_header =
    bound_request (R"({"mode":"apikey","key":"X-Key","value":"{{data.key}}"})",
    "https://example.test/x", json{ { "key", "k3y" } });
    ASSERT_EQ (api_key_header.headers.count ("X-Key"), 1u);
    EXPECT_EQ (api_key_header.headers.at ("X-Key"), "k3y");

    // The value is percent-encoded *after* the bind, so a cell with a space is
    // one query parameter rather than two.
    const auto api_key_query = bound_request (
    R"({"mode":"apikey","key":"token","value":"{{data.key}}","in":"query"})",
    "https://example.test/x", json{ { "key", "k 3y" } });
    EXPECT_EQ (api_key_query.url, "https://example.test/x?token=k%203y");
}

TEST_F (ScenarioPlanTest, AMissingColumnInACredentialEndsTheStepByName) {
    // The failure path: a credential naming a column the row does not carry is
    // the same loud error as one in the URL, not a request sent with a blank
    // password.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{data.missing}}"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    vayu::Request request = resolved.plan.steps[0].request;
    const auto bound =
    bind_step (request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
    EXPECT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("{{data.missing}}"), std::string::npos)
    << bound.error;
    EXPECT_EQ (authorization_of (request), "")
    << "a failed credential bind must send nothing, not a half-built header";
}

TEST_F (ScenarioPlanTest, ADataTokenInTheCredentialsWithNoDataSetIsRefused) {
    // The #415 guard, reached through the auth block. Before the credentials
    // were kept out of the base64 this run started and sent
    // `base64("{{data.user}}:")` on every request.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("{{data.user}}"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("scenario.data"), std::string::npos)
    << resolved.error;
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, ADataTokenInAnOAuth2ConfigIsRefusedWithOrWithoutData) {
    // The one mode the row bind cannot serve: the token is acquired against
    // the endpoint, never bound per iteration. Refused by name rather than
    // sent to the token endpoint as the literal text.
    const auto refused = [&] (const json& scenario) {
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_FALSE (resolved.ok);
        EXPECT_NE (resolved.error.find ("{{data.secret}}"), std::string::npos)
        << resolved.error;
        EXPECT_NE (resolved.error.find ("OAuth 2.0"), std::string::npos)
        << resolved.error;
        EXPECT_NE (resolved.error.find ("Request oauth_req"), std::string::npos)
        << resolved.error;
    };

    seed_collection ("col", "");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"tokenUrl":"https://auth.test/token",
        "clientId":"c","clientSecret":"{{data.secret}}"}})");

    refused (block ("col"));

    json with_rows    = block ("col");
    with_rows["data"] = json::array ({ json{ { "secret", "s" } } });
    refused (with_rows);
}

// #2521: a scripted step's OAuth 2.0 config waits for its script on a
// sequential plan, whose executor acquires after it; a load plan acquires
// once, here, from the stored values, keyed by the resolved config. Mutation
// check: make `resolve_step` compose with `AtComposition` whatever
// `oauth2_after_scripts` says, and the sequential plan carries the token.
TEST_F (ScenarioPlanTest, AScriptedOAuth2StepWaitsForItsScriptOnASequentialPlanOnly) {
    seed_collection ("col", "", /*order=*/0, /*auth=*/"",
    /*pre_script=*/"pm.environment.set('client', 'new');");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"grantType":"client_credentials","autoFetchToken":false,
        "accessTokenUrl":"https://auth.test/token","clientId":"{{client}}"}})");
    seed_environment ("env", R"({"client":{"value":"stored","enabled":true}})");
    // Cached under the stored config's key, so the load plan's acquisition
    // reads it with no endpoint behind it; non-expiring.
    vayu::db::OAuthToken token;
    token.cache_key =
    vayu::http::oauth::cache_key (json{ { "grantType", "client_credentials" },
    { "accessTokenUrl", "https://auth.test/token" }, { "clientId", "stored" } });
    token.access_token = "AT-stored";
    token.created_at   = 1;
    db_->save_oauth_token (token);

    auto sequential                 = options ();
    sequential.environment_id       = "env";
    sequential.oauth2_after_scripts = true;
    const auto waits = vayu::core::resolve_scenario (*db_, block ("col"), sequential);
    ASSERT_TRUE (waits.ok) << waits.error;
    const auto& late = waits.plan.steps.at (0);
    EXPECT_TRUE (late.auth_after_scripts);
    EXPECT_EQ (late.request.headers.count ("Authorization"), 0u);
    const auto* oauth2 = std::get_if<vayu::http::OAuth2Auth> (&late.auth);
    ASSERT_NE (oauth2, nullptr);
    EXPECT_EQ (oauth2->config.at ("clientId"), "{{client}}");
    EXPECT_TRUE (late.oauth2_config.is_null ())
    << "a deferred config is `auth`'s, and nothing a load run refreshes";

    auto load           = options ();
    load.environment_id = "env";
    const auto planned = vayu::core::resolve_scenario (*db_, block ("col"), load);
    ASSERT_TRUE (planned.ok) << planned.error;
    const auto& now = planned.plan.steps.at (0);
    EXPECT_FALSE (now.auth_after_scripts);
    ASSERT_EQ (now.request.headers.count ("Authorization"), 1u);
    EXPECT_EQ (now.request.headers.at ("Authorization"), "Bearer AT-stored");
    // Kept, resolved, so the run can refresh the token it placed (#3199).
    EXPECT_EQ (now.oauth2_config.value ("clientId", std::string ()), "stored");
}

// A name nothing answers: a load plan, which acquires before any script, has
// no moment left to resolve it and refuses it by name rather than asking the
// endpoint with the literal token; a sequential plan leaves it to the send.
TEST_F (ScenarioPlanTest, ALoadPlanRefusesAnOAuth2NameNothingAnswers) {
    seed_collection ("col", "");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"grantType":"client_credentials",
        "accessTokenUrl":"https://auth.test/token","clientId":"{{client}}"}})");

    const auto refused = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    EXPECT_FALSE (refused.ok);
    EXPECT_NE (refused.error.find ("{{client}}"), std::string::npos) << refused.error;
    EXPECT_NE (refused.error.find ("Request oauth_req"), std::string::npos)
    << refused.error;

    auto sequential                 = options ();
    sequential.oauth2_after_scripts = true;
    const auto waits = vayu::core::resolve_scenario (*db_, block ("col"), sequential);
    ASSERT_TRUE (waits.ok) << waits.error;
    EXPECT_TRUE (waits.plan.steps.at (0).auth_after_scripts);
}

TEST_F (ScenarioPlanTest, CredentialsWithoutADataTokenAreStillResolvedIntoThePlan) {
    // Deferral must not widen: the ordinary step still pays its auth once, at
    // plan time, and carries an executable credential without any per-iteration
    // work. Drop the `auth_template.empty()` test in `resolve_scenario` and
    // this step arrives at the wire with no `Authorization` at all.
    seed_collection ("col", "");
    seed_request ("static_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"basic","username":"alice","password":"s3cret"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "unused" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_TRUE (step.auth_template.empty ());
    EXPECT_FALSE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request),
    "Basic " + vayu::utils::base64_encode ("alice:s3cret"));

    // And `bind_step_iteration` is the no-op the executors call unconditionally.
    vayu::Request request = step.request;
    const auto bound = bind_step (request, step, resolved.data_rows, /*row_index=*/0);
    EXPECT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request), authorization_of (step.request));
}

TEST_F (ScenarioPlanTest, AUserSuppliedAuthorizationHeaderStillWinsOverBoundCredentials) {
    // `apply_auth`'s precedence rule is the deferred path's too, because it is
    // the same `apply_auth` - a header the user wrote is never overwritten,
    // whichever iteration the credentials came from.
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})",
    /*post_script=*/"", /*created_at=*/1,
    R"([{"key":"Authorization","value":"Bearer mine","enabled":true}])");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    vayu::Request request = resolved.plan.steps[0].request;
    const auto bound =
    bind_step (request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request), "Bearer mine");
}

// --- Credentials that wait on a script (issue #2473) -------------------------

namespace {

/// The basic pair @p auth holds, as `user:password`, or a note saying what it
/// is instead.
std::string basic_pair_held (const std::optional<vayu::http::Auth>& auth) {
    if (!auth) {
        return "<no auth held>";
    }
    const auto* basic = std::get_if<vayu::http::BasicAuth> (&*auth);
    return basic == nullptr ? "<not basic>" : basic->username + ":" + basic->password;
}

} // namespace

TEST_F (ScenarioPlanTest, ACredentialOnlyAScriptCanAnswerIsHeldForTheScripts) {
    // `{{password}}` survives composition because no scope defines it yet; a
    // step's pre-request script may. Encoded here it would be base64 of the
    // token text, which no later pass can read. Mutation check: drop
    // `auth_after_scripts` from the resolution in `resolve_step` and the step
    // carries `Basic base64(user:{{password}})` with nothing held.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"user","password":"{{password}}"})");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_TRUE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request), "")
    << "auth was encoded at plan time, around the token";

    vayu::Request request = step.request;
    std::optional<vayu::http::Auth> late_auth;
    const auto bound = vayu::core::bind_step_iteration (request, step,
    resolved.data_rows, std::nullopt, vayu::core::IterationIdentity{}, late_auth);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (basic_pair_held (late_auth), "user:{{password}}");
    EXPECT_EQ (authorization_of (request), "")
    << "the bind applied what it was meant to hold";
}

TEST_F (ScenarioPlanTest, ARowTokenBesideAScriptTokenBindsTheRowAndHoldsTheRest) {
    // Mixed credentials: the row answers its half at the bind, before anything
    // is encoded, and the script's half still waits.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{password}}"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];
    EXPECT_TRUE (step.auth_after_scripts);
    EXPECT_FALSE (step.auth_template.empty ());

    vayu::Request request = step.request;
    std::optional<vayu::http::Auth> late_auth;
    const auto bound = vayu::core::bind_step_iteration (request, step,
    resolved.data_rows, /*row_index=*/0, vayu::core::IterationIdentity{}, late_auth);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (basic_pair_held (late_auth), "alice:{{password}}");
    EXPECT_EQ (basic_pair_held (step.auth), "{{data.user}}:{{password}}")
    << "the bind wrote into the plan every iteration shares";
}

TEST_F (ScenarioPlanTest, ACredentialAScopeAnsweredAtComposeIsStillResolvedIntoThePlan) {
    // No behaviour change for the ordinary step: composition substituted the
    // name, so nothing waits, and the plan pays the auth once as it always did.
    seed_collection ("col", "");
    seed_environment ("env", R"({"password":{"value":"s3cret"}})");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"user","password":"{{password}}"})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_FALSE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request),
    "Basic " + vayu::utils::base64_encode ("user:s3cret"));
}

} // namespace
