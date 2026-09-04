/**
 * @file tests/default_headers_test.cpp
 * @brief What the engine adds to a request nobody wrote it into (issue #1229).
 *
 * Four rules are worth failing a build over, and each has a case here:
 *
 * - a default never overwrites a header the request itself carries;
 * - every default can be refused per send, so a testing tool can send exactly
 *   what was written;
 * - the correlation id is generated per transfer, which is the whole of the
 *   defect this issue was filed for - the renderer's stored one was replayed on
 *   every iteration of a load run;
 * - `Accept-Encoding` is recorded as sent without being appended to the header
 *   list, because libcurl writes that line itself from
 *   `CURLOPT_ACCEPT_ENCODING` and appending it here would send it twice.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Declared in config.cpp, the body of GET /request-defaults.
nlohmann::json request_defaults_json (vayu::db::Database& db,
vayu::http::DefaultHeaderScope scope);
// The whole route: the scope the caller named, or the refusal of one it does
// not know.
std::pair<int, nlohmann::json>
request_defaults_response (vayu::db::Database& db, std::string_view scope_param);
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

using vayu::http::DefaultHeaderPolicy;
using vayu::http::DefaultHeaderScope;

/// The header lines a built list would put on the wire, in list order.
std::vector<std::string> lines_of (curl_slist* list) {
    std::vector<std::string> lines;
    for (curl_slist* node = list; node != nullptr; node = node->next) {
        lines.emplace_back (node->data);
    }
    return lines;
}

bool has_line (const std::vector<std::string>& lines, const std::string& line) {
    return std::find (lines.begin (), lines.end (), line) != lines.end ();
}

/// Build the list and the sent record together, freeing the list afterwards.
struct BuiltHeaders {
    std::vector<std::string> lines;
    vayu::Headers sent;
};

BuiltHeaders build (const vayu::Request& request, const DefaultHeaderPolicy& policy) {
    BuiltHeaders built;
    curl_slist* list =
    vayu::http::detail::build_request_header_list (request, policy, &built.sent);
    built.lines = lines_of (list);
    curl_slist_free_all (list);
    return built;
}

vayu::Request get_request () {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = "https://example.com/";
    return request;
}

DefaultHeaderPolicy full_policy () {
    DefaultHeaderPolicy policy;
    policy.user_agent         = "Vayu/9.9.9";
    policy.correlation_header = "X-Vayu-Request-Id";
    policy.accept_encoding    = "gzip, deflate";
    return policy;
}

// ---------------------------------------------------------------------------
// The header list and the sent record
// ---------------------------------------------------------------------------

TEST (DefaultHeadersTest, AddsTheDeclaredSetToARequestThatNamesNoneOfIt) {
    const auto built = build (get_request (), full_policy ());

    EXPECT_TRUE (has_line (built.lines, "User-Agent: Vayu/9.9.9"));
    EXPECT_EQ (built.sent.at ("User-Agent"), "Vayu/9.9.9");
    EXPECT_TRUE (built.sent.contains ("X-Vayu-Request-Id"));
    EXPECT_EQ (built.sent.at ("Accept-Encoding"), "gzip, deflate");
}

TEST (DefaultHeadersTest, AHeaderTheRequestCarriesWinsOverTheDefault) {
    vayu::Request request                = get_request ();
    request.headers["User-Agent"]        = "Mozilla/5.0";
    request.headers["X-Vayu-Request-Id"] = "mine";

    const auto built = build (request, full_policy ());

    EXPECT_TRUE (has_line (built.lines, "User-Agent: Mozilla/5.0"));
    EXPECT_FALSE (has_line (built.lines, "User-Agent: Vayu/9.9.9"));
    EXPECT_EQ (built.sent.at ("X-Vayu-Request-Id"), "mine");
}

TEST (DefaultHeadersTest, ARequestsOwnAcceptEncodingSwitchesNegotiationOff) {
    vayu::Request request              = get_request ();
    request.headers["Accept-Encoding"] = "identity";

    const auto policy = full_policy ();
    EXPECT_FALSE (vayu::http::negotiates_compression (request, policy));

    const auto built = build (request, policy);
    // The request's own line is appended - libcurl sends it verbatim and hands
    // back whatever arrives - and the default's value is not what is recorded.
    EXPECT_TRUE (has_line (built.lines, "Accept-Encoding: identity"));
    EXPECT_EQ (built.sent.at ("Accept-Encoding"), "identity");
}

TEST (DefaultHeadersTest, EveryDefaultCanBeRefusedBySend) {
    vayu::Request request = get_request ();
    request.suppressed_default_headers.insert ("user-agent");
    request.suppressed_default_headers.insert ("Accept-Encoding");
    request.suppressed_default_headers.insert ("X-VAYU-REQUEST-ID");

    const auto policy = full_policy ();
    EXPECT_FALSE (vayu::http::negotiates_compression (request, policy));

    const auto built = build (request, policy);
    EXPECT_TRUE (built.lines.empty ());
    EXPECT_TRUE (built.sent.empty ());
}

TEST (DefaultHeadersTest, TheCorrelationIdIsFreshOnEveryTransfer) {
    const auto policy = full_policy ();
    const auto first  = build (get_request (), policy);
    const auto second = build (get_request (), policy);

    // The defect this issue was filed for: the renderer generated one id, saved
    // it into the request, and a load run then sent that same id on every
    // iteration. Generated per call here, so two transfers cannot share one.
    EXPECT_NE (first.sent.at ("X-Vayu-Request-Id"), second.sent.at ("X-Vayu-Request-Id"));
    EXPECT_FALSE (first.sent.at ("X-Vayu-Request-Id").empty ());
}

TEST (DefaultHeadersTest, AcceptEncodingIsRecordedWithoutBeingAppended) {
    const auto built = build (get_request (), full_policy ());

    // libcurl writes this line from CURLOPT_ACCEPT_ENCODING, which is what
    // makes it decode the response; a line here too would send it twice.
    for (const auto& line : built.lines) {
        EXPECT_EQ (line.find ("Accept-Encoding"), std::string::npos) << line;
    }
    EXPECT_TRUE (built.sent.contains ("Accept-Encoding"));
}

TEST (DefaultHeadersTest, AnEmptyPolicyMemberAddsNothing) {
    DefaultHeaderPolicy policy;
    policy.user_agent.clear ();

    const auto built = build (get_request (), policy);
    EXPECT_TRUE (built.lines.empty ());
    EXPECT_TRUE (built.sent.empty ());
}

// ---------------------------------------------------------------------------
// The names, and what this build can decode
// ---------------------------------------------------------------------------

TEST (DefaultHeadersTest, RefusesAHeaderNameThatIsNotOne) {
    EXPECT_TRUE (vayu::http::unusable_header_name ("").has_value ());
    EXPECT_TRUE (vayu::http::unusable_header_name ("X Request Id").has_value ());
    EXPECT_TRUE (vayu::http::unusable_header_name ("X-Request-Id:").has_value ());
    EXPECT_TRUE (vayu::http::unusable_header_name ("X-Request\r\nId").has_value ());
    EXPECT_FALSE (vayu::http::unusable_header_name ("X-Vayu-Request-Id").has_value ());
    EXPECT_FALSE (vayu::http::unusable_header_name ("x_request.id~1").has_value ());
}

TEST (DefaultHeadersTest, AdvertisesOnlyWhatThisLibcurlCanDecode) {
    const std::string& encodings = vayu::http::supported_accept_encodings ();
    // Every CI leg builds curl with zlib, so this is a real assertion rather
    // than a tautology: an engine that lost it would advertise nothing.
    EXPECT_NE (encodings.find ("gzip"), std::string::npos) << encodings;
    EXPECT_EQ (encodings.find ("identity"), std::string::npos) << encodings;
}

// ---------------------------------------------------------------------------
// The rows a pre-#1229 client saved into a request
// ---------------------------------------------------------------------------

TEST (DefaultHeadersTest, StripsTheRowsTheRendererUsedToSave) {
    const std::string stored = R"([
        {"key":"X-Vayu-Version","value":"0.1.1","enabled":true},
        {"key":"x-request-id","value":"6b2b9b3e-6d3a-4d4a-9d6e-2a9f0a1b2c3d","enabled":true},
        {"key":"User-Agent","value":"Vayu/0.1.1","enabled":true},
        {"key":"X-Team","value":"payments","enabled":true}
    ])";

    const auto rewritten = vayu::http::strip_legacy_managed_headers (stored);
    ASSERT_HAS_VALUE (rewritten);
    const auto rows = nlohmann::json::parse (*rewritten);
    ASSERT_EQ (rows.size (), 1U);
    EXPECT_EQ (rows[0]["key"], "X-Team");
}

TEST (DefaultHeadersTest, KeepsTheHeadersOfThoseNamesThatWereTheUsersOwn) {
    // Each rule is deliberately narrow, because this deletes user data: a
    // correlation id someone typed is not a UUID, and a browser's User-Agent is
    // exactly the header a testing tool exists to send.
    const std::string stored = R"json([
        {"key":"X-Request-ID","value":"order-42","enabled":true},
        {"key":"User-Agent","value":"Mozilla/5.0 Firefox","enabled":true}
    ])json";

    EXPECT_FALSE (vayu::http::strip_legacy_managed_headers (stored).has_value ());
}

TEST (DefaultHeadersTest, ReadsAPaddedRowTheSameWayTheEditorDoes) {
    // The renderer's copy of this rule trims, so this one does too: a row this
    // pass kept and the editor hid would be a header on the wire that nothing
    // shows.
    // Every byte of ASCII whitespace the renderer's copy strips, since the two
    // sides answering differently is what this rule exists to prevent.
    const std::string stored =
    R"json([{"key":" X-Vayu-Version\n","value":"0.1.1","enabled":true},
            {"key":"\tUser-Agent ","value":"\r\nVayu/0.1.1\t","enabled":true}])json";

    const auto rewritten = vayu::http::strip_legacy_managed_headers (stored);
    ASSERT_HAS_VALUE (rewritten);
    EXPECT_EQ (nlohmann::json::parse (*rewritten).size (), 0U);
}

TEST (DefaultHeadersTest, LeavesAloneWhatItCannotRead) {
    EXPECT_FALSE (vayu::http::strip_legacy_managed_headers ("not json").has_value ());
    EXPECT_FALSE (vayu::http::strip_legacy_managed_headers ("{}").has_value ());
    EXPECT_FALSE (vayu::http::strip_legacy_managed_headers ("[]").has_value ());
}

// ---------------------------------------------------------------------------
// Resolution from config, and the declaration clients read
// ---------------------------------------------------------------------------

class DefaultHeaderConfigTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_default_headers.db";

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
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (DefaultHeaderConfigTest, TheSeededDefaultsAreCompressionOnAndNoCorrelationId) {
    const auto design =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Design);
    const auto load =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Load);

    EXPECT_FALSE (design.user_agent.empty ());
    EXPECT_TRUE (design.correlation_header.empty ());
    EXPECT_EQ (design.accept_encoding, vayu::http::supported_accept_encodings ());
    EXPECT_EQ (load.accept_encoding, vayu::http::supported_accept_encodings ());
}

TEST_F (DefaultHeaderConfigTest, EachScopeReadsItsOwnCompressionSetting) {
    vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"loadNegotiateCompression":"false"}})");

    const auto design =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Design);
    const auto load =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Load);
    EXPECT_FALSE (design.accept_encoding.empty ());
    EXPECT_TRUE (load.accept_encoding.empty ());
}

TEST_F (DefaultHeaderConfigTest, TheCorrelationIdIsOptInAndItsNameIsConfigurable) {
    vayu::http::routes::apply_config_update (*db_,
    R"({"entries":{"correlationIdEnabled":"true","correlationIdHeader":"X-Correlation-ID"}})");

    const auto policy =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Design);
    EXPECT_EQ (policy.correlation_header, "X-Correlation-ID");
}

TEST_F (DefaultHeaderConfigTest, ANameThatIsNotOneIsRefusedAtTheWritePath) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"correlationIdHeader":"X Request Id"}})");

    EXPECT_EQ (status, 400);
    EXPECT_NE (body.dump ().find ("correlationIdHeader"), std::string::npos)
    << body.dump ();
    // Refused, so nothing was stored: the send path still has a usable name.
    const auto policy =
    vayu::http::resolve_default_header_policy (*db_, DefaultHeaderScope::Design);
    EXPECT_TRUE (policy.correlation_header.empty ());
}

TEST_F (DefaultHeaderConfigTest, TheDeclaredSetIsWhatASendWouldAdd) {
    vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"correlationIdEnabled":"true"}})");

    const auto declared =
    vayu::http::routes::request_defaults_json (*db_, DefaultHeaderScope::Design);
    ASSERT_TRUE (declared.contains ("headers"));

    std::set<std::string> names;
    bool correlation_is_generated = false;
    for (const auto& row : declared["headers"]) {
        names.insert (row["name"].get<std::string> ());
        if (row["name"] == std::string (vayu::http::DEFAULT_CORRELATION_HEADER)) {
            correlation_is_generated = row["generated"].get<bool> ();
            // A value generated per send has none to show yet, so the field is
            // absent rather than an empty string a client would print.
            EXPECT_FALSE (row.contains ("value"));
        }
    }

    EXPECT_TRUE (names.contains ("User-Agent"));
    EXPECT_TRUE (names.contains ("Accept-Encoding"));
    EXPECT_TRUE (names.contains (std::string (vayu::http::DEFAULT_CORRELATION_HEADER)));
    EXPECT_TRUE (correlation_is_generated);
}

TEST_F (DefaultHeaderConfigTest, ADefaultSwitchedOffIsNotDeclared) {
    vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"negotiateCompression":"false"}})");

    const auto declared =
    vayu::http::routes::request_defaults_json (*db_, DefaultHeaderScope::Design);
    for (const auto& row : declared["headers"]) {
        EXPECT_NE (row["name"], "Accept-Encoding");
    }
}

// Whether a scope's answer holds a row of this name.
bool declares (const nlohmann::json& body, std::string_view name) {
    return std::any_of (body["headers"].begin (), body["headers"].end (),
    [name] (const nlohmann::json& row) { return row["name"] == name; });
}

TEST_F (DefaultHeaderConfigTest, TheAnswerIsForTheScopeTheCallerNames) {
    // The one default the two scopes resolve differently.
    vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"loadNegotiateCompression":"false"}})");

    const auto [design_status, design] =
    vayu::http::routes::request_defaults_response (*db_, "design");
    const auto [load_status, load] =
    vayu::http::routes::request_defaults_response (*db_, "load");

    EXPECT_EQ (design_status, 200);
    EXPECT_EQ (load_status, 200);
    EXPECT_TRUE (declares (design, "Accept-Encoding"));
    EXPECT_FALSE (declares (load, "Accept-Encoding")) << load.dump ();
}

TEST_F (DefaultHeaderConfigTest, AScopeNobodyNamedIsADesignSend) {
    vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"loadNegotiateCompression":"false"}})");

    // Absent, and `?scope=` with nothing after it: both are the answer the
    // endpoint gave before it took the parameter.
    for (const std::string_view scope :
    { std::string_view (""), std::string_view ("design") }) {
        const auto [status, body] =
        vayu::http::routes::request_defaults_response (*db_, scope);
        EXPECT_EQ (status, 200);
        EXPECT_TRUE (declares (body, "Accept-Encoding")) << "scope='" << scope << "'";
    }
}

TEST_F (DefaultHeaderConfigTest, AScopeTheEndpointDoesNotKnowIsRefused) {
    const auto [status, body] =
    vayu::http::routes::request_defaults_response (*db_, "loud");

    EXPECT_EQ (status, 400);
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "invalid_scope");
    // The refusal names what was typed, so a client can show it.
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("loud"), std::string::npos)
    << body.dump ();
    EXPECT_FALSE (body.contains ("headers"));
}

// ---------------------------------------------------------------------------
// The startup repair over stored requests
// ---------------------------------------------------------------------------

TEST_F (DefaultHeaderConfigTest, StartupStripsTheStoredRowsAndLeavesTheUsersAlone) {
    vayu::db::Collection collection;
    collection.id   = "col_headers";
    collection.name = "Headers";
    db_->create_collection (collection);

    vayu::db::Request managed;
    managed.id            = "req_managed";
    managed.collection_id = "col_headers";
    managed.name          = "Managed";
    managed.url           = "https://example.com/";
    managed.headers       = R"([
        {"key":"X-Vayu-Version","value":"0.1.1","enabled":true},
        {"key":"X-Request-ID","value":"6b2b9b3e-6d3a-4d4a-9d6e-2a9f0a1b2c3d","enabled":true},
        {"key":"X-Team","value":"payments","enabled":true}
    ])";
    db_->save_request (managed);

    vayu::db::Request untouched;
    untouched.id            = "req_untouched";
    untouched.collection_id = "col_headers";
    untouched.name          = "Untouched";
    untouched.url           = "https://example.com/";
    untouched.headers = R"([{"key":"User-Agent","value":"Mozilla/5.0","enabled":true}])";
    db_->save_request (untouched);

    EXPECT_EQ (db_->strip_stored_managed_headers (), 1);

    auto stripped = db_->get_request ("req_managed");
    ASSERT_HAS_VALUE (stripped);
    const auto rows = nlohmann::json::parse (stripped->headers);
    ASSERT_EQ (rows.size (), 1U);
    EXPECT_EQ (rows[0]["key"], "X-Team");

    auto kept = db_->get_request ("req_untouched");
    ASSERT_HAS_VALUE (kept);
    EXPECT_NE (kept->headers.find ("Mozilla"), std::string::npos);

    // Idempotent: the pass runs at every startup, and a second one must find
    // nothing left to do rather than rewriting rows again.
    EXPECT_EQ (db_->strip_stored_managed_headers (), 0);
}

} // namespace
