/**
 * @file tests/health_route_test.cpp
 * @brief `GET /health`'s `workers` field (issue #1508): the configured
 *        setting's effective value, not the machine's raw core count.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"

namespace vayu::http::routes {
// Declared in health.cpp; the body of GET /health.
nlohmann::json build_health_response (vayu::db::Database& db);
} // namespace vayu::http::routes

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

class HealthRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_health_route.db";

    void SetUp () override {
        cleanup ();
    }
    void TearDown () override {
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }
};

// A database whose `init ()` never ran has no `workers` config row, the same
// shape `get_config_int` sees for any key that has never been seeded. This
// pins the fallback side of `resolve_worker_count`, independently of the
// configured-value case below, which needs `init ()` to seed the row before
// it can be overwritten.
TEST_F (HealthRouteTest, WithNoConfiguredValueHealthReportsTheDetectedCoreCount) {
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    const auto health = vayu::http::routes::build_health_response (*db);

    EXPECT_EQ (health["workers"].get<unsigned int> (), std::thread::hardware_concurrency ());
}

TEST_F (HealthRouteTest, WithAConfiguredValueHealthReportsIt) {
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);
    db->init ();
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db, R"({"entries":{"workers":"3"}})");
    ASSERT_EQ (status, 200) << body.dump ();

    const auto health = vayu::http::routes::build_health_response (*db);

    // Mutation check: reverting `build_health_response` to the unconditional
    // `std::thread::hardware_concurrency ()` read fails this on any machine
    // that does not happen to have exactly 3 cores.
    EXPECT_EQ (health["workers"].get<int> (), 3);
}

} // namespace
