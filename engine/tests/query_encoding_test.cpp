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
#include "vayu/core/import_document.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
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

/// A Postman v2.1 collection holding one GET item at @p raw with @p rows as
/// its `query[]`, written as Postman writes them (`disabled`, not `enabled`).
std::string postman_item (const std::string& raw, const json& rows, bool encode) {
    json query = json::array ();
    for (const json& row : rows) {
        query.push_back ({ { "key", row.at ("key") }, { "value", row.at ("value") },
        { "disabled", !row.at ("enabled").get<bool> () } });
    }
    json item = { { "name", "R" },
        { "request",
        { { "method", "GET" }, { "url", { { "raw", raw }, { "query", query } } } } } };
    if (!encode) {
        item["protocolProfileBehavior"] = { { "disableUrlEncoding", true } };
    }
    return json{ { "info", { { "schema", POSTMAN_SCHEMA } } },
        { "item", json::array ({ item }) } }
    .dump ();
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

} // namespace
