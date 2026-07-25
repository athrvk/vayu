/**
 * @file tests/resource_write_route_test.cpp
 * @brief Tests for the create/update verb split and the one null-vs-absent
 *        rule across collections, requests and environments (issue #95).
 *
 * Three things are pinned here, for each of the three resources:
 *
 *  - **POST creates and only creates.** An id that already exists is a 409
 *    naming the PUT path, not a silent update. Before the split, POSTing a
 *    stale or typo'd id merged two records into one - the same upsert that
 *    turned an id collision into data loss.
 *
 *  - **PUT updates and only updates.** A missing id is a 404, not a silent
 *    create.
 *
 *  - **One null-vs-absent rule.** On create, absent and null both mean "use the
 *    default". On update, absent keeps the stored value and null resets it to
 *    the default. A field with no default (`name`, and a request's
 *    `collectionId`/`method`/`url`) rejects null with a 400 rather than
 *    ignoring the write. The environments `variables: null` case is a
 *    regression test: it used to store the literal text `null`.
 *
 * Follows the suite's route-test convention (requests_route_test.cpp): the
 * routes' extracted cores are exercised directly, no in-process HTTP server.
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
// Defined in collections.cpp / requests.cpp / environments.cpp. Each returns
// {http_status, json_body} - the same pair the HTTP handler writes out.
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
std::pair<int, nlohmann::json>
create_environment_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::create_collection_response;
using vayu::http::routes::create_environment_response;
using vayu::http::routes::create_request_response;
using vayu::http::routes::update_collection_response;
using vayu::http::routes::update_environment_response;
using vayu::http::routes::update_request_response;

class ResourceWriteRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_resource_write_route.db";

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
        for (const char* suffix : { "", "-wal", "-shm", ".bak" }) {
            std::error_code ec;
            std::filesystem::remove (std::string (DB_PATH) + suffix, ec);
        }
    }

    /** Creates a collection and returns its id - the parent most tests need. */
    std::string make_collection (const std::string& name = "Parent") {
        auto [status, body] = create_collection_response (*db_, json{ { "name", name } });
        EXPECT_EQ (status, 200);
        return body["id"].get<std::string> ();
    }

    /** Creates a request in `collection_id` and returns its id. */
    std::string make_request (const std::string& collection_id) {
        auto [status, body] = create_request_response (*db_,
        json{ { "collectionId", collection_id }, { "name", "R" },
        { "method", "GET" }, { "url", "https://example.com" } });
        EXPECT_EQ (status, 200);
        return body["id"].get<std::string> ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, CollectionCreateGeneratesIdWhenAbsent) {
    auto [status, body] = create_collection_response (*db_, json{ { "name", "New" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["name"], "New");
    EXPECT_TRUE (body["id"].get<std::string> ().rfind ("col_", 0) == 0)
    << "engine-generated ids carry the resource prefix";
}

TEST_F (ResourceWriteRouteTest, CollectionCreateHonoursClientId) {
    // Still accepted this phase - the import orchestrator pre-assigns ids to
    // wire the tree together before persisting (#96 removes the need).
    auto [status, body] = create_collection_response (
    *db_, json{ { "id", "col_fixed" }, { "name", "New" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["id"], "col_fixed");
}

TEST_F (ResourceWriteRouteTest, CollectionCreateOnExistingIdIsConflict) {
    const std::string id = make_collection ("Original");

    auto [status, body] =
    create_collection_response (*db_, json{ { "id", id }, { "name", "Impostor" } });
    EXPECT_EQ (status, 409);
    EXPECT_NE (body["error"].get<std::string> ().find ("PUT /collections/:id"),
    std::string::npos)
    << "the 409 must point the caller at the update verb";

    // The stored record is untouched - this is the data loss the upsert caused.
    auto stored = db_->get_collection (id);
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->name, "Original");
}

TEST_F (ResourceWriteRouteTest, CollectionCreateRequiresName) {
    auto [status, body] = create_collection_response (*db_, json::object ());
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"].get<std::string> ().find ("name"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateMissingIsNotFound) {
    auto [status, body] =
    update_collection_response (*db_, "col_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"], "Collection not found");
    EXPECT_FALSE (db_->get_collection ("col_does_not_exist").has_value ())
    << "a 404 must not leave a record behind";
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateAppliesPatch) {
    const std::string id = make_collection ("Before");
    auto [status, body] =
    update_collection_response (*db_, id, json{ { "name", "After" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["name"], "After");
    EXPECT_EQ (body["id"], id);
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateAbsentKeepsNullResets) {
    const std::string id = make_collection ();
    ASSERT_EQ (
    update_collection_response (*db_, id,
    json{ { "variables", { { "token", { { "value", "abc" }, { "enabled", true } } } } },
    { "description", "notes" } })
    .first,
    200);

    // Absent -> keep.
    auto [keep_status, keep] =
    update_collection_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (keep_status, 200);
    EXPECT_TRUE (keep["variables"].contains ("token")) << "absent means keep";
    EXPECT_EQ (keep["description"], "notes");

    // Null -> reset to the default.
    auto [reset_status, reset] = update_collection_response (
    *db_, id, json{ { "variables", nullptr }, { "description", nullptr } });
    ASSERT_EQ (reset_status, 200);
    EXPECT_TRUE (reset["variables"].is_object ());
    EXPECT_TRUE (reset["variables"].empty ()) << "null resets variables to {}";
    EXPECT_EQ (reset["description"], "");
}

TEST_F (ResourceWriteRouteTest, CollectionNullNameIsRejected) {
    const std::string id = make_collection ("Keep me");
    // `name` has no default, so null cannot mean "reset" - and silently
    // ignoring it (the old behaviour) hides a broken write from the caller.
    auto [status, body] =
    update_collection_response (*db_, id, json{ { "name", nullptr } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"].get<std::string> ().find ("name"), std::string::npos);
    EXPECT_EQ (db_->get_collection (id)->name, "Keep me");
}

TEST_F (ResourceWriteRouteTest, CollectionCreateNullMeansDefault) {
    auto [status, body] = create_collection_response (*db_,
    json{ { "name", "N" }, { "variables", nullptr }, { "auth", nullptr },
    { "description", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_TRUE (body["variables"].empty ());
    EXPECT_EQ (body["auth"]["mode"], "none");
    EXPECT_EQ (body["description"], "");
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateKeepsCycleGuard) {
    // #79's self-parent / descendant checks land in POST; the verb split must
    // not drop them from the path that actually performs reparenting.
    const std::string parent   = make_collection ("Parent");
    auto [child_status, child] = create_collection_response (
    *db_, json{ { "name", "Child" }, { "parentId", parent } });
    ASSERT_EQ (child_status, 200);
    const std::string child_id = child["id"].get<std::string> ();

    EXPECT_EQ (
    update_collection_response (*db_, parent, json{ { "parentId", parent } }).first, 400)
    << "self-parent";
    EXPECT_EQ (
    update_collection_response (*db_, parent, json{ { "parentId", child_id } }).first, 400)
    << "reparent into a descendant";
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, RequestCreateOnExistingIdIsConflict) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);

    auto [status, body] = create_request_response (*db_,
    json{ { "id", id }, { "collectionId", collection }, { "name", "Impostor" },
    { "method", "POST" }, { "url", "https://evil.example" } });
    EXPECT_EQ (status, 409);
    EXPECT_NE (body["error"].get<std::string> ().find ("PUT /requests/:id"),
    std::string::npos);
    EXPECT_EQ (db_->get_request (id)->name, "R");
}

TEST_F (ResourceWriteRouteTest, RequestCreateRequiresItsNoDefaultFields) {
    const std::string collection = make_collection ();
    for (const char* missing : { "collectionId", "name", "method", "url" }) {
        json body{ { "collectionId", collection }, { "name", "R" },
            { "method", "GET" }, { "url", "https://example.com" } };
        body.erase (missing);
        auto [status, error] = create_request_response (*db_, body);
        EXPECT_EQ (status, 400) << "missing " << missing;
        EXPECT_NE (error["error"].get<std::string> ().find (missing), std::string::npos);
    }
}

TEST_F (ResourceWriteRouteTest, RequestUpdateMissingIsNotFound) {
    auto [status, body] =
    update_request_response (*db_, "req_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"], "Request not found");
    EXPECT_FALSE (db_->get_request ("req_does_not_exist").has_value ());
}

TEST_F (ResourceWriteRouteTest, RequestUpdateAbsentKeepsNullResets) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (
    update_request_response (*db_, id,
    json{ { "headers", json::array ({ { { "key", "X" }, { "value", "1" }, { "enabled", true } } }) },
    { "postRequestScript", "pm.test('x', () => {});" },
    { "followRedirects", false }, { "maxRedirects", 3 } })
    .first,
    200);

    // Absent -> keep. Renaming must not clear the headers or the script.
    auto [keep_status, keep] =
    update_request_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (keep_status, 200);
    EXPECT_EQ (keep["headers"].size (), 1u);
    EXPECT_FALSE (keep["followRedirects"].get<bool> ());
    EXPECT_EQ (keep["maxRedirects"], 3);
    EXPECT_EQ (keep["method"], "GET")
    << "an absent method keeps the stored one";

    // Null -> reset to the default.
    auto [reset_status, reset] = update_request_response (*db_, id,
    json{ { "headers", nullptr }, { "postRequestScript", nullptr },
    { "followRedirects", nullptr }, { "maxRedirects", nullptr } });
    ASSERT_EQ (reset_status, 200);
    EXPECT_TRUE (reset["headers"].empty ());
    EXPECT_EQ (reset["postRequestScript"], "");
    EXPECT_TRUE (reset["followRedirects"].get<bool> ())
    << "the engine default is true";
    EXPECT_EQ (reset["maxRedirects"], 10);
}

TEST_F (ResourceWriteRouteTest, RequestNullNoDefaultFieldIsRejected) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    for (const char* field : { "collectionId", "name", "method", "url" }) {
        auto [status, body] =
        update_request_response (*db_, id, json{ { field, nullptr } });
        EXPECT_EQ (status, 400) << field << ": null on a no-default field";
        EXPECT_NE (body["error"].get<std::string> ().find (field), std::string::npos);
    }
    EXPECT_EQ (db_->get_request (id)->url, "https://example.com");
}

TEST_F (ResourceWriteRouteTest, RequestInvalidMethodIsRejected) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" },
             { "method", "TELEPORT" }, { "url", "https://example.com" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"].get<std::string> ().find ("method"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, RequestMalformedKeyValueEntryIsRejected) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" },
             { "headers", json::array ({ json{ { "key", "X" } } }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"].get<std::string> ().find ("index 0"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, RequestMaxRedirectsIsClamped) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    auto [status, body] =
    update_request_response (*db_, id, json{ { "maxRedirects", 5000 } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["maxRedirects"], 100);
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, EnvironmentCreateOnExistingIdIsConflict) {
    auto [created_status, created] =
    create_environment_response (*db_, json{ { "name", "Original" } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] =
    create_environment_response (*db_, json{ { "id", id }, { "name", "Impostor" } });
    EXPECT_EQ (status, 409);
    EXPECT_NE (body["error"].get<std::string> ().find ("PUT /environments/:id"),
    std::string::npos);
    EXPECT_EQ (db_->get_environment (id)->name, "Original");
}

TEST_F (ResourceWriteRouteTest, EnvironmentUpdateMissingIsNotFound) {
    auto [status, body] =
    update_environment_response (*db_, "env_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"], "Environment not found");
}

TEST_F (ResourceWriteRouteTest, EnvironmentNullVariablesResetsToEmptyObject) {
    // Regression: the handler had no null guard, so `variables: null` was
    // dumped as the literal four-character text `null` - JSON that parses but
    // is not an object, so every reader saw no variables and no error.
    auto [created_status, created] = create_environment_response (*db_,
    json{ { "name", "Env" },
    { "variables", { { "token", { { "value", "abc" }, { "enabled", true } } } } } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] =
    update_environment_response (*db_, id, json{ { "variables", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_TRUE (body["variables"].is_object ());
    EXPECT_TRUE (body["variables"].empty ());

    // The stored blob is `{}`, not the string "null".
    EXPECT_EQ (db_->get_environment (id)->variables, "{}");
}

TEST_F (ResourceWriteRouteTest, EnvironmentCreateNullVariablesIsEmptyObject) {
    auto [status, body] = create_environment_response (
    *db_, json{ { "name", "Env" }, { "variables", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (db_->get_environment (body["id"].get<std::string> ())->variables, "{}");
}

TEST_F (ResourceWriteRouteTest, EnvironmentUpdateHonoursIsActive) {
    // isActive used to be read only on create, so an update could never change
    // it - the asymmetry the issue calls out.
    auto [created_status, created] = create_environment_response (
    *db_, json{ { "name", "Env" }, { "isActive", true } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();
    EXPECT_TRUE (created["isActive"].get<bool> ());

    auto [status, body] =
    update_environment_response (*db_, id, json{ { "isActive", false } });
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["isActive"].get<bool> ());
    EXPECT_FALSE (db_->get_environment (id)->is_active);
}

TEST_F (ResourceWriteRouteTest, EnvironmentUpdateAbsentKeepsVariables) {
    auto [created_status, created] = create_environment_response (*db_,
    json{ { "name", "Env" },
    { "variables", { { "token", { { "value", "abc" }, { "enabled", true } } } } } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] =
    update_environment_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["name"], "Renamed");
    EXPECT_TRUE (body["variables"].contains ("token")) << "absent means keep";
}

TEST_F (ResourceWriteRouteTest, EnvironmentNullNameIsRejected) {
    auto [created_status, created] =
    create_environment_response (*db_, json{ { "name", "Keep me" } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] =
    update_environment_response (*db_, id, json{ { "name", nullptr } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (db_->get_environment (id)->name, "Keep me");
}

} // namespace
