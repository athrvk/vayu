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

#include <algorithm>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "spec_move_fixture.hpp"
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
// Defined in collections.cpp; each returns {http_status, json_body}. The
// create core this file also calls is declared in spec_move_fixture.hpp.
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// The update core with its `before_write` seam, invoked inside the lock scope
// with the merged row staged and immediately before it is written.
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write);
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

// -- Leaving a spec binding (#3470) -----------------------------------------
//
// `PUT /collections/:id` with a `parentId` is the door a folder moves through
// besides `POST /reorder` (any API client); it answers as the reorder does for
// a moved folder, over the whole subtree.

class CollectionMoveSpecBindingTest : public CollectionsRouteTest {
    protected:
    void SetUp () override {
        CollectionsRouteTest::SetUp ();
        trees_  = std::make_unique<vayu::tests::SpecMoveTrees> (*db_);
        nested_ = make_folder ("nested", trees_->owners);
        // `listPets` again, a level deeper than `listOwners`.
        deep_pets_ = trees_->create_stamped (nested_, "GET", "/pets", "listPets");
        seed_request (unstamped_, nested_, 1);
    }
    void TearDown () override {
        trees_.reset ();
        CollectionsRouteTest::TearDown ();
    }

    json put (const std::string& id, const json& body) {
        auto [status, response] =
        vayu::http::routes::update_collection_response (*db_, id, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    std::string make_folder (const std::string& name, const std::string& parent_id) {
        auto [status, response] = vayu::http::routes::create_collection_response (
        *db_, json{ { "name", name }, { "parentId", parent_id } });
        EXPECT_EQ (status, 200) << response.dump ();
        return vayu::tests::id_of (response);
    }

    bool stored_stamp (const std::string& id) {
        const auto row = db_->get_request (id);
        if (!row) {
            ADD_FAILURE () << "no request " << id;
            return false;
        }
        return row->spec_operation.has_value ();
    }

    /// The operation ids declined under @p collection_id, sorted.
    std::vector<std::string> declined_at (const std::string& collection_id) {
        std::vector<std::string> ids;
        for (const auto& record : db_->get_declined_operations (collection_id)) {
            ids.push_back (record.operation_id);
        }
        std::ranges::sort (ids);
        return ids;
    }

    /// What `owners` holds once it has left `pets`'s contract: both stamps
    /// cleared and both operations declined there, with the unstamped request
    /// beside them never written.
    void expect_owners_left_pets () {
        for (const auto& id : { trees_->list_owners, deep_pets_ }) {
            EXPECT_FALSE (stored_stamp (id)) << id;
        }
        const auto unstamped = db_->get_request (unstamped_);
        ASSERT_HAS_VALUE (unstamped);
        EXPECT_EQ (unstamped->updated_at, 2)
        << "a request with no stamp has nothing to clear";
        EXPECT_EQ (declined_at (trees_->pets),
        (std::vector<std::string>{ "listOwners", "listPets" }));
        const json pets = trees_->diff_pets ();
        EXPECT_TRUE (pets["added"].empty ()) << pets.dump ();
        // `listPets` is still claimed by the request at the root, which
        // outranks its record.
        EXPECT_EQ (pets["declined"].size (), 1u) << pets.dump ();
        EXPECT_EQ (trees_->safe_sync_pets_created (), 0u);
    }

    void expect_nothing_declined () {
        for (const auto& id : { trees_->list_pets, trees_->list_owners, deep_pets_ }) {
            EXPECT_TRUE (stored_stamp (id)) << id;
        }
        EXPECT_TRUE (declined_at (trees_->pets).empty ());
        const json pets = trees_->diff_pets ();
        EXPECT_TRUE (pets["added"].empty ()) << pets.dump ();
        EXPECT_TRUE (pets["declined"].empty ()) << pets.dump ();
    }

    std::unique_ptr<vayu::tests::SpecMoveTrees> trees_;
    std::string nested_;
    std::string deep_pets_;
    const std::string unstamped_ = "req_unstamped";
};

// The issue's acceptance. Mutation checks: drop the `spec_operation` clear in
// `stage_reparent_departures` and both stamps survive into `cars`, which lists
// them as removed; pass no departures to `apply_reorder` and `pets` lists
// `listOwners` as added and a safe sync creates it again; walk only the moved
// folder's own requests and the nested one keeps its stamp; judge the binding
// after off the stored tree alone (ignore `SpecTreeMove`'s staged rows) and
// nothing is declined.
TEST_F (CollectionMoveSpecBindingTest, AFolderMovedToAnotherBindingIsDeclinedAtTheSource) {
    const json response = put (trees_->owners, json{ { "parentId", trees_->cars } });

    EXPECT_EQ (response["parentId"], trees_->cars) << response.dump ();
    expect_owners_left_pets ();
    const json cars = trees_->diff (trees_->cars, vayu::tests::CARS_DOC);
    EXPECT_TRUE (cars["removed"].empty ()) << "nothing foreign: " << cars.dump ();
}

TEST_F (CollectionMoveSpecBindingTest, AFolderMovedToAnUnboundCollectionIsDeclinedAtTheSource) {
    put (trees_->owners, json{ { "parentId", trees_->plain } });

    expect_owners_left_pets ();
}

TEST_F (CollectionMoveSpecBindingTest, AFolderMovedToTheTopLevelIsDeclinedAtTheSource) {
    const json response = put (trees_->owners, json{ { "parentId", nullptr } });

    EXPECT_TRUE (response["parentId"].is_null ()) << response.dump ();
    expect_owners_left_pets ();
}

// Mutation check: compare the two bindings' `specId` alone in
// `declined_by_move` and the stamps survive the move.
TEST_F (CollectionMoveSpecBindingTest, AFolderMovedToASiblingRootBoundToTheSameDocumentIsDeclined) {
    const std::string twin = trees_->create_bound ("Pets copy", trees_->pets_spec);

    put (trees_->owners, json{ { "parentId", twin } });

    expect_owners_left_pets ();
    EXPECT_TRUE (declined_at (twin).empty ());
}

// A reparent inside the contract, into a sub-folder bound to the root's own
// document included, and an edit that moves nothing keep every stamp.
TEST_F (CollectionMoveSpecBindingTest, AReparentWithinTheContractKeepsEveryStamp) {
    const std::string inner =
    trees_->create_bound ("pets again", trees_->pets_spec, trees_->pets);

    put (nested_, json{ { "parentId", trees_->pets } });
    put (trees_->owners, json{ { "parentId", inner } });
    put (trees_->owners, json{ { "name", "owners, renamed" } });

    expect_nothing_declined ();
    EXPECT_TRUE (declined_at (inner).empty ());
}

// Moving the bound collection itself moves the contract with its requests.
TEST_F (CollectionMoveSpecBindingTest, MovingTheBoundCollectionKeepsItsStamps) {
    put (trees_->pets, json{ { "parentId", trees_->plain } });

    expect_nothing_declined ();
}

// An unbind and a reparent in one body: the stamps leave with the folder, and
// the declines are recorded in the same transaction as the unbind's forget.
// Mutation check: write the unbind with `rebind_collection (merged)` alone and
// both stamps survive.
TEST_F (CollectionMoveSpecBindingTest, AnUnbindThatAlsoReparentsStillDeclinesAtTheSource) {
    put (trees_->owners, json{ { "parentId", trees_->cars }, { "openapi", nullptr } });

    expect_owners_left_pets ();
}

// A bound folder unbound and moved out at once leaves the contract it was: its
// request's stamp is cleared, and the decline that records is forgotten with
// the binding, as an unbind forgets every earlier one. Mutation check: forget
// before recording in `rebind_collection` and the record survives.
TEST_F (CollectionMoveSpecBindingTest, UnbindingAndMovingTheBoundCollectionForgetsWhatItDeclined) {
    const json response =
    put (trees_->cars, json{ { "parentId", trees_->plain }, { "openapi", nullptr } });

    EXPECT_EQ (response["openapi"], json::object ()) << response.dump ();
    EXPECT_FALSE (stored_stamp (trees_->list_cars));
    EXPECT_TRUE (declined_at (trees_->cars).empty ());
}

// The decline is part of the write's one transaction: a commit that fails
// leaves the folder, the stamps and the records as they were. The victim sits
// after `listOwners`, so the write has recorded that decline before it meets
// the missing row.
TEST_F (CollectionMoveSpecBindingTest, AReparentThatFailsAtCommitRecordsNoDecline) {
    const std::string victim =
    trees_->create_stamped (trees_->owners, "GET", "/pets", "listPets");

    auto [status, response] =
    vayu::http::routes::update_collection_response (*db_, trees_->owners,
    json{ { "parentId", trees_->plain } }, [&] { db_->delete_request (victim); });

    ASSERT_EQ (status, 409) << response.dump ();
    const auto owners = db_->get_collection (trees_->owners);
    ASSERT_HAS_VALUE (owners);
    EXPECT_EQ (owners->parent_id, std::optional<std::string> (trees_->pets));
    EXPECT_TRUE (stored_stamp (trees_->list_owners));
    EXPECT_TRUE (declined_at (trees_->pets).empty ());
}

} // namespace
