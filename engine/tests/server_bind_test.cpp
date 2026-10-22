/**
 * @file tests/server_bind_test.cpp
 * @brief The engine listener's bind outcome (issue #983).
 *
 * A taken port used to be reported nowhere: `listen()` folded the bind into the
 * serve loop, returned false into a thread nobody read, and the daemon saw only
 * a server that had stopped running - which it treated as a shutdown request
 * and exited 0, one line after printing its listening banner.
 */

#include <gtest/gtest.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <memory>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

#if defined(__linux__)
#include <netinet/in.h>
#include <sys/socket.h>
#endif

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/server.hpp"
#include "vayu/utils/logger.hpp"

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "wait_until.hpp"

namespace {

/// A log directory of its own, since `vayu::utils::Logger` is a singleton
/// that keeps writing into whichever directory it was last initialised with
/// (the same reason `logger_test.cpp`'s `ScratchLogDir` exists).
class ScratchLogDir {
    public:
    ScratchLogDir () {
        // The counter alone is not unique across processes: ctest runs each
        // test as its own invocation of this binary, so two different tests'
        // counters both start at 0 and would otherwise collide on the same
        // path under parallel ctest - the exact race `logger_test.cpp`'s
        // `ScratchLogDir` avoids by hashing in the test's own name too.
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-request-log-test-" + std::to_string (counter.fetch_add (1)) + "-" +
        std::to_string (static_cast<unsigned long long> (std::hash<std::string>{}(
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ()))));
        std::filesystem::create_directories (path_);
    }
    ~ScratchLogDir () {
        std::error_code ignored;
        std::filesystem::remove_all (path_, ignored);
    }
    ScratchLogDir (const ScratchLogDir&)            = delete;
    ScratchLogDir& operator= (const ScratchLogDir&) = delete;
    ScratchLogDir (ScratchLogDir&&)                 = delete;
    ScratchLogDir& operator= (ScratchLogDir&&)      = delete;

    const std::filesystem::path& path () const {
        return path_;
    }

    private:
    std::filesystem::path path_;
};

/// The file the logger is currently writing - the newest `engine_*.log`.
std::string newest_log_contents (const std::filesystem::path& dir) {
    std::filesystem::path newest;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        const std::string name = entry.path ().filename ().string ();
        if (name.starts_with ("engine_") && name.ends_with (".log") && entry.path () > newest) {
            newest = entry.path ();
        }
    }
    std::ifstream in (newest);
    std::stringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

/// A listener holding a port for as long as it is alive, the way any other
/// process on the machine would. `stop()` is what releases the port, so the
/// fixture's own teardown cannot leave it held for the next test.
class PortHolder {
    public:
    PortHolder () {
        port_   = server_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { server_.listen_after_bind (); });
        server_.wait_until_ready ();
    }

    ~PortHolder () {
        server_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    PortHolder (const PortHolder&)            = delete;
    PortHolder& operator= (const PortHolder&) = delete;
    PortHolder (PortHolder&&)                 = delete;
    PortHolder& operator= (PortHolder&&)      = delete;

    int port () const {
        return port_;
    }

    private:
    httplib::Server server_;
    std::thread thread_;
    int port_ = 0;
};

class ServerBindTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_server_bind.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::core::RunManager run_manager_;
};

TEST_F (ServerBindTest, ATakenPortFailsToStartAndNamesTheReason) {
    PortHolder holder;
    ASSERT_GT (holder.port (), 0);

    vayu::http::Server server (*db_, run_manager_, holder.port ());

    EXPECT_FALSE (server.start ());
    EXPECT_FALSE (server.is_running ());

    const std::string reason = server.bind_error ();
    EXPECT_NE (reason.find ("127.0.0.1:" + std::to_string (holder.port ())), std::string::npos)
    << reason;
    EXPECT_NE (reason.find ("already listening"), std::string::npos) << reason;
}

TEST_F (ServerBindTest, AFreePortStartsAndServesWithNoRecordedError) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());
    EXPECT_TRUE (server.is_running ());
    EXPECT_EQ (server.bind_error (), "");

    httplib::Client client ("127.0.0.1", port);
    auto response = client.Get ("/health");
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    EXPECT_EQ (response->status, 200);

    server.stop ();
}

/// The management server buffers a body before any route sees it, so an
/// import is bounded from `Content-Length` before the body is read (#1782).
/// The guard is driven directly: over a socket the server answers without
/// reading the upload, and whether the client sees the 413 or a reset depends
/// on the platform's socket buffers.
namespace {

httplib::Server::HandlerResponse guard_outcome (vayu::db::Database& db,
const std::string& path,
const std::string& length,
httplib::Response& res) {
    httplib::Request req;
    req.method = "POST";
    req.path   = path;
    req.set_header ("Content-Length", length);
    return vayu::http::routes::reject_oversized_import (db, req, res);
}

} // namespace

TEST_F (ServerBindTest, AnOversizedImportBodyIsRefusedWith413BeforeItIsRead) {
    httplib::Response res;
    // The default cap is 10 MiB, so the limit is 16 MiB: 20 MiB is refused.
    EXPECT_EQ (
    guard_outcome (*db_, "/import/parse", std::to_string (20U * 1024U * 1024U), res),
    httplib::Server::HandlerResponse::Handled);
    EXPECT_EQ (res.status, 413);
    const auto parsed = nlohmann::json::parse (res.body);
    EXPECT_NE (parsed.at ("error").at ("message").get<std::string> ().find (
               "maxSpecDocumentBytes"),
    std::string::npos);
}

TEST_F (ServerBindTest, TheImportBodyLimitFollowsTheLiveSetting) {
    auto entry = db_->get_config_entry ("maxSpecDocumentBytes");
    ASSERT_HAS_VALUE (entry);
    entry->value = "104857600";
    db_->save_config_entry (*entry);

    httplib::Response raised;
    EXPECT_EQ (guard_outcome (*db_, "/import", std::to_string (20U * 1024U * 1024U), raised),
    httplib::Server::HandlerResponse::Unhandled);

    entry->value = "1024";
    db_->save_config_entry (*entry);
    httplib::Response lowered;
    EXPECT_EQ (guard_outcome (*db_, "/import/document",
               std::to_string (2U * 1024U * 1024U), lowered),
    httplib::Server::HandlerResponse::Handled);
    EXPECT_EQ (lowered.status, 413);
}

TEST_F (ServerBindTest, TheImportBodyGuardLeavesOtherRoutesAndSmallBodiesAlone) {
    httplib::Response res;
    EXPECT_EQ (guard_outcome (*db_, "/import/parse", "2", res),
    httplib::Server::HandlerResponse::Unhandled);
    EXPECT_EQ (guard_outcome (*db_, "/specs", std::to_string (20U * 1024U * 1024U), res),
    httplib::Server::HandlerResponse::Unhandled);
}

TEST_F (ServerBindTest, AnImportBodyOverTheLimitNeverReachesTheRouteOverASocket) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    httplib::Client client ("127.0.0.1", port);
    const std::string body = std::string (size_t{ 20 } * 1024 * 1024, 'x');
    auto response = client.Post ("/import/parse", body, "application/json");
    // Either the 413 or a closed connection, depending on the platform's socket
    // buffers; never the route's own 400 for a body that is not JSON.
    if (response) {
        EXPECT_EQ (response->status, 413);
    }

    // A body inside the limit still reaches the route (400: not a JSON object).
    auto within_limit = client.Post ("/import/parse", "[]", "application/json");
    if (!within_limit) {
        httplib::Client fresh ("127.0.0.1", port);
        within_limit = fresh.Post ("/import/parse", "[]", "application/json");
    }
    ASSERT_TRUE (within_limit) << httplib::to_string (within_limit.error ());
    EXPECT_EQ (within_limit->status, 400);

    server.stop ();
}

TEST_F (ServerBindTest, EveryResponseCarriesNoStoreCacheControl) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    httplib::Client client ("127.0.0.1", port);
    auto health_response = client.Get ("/health");
    ASSERT_TRUE (health_response) << httplib::to_string (health_response.error ());
    EXPECT_EQ (health_response->get_header_value ("Cache-Control"), "no-store");

    // The header comes from one call site (set_default_headers), but a second,
    // unrelated JSON route pins that it is truly a server-wide default rather
    // than something that happened to land on /health alone.
    auto collections_response = client.Get ("/collections");
    ASSERT_TRUE (collections_response)
    << httplib::to_string (collections_response.error ());
    EXPECT_EQ (collections_response->get_header_value ("Cache-Control"), "no-store");

    server.stop ();
}

// The API listens on loopback only, where compressing a response is CPU spent
// for no bandwidth anyone saves - and cpp-httplib's brotli ran at its default
// quality, 11: measured on a 300-collection workspace, `/collections` went
// from 2.6 ms to 175 ms and one collection's request list from 1.4 ms to
// 16 ms for a renderer that advertises `br`, which put ~5 s of compression
// into every launch. `vcpkg.json` builds cpp-httplib without its compression
// features; this pins the outcome for the header a browser actually sends.
// Mutation check: drop `"default-features": false` from the cpp-httplib entry
// and the response comes back `Content-Encoding: br`.
TEST_F (ServerBindTest, AResponseIsNeverCompressedForALoopbackClient) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    httplib::Client client ("127.0.0.1", port);
    client.set_decompress (false);
    const httplib::Headers browser = { { "Accept-Encoding", "gzip, deflate, br, zstd" } };
    // The config catalogue: JSON, and large enough that a compressing server
    // would compress it.
    auto response = client.Get ("/config", browser);
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    EXPECT_EQ (response->status, 200);
    ASSERT_GT (response->body.size (), 4096u)
    << "the body is too within_limit to prove anything";
    EXPECT_FALSE (response->has_header ("Content-Encoding"))
    << "answered with Content-Encoding: "
    << response->get_header_value ("Content-Encoding");

    server.stop ();
}

// Issue #1510: the hook that replaces every route's hand-written entry line
// with one centralised request line, proven against the real server rather
// than against `install_request_logger` called by hand - `Server::setup_routes`
// is what has to wire it, not just the function existing.
TEST_F (ServerBindTest, EachCallProducesOneCentralRequestLogLine) {
    ScratchLogDir log_dir;
    vayu::utils::Logger::instance ().init (log_dir.path ().string ());
    vayu::utils::Logger::instance ().set_file_level (vayu::utils::Logger::Level::DEBUG);
    vayu::utils::Logger::instance ().set_max_file_bytes (0);

    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    httplib::Client client ("127.0.0.1", port);
    httplib::Headers headers{ { "Authorization", "Bearer secret-token-should-not-be-logged" } };
    auto response =
    client.Get ("/health?token=secret-query-should-not-be-logged", headers);
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    EXPECT_EQ (response->status, 200);

    server.stop ();
    vayu::utils::Logger::instance ().flush ();

    const std::string written = newest_log_contents (log_dir.path ());
    EXPECT_TRUE (std::regex_search (written, std::regex (R"(GET /health 200 \d+(\.\d+)?ms \d+B)")))
    << written;
    // Never the query string, headers or body - any of the three can carry a
    // token or a credential (issue #1510's own rule for the line's content).
    EXPECT_EQ (written.find ("secret-token-should-not-be-logged"), std::string::npos)
    << written;
    EXPECT_EQ (written.find ("secret-query-should-not-be-logged"), std::string::npos)
    << written;
}

// The request gate (`admit_management_request`) answers before routing, on
// the same pre-routing handler that stamps the start time, so a refused call
// is still one line - at INFO, where a 4xx belongs.
TEST_F (ServerBindTest, ARefusedCallStillProducesItsRequestLogLine) {
    ScratchLogDir log_dir;
    vayu::utils::Logger::instance ().init (log_dir.path ().string ());
    vayu::utils::Logger::instance ().set_file_level (vayu::utils::Logger::Level::DEBUG);
    vayu::utils::Logger::instance ().set_max_file_bytes (0);

    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    httplib::Client client ("127.0.0.1", port);
    auto response =
    client.Get ("/health", httplib::Headers{ { "Origin", "https://evil.example" } });
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    EXPECT_EQ (response->status, 403);

    server.stop ();
    vayu::utils::Logger::instance ().flush ();

    const std::string written = newest_log_contents (log_dir.path ());
    EXPECT_TRUE (std::regex_search (written,
    std::regex (R"("level":"info".*GET /health 403 \d+(\.\d+)?ms \d+B)")))
    << written;
}

// `stop()` returns only once the request it found in flight has been answered,
// because the daemon tears down the run manager, curl's global state and the
// database right after it (#2667). The upstream holds the engine's `/execute`
// handler inside its transfer until it is released from another thread, which
// races `stop()` the way a real shutdown races a finishing request: the
// handler is always in flight when `stop()` is called, and usually still
// running when the listener closes. Under ASan a handler that outlived `stop()` is also reported writing
// through the destroyed Server. Mutation check: make `stop()` detach the
// listener thread instead of waiting for it, and the result row is missing when
// it returns.
TEST_F (ServerBindTest, StopAnswersTheRequestInFlightBeforeReturning) {
    vayu::tests::SlowMockServer upstream;
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    // `std::async` futures wait for their task on destruction, so no assertion
    // below can leave a thread running past the objects it uses.
    auto call = std::async (std::launch::async, [port, url = upstream.hang_url ()] () {
        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (20, 0);
        const nlohmann::json payload{ { "method", "GET" }, { "url", url } };
        const auto response = client.Post ("/execute", payload.dump (), "application/json");
        return response ? response->status : -1;
    });
    EXPECT_TRUE (vayu::tests::wait_until (
    [&upstream] () { return upstream.live_connection_count () > 0; }))
    << "the /execute handler never reached the upstream";

    auto release = std::async (
    std::launch::async, [&upstream] () { upstream.released.store (true); });
    server.stop ();
    release.get ();

    // The buffered `/execute` stores its result row before it answers.
    const auto runs = db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0);
    EXPECT_FALSE (runs.empty () || db_->get_results (runs.front ().id).empty ())
    << "stop() returned with the /execute handler still running";
    EXPECT_EQ (call.get (), 200);
}

// `stop()` ends a handler held inside an upstream transfer rather than waiting
// on it (#2683). The upstream is released only after `stop()` has returned, so
// the transfer can end only by being cancelled, and the handler still answers
// and records its row because `stop()` joins it. Healthy: the transfer sees the
// cancel at its next libcurl progress tick, about a second. Mutation checks:
// drop `inputs.cancel` from the buffered `/execute`, and `stop()` waits out
// the send's own 30s timeout and the answer is `TIMEOUT`; restore the timed
// wait and detach in `stop()`, and the row is missing when it returns.
TEST_F (ServerBindTest, StopCancelsTheUpstreamTransferAHandlerIsHeldIn) {
    vayu::tests::SlowMockServer upstream;
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    auto call = std::async (std::launch::async, [port, url = upstream.hang_url ()] () {
        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (40, 0);
        const nlohmann::json payload{ { "method", "GET" }, { "url", url } };
        const auto response = client.Post ("/execute", payload.dump (), "application/json");
        return response ? std::make_pair (response->status, response->body) :
                          std::make_pair (-1, httplib::to_string (response.error ()));
    });
    ASSERT_TRUE (vayu::tests::wait_until (
    [&upstream] () { return upstream.live_connection_count () > 0; }))
    << "the /execute handler never reached the upstream";

    server.stop ();

    const auto runs = db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0);
    EXPECT_FALSE (runs.empty () || db_->get_results (runs.front ().id).empty ())
    << "stop() returned with the /execute handler still running";
    const auto [status, body] = call.get ();
    upstream.released.store (true);
    ASSERT_EQ (status, 200) << body;
    EXPECT_EQ (nlohmann::json::parse (body).value ("errorCode", ""),
    vayu::to_string (vayu::ErrorCode::Cancelled))
    << body;
}

/// Calls `server.stop()` while a client is still reading @p path's event
/// stream, and answers whether `stop()` returned inside the wait deadline with
/// the stream closed under the reader - ended, not left running on a detached
/// thread. @p end_stream is what lets a broken `stop()` return at all, from the
/// producing side, so a regression fails the test rather than hanging it;
/// the reader also hangs up on its next frame once that has been called.
bool stop_returns_while_a_relay_is_read (vayu::http::Server& server,
int port,
const std::string& path,
const std::function<void ()>& end_stream) {
    std::atomic<bool> read_something{ false };
    std::atomic<bool> hang_up{ false };
    auto reader         = std::async (std::launch::async, [&, port, path] () {
        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (40, 0);
        return client.Get (path, [&] (const char*, size_t) {
            read_something.store (true);
            return !hang_up.load ();
        });
    });
    const bool relaying = vayu::tests::wait_until (
    [&read_something] () { return read_something.load (); });
    EXPECT_TRUE (relaying) << path << " never wrote a frame";

    auto stopped =
    std::async (std::launch::async, [&server] () { server.stop (); });
    const auto ready = [] (const auto& future) {
        return future.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    };
    const bool returned =
    vayu::tests::wait_until ([&] () { return ready (stopped); });
    const bool closed =
    returned && vayu::tests::wait_until ([&] () { return ready (reader); });
    hang_up.store (true);
    end_stream ();
    stopped.get ();
    reader.get ();
    return relaying && returned && closed;
}

// A live relay ends when the server stops instead of holding the join open for
// as long as its client reads (#2683). An inbox outlives `Server::stop()`, so
// without the stop flag `/inbox/:id/live` keeps polling it. Healthy: the relay
// ends within one poll interval (250ms by default). Mutation checks: drop
// `server_stopping` from `stream_inbox_live`'s loop, and `stop()` returns only
// once the reader hangs up after the 20s wait; restore the timed wait and
// detach in `stop()`, and it returns with the relay still writing.
TEST_F (ServerBindTest, StopEndsAnInboxRelayItsClientIsStillReading) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());
    httplib::Client control ("127.0.0.1", port);
    const auto started = control.Post ("/inbox/start", R"({"port":0})", "application/json");
    ASSERT_TRUE (started) << httplib::to_string (started.error ());
    ASSERT_EQ (started->status, 200) << started->body;
    const auto inbox_id = nlohmann::json::parse (started->body).value ("inboxId", "");

    // The reader's hang-up is the whole release here: the relay writes a
    // keep-alive every poll, which is where it learns of it.
    EXPECT_TRUE (stop_returns_while_a_relay_is_read (
    server, port, "/inbox/" + inbox_id + "/live", [] () {}))
    << "stop() did not end an inbox relay whose client was still reading";
}

// The same for a load run's `/runs/:id/live`, which the daemon stops only after
// `Server::stop()`. The run here has no worker: it is a registered context
// with one tick published, so the relay writes that tick and then waits on a
// run that never ends. Mutation checks: drop `stopping` from
// `stream_live_metrics`'s loop, and `stop()` returns only once the run is
// ended after the 20s wait; restore the timed wait and detach in `stop()`, and
// it returns with the relay still running.
TEST_F (ServerBindTest, StopEndsALiveMetricsRelayOfARunStillGoing) {
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    const std::string run_id = "run_held_open";
    auto context = std::make_shared<vayu::core::RunContext> (run_id, nlohmann::json{});
    context->append_tick ("event: metrics\nid: 0\ndata: {}\n\n");
    run_manager_.register_run (run_id, context);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());

    EXPECT_TRUE (stop_returns_while_a_relay_is_read (server, port, "/runs/" + run_id + "/live",
    [&context] () {
        context->settled.store (true, std::memory_order_release);
        context->closed.store (true, std::memory_order_release);
    }))
    << "stop() did not end a live relay whose run had not ended";
    run_manager_.unregister_run (run_id);
}

#if defined(__linux__)
/// The listening socket this process holds on @p port, or -1.
int listening_socket_on (int port) {
    constexpr int SCANNED_DESCRIPTORS = 1024;
    for (int fd = 0; fd < SCANNED_DESCRIPTORS; ++fd) {
        sockaddr_in address{};
        socklen_t length = sizeof (address);
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        if (::getsockname (fd, reinterpret_cast<sockaddr*> (&address), &length) != 0 ||
        address.sin_family != AF_INET ||
        std::cmp_not_equal (ntohs (address.sin_port), port)) {
            continue;
        }
        int listening      = 0;
        socklen_t its_size = sizeof (listening);
        if (::getsockopt (fd, SOL_SOCKET, SO_ACCEPTCONN, &listening, &its_size) == 0 &&
        listening != 0) {
            return fd;
        }
    }
    return -1;
}
#endif

// An accept loop that ended on its own - an accept error cpp-httplib does not
// retry - leaves `is_running()` false, which the daemon's wait reads as a
// reason to shut down. `stop()` must still join the listener thread: destroying
// a joinable one terminates the process (#2667). Shutting the listening socket
// down from outside is that error on Linux, where accept then answers EINVAL;
// other platforms do not promise to wake accept for it, so there is nothing to
// provoke the path with there. Mutation check: guard `stop()` with
// `is_running_` again, and this test's process aborts.
TEST_F (ServerBindTest, AListenerThatEndedOnItsOwnIsStillJoined) {
#if !defined(__linux__)
    GTEST_SKIP ()
    << "needs a way to end the accept loop from outside the server";
#else
    int port = 0;
    {
        PortHolder holder;
        port = holder.port ();
    }
    ASSERT_GT (port, 0);

    vayu::http::Server server (*db_, run_manager_, port);
    ASSERT_TRUE (server.start ());
    const int listener = listening_socket_on (port);
    ASSERT_GE (listener, 0);

    ASSERT_EQ (::shutdown (listener, SHUT_RDWR), 0);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&server] () { return !server.is_running (); }));

    server.stop ();
    EXPECT_FALSE (server.is_running ());
#endif
}

} // namespace
