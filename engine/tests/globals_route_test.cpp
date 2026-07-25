/**
 * @file tests/globals_route_test.cpp
 * @brief Tests for POST /globals and the null-vs-absent rule on its one field.
 *
 * Globals is the resource issue #95 did not reach: it is a singleton on
 * `POST /globals` rather than a create/update pair, so it kept the exact bug the
 * verb split killed for environments - `g.variables = json["variables"].dump()`
 * with no null guard, storing the four-character text `null` for
 * `{"variables": null}`.
 *
 * That value is worse than an error because it *parses*. `GET /globals` wraps
 * its parse in try/catch and falls back to `{}`, so a corrupted row reads back
 * as an empty set of globals with no error anywhere - the user's variables are
 * simply gone. So the assertions below are on the **stored blob**, not just on
 * the response body: a response-only check passes on the broken code.
 *
 * Follows the suite's route-test convention (resource_write_route_test.cpp): the
 * route's extracted core is exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in globals.cpp. Returns {http_status, json_body} - the same pair the
// HTTP handler writes out.
std::pair<int, nlohmann::json>
save_globals_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::save_globals_response;

class GlobalsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_globals_route.db";

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
        std::filesystem::remove (DB_PATH);
        std::filesystem::remove (std::string (DB_PATH) + "-wal");
        std::filesystem::remove (std::string (DB_PATH) + "-shm");
    }

    /** The variables blob as it actually sits in the database. */
    std::string stored_variables () {
        auto g = db_->get_globals ();
        EXPECT_TRUE (g.has_value ());
        return g ? g->variables : std::string ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// The regression. `null` means "use the default", and the default for a
// variables map is an empty object - not the text "null".
TEST_F (GlobalsRouteTest, NullVariablesResetsToEmptyObject) {
    save_globals_response (*db_, json{ { "variables", { { "token", "abc" } } } });
    ASSERT_NE (stored_variables (), "");

    auto [status, body] = save_globals_response (*db_, json{ { "variables", nullptr } });

    EXPECT_EQ (status, 200);
    EXPECT_EQ (stored_variables (), "{}");
    EXPECT_TRUE (json::parse (stored_variables ()).is_object ());
    EXPECT_TRUE (body["variables"].is_object ());
    EXPECT_TRUE (body["variables"].empty ());
}

// Absent means the same thing on a singleton save, and always has.
TEST_F (GlobalsRouteTest, AbsentVariablesIsEmptyObject) {
    auto [status, body] = save_globals_response (*db_, json::object ());

    EXPECT_EQ (status, 200);
    EXPECT_EQ (stored_variables (), "{}");
    EXPECT_TRUE (body["variables"].is_object ());
}

// The ordinary path, pinned so the fix cannot regress it.
TEST_F (GlobalsRouteTest, VariablesAreStoredAndReturned) {
    auto [status, body] = save_globals_response (
    *db_, json{ { "variables", { { "base_url", "https://api.test" } } } });

    EXPECT_EQ (status, 200);
    EXPECT_EQ (json::parse (stored_variables ())["base_url"], "https://api.test");
    EXPECT_EQ (body["variables"]["base_url"], "https://api.test");
    EXPECT_EQ (body["id"], "globals");
}

// A save replaces the whole set - it is not a merge-patch. Pinned because the
// null case above only makes sense against replace semantics.
TEST_F (GlobalsRouteTest, SaveReplacesTheWholeSet) {
    save_globals_response (*db_, json{ { "variables", { { "a", "1" } } } });
    save_globals_response (*db_, json{ { "variables", { { "b", "2" } } } });

    auto stored = json::parse (stored_variables ());
    EXPECT_FALSE (stored.contains ("a"));
    EXPECT_EQ (stored["b"], "2");
}

} // namespace
