/**
 * @file tests/request_composer_test.cpp
 * @brief Tests for engine-side request composition (issue #226): the
 * cross-language conformance fixture, the dynamic-variable table, the
 * collection-chain inherit walk, and the POST /compose core.
 *
 * The fixture (`tests/fixtures/variable-resolution-conformance.json`) is the
 * contract between this suite and the app's vitest suite
 * (`app/src/lib/variable-resolution.conformance.test.ts`): both drive their
 * implementation over the same `(scopes, input, expected)` table, so a
 * divergence between engine execution and renderer preview fails somewhere
 * rather than reaching a user. Scopes are raw stored-variables bags, so the
 * fixture also exercises `parse_variables`' D17 tolerance (absent `enabled`
 * is enabled, a non-string `value` reads as "").
 *
 * The DB-backed tests mirror the suite's other route tests: they drive the
 * extracted core (`compose_request_core`) against a real database file, no
 * in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <regex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "variable-resolution-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

// Build a vayu::Environment from a fixture bag through the same parser the
// engine uses on stored blobs - the D17 rules live there, and reading the bag
// any other way would test a path production never takes.
vayu::Environment env_from_bag (const json& bag) {
    return vayu::json::parse_variables (bag.dump ());
}

vayu::http::VariableValues values_from_scopes (const json& scopes) {
    vayu::Environment globals, environment;
    std::vector<vayu::Environment> chain;
    if (scopes.contains ("globals")) {
        globals = env_from_bag (scopes["globals"]);
    }
    if (scopes.contains ("chain")) {
        for (const auto& bag : scopes["chain"]) {
            chain.push_back (env_from_bag (bag));
        }
    }
    if (scopes.contains ("environment")) {
        environment = env_from_bag (scopes["environment"]);
    }
    return vayu::http::build_variable_values (globals, chain, environment);
}

TEST (VariableResolutionConformance, EveryFixtureCasePasses) {
    const json fixture = load_fixture ();
    ASSERT_FALSE (fixture["cases"].empty ())
    << "conformance fixture scanned nothing";
    for (const auto& c : fixture["cases"]) {
        const auto vars = values_from_scopes (c["scopes"]);
        EXPECT_EQ (vayu::http::resolve_template (c["input"].get<std::string> (), vars),
        c["expected"].get<std::string> ())
        << "case: " << c["name"].get<std::string> ();
    }
}

TEST (VariableResolutionConformance, DynamicVariableNamesMatchFixture) {
    const json fixture = load_fixture ();
    std::vector<std::string> expected;
    for (const auto& name : fixture["dynamicVariableNames"]) {
        expected.push_back (name.get<std::string> ());
    }
    ASSERT_FALSE (expected.empty ()) << "conformance fixture scanned nothing";
    EXPECT_EQ (vayu::http::dynamic_variable_names (), expected);
}

TEST (DynamicVariables, EveryGeneratorProducesANonEmptyNonBraceValue) {
    const vayu::http::VariableValues no_vars;
    for (const auto& name : vayu::http::dynamic_variable_names ()) {
        const std::string input = "{{" + name + "}}";
        const std::string resolved = vayu::http::resolve_template (input, no_vars);
        EXPECT_FALSE (resolved.empty ()) << name;
        EXPECT_NE (resolved, input) << name;
    }
}

TEST (DynamicVariables, GuidIsAUuidV4AndDiffersPerOccurrence) {
    const vayu::http::VariableValues no_vars;
    const std::string out = vayu::http::resolve_template ("{{$guid}}|{{$guid}}", no_vars);
    const auto sep = out.find ('|');
    ASSERT_NE (sep, std::string::npos);
    const std::string a = out.substr (0, sep);
    const std::string b = out.substr (sep + 1);
    const std::regex uuid_v4 (
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    EXPECT_TRUE (std::regex_match (a, uuid_v4)) << a;
    EXPECT_TRUE (std::regex_match (b, uuid_v4)) << b;
    // Once per occurrence: two {{$guid}} in one payload are two different ids.
    EXPECT_NE (a, b);
}

TEST (DynamicVariables, RandomIntStaysInRange) {
    const vayu::http::VariableValues no_vars;
    for (int i = 0; i < 50; ++i) {
        const int value =
        std::stoi (vayu::http::resolve_template ("{{$randomInt}}", no_vars));
        EXPECT_GE (value, 0);
        EXPECT_LE (value, 1000);
    }
}

// --- DB-backed composition ---------------------------------------------------

class RequestComposerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_request_composer.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection (const std::string& id,
    const std::string& parent_id,
    const std::string& variables = "",
    const std::string& auth      = "",
    const std::string& pre       = "",
    const std::string& post      = "") {
        vayu::db::Collection col;
        col.id = id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.name                = "Collection " + id;
        col.variables           = variables;
        col.auth                = auth;
        col.pre_request_script  = pre;
        col.post_request_script = post;
        col.order               = 0;
        col.created_at          = 1;
        col.updated_at          = 1;
        db_->create_collection (col);
    }

    void seed_environment (const std::string& id, const std::string& variables) {
        vayu::db::Environment env;
        env.id         = id;
        env.name       = "Env " + id;
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    vayu::db::Request make_request (const std::string& id, const std::string& collection_id) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::POST;
        r.url           = "https://{{host}}/api/{{path}}";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        return r;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RequestComposerTest, CollectionChainIsRootFirstAndCycleGuarded) {
    seed_collection ("root", "");
    seed_collection ("mid", "root");
    seed_collection ("leaf", "mid");
    auto chain = vayu::http::collection_chain (*db_, "leaf");
    ASSERT_EQ (chain.size (), 3u);
    EXPECT_EQ (chain[0].id, "root");
    EXPECT_EQ (chain[1].id, "mid");
    EXPECT_EQ (chain[2].id, "leaf");

    // A parent cycle terminates instead of hanging under the DB mutex.
    seed_collection ("a", "b");
    seed_collection ("b", "a");
    auto cyclic = vayu::http::collection_chain (*db_, "a");
    EXPECT_EQ (cyclic.size (), 2u);

    EXPECT_TRUE (vayu::http::collection_chain (*db_, "missing").empty ());
    EXPECT_TRUE (vayu::http::collection_chain (*db_, "").empty ());
}

TEST_F (RequestComposerTest, InheritWalksLeafToRootAndNoauthTerminates) {
    seed_collection ("root", "", "", R"({"mode":"bearer","token":"root-token"})");
    seed_collection ("mid", "root", "", R"({"mode":"none"})");
    seed_collection ("leaf", "mid", "", "");

    // `none` (and an absent auth) step over; the nearest concrete auth wins.
    auto chain = vayu::http::collection_chain (*db_, "leaf");
    auto auth  = vayu::http::resolve_inherited_auth (chain);
    ASSERT_TRUE (auth.is_object ());
    EXPECT_EQ (auth["token"], "root-token");

    // An explicit noauth between leaf and that auth ends the walk: "send
    // nothing" is a different answer from "nobody configured any".
    seed_collection ("root2", "", "", R"({"mode":"bearer","token":"root2-token"})");
    seed_collection ("blocker", "root2", "", R"({"mode":"noauth"})");
    seed_collection ("leaf2", "blocker", "", "");
    auto blocked =
    vayu::http::resolve_inherited_auth (vayu::http::collection_chain (*db_, "leaf2"));
    EXPECT_TRUE (blocked.is_null ());

    EXPECT_TRUE (vayu::http::resolve_inherited_auth ({}).is_null ());
}

TEST_F (RequestComposerTest, ComposesASavedRequestById) {
    seed_collection ("root", "",
    R"({"host":{"value":"root.test","enabled":true},"path":{"value":"root-path","enabled":true}})",
    R"({"mode":"bearer","token":"{{token}}"})", "console.log('root pre');",
    "console.log('root post');");
    seed_collection ("leaf", "root",
    R"({"path":{"value":"leaf-path","enabled":true},"token":{"value":"leaf-token","enabled":true}})",
    "", "", "console.log('leaf post');");
    seed_environment ("env_1", R"({"host":{"value":"env.test","enabled":true}})");

    auto r = make_request ("req_1", "leaf");
    r.headers = R"([{"key":"X-Token","value":"{{token}}","enabled":true},{"key":"X-Off","value":"nope","enabled":false},{"key":"","value":"dropped"}])";
    r.body = R"({"mode":"json","content":"{\"host\":\"{{host}}\"}"})";
    r.auth = R"({"mode":"inherit"})";
    r.pre_request_script  = "console.log('own pre');";
    r.post_request_script = "";
    r.follow_redirects    = false;
    r.max_redirects       = 3;
    r.http_version        = "http2";
    db_->save_request (r);

    auto [status, payload] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_1" } });
    ASSERT_EQ (status, 200) << payload.dump ();

    // Variables: environment > chain leaf > chain root.
    EXPECT_EQ (payload["url"], "https://env.test/api/leaf-path");
    EXPECT_EQ (payload["method"], "POST");

    // Headers: enabled-only, empty keys dropped, values resolved.
    EXPECT_EQ (payload["headers"], (json{ { "X-Token", "leaf-token" } }));

    // Body content resolved.
    EXPECT_EQ (payload["body"]["mode"], "json");
    EXPECT_EQ (payload["body"]["content"], "{\"host\":\"env.test\"}");

    // Inherit resolved through the chain to root's bearer, then its
    // {{token}} resolved - the walk and the substitution compose.
    EXPECT_EQ (payload["auth"]["mode"], "bearer");
    EXPECT_EQ (payload["auth"]["token"], "leaf-token");

    // Script parts: chain root->leaf then the request's own, blanks dropped.
    ASSERT_EQ (payload["preRequestScripts"].size (), 2u);
    EXPECT_EQ (payload["preRequestScripts"][0]["origin"], "collection");
    EXPECT_EQ (payload["preRequestScripts"][0]["id"], "root");
    EXPECT_EQ (payload["preRequestScripts"][1]["origin"], "request");
    EXPECT_EQ (payload["preRequestScripts"][1]["script"], "console.log('own pre');");
    ASSERT_EQ (payload["postRequestScripts"].size (), 2u);
    EXPECT_EQ (payload["postRequestScripts"][0]["id"], "root");
    EXPECT_EQ (payload["postRequestScripts"][1]["id"], "leaf");

    // Execution options always emitted from the stored row.
    EXPECT_EQ (payload["followRedirects"], false);
    EXPECT_EQ (payload["maxRedirects"], 3);
    EXPECT_EQ (payload["httpVersion"], "http2");

    // Ids echoed so the composed payload can be POSTed to /execute unchanged.
    EXPECT_EQ (payload["requestId"], "req_1");
    EXPECT_EQ (payload["environmentId"], "env_1");
}

TEST_F (RequestComposerTest, StoredRequestWithoutAuthBlobDefaultsToInherit) {
    seed_collection ("col", "", "", R"({"mode":"apikey","key":"X-Key","value":"k"})");
    auto r = make_request ("req_1", "col");
    r.url  = "https://example.test";
    r.auth = ""; // rows saved before the auth column's default existed
    db_->save_request (r);

    auto [status, payload] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["auth"]["mode"], "apikey");
}

TEST_F (RequestComposerTest, RequestLevelNoauthAndNoneSendNothing) {
    seed_collection ("col", "", "", R"({"mode":"bearer","token":"t"})");
    for (const char* mode : { R"({"mode":"noauth"})", R"({"mode":"none"})" }) {
        auto r = make_request ("req_1", "col");
        r.url  = "https://example.test";
        r.auth = mode;
        db_->save_request (r);
        auto [status, payload] =
        vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
        ASSERT_EQ (status, 200);
        EXPECT_FALSE (payload.contains ("auth")) << mode;
    }
}

TEST_F (RequestComposerTest, ComposesAnInlineRequestAgainstAScope) {
    seed_collection ("col", "", R"({"host":{"value":"col.test","enabled":true}})",
    R"({"mode":"bearer","token":"{{secret}}"})");
    seed_environment ("env_1", R"({"secret":{"value":"s3cr3t","enabled":true}})");

    const json body = { { "request",
                        { { "method", "get" }, { "url", "https://{{host}}/x" },
                        { "headers", { { "X-{{host}}", "{{secret}}" } } },
                        { "body", { { "mode", "text" }, { "content", "v={{secret}}" } } },
                        { "auth", { { "mode", "inherit" } } },
                        { "preRequestScripts",
                        json::array ({ { { "origin", "request" },
                        { "script", "pm.request; // {{not-touched}}" } } }) },
                        { "followRedirects", true } } },
        { "collectionId", "col" }, { "environmentId", "env_1" } };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["method"], "GET");
    EXPECT_EQ (payload["url"], "https://col.test/x");
    EXPECT_EQ (payload["headers"], (json{ { "X-col.test", "s3cr3t" } }));
    EXPECT_EQ (payload["body"]["content"], "v=s3cr3t");
    // Inline inherit resolves through the supplied collection scope, and the
    // winning block's own {{vars}} resolve (strictly before any OAuth cache
    // key could be derived from it - D10).
    EXPECT_EQ (payload["auth"]["token"], "s3cr3t");
    // Scripts pass through untouched - never interpolated (D16).
    EXPECT_EQ (payload["preRequestScripts"][0]["script"], "pm.request; // {{not-touched}}");
    EXPECT_EQ (payload["followRedirects"], true);
    EXPECT_EQ (payload["environmentId"], "env_1");
}

// A form body carries its content as `fields`, so resolution has to reach
// inside them - the composer's `content` pass alone would leave a form body
// full of literal `{{...}}` on the wire. The engine only started *sending*
// these bodies with issue #381; this pins the half of the pipeline that was
// already right, so the two cannot drift apart.
TEST_F (RequestComposerTest, ResolvesVariablesInsideFormFields) {
    seed_collection ("col", "", R"({"host":{"value":"col.test","enabled":true}})");
    seed_environment ("env_1", R"({"secret":{"value":"s3cr3t","enabled":true}})");

    const json body = {
        { "request",
        { { "method", "post" }, { "url", "https://{{host}}/x" },
        { "body",
        { { "mode", "x-www-form-urlencoded" },
        { "fields",
        json::array ({ { { "key", "at-{{host}}" }, { "value", "{{secret}}" }, { "enabled", true } },
        { { "key", "off" }, { "value", "{{secret}}" }, { "enabled", false } } }) } } } } },
        { "collectionId", "col" }, { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["body"]["mode"], "x-www-form-urlencoded");
    EXPECT_EQ (payload["body"]["fields"][0]["key"], "at-col.test");
    EXPECT_EQ (payload["body"]["fields"][0]["value"], "s3cr3t");
    // A disabled field is still resolved and still carried: it is dropped at
    // the wire, not during composition, so switching it back on in the UI
    // needs no re-compose.
    EXPECT_EQ (payload["body"]["fields"][1]["value"], "s3cr3t");
    EXPECT_EQ (payload["body"]["fields"][1]["enabled"], false);
}

// A file part's path is as templatable as any other field - a fixture
// directory is exactly what an environment variable holds - and an unresolved
// `{{...}}` reaching the transfer would be opened as a literal filename and
// refused. The declared filename and per-part Content-Type resolve with it.
TEST_F (RequestComposerTest, ResolvesVariablesInsideAFilePart) {
    seed_environment ("env_1", R"({"fixtures":{"value":"/data/fixtures","enabled":true},
                                   "ext":{"value":"png","enabled":true}})");

    const json body = {
        { "request",
        { { "method", "post" }, { "url", "https://x.test/upload" },
        { "body",
        { { "mode", "form-data" },
        { "fields",
        json::array ({ { { "key", "avatar" }, { "type", "file" },
        { "src", "{{fixtures}}/avatar.{{ext}}" }, { "fileName", "avatar.{{ext}}" },
        { "contentType", "image/{{ext}}" }, { "enabled", true } } }) } } } } },
        { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    const auto& field = payload["body"]["fields"][0];
    EXPECT_EQ (field["src"], "/data/fixtures/avatar.png");
    EXPECT_EQ (field["fileName"], "avatar.png");
    EXPECT_EQ (field["contentType"], "image/png");
    EXPECT_EQ (field["type"], "file");
}

TEST_F (RequestComposerTest, InlineOverlayReplacesStoredFieldsAndStillResolves) {
    seed_collection ("col", "", R"({"host":{"value":"stored.test","enabled":true}})");
    auto r = make_request ("req_1", "col");
    db_->save_request (r);

    const json body        = { { "requestId", "req_1" },
               { "request", { { "url", "https://{{host}}/overridden" }, { "method", "put" } } } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["url"], "https://stored.test/overridden");
    EXPECT_EQ (payload["method"], "PUT");
    EXPECT_EQ (payload["requestId"], "req_1"); // stored identity survives overlay
}

TEST_F (RequestComposerTest, OAuth2ConfigIsResolvedBeforeAnyCacheKeyCanBe) {
    seed_collection ("col", "", "");
    seed_environment ("env_a", R"({"idp":{"value":"https://a.idp.test","enabled":true}})");
    seed_environment ("env_b", R"({"idp":{"value":"https://b.idp.test","enabled":true}})");
    auto r = make_request ("req_1", "col");
    r.url  = "https://example.test";
    r.auth = R"({"mode":"oauth2","config":{"grantType":"client_credentials","accessTokenUrl":"{{idp}}/token","clientId":"cid"}})";
    db_->save_request (r);

    auto [sa, pa] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_a" } });
    auto [sb, pb] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_b" } });
    ASSERT_EQ (sa, 200);
    ASSERT_EQ (sb, 200);
    // Two environments whose configs differ only through {{vars}} compose to
    // different concrete configs, so their token cache keys cannot collide.
    EXPECT_EQ (pa["auth"]["config"]["accessTokenUrl"], "https://a.idp.test/token");
    EXPECT_EQ (pb["auth"]["config"]["accessTokenUrl"], "https://b.idp.test/token");
}

TEST_F (RequestComposerTest, ComposedOutputIsNeverInterpolatedTwice) {
    // A body whose *resolved* content legitimately contains {{...}} (posting a
    // Postman collection, a Handlebars template) must survive composition
    // exactly once - and because /execute never interpolates, sending the
    // composed payload cannot resolve it again (D12).
    seed_environment ("env_1", R"({"tpl":{"value":"{{name}} says hi","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "POST" }, { "url", "https://example.test" },
                               { "body", { { "mode", "text" }, { "content", "{{tpl}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["body"]["content"], "{{name}} says hi");
}

TEST_F (RequestComposerTest, UnknownRequestIdIsADefinitive404) {
    auto [status, payload] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_missing" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (payload["error"]["code"], "request_not_found");
    EXPECT_NE (
    payload["error"]["message"].get<std::string> ().find ("req_missing"), std::string::npos);
}

TEST_F (RequestComposerTest, MalformedBodiesAre400sInTheNestedShape) {
    for (const auto& body : { json::object (), json{ { "requestId", 42 } },
         json{ { "request", "nope" } }, json (nullptr), json ("string") }) {
        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (payload["error"]["code"], "invalid_compose_request") << body.dump ();
        EXPECT_TRUE (payload["error"]["message"].is_string ()) << body.dump ();
    }
}

TEST_F (RequestComposerTest, UnknownScopeIdsDegradeToAnEmptyScope) {
    const json body = { { "request", { { "method", "GET" }, { "url", "https://x.test/{{missing}}" } } },
        { "collectionId", "col_missing" }, { "environmentId", "env_missing" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["url"], "https://x.test/");
}

} // namespace
