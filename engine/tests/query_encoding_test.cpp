/**
 * @file tests/query_encoding_test.cpp
 * @brief How a query row is written into a URL: Postman's own rule (issue
 *        #1771), through every engine path that joins one.
 *
 * `tests/fixtures/query-encoding-conformance.json` is the contract between
 * `core::encode_query_component` and the app's copy
 * (`query-encoding.conformance.test.ts` reads the same file): a case added
 * there fails whichever side answers it differently. Each case runs three
 * ways here - the encoder itself, an API key placed in the query by
 * `apply_auth`, and a Postman import's `query[]` joined into the stored URL -
 * because each is a separate caller that could keep an older rule.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using vayu::core::encode_query_component;
using vayu::core::ImportParse;
using vayu::core::parse_import;
using vayu::core::QueryPart;

constexpr const char* POSTMAN_SCHEMA =
"https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "query-encoding-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

/// A Postman v2.1 GET item at @p url, as a collection holding only it.
std::string postman_collection (const json& url, bool encode) {
    json item = { { "name", "R" }, { "request", { { "method", "GET" }, { "url", url } } } };
    if (!encode) {
        item["protocolProfileBehavior"] = { { "disableUrlEncoding", true } };
    }
    return json{ { "info", { { "schema", POSTMAN_SCHEMA } } },
        { "item", json::array ({ item }) } }
    .dump ();
}

/// A Postman v2.1 collection holding one GET item at @p raw with @p rows as
/// its `query[]`, written as Postman writes them (`disabled`, not `enabled`,
/// and a `valueless` row's value as `null`).
std::string postman_item (const std::string& raw, const json& rows, bool encode) {
    json query = json::array ();
    for (const json& row : rows) {
        query.push_back ({ { "key", row.at ("key") },
        { "value", row.value ("valueless", false) ? json (nullptr) : row.at ("value") },
        { "disabled", !row.at ("enabled").get<bool> () } });
    }
    return postman_collection (json{ { "raw", raw }, { "query", query } }, encode);
}

std::string imported_url (const std::string& document) {
    const ImportParse parsed = parse_import (document, {}, {});
    if (!parsed.ok ()) {
        ADD_FAILURE () << parsed.error;
        return {};
    }
    return parsed.result.at ("collections")[0].at ("requests")[0].at ("url").get<std::string> ();
}

TEST (QueryEncodingConformance, EveryComponentEncodesAsAKeyAndAsAValue) {
    const json fixture     = load_fixture ();
    const json& components = fixture.at ("components");
    // Guards the scan itself: an empty table would pass every case.
    ASSERT_GT (components.size (), 20U);
    for (const json& c : components) {
        const std::string name = c.at ("name").get<std::string> ();
        const std::string text = c.at ("text").get<std::string> ();
        EXPECT_EQ (encode_query_component (text, QueryPart::Key),
        c.at ("key").get<std::string> ())
        << name;
        EXPECT_EQ (encode_query_component (text, QueryPart::Value),
        c.at ("value").get<std::string> ())
        << name;
    }
}

// Postman adds an API key in the query as a query param, so the same rule
// writes it.
TEST (QueryEncodingConformance, AnApiKeyInTheQueryIsWrittenByTheSameRule) {
    const json fixture     = load_fixture ();
    const json& components = fixture.at ("components");
    ASSERT_GT (components.size (), 20U);
    for (const json& c : components) {
        const std::string text = c.at ("text").get<std::string> ();
        if (text.empty ()) {
            continue; // an empty key adds nothing
        }
        vayu::Request req;
        req.url           = "https://x/";
        const auto result = vayu::http::apply_auth (req,
        json{ { "mode", "apikey" }, { "in", "query" }, { "key", text }, { "value", text } },
        nullptr);
        EXPECT_TRUE (result.ok) << c.at ("name");
        EXPECT_EQ (req.url,
        "https://x/?" + c.at ("key").get<std::string> () + "=" +
        c.at ("value").get<std::string> ())
        << c.at ("name");
    }
}

TEST (QueryEncodingConformance, EveryQueryJoinsIntoAPostmanImportsStoredUrl) {
    const json fixture  = load_fixture ();
    const json& queries = fixture.at ("queries");
    ASSERT_GT (queries.size (), 10U);
    for (const json& q : queries) {
        const bool encode       = q.value ("encode", true);
        const std::string query = q.at ("query").get<std::string> ();
        const std::string expected = query.empty () ? "https://x/" : "https://x/?" + query;
        EXPECT_EQ (imported_url (postman_item ("https://x/", q.at ("rows"), encode)), expected)
        << q.at ("name");
    }
}

/// The first stored request of an imported @p document.
json imported_request (const std::string& document) {
    const ImportParse parsed = parse_import (document, {}, {});
    if (!parsed.ok ()) {
        ADD_FAILURE () << parsed.error;
        return json::object ();
    }
    return parsed.result.at ("collections")[0].at ("requests")[0];
}

// Issue #1772's acceptance: `{flag, ""}` stores `flag=`, and a null value a
// bare `flag` on a row that says so.
TEST (PostmanQueryImport, AnEmptyValueKeepsItsEqualsSignAndANullOneDoesNot) {
    const json empty = imported_request (postman_item ("https://x/?flag=&x=1",
    json::parse (R"([{"key":"flag","value":"","enabled":true},{"key":"x","value":"1","enabled":true}])"),
    true));
    EXPECT_EQ (empty.at ("url"), "https://x/?flag=&x=1");
    EXPECT_FALSE (empty.at ("params")[0].contains ("valueless"));

    const json null = imported_request (postman_collection (json::parse (R"({
        "raw": "https://x/?flag&x=1",
        "query": [{"key": "flag", "value": null}, {"key": "x", "value": "1"}]})"),
    true));
    EXPECT_EQ (null.at ("url"), "https://x/?flag&x=1");
    EXPECT_EQ (null.at ("params")[0],
    json::parse (R"({"key":"flag","value":"","enabled":true,"valueless":true})"));
}

// `QueryParam.parse` reads no value from a row that omits it, and from a
// pair with no `=` in a URL written as a string or a `raw` with no `query[]`.
TEST (PostmanQueryImport, AMissingValueAndABarePairAreValueless) {
    const json absent =
    json::parse (R"({"raw": "https://x/?flag", "query": [{"key": "flag"}]})");
    EXPECT_EQ (imported_request (postman_collection (absent, true)).at ("url"), "https://x/?flag");
    for (const json& url :
    { json ("https://x/?flag&e=&x=1"), json{ { "raw", "https://x/?flag&e=&x=1" } } }) {
        const json request = imported_request (postman_collection (url, true));
        EXPECT_EQ (request.at ("url"), "https://x/?flag&e=&x=1") << url.dump ();
        EXPECT_EQ (request.at ("params")[0].value ("valueless", false), true)
        << url.dump ();
        EXPECT_FALSE (request.at ("params")[1].contains ("valueless")) << url.dump ();
    }
}

/**
 * Issue #1771's own request, end to end: a Postman item
 * `GET https://x/?q=a|b&r=c d` is stored with `|` as written and the space as
 * `%20`, and that URL reaches the server byte for byte - libcurl passes a `|`
 * through rather than escaping it.
 */
class PostmanQueryOnTheWire : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<vayu::tests::EchoServer> ();
        client_ = std::make_unique<vayu::http::Client> ();
    }

    void TearDown () override {
        client_.reset ();
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    std::unique_ptr<vayu::tests::EchoServer> server_;
    std::unique_ptr<vayu::http::Client> client_;
};

const json& issue_rows () {
    static const json rows = json::parse (R"([
        {"key":"q","value":"a|b","enabled":true},
        {"key":"r","value":"c d","enabled":true}])");
    return rows;
}

TEST (PostmanQueryImport, TheIssuesItemIsStoredWithAPipeAsWritten) {
    EXPECT_EQ (imported_url (postman_item ("https://x/?q=a|b&r=c d", issue_rows (), true)),
    "https://x/?q=a|b&r=c%20d");
}

TEST_F (PostmanQueryOnTheWire, TheIssuesItemReachesTheServerAsStored) {
    const std::string raw = server_->url () + "?q=a|b&r=c d";
    const std::string url = imported_url (postman_item (raw, issue_rows (), true));
    ASSERT_EQ (url, server_->url () + "?q=a|b&r=c%20d");

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = url;
    auto result    = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->target (), "/echo?q=a|b&r=c%20d");
}

// ---------------------------------------------------------------------------
// Values known only at send time (issue #1773): a `{{var}}` in the URL and a
// script's `query.add`, written by the same rule once they are known.
// ---------------------------------------------------------------------------

TEST (QueryEncodingConformance, EverySubstitutionIsWrittenByTheRuleOfItsComponent) {
    const json fixture = load_fixture ();
    const json& cases  = fixture.at ("substitutions").at ("cases");
    ASSERT_GT (cases.size (), 10U);
    for (const json& c : cases) {
        vayu::http::VariableValues vars;
        for (const auto& [name, value] : c.at ("variables").items ()) {
            vars[name] = value.get<std::string> ();
        }
        EXPECT_EQ (vayu::http::resolve_url_template (
                   c.at ("url").get<std::string> (), vars, c.value ("encode", true)),
        c.at ("sent").get<std::string> ())
        << c.at ("name");
    }
}

/// A database with one environment, for the cases that compose: composition
/// is the first place a `{{var}}` in the URL is answered.
class SendTimeQueryValues : public PostmanQueryOnTheWire {
    protected:
    static constexpr const char* DB_PATH = "test_send_time_query_values.db";

    void SetUp () override {
        PostmanQueryOnTheWire::SetUp ();
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        PostmanQueryOnTheWire::TearDown ();
    }

    /// `url` composed against an environment holding @p variables, then sent;
    /// answers the target the server read.
    std::string compose_and_send (const std::string& url, const json& variables, bool encode) {
        vayu::db::Environment env;
        env.id         = "env_1";
        env.name       = "Env";
        env.variables  = variables.dump ();
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);

        json request = { { "method", "GET" }, { "url", url } };
        if (!encode) {
            request["disableUrlEncoding"] = true;
        }
        auto [status, payload] = vayu::http::compose_request_core (
        *db_, json{ { "request", request }, { "environmentId", "env_1" } });
        if (status != 200) {
            ADD_FAILURE () << payload.dump ();
            return {};
        }
        return send (payload.at ("url").get<std::string> ());
    }

    std::string send (const std::string& url, bool encode = true) {
        vayu::Request request;
        request.method               = vayu::HttpMethod::GET;
        request.url                  = url;
        request.disable_url_encoding = !encode;
        auto result                  = client_->send (request);
        if (!result.is_ok ()) {
            ADD_FAILURE () << result.error ().message;
            return {};
        }
        return server_->target ();
    }

    static json variable (const std::string& value) {
        return json{ { "value", value }, { "enabled", true } };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// `GET {{base}}?q={{term}}&{{k}}=1`: raw, libcurl refuses the space. Postman
// substitutes into the URL string and parses it again, so a value's `=` and
// `&` split pairs and its `#` opens the fragment (which is not sent).
TEST_F (SendTimeQueryValues, AComposedQueryValueReachesTheWireEncoded) {
    const json variables = { { "base", variable (server_->url ()) },
        { "term", variable ("a b\"c") }, { "k", variable ("x=y&z") } };
    EXPECT_EQ (compose_and_send ("{{base}}?q={{term}}&{{k}}=1", variables, true),
    "/echo?q=a%20b%22c&x=y&z=1");
    EXPECT_EQ (
    compose_and_send ("{{base}}?q={{term}}",
    { { "base", variable (server_->url ()) }, { "term", variable ("a b#c") } }, true),
    "/echo?q=a%20b");
}

TEST_F (SendTimeQueryValues, DisableUrlEncodingComposesTheValueAsItStands) {
    const json variables = { { "base", variable (server_->url ()) },
        { "term", variable ("a\"b") } };
    EXPECT_EQ (compose_and_send ("{{base}}?q={{term}}", variables, false), "/echo?q=a\"b");
}

// A name composition could not answer, set by the pre-request script, is
// resolved by the residual pass under the same rule.
TEST_F (SendTimeQueryValues, TheResidualPassEncodesAValueTheScriptSet) {
    vayu::Request request;
    request.url = server_->url () + "?{{k}}={{term}}";
    EXPECT_FALSE (vayu::http::routes::resolve_residual_tokens (request,
    vayu::http::VariableValues{ { "k", "a=b" }, { "term", "c d%41" } }));
    EXPECT_EQ (request.url, server_->url () + "?a=b=c%20d%41");
    EXPECT_EQ (send (request.url), "/echo?a=b=c%20d%41");

    vayu::Request as_typed;
    as_typed.url                  = server_->url () + "?q={{term}}";
    as_typed.disable_url_encoding = true;
    EXPECT_FALSE (vayu::http::routes::resolve_residual_tokens (
    as_typed, vayu::http::VariableValues{ { "term", "a\"b" } }));
    EXPECT_EQ (as_typed.url, server_->url () + "?q=a\"b");
}

#ifdef VAYU_HAS_QUICKJS
// `getQueryString()` reports the rows as they go out, so a signature computed
// over it signs the bytes the server receives.
TEST_F (SendTimeQueryValues, AScriptQueryAddIsEncodedAndGetQueryStringIsTheWire) {
    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::Request request;
    request.method    = vayu::HttpMethod::GET;
    request.url       = server_->url ();
    const auto result = engine.execute_prerequest (R"JS(
        pm.request.url.query.add({ key: 'k', value: 'a b' });
        pm.request.url.query.upsert({ key: 'x=y', value: 'c#d' });
        pm.environment.set('qs', pm.request.url.getQueryString());
    )JS",
    request, env);
    ASSERT_TRUE (result.success) << result.error_message;

    const std::string target = send (request.url);
    EXPECT_EQ (target, "/echo?k=a%20b&x%3Dy=c%23d");
    ASSERT_EQ (env.count ("qs"), 1U);
    EXPECT_EQ ("/echo?" + env.at ("qs").value, target);
}

TEST_F (SendTimeQueryValues, AScriptQueryAddIsWrittenAsTypedWhenUrlEncodingIsOff) {
    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::Request request;
    request.url                  = "https://x/";
    request.disable_url_encoding = true;
    const auto result            = engine.execute_prerequest (
    "pm.request.url.query.add({ key: 'k', value: 'a\"b' });", request, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://x/?k=a\"b");
}
#endif

} // namespace
