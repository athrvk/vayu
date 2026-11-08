/**
 * @file tests/health_route_test.cpp
 * @brief `GET /health`'s `workers` field (issue #1508): the configured
 *        setting's effective value, not the machine's raw core count; and its
 *        `dataDir` field (#3328), the data directory resolved absolute.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/daemon_args.hpp"
#include "vayu/core/worker_count.hpp"
#include "vayu/db/database.hpp"

namespace vayu::http::routes {
// Declared in health.cpp; the body of GET /health.
nlohmann::json build_health_response (vayu::db::Database& db, const std::string& data_dir);
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
TEST_F (HealthRouteTest, WithNoConfiguredValueHealthReportsTheEffectiveCoreCount) {
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    const auto health = vayu::http::routes::build_health_response (*db, {});

    // Not the raw `hardware_concurrency ()`, which is 0 on a host that cannot
    // tell, and `/health` must never report 0 workers.
    EXPECT_EQ (health["workers"].get<unsigned int> (),
    vayu::core::effective_worker_count (std::thread::hardware_concurrency ()));
    EXPECT_GT (health["workers"].get<unsigned int> (), 0u);
}

TEST_F (HealthRouteTest, WithAConfiguredValueHealthReportsIt) {
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);
    db->init ();
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db, R"({"entries":{"workers":"3"}})");
    ASSERT_EQ (status, 200) << body.dump ();

    const auto health = vayu::http::routes::build_health_response (*db, {});

    // Mutation check: reverting `build_health_response` to the unconditional
    // `std::thread::hardware_concurrency ()` read fails this on any machine
    // that does not happen to have exactly 3 cores.
    EXPECT_EQ (health["workers"].get<int> (), 3);
}

// ---------------------------------------------------------------------------
// dataDir (#3328)
// ---------------------------------------------------------------------------

/// @p path as `absolute_data_dir` spells its answer.
std::string utf8 (const std::filesystem::path& path) {
    const std::u8string text = path.u8string ();
    return { text.begin (), text.end () };
}

TEST_F (HealthRouteTest, HealthReportsTheDataDirectoryItWasGiven) {
    auto db               = std::make_unique<vayu::db::Database> (DB_PATH);
    const std::string dir = vayu::core::absolute_data_dir ("health-data");

    const auto health = vayu::http::routes::build_health_response (*db, dir);

    // Mutation check: dropping the `dataDir` assignment fails this.
    ASSERT_TRUE (health.contains ("dataDir")) << health.dump ();
    EXPECT_EQ (health["dataDir"].get<std::string> (), dir);
}

TEST (AbsoluteDataDirTest, ARelativeDirectoryIsResolvedAgainstTheCurrentOne) {
    const std::string resolved = vayu::core::absolute_data_dir ("health-data");

    // Mutation check: returning the argument as given fails both.
    EXPECT_TRUE (std::filesystem::path (resolved).is_absolute ()) << resolved;
    EXPECT_EQ (resolved, utf8 (std::filesystem::current_path () / "health-data"));
}

TEST (AbsoluteDataDirTest, DotSegmentsAndATrailingSeparatorAreDropped) {
    const std::filesystem::path base = std::filesystem::current_path ();
    const std::filesystem::path written = base / "a" / "." / "b" / ".." / "data" / "";

    // Mutation check: removing the trailing-separator step fails this with
    // the same path plus one separator.
    EXPECT_EQ (vayu::core::absolute_data_dir (written.string ()), utf8 (base / "a" / "data"));
}

TEST (AbsoluteDataDirTest, AnAbsoluteDirectoryKeepsItsSpelling) {
    // Nothing here exists: the answer is lexical and never asks the
    // filesystem, which is also why a symlink is reported as written.
    const std::filesystem::path written =
    std::filesystem::current_path () / "no-such-parent" / "data";

    EXPECT_EQ (vayu::core::absolute_data_dir (written.string ()), utf8 (written));
}

} // namespace
