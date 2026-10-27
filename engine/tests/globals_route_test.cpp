/**
 * @file tests/globals_route_test.cpp
 * @brief Tests for POST /globals: the null-vs-absent rule on its one field, and
 *        the `If-Match` precondition judged in its lock scope (#2988).
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
 * route's extracted core is exercised directly, no in-process HTTP server. The
 * handler's half of `If-Match` (#2988) is in if_match_route_test.cpp.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "competing_writer.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/entity_tag.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in globals.cpp. Returns {http_status, json_body} - the same pair the
// HTTP handler writes out.
std::pair<int, nlohmann::json>
save_globals_response (vayu::db::Database& db, const nlohmann::json& json);
// The same with the request's `If-Match` (#2988) and the lock-scope test seam.
std::pair<int, nlohmann::json> save_globals_response (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::save_globals_response;
using vayu::tests::CompetingWriter;

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
        vayu::tests::remove_database_files (DB_PATH);
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

// Issue #133: the null guard removed one bad *value*; this removes the bad
// *shape*. `{"variables": 42}` used to store `42` - JSON that parses but is not
// an object, so `GET /globals` fell back to `{}` and the globals vanished
// exactly as they did for the `null` case.
TEST_F (GlobalsRouteTest, WrongShapeVariablesIsRejected) {
    save_globals_response (*db_, json{ { "variables", { { "token", "abc" } } } });
    const std::string before = stored_variables ();

    for (const json& bad :
    { json (42), json ("token"), json::array ({ 1, 2 }), json (true) }) {
        auto [status, body] = save_globals_response (*db_, json{ { "variables", bad } });
        EXPECT_EQ (status, 400) << "variables = " << bad.dump ();
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("variables"), std::string::npos);
    }

    EXPECT_EQ (stored_variables (), before)
    << "a rejected write must not reach the column";
}

// ---------------------------------------------------------------------------
// If-Match on the whole-blob save (issue #2988)
// ---------------------------------------------------------------------------

vayu::http::IfMatch if_match_of (const std::string& field) {
    auto parsed = vayu::http::IfMatch::parse (field);
    EXPECT_TRUE (parsed.has_value ()) << field;
    return parsed.value_or (vayu::http::IfMatch::parse ("*").value ());
}

std::string tag_of (const json& row) {
    return vayu::http::entity_tag (row["updatedAt"].get<int64_t> ());
}

json variables_with (const std::string& value) {
    return json{ { "variables", { { "host", value } } } };
}

TEST_F (GlobalsRouteTest, ASaveNamingTheStoredTagLandsWithANewOne) {
    auto [seed_status, seeded] = save_globals_response (*db_, variables_with ("a"));
    ASSERT_EQ (seed_status, 200) << seeded.dump ();

    auto [status, body] = save_globals_response (
    *db_, variables_with ("b"), if_match_of (tag_of (seeded)), nullptr);
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_GT (body["updatedAt"].get<int64_t> (), seeded["updatedAt"].get<int64_t> ())
    << "the answer must carry a tag the one it replaced no longer matches";
    EXPECT_EQ (json::parse (stored_variables ())["host"], "b");
}

// Mutation check: drop the `check_if_match` call in `save_globals_locked` and
// this answers 200 with the stale blob stored over the other client's.
TEST_F (GlobalsRouteTest, ASaveNamingAStaleTagIs412AndWritesNothing) {
    auto [seed_status, seeded] = save_globals_response (*db_, variables_with ("a"));
    ASSERT_EQ (seed_status, 200);
    auto [moved_status, moved] = save_globals_response (*db_, variables_with ("moved"));
    ASSERT_EQ (moved_status, 200);

    auto [status, body] = save_globals_response (
    *db_, variables_with ("stale"), if_match_of (tag_of (seeded)), nullptr);
    EXPECT_EQ (status, 412) << body.dump ();
    EXPECT_EQ (body["error"]["code"], "precondition_failed");
    EXPECT_EQ (body["error"]["updatedAt"], moved["updatedAt"])
    << "the refusal names the version a re-read will find";
    const auto stored = db_->get_globals ();
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (json::parse (stored->variables)["host"], "moved");
    EXPECT_EQ (stored->updated_at, moved["updatedAt"].get<int64_t> ());
}

TEST_F (GlobalsRouteTest, ASaveWithoutIfMatchIsUnconditional) {
    ASSERT_EQ (save_globals_response (*db_, variables_with ("a")).first, 200);
    ASSERT_EQ (save_globals_response (*db_, variables_with ("moved")).first, 200);

    auto [status, body] =
    save_globals_response (*db_, variables_with ("last"), std::nullopt, nullptr);
    EXPECT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (json::parse (stored_variables ())["host"], "last");
}

// `GET /globals` answers a never-written row at `updatedAt: 0`, so `W/"0"` is
// the tag a first conditional save names; once anything is written it is
// stale like any other.
TEST_F (GlobalsRouteTest, TheNeverWrittenRowIsVersionZero) {
    ASSERT_FALSE (db_->get_globals ().has_value ());

    auto [first_status, first] = save_globals_response (
    *db_, variables_with ("first"), if_match_of ("W/\"0\""), nullptr);
    ASSERT_EQ (first_status, 200) << first.dump ();
    EXPECT_GT (first["updatedAt"].get<int64_t> (), 0);

    auto [second_status, second] = save_globals_response (
    *db_, variables_with ("second"), if_match_of ("W/\"0\""), nullptr);
    EXPECT_EQ (second_status, 412) << second.dump ();
    EXPECT_EQ (second["error"]["updatedAt"], first["updatedAt"]);
    EXPECT_EQ (json::parse (stored_variables ())["host"], "first");
}

// Two saves in one millisecond, or a row stamped ahead of this clock (an
// import from a faster machine), must still get distinct tags. Mutation check:
// stamp `now_ms ()` in `save_globals_locked` and `updatedAt` goes backwards.
TEST_F (GlobalsRouteTest, ASaveAlwaysMovesItsTagForward) {
    ASSERT_EQ (save_globals_response (*db_, variables_with ("a")).first, 200);
    auto stored = db_->get_globals ();
    ASSERT_HAS_VALUE (stored);
    stored->updated_at = std::chrono::duration_cast<std::chrono::milliseconds> (
                         std::chrono::system_clock::now ().time_since_epoch ())
                         .count () +
    3'600'000;
    db_->save_globals (*stored);

    auto [status, body] = save_globals_response (*db_, variables_with ("b"));
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["updatedAt"].get<int64_t> (), stored->updated_at + 1);
}

// Two clients read one version and both save conditioned on it. The second is
// started inside the first's lock scope, so it judges its tag against the row
// the first committed. Mutation check: drop the `with_lock` in
// `save_globals_response` and the second save lands too.
TEST_F (GlobalsRouteTest, TwoSavesFromOneReadLandOnlyOnce) {
    auto [seed_status, seeded] = save_globals_response (*db_, variables_with ("a"));
    ASSERT_EQ (seed_status, 200);
    const auto tag = if_match_of (tag_of (seeded));

    int other_status = 0;
    json other_body;
    CompetingWriter other ([&] {
        auto result = save_globals_response (*db_, variables_with ("other"), tag, nullptr);
        other_status = result.first;
        other_body   = result.second;
    });

    auto [status, body] =
    save_globals_response (*db_, variables_with ("first"), tag, other.probe ());
    ASSERT_EQ (status, 200) << body.dump ();
    other.join ();
    EXPECT_EQ (other_status, 412) << other_body.dump ();
    EXPECT_EQ (json::parse (stored_variables ())["host"], "first");
}

} // namespace
