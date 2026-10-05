/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/url_scheme_test.cpp
 * @brief Only `http` and `https` leave the engine.
 *
 * libcurl is a multi-protocol library, so a handle given a `file://` URL reads
 * the file and hands it back as a body. Two layers keep every transfer to the
 * two schemes this product sends:
 *
 * 1. `unsendable_scheme`, asked by `validate_transferable` of the URL every
 *    driver is about to hand a handle - after composition, the data-row bind,
 *    the pre-request script and the residual pass have all had their say. Its
 *    refusal is the ordinary status-0 response, so `POST /execute`, a run,
 *    `pm.sendRequest`, an import fetch and an OAuth token request all report it
 *    the same way.
 * 2. `CURLOPT_PROTOCOLS_STR` / `CURLOPT_REDIR_PROTOCOLS_STR`, set on every
 *    handle by `apply_transport_policy`, for the URLs layer 1 never sees: a
 *    redirect's `Location`, and the scheme libcurl guesses for a URL that names
 *    none.
 *
 * Each transfer case reads a file whose contents it then asserts never came
 * back, so a refusal that names the right scheme but still read the file
 * cannot pass.
 */

#include <gtest/gtest.h>

#include <curl/curl.h>

#include <array>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using vayu::http::unsendable_scheme;
using vayu::http::url_scheme;

// ============================================================================
// The rule, as a pure function
// ============================================================================

struct SchemeCase {
    const char* url;
    /// What `url_scheme` reads, as written.
    const char* scheme;
    bool sendable;
};

constexpr auto SCHEME_CASES = std::to_array<SchemeCase> ({
// The two that are sent, in any case: a scheme is case-insensitive
// (RFC 3986 3.1), and libcurl lowercases it before it looks.
{ "http://example.com/", "http", true },
{ "HTTP://example.com/", "HTTP", true },
{ "https://example.com/", "https", true },
{ "hTTpS://example.com/", "hTTpS", true },
// The rest are refused, whether or not this build of libcurl speaks them.
{ "file:///etc/passwd", "file", false },
{ "FILE:///etc/passwd", "FILE", false },
{ "file:/etc/passwd", "file", false },
{ "ftp://example.com/pub/x", "ftp", false },
{ "gopher://example.com/", "gopher", false },
{ "dict://example.com/d:x", "dict", false },
{ "ws://example.com/socket", "ws", false },
{ "https+unix://example.com/", "https+unix", false },
// A `data:` URL is refused only when it has the `:/` libcurl needs to read
// a scheme at all. Without it libcurl reads `data` as a host and `text` as
// its port - a URL it cannot parse, and nothing libcurl could read as data
// anyway: it has no `data:` protocol.
{ "data:/plain,hello", "data", false },
{ "data:text/plain,hello", "", true },
// No scheme is today's behaviour, unchanged: libcurl guesses one from the
// host (`http`, or `ftp` for an `ftp.` host and the like), and the handle's
// protocol allowlist refuses a guess outside the two - see
// `AGuessedSchemeIsHeldToTheHandlesAllowlist` below.
{ "example.com/path", "", true },
{ "localhost:8080/path", "", true },
{ "ftp.example.com/pub/x", "", true },
{ "", "", true },
// The first character must be a letter, or there is no scheme to read.
{ "1http://example.com/", "", true },
{ "{{baseUrl}}/users", "", true },
});

TEST (UrlScheme, ReadsTheSchemeLibcurlWouldAndAllowsOnlyHttpAndHttps) {
    for (const auto& c : SCHEME_CASES) {
        EXPECT_EQ (url_scheme (c.url), c.scheme) << c.url;
        EXPECT_EQ (!unsendable_scheme (c.url).has_value (), c.sendable) << c.url;
    }
}

TEST (UrlScheme, TheRefusalNamesTheSchemeAndTheTwoThatAreAllowed) {
    const auto problem = unsendable_scheme ("FILE:///etc/passwd");
    ASSERT_HAS_VALUE (problem);
    EXPECT_NE (problem->find ("'FILE'"), std::string::npos) << *problem;
    EXPECT_NE (problem->find ("only http and https"), std::string::npos) << *problem;
}

// ============================================================================
// Transfers
// ============================================================================

constexpr const char* SECRET = "vayu-url-scheme-test-secret";

/// A local file holding `SECRET`, as an absolute `file://` URL. The process
/// works in a private scratch directory (`tests/main.cpp`), so the name cannot
/// collide with a sibling process's.
class SecretFile {
    public:
    SecretFile ()
    : path_ (std::filesystem::absolute ("url_scheme_secret.txt")) {
        std::ofstream out (path_);
        out << SECRET;
    }
    ~SecretFile () {
        std::error_code ignored;
        std::filesystem::remove (path_, ignored);
    }
    SecretFile (const SecretFile&)            = delete;
    SecretFile& operator= (const SecretFile&) = delete;
    SecretFile (SecretFile&&)                 = delete;
    SecretFile& operator= (SecretFile&&)      = delete;

    std::string url () const {
        return "file://" + path_.generic_string ();
    }

    private:
    std::filesystem::path path_;
};

vayu::Request get (const std::string& url) {
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 5000;
    return request;
}

/// The refusal `validate_transferable` makes, as every driver reports it.
void expect_scheme_refusal (const vayu::Response& response, const char* scheme) {
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl);
    EXPECT_NE (response.error_message.find ("Cannot send this request"), std::string::npos)
    << response.error_message;
    EXPECT_NE (response.error_message.find (std::string ("'") + scheme + "'"),
    std::string::npos)
    << response.error_message;
    EXPECT_NE (response.error_message.find ("only http and https"), std::string::npos)
    << response.error_message;
    EXPECT_EQ (response.body.find (SECRET), std::string::npos)
    << "the file was read";
}

TEST (UrlSchemeTransfer, TheSingleRequestClientRefusesAFileUrl) {
    const SecretFile secret;
    vayu::http::Client client;
    const auto result = client.send (get (secret.url ()));
    ASSERT_TRUE (result.is_ok ());
    expect_scheme_refusal (result.value (), "file");
}

// The load path: the same gate, on the event loop's worker.
TEST (UrlSchemeTransfer, TheEventLoopRefusesAFileUrl) {
    const SecretFile secret;
    vayu::http::EventLoop loop;
    loop.start ();
    auto handle       = loop.submit_async (get (secret.url ()));
    const auto result = handle.future.get ();
    loop.stop ();
    ASSERT_TRUE (result.is_ok ());
    expect_scheme_refusal (result.value (), "file");
}

TEST (UrlSchemeTransfer, AStreamRefusesAFileUrl) {
    const SecretFile secret;
    vayu::http::SseStreamRequest spec;
    spec.run_id  = "run_scheme";
    spec.request = get (secret.url ());
    vayu::http::SseStreamContext context ("run_scheme", spec.limits);
    const auto response = vayu::http::consume_sse_stream (spec, context);
    expect_scheme_refusal (response, "file");
    EXPECT_EQ (context.end_reason (), vayu::http::SseEndReason::Error);
}

// ---------------------------------------------------------------------------
// The handle's own allowlist: what the URL check never sees
// ---------------------------------------------------------------------------

/// A redirect is followed inside libcurl, so its `Location` reaches no check
/// of ours. `CURLOPT_REDIR_PROTOCOLS_STR` refuses it there, as the protocol
/// error it is - never as a successful read of the target.
void expect_protocol_refusal (const vayu::Response& response) {
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl) << response.error_message;
    EXPECT_EQ (response.body.find (SECRET), std::string::npos)
    << "the file was read";
}

TEST (UrlSchemeRedirect, ARedirectToAFileUrlIsAProtocolErrorNotARead) {
    const SecretFile secret;
    const vayu::tests::EchoServer server;
    auto request             = get (server.redirect_to (secret.url ()));
    request.follow_redirects = true;
    vayu::http::Client client;
    const auto result = client.send (request);
    ASSERT_TRUE (result.is_ok ());
    expect_protocol_refusal (result.value ());
}

// libcurl's own default already keeps a redirect off `file`, but not off FTP:
// its default redirect allowlist is HTTP, HTTPS, FTP and FTPS. Port 1 refuses
// the connection, so a handle that followed would report CONNECTION_FAILED.
TEST (UrlSchemeRedirect, ARedirectToFtpIsRefusedOnBothDrivers) {
    const vayu::tests::EchoServer server;
    auto request = get (server.redirect_to ("ftp://127.0.0.1:1/pub/x"));
    request.follow_redirects = true;

    vayu::http::Client client;
    const auto sent = client.send (request);
    ASSERT_TRUE (sent.is_ok ());
    expect_protocol_refusal (sent.value ());

    vayu::http::EventLoop loop;
    loop.start ();
    auto handle       = loop.submit_async (request);
    const auto looped = handle.future.get ();
    loop.stop ();
    ASSERT_TRUE (looped.is_ok ());
    expect_protocol_refusal (looped.value ());
}

// A URL naming no scheme passes the URL check (that is today's behaviour), and
// libcurl guesses one from the host. An `ftp.` host guesses FTP, which the
// handle's allowlist refuses before anything is resolved.
TEST (UrlSchemeRedirect, AGuessedSchemeIsHeldToTheHandlesAllowlist) {
    vayu::http::Client client;
    const auto result = client.send (get ("ftp.localhost:1/pub/x"));
    ASSERT_TRUE (result.is_ok ());
    expect_protocol_refusal (result.value ());
}

// The applier on a bare handle, with no URL check in front of it: the one
// place every driver's handle is configured is enough on its own.
TEST (UrlSchemeRedirect, TheTransportApplierAloneRefusesAFileUrl) {
    const SecretFile secret;
    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    std::string body;
    const auto url = secret.url ();
    vayu::http::set_opt<CURLOPT_URL> (curl, url.c_str ());
    vayu::http::detail::apply_transport_policy (
    curl, vayu::http::TransportPolicy{}, /*verify_ssl=*/true, url);
    vayu::http::set_opt<CURLOPT_WRITEFUNCTION> (
    curl, +[] (char* data, size_t size, size_t count, void* sink) -> size_t {
        static_cast<std::string*> (sink)->append (data, size * count);
        return size * count;
    });
    vayu::http::set_opt<CURLOPT_WRITEDATA> (curl, &body);
    const CURLcode code = curl_easy_perform (curl);
    curl_easy_cleanup (curl);
    EXPECT_EQ (code, CURLE_UNSUPPORTED_PROTOCOL) << curl_easy_strerror (code);
    EXPECT_EQ (body.find (SECRET), std::string::npos) << "the file was read";
}

// ============================================================================
// POST /execute
// ============================================================================

/**
 * `POST /execute` on an in-process listener, the shape `sse_stream_test.cpp`'s
 * `StreamExecuteTest` uses: the real handler, the real exchange, the real
 * scripts.
 */
class UrlSchemeExecuteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_url_scheme_execute.db";

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
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The buffered answer to @p payload, which is always a 200: a send that
    /// never reached the wire says so in the body.
    json execute (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        EXPECT_TRUE (response);
        if (!response) {
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << response->body;
        return json::parse (response->body);
    }

    static json pre_request_script (const std::string& script) {
        return json::array ({ { { "id", "el_pre" }, { "kind", "script.pre" },
        { "config", { { "script", script } } } } });
    }

    static void expect_refused_body (const json& body, const char* scheme) {
        EXPECT_EQ (body.value ("status", -1), 0) << body.dump (2);
        EXPECT_EQ (body.value ("errorCode", ""), "INVALID_URL") << body.dump (2);
        const auto message = body.value ("errorMessage", std::string ());
        EXPECT_NE (message.find (std::string ("'") + scheme + "'"), std::string::npos)
        << message;
        EXPECT_NE (message.find ("only http and https"), std::string::npos) << message;
        EXPECT_EQ (body.dump ().find (SECRET), std::string::npos)
        << "the file was read";
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

TEST_F (UrlSchemeExecuteTest, AFileUrlIsRefusedBeforeAnyTransfer) {
    const SecretFile secret;
    expect_refused_body (execute ({ { "method", "GET" }, { "url", secret.url () } }), "file");
}

// The URL as written names no scheme; the one it is sent with comes from a
// variable the pre-request script sets, resolved by the residual pass. The
// check reads the URL after that, so it is refused all the same.
TEST_F (UrlSchemeExecuteTest, AVariableBuiltUrlIsCheckedAfterItResolves) {
    const SecretFile secret;
    expect_refused_body (
    execute ({ { "method", "GET" }, { "url", "{{target}}" },
    { "elements", pre_request_script ("pm.globals.set('target', '" + secret.url () + "');") } }),
    "file");
}

// `pm.sendRequest` is the network's answer, so the refusal reaches its callback
// as `err` - the same code and words a Send gets - and the request the script
// belongs to carries on.
TEST_F (UrlSchemeExecuteTest, APreRequestScriptsSendRequestIsRefusedWithTheSameError) {
    const SecretFile secret;
    const vayu::tests::EchoServer echo;
    const std::string script = "pm.sendRequest('" + secret.url () +
    "', function (err, res) { "
    "  var seen = err ? err.code + '|' + err.message : 'read:' + res.text(); "
    "  pm.request.headers.add({ key: 'X-Seen', value: seen }); "
    "});";
    const json body = execute ({ { "method", "GET" }, { "url", echo.url () },
    { "allowScriptRequests", true }, { "elements", pre_request_script (script) } });
    EXPECT_EQ (body.value ("status", -1), 200) << body.dump (2);

    const std::string seen = echo.header ("X-Seen");
    EXPECT_EQ (seen.rfind ("INVALID_URL|Cannot send this request", 0), 0u) << seen;
    EXPECT_NE (seen.find ("'file'"), std::string::npos) << seen;
    EXPECT_NE (seen.find ("only http and https"), std::string::npos) << seen;
    EXPECT_EQ (seen.find (SECRET), std::string::npos) << "the file was read";
}

} // namespace
