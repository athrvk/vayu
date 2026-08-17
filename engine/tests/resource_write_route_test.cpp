/**
 * @file tests/resource_write_route_test.cpp
 * @brief Tests for the create/update verb split, engine-owned ids, and the one
 *        null-vs-absent rule across collections, requests and environments
 *        (issues #95, #97).
 *
 * Four things are pinned here, for each of the three resources:
 *
 *  - **POST creates and only creates.** Before the split, POSTing a stale or
 *    typo'd id merged two records into one - the same upsert that turned an id
 *    collision into data loss.
 *
 *  - **The engine owns every id** (#97). A create carrying a body `id` is a
 *    400, so the id in the payload can no longer select a record at all -
 *    which is why the collision cases above now assert a 400 rather than the
 *    409 that only a `generate_id` collision could still produce. An update's
 *    identity is the path, so a body `id` disagreeing with it is a 400 rather
 *    than a write to whichever of the two the handler happened to prefer.
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
 *  - **Object-shaped fields reject a wrong shape** (issue #133).
 *    `variables`, `auth` and a request's `body` are dumped JSON blobs.
 *    A non-object used to be dumped verbatim, stored, and then
 *    silently discarded by every reader - `auth` most severely, since
 *    a request the user believed carried credentials went out bare.
 *    Those tests assert the **stored blob**, because a response-only
 *    assertion passes against the old code too.
 *
 * Follows the suite's route-test convention (requests_route_test.cpp): the
 * routes' extracted cores are exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

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
// Defined in requests.cpp - the list serializer, which is separate code from
// the single-request one and has been the half a new field missed before.
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
// Defined in config.cpp - used here only to flip the "defaultHttpVersion"
// global mid-test, proving the httpVersion seed is read live rather than
// baked in at process start.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::apply_config_update;
using vayu::http::routes::create_collection_response;
using vayu::http::routes::create_environment_response;
using vayu::http::routes::create_request_response;
using vayu::http::routes::update_collection_response;
using vayu::http::routes::update_environment_response;
using vayu::http::routes::update_request_response;

/**
 * The exact create-time rejection from routes.hpp. Spelled out here rather than
 * substring-matched: it is the message that tells a client where ids come from
 * and which endpoint to use for a bulk tree, so a reword should show up as a
 * failing test and be made deliberately.
 */
constexpr const char* ENGINE_OWNS_ID =
"id is assigned by the engine; omit it (bulk import: POST /import/apply)";

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
        vayu::tests::remove_database_files (DB_PATH);
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

    /**
     * Values that are valid JSON but not an object - each one used to be dumped
     * into the blob column verbatim. `"bearer"` is the realistic one: an `auth`
     * written as a bare mode string rather than `{"mode":"bearer",...}`.
     */
    static const std::vector<json>& wrong_shapes () {
        static const std::vector<json> values{ json (42), json ("bearer"),
            json::array ({ 1, 2 }), json (true) };
        return values;
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

TEST_F (ResourceWriteRouteTest, CollectionCreateRejectsClientId) {
    auto [status, body] = create_collection_response (
    *db_, json{ { "id", "col_fixed" }, { "name", "New" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], ENGINE_OWNS_ID);
    EXPECT_FALSE (db_->get_collection ("col_fixed").has_value ())
    << "a rejected create must not persist anything";

    // Nothing was created under a generated id either - the whole write is off.
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (ResourceWriteRouteTest, CollectionCreateRejectsNullClientId) {
    // Presence is the trigger: the null-vs-absent rule does not reach `id`,
    // because a caller sending null still believes the field is honoured.
    auto [status, body] =
    create_collection_response (*db_, json{ { "id", nullptr }, { "name", "New" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], ENGINE_OWNS_ID);
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (ResourceWriteRouteTest, CollectionCreateOnExistingIdIsRejected) {
    // The upsert this replaced merged two records into one when the ids
    // collided. There is no route left to that: a body id never reaches the
    // existence check, so the stored record cannot be touched by a create.
    const std::string id = make_collection ("Original");

    auto [status, body] =
    create_collection_response (*db_, json{ { "id", id }, { "name", "Impostor" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], ENGINE_OWNS_ID);

    auto stored = db_->get_collection (id);
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->name, "Original");
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateRejectsMismatchedBodyId) {
    const std::string id = make_collection ("Original");

    auto [status, body] = update_collection_response (
    *db_, id, json{ { "id", "col_somewhere_else" }, { "name", "Renamed" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Body 'id'"),
    std::string::npos);
    EXPECT_EQ (db_->get_collection (id)->name, "Original")
    << "a body id naming another record must not write through the path id";
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateAcceptsMatchingBodyId) {
    // Redundant but not contradictory: the path and the body agree on which
    // record is being written, so there is nothing to guess.
    const std::string id = make_collection ("Original");

    auto [status, body] = update_collection_response (
    *db_, id, json{ { "id", id }, { "name", "Renamed" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["name"], "Renamed");
    EXPECT_EQ (db_->get_collection (id)->name, "Renamed");
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateRejectsNullBodyId) {
    const std::string id = make_collection ("Original");

    auto [status, body] = update_collection_response (
    *db_, id, json{ { "id", nullptr }, { "name", "Renamed" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Body 'id'"),
    std::string::npos);
    EXPECT_EQ (db_->get_collection (id)->name, "Original");
}

TEST_F (ResourceWriteRouteTest, UpdateRejectsBodyIdBeforeLookingTheRecordUp) {
    // The answer to a malformed body must not depend on whether the target
    // exists, or a client debugging a 404 chases the wrong problem.
    auto [status, body] = update_collection_response (
    *db_, "col_does_not_exist", json{ { "id", "col_other" }, { "name", "X" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Body 'id'"),
    std::string::npos);
}

TEST_F (ResourceWriteRouteTest, CollectionCreateRequiresName) {
    auto [status, body] = create_collection_response (*db_, json::object ());
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("name"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, CollectionUpdateMissingIsNotFound) {
    auto [status, body] =
    update_collection_response (*db_, "col_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Collection not found");
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
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("name"), std::string::npos);
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

TEST_F (ResourceWriteRouteTest, CollectionWrongShapeObjectFieldIsRejected) {
    const std::string id = make_collection ();
    ASSERT_EQ (
    update_collection_response (*db_, id,
    json{ { "variables", { { "token", { { "value", "abc" }, { "enabled", true } } } } },
    { "auth", { { "mode", "bearer" }, { "token", "t" } } } })
    .first,
    200);
    const auto before = *db_->get_collection (id);

    for (const char* field : { "variables", "auth", "dataSchema" }) {
        for (const json& bad : wrong_shapes ()) {
            auto [status, body] =
            update_collection_response (*db_, id, json{ { field, bad } });
            EXPECT_EQ (status, 400) << field << " = " << bad.dump ();
            EXPECT_NE (body["error"]["message"].get<std::string> ().find (field),
            std::string::npos)
            << "the 400 must name the field";
        }
    }

    // The stored blobs are what matters: the old helper returned 200 and wrote
    // the junk, so asserting only the response would pass either way.
    const auto after = *db_->get_collection (id);
    EXPECT_EQ (after.variables, before.variables);
    EXPECT_EQ (after.auth, before.auth);
    EXPECT_EQ (after.data_schema, before.data_schema);
}

TEST_F (ResourceWriteRouteTest, CollectionCreateWrongShapeObjectFieldIsRejected) {
    for (const char* field : { "variables", "auth", "dataSchema" }) {
        for (const json& bad : wrong_shapes ()) {
            auto [status, body] = create_collection_response (
            *db_, json{ { "name", "N" }, { field, bad } });
            EXPECT_EQ (status, 400) << field << " = " << bad.dump ();
            EXPECT_NE (body["error"]["message"].get<std::string> ().find (field),
            std::string::npos);
        }
    }
    EXPECT_TRUE (db_->get_collections ().empty ())
    << "a rejected create must not leave a record behind";
}

// --- The declared data contract (issue #599) ---------------------------------

TEST_F (ResourceWriteRouteTest, CollectionDataSchemaRoundTripsAndFollowsTheNullRule) {
    // The whole point of storing the contract on the row: it has to survive the
    // trip, and it has to obey the same null-vs-absent rule as every sibling
    // field, because "Clear" is only expressible as an explicit null.
    auto [create_status, created] = create_collection_response (*db_, json{ { "name", "N" } });
    ASSERT_EQ (create_status, 200);
    const std::string id = created["id"];
    EXPECT_TRUE (created["dataSchema"].is_object ());
    EXPECT_TRUE (created["dataSchema"].empty ()) << "absent on create means no contract";

    const json schema{ { "columns", json::array ({ "id", "email" }) },
        { "declaredAt", 1700000000000 }, { "fileName", "users.csv" } };
    auto [set_status, set] = update_collection_response (*db_, id, json{ { "dataSchema", schema } });
    ASSERT_EQ (set_status, 200);
    EXPECT_EQ (set["dataSchema"], schema);

    // Absent -> keep. A rename must not silently drop the contract.
    auto [keep_status, keep] = update_collection_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (keep_status, 200);
    EXPECT_EQ (keep["dataSchema"], schema) << "absent means keep";

    // Null -> reset to the default, which is "declares no contract".
    auto [clear_status, cleared] =
    update_collection_response (*db_, id, json{ { "dataSchema", nullptr } });
    ASSERT_EQ (clear_status, 200);
    EXPECT_TRUE (cleared["dataSchema"].is_object ());
    EXPECT_TRUE (cleared["dataSchema"].empty ());
    EXPECT_EQ (db_->get_collection (id)->data_schema, "{}");
}

TEST_F (ResourceWriteRouteTest, CollectionDataSchemaContentsAreValidated) {
    // A blob that parses as an object is not yet a schema. Each of these would
    // otherwise be stored and only fail much later - as a refusal message naming
    // things that are not column names, or as a diff no file can satisfy.
    const std::string id = make_collection ();

    const std::vector<std::pair<json, const char*>> bad{
        { json{ { "columns", "id,email" } }, "columns" },
        { json{ { "columns", json::array ({ "id", 7 }) } }, "columns" },
        { json{ { "columns", json::array ({ "id", "" }) } }, "columns" },
        { json{ { "columns", json::array ({ "id", "id" }) } }, "columns" },
        { json{ { "columns", json::array ({ std::string (257, 'x') }) } }, "columns" },
        { json{ { "columns", json::array ({ "id" }) }, { "declaredAt", "yesterday" } },
        "declaredAt" },
        { json{ { "columns", json::array ({ "id" }) }, { "fileName", 7 } }, "fileName" },
    };

    for (const auto& [schema, names] : bad) {
        auto [status, body] = update_collection_response (*db_, id, json{ { "dataSchema", schema } });
        EXPECT_EQ (status, 400) << schema.dump ();
        EXPECT_NE (body["error"]["message"].get<std::string> ().find (names), std::string::npos)
        << body["error"]["message"];
        EXPECT_EQ (db_->get_collection (id)->data_schema, "{}")
        << "a rejected write must store nothing - " << schema.dump ();
    }

    // Over the column-count cap, built rather than listed above.
    json many = json::object ();
    many["columns"] = json::array ();
    for (int i = 0; i <= 1024; ++i) {
        many["columns"].push_back ("c" + std::to_string (i));
    }
    auto [many_status, many_body] =
    update_collection_response (*db_, id, json{ { "dataSchema", many } });
    EXPECT_EQ (many_status, 400);
    EXPECT_NE (many_body["error"]["message"].get<std::string> ().find ("1024"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, CollectionDataSchemaAcceptsAContractWithoutOptionalFields) {
    // `declaredAt` and `fileName` are optional, and an empty object is the
    // canonical "no contract" - neither may be turned into a refusal by the
    // contents check, which only ever looks at what is present.
    for (const json& fine : { json::object (), json{ { "columns", json::array ({ "id" }) } },
             json{ { "columns", json::array () } } }) {
        auto [status, body] =
        create_collection_response (*db_, json{ { "name", "N" }, { "dataSchema", fine } });
        EXPECT_EQ (status, 200) << fine.dump ();
        EXPECT_EQ (body["dataSchema"], fine);
    }
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

TEST_F (ResourceWriteRouteTest, RequestCreateRejectsClientId) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);

    auto [status, body] = create_request_response (*db_,
    json{ { "id", id }, { "collectionId", collection }, { "name", "Impostor" },
    { "method", "POST" }, { "url", "https://evil.example" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], ENGINE_OWNS_ID);
    EXPECT_EQ (db_->get_request (id)->name, "R");
    EXPECT_EQ (db_->get_requests_in_collection (collection).size (), 1U)
    << "a rejected create must not persist a second row under a generated id";
}

TEST_F (ResourceWriteRouteTest, RequestUpdateRejectsMismatchedBodyId) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);

    auto [status, body] = update_request_response (
    *db_, id, json{ { "id", "req_somewhere_else" }, { "name", "Renamed" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Body 'id'"),
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
        EXPECT_NE (error["error"]["message"].get<std::string> ().find (missing),
        std::string::npos);
    }
}

TEST_F (ResourceWriteRouteTest, RequestUpdateMissingIsNotFound) {
    auto [status, body] =
    update_request_response (*db_, "req_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Request not found");
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

// `requests.stream` (issue #574). It follows the redirect policy's contract
// exactly - absent keeps, null resets, a non-boolean is ignored rather than
// rejected - and it is the app's Event stream toggle that persists here, so a
// round trip that silently dropped it would look like a toggle that works until
// the tab is reopened.
TEST_F (ResourceWriteRouteTest, RequestStreamFlagRoundTrips) {
    const std::string collection = make_collection ();

    auto [created_status, created] = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.com/sse" } });
    ASSERT_EQ (created_status, 200);
    EXPECT_FALSE (created["stream"].get<bool> ())
    << "a request is not a stream until it is told it is";
    const std::string id = created["id"].get<std::string> ();

    auto [on_status, on] = update_request_response (*db_, id, json{ { "stream", true } });
    ASSERT_EQ (on_status, 200);
    EXPECT_TRUE (on["stream"].get<bool> ());

    // Absent -> keep. This is the hop the toggle would lose on any other write.
    auto [keep_status, keep] =
    update_request_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (keep_status, 200);
    EXPECT_TRUE (keep["stream"].get<bool> ());

    // Null -> reset to the default.
    auto [reset_status, reset] = update_request_response (*db_, id, json{ { "stream", nullptr } });
    ASSERT_EQ (reset_status, 200);
    EXPECT_FALSE (reset["stream"].get<bool> ());

    // A non-boolean is ignored rather than rejected, like `followRedirects`.
    ASSERT_EQ (update_request_response (*db_, id, json{ { "stream", true } }).first, 200);
    auto [ignored_status, ignored] =
    update_request_response (*db_, id, json{ { "stream", "yes" } });
    ASSERT_EQ (ignored_status, 200);
    EXPECT_TRUE (ignored["stream"].get<bool> ());
}

TEST_F (ResourceWriteRouteTest, RequestNullNoDefaultFieldIsRejected) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    for (const char* field : { "collectionId", "name", "method", "url" }) {
        auto [status, body] =
        update_request_response (*db_, id, json{ { field, nullptr } });
        EXPECT_EQ (status, 400) << field << ": null on a no-default field";
        EXPECT_NE (body["error"]["message"].get<std::string> ().find (field),
        std::string::npos);
    }
    EXPECT_EQ (db_->get_request (id)->url, "https://example.com");
}

TEST_F (ResourceWriteRouteTest, RequestInvalidMethodIsRejected) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" },
             { "method", "TELEPORT" }, { "url", "https://example.com" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("method"),
    std::string::npos);
}

TEST_F (ResourceWriteRouteTest, RequestMalformedKeyValueEntryIsRejected) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" },
             { "headers", json::array ({ json{ { "key", "X" } } }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("index 0"),
    std::string::npos);
}

TEST_F (ResourceWriteRouteTest, RequestWrongShapeObjectFieldIsRejected) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (update_request_response (*db_, id,
               json{ { "body", { { "mode", "raw" }, { "raw", "{}" } } },
               { "auth", { { "mode", "bearer" }, { "token", "t" } } } })
               .first,
    200);
    const auto before = *db_->get_request (id);

    for (const char* field : { "body", "auth" }) {
        for (const json& bad : wrong_shapes ()) {
            auto [status, error] =
            update_request_response (*db_, id, json{ { field, bad } });
            EXPECT_EQ (status, 400) << field << " = " << bad.dump ();
            EXPECT_NE (error["error"]["message"].get<std::string> ().find (field),
            std::string::npos);
        }
    }

    const auto after = *db_->get_request (id);
    EXPECT_EQ (after.body, before.body);
    EXPECT_EQ (after.auth, before.auth)
    << "a stored non-object auth reads back as no auth, and the request goes "
       "out bare";
}

TEST_F (ResourceWriteRouteTest, RequestCreateWrongShapeObjectFieldIsRejected) {
    const std::string collection = make_collection ();
    for (const char* field : { "body", "auth" }) {
        for (const json& bad : wrong_shapes ()) {
            json payload{ { "collectionId", collection }, { "name", "R" },
                { "method", "GET" }, { "url", "https://example.com" } };
            payload[field]       = bad;
            auto [status, error] = create_request_response (*db_, payload);
            EXPECT_EQ (status, 400) << field << " = " << bad.dump ();
            EXPECT_NE (error["error"]["message"].get<std::string> ().find (field),
            std::string::npos);
        }
    }
    EXPECT_TRUE (db_->get_requests_in_collection (collection).empty ())
    << "a rejected create must not leave a record behind";
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
// Requests - verifySSL (issue #706). Stored like the redirect policy and
// defaulted like it: absent means verifying on create, `null` resets to
// verifying on update. The direction is what these pin - a field that read as
// "accept any certificate" whenever a client left it out would turn every
// pre-existing request insecure on the first save.
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, RequestCreateAbsentVerifySSLVerifies) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" } });
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("verifySSL"));
    EXPECT_EQ (body["verifySSL"], true);
    EXPECT_TRUE (db_->get_request (body["id"].get<std::string> ())->verify_ssl);
}

TEST_F (ResourceWriteRouteTest, RequestCreateStoresVerifySSLFalse) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" }, { "verifySSL", false } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["verifySSL"], false);
    EXPECT_FALSE (db_->get_request (body["id"].get<std::string> ())->verify_ssl);
}

TEST_F (ResourceWriteRouteTest, RequestUpdateKeepsVerifySSLWhenAbsent) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (
    update_request_response (*db_, id, json{ { "verifySSL", false } }).first, 200);

    auto [status, body] =
    update_request_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["verifySSL"], false)
    << "an untouched field must survive a patch";
}

TEST_F (ResourceWriteRouteTest, RequestUpdateNullVerifySSLResetsToVerifying) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (
    update_request_response (*db_, id, json{ { "verifySSL", false } }).first, 200);

    auto [status, body] =
    update_request_response (*db_, id, json{ { "verifySSL", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["verifySSL"], true);
}

TEST_F (ResourceWriteRouteTest, VerifySSLReadsBackThroughBothSerializers) {
    // The two-serializer rule: `serialize` answers the single-request route and
    // `serialize_to_stream` the list, and this repo has shipped a field on one
    // and not the other before.
    const std::string collection = make_collection ();
    auto [status, created]       = create_request_response (*db_,
          json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
          { "url", "https://internal.example.com" }, { "verifySSL", false } });
    ASSERT_EQ (status, 200);

    const json listed =
    json::parse (vayu::http::routes::list_requests_body (*db_, collection));
    ASSERT_EQ (listed.size (), 1u);
    ASSERT_TRUE (listed[0].contains ("verifySSL"))
    << "the list serializer dropped the field the single-request one carries";
    EXPECT_EQ (listed[0]["verifySSL"], created["verifySSL"]);
}

// ---------------------------------------------------------------------------
// Requests - httpVersion (issue: task 5, the requests-CRUD ingest/validate/
// seed matrix). All eight cells of:
//
//   |        | absent            | null              | valid | invalid |
//   | create | seed from global  | seed from global  | store | 400     |
//   | update | keep              | seed from global  | store | 400     |
//
// "Seed from global" means the *live* "defaultHttpVersion" config entry, not
// vayu::DEFAULT_HTTP_VERSION - a user who changes the global must see it apply
// to the next request they create/reset, without an engine restart.
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, RequestCreateAbsentHttpVersionSeedsFromGlobal) {
    // Global starts at its compiled-in default ("auto") - nothing has changed
    // it yet in a fresh test DB.
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "auto");
}

TEST_F (ResourceWriteRouteTest, RequestCreateAbsentHttpVersionSeedsFromConfiguredGlobal) {
    // The discriminating case: flip the global away from its compiled-in
    // default *before* creating, so a seed of vayu::DEFAULT_HTTP_VERSION
    // (rather than a live config read) would fail this.
    ASSERT_EQ (
    apply_config_update (*db_, R"({"entries":{"defaultHttpVersion":"http2"}})").first, 200);

    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http2");
}

TEST_F (ResourceWriteRouteTest, RequestCreateNullHttpVersionSeedsFromConfiguredGlobal) {
    ASSERT_EQ (
    apply_config_update (*db_, R"({"entries":{"defaultHttpVersion":"http2"}})").first, 200);

    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" }, { "httpVersion", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http2");
}

TEST_F (ResourceWriteRouteTest, RequestCreateValidHttpVersionIsStored) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" }, { "httpVersion", "http1.1" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http1.1");
    EXPECT_EQ (db_->get_request (body["id"].get<std::string> ())->http_version, "http1.1");
}

TEST_F (ResourceWriteRouteTest, RequestCreateInvalidHttpVersionIsRejectedAndNotStored) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" }, { "httpVersion", "http3" } });
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("httpVersion"), std::string::npos)
    << "the 400 must name the offending field";
    EXPECT_NE (message.find ("http3"), std::string::npos)
    << "the 400 must echo the offending value";
    for (const auto version : vayu::all_http_versions ()) {
        EXPECT_NE (message.find (vayu::to_string (version)), std::string::npos)
        << "the 400 must list the valid values (missing '"
        << vayu::to_string (version) << "')";
    }
}

TEST_F (ResourceWriteRouteTest, RequestCreateNonStringHttpVersionIsRejected) {
    // Diverges deliberately from apply_bool_field/apply_int_field, which
    // silently ignore a wrong-typed value - a wrong type on an enumerated
    // field is exactly the kind of mistake the reject-don't-coerce rule
    // exists for.
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.com" }, { "httpVersion", 2 } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (
    body["error"]["message"].get<std::string> ().find ("httpVersion"), std::string::npos);
}

TEST_F (ResourceWriteRouteTest, RequestUpdateAbsentHttpVersionKeepsExisting) {
    const std::string collection  = make_collection ();
    auto [create_status, created] = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.com" }, { "httpVersion", "http2" } });
    ASSERT_EQ (create_status, 200);
    const std::string id = created["id"].get<std::string> ();

    // Flipping the global afterwards must not retroactively touch a request
    // that did not ask to be reset.
    ASSERT_EQ (apply_config_update (*db_, R"({"entries":{"defaultHttpVersion":"http1.1"}})")
               .first,
    200);

    auto [status, body] =
    update_request_response (*db_, id, json{ { "name", "Renamed" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http2") << "absent means keep";
}

TEST_F (ResourceWriteRouteTest, RequestUpdateNullHttpVersionReReadsGlobalAtWriteTime) {
    // The other discriminating case: create while the global is still "auto",
    // then flip the global, then reset with null. Only a write-time config
    // read (not a value captured at create time, and not
    // vayu::DEFAULT_HTTP_VERSION) produces "http2" here.
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (db_->get_request (id)->http_version, "auto");

    ASSERT_EQ (
    apply_config_update (*db_, R"({"entries":{"defaultHttpVersion":"http2"}})").first, 200);

    auto [status, body] =
    update_request_response (*db_, id, json{ { "httpVersion", nullptr } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http2");
    EXPECT_EQ (db_->get_request (id)->http_version, "http2");
}

TEST_F (ResourceWriteRouteTest, RequestUpdateValidHttpVersionIsStored) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    auto [status, body] =
    update_request_response (*db_, id, json{ { "httpVersion", "http2" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["httpVersion"], "http2");
}

TEST_F (ResourceWriteRouteTest, RequestUpdateInvalidHttpVersionIsRejectedAndUnchanged) {
    const std::string collection = make_collection ();
    const std::string id         = make_request (collection);
    ASSERT_EQ (
    update_request_response (*db_, id, json{ { "httpVersion", "http2" } }).first, 200);

    auto [status, body] =
    update_request_response (*db_, id, json{ { "httpVersion", "spdy" } });
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("httpVersion"), std::string::npos);
    EXPECT_NE (message.find ("spdy"), std::string::npos);
    EXPECT_EQ (db_->get_request (id)->http_version, "http2")
    << "a rejected update must leave the stored value untouched";
}

TEST_F (ResourceWriteRouteTest, RequestAllHttpVersionsAreAcceptedAndRoundTrip) {
    // Mutation-check analogue of Task 4's SeededDefaultHttpVersionOptions...
    // test: derived from the same all_http_versions() the seeded config
    // options use, so validation cannot silently drop or add an entry
    // relative to what the config UI offers.
    const std::string collection = make_collection ();
    for (const auto version : vayu::all_http_versions ()) {
        const std::string wire = vayu::to_string (version);
        auto [status, body]    = create_request_response (*db_,
           json{ { "collectionId", collection }, { "name", "R-" + wire }, { "method", "GET" },
           { "url", "https://example.com" }, { "httpVersion", wire } });
        ASSERT_EQ (status, 200) << "rejected valid value '" << wire << "'";
        EXPECT_EQ (body["httpVersion"], wire);
    }
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

TEST_F (ResourceWriteRouteTest, EnvironmentCreateRejectsClientId) {
    auto [created_status, created] =
    create_environment_response (*db_, json{ { "name", "Original" } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] =
    create_environment_response (*db_, json{ { "id", id }, { "name", "Impostor" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["message"], ENGINE_OWNS_ID);
    EXPECT_EQ (db_->get_environment (id)->name, "Original");
    EXPECT_EQ (db_->get_environments ().size (), 1U)
    << "a rejected create must not persist a second row under a generated id";
}

TEST_F (ResourceWriteRouteTest, EnvironmentUpdateRejectsMismatchedBodyId) {
    auto [created_status, created] =
    create_environment_response (*db_, json{ { "name", "Original" } });
    ASSERT_EQ (created_status, 200);
    const std::string id = created["id"].get<std::string> ();

    auto [status, body] = update_environment_response (
    *db_, id, json{ { "id", "env_somewhere_else" }, { "name", "Renamed" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Body 'id'"),
    std::string::npos);
    EXPECT_EQ (db_->get_environment (id)->name, "Original");
}

TEST_F (ResourceWriteRouteTest, EnvironmentUpdateMissingIsNotFound) {
    auto [status, body] =
    update_environment_response (*db_, "env_does_not_exist", json{ { "name", "X" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Environment not found");
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

TEST_F (ResourceWriteRouteTest, ActivatingOverTheRouteDeactivatesThePrevious) {
    // The wire spelling of "switch environment": one PUT with isActive true.
    // The client sends no companion write to clear the old one, so if the route
    // did not go through the DB-layer rule both would come back active.
    auto [first_status, first] = create_environment_response (
    *db_, json{ { "name", "Dev" }, { "isActive", true } });
    ASSERT_EQ (first_status, 200);
    const std::string dev = first["id"].get<std::string> ();

    auto [second_status, second] =
    create_environment_response (*db_, json{ { "name", "Prod" } });
    ASSERT_EQ (second_status, 200);
    const std::string prod = second["id"].get<std::string> ();

    auto [status, body] =
    update_environment_response (*db_, prod, json{ { "isActive", true } });
    ASSERT_EQ (status, 200);
    EXPECT_TRUE (body["isActive"].get<bool> ());
    EXPECT_TRUE (db_->get_environment (prod)->is_active);
    EXPECT_FALSE (db_->get_environment (dev)->is_active);
}

TEST_F (ResourceWriteRouteTest, CreatingAnActiveEnvironmentDeactivatesThePrevious) {
    auto [first_status, first] = create_environment_response (
    *db_, json{ { "name", "Dev" }, { "isActive", true } });
    ASSERT_EQ (first_status, 200);
    const std::string dev = first["id"].get<std::string> ();

    auto [status, body] = create_environment_response (
    *db_, json{ { "name", "Prod" }, { "isActive", true } });
    ASSERT_EQ (status, 200);
    EXPECT_TRUE (db_->get_environment (body["id"].get<std::string> ())->is_active);
    EXPECT_FALSE (db_->get_environment (dev)->is_active);
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

TEST_F (ResourceWriteRouteTest, EnvironmentWrongShapeVariablesIsRejected) {
    auto [created_status, created] = create_environment_response (*db_,
    json{ { "name", "Env" },
    { "variables", { { "token", { { "value", "abc" }, { "enabled", true } } } } } });
    ASSERT_EQ (created_status, 200);
    const std::string id     = created["id"].get<std::string> ();
    const std::string before = db_->get_environment (id)->variables;

    for (const json& bad : wrong_shapes ()) {
        auto [status, body] =
        update_environment_response (*db_, id, json{ { "variables", bad } });
        EXPECT_EQ (status, 400) << "variables = " << bad.dump ();
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("variables"), std::string::npos);
    }
    EXPECT_EQ (db_->get_environment (id)->variables, before)
    << "a rejected write must not reach the column";
}

TEST_F (ResourceWriteRouteTest, EnvironmentCreateWrongShapeVariablesIsRejected) {
    for (const json& bad : wrong_shapes ()) {
        auto [status, body] = create_environment_response (
        *db_, json{ { "name", "Env" }, { "variables", bad } });
        EXPECT_EQ (status, 400) << "variables = " << bad.dump ();
    }
    EXPECT_TRUE (db_->get_environments ().empty ())
    << "a rejected create must not leave a record behind";
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
