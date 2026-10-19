/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_binary_body_test.cpp
 * @brief A response that is not UTF-8 through the real `POST /execute`
 *        (issue #2458).
 *
 * Every row of the issue's measured table used to answer a bodiless 500,
 * though the server had answered 200: nlohmann's strict dump refused the body
 * (or a header) the route was about to send. Driven through the handler,
 * because the dump that threw is a line in the route and no seam below it
 * sees the live body; `json_test.cpp` pins the encoding decision itself.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {
// Declared here rather than in routes.hpp, matching `start_created_run` in
// run_config_validation_test.cpp: the extracted core is an implementation
// detail of the route, and only its test needs the prototype.
void guard_recorded_send (vayu::db::Database& db,
httplib::Response& res,
const std::optional<std::string>& run_id,
const std::function<void ()>& send);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;

/// gzip of "caf\xC3\xA9 hello" (mtime 0), so a decoded body is UTF-8 text and
/// an undecoded one is bytes that are not.
constexpr auto GZIP_OF_TEXT = std::to_array<std::uint8_t> ({ 0x1F, 0x8B, 0x08, 0x00,
0x00, 0x00, 0x00, 0x00, 0x02, 0xFF, 0x4B, 0x4E, 0x4C, 0x3B, 0xBC, 0x52, 0x21, 0x23,
0x35, 0x27, 0x27, 0x1F, 0x00, 0x71, 0x54, 0x69, 0x62, 0x0B, 0x00, 0x00, 0x00 });
constexpr std::string_view GZIPPED_TEXT = "caf\xC3\xA9 hello";

/// Not a real brotli stream, and it need not be: the request that fetches it
/// refuses `Accept-Encoding`, so libcurl never tries to decode it.
constexpr auto BROTLI_LOOKING =
std::to_array<std::uint8_t> ({ 0x0B, 0x02, 0x80, 0x68, 0x69, 0x03, 0xFF });

std::string bytes_of (std::span<const std::uint8_t> bytes) {
    return std::string (vayu::utils::byte_view (bytes));
}

/// `{"s":"` and then three-byte characters, so a 1024-byte cap falls one byte
/// into the character starting at byte 1023.
std::string euro_json () {
    std::string body = "{\"s\":\"";
    for (int i = 0; i < 400; ++i) {
        body += "\xE2\x82\xAC";
    }
    return body + "\"}";
}

std::string every_byte_value () {
    std::string bytes;
    for (int value = 0; value < 256; ++value) {
        bytes.push_back (static_cast<char> (value));
    }
    return bytes;
}

/// One route of the server below: what it answers with.
struct ServedBody {
    std::string path;
    std::string content_type;
    std::string content_encoding;
    std::string bytes;
};

/// The issue's table, one route per row, plus the text controls.
std::vector<ServedBody> served_bodies () {
    return {
        { "/latin1", "text/plain; charset=iso-8859-1", "", "caf\xE9 na\xEFve \xA3 \xFF\xFE" },
        { "/latin1-no-charset", "text/plain", "", "caf\xE9 na\xEFve \xA3 \xFF\xFE" },
        { "/windows-1252", "application/json; charset=windows-1252", "",
        "{\"s\":\"\x93quoted\x94 \x80\"}" },
        { "/lying-utf8", "application/json; charset=utf-8", "", "{\"s\":\"ok\xFF\xFE\xC3(\"}" },
        { "/utf16", "text/plain; charset=utf-16", "", std::string ("\xFF\xFEh\0i\0", 6) },
        { "/octets", "application/octet-stream", "", every_byte_value () },
        { "/nul", "text/plain", "", std::string ("ab\0cd", 5) },
        { "/brotli", "text/plain", "br", bytes_of (BROTLI_LOOKING) },
        { "/gzip", "text/plain", "gzip", bytes_of (GZIP_OF_TEXT) },
        { "/utf8-bom", "text/plain; charset=utf-8", "", "\xEF\xBB\xBFhi" },
        { "/euro-json", "application/json", "", euro_json () },
    };
}

/// Serves `served_bodies ()`, and `/latin-header`: a `200 ok` whose one odd
/// thing is an `X-Latin` header value carrying a Latin-1 byte.
class BytesServer {
    public:
    BytesServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        for (auto& served : served_bodies ()) {
            svr_.Get (served.path, [served] (const httplib::Request&, httplib::Response& res) {
                if (!served.content_encoding.empty ()) {
                    res.set_header ("Content-Encoding", served.content_encoding);
                }
                res.set_content (served.bytes, served.content_type);
            });
        }
        svr_.Get ("/latin-header", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("X-Latin", "caf\xE9");
            res.set_content ("ok", "text/plain");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~BytesServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    BytesServer (const BytesServer&)            = delete;
    BytesServer& operator= (const BytesServer&) = delete;
    BytesServer (BytesServer&&)                 = delete;
    BytesServer& operator= (BytesServer&&)      = delete;

    std::string url (std::string_view path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + std::string (path);
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

/// The served bytes of @p path.
std::string served_bytes (std::string_view path) {
    for (auto& served : served_bodies ()) {
        if (served.path == path) {
            return std::move (served.bytes);
        }
    }
    ADD_FAILURE () << "no served body at " << path;
    return {};
}

class ExecuteBinaryBodyTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_binary_body.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The `/execute` answer for @p payload, which must be a 200.
    json execute (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "POST /execute did not answer";
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << "body: '" << response->body << "'";
        return json::parse (response->body, nullptr, false);
    }

    /// The `/execute` answer for a GET of @p path on @p server.
    json fetch (const BytesServer& server, std::string_view path) const {
        return execute ({ { "method", "GET" }, { "url", server.url (path) } });
    }

    /// The one run this test's send wrote.
    vayu::db::Run only_run () const {
        const auto runs = db_->get_all_runs ();
        if (runs.size () != 1) {
            ADD_FAILURE () << "expected one run, found " << runs.size ();
            return {};
        }
        return runs.front ();
    }

    /// The stored trace of that run's one result.
    json stored_trace () const {
        const auto results = db_->get_results (only_run ().id);
        if (results.size () != 1) {
            ADD_FAILURE () << "expected one result, found " << results.size ();
            return json::object ();
        }
        return json::parse (results.front ().trace_data, nullptr, false);
    }

    std::unique_ptr<vayu::db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    vayu::core::RunManager run_manager_;
    vayu::http::OAuth2AuthorizeManager authorize_manager_;
    vayu::http::CookieJar cookie_jar_;
    vayu::http::MockIssuerManager mock_issuer_manager_;
    vayu::http::InboxManager inbox_manager_;
    vayu::http::MockServerManager mock_server_manager_;
    vayu::http::RunSummaryCache run_summary_cache_;
    std::unique_ptr<vayu::http::SseStreamManager> manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

/// Asserts @p answer carries @p bytes as base64, with the server's own status.
void expect_base64_answer (const json& answer, const std::string& bytes) {
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (answer.value ("bodyEncoding", ""), "base64") << answer.dump ();
    EXPECT_TRUE (answer.contains ("body") && answer.at ("body").is_null ())
    << answer.dump ();
    EXPECT_EQ (answer.value ("bodySize", size_t{ 0 }), bytes.size ());
    EXPECT_EQ (vayu::utils::base64_decode (answer.value ("bodyRaw", "")), bytes);
}

// ---------------------------------------------------------------------------
// The byte rows: base64 live and stored, run completed. Mutation check: make
// `serialize (Response)` always take the utf8 branch and every row still
// answers 200, because the route dumps with `replace`, but with U+FFFD in
// place of each byte that is not UTF-8, so `expect_base64_answer` fails on
// `bodyEncoding` and on the bytes.
// ---------------------------------------------------------------------------

struct ByteRow {
    const char* name;
    const char* path;
};

constexpr auto BYTE_ROWS = std::to_array<ByteRow> ({
{ "Latin1DeclaredAsSuch", "/latin1" },
{ "Latin1WithNoCharset", "/latin1-no-charset" },
{ "Windows1252Json", "/windows-1252" },
{ "JsonThatLiesAboutBeingUtf8", "/lying-utf8" },
{ "Utf16WithByteOrderMark", "/utf16" },
{ "EveryByteValue", "/octets" },
{ "TextCarryingNul", "/nul" },
});

class ExecuteByteRowTest : public ExecuteBinaryBodyTest,
                           public ::testing::WithParamInterface<ByteRow> {};

TEST_P (ExecuteByteRowTest, AnswersTheBytesAsBase64AndCompletesTheRun) {
    const BytesServer server;
    const auto answer = fetch (server, GetParam ().path);
    const auto bytes  = served_bytes (GetParam ().path);

    expect_base64_answer (answer, bytes);
    EXPECT_EQ (only_run ().status, vayu::RunStatus::Completed);

    // A restored body is the bytes the live one was, under the same marker.
    const auto trace = stored_trace ();
    ASSERT_TRUE (trace.contains ("response")) << trace.dump ();
    EXPECT_EQ (trace.at ("response").value ("bodyEncoding", ""), "base64");
    EXPECT_EQ (trace.at ("response").value ("body", ""), answer.value ("bodyRaw", ""));
}

INSTANTIATE_TEST_SUITE_P (Issue2458,
ExecuteByteRowTest,
::testing::ValuesIn (BYTE_ROWS),
[] (const ::testing::TestParamInfo<ByteRow>& info) {
    return std::string (info.param.name);
});

// A server that compresses whatever was asked: refusing the default
// `Accept-Encoding` leaves libcurl nothing to decode with.
TEST_F (ExecuteBinaryBodyTest, AnUndecodedBrotliBodyIsBase64) {
    const BytesServer server;
    const auto answer = execute ({ { "method", "GET" }, { "url", server.url ("/brotli") },
    { "disabledDefaultHeaders", json::array ({ "Accept-Encoding" }) } });

    expect_base64_answer (answer, served_bytes ("/brotli"));
    EXPECT_EQ (only_run ().status, vayu::RunStatus::Completed);
}

// A request naming its own `Accept-Encoding` gets no decoding from libcurl,
// so a server that gzips anyway hands back the compressed bytes.
TEST_F (ExecuteBinaryBodyTest, AnUndecodedGzipBodyIsBase64) {
    const BytesServer server;
    const auto answer = execute ({ { "method", "GET" }, { "url", server.url ("/gzip") },
    { "headers", { { "Accept-Encoding", "identity" } } } });

    expect_base64_answer (answer, served_bytes ("/gzip"));
}

// ---------------------------------------------------------------------------
// The controls: text stays text, and the trace says nothing new about it.
// ---------------------------------------------------------------------------

TEST_F (ExecuteBinaryBodyTest, AGzipBodyLibcurlDecodedIsUtf8Text) {
    const BytesServer server;
    const auto answer = fetch (server, "/gzip");

    EXPECT_EQ (answer.value ("bodyEncoding", ""), "utf8") << answer.dump ();
    EXPECT_EQ (answer.value ("bodyRaw", ""), GZIPPED_TEXT);
    EXPECT_FALSE (stored_trace ()["response"].contains ("bodyEncoding"));
}

TEST_F (ExecuteBinaryBodyTest, AUtf8ByteOrderMarkIsText) {
    const BytesServer server;
    const auto answer = fetch (server, "/utf8-bom");

    EXPECT_EQ (answer.value ("bodyEncoding", ""), "utf8") << answer.dump ();
    EXPECT_EQ (answer.value ("bodyRaw", ""), "\xEF\xBB\xBFhi");
    EXPECT_FALSE (stored_trace ()["response"].contains ("bodyEncoding"));
}

// A stored slice of a base64 body is still base64 and still the front of the
// bytes (the cap's own rules are `json_test.cpp`'s).
TEST_F (ExecuteBinaryBodyTest, ATraceCapKeepsABase64BodyDecodable) {
    auto entry = db_->get_config_entry ("maxTraceBodyBytes");
    ASSERT_HAS_VALUE (entry);
    entry->value = "100";
    db_->save_config_entry (*entry);

    const BytesServer server;
    const auto answer = fetch (server, "/octets");
    expect_base64_answer (answer, every_byte_value ());

    const auto trace = stored_trace ();
    ASSERT_TRUE (trace.contains ("response")) << trace.dump ();
    const auto& node = trace.at ("response");
    EXPECT_TRUE (node.value ("bodyTruncated", false)) << node.dump ();
    EXPECT_EQ (node.value ("bodyBytes", size_t{ 0 }), size_t{ 256 });
    EXPECT_EQ (vayu::utils::base64_decode (node.value ("body", "")),
    every_byte_value ().substr (0, 99));
}

// A body the read cap cut inside a character is the text it was, less that
// character, live and stored alike. Mutation check: drop the `body_truncated`
// branch in `response_body_text` and both answer base64.
TEST_F (ExecuteBinaryBodyTest, ACappedUtf8BodyCutInsideACharacterStaysText) {
    auto entry = db_->get_config_entry ("maxDesignResponseBodyBytes");
    ASSERT_HAS_VALUE (entry);
    entry->value = "1024";
    db_->save_config_entry (*entry);

    const BytesServer server;
    const auto answer = fetch (server, "/euro-json");

    EXPECT_EQ (answer.value ("bodyEncoding", ""), "utf8") << answer.dump ();
    EXPECT_TRUE (answer.value ("bodyCapped", false));
    EXPECT_EQ (answer.value ("bodySize", size_t{ 0 }), size_t{ 1024 });
    EXPECT_EQ (answer.value ("bodyRaw", ""), euro_json ().substr (0, 1023));

    const auto trace = stored_trace ();
    ASSERT_TRUE (trace.contains ("response")) << trace.dump ();
    const auto& node = trace.at ("response");
    EXPECT_FALSE (node.contains ("bodyEncoding")) << node.dump ();
    EXPECT_TRUE (node.value ("bodyCapped", false));
    EXPECT_EQ (node.value ("body", ""), answer.value ("bodyRaw", ""));
}

// ---------------------------------------------------------------------------
// A header value carrying a Latin-1 byte, with the curl exchange logged
// (console verbosity 2 is what collects it). Mutation check: put the strict
// dump back at `run_buffered_execution`'s `set_content`, or at either sink in
// `logger.cpp`, and this answers a 500 and fails its run.
// ---------------------------------------------------------------------------

TEST_F (ExecuteBinaryBodyTest, AHeaderThatIsNotUtf8StillAnswersAndCompletes) {
    auto& logger        = vayu::utils::Logger::instance ();
    const int verbosity = logger.get_verbosity ();
    logger.set_verbosity (2);

    const BytesServer server;
    const auto answer = fetch (server, "/latin-header");
    logger.set_verbosity (verbosity);

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (answer.value ("bodyEncoding", ""), "utf8");
    EXPECT_EQ (answer.value ("bodyRaw", ""), "ok");
    // Still lossy: a header value is not a body and has no encoding of its own.
    EXPECT_EQ (answer.value ("headers", json::object ()).value ("x-latin", ""), "caf\xEF\xBF\xBD")
    << answer.dump ();
    EXPECT_EQ (only_run ().status, vayu::RunStatus::Completed);
}

// ---------------------------------------------------------------------------
// The net under all of the above: whatever throws once the row exists fails
// the row and answers a JSON error. Mutation check: make `guard_recorded_send`
// call `send ()` bare and the throw escapes this test.
// ---------------------------------------------------------------------------

TEST_F (ExecuteBinaryBodyTest, ASendThatThrowsFailsItsRunAndAnswersJson) {
    vayu::db::Run run;
    run.id     = "run_throws";
    run.type   = vayu::RunType::Design;
    run.status = vayu::RunStatus::Running;
    db_->create_run (run);

    httplib::Response res;
    EXPECT_NO_THROW (vayu::http::routes::guard_recorded_send (*db_, res, run.id, [] () {
        throw std::runtime_error (
        "[json.exception.type_error.316] invalid UTF-8");
    }));

    EXPECT_EQ (res.status, 500);
    const auto body = json::parse (res.body, nullptr, false);
    EXPECT_NE (
    vayu::http::routes::error_message_of (body).find ("type_error.316"), std::string::npos)
    << res.body;
    const auto stored = db_->get_run ("run_throws");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Failed);
}

// A transient send has no row to fail, and still gets an answer it can read -
// even when the reason quotes a byte that is not UTF-8. Mutation check: put
// `send_error`'s strict dump back and the error answer itself throws.
TEST_F (ExecuteBinaryBodyTest, ATransientSendThatThrowsStillAnswersJson) {
    httplib::Response res;
    EXPECT_NO_THROW (vayu::http::routes::guard_recorded_send (
    *db_, res, std::nullopt, [] () { throw std::runtime_error ("caf\xE9"); }));

    EXPECT_EQ (res.status, 500);
    EXPECT_EQ (vayu::http::routes::error_message_of (json::parse (res.body, nullptr, false)),
    "Execution failed: caf\xEF\xBF\xBD");
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

TEST_F (ExecuteBinaryBodyTest, ASendThatReturnsIsLeftAlone) {
    httplib::Response res;
    bool ran = false;
    vayu::http::routes::guard_recorded_send (
    *db_, res, std::nullopt, [&ran] () { ran = true; });

    EXPECT_TRUE (ran);
    EXPECT_TRUE (res.body.empty ());
}

} // namespace
