/**
 * @file tests/examples_route_test.cpp
 * @brief Tests for the saved-example routes nested under a request (issue #481)
 *        and for the cascade that keeps an example from outliving its owner.
 *
 * Focus: examples are the first resource in this schema that is owned by
 * another row, so the two things that can go wrong are ownership and cleanup.
 * Every route proves that a path whose request does not exist answers 404
 * before it looks at anything else, that an example stored under a *different*
 * request is invisible here, and that deleting a request - or the collection
 * above it - takes the examples with it rather than stranding rows no read can
 * reach.
 *
 * Covers the routes' extracted cores in isolation, matching the suite's other
 * route tests (no in-process HTTP server).
 */

#include <gtest/gtest.h>

#include <functional>
#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "competing_writer.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in examples.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json> list_request_examples_response (vayu::db::Database& db,
const std::string& request_id);
std::pair<int, nlohmann::json> create_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> delete_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id);
// The update core with its `before_write` seam - invoked inside the lock scope
// with the merged row staged and immediately before it is written (#1440).
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json,
const std::function<void ()>& before_write);
// Defined in import.cpp - the bulk path that also writes examples.
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

class ExamplesRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_examples_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        seed_request ("req_1");
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /** A request under `col_1`, creating the collection on first use. */
    void seed_request (const std::string& id) {
        if (!db_->get_collection ("col_1")) {
            vayu::db::Collection col;
            col.id         = "col_1";
            col.name       = "API";
            col.order      = 0;
            col.created_at = 1;
            col.updated_at = 1;
            db_->create_collection (col);
        }
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/user";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /** Creates one example through the route core and returns its id. */
    std::string create_example (const std::string& request_id, const json& body) {
        auto [status, response] =
        routes::create_request_example_response (*db_, request_id, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

TEST_F (ExamplesRouteTest, CreateStoresEveryFieldAndDefaultsTheRest) {
    auto [status, body] = routes::create_request_example_response (*db_, "req_1",
    json{ { "name", "200 OK" }, { "status", 201 },
    { "headers",
    json::array ({ { { "key", "Content-Type" }, { "value", "application/json" },
    { "enabled", true } } }) },
    { "body", R"({"id":1})" }, { "contentType", "application/json" } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["requestId"], "req_1");
    EXPECT_EQ (body["name"], "200 OK");
    EXPECT_EQ (body["status"], 201);
    EXPECT_EQ (body["body"], R"({"id":1})");
    EXPECT_EQ (body["contentType"], "application/json");
    ASSERT_TRUE (body["headers"].is_array ());
    EXPECT_EQ (body["headers"][0]["key"], "Content-Type");
    // Engine-owned id, prefixed like every other resource's.
    EXPECT_EQ (body["id"].get<std::string> ().rfind ("exa_", 0), 0u);

    // Absent fields take their defaults rather than being left unset.
    auto [_, defaulted] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "Bare" } });
    EXPECT_EQ (defaulted["status"], 200);
    EXPECT_EQ (defaulted["body"], "");
    EXPECT_EQ (defaulted["contentType"], "");
    EXPECT_TRUE (defaulted["headers"].is_array ());
    EXPECT_TRUE (defaulted["headers"].empty ());
}

TEST_F (ExamplesRouteTest, CreateUnderMissingRequestIs404) {
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_nope", json{ { "name", "x" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Request not found");
}

TEST_F (ExamplesRouteTest, CreateRejectsClientSuppliedId) {
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "id", "exa_mine" }, { "name", "x" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "bad_request");
    // Nothing was written - the rejection is before the insert, not after it.
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);
}

TEST_F (ExamplesRouteTest, CreateRequiresName) {
    auto [status, body] =
    routes::create_request_example_response (*db_, "req_1", json::object ());
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], "Missing required field: name");
}

// A status outside the wire's range is refused rather than clamped: a mock
// server would re-serve whatever is stored, and there is no status line for 700.
TEST_F (ExamplesRouteTest, CreateRejectsImpossibleStatus) {
    for (const int status_code : { 99, 600 }) {
        auto [status, body] = routes::create_request_example_response (
        *db_, "req_1", json{ { "name", "x" }, { "status", status_code } });
        EXPECT_EQ (status, 400) << status_code;
        EXPECT_NE (body["error"]["message"].get<std::string> ().find (
                   "not an HTTP status code"),
        std::string::npos);
    }
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);
}

TEST_F (ExamplesRouteTest, CreateRejectsMalformedHeaders) {
    auto [status, body] = routes::create_request_example_response (*db_, "req_1",
    json{ { "name", "x" }, { "headers", json::array ({ json{ { "key", "A" } } }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find (
               "headers entry at index 0"),
    std::string::npos);
}

// The cap is a refusal, not a truncation: a body silently cut in half would be
// served as if it were what the caller stored.
TEST_F (ExamplesRouteTest, CreateRejectsBodyOverTheCap) {
    const std::string too_big (
    vayu::core::constants::request_example::MAX_BODY_BYTES + 1, 'x');
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "x" }, { "body", too_big } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("over the"),
    std::string::npos);
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);
}

// ---------------------------------------------------------------------------
// Origin (issue #588)
// ---------------------------------------------------------------------------

// The discriminator a spec sync (#627) reads to know which rows it may
// replace. Both halves matter: a create that claims nothing is an import row -
// the honest answer for every writer that predates the column - and a create
// that claims `user` keeps it, because that claim is the whole reason the
// column exists.
TEST_F (ExamplesRouteTest, CreateDefaultsOriginToImportAndKeepsAClaimedUser) {
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "Bare" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["origin"], "import");
    const auto stored_example7 = db_->get_request_example (body["id"]);
    ASSERT_HAS_VALUE (stored_example7);
    EXPECT_EQ (stored_example7->origin, "import");

    auto [saved_status, saved] = routes::create_request_example_response (*db_,
    "req_1", json{ { "name", "Saved from a response" }, { "origin", "user" } });
    ASSERT_EQ (saved_status, 200) << saved.dump ();
    EXPECT_EQ (saved["origin"], "user");
    const auto stored_example6 = db_->get_request_example (saved["id"]);
    ASSERT_HAS_VALUE (stored_example6);
    EXPECT_EQ (stored_example6->origin, "user");
}

// A 400, not a silent fall back to `import`: an absorbed typo would hand a
// user-saved example to the next sync to overwrite, which is the one outcome
// the column exists to prevent.
TEST_F (ExamplesRouteTest, CreateRejectsAnUnknownOrigin) {
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "x" }, { "origin", "spec" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], "Invalid 'origin': must be 'import' or 'user'");
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);

    auto [type_status, type_body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "x" }, { "origin", 7 } });
    EXPECT_EQ (type_status, 400);
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);
}

TEST_F (ExamplesRouteTest, UpdateOriginFollowsTheNullVsAbsentRule) {
    const std::string id =
    create_example ("req_1", json{ { "name", "Saved" }, { "origin", "user" } });

    // Absent keeps it - a rename must not quietly re-file a user's example as
    // an import row that the next sync would then replace.
    auto [renamed_status, renamed] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "Renamed" } });
    ASSERT_EQ (renamed_status, 200) << renamed.dump ();
    EXPECT_EQ (renamed["origin"], "user");

    // Null resets to the default, like every other field with one.
    auto [reset_status, reset_body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "origin", nullptr } });
    ASSERT_EQ (reset_status, 200);
    EXPECT_EQ (reset_body["origin"], "import");

    auto [bad_status, bad_body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "origin", "elsewhere" } });
    EXPECT_EQ (bad_status, 400);
    const auto stored_example5 = db_->get_request_example (id);
    ASSERT_HAS_VALUE (stored_example5);
    EXPECT_EQ (stored_example5->origin, "import");
}

// ---------------------------------------------------------------------------
// Truncated bodies (issue #659 item 2)
// ---------------------------------------------------------------------------

// A mock server answers with a stored example verbatim, so an example saved
// from a capped response is served as if it were whole. The fact has to live on
// the row: it used to live only in the default *name*, which the save dialog
// invites the user to edit, so renaming it erased the disclosure.
TEST_F (ExamplesRouteTest, CreateDefaultsBodyTruncatedToFalseAndKeepsAClaimedTrue) {
    auto [status, body] = routes::create_request_example_response (
    *db_, "req_1", json{ { "name", "Whole" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["bodyTruncated"], false);
    const auto stored_example4 = db_->get_request_example (body["id"]);
    ASSERT_HAS_VALUE (stored_example4);
    EXPECT_FALSE (stored_example4->body_truncated);

    auto [cut_status, cut] = routes::create_request_example_response (*db_, "req_1",
    json{ { "name", "First slice only" }, { "body", "{\"items\":[" },
    { "bodyTruncated", true } });
    ASSERT_EQ (cut_status, 200) << cut.dump ();
    EXPECT_EQ (cut["bodyTruncated"], true);
    const auto stored_example3 = db_->get_request_example (cut["id"]);
    ASSERT_HAS_VALUE (stored_example3);
    EXPECT_TRUE (stored_example3->body_truncated);
}

// The list read is what the Examples panel paints its chip from, so the flag
// has to survive the round trip through storage rather than only the create
// response - the same reason `origin` is asserted on both.
TEST_F (ExamplesRouteTest, ListCarriesBodyTruncatedPerRow) {
    create_example ("req_1", json{ { "name", "Whole" } });
    create_example ("req_1", json{ { "name", "Cut" }, { "bodyTruncated", true } });

    auto [status, body] = routes::list_request_examples_response (*db_, "req_1");
    ASSERT_EQ (status, 200) << body.dump ();
    ASSERT_EQ (body.size (), 2u);
    EXPECT_EQ (body[0]["bodyTruncated"], false);
    EXPECT_EQ (body[1]["bodyTruncated"], true);
}

// Absent keeps, null resets - the same null-vs-absent rule every other
// defaulted field follows. Absent-keeps is the load-bearing half: renaming a
// truncated example must not quietly promote it to a complete one, which is
// exactly the failure the name-suffix disclosure had.
TEST_F (ExamplesRouteTest, UpdateBodyTruncatedFollowsTheNullVsAbsentRule) {
    const std::string id =
    create_example ("req_1", json{ { "name", "Cut" }, { "bodyTruncated", true } });

    auto [renamed_status, renamed] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "Renamed by hand" } });
    ASSERT_EQ (renamed_status, 200) << renamed.dump ();
    EXPECT_EQ (renamed["bodyTruncated"], true);

    auto [reset_status, reset_body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "bodyTruncated", nullptr } });
    ASSERT_EQ (reset_status, 200) << reset_body.dump ();
    EXPECT_EQ (reset_body["bodyTruncated"], false);
    const auto stored_example2 = db_->get_request_example (id);
    ASSERT_HAS_VALUE (stored_example2);
    EXPECT_FALSE (stored_example2->body_truncated);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// Creation order is the list order, and it survives the fact that every row
// here is written in the same millisecond - which is exactly the case
// `created_at` alone cannot break, since the id tiebreak is a lottery. Revert
// `order` to a constant and this fails roughly two runs in three, so it is
// asserted over three rows rather than two.
TEST_F (ExamplesRouteTest, ListIsInCreationOrderAndScopedToTheRequest) {
    seed_request ("req_2");
    const std::string first = create_example ("req_1", json{ { "name", "first" } });
    const std::string second = create_example ("req_1", json{ { "name", "second" } });
    const std::string third = create_example ("req_1", json{ { "name", "third" } });
    create_example ("req_2", json{ { "name", "other request" } });

    auto [status, body] = routes::list_request_examples_response (*db_, "req_1");
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body.size (), 3u)
    << "the sibling request's example must not be listed here";
    EXPECT_EQ (body[0]["id"], first);
    EXPECT_EQ (body[1]["id"], second);
    EXPECT_EQ (body[2]["id"], third);
    // The append is what puts them in that order, not the insertion accident.
    EXPECT_EQ (body[0]["order"], 0);
    EXPECT_EQ (body[2]["order"], 2);
}

// "No examples yet" and "no such request" are different answers, and the app's
// Examples tab shows the first one before anything is imported.
TEST_F (ExamplesRouteTest, ListDistinguishesEmptyFromMissingRequest) {
    auto [empty_status, empty_body] =
    routes::list_request_examples_response (*db_, "req_1");
    EXPECT_EQ (empty_status, 200);
    ASSERT_TRUE (empty_body.is_array ());
    EXPECT_TRUE (empty_body.empty ());

    auto [missing_status, missing_body] =
    routes::list_request_examples_response (*db_, "req_nope");
    EXPECT_EQ (missing_status, 404);
    EXPECT_EQ (missing_body["error"]["message"], "Request not found");
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

TEST_F (ExamplesRouteTest, UpdateIsMergePatch) {
    const std::string id = create_example ("req_1",
    json{ { "name", "Original" }, { "status", 201 }, { "body", "hello" } });

    auto [status, body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["name"], "Renamed");
    // Absent fields keep their stored value...
    EXPECT_EQ (body["status"], 201);
    EXPECT_EQ (body["body"], "hello");

    // ...and an explicit null resets the ones that have a default.
    auto [reset_status, reset_body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "status", nullptr }, { "body", nullptr } });
    ASSERT_EQ (reset_status, 200);
    EXPECT_EQ (reset_body["status"], 200);
    EXPECT_EQ (reset_body["body"], "");
}

TEST_F (ExamplesRouteTest, UpdateMissingExampleIs404NotACreate) {
    auto [status, body] = routes::update_request_example_response (
    *db_, "req_1", "exa_nope", json{ { "name", "x" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Example not found");
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);
}

// The nesting is the ownership check, not decoration: an example reached
// through the wrong request must not be readable or writable there.
TEST_F (ExamplesRouteTest, ExampleOfAnotherRequestIsInvisible) {
    seed_request ("req_2");
    const std::string id = create_example ("req_2", json{ { "name", "theirs" } });

    auto [update_status, update_body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "stolen" } });
    EXPECT_EQ (update_status, 404);
    EXPECT_EQ (update_body["error"]["message"], "Example not found");

    auto [delete_status, _] = routes::delete_request_example_response (*db_, "req_1", id);
    EXPECT_EQ (delete_status, 404);

    // Still stored, still named what its owner called it.
    auto stored = db_->get_request_example (id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->name, "theirs");
}

TEST_F (ExamplesRouteTest, UpdateRejectsMismatchedBodyId) {
    const std::string id = create_example ("req_1", json{ { "name", "x" } });
    auto [status, body]  = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "id", "exa_other" }, { "name", "y" } });
    EXPECT_EQ (status, 400);
    const auto stored_example = db_->get_request_example (id);
    ASSERT_HAS_VALUE (stored_example);
    EXPECT_EQ (stored_example->name, "x");
}

// ---------------------------------------------------------------------------
// Delete and the cascades
// ---------------------------------------------------------------------------

TEST_F (ExamplesRouteTest, DeleteRemovesAUserSavedRowOutright) {
    const std::string id =
    create_example ("req_1", json{ { "name", "x" }, { "origin", "user" } });

    auto [status, body] = routes::delete_request_example_response (*db_, "req_1", id);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["id"], id);
    EXPECT_FALSE (db_->get_request_example (id).has_value ());
    // Nothing can re-create a saved response, so there is no intent to record
    // and no tombstone to leave behind (issue #722).
    EXPECT_TRUE (db_->get_suppressed_request_examples ("req_1").empty ());

    // A second delete is a 404 rather than a silent success.
    auto [again, _] = routes::delete_request_example_response (*db_, "req_1", id);
    EXPECT_EQ (again, 404);
}

// Issue #722. The row stays as a tombstone so a later spec sync knows not to
// write the status back - and every read has to behave as though it were gone,
// or a delete that "worked" would still be visible in the panel and served by a
// mock. Mutation check: delete the origin branch in
// `delete_request_example_response` and the tombstone assertion reddens; drop
// the `suppressed` filter from either `Database` read and the first three do.
TEST_F (ExamplesRouteTest, DeletingAnImportedExampleLeavesATombstoneNoReadCanSee) {
    const std::string id = create_example ("req_1",
    json{ { "name", "404 - Not found" }, { "status", 404 },
    { "body", R"({"error":"gone"})" }, { "contentType", "application/json" } });

    auto [status, body] = routes::delete_request_example_response (*db_, "req_1", id);
    ASSERT_EQ (status, 200) << body.dump ();

    auto [list_status, listed] = routes::list_request_examples_response (*db_, "req_1");
    ASSERT_EQ (list_status, 200);
    EXPECT_TRUE (listed.empty ());
    EXPECT_FALSE (db_->get_request_example (id).has_value ());
    EXPECT_EQ (db_->count_request_examples ("req_1"), 0);

    // An update cannot bring it back by writing over the tombstone.
    auto [update_status, _] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "back" } });
    EXPECT_EQ (update_status, 404);

    // What is kept is the status - the identity a sync matches on - and not the
    // body, which no reader of a deleted example ever wants.
    const auto tombstones = db_->get_suppressed_request_examples ("req_1");
    ASSERT_EQ (tombstones.size (), 1u);
    EXPECT_EQ (tombstones[0].id, id);
    EXPECT_EQ (tombstones[0].status, 404);
    EXPECT_TRUE (tombstones[0].body.empty ());
    EXPECT_TRUE (tombstones[0].content_type.empty ());
}

// Without the cascade these rows survive their owner: every read is by request
// id, so nothing could ever list them and no later delete could find them.
TEST_F (ExamplesRouteTest, DeletingTheRequestDeletesItsExamples) {
    seed_request ("req_2");
    const std::string mine = create_example ("req_1", json{ { "name", "mine" } });
    const std::string theirs = create_example ("req_2", json{ { "name", "theirs" } });

    // A tombstone is a row like any other, so the cascade has to take it too -
    // otherwise a deleted imported example outlives the request it answered
    // (issue #722).
    const std::string tombstoned =
    create_example ("req_1", json{ { "name", "deleted" } });
    routes::delete_request_example_response (*db_, "req_1", tombstoned);
    ASSERT_EQ (db_->get_suppressed_request_examples ("req_1").size (), 1u);

    // Deleting a request is soft since issue #988, so the examples go with it in
    // the sense that matters: every route reaching them checks the owner first,
    // and the owner is unreadable. They are removed for good by the purge.
    db_->delete_request ("req_1");

    EXPECT_EQ (routes::list_request_examples_response (*db_, "req_1").first, 404);
    // The sibling request's examples are untouched.
    EXPECT_TRUE (db_->get_request_example (theirs).has_value ());

    db_->purge_deleted ("req_1");

    EXPECT_FALSE (db_->get_request_example (mine).has_value ());
    EXPECT_TRUE (db_->get_suppressed_request_examples ("req_1").empty ());
    EXPECT_TRUE (db_->get_request_example (theirs).has_value ());
}

TEST_F (ExamplesRouteTest, DeletingTheCollectionDeletesEveryDescendantsExamples) {
    seed_request ("req_2");
    const std::string a = create_example ("req_1", json{ { "name", "a" } });
    const std::string b = create_example ("req_2", json{ { "name", "b" } });

    db_->delete_collection ("col_1");

    // Unreachable while the collection is in the trash (issue #988) - both
    // requests answer 404 through the owner check - and gone once it is purged.
    EXPECT_EQ (routes::list_request_examples_response (*db_, "req_1").first, 404);
    EXPECT_EQ (routes::list_request_examples_response (*db_, "req_2").first, 404);

    db_->purge_deleted ("col_1");

    EXPECT_FALSE (db_->get_request_example (a).has_value ());
    EXPECT_FALSE (db_->get_request_example (b).has_value ());
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

// The import path is the only writer of examples today, so its atomicity is
// the property that matters: a rejected example must take the whole payload
// with it, not leave a request behind with half its responses.
TEST_F (ExamplesRouteTest, ImportApplyWritesNestedExamples) {
    auto [status, body] = routes::import_apply_response (*db_,
    json{ { "collections", json::array ({ json{ { "tempId", "c1" }, { "name", "Imported" } } }) },
    { "requests",
    json::array ({ json{ { "tempId", "r1" }, { "collectionTempId", "c1" },
    { "name", "Get user" }, { "method", "GET" }, { "url", "https://example.test/user" },
    { "examples",
    json::array ({ json{ { "name", "200 OK" }, { "status", 200 }, { "body", R"({"ok":true})" } },
    json{ { "name", "404" }, { "status", 404 } } }) } } }) } });

    ASSERT_EQ (status, 200) << body.dump ();
    const std::string request_id = body["idMap"]["r1"];
    // Examples are not in the idMap - nothing references them, so they carry no
    // temp id to map back.
    EXPECT_EQ (body["idMap"].size (), 2u);

    // Payload order is preserved. Every row here is written with the same
    // `now`, so without the per-index `order` the list comes back shuffled by
    // the id tiebreak - and "the first example" is what a mock server serves.
    auto stored = db_->get_request_examples (request_id);
    ASSERT_EQ (stored.size (), 2u);
    EXPECT_EQ (stored[0].name, "200 OK");
    EXPECT_EQ (stored[0].body, R"({"ok":true})");
    EXPECT_EQ (stored[1].status, 404);
    // Bulk import claims no origin, so both rows are import rows - which is
    // what they are. The single route and this one share the applier, so this
    // is the assertion that keeps the two paths from disagreeing about it.
    EXPECT_EQ (stored[0].origin, "import");
    EXPECT_EQ (stored[1].origin, "import");
}

TEST_F (ExamplesRouteTest, ImportApplyRejectsABadExampleAndWritesNothing) {
    auto [status, body] = routes::import_apply_response (*db_,
    json{ { "collections", json::array ({ json{ { "tempId", "c1" }, { "name", "Imported" } } }) },
    { "requests",
    json::array ({ json{ { "tempId", "r1" }, { "collectionTempId", "c1" },
    { "name", "Get user" }, { "method", "GET" }, { "url", "https://example.test/user" },
    { "examples", json::array ({ json{ { "status", 200 } } }) } } }) } });

    EXPECT_EQ (status, 400);
    // The failure names the request item it came from, like every other
    // per-item import error.
    EXPECT_EQ (body["error"]["item"], "r1");
    // Nothing from the payload landed - only the fixture's own collection is
    // stored, so neither the request nor its first (valid) example was written.
    const auto collections = db_->get_collections ();
    ASSERT_EQ (collections.size (), 1u);
    EXPECT_EQ (collections[0].id, "col_1");
}

/**
 * The update core's read, merge and write are one lock scope (#1440), so two
 * PUTs to one example naming different fields both land. Merge-patch is what
 * makes an unheld read destructive: the write carries the fields the body never
 * named, so the loser's change is overwritten with a value nobody sent.
 *
 * The second writer runs from inside the first one's scope through the
 * `before_write` seam and is given a window to finish (`competing_writer.hpp`).
 * Mutation check: drop the `with_lock` and the `status` assertion reds.
 */
TEST_F (ExamplesRouteTest, AConcurrentExampleUpdateWaitsAndKeepsBothFieldsWritten) {
    const std::string id = create_example ("req_1", json{ { "name", "Saved" } });

    int other_status = 0;
    json other_body;
    vayu::tests::CompetingWriter other ([&] {
        auto result = routes::update_request_example_response (
        *db_, "req_1", id, json{ { "status", 404 } });
        other_status = result.first;
        other_body   = result.second;
    });

    auto [status, body] = routes::update_request_example_response (
    *db_, "req_1", id, json{ { "name", "Renamed" } }, other.probe ());
    ASSERT_EQ (status, 200) << body.dump ();
    other.join ();
    ASSERT_EQ (other_status, 200) << other_body.dump ();

    const auto stored = db_->get_request_example (id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->name, "Renamed");
    EXPECT_EQ (stored->status, 404)
    << "the status write merged against the row this write had already staged";
}

} // namespace
