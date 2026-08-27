/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/trash_test.cpp
 * @brief Soft delete for collections and requests, and the three trash routes
 *        on top of it (issue #988).
 *
 * What is pinned here is what a soft delete can silently get wrong, and each of
 * these fails on a plausible implementation of the same feature:
 *
 *  - **A read surface that forgot the filter.** A stamped row that still shows
 *    up somewhere is a ghost, and it looks exactly like working software from
 *    every *other* surface. So each read is asserted, one per assertion, rather
 *    than "the sidebar looks right".
 *  - **A restore that brings back too much.** Restoring a collection must not
 *    resurrect a request the user deleted separately beforehand - the cohort
 *    rule, and the one thing a naive "clear every stamp under this subtree"
 *    gets wrong.
 *  - **A restore that brings back too little**, or into a parent that is gone:
 *    the re-parent rule.
 *  - **A purge that leaves rows behind.** A request left under a removed
 *    collection is reachable by no read and restorable by nothing, so the purge
 *    is asserted over the whole subtree and the examples under it.
 *  - **Retention purging the wrong side of the window**, and `0` meaning
 *    "immediately" rather than "keep forever".
 *
 * Follows the suite's route-test convention: the routes' extracted cores are
 * exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in trash.cpp / examples.cpp - the pair (or body) each handler writes.
nlohmann::json trash_list_body (vayu::db::Database& db);
std::pair<int, nlohmann::json>
trash_restore_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
trash_purge_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json> list_request_examples_response (vayu::db::Database& db,
const std::string& request_id);
} // namespace vayu::http::routes

namespace vayu::db {
namespace {

namespace routes = vayu::http::routes;

constexpr const char* TEST_DB_PATH = "test_trash.db";

/// A day in milliseconds - the unit `trashRetentionDays` is expressed in, spelled
/// once so a test that means "31 days from now" reads as that.
constexpr int64_t DAY_MS = 24LL * 60 * 60 * 1000;

/// A field of the engine's `{"error": {"code", "message"}}` envelope, or "" - so
/// a body that is not an error fails the assertion rather than throwing.
std::string error_field (const json& body, const char* field) {
    const auto error = body.find ("error");
    if (error == body.end () || !error->is_object ()) {
        return {};
    }
    return error->value (field, std::string{});
}

class TrashTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
        db_ = std::make_unique<Database> (TEST_DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    void make_collection (const std::string& id,
    const std::string& name,
    const std::optional<std::string>& parent = std::nullopt) {
        Collection col;
        col.id         = id;
        col.name       = name;
        col.parent_id  = parent;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    void make_request (const std::string& id, const std::string& collection_id) {
        Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/" + id;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    void make_example (const std::string& id, const std::string& request_id) {
        RequestExample e;
        e.id         = id;
        e.request_id = request_id;
        e.name       = id;
        e.status     = 200;
        e.headers    = "[]";
        e.body       = "{}";
        e.created_at = 1;
        e.updated_at = 1;
        db_->save_request_example (e);
    }

    /// The trash entry for @p id, so an assertion can name the row it means
    /// instead of indexing into a list whose order it would then also be
    /// asserting.
    std::optional<TrashEntry> entry_for (const std::string& id) {
        for (const auto& entry : db_->get_trash ()) {
            if (entry.id == id) {
                return entry;
            }
        }
        return std::nullopt;
    }

    std::unique_ptr<Database> db_;
};

// ---------------------------------------------------------------------------
// The filter: a stamped row is gone to every read surface
// ---------------------------------------------------------------------------

TEST_F (TrashTest, ADeletedCollectionIsAbsentFromEveryReadSurface) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_1", "col_1");

    db_->delete_collection ("col_1");

    EXPECT_TRUE (db_->get_collections ().empty ());
    EXPECT_FALSE (db_->get_collection ("col_1").has_value ());
    EXPECT_FALSE (db_->get_collection ("col_2").has_value ());
    EXPECT_FALSE (db_->get_request ("req_1").has_value ());
    EXPECT_TRUE (db_->get_requests_in_collection ("col_1").empty ());
}

TEST_F (TrashTest, ADeletedRequestIsAbsentButItsCollectionIsUntouched) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_request ("req_2", "col_1");

    db_->delete_request ("req_1");

    EXPECT_FALSE (db_->get_request ("req_1").has_value ());
    ASSERT_HAS_VALUE (db_->get_collection ("col_1"));
    auto remaining = db_->get_requests_in_collection ("col_1");
    ASSERT_EQ (remaining.size (), 1U);
    EXPECT_EQ (remaining.front ().id, "req_2");
}

TEST_F (TrashTest, ADeletedRequestsExamplesAreUnreachable) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_example ("exa_1", "req_1");

    ASSERT_EQ (routes::list_request_examples_response (*db_, "req_1").first, 200);
    db_->delete_request ("req_1");

    // The owner check every example route runs is what makes this a 404 rather
    // than a list of examples belonging to a request nobody can see.
    auto [status, body] = routes::list_request_examples_response (*db_, "req_1");
    EXPECT_EQ (status, 404);
    EXPECT_EQ (error_field (body, "message"), "Request not found");
}

TEST_F (TrashTest, ADeletedCollectionIsNotListedAsBindingItsSpecDocument) {
    SpecDocument doc;
    doc.id         = "spec_1";
    doc.content    = "{\"openapi\":\"3.0.0\"}";
    doc.hash       = "hash_1";
    doc.fetched_at = 1;
    db_->save_spec_document (doc);

    Collection col;
    col.id      = "col_1";
    col.name    = "API";
    col.openapi = R"({"specId":"spec_1","specHash":"hash_1","syncedAt":1})";
    db_->create_collection (col);
    ASSERT_EQ (db_->get_collections_bound_to_spec ("spec_1").size (), 1U);

    db_->delete_collection ("col_1");
    EXPECT_TRUE (db_->get_collections_bound_to_spec ("spec_1").empty ());

    // But the document itself survives, deliberately: the sweep reads the
    // unfiltered table, because a collection in the trash still binds what a
    // restore would need. Reclaiming it here would restore a broken binding.
    db_->sweep_orphaned_spec_documents ();
    EXPECT_TRUE (db_->get_spec_document ("spec_1").has_value ());
}

TEST_F (TrashTest, AReorderRefusesADeletedRow) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    auto stored = db_->get_request ("req_1");
    ASSERT_HAS_VALUE (stored);

    db_->delete_request ("req_1");

    // `update` carries the caller's whole struct, so a reorder that did not
    // check would clear the stamp and resurrect the row silently.
    stored->order = 5;
    EXPECT_THROW (db_->apply_reorder ({}, { *stored }), MissingRowError);
    EXPECT_FALSE (db_->get_request ("req_1").has_value ());
}

// ---------------------------------------------------------------------------
// The listing: roots only, with what their cascade took
// ---------------------------------------------------------------------------

TEST_F (TrashTest, TheTrashListsTheDeletedRootWithItsCascadeAsCounts) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_1", "col_1");
    make_request ("req_2", "col_2");

    db_->delete_collection ("col_1");

    auto entries = db_->get_trash ();
    ASSERT_EQ (entries.size (), 1U) << "a cascaded child is not a second root";
    EXPECT_EQ (entries.front ().id, "col_1");
    EXPECT_EQ (entries.front ().kind, "collection");
    EXPECT_EQ (entries.front ().name, "API");
    EXPECT_GT (entries.front ().deleted_at, 0);
    EXPECT_EQ (entries.front ().collections, 1);
    EXPECT_EQ (entries.front ().requests, 2);
}

TEST_F (TrashTest, ADeletedRequestIsItsOwnRootWithNoCounts) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");

    db_->delete_request ("req_1");

    auto entries = db_->get_trash ();
    ASSERT_EQ (entries.size (), 1U);
    // One binding, so the guard below is about the same expression the read
    // uses - `entries.front ()` written twice is two of them (engine/CLAUDE.md).
    const auto& entry = entries.front ();
    EXPECT_EQ (entry.kind, "request");
    ASSERT_HAS_VALUE (entry.parent_id);
    EXPECT_EQ (*entry.parent_id, "col_1");
    EXPECT_EQ (entry.collections, 0);
    EXPECT_EQ (entry.requests, 0);
}

TEST_F (TrashTest, TheListingIsNewestFirst) {
    make_collection ("col_1", "First");
    make_collection ("col_2", "Second");
    db_->delete_collection ("col_1");
    db_->delete_collection ("col_2");

    auto entries = db_->get_trash ();
    ASSERT_EQ (entries.size (), 2U);
    EXPECT_GE (entries.front ().deleted_at, entries.back ().deleted_at);
}

TEST_F (TrashTest, TheListRouteCarriesEveryFieldOfAnEntry) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_collection ("col_1");

    const auto body = routes::trash_list_body (*db_);
    ASSERT_TRUE (body.contains ("items"));
    ASSERT_EQ (body["total"], 1);
    const auto& item = body["items"][0];
    EXPECT_EQ (item["id"], "col_1");
    EXPECT_EQ (item["kind"], "collection");
    EXPECT_EQ (item["name"], "API");
    EXPECT_TRUE (item["parentId"].is_null ());
    EXPECT_EQ (item["collections"], 0);
    EXPECT_EQ (item["requests"], 1);
    EXPECT_GT (item["deletedAt"].get<int64_t> (), 0);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

TEST_F (TrashTest, RestoreBringsBackTheWholeSubtreeAsItWas) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_1", "col_2");
    db_->delete_collection ("col_1");

    auto outcome = db_->restore_deleted ("col_1");
    ASSERT_HAS_VALUE (outcome);
    EXPECT_FALSE (outcome->reparented);

    ASSERT_HAS_VALUE (db_->get_collection ("col_1"));
    auto nested = db_->get_collection ("col_2");
    ASSERT_HAS_VALUE (nested);
    ASSERT_HAS_VALUE (nested->parent_id);
    EXPECT_EQ (*nested->parent_id, "col_1")
    << "a restore rewrites nothing but the stamp";
    ASSERT_HAS_VALUE (db_->get_request ("req_1"));
    EXPECT_TRUE (db_->get_trash ().empty ());
}

TEST_F (TrashTest, RestoringACollectionLeavesAnEarlierSeparateDeleteInTheTrash) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_request ("req_2", "col_1");

    db_->delete_request ("req_1");    // The user meant this one to go.
    db_->delete_collection ("col_1"); // Then removed the whole collection.

    ASSERT_HAS_VALUE (db_->restore_deleted ("col_1"));

    ASSERT_HAS_VALUE (db_->get_request ("req_2"));
    EXPECT_FALSE (db_->get_request ("req_1").has_value ())
    << "the cohort rule: a restore puts back what its own delete took, no more";

    // And the earlier delete is a root again, now that its collection is live.
    auto entries = db_->get_trash ();
    ASSERT_EQ (entries.size (), 1U);
    EXPECT_EQ (entries.front ().id, "req_1");
}

TEST_F (TrashTest, RestoreReparentsToTheRootWhenTheParentIsInTheTrash) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");

    db_->delete_collection ("col_2"); // Its own cohort.
    db_->delete_collection ("col_1"); // A later one, which leaves col_2 alone.

    auto outcome = db_->restore_deleted ("col_2");
    ASSERT_HAS_VALUE (outcome);
    EXPECT_TRUE (outcome->reparented);

    auto restored = db_->get_collection ("col_2");
    ASSERT_HAS_VALUE (restored);
    EXPECT_FALSE (restored->parent_id.has_value ())
    << "a collection whose parent is gone comes back at the tree root";
}

TEST_F (TrashTest, RestoringARequestUnderADeletedCollectionIsRefused) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");

    db_->delete_request ("req_1");
    db_->delete_collection ("col_1");

    auto outcome = db_->restore_deleted ("req_1");
    ASSERT_FALSE (outcome.has_value ())
    << "the refusal is the point of this test";
    EXPECT_EQ (outcome.error ().reason, RestoreRefusal::OwnerGone);

    auto [status, body] = routes::trash_restore_response (*db_, "req_1");
    EXPECT_EQ (status, 409);
    EXPECT_NE (error_field (body, "message").find ("restore that first"), std::string::npos)
    << "the refusal names the way forward: " << error_field (body, "message");
}

TEST_F (TrashTest, RestoringSomethingTheTrashDoesNotHoldIsA404) {
    make_collection ("col_1", "API");

    auto [live_status, live_body] = routes::trash_restore_response (*db_, "col_1");
    EXPECT_EQ (live_status, 404)
    << "a live row is not restorable - it is not deleted";
    auto [missing_status, missing_body] = routes::trash_restore_response (*db_, "col_nope");
    EXPECT_EQ (missing_status, 404);
    EXPECT_NE (error_field (missing_body, "message").find ("col_nope"), std::string::npos);
}

TEST_F (TrashTest, TheRestoreRouteReportsWhatItPutBack) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_collection ("col_1");

    auto [status, body] = routes::trash_restore_response (*db_, "col_1");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["id"], "col_1");
    EXPECT_EQ (body["requests"], 1);
    EXPECT_TRUE (body["restored"].get<bool> ());
    EXPECT_FALSE (body["reparentedToRoot"].get<bool> ());
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

TEST_F (TrashTest, PurgeDestroysTheWholeSubtreeIncludingExamples) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_1", "col_2");
    make_example ("exa_1", "req_1");
    db_->delete_collection ("col_1");

    auto outcome = db_->purge_deleted ("col_1");
    ASSERT_HAS_VALUE (outcome);
    EXPECT_EQ (outcome->entry.requests, 1);

    EXPECT_TRUE (db_->get_trash ().empty ());
    EXPECT_FALSE (db_->restore_deleted ("col_1").has_value ())
    << "nothing left to restore";
    EXPECT_FALSE (db_->get_request_example ("exa_1").has_value ());
    EXPECT_TRUE (db_->get_request_examples ("req_1").empty ());
}

TEST_F (TrashTest, PurgeTakesARowAnEarlierDeleteLeftUnderTheSubtree) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_request ("req_1");
    db_->delete_collection ("col_1");

    ASSERT_HAS_VALUE (db_->purge_deleted ("col_1"));

    // The cohort is the unit of a *restore*, never of a purge: a request left
    // under a removed collection is reachable by no read and restorable by
    // nothing, so it would leak forever.
    EXPECT_TRUE (db_->get_trash ().empty ());
}

TEST_F (TrashTest, PurgingALiveRowIsRefused) {
    make_collection ("col_1", "API");

    EXPECT_FALSE (db_->purge_deleted ("col_1").has_value ());
    auto [status, body] = routes::trash_purge_response (*db_, "col_1");
    EXPECT_EQ (status, 404);
    ASSERT_HAS_VALUE (db_->get_collection ("col_1"))
    << "a mistyped id destroys nothing";
}

TEST_F (TrashTest, ThePurgeRouteReportsWhatItDestroyed) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_collection ("col_1");

    auto [status, body] = routes::trash_purge_response (*db_, "col_1");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["id"], "col_1");
    EXPECT_EQ (body["requests"], 1);
    EXPECT_TRUE (body["purged"].get<bool> ());
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

TEST_F (TrashTest, RetentionPurgesOnlyWhatIsPastTheWindow) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_collection ("col_1");
    auto entry = entry_for ("col_1");
    ASSERT_HAS_VALUE (entry);

    EXPECT_EQ (db_->purge_expired_trash (30, entry->deleted_at + (29 * DAY_MS)), 0);
    EXPECT_EQ (db_->get_trash ().size (), 1U);

    EXPECT_EQ (db_->purge_expired_trash (30, entry->deleted_at + (31 * DAY_MS)), 1);
    EXPECT_TRUE (db_->get_trash ().empty ());
}

TEST_F (TrashTest, ARetentionOfZeroKeepsTheTrashForever) {
    make_collection ("col_1", "API");
    db_->delete_collection ("col_1");
    auto entry = entry_for ("col_1");
    ASSERT_HAS_VALUE (entry);

    EXPECT_EQ (db_->purge_expired_trash (0, entry->deleted_at + (3650 * DAY_MS)), 0);
    EXPECT_EQ (db_->get_trash ().size (), 1U);
}

TEST_F (TrashTest, RetentionIsConfiguredAndSeededAtThirtyDays) {
    auto seeded = db_->get_config_entry ("trashRetentionDays");
    ASSERT_HAS_VALUE (seeded);
    EXPECT_EQ (seeded->value,
    std::to_string (vayu::core::constants::database::TRASH_RETENTION_DAYS));
    EXPECT_EQ (seeded->category, "data_retention");

    // The configured pass reads that entry: set it to keep-forever and a very
    // old delete survives a sweep that would otherwise take it.
    make_collection ("col_1", "API");
    db_->delete_collection ("col_1");
    seeded->value = "0";
    db_->save_config_entry (*seeded);
    EXPECT_EQ (db_->purge_expired_trash_configured (), 0);
    EXPECT_EQ (db_->get_trash ().size (), 1U);
}

} // namespace
} // namespace vayu::db
