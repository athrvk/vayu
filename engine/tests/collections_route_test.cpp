/**
 * @file tests/collections_route_test.cpp
 * @brief Tests for the collection-tree cycle guards (issue #79).
 *
 * Two layers are covered:
 *
 *  - Write-time validation (`validate_parent_assignment`, the extracted core of
 *    POST /collections): a self-parent and a reparent-into-descendant are each
 *    rejected with 400; a legal reparent and a null parent pass. Corrupt data
 *    already in the tree must not hang the validator, so the ancestor walk is
 *    bounded by a visited set.
 *
 *  - Cascade delete (`Database::delete_collection`): it must terminate and
 *    remove every member even when the parent_id tree contains a cycle (data
 *    that predates the validation above), and the normal nested cascade - parent
 *    + child + their requests - must still delete cleanly. Without the visited
 *    set the BFS loops forever under the global DB mutex, hanging every endpoint.
 *
 * Follows the suite's route-test convention (requests_route_test.cpp): the
 * route's extracted core is exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in collections.cpp; succeeds when the parent assignment is legal,
// and fails with the 400 to send when it is not.
RouteResult validate_parent_assignment (vayu::db::Database& db,
const std::string& id,
const std::optional<std::string>& parent_id);
// Defined in collections.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// Defined in collections.cpp; the GET /collections answer, {status, body}.
std::pair<int, nlohmann::json> list_collections_response (vayu::db::Database& db,
const ListPageQuery& page_query);
} // namespace vayu::http::routes

namespace {

class CollectionsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_collections_route.db";

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

    // Persist a collection with an optional parent. Bypasses the route so tests
    // can build shapes (including corrupt cycles) the route would reject.
    void seed_collection (const std::string& id,
    const std::string& name,
    std::optional<std::string> parent = std::nullopt,
    int order                         = 0) {
        vayu::db::Collection col;
        col.id        = id;
        col.name      = name;
        col.parent_id = std::move (parent);
        col.order     = order;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id, const std::string& collection_id, int order = 0) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "req";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/";
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 2;
        db_->save_request (r);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// -- Write-time validation -------------------------------------------------

TEST_F (CollectionsRouteTest, NullParentIsAllowed) {
    seed_collection ("col_a", "A");
    EXPECT_TRUE (
    vayu::http::routes::validate_parent_assignment (*db_, "col_a", std::nullopt).has_value ());
}

TEST_F (CollectionsRouteTest, SelfParentRejectedWith400) {
    seed_collection ("col_a", "A");
    const auto outcome =
    vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_a");
    ASSERT_FALSE (outcome.has_value ());
    EXPECT_EQ (outcome.error ().status, 400);
    EXPECT_EQ (outcome.error ().body["error"]["message"], "A collection cannot be its own parent");
}

TEST_F (CollectionsRouteTest, ReparentIntoDescendantRejectedWith400) {
    // A -> B -> C. Moving A under C would make A its own descendant's child.
    seed_collection ("col_a", "A");
    seed_collection ("col_b", "B", "col_a");
    seed_collection ("col_c", "C", "col_b");

    const auto outcome =
    vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_c");
    ASSERT_FALSE (outcome.has_value ());
    EXPECT_EQ (outcome.error ().status, 400);
    EXPECT_EQ (outcome.error ().body["error"]["message"],
    "Cannot move a collection into its own descendant");
}

TEST_F (CollectionsRouteTest, LegalReparentSucceeds) {
    // A -> B, and a sibling D. Moving D under B is legal (B is not a descendant
    // of D), so validation succeeds.
    seed_collection ("col_a", "A");
    seed_collection ("col_b", "B", "col_a");
    seed_collection ("col_d", "D");

    EXPECT_TRUE (
    vayu::http::routes::validate_parent_assignment (*db_, "col_d", "col_b").has_value ());
}

TEST_F (CollectionsRouteTest, MissingParentEndsWalkCleanly) {
    // Parent existence is intentionally not required (import creates in bulk).
    // A parent id that resolves to nothing must pass, not throw or reject.
    seed_collection ("col_a", "A");
    EXPECT_TRUE (
    vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_ghost").has_value ());
}

TEST_F (CollectionsRouteTest, PreExistingCycleDoesNotHangValidator) {
    // Corrupt data: X -> Y -> X, written before validation existed. Validating
    // an unrelated node whose parent chain enters the cycle must terminate
    // (the visited set bounds the walk) rather than spin forever.
    seed_collection ("col_x", "X", "col_y");
    seed_collection ("col_y", "Y", "col_x");
    seed_collection ("col_z", "Z");

    // col_z is not on the x/y cycle, so the walk simply terminates: legal.
    EXPECT_TRUE (
    vayu::http::routes::validate_parent_assignment (*db_, "col_z", "col_x").has_value ());
}

// -- Cascade delete --------------------------------------------------------

TEST_F (CollectionsRouteTest, DeleteTerminatesAndClearsCycle) {
    // Self-referential corrupt data: a collection that is its own parent. The
    // old BFS (no visited set) would grow to_delete forever here. Deletion must
    // terminate and remove the collection and its requests.
    seed_collection ("col_loop", "Loop", "col_loop");
    seed_request ("req_loop", "col_loop");

    db_->delete_collection ("col_loop");

    EXPECT_FALSE (db_->get_collection ("col_loop").has_value ());
    EXPECT_FALSE (db_->get_request ("req_loop").has_value ());
}

TEST_F (CollectionsRouteTest, DeleteTerminatesOnTwoNodeCycle) {
    // A -> B -> A cycle plus requests in each. Deleting either entry point must
    // terminate and remove both collections and both requests.
    seed_collection ("col_a", "A", "col_b");
    seed_collection ("col_b", "B", "col_a");
    seed_request ("req_a", "col_a");
    seed_request ("req_b", "col_b");

    db_->delete_collection ("col_a");

    EXPECT_FALSE (db_->get_collection ("col_a").has_value ());
    EXPECT_FALSE (db_->get_collection ("col_b").has_value ());
    EXPECT_FALSE (db_->get_request ("req_a").has_value ());
    EXPECT_FALSE (db_->get_request ("req_b").has_value ());
}

TEST_F (CollectionsRouteTest, NestedCascadeDeletesChildrenAndRequests) {
    // Acyclic regression, made explicit so the transaction rewrite stays honest:
    // parent -> child, requests in both, all gone after deleting the parent; an
    // unrelated sibling tree is untouched.
    seed_collection ("col_parent", "Parent");
    seed_collection ("col_child", "Child", "col_parent");
    seed_request ("req_parent", "col_parent");
    seed_request ("req_child", "col_child");

    seed_collection ("col_other", "Other");
    seed_request ("req_other", "col_other");

    db_->delete_collection ("col_parent");

    EXPECT_FALSE (db_->get_collection ("col_parent").has_value ());
    EXPECT_FALSE (db_->get_collection ("col_child").has_value ());
    EXPECT_FALSE (db_->get_request ("req_parent").has_value ());
    EXPECT_FALSE (db_->get_request ("req_child").has_value ());

    // Sibling tree survives.
    EXPECT_TRUE (db_->get_collection ("col_other").has_value ());
    EXPECT_TRUE (db_->get_request ("req_other").has_value ());
}

// -- The append rule across kinds (#2535) -----------------------------------
//
// A collection's children are its sub-folders and its requests in one `order`
// space, so a folder that states no `order` lands after both kinds. Mutation
// check: drop the request scan from `Database::next_sibling_order` and each of
// these lands among the parent's requests instead.

TEST_F (CollectionsRouteTest, ACreatedFolderAppendsAfterItsParentsRequests) {
    seed_collection ("col_p", "P");
    seed_collection ("col_f", "F", "col_p", 1);
    seed_request ("req_a", "col_p", 4);

    auto [status, body] = vayu::http::routes::create_collection_response (
    *db_, json{ { "name", "new" }, { "parentId", "col_p" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 5);
}

TEST_F (CollectionsRouteTest, AReparentWithNoOrderAppendsPastBothKindsOfTheDestination) {
    seed_collection ("col_moving", "Moving", std::nullopt, 9);
    seed_collection ("col_d", "Destination");
    seed_collection ("col_f", "F", "col_d", 1);
    seed_request ("req_a", "col_d", 3);

    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_moving", json{ { "parentId", "col_d" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 4);
}

// The folder itself holds the highest slot, so a reset that counted it would
// land one past itself rather than after its siblings.
TEST_F (CollectionsRouteTest, AnExplicitNullOrderLandsAfterTheOtherSiblingsOfBothKinds) {
    seed_collection ("col_p", "P");
    seed_collection ("col_x", "X", "col_p", 9);
    seed_collection ("col_y", "Y", "col_p", 1);
    seed_request ("req_a", "col_p", 6);

    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_x", json{ { "order", nullptr } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 7);
}

// The roots are the collections with no parent; a nested folder's higher
// `order` is a position in another list.
TEST_F (CollectionsRouteTest, ARootAppendsAfterTheOtherRootsOnly) {
    seed_collection ("col_a", "A", std::nullopt, 2);
    seed_collection ("col_nested", "Nested", "col_a", 8);

    auto [status, body] =
    vayu::http::routes::create_collection_response (*db_, json{ { "name", "root" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"], 3);
}

// -- A collection never inherits auth (#3445) -------------------------------
//
// Mutation check: drop `reject_inherit_auth` from either core and the matching
// refusal test reds; make it fire on an absent `auth` and the legacy-row test
// reds; make it fire on null and the null test reds.

TEST_F (CollectionsRouteTest, ACreateStatingInheritAuthIsRefusedAndWritesNothing) {
    auto [status, body] = vayu::http::routes::create_collection_response (
    *db_, json{ { "name", "X" }, { "auth", { { "mode", "inherit" } } } });

    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("'auth'"), std::string::npos)
    << body.dump ();
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (CollectionsRouteTest, AnUpdateStatingInheritAuthIsRefusedAndLeavesTheRowAlone) {
    seed_collection ("col_a", "A");
    const auto before = db_->get_collection ("col_a");
    ASSERT_HAS_VALUE (before);

    auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col_a", json{ { "name", "Renamed" }, { "auth", { { "mode", "inherit" } } } });

    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("'auth'"), std::string::npos)
    << body.dump ();
    const auto after = db_->get_collection ("col_a");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->name, "A");
    EXPECT_EQ (after->auth, before->auth);
    EXPECT_EQ (after->updated_at, before->updated_at);
}

TEST_F (CollectionsRouteTest, OtherAuthModesAreStillStored) {
    auto [status, body] = vayu::http::routes::create_collection_response (*db_,
    json{ { "name", "X" }, { "auth", { { "mode", "bearer" }, { "token", "t" } } } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["auth"]["mode"], "bearer");
}

// A row stored before the refusal existed is still editable: only a stated
// `auth` is judged, so a PUT that says nothing about it passes.
TEST_F (CollectionsRouteTest, APutOfOtherFieldsSucceedsOnARowStoredWithInheritAuth) {
    vayu::db::Collection legacy;
    legacy.id   = "col_legacy";
    legacy.name = "Legacy";
    legacy.auth = R"({"mode":"inherit"})";
    db_->create_collection (legacy);

    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_legacy", json{ { "name", "Renamed" } });

    ASSERT_EQ (status, 200) << body.dump ();
    const auto stored = db_->get_collection ("col_legacy");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->name, "Renamed");
    EXPECT_EQ (json::parse (stored->auth)["mode"], "inherit");
}

TEST_F (CollectionsRouteTest, ANullAuthResetsToNoneOnBothVerbs) {
    auto [created_status, created] = vayu::http::routes::create_collection_response (
    *db_, json{ { "name", "X" }, { "auth", nullptr } });
    ASSERT_EQ (created_status, 200) << created.dump ();
    EXPECT_EQ (created["auth"]["mode"], "none");

    seed_collection ("col_a", "A");
    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_a", json{ { "auth", nullptr } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["auth"]["mode"], "none");
}

// -- A stored auth names a known mode (#3464) -------------------------------
//
// Mutation check: drop `reject_unknown_auth_mode` from either core and the
// matching test reds (each case is a loop, so all of its rows go with it); make
// it fire on null or on an absent `auth` and the valid-write test reds.

// Every body here parsed as stored and sent with no credential before the check.
const std::vector<json>& unknown_auth_blocks () {
    static const std::vector<json> blocks = {
        json{ { "mode", "Inherit" } },
        json{ { "mode", "Bearer" }, { "token", "t" } },
        json{ { "mode", " inherit" } },
        json{ { "mode", "" } },
        json{ { "mode", 7 } },
        json{ { "mode", nullptr } },
        json{ { "mode", json::array ({ "bearer" }) } },
        json{ { "token", "t" } },
        json::object (),
    };
    return blocks;
}

TEST_F (CollectionsRouteTest, ACreateWithAnUnknownAuthModeIsRefusedAndWritesNothing) {
    for (const json& auth : unknown_auth_blocks ()) {
        auto [status, body] = vayu::http::routes::create_collection_response (
        *db_, json{ { "name", "X" }, { "auth", auth } });

        EXPECT_EQ (status, 400) << auth.dump () << " -> " << body.dump ();
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("auth.mode"), std::string::npos)
        << body.dump ();
    }
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (CollectionsRouteTest, AnUpdateWithAnUnknownAuthModeIsRefusedAndLeavesTheRowAlone) {
    seed_collection ("col_a", "A");
    const auto before = db_->get_collection ("col_a");
    ASSERT_HAS_VALUE (before);

    for (const json& auth : unknown_auth_blocks ()) {
        auto [status, body] = vayu::http::routes::update_collection_response (
        *db_, "col_a", json{ { "name", "Renamed" }, { "auth", auth } });

        EXPECT_EQ (status, 400) << auth.dump () << " -> " << body.dump ();
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("auth.mode"), std::string::npos)
        << body.dump ();
    }
    const auto after = db_->get_collection ("col_a");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->name, "A");
    EXPECT_EQ (after->auth, before->auth);
    EXPECT_EQ (after->updated_at, before->updated_at);
}

// A bare array was already a 400 from `apply_json_field`; it must still store
// nothing on either verb now that the mode check sits ahead of it.
TEST_F (CollectionsRouteTest, AnAuthThatIsNotAnObjectIsStillRefusedOnBothVerbs) {
    seed_collection ("col_a", "A");

    auto [created_status, created] = vayu::http::routes::create_collection_response (
    *db_, json{ { "name", "X" }, { "auth", json::array ({ "inherit" }) } });
    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_a", json{ { "auth", json::array ({ "inherit" }) } });

    EXPECT_EQ (created_status, 400) << created.dump ();
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_EQ (db_->get_collections ().size (), 1U);
}

TEST_F (CollectionsRouteTest, EveryKnownAuthModeButInheritIsStoredOnBothVerbs) {
    seed_collection ("col_a", "A");
    for (const std::string_view mode : vayu::http::AUTH_MODES) {
        if (mode == "inherit") {
            continue; // #3445, above.
        }
        auto [created_status, created] = vayu::http::routes::create_collection_response (
        *db_, json{ { "name", "X" }, { "auth", { { "mode", std::string (mode) } } } });
        auto [status, body] = vayu::http::routes::update_collection_response (
        *db_, "col_a", json{ { "auth", { { "mode", std::string (mode) } } } });

        EXPECT_EQ (created_status, 200) << mode << " -> " << created.dump ();
        EXPECT_EQ (status, 200) << mode << " -> " << body.dump ();
    }
}

// -- GET /collections: `q` / `limit` / `offset` (#2443) ----------------------

std::vector<std::string> ids_of (const json& rows) {
    std::vector<std::string> ids;
    for (const auto& row : rows) {
        ids.push_back (row.at ("id").get<std::string> ());
    }
    return ids;
}

// With none of the three keys the route answers the bare array it always has,
// every live collection serialized in the documented order. Mutation check:
// answer a call with no key through `list_page_of` and this reds.
TEST_F (CollectionsRouteTest, ListWithNoPagingKeysIsTheBareArrayByteForByte) {
    seed_collection ("col_b", "B", std::nullopt, 1);
    seed_collection ("col_a", "A", std::nullopt, 0);
    json expected = json::array ();
    for (const auto& c : db_->get_collections ()) {
        expected.push_back (vayu::json::serialize (c));
    }
    ASSERT_EQ (expected.size (), 2U);

    auto [status, body] = vayu::http::routes::list_collections_response (
    *db_, vayu::http::routes::ListPageQuery{});
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.dump (), expected.dump ());
}

// `q` is a case-insensitive substring of the name, and a collection in the
// trash never matches. Mutation check: drop the `matches` predicate from
// list_collections_response and the unmatched rows come back.
TEST_F (CollectionsRouteTest, PagedListMatchesQAgainstTheNameCaseInsensitively) {
    seed_collection ("col_pay", "Payments API", std::nullopt, 0);
    seed_collection ("col_users", "Users", std::nullopt, 1);
    seed_collection ("col_pay2", "legacy PAYMENTS v1", "col_users", 0);
    seed_collection ("col_old", "Old payments", std::nullopt, 2);
    db_->delete_collection ("col_old");

    auto [status, body] =
    vayu::http::routes::list_collections_response (*db_, { .q = "payMENTS" });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (ids_of (body["data"]), (std::vector<std::string>{ "col_pay", "col_pay2" }));
    EXPECT_EQ (body["pagination"]["total"], 2);
    const auto pay = db_->get_collection ("col_pay");
    ASSERT_HAS_VALUE (pay);
    EXPECT_EQ (body["data"][0], vayu::json::serialize (*pay));
}

// Pages walk the documented order without a gap or a repeat. Mutation check:
// drop the offset from ListPage::window and every page restarts at the top.
TEST_F (CollectionsRouteTest, PagedListWalksTheOrderedRowsInStablePages) {
    for (int i = 4; i >= 0; --i) {
        seed_collection ("col_" + std::to_string (i), "C", std::nullopt, i);
    }
    std::vector<std::string> walked;
    for (const auto& [offset, returned, has_more] : { std::tuple{ "0", 2, true },
         std::tuple{ "2", 2, true }, std::tuple{ "4", 1, false } }) {
        auto [status, body] = vayu::http::routes::list_collections_response (
        *db_, { .limit = "2", .offset = offset });
        ASSERT_EQ (status, 200) << body.dump ();
        EXPECT_EQ (body["pagination"]["returned"], returned) << offset;
        EXPECT_EQ (body["pagination"]["hasMore"], has_more) << offset;
        EXPECT_EQ (body["pagination"]["total"], 5) << offset;
        for (const auto& id : ids_of (body["data"])) {
            walked.push_back (id);
        }
    }
    EXPECT_EQ (walked,
    (std::vector<std::string>{ "col_0", "col_1", "col_2", "col_3", "col_4" }));
}

TEST_F (CollectionsRouteTest, PagedListRefusesABadLimitOrOffset) {
    for (const auto& [query, code] :
    { std::pair{ vayu::http::routes::ListPageQuery{ .limit = "5abc" }, "invalid_limit" },
    std::pair{ vayu::http::routes::ListPageQuery{ .offset = "" }, "invalid_offset" } }) {
        auto [status, body] = vayu::http::routes::list_collections_response (*db_, query);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (body["error"]["code"], code);
    }
}

} // namespace
