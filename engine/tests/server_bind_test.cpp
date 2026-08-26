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

#include <memory>
#include <string>
#include <thread>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/server.hpp"

#include "temp_database.hpp"

namespace {

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

    vayu::http::Server server (*db_, run_manager_, holder.port (), false);

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

    vayu::http::Server server (*db_, run_manager_, port, false);
    ASSERT_TRUE (server.start ());
    EXPECT_TRUE (server.is_running ());
    EXPECT_EQ (server.bind_error (), "");

    httplib::Client client ("127.0.0.1", port);
    auto response = client.Get ("/health");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);

    server.stop ();
}

} // namespace
