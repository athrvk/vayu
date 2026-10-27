/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/trash_listing_cost_test.cpp
 * @brief What listing the trash reads (#2972): the columns an entry shows and
 *        nothing else, in a number of statements set by the tables the trash
 *        spans rather than by how many folders a trashed root holds; and the
 *        request columns a purge reads to remove a trashed root's examples; and
 *        the index the stamped requests are reached through (#3006).
 *
 * Each is observed on the storage's own connection through an auto-extension
 * (`sqlite_auto_extension.hpp`): SQLite's authorizer, which it consults for
 * every column a statement reads as the statement is prepared, and the trace
 * of every statement begun. The index's plan is then read with EXPLAIN QUERY
 * PLAN on a separate handle. No reading depends on the clock.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "optional_assert.hpp"
#include "sqlite_auto_extension.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

namespace vayu::http::routes {
// Defined in trash.cpp.
nlohmann::json trash_list_body (vayu::db::Database& db);
std::pair<int, nlohmann::json>
trash_restore_response (vayu::db::Database& db, const std::string& id);
} // namespace vayu::http::routes

namespace vayu::db {
namespace {

constexpr const char* TEST_DB_PATH = "test_trash_listing_cost.db";

/// A body the size a pasted fixture or a recorded response reaches.
constexpr size_t LARGE_BODY_BYTES = size_t{ 1024 } * 1024;

/// What the storage's connection did while `recording` was set. The callbacks
/// run on whichever thread steps a statement, hence the mutex.
struct StatementLog {
    std::mutex mutex;
    bool recording = false;
    std::vector<std::string> statements;
    /// "table.column", for every column a prepared statement reads.
    std::set<std::string> columns_read;
};

StatementLog& statement_log () {
    static StatementLog log;
    return log;
}

int record_statement (unsigned type, void* /*context*/, void* /*statement*/, void* sql) {
    auto& log = statement_log ();
    const std::lock_guard<std::mutex> lock (log.mutex);
    if (type != SQLITE_TRACE_STMT || !log.recording) {
        return 0;
    }
    const std::string text = static_cast<const char*> (sql);
    // A trigger's statements are reported again with a leading "--"; they are
    // not statements the caller ran.
    if (!text.starts_with ("--")) {
        log.statements.push_back (text);
    }
    return 0;
}

int record_column_read (void* /*context*/,
int action,
const char* table,
const char* column,
const char* /*database*/,
const char* /*trigger*/) {
    auto& log = statement_log ();
    const std::lock_guard<std::mutex> lock (log.mutex);
    if (action == SQLITE_READ && log.recording && table != nullptr && column != nullptr) {
        log.columns_read.insert (std::string (table) + "." + column);
    }
    return SQLITE_OK;
}

int install_statement_log (sqlite3* db, char** /*error*/, const sqlite3_api_routines* /*api*/) {
    const int rc = sqlite3_trace_v2 (db, SQLITE_TRACE_STMT, &record_statement, nullptr);
    if (rc != SQLITE_OK) {
        return rc;
    }
    return sqlite3_set_authorizer (db, &record_column_read, nullptr);
}

/// What one call did on the storage's connection.
struct Recorded {
    std::vector<std::string> statements;
    std::set<std::string> columns_read;

    /// The statements one per line, for a failure message.
    std::string listing () const {
        std::string joined;
        for (const auto& sql : statements) {
            joined += "\n  " + sql;
        }
        return joined;
    }
};

template <typename Call> Recorded record (const Call& call) {
    auto& log = statement_log ();
    {
        const std::lock_guard<std::mutex> lock (log.mutex);
        log.statements.clear ();
        log.columns_read.clear ();
        log.recording = true;
    }
    call ();
    const std::lock_guard<std::mutex> lock (log.mutex);
    log.recording = false;
    return { log.statements, log.columns_read };
}

/// The four tables the trash spans: collections, requests, environments and
/// request examples.
constexpr size_t TRASH_TABLES = 4;

class TrashListingCostTest : public ::testing::Test {
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

    /// Reopens the database with the statement log on its connection: the
    /// hook lands as a connection opens, and the storage's stays open.
    void reopen_with_statement_log () {
        db_.reset ();
        extension_ =
        std::make_unique<vayu::tests::ScopedAutoExtension> (&install_statement_log);
        ASSERT_EQ (extension_->registered, SQLITE_OK);
        db_ = std::make_unique<Database> (TEST_DB_PATH);
        db_->init ();
    }

    void make_collection (const std::string& id,
    const std::optional<std::string>& parent = std::nullopt) {
        Collection col;
        col.id         = id;
        col.name       = "Folder " + id;
        col.parent_id  = parent;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    void make_request (const std::string& id,
    const std::string& collection_id,
    const std::string& body = "") {
        Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = id;
        r.method        = vayu::HttpMethod::POST;
        r.url           = "https://example.test/" + id;
        r.body          = body;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// A trashed collection holding @p folders folders below it, each with one
    /// request, as one delete leaves it. Each folder hangs under an earlier
    /// one, so the tree is several levels deep as well as wide.
    void trash_a_root_holding (const std::string& root_id, int folders) {
        make_collection (root_id);
        std::vector<std::string> ids{ root_id };
        for (int i = 0; i < folders; ++i) {
            const std::string id = root_id + "_f" + std::to_string (i);
            make_collection (id, ids.at (ids.size () / 2));
            make_request (id + "_req", id);
            ids.push_back (id);
        }
        db_->delete_collection (root_id);
    }

    std::unique_ptr<vayu::tests::ScopedAutoExtension> extension_;
    std::unique_ptr<Database> db_;
};

// Listing a trashed request whose body is a megabyte reads the columns an
// entry shows, never the body, the headers or the elements; nor is a trashed
// example's body read, nor a collection's variables. The allowed set is ids,
// names, owners, stamps and an environment's variables, which its entry
// counts, so a read that widens fails here naming the column. Mutation check:
// list stamped requests with `get_all<Request>` again and `requests.body` is
// read.
TEST_F (TrashListingCostTest, ListingNeverReadsABodyOrAnyColumnAnEntryDoesNotShow) {
    const std::string large (LARGE_BODY_BYTES, 'x');
    make_collection ("col_live");
    make_request ("req_large", "col_live", large);
    db_->delete_request ("req_large");

    make_request ("req_owner", "col_live");
    RequestExample example;
    example.id         = "ex_large";
    example.request_id = "req_owner";
    example.name       = "large";
    example.status     = 200;
    example.headers    = "[]";
    example.body       = large;
    example.origin     = vayu::core::constants::request_example::ORIGIN_USER;
    example.created_at = 1;
    example.updated_at = 1;
    db_->save_request_example (example);
    db_->delete_request_example ("ex_large");

    trash_a_root_holding ("col_root", 3);

    Environment env;
    env.id         = "env_1";
    env.name       = "Staging";
    env.variables  = R"({"a":{"value":"1"}})";
    env.created_at = 1;
    env.updated_at = 1;
    db_->save_environment (env);
    db_->delete_environment ("env_1");

    reopen_with_statement_log ();
    if (HasFatalFailure ()) {
        return;
    }
    nlohmann::json listed;
    const auto recorded =
    record ([&] { listed = vayu::http::routes::trash_list_body (*db_); });

    // What was listed is every kind, so every kind's read is in the record.
    ASSERT_EQ (listed["total"], 4) << listed.dump ();
    // A log that saw nothing passes forever.
    ASSERT_TRUE (recorded.columns_read.contains ("requests.name"))
    << "the authorizer did not see the listing's statements";

    const std::set<std::string> shown{
        "collections.id",
        "collections.name",
        "collections.parent_id",
        "collections.deleted_at",
        "requests.id",
        "requests.name",
        "requests.collection_id",
        "requests.deleted_at",
        "environments.id",
        "environments.name",
        "environments.variables",
        "environments.deleted_at",
        "request_examples.id",
        "request_examples.name",
        "request_examples.request_id",
        "request_examples.deleted_at",
    };
    for (const auto& column : recorded.columns_read) {
        EXPECT_TRUE (shown.contains (column)) << "the listing read " << column;
    }
}

// Purging a trashed collection finds the requests whose examples it removes by
// their ids alone: a request holding a megabyte body, headers and elements is
// destroyed without any of them being read. The allowed set is the columns the
// purge keys on (a request's id and owner, an example's request) plus the stamp
// its outcome's entry is looked up by, so a read that widens fails here naming
// the column. Mutation check: walk the requests with `get_all<Request>` again in
// `purge_collection_locked` and `requests.body` is read.
TEST_F (TrashListingCostTest, PurgeNeverReadsARequestColumnBeyondItsIds) {
    const std::string large (LARGE_BODY_BYTES, 'x');
    make_collection ("col_root");
    make_collection ("col_child", "col_root");
    for (const std::string owner : { "col_root", "col_child" }) {
        Request r;
        r.id            = owner + "_req";
        r.collection_id = owner;
        r.name          = r.id;
        r.method        = vayu::HttpMethod::POST;
        r.url           = "https://example.test/" + r.id;
        r.headers       = R"([{"key":"X-Large","value":")" + large + R"("}])";
        r.body          = large;
        r.elements = R"([{"kind":"script.pre","config":{"source":")" + large + R"("}}])";
        r.created_at = 1;
        r.updated_at = 1;
        db_->save_request (r);

        RequestExample example;
        example.id         = owner + "_ex";
        example.request_id = r.id;
        example.name       = "saved";
        example.status     = 200;
        example.headers    = "[]";
        example.body       = large;
        example.origin = vayu::core::constants::request_example::ORIGIN_USER;
        example.created_at = 1;
        example.updated_at = 1;
        db_->save_request_example (example);
    }
    db_->delete_collection ("col_root");

    reopen_with_statement_log ();
    if (HasFatalFailure ()) {
        return;
    }
    std::optional<TrashOutcome> purged;
    const auto recorded =
    record ([&] { purged = db_->purge_deleted ("col_root"); });

    // The purge took both folders' requests and their examples with them.
    ASSERT_HAS_VALUE (purged);
    EXPECT_EQ (purged->entry.requests, 2);
    EXPECT_FALSE (db_->get_request_example ("col_root_ex").has_value ());
    EXPECT_FALSE (db_->get_request_example ("col_child_ex").has_value ());
    EXPECT_FALSE (db_->get_request ("col_root_req").has_value ());
    EXPECT_FALSE (db_->get_request ("col_child_req").has_value ());

    // A log that saw nothing passes forever.
    ASSERT_TRUE (recorded.columns_read.contains ("requests.collection_id"))
    << "the authorizer did not see the purge's statements";

    const std::set<std::string> allowed{
        "requests.id",
        "requests.collection_id",
        "requests.deleted_at",
        "request_examples.request_id",
    };
    for (const auto& column : recorded.columns_read) {
        const bool of_a_request = column.starts_with ("requests.") ||
        column.starts_with ("request_examples.");
        if (of_a_request) {
            EXPECT_TRUE (allowed.contains (column)) << "the purge read " << column;
        }
    }
}

// A trashed root's counts take no statement per folder: listing a root of 300
// folders runs as many statements as listing a root of one, and no more than
// one per table the trash spans. Healthy: 4 either way. The per-folder shape
// this replaced ran a subtree query and two counts per folder, about 900 for
// 300 folders. Mutation check: count each subtree row with its own
// `count<Request>` again and the 300-folder listing exceeds the bound.
TEST_F (TrashListingCostTest, ListingARootOfThreeHundredFoldersRunsAStatementCountSetByTables) {
    reopen_with_statement_log ();
    if (HasFatalFailure ()) {
        return;
    }
    // The small root alone first, then beside the large one, so the two
    // listings differ only in a root of 300 folders.
    trash_a_root_holding ("col_small", 1);
    std::vector<TrashEntry> small_listing;
    const auto small = record ([&] { small_listing = db_->get_trash (); });
    ASSERT_EQ (small_listing.size (), 1U);

    trash_a_root_holding ("col_large", 300);
    std::vector<TrashEntry> large_listing;
    const auto large = record ([&] { large_listing = db_->get_trash (); });
    ASSERT_EQ (large_listing.size (), 2U);
    for (const auto& entry : large_listing) {
        const int64_t folders = entry.id == "col_large" ? 300 : 1;
        EXPECT_EQ (entry.collections, folders) << entry.id;
        EXPECT_EQ (entry.requests, folders) << entry.id;
    }

    ASSERT_FALSE (small.statements.empty ()) << "the trace saw nothing";
    EXPECT_EQ (large.statements.size (), small.statements.size ()) << large.listing ();
    EXPECT_LE (large.statements.size (), TRASH_TABLES) << large.listing ();
}

/// The plan SQLite chooses for @p sql on a fresh connection to the test
/// database, one `detail` line per row.
std::string query_plan_of (const std::string& sql) {
    sqlite3* handle = nullptr;
    std::string plan;
    if (sqlite3_open (TEST_DB_PATH, &handle) != SQLITE_OK) {
        ADD_FAILURE () << "could not open " << TEST_DB_PATH;
        sqlite3_close (handle);
        return plan;
    }
    sqlite3_stmt* stmt        = nullptr;
    const std::string explain = "EXPLAIN QUERY PLAN " + sql;
    if (sqlite3_prepare_v2 (handle, explain.c_str (), -1, &stmt, nullptr) != SQLITE_OK) {
        ADD_FAILURE () << "could not plan " << sql << ": " << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return plan;
    }
    while (sqlite3_step (stmt) == SQLITE_ROW) {
        plan += column_text (stmt, 3);
        plan += '\n';
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return plan;
}

/// The `CREATE INDEX` text SQLite stored for @p name, empty when it has none.
std::string index_ddl_of (const std::string& name) {
    sqlite3* handle = nullptr;
    std::string ddl;
    if (sqlite3_open (TEST_DB_PATH, &handle) != SQLITE_OK) {
        ADD_FAILURE () << "could not open " << TEST_DB_PATH;
        sqlite3_close (handle);
        return ddl;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text (stmt, 1, name.c_str (), -1, SQLITE_TRANSIENT);
        if (sqlite3_step (stmt) == SQLITE_ROW) {
            ddl = column_text (stmt, 0);
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return ddl;
}

// The listing reaches the stamped requests through `idx_requests_deleted_at`
// rather than walking every request row, whose overflow pages hold a large
// body, to find the few that are stamped (#3006). The statement is the one the
// listing ran, taken from the trace, so a rewrite of its WHERE that the partial
// index no longer covers fails here too. Mutation check: remove the
// `idx_requests_deleted_at` line from `make_vayu_storage` and the plan is a
// SCAN of requests.
TEST_F (TrashListingCostTest, ListingTheStampedRequestsSearchesTheDeletedAtIndex) {
    reopen_with_statement_log ();
    if (HasFatalFailure ()) {
        return;
    }
    make_collection ("col_live");
    make_request ("req_live", "col_live", std::string (LARGE_BODY_BYTES, 'x'));
    make_request ("req_trashed", "col_live", std::string (LARGE_BODY_BYTES, 'x'));
    db_->delete_request ("req_trashed");

    std::vector<TrashEntry> listed;
    const auto recorded = record ([&] { listed = db_->get_trash (); });
    ASSERT_EQ (listed.size (), 1U) << recorded.listing ();

    std::vector<std::string> request_selects;
    for (const auto& sql : recorded.statements) {
        if (sql.starts_with ("SELECT") && sql.contains ("FROM \"requests\"") &&
        sql.contains ("\"deleted_at\" IS NOT NULL")) {
            request_selects.push_back (sql);
        }
    }
    ASSERT_EQ (request_selects.size (), 1U) << recorded.listing ();

    const std::string plan = query_plan_of (request_selects.front ());
    EXPECT_TRUE (plan.contains ("USING INDEX idx_requests_deleted_at")) << plan;
    EXPECT_FALSE (plan.contains ("SCAN")) << plan;

    // Partial is the point: a full index would hold an entry per live request.
    // Mutation check: drop the `where (...)` from the index and this fails.
    const std::string ddl = index_ddl_of ("idx_requests_deleted_at");
    EXPECT_TRUE (ddl.contains ("WHERE")) << ddl;
    EXPECT_TRUE (ddl.contains ("IS NOT NULL")) << ddl;
}

// The listing and a restore count one cohort the same way, from the same
// definition: a row an earlier delete took inside the subtree is in neither,
// and neither is a request under a folder an earlier delete took.
TEST_F (TrashListingCostTest, TheListingAndTheRestoreCountTheSameCohort) {
    make_collection ("col_root");
    make_collection ("col_a", "col_root");
    make_collection ("col_b", "col_a");
    make_collection ("col_early", "col_root");
    make_request ("req_root", "col_root");
    make_request ("req_a", "col_a");
    make_request ("req_b", "col_b");
    make_request ("req_early", "col_root");
    make_request ("req_in_early", "col_early");

    db_->delete_request ("req_early");
    db_->delete_collection ("col_early");
    db_->delete_collection ("col_root");

    std::optional<TrashEntry> listed;
    for (auto& entry : db_->get_trash ()) {
        if (entry.id == "col_root") {
            listed = std::move (entry);
        }
    }
    ASSERT_HAS_VALUE (listed);
    EXPECT_EQ (listed->collections, 2);
    EXPECT_EQ (listed->requests, 3);

    const auto [status, restored] =
    vayu::http::routes::trash_restore_response (*db_, "col_root");
    ASSERT_EQ (status, 200) << restored.dump ();
    EXPECT_EQ (restored["collections"], listed->collections);
    EXPECT_EQ (restored["requests"], listed->requests);
}

} // namespace
} // namespace vayu::db
