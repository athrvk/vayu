/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/trash_test.cpp
 * @brief Soft delete for collections, requests (issue #988), environments
 *        (#2970) and a user's saved examples (#2971), and the three trash
 *        routes on top of it.
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
 *  - **A purge that takes a live row** no trash entry ever listed, and the
 *    write that would have put one under a trashed parent (#1883).
 *  - **Retention purging the wrong side of the window**, and `0` meaning
 *    "immediately" rather than "keep forever".
 *
 * Follows the suite's route-test convention: the routes' extracted cores are
 * exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/db/sibling_order.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/http/mock_server.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in trash.cpp / examples.cpp - the pair (or body) each handler writes.
nlohmann::json trash_list_body (vayu::db::Database& db);
std::pair<int, nlohmann::json>
trash_list_response (vayu::db::Database& db, const ListPageQuery& page_query);
std::pair<int, nlohmann::json>
trash_restore_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
trash_purge_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json> list_request_examples_response (vayu::db::Database& db,
const std::string& request_id);
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> delete_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id);
// Defined in postman_export.cpp / spec_export.cpp.
std::pair<int, nlohmann::json>
export_postman_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
export_spec_response (vayu::db::Database& db, const nlohmann::json& json);
// Defined in collections.cpp.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// Defined in environments.cpp / postman_export.cpp.
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
delete_environment_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
export_postman_environment_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace vayu::db {
namespace {

namespace routes = vayu::http::routes;
// `list_page.hpp` brings in the `vayu::json` namespace, which would otherwise
// win the lookup of `json` from inside `vayu::db`.
using nlohmann::json;

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

    void make_example (const std::string& id,
    const std::string& request_id,
    const std::string& origin = vayu::core::constants::request_example::ORIGIN_IMPORT,
    std::optional<int64_t> deleted_at = std::nullopt) {
        RequestExample e;
        e.id           = id;
        e.request_id   = request_id;
        e.name         = id;
        e.status       = 200;
        e.headers      = "[]";
        e.body         = R"({"marker":")" + id + R"("})";
        e.content_type = "application/json";
        e.created_at   = 1;
        e.updated_at   = 1;
        e.origin       = origin;
        e.deleted_at   = deleted_at;
        db_->save_request_example (e);
    }

    /// A user-saved example - the only origin a delete sends to the trash.
    void make_user_example (const std::string& id, const std::string& request_id) {
        make_example (id, request_id, vayu::core::constants::request_example::ORIGIN_USER);
    }

    /// What `GET /requests/:id/examples` writes for @p id, or "" when it lists
    /// no such row - the text a restore must give back unchanged.
    std::string served_example (const std::string& request_id, const std::string& id) {
        const auto [status, listed] =
        routes::list_request_examples_response (*db_, request_id);
        if (status != 200) {
            return {};
        }
        for (const auto& example : listed) {
            if (example.at ("id").get<std::string> () == id) {
                return example.dump ();
            }
        }
        return {};
    }

    void make_environment (const std::string& id,
    const std::string& variables = "{}",
    bool is_active               = false) {
        Environment env;
        env.id          = id;
        env.name        = "Env " + id;
        env.description = "staging";
        env.variables   = variables;
        env.is_active   = is_active;
        env.created_at  = 1;
        env.updated_at  = 1;
        db_->save_environment (env);
    }

    /// What `GET /environments` writes for @p id, or "" when it lists no such
    /// row - the text a restore must give back unchanged.
    std::string served_environment (const std::string& id) {
        for (const auto& env : db_->get_environments ()) {
            if (env.id == id) {
                return vayu::json::serialize (env).dump ();
            }
        }
        return {};
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

TEST_F (TrashTest, ACollectionCannotBeParentedUnderATrashedOne) {
    make_collection ("col_trashed", "Trashed");
    make_collection ("col_live", "Live");
    db_->delete_collection ("col_trashed");

    // A trashed parent reads as missing to `get_collection`, and a missing
    // parent is legal (import's forward references), so only an explicit check
    // tells the two apart.
    auto [create_status, create_body] = routes::create_collection_response (
    *db_, json{ { "name", "x" }, { "parentId", "col_trashed" } });
    EXPECT_EQ (create_status, 409);
    EXPECT_EQ (error_field (create_body, "message"),
    "Collection 'col_trashed' is in the trash - restore it first");
    EXPECT_EQ (db_->get_collections ().size (), 1U)
    << "the refused create wrote nothing";

    auto [update_status, update_body] = routes::update_collection_response (
    *db_, "col_live", json{ { "parentId", "col_trashed" } });
    EXPECT_EQ (update_status, 409);
    EXPECT_EQ (error_field (update_body, "message"),
    "Collection 'col_trashed' is in the trash - restore it first");
    auto live = db_->get_collection ("col_live");
    ASSERT_HAS_VALUE (live);
    EXPECT_FALSE (live->parent_id.has_value ())
    << "the refused move wrote nothing";

    // An id the store has never seen is still not this refusal.
    auto [unknown_status, unknown_body] = routes::create_collection_response (
    *db_, json{ { "name", "y" }, { "parentId", "col_never_written" } });
    EXPECT_EQ (unknown_status, 200) << error_field (unknown_body, "message");
}

TEST_F (TrashTest, ACollectionStrandedUnderATrashedOneStaysEditable) {
    make_collection ("col_trashed", "Trashed");
    db_->delete_collection ("col_trashed");
    make_collection ("col_stranded", "Stranded", "col_trashed");

    // The refusal reads the parent the body states, never the stored one, so
    // a rename does not fail on a parent written before the refusal existed.
    auto [rename_status, rename_body] = routes::update_collection_response (
    *db_, "col_stranded", json{ { "name", "Renamed" } });
    EXPECT_EQ (rename_status, 200) << error_field (rename_body, "message");

    auto [move_status, move_body] = routes::update_collection_response (
    *db_, "col_stranded", json{ { "parentId", nullptr } });
    EXPECT_EQ (move_status, 200) << error_field (move_body, "message");
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

// -- `q` / `limit` / `offset` (#2443) ----------------------------------------

std::vector<std::string> ids_of (const json& rows) {
    std::vector<std::string> ids;
    for (const auto& row : rows) {
        ids.push_back (row.at ("id").get<std::string> ());
    }
    return ids;
}

// With none of the three keys the route answers `{items, total}` exactly as
// before. Mutation check: answer a call with no key through `list_page_of`
// and this reds.
TEST_F (TrashTest, TheListRouteWithNoPagingKeysIsTheItemsBodyByteForByte) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    db_->delete_request ("req_1");
    db_->delete_collection ("col_1");

    auto [status, body] = routes::trash_list_response (*db_, routes::ListPageQuery{});
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.dump (), routes::trash_list_body (*db_).dump ());
}

// `q` is a case-insensitive substring of a root's name. What a cascade took
// is not a root and never matches, and a restored row has left the trash.
// Mutation check: drop the `matches` predicate from trash_list_response and
// the unmatched root comes back.
TEST_F (TrashTest, TheListRouteMatchesQAgainstARootsNameCaseInsensitively) {
    make_collection ("col_pay", "Payments");
    make_collection ("col_child", "payments sandbox", "col_pay");
    make_collection ("col_users", "Users");
    make_collection ("col_back", "PAYMENTS restored");
    make_request ("req_refund", "col_users");
    Request pay;
    pay.id            = "req_pay";
    pay.collection_id = "col_users";
    pay.name          = "Pay a PaYmEnT";
    pay.url           = "https://example.test/";
    db_->save_request (pay);
    db_->delete_collection ("col_pay");
    db_->delete_request ("req_pay");
    db_->delete_request ("req_refund");
    db_->delete_collection ("col_back");
    ASSERT_EQ (routes::trash_restore_response (*db_, "col_back").first, 200);

    // The legacy body's rows, in its order, kept where `q` matches.
    const auto legacy = routes::trash_list_body (*db_);
    json expected     = json::array ();
    for (const auto& item : legacy["items"]) {
        if (item["id"] == "col_pay" || item["id"] == "req_pay") {
            expected.push_back (item);
        }
    }
    ASSERT_EQ (expected.size (), 2U) << "the fixture seeded the wrong roots";

    auto [status, body] = routes::trash_list_response (*db_, { .q = "PAYMENT" });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["data"], expected);
    EXPECT_EQ (body["pagination"]["total"], 2);
}

// Pages walk the newest-first order without a gap or a repeat. Mutation
// check: drop the offset from ListPage::window and every page restarts at the
// newest root.
TEST_F (TrashTest, TheListRouteWalksTheRootsInStablePages) {
    for (int i = 0; i < 5; ++i) {
        const std::string id = "col_" + std::to_string (i);
        make_collection (id, "Folder");
        db_->delete_collection (id);
    }
    const auto all = ids_of (routes::trash_list_body (*db_)["items"]);
    ASSERT_EQ (all.size (), 5U);

    std::vector<std::string> walked;
    for (const auto& [offset, returned, has_more] : { std::tuple{ "0", 2, true },
         std::tuple{ "2", 2, true }, std::tuple{ "4", 1, false } }) {
        auto [status, body] =
        routes::trash_list_response (*db_, { .limit = "2", .offset = offset });
        ASSERT_EQ (status, 200) << body.dump ();
        EXPECT_EQ (body["pagination"]["returned"], returned) << offset;
        EXPECT_EQ (body["pagination"]["hasMore"], has_more) << offset;
        EXPECT_EQ (body["pagination"]["total"], 5) << offset;
        for (const auto& id : ids_of (body["data"])) {
            walked.push_back (id);
        }
    }
    EXPECT_EQ (walked, all);
}

TEST_F (TrashTest, TheListRouteRefusesABadLimitOrOffset) {
    for (const auto& [query, code] :
    { std::pair{ routes::ListPageQuery{ .limit = "501" }, "invalid_limit" },
    std::pair{ routes::ListPageQuery{ .offset = "-1" }, "invalid_offset" } }) {
        auto [status, body] = routes::trash_list_response (*db_, query);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (error_field (body, "code"), code);
    }
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

// The spec-file and data-file bindings ride the row (#2765), so a restore
// that rewrites nothing but the stamp gives them back unchanged. Mutation
// check: reset `spec_file` to `{}` on each row `delete_collection` stamps and
// this fails.
TEST_F (TrashTest, RestoreBringsBackACollectionsFileBindings) {
    const json spec_file{ { "path", "/specs/pets.yaml" }, { "fileName", "pets.yaml" } };
    const json data_file{ { "path", "/data/users.csv" },
        { "fileName", "users.csv" }, { "castNumbers", true } };
    auto [status, created] = routes::create_collection_response (*db_,
    json{ { "name", "API" }, { "specFile", spec_file }, { "dataFile", data_file } });
    ASSERT_EQ (status, 200) << created.dump ();
    const std::string id = created["id"];

    db_->delete_collection (id);
    ASSERT_EQ (routes::trash_restore_response (*db_, id).first, 200);

    const auto restored = db_->get_collection (id);
    ASSERT_HAS_VALUE (restored);
    EXPECT_EQ (json::parse (restored->spec_file), spec_file);
    EXPECT_EQ (json::parse (restored->data_file), data_file);
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

// A restore rewrites nothing but the stamp, `order` included, and the append
// rule counts live siblings only (#2535): a folder created while a request sat
// in the trash may take its slot. The restored request then ties with it, and
// the sibling order settles the tie the same way every time, folder first.
TEST_F (TrashTest, ARestoredRequestKeepsItsOrderAndSortsAfterAFolderThatTookItsSlot) {
    make_collection ("col_p", "API");
    make_collection ("col_f", "first", "col_p");
    make_request ("req_a", "col_p");
    auto request = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (request);
    request->order = 1;
    db_->save_request (*request);

    db_->delete_request ("req_a");
    auto [status, created] = routes::create_collection_response (
    *db_, json{ { "name", "second" }, { "parentId", "col_p" } });
    ASSERT_EQ (status, 200) << created.dump ();
    EXPECT_EQ (created["order"], 1) << "the trashed request's slot is free";
    ASSERT_HAS_VALUE (db_->restore_deleted ("req_a"));

    const auto restored = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (restored);
    EXPECT_EQ (restored->order, 1);

    const std::vector<Collection> collections = db_->get_collections ();
    std::vector<const Collection*> folders;
    for (const auto& c : collections) {
        if (c.parent_id == "col_p") {
            folders.push_back (&c);
        }
    }
    const std::vector<Request> requests =
    db_->get_requests_in_collection ("col_p");
    std::vector<std::string> listed;
    for (const auto& slot : merge_siblings (folders, requests)) {
        listed.push_back (slot.kind == SiblingKind::Folder ?
        folders.at (slot.index)->id :
        requests.at (slot.index).id);
    }
    EXPECT_EQ (listed,
    (std::vector<std::string>{ "col_f", created["id"].get<std::string> (), "req_a" }));
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

/// How many `collections` rows, trashed ones included, mention @p text in
/// either file binding - read past every filter `Database` applies.
int64_t rows_binding (const std::string& text) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (TEST_DB_PATH, &handle) != SQLITE_OK) {
        sqlite3_close (handle);
        ADD_FAILURE () << "could not open " << TEST_DB_PATH;
        return -1;
    }
    sqlite3_stmt* stmt = nullptr;
    int64_t count      = -1;
    if (sqlite3_prepare_v2 (handle,
        "SELECT COUNT(*) FROM collections WHERE instr(spec_file, ?1) > 0 OR "
        "instr(data_file, ?1) > 0",
        -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text (stmt, 1, text.c_str (), -1, SQLITE_TRANSIENT);
        if (sqlite3_step (stmt) == SQLITE_ROW) {
            count = sqlite3_column_int64 (stmt, 0);
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return count;
}

// A purge takes the row and the bindings on it (#2765): nothing is left that
// names the files. Mutation check: skip the collection rows in
// `purge_collection_locked` and the counts stay at one.
TEST_F (TrashTest, PurgeLeavesNoFileBindingBehind) {
    make_collection ("col_1", "API");
    auto [status, body] = routes::update_collection_response (*db_, "col_1",
    json{ { "specFile", { { "path", "/specs/pets.yaml" }, { "fileName", "pets.yaml" } } },
    { "dataFile", { { "path", "/data/users.csv" }, { "fileName", "users.csv" } } } });
    ASSERT_EQ (status, 200) << body.dump ();
    db_->delete_collection ("col_1");
    ASSERT_EQ (rows_binding ("pets.yaml"), 1)
    << "the trashed row still holds it";
    ASSERT_EQ (rows_binding ("users.csv"), 1)
    << "the trashed row still holds it";

    ASSERT_HAS_VALUE (db_->purge_deleted ("col_1"));

    EXPECT_EQ (rows_binding ("pets.yaml"), 0);
    EXPECT_EQ (rows_binding ("users.csv"), 0);
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

TEST_F (TrashTest, PurgeNeverTakesALiveRow) {
    make_collection ("col_parent", "Parent");
    db_->delete_collection ("col_parent");
    // The state #1883's write-side refusal now prevents, seeded directly: a
    // live collection (with a live request and a live child) under a stamped
    // one, plus a separately deleted collection under the live one.
    make_collection ("col_live", "Live", "col_parent");
    make_request ("req_live", "col_live");
    make_collection ("col_grandchild", "Grandchild", "col_live");
    make_collection ("col_own_root", "Own root", "col_live");
    db_->delete_collection ("col_own_root");

    ASSERT_HAS_VALUE (db_->purge_deleted ("col_parent"));

    auto live = db_->get_collection ("col_live");
    ASSERT_HAS_VALUE (live);
    EXPECT_FALSE (live->parent_id.has_value ())
    << "a live child of a purged collection comes back at the tree root";
    const auto listed = db_->get_collections ();
    EXPECT_TRUE (std::ranges::any_of (
    listed, [] (const Collection& row) { return row.id == "col_live"; }))
    << "and the sidebar's read sees it there";
    EXPECT_TRUE (db_->get_request ("req_live").has_value ());
    auto grandchild = db_->get_collection ("col_grandchild");
    ASSERT_HAS_VALUE (grandchild);
    ASSERT_HAS_VALUE (grandchild->parent_id);
    EXPECT_EQ (*grandchild->parent_id, "col_live");
    EXPECT_TRUE (entry_for ("col_own_root").has_value ())
    << "a stamped row below the live boundary stays its own trash root";
    EXPECT_FALSE (entry_for ("col_parent").has_value ());
}

TEST_F (TrashTest, RetentionNeverTakesALiveRow) {
    make_collection ("col_parent", "Parent");
    db_->delete_collection ("col_parent");
    make_collection ("col_live", "Live", "col_parent");
    auto entry = entry_for ("col_parent");
    ASSERT_HAS_VALUE (entry);

    EXPECT_EQ (db_->purge_expired_trash (30, entry->deleted_at + (31 * DAY_MS)), 1);
    auto live = db_->get_collection ("col_live");
    ASSERT_HAS_VALUE (live);
    EXPECT_FALSE (live->parent_id.has_value ());
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

// The sweep re-checks each expired root before purging it (#2972), so every
// kind must pass that check. Mutation check: answer false from
// `still_trashed` for any one kind and that root is left behind.
TEST_F (TrashTest, RetentionPurgesEveryExpiredRootOfEveryKind) {
    make_collection ("col_1", "API");
    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_1", "col_2");
    make_collection ("col_3", "Other");
    make_collection ("col_live", "Live");
    make_request ("req_2", "col_live");
    make_request ("req_owner", "col_live");
    make_user_example ("ex_1", "req_owner");
    make_environment ("env_1");

    db_->delete_collection ("col_1");
    db_->delete_collection ("col_3");
    db_->delete_request ("req_2");
    db_->delete_request_example ("ex_1");
    db_->delete_environment ("env_1");
    ASSERT_EQ (db_->get_trash ().size (), 5U);

    int64_t newest = 0;
    for (const auto& entry : db_->get_trash ()) {
        newest = std::max (newest, entry.deleted_at);
    }
    EXPECT_EQ (db_->purge_expired_trash (30, newest + (31 * DAY_MS)), 5);
    EXPECT_TRUE (db_->get_trash ().empty ());
    EXPECT_FALSE (db_->get_request ("req_1").has_value ());
    EXPECT_TRUE (db_->get_request ("req_owner").has_value ());
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

// ---------------------------------------------------------------------------
// Environments (#2970): no owner, no cohort, no re-parent - and never active
// while in the trash
// ---------------------------------------------------------------------------

/// How many rows of @p table carry @p id, stamped ones included - read past
/// every filter `Database` applies, so a purge is seen to remove the row.
int64_t stored_rows (const std::string& table, const std::string& id) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (TEST_DB_PATH, &handle) != SQLITE_OK) {
        sqlite3_close (handle);
        ADD_FAILURE () << "could not open " << TEST_DB_PATH;
        return -1;
    }
    sqlite3_stmt* stmt    = nullptr;
    int64_t count         = -1;
    const std::string sql = "SELECT COUNT(*) FROM " + table + " WHERE id = ?1";
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text (stmt, 1, id.c_str (), -1, SQLITE_TRANSIENT);
        if (sqlite3_step (stmt) == SQLITE_ROW) {
            count = sqlite3_column_int64 (stmt, 0);
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return count;
}

// Mutation check: drop the `is_null (deleted_at)` filter from
// `get_environment` and every read below finds the row again.
TEST_F (TrashTest, ADeletedEnvironmentIsAbsentFromEveryReadSurface) {
    make_environment ("env_1", R"({"host":{"value":"a.test","enabled":true}})");
    make_environment ("env_2");

    auto [deleted_status, deleted_body] =
    routes::delete_environment_response (*db_, "env_1");
    ASSERT_EQ (deleted_status, 200) << deleted_body.dump ();
    EXPECT_EQ (deleted_body, (json{ { "success", true } }));

    EXPECT_FALSE (db_->get_environment ("env_1").has_value ());
    EXPECT_EQ (served_environment ("env_1"), "");
    EXPECT_EQ (db_->get_environments ().size (), 1U)
    << "the live one is still listed";
    EXPECT_EQ (stored_rows ("environments", "env_1"), 1)
    << "stamped, not removed";

    auto [put_status, put_body] =
    routes::update_environment_response (*db_, "env_1", json{ { "name", "Back" } });
    EXPECT_EQ (put_status, 404);
    EXPECT_EQ (error_field (put_body, "message"), "Environment not found");
    auto [again_status, again_body] = routes::delete_environment_response (*db_, "env_1");
    EXPECT_EQ (again_status, 404) << "a second delete finds nothing live";
    EXPECT_EQ (error_field (again_body, "message"), "Environment not found");
    auto [export_status, export_body] = routes::export_postman_environment_response (
    *db_, json{ { "environmentId", "env_1" } });
    EXPECT_EQ (export_status, 404);
    EXPECT_EQ (error_field (export_body, "message"), "Environment not found");
}

TEST_F (TrashTest, ADeletedEnvironmentIsARootCountingItsVariables) {
    // Two variables as every reader sees them; the bare string is no variable
    // to `parse_variables`, so it is not counted either.
    make_environment ("env_1",
    R"({"host":{"value":"a.test","enabled":true},"token":{"value":"t","enabled":false},"junk":"bare"})");
    db_->delete_environment ("env_1");

    auto entry = entry_for ("env_1");
    ASSERT_HAS_VALUE (entry);
    EXPECT_EQ (entry->kind, "environment");
    EXPECT_EQ (entry->name, "Env env_1");
    EXPECT_GT (entry->deleted_at, 0);
    EXPECT_FALSE (entry->parent_id.has_value ());
    EXPECT_EQ (entry->collections, 0);
    EXPECT_EQ (entry->requests, 0);
    ASSERT_HAS_VALUE (entry->variables);
    EXPECT_EQ (*entry->variables, 2);
}

// `variables` is an environment's alone: a collection or request entry carries
// no such key, not a 0 a client would render as "0 variables".
TEST_F (TrashTest, TheListRouteCarriesAnEnvironmentsVariablesAndOnlyThere) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_collection ("col_2", "Other");
    make_environment ("env_1", R"({"host":{"value":"a.test","enabled":true}})");
    db_->delete_request ("req_1");
    db_->delete_collection ("col_2");
    db_->delete_environment ("env_1");

    const auto body = routes::trash_list_body (*db_);
    ASSERT_EQ (body["total"], 3);
    int environments = 0;
    for (const auto& item : body["items"]) {
        if (item["kind"] == "environment") {
            ++environments;
            EXPECT_EQ (item["id"], "env_1");
            EXPECT_EQ (item["name"], "Env env_1");
            EXPECT_TRUE (item["parentId"].is_null ());
            EXPECT_EQ (item["collections"], 0);
            EXPECT_EQ (item["requests"], 0);
            EXPECT_EQ (item["variables"], 1);
            EXPECT_GT (item["deletedAt"].get<int64_t> (), 0);
        } else {
            EXPECT_FALSE (item.contains ("variables")) << item.dump ();
        }
    }
    EXPECT_EQ (environments, 1);
}

// Mutation check: make `delete_environment` remove the row again and the
// restore is a 404.
TEST_F (TrashTest, RestoringAnEnvironmentServesItByteForByteAsBefore) {
    make_environment ("env_1",
    R"({"host":{"value":"a.test","enabled":true,"secret":false,"type":"string","createdAt":7}})");
    const std::string before = served_environment ("env_1");
    ASSERT_NE (before, "");
    db_->delete_environment ("env_1");

    auto [status, body] = routes::trash_restore_response (*db_, "env_1");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["kind"], "environment");
    EXPECT_EQ (body["variables"], 1);
    EXPECT_TRUE (body["restored"].get<bool> ());
    EXPECT_FALSE (body["reparentedToRoot"].get<bool> ());

    EXPECT_EQ (served_environment ("env_1"), before);
    EXPECT_FALSE (entry_for ("env_1").has_value ()) << "it has left the trash";
}

TEST_F (TrashTest, TrashingTheActiveEnvironmentClearsItAndRestoreDoesNotTakeItBack) {
    make_environment ("env_dev", "{}", /*is_active=*/true);
    make_environment ("env_prod");
    db_->delete_environment ("env_dev");

    const auto active_ids = [this] {
        std::vector<std::string> ids;
        for (const auto& env : db_->get_environments ()) {
            if (env.is_active) {
                ids.push_back (env.id);
            }
        }
        return ids;
    };
    EXPECT_TRUE (active_ids ().empty ())
    << "a trashed environment is never active";

    make_environment ("env_prod", "{}", /*is_active=*/true);
    EXPECT_EQ (active_ids (), std::vector<std::string>{ "env_prod" });

    ASSERT_HAS_VALUE (db_->restore_deleted ("env_dev"));
    auto restored = db_->get_environment ("env_dev");
    ASSERT_HAS_VALUE (restored);
    EXPECT_FALSE (restored->is_active)
    << "activating it is the client's choice";
    EXPECT_EQ (active_ids (), std::vector<std::string>{ "env_prod" });
}

TEST_F (TrashTest, PurgingAnEnvironmentRemovesTheRow) {
    make_environment ("env_1", R"({"host":{"value":"a.test","enabled":true}})");
    db_->delete_environment ("env_1");

    auto [status, body] = routes::trash_purge_response (*db_, "env_1");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["kind"], "environment");
    EXPECT_EQ (body["variables"], 1);
    EXPECT_TRUE (body["purged"].get<bool> ());

    EXPECT_EQ (stored_rows ("environments", "env_1"), 0);
    EXPECT_TRUE (db_->get_trash ().empty ());
    auto [restore_status, restore_body] = routes::trash_restore_response (*db_, "env_1");
    EXPECT_EQ (restore_status, 404) << "nothing left to restore";
}

TEST_F (TrashTest, RestoringOrPurgingALiveEnvironmentIsA404) {
    make_environment ("env_1");

    EXPECT_EQ (routes::trash_restore_response (*db_, "env_1").first, 404);
    EXPECT_EQ (routes::trash_purge_response (*db_, "env_1").first, 404);
    EXPECT_EQ (stored_rows ("environments", "env_1"), 1)
    << "a mistyped id destroys nothing";
    EXPECT_TRUE (db_->get_environment ("env_1").has_value ());
}

// Mutation check: drop the environment branch from `purge_trash_entry_locked`
// and the sweep throws on the first expired environment.
TEST_F (TrashTest, RetentionPurgesAnEnvironmentPastTheWindowAndLeavesALiveOne) {
    make_environment ("env_trashed");
    make_environment ("env_live");
    db_->delete_environment ("env_trashed");
    auto entry = entry_for ("env_trashed");
    ASSERT_HAS_VALUE (entry);

    EXPECT_EQ (db_->purge_expired_trash (30, entry->deleted_at + (29 * DAY_MS)), 0);
    EXPECT_EQ (stored_rows ("environments", "env_trashed"), 1);

    EXPECT_EQ (db_->purge_expired_trash (30, entry->deleted_at + (31 * DAY_MS)), 1);
    EXPECT_EQ (stored_rows ("environments", "env_trashed"), 0);
    EXPECT_TRUE (db_->get_trash ().empty ());
    EXPECT_TRUE (db_->get_environment ("env_live").has_value ());
}

// ---------------------------------------------------------------------------
// Examples (#2971): a user's saved example waits under its live request; an
// imported one is still a tombstone
// ---------------------------------------------------------------------------

/// The `text` an export core answered, or "" (with a failure) on any other
/// answer - the bytes a person would save, searched for an example's marker.
std::string exported_text (const std::pair<int, json>& outcome) {
    if (outcome.first != 200 || !outcome.second.contains ("text")) {
        ADD_FAILURE ()
        << "export answered " << outcome.first << ": " << outcome.second.dump ();
        return {};
    }
    return outcome.second["text"].get<std::string> ();
}

// Mutation check: drop `is_null (deleted_at)` from `live_examples_of` and the
// list, count, mock and export assertions find the row again; drop it from
// `get_request_example` and the PUT and second DELETE answer 200.
TEST_F (TrashTest, ADeletedUserExampleIsAbsentFromEveryReadSurface) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_kept", "req_1");
    make_user_example ("exa_gone", "req_1");

    auto [deleted_status, deleted_body] =
    routes::delete_request_example_response (*db_, "req_1", "exa_gone");
    ASSERT_EQ (deleted_status, 200) << deleted_body.dump ();
    EXPECT_EQ (stored_rows ("request_examples", "exa_gone"), 1)
    << "stamped, not removed";

    EXPECT_EQ (served_example ("req_1", "exa_gone"), "");
    EXPECT_NE (served_example ("req_1", "exa_kept"), "")
    << "the live one is still listed";
    EXPECT_EQ (db_->count_request_examples ("req_1"), 1);
    EXPECT_FALSE (db_->get_request_example ("exa_gone").has_value ());

    auto [put_status, put_body] = routes::update_request_example_response (
    *db_, "req_1", "exa_gone", json{ { "name", "back" } });
    EXPECT_EQ (put_status, 404);
    EXPECT_EQ (error_field (put_body, "message"), "Example not found");
    auto [again_status, again_body] =
    routes::delete_request_example_response (*db_, "req_1", "exa_gone");
    EXPECT_EQ (again_status, 404) << "a second delete finds nothing live";
    EXPECT_EQ (error_field (again_body, "message"), "Example not found");

    const auto mock_routes = vayu::http::build_mock_routes (*db_, "col_1");
    ASSERT_EQ (mock_routes.size (), 1U);
    ASSERT_EQ (mock_routes[0].examples.size (), 1U);
    EXPECT_EQ (mock_routes[0].examples[0].id, "exa_kept");

    const std::string postman = exported_text (
    routes::export_postman_response (*db_, json{ { "collectionId", "col_1" } }));
    EXPECT_NE (postman.find ("exa_kept"), std::string::npos);
    EXPECT_EQ (postman.find ("exa_gone"), std::string::npos);

    const std::string spec = exported_text (
    routes::export_spec_response (*db_, json{ { "collectionId", "col_1" } }));
    EXPECT_NE (spec.find ("exa_kept"), std::string::npos);
    EXPECT_EQ (spec.find ("exa_gone"), std::string::npos);
}

// Regression for the branch #2971 left alone: an imported example is a spec
// sync's tombstone (#722), never a trash entry a restore could bring back
// under a document that dropped it.
TEST_F (TrashTest, DeletingAnImportedExampleStillTombstonesItOutsideTheTrash) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_example ("exa_imported", "req_1");

    auto [status, body] =
    routes::delete_request_example_response (*db_, "req_1", "exa_imported");
    ASSERT_EQ (status, 200) << body.dump ();

    EXPECT_TRUE (db_->get_trash ().empty ());
    const auto tombstones = db_->get_suppressed_request_examples ("req_1");
    ASSERT_EQ (tombstones.size (), 1U);
    EXPECT_EQ (tombstones[0].id, "exa_imported");
    EXPECT_FALSE (tombstones[0].deleted_at.has_value ());
    EXPECT_EQ (routes::trash_restore_response (*db_, "exa_imported").first, 404);
}

TEST_F (TrashTest, ADeletedExampleIsARootNamingItsRequest) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    db_->delete_request_example ("exa_1");

    auto entry = entry_for ("exa_1");
    ASSERT_HAS_VALUE (entry);
    EXPECT_EQ (entry->kind, "example");
    EXPECT_EQ (entry->name, "exa_1");
    EXPECT_GT (entry->deleted_at, 0);
    ASSERT_HAS_VALUE (entry->parent_id);
    EXPECT_EQ (*entry->parent_id, "req_1") << "the request, not the collection";
    EXPECT_EQ (entry->collections, 0);
    EXPECT_EQ (entry->requests, 0);
    EXPECT_FALSE (entry->variables.has_value ());

    const auto body = routes::trash_list_body (*db_);
    ASSERT_EQ (body["total"], 1);
    const auto& item = body["items"][0];
    EXPECT_EQ (item["kind"], "example");
    EXPECT_EQ (item["name"], "exa_1");
    EXPECT_EQ (item["parentId"], "req_1");
    EXPECT_EQ (item["collections"], 0);
    EXPECT_EQ (item["requests"], 0);
    EXPECT_FALSE (item.contains ("variables")) << item.dump ();
}

// Under a trashed request the example is part of what that request's entry
// stands for; once the request is back, the example's own earlier delete is
// a root again - the cohort rule, one level down.
TEST_F (TrashTest, AnExampleUnderATrashedRequestIsListedOnlyThroughTheRequest) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    db_->delete_request_example ("exa_1");
    db_->delete_request ("req_1");

    EXPECT_FALSE (entry_for ("exa_1").has_value ());
    EXPECT_TRUE (entry_for ("req_1").has_value ());

    ASSERT_HAS_VALUE (db_->restore_deleted ("req_1"));
    EXPECT_TRUE (entry_for ("exa_1").has_value ());
    EXPECT_EQ (served_example ("req_1", "exa_1"), "")
    << "restoring the request leaves the example's own delete standing";
}

// A stamped example with no request row at all - nothing purges a request
// without its examples, so this is seeded - has nothing to come back under:
// it is listed nowhere, its restore says why, and a purge by id still clears it.
TEST_F (TrashTest, AnExampleWhoseRequestIsGoneIsUnlistedAndUnrestorable) {
    make_example ("exa_orphan", "req_missing",
    vayu::core::constants::request_example::ORIGIN_USER, int64_t{ 1000 });

    EXPECT_TRUE (db_->get_trash ().empty ());
    auto [status, body] = routes::trash_restore_response (*db_, "exa_orphan");
    EXPECT_EQ (status, 409);
    EXPECT_EQ (error_field (body, "message"),
    "Example 'exa_orphan' cannot be restored on its own - the request it "
    "belongs to is gone");

    EXPECT_EQ (routes::trash_purge_response (*db_, "exa_orphan").first, 200);
    EXPECT_EQ (stored_rows ("request_examples", "exa_orphan"), 0);
}

// Mutation check: make `delete_request_example` remove the row again and the
// restore is a 404.
TEST_F (TrashTest, RestoringAnExampleServesItByteForByteAsBefore) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    const std::string before = served_example ("req_1", "exa_1");
    ASSERT_NE (before, "");
    auto [deleted_status, deleted_body] =
    routes::delete_request_example_response (*db_, "req_1", "exa_1");
    ASSERT_EQ (deleted_status, 200) << deleted_body.dump ();

    auto [status, body] = routes::trash_restore_response (*db_, "exa_1");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["kind"], "example");
    EXPECT_EQ (body["parentId"], "req_1");
    EXPECT_TRUE (body["restored"].get<bool> ());
    EXPECT_FALSE (body["reparentedToRoot"].get<bool> ());

    EXPECT_EQ (served_example ("req_1", "exa_1"), before);
    EXPECT_FALSE (entry_for ("exa_1").has_value ()) << "it has left the trash";
}

// Mutation check: drop the `request_is_absent_locked` refusal from
// `restore_example_locked` and the restore answers 200 under a trashed request.
TEST_F (TrashTest, RestoringAnExampleUnderATrashedRequestIsRefused) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    db_->delete_request_example ("exa_1");
    db_->delete_request ("req_1");

    auto [status, body] = routes::trash_restore_response (*db_, "exa_1");
    EXPECT_EQ (status, 409);
    EXPECT_EQ (error_field (body, "message"),
    "Example 'exa_1' cannot be restored on its own - the request it belongs to "
    "is in the trash, so restore that first");

    EXPECT_EQ (stored_rows ("request_examples", "exa_1"), 1);
    ASSERT_HAS_VALUE (db_->restore_deleted ("req_1"));
    EXPECT_EQ (served_example ("req_1", "exa_1"), "")
    << "the refusal cleared nothing";
    EXPECT_TRUE (entry_for ("exa_1").has_value ());
}

// A delete makes room under `MAX_PER_REQUEST` that a later create may take;
// restoring into a full request would hold more examples than any write path
// allows. Mutation check: drop the cap refusal and the 409 is a 200.
TEST_F (TrashTest, RestoringAnExampleIntoAFullRequestIsRefused) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_trashed", "req_1");
    db_->delete_request_example ("exa_trashed");
    const auto limit = vayu::core::constants::request_example::MAX_PER_REQUEST;
    for (size_t i = 0; i < limit; ++i) {
        make_user_example ("exa_live_" + std::to_string (i), "req_1");
    }

    auto [status, body] = routes::trash_restore_response (*db_, "exa_trashed");
    EXPECT_EQ (status, 409);
    EXPECT_EQ (error_field (body, "message"),
    "Example 'exa_trashed' cannot be restored - its request already holds the "
    "maximum of " +
    std::to_string (limit) + " examples, so delete one first");
    EXPECT_TRUE (entry_for ("exa_trashed").has_value ())
    << "still in the trash";

    db_->delete_request_example ("exa_live_0");
    EXPECT_EQ (routes::trash_restore_response (*db_, "exa_trashed").first, 200)
    << "a trashed example does not count against the cap";
}

TEST_F (TrashTest, RestoringOrPurgingALiveExampleIsA404) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");

    EXPECT_EQ (routes::trash_restore_response (*db_, "exa_1").first, 404);
    EXPECT_EQ (routes::trash_purge_response (*db_, "exa_1").first, 404);
    EXPECT_EQ (stored_rows ("request_examples", "exa_1"), 1)
    << "a mistyped id destroys nothing";
    EXPECT_TRUE (db_->get_request_example ("exa_1").has_value ());
}

// Mutation check: drop the example branch from `purge_trash_entry_locked` and
// the purge throws.
TEST_F (TrashTest, PurgingAnExampleRemovesTheRow) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    db_->delete_request_example ("exa_1");

    auto [status, body] = routes::trash_purge_response (*db_, "exa_1");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["kind"], "example");
    EXPECT_TRUE (body["purged"].get<bool> ());

    EXPECT_EQ (stored_rows ("request_examples", "exa_1"), 0);
    EXPECT_TRUE (db_->get_trash ().empty ());
    EXPECT_EQ (routes::trash_restore_response (*db_, "exa_1").first, 404)
    << "nothing left to restore";
}

// The request and collection purges remove examples by request id, stamp or
// no stamp, so a trashed example never outlives the request it answered.
TEST_F (TrashTest, PurgingTheRequestOrItsCollectionLeavesNoTrashedExample) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    make_user_example ("exa_1", "req_1");
    db_->delete_request_example ("exa_1");
    db_->delete_request ("req_1");
    ASSERT_HAS_VALUE (db_->purge_deleted ("req_1"));
    EXPECT_EQ (stored_rows ("request_examples", "exa_1"), 0);

    make_collection ("col_2", "Nested", "col_1");
    make_request ("req_2", "col_2");
    make_user_example ("exa_2", "req_2");
    db_->delete_request_example ("exa_2");
    db_->delete_collection ("col_1");
    ASSERT_HAS_VALUE (db_->purge_deleted ("col_1"));
    EXPECT_EQ (stored_rows ("request_examples", "exa_2"), 0);
}

// Mutation check: drop the example branch from `purge_trash_entry_locked`
// and the sweep throws on the expired example.
TEST_F (TrashTest, RetentionPurgesAnExamplePastTheWindowAndKeepsARecentOne) {
    make_collection ("col_1", "API");
    make_request ("req_1", "col_1");
    constexpr int64_t DELETED = 1000;
    make_example ("exa_old", "req_1",
    vayu::core::constants::request_example::ORIGIN_USER, DELETED);
    make_example ("exa_recent", "req_1",
    vayu::core::constants::request_example::ORIGIN_USER, DELETED + (20 * DAY_MS));

    EXPECT_EQ (db_->purge_expired_trash (30, DELETED + (31 * DAY_MS)), 1);
    EXPECT_EQ (stored_rows ("request_examples", "exa_old"), 0);
    EXPECT_EQ (stored_rows ("request_examples", "exa_recent"), 1);
    EXPECT_TRUE (entry_for ("exa_recent").has_value ());
}

} // namespace
} // namespace vayu::db
