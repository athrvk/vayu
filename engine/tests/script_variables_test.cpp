/**
 * @file tests/script_variables_test.cpp
 * @brief Tests for the stored-variables round trip, the design-run persist of
 *        the three variable scopes (issue #135), and the collection chain
 *        those scopes are loaded from (issue #234).
 *
 * A variables blob is written by the app and rewritten by the engine after
 * every design run, so the two halves of `parse_variables`/`serialize_variables`
 * are a contract: whatever the serializer omits is erased from disk by merely
 * sending a request. That is how `createdAt` - the app's row-ordering key for
 * the variables editor - was lost from every scope a run touched, which made a
 * newly added variable sort *above* the older ones.
 *
 * The assertions are therefore on the **stored blob**, not on the in-memory
 * map: a map-level check passes on the broken code, since the field only
 * disappears at serialization. `RoundTripKeepsEveryField` is the guard that
 * makes the next added field fail loudly instead of silently vanishing.
 *
 * Follows the suite's route-test convention (globals_route_test.cpp): the
 * route's extracted core is exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;
using vayu::json::parse_variables;
using vayu::json::serialize_variables;

namespace vayu::http::routes {
// Defined in execution.cpp. The tail of POST /execute: writes back whatever the
// pre/post-request scripts left in the three variable scopes.
void persist_script_variables (vayu::db::Database& db,
const vayu::db::Run& run,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::persist_script_variables;

// A blob in the shape the app writes: every field, including the ordering key.
constexpr const char* APP_BLOB =
R"({"token":{"value":"abc","enabled":true,"secret":true,"type":"json","createdAt":1784967810149}})";

// ---------------------------------------------------------------------------
// parse_variables / serialize_variables
// ---------------------------------------------------------------------------

// The regression, at its narrowest: the serializer must write back every field
// the parser reads. Mutation-check - drop any one line from
// serialize_variables and this fails on that field.
TEST (ScriptVariables, RoundTripKeepsEveryField) {
    auto stored = json::parse (serialize_variables (parse_variables (APP_BLOB)));

    ASSERT_TRUE (stored.contains ("token"));
    EXPECT_EQ (stored["token"]["value"], "abc");
    EXPECT_EQ (stored["token"]["enabled"], true);
    EXPECT_EQ (stored["token"]["secret"], true);
    EXPECT_EQ (stored["token"]["type"], "json");
    EXPECT_EQ (stored["token"]["createdAt"], 1784967810149LL);

    // No field of the parsed struct went unwritten. This is the part that
    // catches the *next* field rather than this one.
    EXPECT_EQ (parse_variables (stored.dump ()), parse_variables (APP_BLOB));
}

// An unknown creation time stays unknown. Stamping it here is what made a
// pre-existing row leapfrog the row the user had just added.
TEST (ScriptVariables, AbsentCreatedAtIsNotInvented) {
    auto stored = json::parse (
    serialize_variables (parse_variables (R"({"a":{"value":"1","enabled":true}})")));

    EXPECT_FALSE (stored["a"].contains ("createdAt"));
}

// A blob that has been through an older engine has no createdAt at all, and a
// hand-edited one can have a non-numeric value. Neither may throw, and neither
// may be read as an ordering key.
TEST (ScriptVariables, NonNumericCreatedAtIsTreatedAsAbsent) {
    auto env = parse_variables (R"({"a":{"value":"1","createdAt":"nope"}})");

    ASSERT_EQ (env.count ("a"), 1U);
    EXPECT_FALSE (env.at ("a").created_at.has_value ());
}

TEST (ScriptVariables, MalformedBlobParsesToEmptyRatherThanThrowing) {
    EXPECT_TRUE (parse_variables ("not json").empty ());
    EXPECT_TRUE (parse_variables ("").empty ());
    // A non-object entry is skipped, not coerced.
    EXPECT_TRUE (parse_variables (R"({"a":"bare string"})").empty ());
}

// ---------------------------------------------------------------------------
// persist_script_variables
// ---------------------------------------------------------------------------

class PersistScriptVariablesTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_variables.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        vayu::db::Collection collection;
        collection.id         = "col_1";
        collection.name       = "Collection";
        collection.variables  = APP_BLOB;
        collection.auth       = "{}";
        collection.order      = 0;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        vayu::db::Request request;
        request.id            = "req_1";
        request.collection_id = "col_1";
        request.name          = "Request";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "http://127.0.0.1/health";
        request.params        = "[]";
        request.headers       = "[]";
        request.body          = R"({"mode":"none"})";
        request.body_type     = "none";
        request.auth          = R"({"mode":"none"})";
        request.order         = 0;
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);

        vayu::db::Environment environment;
        environment.id         = "env_1";
        environment.name       = "Env";
        environment.variables  = APP_BLOB;
        environment.is_active  = true;
        environment.created_at = 1;
        environment.updated_at = 1;
        db_->save_environment (environment);

        vayu::db::Globals globals;
        globals.id         = "globals";
        globals.variables  = APP_BLOB;
        globals.updated_at = 1;
        db_->save_globals (globals);

        run_.id              = "run_1";
        run_.request_id      = "req_1";
        run_.environment_id  = "env_1";
        run_.type            = vayu::RunType::Design;
        run_.status          = vayu::RunStatus::Completed;
        run_.config_snapshot = "{}";
        run_.start_time      = 1;
        run_.end_time        = 1;
        db_->create_run (run_);
    }

    void TearDown () override {
        db_.reset ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::string stored_collection_variables () {
        auto c = db_->get_collection ("col_1");
        EXPECT_TRUE (c.has_value ());
        return c ? c->variables : std::string ();
    }
    std::string stored_environment_variables () {
        auto e = db_->get_environment ("env_1");
        EXPECT_TRUE (e.has_value ());
        return e ? e->variables : std::string ();
    }
    std::string stored_globals_variables () {
        auto g = db_->get_globals ();
        EXPECT_TRUE (g.has_value ());
        return g ? g->variables : std::string ();
    }
    int64_t stored_collection_updated_at () {
        auto c = db_->get_collection ("col_1");
        return c ? c->updated_at : 0;
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::db::Run run_;
};

// The reported bug: sending a request stripped `createdAt` from all three
// scopes, so the next variable the user added sorted above rows created before
// it. Nothing here modifies a variable - a plain Send must leave the blobs
// exactly as the app wrote them.
TEST_F (PersistScriptVariablesTest, ARunThatChangesNothingLeavesEveryScopeUntouched) {
    auto env       = parse_variables (stored_environment_variables ());
    auto globals   = parse_variables (stored_globals_variables ());
    auto coll_vars = parse_variables (stored_collection_variables ());

    persist_script_variables (*db_, run_, env, globals, coll_vars);

    EXPECT_EQ (stored_environment_variables (), APP_BLOB);
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
    // Not rewritten at all, so a Send no longer moves a collection's "Updated".
    EXPECT_EQ (stored_collection_updated_at (), 1);
}

// When a script *does* write, the scope is rewritten - and the untouched
// fields of the untouched variables still survive the trip.
TEST_F (PersistScriptVariablesTest, AScriptWriteKeepsTheOrderingKeyOfEveryOtherVariable) {
    auto env       = parse_variables (stored_environment_variables ());
    auto globals   = parse_variables (stored_globals_variables ());
    auto coll_vars = parse_variables (stored_collection_variables ());

    // What pm.collectionVariables.set("fresh", ...) leaves behind: a new key
    // stamped with its own creation time, every existing key untouched.
    vayu::Variable fresh;
    fresh.value        = "new";
    fresh.created_at   = 1784967999999;
    coll_vars["fresh"] = fresh;

    persist_script_variables (*db_, run_, env, globals, coll_vars);

    auto stored = json::parse (stored_collection_variables ());
    EXPECT_EQ (stored["token"]["createdAt"], 1784967810149LL);
    EXPECT_EQ (stored["token"]["secret"], true);
    EXPECT_EQ (stored["token"]["type"], "json");
    EXPECT_EQ (stored["fresh"]["createdAt"], 1784967999999LL);
    EXPECT_GT (stored_collection_updated_at (), 1);

    // The scopes no script touched are still not rewritten.
    EXPECT_EQ (stored_environment_variables (), APP_BLOB);
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
}

// A run with no environment and no request must not touch the scopes it has no
// business writing, and must not fail on the lookups that return nothing.
TEST_F (PersistScriptVariablesTest, ARunWithoutAnEnvironmentOrRequestWritesOnlyGlobals) {
    vayu::db::Run bare = run_;
    bare.id            = "run_2";
    bare.request_id.reset ();
    bare.environment_id.reset ();

    auto globals       = parse_variables (stored_globals_variables ());
    globals["g"].value = "1";

    persist_script_variables (*db_, bare, {}, globals, {});

    EXPECT_EQ (json::parse (stored_globals_variables ())["g"]["value"], "1");
    EXPECT_EQ (stored_environment_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
}

// `pm.environment.unset()` (#184) is the first thing that can make a scope
// *smaller*, and a removal is the write most easily lost: every other one shows
// up as a changed value, while this one shows up only as a key that is no
// longer there. The scope is rewritten because the two maps differ, and the
// serializer writes the map it is given rather than merging into what is on
// disk - so an absent key stays absent.
TEST_F (PersistScriptVariablesTest, AnUnsetVariableIsRemovedFromTheStoredBlob) {
    auto env       = parse_variables (stored_environment_variables ());
    auto globals   = parse_variables (stored_globals_variables ());
    auto coll_vars = parse_variables (stored_collection_variables ());

    ASSERT_EQ (env.count ("token"), 1U);
    env.erase ("token"); // what pm.environment.unset("token") leaves behind
    env["kept"] = vayu::Variable{ "still here", false, true };

    persist_script_variables (*db_, run_, env, globals, coll_vars);

    auto stored = json::parse (stored_environment_variables ());
    EXPECT_FALSE (stored.contains ("token")) << stored.dump ();
    EXPECT_EQ (stored["kept"]["value"], "still here");
}

// `clear()` empties one scope and no other. An empty blob is `{}`, not a
// scope left untouched because "nothing to write" was mistaken for "no change".
TEST_F (PersistScriptVariablesTest, AClearedScopeIsStoredAsEmptyAndTheOthersAreUntouched) {
    auto env       = parse_variables (stored_environment_variables ());
    auto globals   = parse_variables (stored_globals_variables ());
    auto coll_vars = parse_variables (stored_collection_variables ());

    env.clear (); // what pm.environment.clear() leaves behind

    persist_script_variables (*db_, run_, env, globals, coll_vars);

    EXPECT_EQ (stored_environment_variables (), "{}");
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
}

// ---------------------------------------------------------------------------
// load_script_variable_scopes - the collection chain a script reads (issue #234)
//
// This is where the D2 asymmetry lived: composition walked the whole ancestor
// chain for `{{name}}` while the route handed the scripts one `get_collection`
// of the immediate parent, so an inherited name read as undefined in a script
// and substituted fine in the URL. The two tests that carry the design are the
// agreement one (both notations answer the same) and the hazard one (a script
// write still reaches the leaf collection alone).
// ---------------------------------------------------------------------------

using vayu::http::routes::load_script_variable_scopes;

class ScriptVariableScopesTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_scopes.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        // API (root, defines `token`) -> Users (leaf, defines `page_size`).
        add_collection ("col_root", "API", std::nullopt,
        R"({"token":{"value":"root-token","enabled":true},)"
        R"("shadowed":{"value":"root-wins","enabled":true}})");
        add_collection ("col_leaf", "Users", "col_root",
        R"({"page_size":{"value":"25","enabled":true}})");

        vayu::db::Request request;
        request.id            = "req_1";
        request.collection_id = "col_leaf";
        request.name          = "List users";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "https://api.example.com/users?token={{token}}";
        request.params        = "[]";
        request.headers       = "[]";
        request.body          = R"({"mode":"none"})";
        request.body_type     = "none";
        request.auth          = R"({"mode":"none"})";
        request.order         = 0;
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);

        run_.id              = "run_1";
        run_.request_id      = "req_1";
        run_.type            = vayu::RunType::Design;
        run_.status          = vayu::RunStatus::Completed;
        run_.config_snapshot = "{}";
        run_.start_time      = 1;
        run_.end_time        = 1;
        db_->create_run (run_);
    }

    void TearDown () override {
        db_.reset ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void add_collection (const std::string& id,
    const std::string& name,
    std::optional<std::string> parent,
    const std::string& variables) {
        vayu::db::Collection collection;
        collection.id         = id;
        collection.name       = name;
        collection.parent_id  = std::move (parent);
        collection.variables  = variables;
        collection.auth       = "{}";
        collection.order      = 0;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);
    }

    std::string stored_variables (const std::string& collection_id) {
        auto c = db_->get_collection (collection_id);
        EXPECT_TRUE (c.has_value ());
        return c ? c->variables : std::string ();
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::db::Run run_;
};

// The leaf is the request's own collection and the only writable one; the rest
// of the chain arrives root-first and separate. Revert the walk to the old
// single get_collection and `collection_ancestors` is empty here.
TEST_F (ScriptVariableScopesTest, TheChainArrivesRootFirstWithTheLeafHeldSeparately) {
    auto scopes = load_script_variable_scopes (*db_, run_);

    ASSERT_EQ (scopes.collection_ancestors.size (), 1U);
    EXPECT_EQ (scopes.collection_ancestors[0].at ("token").value, "root-token");
    EXPECT_EQ (scopes.collection.count ("token"), 0U)
    << "the ancestor's variables were merged into the writable leaf scope";
    EXPECT_EQ (scopes.collection.at ("page_size").value, "25");
}

TEST_F (ScriptVariableScopesTest, ARequestOutsideAnyCollectionGetsEmptyCollectionScopes) {
    vayu::db::Request loose;
    loose.id         = "req_loose";
    loose.name       = "Loose";
    loose.method     = vayu::HttpMethod::GET;
    loose.url        = "https://api.example.com/ping";
    loose.params     = "[]";
    loose.headers    = "[]";
    loose.body       = R"({"mode":"none"})";
    loose.body_type  = "none";
    loose.auth       = R"({"mode":"none"})";
    loose.order      = 0;
    loose.created_at = 1;
    loose.updated_at = 1;
    db_->save_request (loose);

    vayu::db::Run run = run_;
    run.id            = "run_loose";
    run.request_id    = "req_loose";

    auto scopes = load_script_variable_scopes (*db_, run);

    EXPECT_TRUE (scopes.collection.empty ());
    EXPECT_TRUE (scopes.collection_ancestors.empty ());
}

// The issue in one assertion: the same `{{token}}`, defined only on an
// ancestor, must mean the same thing in a request field and in a script.
TEST_F (ScriptVariableScopesTest, AnInheritedNameResolvesTheSameInAScriptAsInTheUrl) {
    auto [status, composed] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
    ASSERT_EQ (status, 200) << composed.dump ();
    const std::string composed_url = composed["url"].get<std::string> ();
    ASSERT_NE (composed_url.find ("root-token"), std::string::npos) << composed_url;

    auto scopes = load_script_variable_scopes (*db_, run_);
    vayu::runtime::ScriptContext ctx;
    ctx.environment         = &scopes.environment;
    ctx.globals             = &scopes.globals;
    ctx.collectionVariables = &scopes.collection;
    ctx.collectionAncestors = &scopes.collection_ancestors;

    vayu::runtime::ScriptEngine engine;
    auto result = engine.execute (R"JS(
        pm.globals.set('replaced', pm.variables.replaceIn('{{token}}'));
        pm.globals.set('scoped', String(pm.collectionVariables.get('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (scopes.globals.at ("replaced").value, "root-token");
    EXPECT_EQ (scopes.globals.at ("scoped").value, "root-token");
    EXPECT_NE (composed_url.find (scopes.globals.at ("replaced").value), std::string::npos);
}

// The hazard #226 declined to risk, end to end: a script reads an inherited
// name and writes its own, and the persist that follows must touch the leaf
// collection only. If the chain were merged into one writable map, the diff
// against the leaf's stored blob would report the ancestor's variables as new
// and write them into the leaf permanently.
TEST_F (ScriptVariableScopesTest, AScriptThatReadsAnAncestorAndWritesPersistsOnlyTheLeaf) {
    const std::string root_before = stored_variables ("col_root");

    auto scopes = load_script_variable_scopes (*db_, run_);
    vayu::runtime::ScriptContext ctx;
    ctx.environment         = &scopes.environment;
    ctx.globals             = &scopes.globals;
    ctx.collectionVariables = &scopes.collection;
    ctx.collectionAncestors = &scopes.collection_ancestors;

    vayu::runtime::ScriptEngine engine;
    auto result = engine.execute (R"JS(
        pm.collectionVariables.get('token');
        pm.collectionVariables.get('shadowed');
        pm.collectionVariables.toObject();
        pm.collectionVariables.set('cursor', 'abc');
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;

    persist_script_variables (
    *db_, run_, scopes.environment, scopes.globals, scopes.collection);

    auto leaf = json::parse (stored_variables ("col_leaf"));
    EXPECT_EQ (leaf["cursor"]["value"], "abc");
    EXPECT_EQ (leaf["page_size"]["value"], "25");
    EXPECT_FALSE (leaf.contains ("token"))
    << "an ancestor's variable was copied down into the leaf collection: "
    << leaf.dump ();
    EXPECT_FALSE (leaf.contains ("shadowed")) << leaf.dump ();
    // The ancestor is not a write target at all, so its row is untouched -
    // blob and `updated_at` both.
    EXPECT_EQ (stored_variables ("col_root"), root_before);
    auto root = db_->get_collection ("col_root");
    ASSERT_TRUE (root.has_value ());
    EXPECT_EQ (root->updated_at, 1);
}

} // namespace
