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

#include <atomic>
#include <filesystem>
#include <fstream>
#include <memory>
#include <regex>
#include <sstream>
#include <string>
#include <thread>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/server.hpp"
#include "vayu/utils/logger.hpp"

#include "temp_database.hpp"

namespace {

/// A log directory of its own, since `vayu::utils::Logger` is a singleton
/// that keeps writing into whichever directory it was last initialised with
/// (the same reason `logger_test.cpp`'s `ScratchLogDir` exists).
class ScratchLogDir {
    public:
    ScratchLogDir () {
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-request-log-test-" + std::to_string (counter.fetch_add (1)));
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

/// The file the logger is currently writing - the newest `vayu_*.log`.
std::string newest_log_contents (const std::filesystem::path& dir) {
    std::filesystem::path newest;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        const std::string name = entry.path ().filename ().string ();
        if (name.starts_with ("vayu_") && name.ends_with (".log") && entry.path () > newest) {
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
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);

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
    ASSERT_TRUE (health_response);
    EXPECT_EQ (health_response->get_header_value ("Cache-Control"), "no-store");

    // The header comes from one call site (set_default_headers), but a second,
    // unrelated JSON route pins that it is truly a server-wide default rather
    // than something that happened to land on /health alone.
    auto collections_response = client.Get ("/collections");
    ASSERT_TRUE (collections_response);
    EXPECT_EQ (collections_response->get_header_value ("Cache-Control"), "no-store");

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
    ASSERT_TRUE (response);
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

} // namespace
