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

#include <filesystem>
#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in collections.cpp; returns std::nullopt when the parent assignment
// is legal, else {http_status, json_body} describing the 400 rejection.
std::optional<std::pair<int, nlohmann::json>> validate_parent_assignment (
vayu::db::Database& db, const std::string& id,
const std::optional<std::string>& parent_id);
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
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
    }

    // Persist a collection with an optional parent. Bypasses the route so tests
    // can build shapes (including corrupt cycles) the route would reject.
    void seed_collection (const std::string& id, const std::string& name,
    std::optional<std::string> parent = std::nullopt) {
        vayu::db::Collection col;
        col.id        = id;
        col.name      = name;
        col.parent_id = std::move (parent);
        col.order     = 0;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id, const std::string& collection_id) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "req";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 2;
        db_->save_request (r);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// -- Write-time validation -------------------------------------------------

TEST_F (CollectionsRouteTest, NullParentIsAllowed) {
    seed_collection ("col_a", "A");
    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_a", std::nullopt);
    EXPECT_FALSE (err.has_value ());
}

TEST_F (CollectionsRouteTest, SelfParentRejectedWith400) {
    seed_collection ("col_a", "A");
    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_a");
    ASSERT_TRUE (err.has_value ());
    EXPECT_EQ (err->first, 400);
    EXPECT_EQ (err->second["error"], "A collection cannot be its own parent");
}

TEST_F (CollectionsRouteTest, ReparentIntoDescendantRejectedWith400) {
    // A -> B -> C. Moving A under C would make A its own descendant's child.
    seed_collection ("col_a", "A");
    seed_collection ("col_b", "B", "col_a");
    seed_collection ("col_c", "C", "col_b");

    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_c");
    ASSERT_TRUE (err.has_value ());
    EXPECT_EQ (err->first, 400);
    EXPECT_EQ (err->second["error"], "Cannot move a collection into its own descendant");
}

TEST_F (CollectionsRouteTest, LegalReparentSucceeds) {
    // A -> B, and a sibling D. Moving D under B is legal (B is not a descendant
    // of D). Validation returns nullopt.
    seed_collection ("col_a", "A");
    seed_collection ("col_b", "B", "col_a");
    seed_collection ("col_d", "D");

    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_d", "col_b");
    EXPECT_FALSE (err.has_value ());
}

TEST_F (CollectionsRouteTest, MissingParentEndsWalkCleanly) {
    // Parent existence is intentionally not required (import creates in bulk).
    // A parent id that resolves to nothing must pass, not throw or reject.
    seed_collection ("col_a", "A");
    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_a", "col_ghost");
    EXPECT_FALSE (err.has_value ());
}

TEST_F (CollectionsRouteTest, PreExistingCycleDoesNotHangValidator) {
    // Corrupt data: X -> Y -> X, written before validation existed. Validating
    // an unrelated node whose parent chain enters the cycle must terminate
    // (the visited set bounds the walk) rather than spin forever.
    seed_collection ("col_x", "X", "col_y");
    seed_collection ("col_y", "Y", "col_x");
    seed_collection ("col_z", "Z");

    auto err = vayu::http::routes::validate_parent_assignment (*db_, "col_z", "col_x");
    // col_z is not on the x/y cycle, so the walk simply terminates: legal.
    EXPECT_FALSE (err.has_value ());
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

} // namespace
