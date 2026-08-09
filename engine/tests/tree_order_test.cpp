/**
 * @file tests/tree_order_test.cpp
 * @brief The ordering foundation the sidebar, the MCP smoke tool and a scenario
 *        plan all read (issue #360).
 *
 * Four contracts, each of which was a real defect before this file existed:
 *
 *  - **A created request appends.** `order` defaulted to 0, so every
 *    UI-created request tied with every other one and the stored column
 *    encoded nothing. The moment explicit orders exist - the first drag -
 *    every new or duplicated request would have jumped to the top.
 *  - **The tie rule is pinned, and stable across an edit.** A single-key
 *    `ORDER BY` left ties to the implicit rowid, and `INSERT OR REPLACE` on a
 *    TEXT primary key reassigns that rowid on every write - so renaming a
 *    request silently reshuffled it among its ties. The stability test is the
 *    mutation check: drop `created_at` from either ORDER BY and it reddens.
 *  - **A write cannot strand a row.** `collectionId` pointing at nothing used
 *    to succeed; no per-collection GET lists such a row and no cascade delete
 *    ever reaps it.
 *  - **A reparented collection appends among its new siblings** instead of
 *    keeping a position from the list it just left.
 *
 * The tie rule itself is driven from `fixtures/tree-order-conformance.json`,
 * which `app/src/types/tree-order.conformance.test.ts` also reads - the sidebar
 * and the engine cannot disagree without one of the two suites failing.
 *
 * Route cores are exercised directly, no in-process HTTP server, matching the
 * suite's other route tests.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in collections.cpp / requests.cpp; each returns {http_status, body}.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "tree-order-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

class TreeOrderTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_tree_order.db";
    // Owns the request rows in the conformance cases, and is filtered out of the
    // collection assertions so only the case's own rows are compared.
    static constexpr const char* HOLDER = "col-holder";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        seed_collection (HOLDER, /*order=*/0, /*created_at=*/1);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection (const std::string& id,
    int order,
    int64_t created_at,
    const std::string& parent_id = "") {
        vayu::db::Collection c;
        c.id = id;
        if (!parent_id.empty ()) {
            c.parent_id = parent_id;
        }
        c.name       = "Collection " + id;
        c.order      = order;
        c.created_at = created_at;
        c.updated_at = created_at;
        db_->create_collection (c);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    int order,
    int64_t created_at) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/";
        r.order         = order;
        r.created_at    = created_at;
        r.updated_at    = created_at;
        db_->save_request (r);
    }

    // The minimum body POST /requests accepts, so a test states only the field
    // it is about.
    static json request_body (const std::string& collection_id, const std::string& name) {
        return json{ { "collectionId", collection_id }, { "name", name },
            { "method", "GET" }, { "url", "https://example.test/" } };
    }

    std::vector<std::string> request_ids (const std::string& collection_id) {
        std::vector<std::string> ids;
        for (const auto& r : db_->get_requests_in_collection (collection_id)) {
            ids.push_back (r.id);
        }
        return ids;
    }

    // Every collection except the request holder, in stored order.
    std::vector<std::string> collection_ids () {
        std::vector<std::string> ids;
        for (const auto& c : db_->get_collections ()) {
            if (c.id != HOLDER) {
                ids.push_back (c.id);
            }
        }
        return ids;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// --- The shared tie rule ------------------------------------------------------

TEST_F (TreeOrderTest, ConformanceFixtureIsNonEmpty) {
    const json fixture = load_fixture ();
    // Guards the scan itself: a fixture that failed to load would otherwise make
    // every case below vacuously pass.
    ASSERT_TRUE (fixture.contains ("cases"));
    EXPECT_GE (fixture["cases"].size (), 12u);
}

TEST_F (TreeOrderTest, RequestsFollowTheConformanceOrder) {
    // Named, not `load_fixture ()["cases"]` inline: the subscript returns a
    // reference into a temporary the full expression then destroys, so the loop
    // would walk freed memory - and in practice walk nothing, passing whatever
    // the ORDER BY did. `cases_run` is the guard against exactly that.
    const json fixture = load_fixture ();
    size_t cases_run   = 0;
    for (const auto& c : fixture["cases"]) {
        const std::string name = c["name"].get<std::string> ();
        std::vector<std::string> expected;
        for (const auto& row : c["rows"]) {
            seed_request (row["id"].get<std::string> (), HOLDER,
            row["order"].get<int> (), row["createdAt"].get<int64_t> ());
        }
        for (const auto& id : c["expected"]) {
            expected.push_back (id.get<std::string> ());
        }

        EXPECT_EQ (request_ids (HOLDER), expected) << "case: " << name;
        ++cases_run;

        for (const auto& row : c["rows"]) {
            db_->delete_request (row["id"].get<std::string> ());
        }
    }
    EXPECT_GE (cases_run, 12u) << "the fixture loop asserted nothing";
}

TEST_F (TreeOrderTest, CollectionsFollowTheConformanceOrder) {
    const json fixture = load_fixture ();
    size_t cases_run   = 0;
    for (const auto& c : fixture["cases"]) {
        const std::string name = c["name"].get<std::string> ();
        std::vector<std::string> expected;
        for (const auto& row : c["rows"]) {
            seed_collection (row["id"].get<std::string> (), row["order"].get<int> (),
            row["createdAt"].get<int64_t> ());
        }
        for (const auto& id : c["expected"]) {
            expected.push_back (id.get<std::string> ());
        }

        EXPECT_EQ (collection_ids (), expected) << "case: " << name;
        ++cases_run;

        for (const auto& row : c["rows"]) {
            db_->delete_collection (row["id"].get<std::string> ());
        }
    }
    EXPECT_GE (cases_run, 12u) << "the fixture loop asserted nothing";
}

// --- Stability across an edit (the rowid-churn mutation check) -----------------

TEST_F (TreeOrderTest, EditingATiedRequestDoesNotMoveIt) {
    seed_request ("req-a", HOLDER, /*order=*/0, /*created_at=*/1000);
    seed_request ("req-b", HOLDER, /*order=*/0, /*created_at=*/2000);
    seed_request ("req-c", HOLDER, /*order=*/0, /*created_at=*/3000);
    const std::vector<std::string> before{ "req-a", "req-b", "req-c" };
    ASSERT_EQ (request_ids (HOLDER), before);

    // A rename is an INSERT OR REPLACE, which hands the row a fresh rowid. With
    // the rowid as the tiebreak this moved "req-a" to the end of the tie group.
    const auto [status, body] = vayu::http::routes::update_request_response (*db_,
    "req-a", json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200) << body.dump ();

    EXPECT_EQ (request_ids (HOLDER), before);
}

TEST_F (TreeOrderTest, EditingATiedCollectionDoesNotMoveIt) {
    seed_collection ("col-a", /*order=*/0, /*created_at=*/1000);
    seed_collection ("col-b", /*order=*/0, /*created_at=*/2000);
    const std::vector<std::string> before{ "col-a", "col-b" };
    ASSERT_EQ (collection_ids (), before);

    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-a", json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200) << body.dump ();

    EXPECT_EQ (collection_ids (), before);
}

// --- Request create appends ---------------------------------------------------

TEST_F (TreeOrderTest, FirstRequestInACollectionGetsOrderZero) {
    const auto [status, body] =
    vayu::http::routes::create_request_response (*db_, request_body (HOLDER, "First"));
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 0);
}

TEST_F (TreeOrderTest, ACreatedRequestAppendsAfterItsSiblings) {
    seed_request ("req-0", HOLDER, /*order=*/0, /*created_at=*/1000);
    seed_request ("req-1", HOLDER, /*order=*/1, /*created_at=*/2000);
    seed_request ("req-2", HOLDER, /*order=*/2, /*created_at=*/3000);

    const auto [status, body] =
    vayu::http::routes::create_request_response (*db_, request_body (HOLDER, "Appended"));
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 3);
    EXPECT_EQ (request_ids (HOLDER).back (), body["id"].get<std::string> ());
}

TEST_F (TreeOrderTest, TheAppendedOrderIsPerCollectionNotGlobal) {
    seed_collection ("col-other", /*order=*/1, /*created_at=*/1);
    seed_request ("req-x", "col-other", /*order=*/9, /*created_at=*/1000);

    const auto [status, body] =
    vayu::http::routes::create_request_response (*db_, request_body (HOLDER, "Fresh"));
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 0);
}

TEST_F (TreeOrderTest, AnExplicitOrderOnCreateIsHonoured) {
    seed_request ("req-0", HOLDER, /*order=*/0, /*created_at=*/1000);

    json body_json     = request_body (HOLDER, "Pinned");
    body_json["order"] = 42;
    const auto [status, body] = vayu::http::routes::create_request_response (*db_, body_json);
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 42);
}

TEST_F (TreeOrderTest, ANullOrderOnCreateAppends) {
    seed_request ("req-0", HOLDER, /*order=*/4, /*created_at=*/1000);

    json body_json     = request_body (HOLDER, "Defaulted");
    body_json["order"] = nullptr;
    const auto [status, body] = vayu::http::routes::create_request_response (*db_, body_json);
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 5);
}

// --- A write cannot strand a row ----------------------------------------------

TEST_F (TreeOrderTest, CreatingUnderAMissingCollectionIs400) {
    const auto [status, body] =
    vayu::http::routes::create_request_response (*db_, request_body ("col-nope", "Orphan"));
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("col-nope"), std::string::npos)
    << body.dump ();
    // Nothing persisted: the 400 is a rejection, not a rejection-after-write.
    EXPECT_TRUE (db_->get_requests_in_collection ("col-nope").empty ());
}

TEST_F (TreeOrderTest, MovingToAMissingCollectionIs400AndKeepsTheRowWhereItWas) {
    seed_request ("req-a", HOLDER, /*order=*/0, /*created_at=*/1000);

    const auto [status, body] = vayu::http::routes::update_request_response (*db_,
    "req-a", json{ { "collectionId", "col-nope" } });
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_EQ (request_ids (HOLDER), (std::vector<std::string>{ "req-a" }));
}

TEST_F (TreeOrderTest, AnUpdateThatStatesNoCollectionStillWritesAStrandedRow) {
    // A row written before the check existed must stay editable - and repairable
    // by a PUT that moves it somewhere real - rather than becoming unwritable.
    seed_request ("req-stranded", "col-gone", /*order=*/0, /*created_at=*/1000);

    const auto renamed = vayu::http::routes::update_request_response (*db_,
    "req-stranded", json{ { "name", "Still editable" } });
    EXPECT_EQ (renamed.first, 200) << renamed.second.dump ();

    const auto repaired = vayu::http::routes::update_request_response (*db_,
    "req-stranded", json{ { "collectionId", HOLDER } });
    ASSERT_EQ (repaired.first, 200) << repaired.second.dump ();
    EXPECT_EQ (request_ids (HOLDER), (std::vector<std::string>{ "req-stranded" }));
}

// --- Moves append in the destination ------------------------------------------

TEST_F (TreeOrderTest, MovingARequestToAnotherCollectionAppendsThere) {
    seed_collection ("col-target", /*order=*/1, /*created_at=*/1);
    seed_request ("req-there-0", "col-target", /*order=*/0, /*created_at=*/1000);
    seed_request ("req-there-1", "col-target", /*order=*/1, /*created_at=*/2000);
    seed_request ("req-moving", HOLDER, /*order=*/0, /*created_at=*/3000);

    const auto [status, body] = vayu::http::routes::update_request_response (*db_,
    "req-moving", json{ { "collectionId", "col-target" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 2);
    EXPECT_EQ (request_ids ("col-target"),
    (std::vector<std::string>{ "req-there-0", "req-there-1", "req-moving" }));
}

TEST_F (TreeOrderTest, AMoveThatStatesAnOrderKeepsIt) {
    seed_collection ("col-target", /*order=*/1, /*created_at=*/1);
    seed_request ("req-there", "col-target", /*order=*/5, /*created_at=*/1000);
    seed_request ("req-moving", HOLDER, /*order=*/0, /*created_at=*/2000);

    const auto [status, body] = vayu::http::routes::update_request_response (*db_,
    "req-moving", json{ { "collectionId", "col-target" }, { "order", 3 } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 3);
}

TEST_F (TreeOrderTest, AnUpdateWithinTheSameCollectionKeepsItsOrder) {
    seed_request ("req-a", HOLDER, /*order=*/7, /*created_at=*/1000);

    const auto [status, body] = vayu::http::routes::update_request_response (*db_,
    "req-a", json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 7);
}

TEST_F (TreeOrderTest, ReparentingACollectionAppendsAmongItsNewSiblings) {
    seed_collection ("col-parent", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-child-0", /*order=*/0, /*created_at=*/2, "col-parent");
    seed_collection ("col-child-1", /*order=*/1, /*created_at=*/3, "col-parent");
    seed_collection ("col-moving", /*order=*/0, /*created_at=*/4);

    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-moving", json{ { "parentId", "col-parent" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 2);
}

TEST_F (TreeOrderTest, AReparentThatStatesAnOrderKeepsIt) {
    seed_collection ("col-parent", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-child", /*order=*/0, /*created_at=*/2, "col-parent");
    seed_collection ("col-moving", /*order=*/0, /*created_at=*/3);

    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-moving", json{ { "parentId", "col-parent" }, { "order", 0 } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 0);
}

TEST_F (TreeOrderTest, MovingACollectionToTheRootAppendsAmongTheRoots) {
    seed_collection ("col-root-0", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-root-1", /*order=*/1, /*created_at=*/2);
    seed_collection ("col-nested", /*order=*/0, /*created_at=*/3, "col-root-0");

    // Explicit JSON null on parentId is how a client says "move to the root";
    // absent would mean "keep the parent".
    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-nested", json{ { "parentId", nullptr } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_TRUE (body["parentId"].is_null ()) << body.dump ();
    // HOLDER (order 0), col-root-0 (0) and col-root-1 (1) are the stored roots.
    EXPECT_EQ (body["order"].get<int> (), 2);
}

TEST_F (TreeOrderTest, AnUpdateThatKeepsTheSameParentKeepsTheOrder) {
    seed_collection ("col-parent", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-child-0", /*order=*/0, /*created_at=*/2, "col-parent");
    seed_collection ("col-child-1", /*order=*/1, /*created_at=*/3, "col-parent");

    // Restating the current parent is not a move, so the position is untouched.
    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-child-0", json{ { "parentId", "col-parent" }, { "name", "Renamed" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 0);
}

TEST_F (TreeOrderTest, AnExplicitNullOrderOnUpdateAppendsRatherThanCollidingOnZero) {
    seed_collection ("col-a", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-b", /*order=*/1, /*created_at=*/2);
    seed_collection ("col-c", /*order=*/2, /*created_at=*/3);

    // "Reset to the default" - and this field's default is "append", which is
    // what create does. It used to reset to 0 and tie with the first sibling.
    const auto [status, body] = vayu::http::routes::update_collection_response (*db_,
    "col-a", json{ { "order", nullptr } });
    ASSERT_EQ (status, 200) << body.dump ();
    // HOLDER (0), col-b (1) and col-c (2) are the other roots; col-a itself is
    // excluded from the scan, so it lands one past the highest of those.
    EXPECT_EQ (body["order"].get<int> (), 3);
    EXPECT_EQ (collection_ids (), (std::vector<std::string>{ "col-b", "col-c", "col-a" }));
}

TEST_F (TreeOrderTest, ACreatedCollectionStillAppendsAmongItsSiblings) {
    seed_collection ("col-root-0", /*order=*/0, /*created_at=*/1);
    seed_collection ("col-root-1", /*order=*/3, /*created_at=*/2);

    const auto [status, body] = vayu::http::routes::create_collection_response (*db_,
    json{ { "name", "Appended" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["order"].get<int> (), 4);
}

} // namespace
