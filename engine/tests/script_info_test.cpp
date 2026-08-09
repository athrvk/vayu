/**
 * @file tests/script_info_test.cpp
 * @brief The route half of `pm.info` (issue #300): where `requestName` comes
 *        from on POST /execute, and that POST /compose emits it.
 *
 * The sandbox half - what a script actually reads - lives in
 * script_engine_test.cpp. What is pinned here is the plumbing that decides
 * whether the script has anything to read: a name sent inline (the renderer's
 * path, whose editor state may be unsaved), a name looked up from the stored
 * row (MCP's path, which links a `requestId` without sending a name), and the
 * two ways that can go wrong - an unknown id and a field of the wrong type.
 *
 * Follows the suite's route-test convention (script_variables_test.cpp): the
 * route's extracted core is exercised directly against a real database, no
 * in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/types.hpp"

using nlohmann::json;
using vayu::http::routes::resolve_script_request_name;

namespace {

class ScriptRequestNameTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_info.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        vayu::db::Collection collection;
        collection.id         = "col_1";
        collection.name       = "Collection";
        collection.variables  = "{}";
        collection.auth       = "{}";
        collection.order      = 0;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        vayu::db::Request request;
        request.id            = "req_1";
        request.collection_id = "col_1";
        request.name          = "Fetch users";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "http://127.0.0.1/users";
        request.params        = "[]";
        request.headers       = "[]";
        request.body          = R"({"mode":"none"})";
        request.body_type     = "none";
        request.auth          = R"({"mode":"none"})";
        request.order         = 0;
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);
    }

    void TearDown () override {
        db_.reset ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// The inline path: the renderer executes editor state, which may be unsaved or
// a detached replay copy, so the name it sends wins over anything stored.
TEST_F (ScriptRequestNameTest, PayloadNameWinsOverTheStoredRow) {
    auto resolved = resolve_script_request_name (
    *db_, json{ { "requestName", "Renamed in the editor" } }, std::string ("req_1"));

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.name.has_value ());
    EXPECT_EQ (*resolved.name, "Renamed in the editor");
}

// An unsaved request has a name and no row to look it up in. This is the case
// that makes the payload field necessary rather than a convenience.
TEST_F (ScriptRequestNameTest, PayloadNameIsUsedWithNoRequestIdAtAll) {
    auto resolved =
    resolve_script_request_name (*db_, json{ { "requestName", "Untitled" } }, std::nullopt);

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.name.has_value ());
    EXPECT_EQ (*resolved.name, "Untitled");
}

// MCP's run_request links a saved request by id without sending its name;
// without this lookup `pm.info.requestName` would be undefined from one client
// and populated from the other.
TEST_F (ScriptRequestNameTest, FallsBackToTheStoredRowWhenOnlyAnIdIsSent) {
    auto resolved = resolve_script_request_name (*db_, json::object (), std::string ("req_1"));

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.name.has_value ());
    EXPECT_EQ (*resolved.name, "Fetch users");
}

// A deleted or mistyped id costs the script a name; it does not cost the user
// their request. The run row already tolerates an id with no row behind it.
TEST_F (ScriptRequestNameTest, UnknownRequestIdYieldsNoNameAndNoError) {
    auto resolved = resolve_script_request_name (*db_, json::object (), std::string ("req_gone"));

    EXPECT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.name.has_value ());
}

// Absent everywhere is a normal answer - an ad-hoc request has no name.
TEST_F (ScriptRequestNameTest, NothingToResolveYieldsAbsent) {
    auto resolved = resolve_script_request_name (*db_, json::object (), std::nullopt);

    EXPECT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.name.has_value ());
}

// An empty string is not a name: it must not shadow the stored row, and it
// must not reach the script as "".
TEST_F (ScriptRequestNameTest, EmptyPayloadNameDoesNotShadowTheStoredRow) {
    auto resolved = resolve_script_request_name (
    *db_, json{ { "requestName", "" } }, std::string ("req_1"));

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.name.has_value ());
    EXPECT_EQ (*resolved.name, "Fetch users");
}

TEST_F (ScriptRequestNameTest, EmptyPayloadNameWithNoRowResolvesToAbsent) {
    auto resolved =
    resolve_script_request_name (*db_, json{ { "requestName", "" } }, std::nullopt);

    EXPECT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.name.has_value ());
}

// `null` is how the clients spell "no value" on every other optional field, so
// it is absence here too, not a type error.
TEST_F (ScriptRequestNameTest, NullPayloadNameIsAbsenceNotAnError) {
    auto resolved =
    resolve_script_request_name (*db_, json{ { "requestName", nullptr } }, std::nullopt);

    EXPECT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.name.has_value ());
}

// The loud path. A number where a string belongs is a client bug, and the
// route answers 400 rather than dropping the field and leaving the script to
// wonder why its name is undefined.
TEST_F (ScriptRequestNameTest, NonStringPayloadNameIsRejected) {
    auto resolved =
    resolve_script_request_name (*db_, json{ { "requestName", 7 } }, std::string ("req_1"));

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("requestName"), std::string::npos) << resolved.error;
    EXPECT_FALSE (resolved.name.has_value ());
}

// POST /compose is what carries the stored name to a client that never reads
// the row - MCP's run_collection_smoke composes by id and posts the result
// unchanged. Drop the emission and `pm.info.requestName` goes undefined there.
TEST_F (ScriptRequestNameTest, ComposeByIdEmitsTheStoredRequestName) {
    auto [status, payload] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });

    ASSERT_EQ (status, 200) << payload.dump ();
    ASSERT_TRUE (payload.contains ("requestName")) << payload.dump ();
    EXPECT_EQ (payload["requestName"], "Fetch users");
}

// The inline path has no row to read, so compose must not invent a name -
// it passes through whatever the client sent, and nothing when it sent none.
TEST_F (ScriptRequestNameTest, ComposeInlineCarriesTheClientsNameAndNothingElse) {
    auto [status, payload] = vayu::http::compose_request_core (*db_,
    json{ { "request",
    json{ { "method", "GET" }, { "url", "http://127.0.0.1/x" }, { "requestName", "Unsaved" } } } });

    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["requestName"], "Unsaved");

    auto [bare_status, bare] = vayu::http::compose_request_core (
    *db_, json{ { "request", json{ { "method", "GET" }, { "url", "http://127.0.0.1/x" } } } });

    ASSERT_EQ (bare_status, 200) << bare.dump ();
    EXPECT_FALSE (bare.contains ("requestName")) << bare.dump ();
}

} // namespace
