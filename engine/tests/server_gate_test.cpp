/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/server_gate_test.cpp
 * @brief The management API serves no browser: the request gate in
 *        `server.cpp` (`admit_management_request`), and the request-body
 *        caps on the same pre-routing handler (#1824).
 *
 * Driven through a real `Server` on a free port, because the rule is wiring:
 * it must run before routing on every route, and a route-core test cannot
 * see a pre-routing handler. The `Host` the client sends is set by hand where
 * a test needs a name other than the one `httplib::Client` writes itself
 * (`127.0.0.1:<port>`); a request with no `Host` or with two is written to a
 * socket byte for byte (`raw_status`), because the client never sends one, and
 * so is a request announcing a body it never sends (`raw_answer`).
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <array>
#include <cstddef>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <type_traits>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/server.hpp"

#include "temp_database.hpp"

namespace {

using nlohmann::json;

/// A port nothing is listening on: `Server` takes its port up front, and only
/// listening and stopping releases a socket `bind_to_any_port` opened.
int free_port () {
    httplib::Server probe;
    const int port = probe.bind_to_any_port ("127.0.0.1");
    std::thread runner ([&probe] () { probe.listen_after_bind (); });
    probe.wait_until_ready ();
    probe.stop ();
    runner.join ();
    return port;
}

/// True when any response header is a CORS one.
bool has_cors_header (const httplib::Response& response) {
    for (const auto& [name, value] : response.headers) {
        if (name.starts_with ("Access-Control-")) {
            return true;
        }
    }
    return false;
}

/// What the listener on @p port answers to @p request, written to the socket
/// as given and read until the server closes (every request here asks it to);
/// "" when the request could not be sent whole. Through httplib's own socket
/// helpers, which already hold every platform's spelling of a socket.
std::string raw_answer (int port, const std::string& request) {
    auto error        = httplib::Error::Success;
    const auto socket = httplib::detail::create_client_socket ("127.0.0.1", "",
    port, AF_INET, true, false, nullptr, 5, 0, 5, 0, 5, 0, "", error);
    // SOCKET is unsigned on Windows and INVALID_SOCKET is (-1) there.
    if (socket == static_cast<std::remove_cv_t<decltype (socket)>> (INVALID_SOCKET)) {
        return {};
    }
    std::size_t sent = 0;
    while (sent < request.size ()) {
        const std::string_view rest = std::string_view (request).substr (sent);
        const auto n =
        httplib::detail::send_socket (socket, rest.data (), rest.size (), 0);
        if (n <= 0) {
            break;
        }
        sent += static_cast<std::size_t> (n);
    }
    std::string answer;
    std::array<char, 512> buffer{};
    while (sent == request.size ()) {
        const auto n =
        httplib::detail::read_socket (socket, buffer.data (), buffer.size (), 0);
        if (n <= 0) {
            break;
        }
        answer.append (buffer.data (), static_cast<std::size_t> (n));
    }
    httplib::detail::close_socket (socket);
    return answer;
}

/// The status code in a `raw_answer`; 0 when the exchange failed.
int raw_status (int port, const std::string& request) {
    const std::string answer = raw_answer (port, request);
    // "HTTP/1.1 403 Forbidden": the code is the second word.
    const auto space = answer.find (' ');
    if (space == std::string::npos || answer.size () < space + 4) {
        return 0;
    }
    return std::stoi (answer.substr (space + 1, 3));
}

/// One member (`code`, `message`) of the engine's one error shape, or "" when
/// the body is not that shape.
std::string error_member (const httplib::Response& response, const char* member) {
    const auto body = json::parse (response.body, nullptr, false);
    if (!body.is_object () || !body.contains ("error") || !body["error"].is_object ()) {
        return {};
    }
    return body["error"].value (member, std::string ());
}

class ServerGateTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_server_gate.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        port_ = free_port ();
        server_ = std::make_unique<vayu::http::Server> (*db_, run_manager_, port_);
        ASSERT_TRUE (server_->start ()) << server_->bind_error ();
    }

    void TearDown () override {
        server_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    [[nodiscard]] httplib::Client client () const {
        return httplib::Client ("127.0.0.1", port_);
    }

    [[nodiscard]] std::string with_port (const std::string& name) const {
        return name + ":" + std::to_string (port_);
    }

    /// A POST whose headers announce a body that is never sent, so a listener
    /// that answers it decided from the headers alone, before reading any
    /// body; one that reads instead waits out the socket timeout.
    [[nodiscard]] std::string body_announced_but_unsent (const std::string& path,
    const std::string& framing) const {
        return "POST " + path + " HTTP/1.1\r\nHost: " + with_port ("127.0.0.1") +
        "\r\nContent-Type: application/json\r\n" + framing + "\r\nConnection: close\r\n\r\n";
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::core::RunManager run_manager_;
    std::unique_ptr<vayu::http::Server> server_;
    int port_ = 0;
};

TEST_F (ServerGateTest, AForeignOriginIsRefusedOnAReadRoute) {
    auto response = client ().Get (
    "/health", httplib::Headers{ { "Origin", "https://evil.example" } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403);
    EXPECT_EQ (error_member (*response, "code"), "forbidden") << response->body;
    EXPECT_NE (error_member (*response, "message").find ("does not serve browser origins"),
    std::string::npos)
    << response->body;
    EXPECT_FALSE (has_cors_header (*response));
}

TEST_F (ServerGateTest, AForeignOriginIsRefusedOnAWriteRouteBeforeItWrites) {
    auto http     = client ();
    auto response = http.Post ("/collections",
    httplib::Headers{ { "Origin", "https://evil.example" } },
    json{ { "name", "planted" } }.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403) << response->body;
    EXPECT_FALSE (has_cors_header (*response));

    // The route never ran: nothing was created.
    auto listed = http.Get ("/collections");
    ASSERT_TRUE (listed);
    ASSERT_EQ (listed->status, 200);
    EXPECT_EQ (listed->body.find ("planted"), std::string::npos) << listed->body;
}

TEST_F (ServerGateTest, TheNullOriginOfASandboxedPageIsRefused) {
    auto response = client ().Get ("/health", httplib::Headers{ { "Origin", "null" } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403) << response->body;
}

// DNS rebinding: the page is same-origin with the listener, so it sends no
// Origin on a GET - the name it dialled is what gives it away.
TEST_F (ServerGateTest, AForeignHostIsRefusedEvenWithoutAnOrigin) {
    auto response = client ().Get (
    "/health", httplib::Headers{ { "Host", with_port ("evil.example") } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403);
    EXPECT_NE (error_member (*response, "message").find ("Host check"), std::string::npos)
    << response->body;
}

// `httplib::Client` always writes exactly one `Host`, so these two go to the
// socket by hand. Mutation check: drop the count clause in
// `names_this_listener` and the duplicated pair, whose first value is this
// listener, is served.
TEST_F (ServerGateTest, ARequestWithNoHostIsRefused) {
    EXPECT_EQ (raw_status (port_, "GET /health HTTP/1.1\r\nConnection: close\r\n\r\n"), 403);
}

TEST_F (ServerGateTest, ARequestWithTwoHostsIsRefused) {
    const std::string request = "GET /health HTTP/1.1\r\nHost: " + with_port ("127.0.0.1") +
    "\r\nHost: " + with_port ("evil.example") + "\r\nConnection: close\r\n\r\n";
    EXPECT_EQ (raw_status (port_, request), 403);
    // The same exchange with one Host is served, so the 403 above is the
    // duplicate's and not the hand-written request's.
    EXPECT_EQ (raw_status (port_,
               "GET /health HTTP/1.1\r\nHost: " + with_port ("127.0.0.1") + "\r\nConnection: close\r\n\r\n"),
    200);
}

TEST_F (ServerGateTest, ALoopbackNameOnAnotherPortIsRefused) {
    auto response = client ().Get ("/health",
    httplib::Headers{ { "Host", "127.0.0.1:" + std::to_string (port_ + 1) } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403) << response->body;
}

TEST_F (ServerGateTest, APreflightIsAnsweredWithNoCorsHeaderWhateverItsOrigin) {
    auto response = client ().Options ("/collections",
    httplib::Headers{ { "Origin", "https://evil.example" },
    { "Access-Control-Request-Method", "POST" },
    { "Access-Control-Request-Headers", "content-type" } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 204);
    EXPECT_TRUE (response->body.empty ()) << response->body;
    EXPECT_FALSE (response->has_header ("Access-Control-Allow-Origin"));
    EXPECT_FALSE (has_cors_header (*response));
}

TEST_F (ServerGateTest, APreflightUnderAForeignHostIsStillRefused) {
    auto response = client ().Options (
    "/collections", httplib::Headers{ { "Host", with_port ("evil.example") } });
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 403) << response->body;
}

TEST_F (ServerGateTest, ARequestWithNoOriginIsServedWithNoCorsHeader) {
    auto response = client ().Get ("/health");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200) << response->body;
    EXPECT_FALSE (has_cors_header (*response));
}

TEST_F (ServerGateTest, EveryLoopbackSpellingOfThisListenerIsServed) {
    for (const char* name : { "localhost", "LOCALHOST", "127.0.0.1", "[::1]" }) {
        auto response =
        client ().Get ("/health", httplib::Headers{ { "Host", with_port (name) } });
        ASSERT_TRUE (response) << name;
        EXPECT_EQ (response->status, 200) << name << ": " << response->body;
    }
}

// The body caps (#1824) are judged from the headers before routing, so each
// probe below announces a body and sends none of it. Mutation check: drop
// `refuse_unbounded_body` from the pre-routing handler in `server.cpp` and the
// chunked and any-route cases wait for a body instead of answering (status 0);
// drop `reject_oversized_import` and the import case does.
TEST_F (ServerGateTest, AChunkedBodyIsRefusedBeforeAnyOfItIsRead) {
    for (const char* path : { "/import/parse", "/environments" }) {
        const std::string answer = raw_answer (
        port_, body_announced_but_unsent (path, "Transfer-Encoding: chunked"));
        EXPECT_TRUE (answer.starts_with ("HTTP/1.1 411 ")) << path << ": " << answer;
        EXPECT_NE (answer.find ("send Content-Length"), std::string::npos)
        << path << ": " << answer;
    }
}

TEST_F (ServerGateTest, ABodyOverTheCeilingIsRefusedOnAnyRouteFromItsDeclaredLength) {
    const std::string over =
    std::to_string (vayu::core::constants::request_body::MAX_BYTES + 1);
    const std::string answer = raw_answer (port_,
    body_announced_but_unsent ("/environments", "Content-Length: " + over));
    EXPECT_TRUE (answer.starts_with ("HTTP/1.1 413 ")) << answer;
    EXPECT_NE (answer.find ("Request body is " + over + " bytes"), std::string::npos)
    << answer;
    EXPECT_NE (answer.find ("for any request"), std::string::npos) << answer;
}

TEST_F (ServerGateTest, AnImportBodyOverItsLiveLimitIsRefusedFromItsDeclaredLength) {
    // The default document cap is 10 MiB, so an import body may be 16 MiB.
    const std::string answer = raw_answer (port_,
    body_announced_but_unsent (
    "/import/parse", "Content-Length: " + std::to_string (20U * 1024U * 1024U)));
    EXPECT_TRUE (answer.starts_with ("HTTP/1.1 413 ")) << answer;
    EXPECT_NE (answer.find ("maxSpecDocumentBytes"), std::string::npos) << answer;
}

TEST_F (ServerGateTest, ABodyWithADeclaredLengthUnderTheCapsReachesItsRoute) {
    auto response = client ().Post (
    "/environments", json{ { "name", "Staging" } }.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200) << response->body;
}

} // namespace
