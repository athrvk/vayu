/**
 * @file tests/script_variables_test.cpp
 * @brief Tests for the stored-variables round trip, the design-run persist of
 *        the three variable scopes (issues #135 and #1878), the typed value a
 *        script set within a run (#2529), the run-local scope that is never
 *        persisted (#2564), and the collection chain those scopes are loaded
 *        from (issue #234).
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

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "competing_writer.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;
using vayu::json::parse_variables;
using vayu::json::serialize_variables;

namespace vayu::http::routes {
// The competing clients' route cores (environments.cpp, globals.cpp,
// collections.cpp); each returns {http_status, json_body}.
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
save_globals_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::load_script_variable_scopes;
using vayu::http::routes::persist_script_variables;
using vayu::http::routes::ScriptVariableScopes;

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

// A Postman import's variable description (the Postman exporter writes it
// back) survives a script's variable write; an absent one stays absent.
TEST (ScriptVariables, RoundTripKeepsAnImportedDescription) {
    auto stored = json::parse (serialize_variables (parse_variables (
    R"({"a":{"value":"1","enabled":true,"description":"Why"},"b":{"value":"2"}})")));

    EXPECT_EQ (stored["a"]["description"], "Why");
    EXPECT_FALSE (stored["b"].contains ("description"));
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
// The typed value a script set, within the run (#2529)
//
// Each script runs in a context of its own, so a value read back by a second
// `run` crossed the same boundary a value set in a pre-request script and read
// in the test script does. Every check throws on a mismatch, which fails the
// script and names the expectation.
// ---------------------------------------------------------------------------

class ScriptVariablesTest : public ::testing::Test {
    protected:
    void run (const std::string& source) {
        vayu::runtime::ScriptContext ctx;
        vayu::http::routes::bind_variable_scopes (ctx, scopes_);
        vayu::runtime::ScriptEngine engine;
        const auto result = engine.execute (source, ctx);
        ASSERT_TRUE (result.success) << result.error_message;
    }

    // The XG shape from the issue, plus one value of every other carried kind.
    void set_one_of_each () {
        run (R"JS(
            pm.environment.set('n', 0);
            pm.environment.set('n', pm.environment.get('n') + 1);
            pm.environment.set('flag', true);
            pm.environment.set('list', [1, 2, 3]);
            pm.environment.set('obj', { a: 1 });
            pm.environment.set('nothing', null);
        )JS");
    }

    ScriptVariableScopes scopes_;
};

// Mutation check: make `cast_variable_to_jsvalue` ignore `script_value` and
// `get('n')` is the string "01".
TEST_F (ScriptVariablesTest, SetKeepsTheTypedValueInTheRun) {
    set_one_of_each ();

    run (R"JS(
        pm.expect(pm.environment.get('n')).to.equal(1);
        pm.expect(typeof pm.environment.get('n')).to.equal('number');
        pm.expect(pm.environment.get('flag')).to.equal(true);
        pm.expect(Array.isArray(pm.environment.get('list'))).to.equal(true);
        pm.expect(pm.environment.get('list')).to.eql([1, 2, 3]);
        pm.expect(pm.environment.get('obj').a).to.equal(1);
        pm.expect(pm.environment.get('nothing')).to.equal(null);

        // Every other reader answers the same value get() does.
        pm.expect(pm.environment.toObject().n).to.equal(1);
        pm.expect(pm.variables.get('list')).to.eql([1, 2, 3]);
        pm.expect(pm.variables.toObject().obj).to.eql({ a: 1 });
        pm.expect(pm.environment.has('nothing')).to.equal(true);
    )JS");
}

// The other two scopes share the binding, and so the carry.
TEST_F (ScriptVariablesTest, EveryScopeKeepsTheTypedValue) {
    run (R"JS(
        pm.globals.set('g', 2);
        pm.collectionVariables.set('c', false);
    )JS");

    run (R"JS(
        pm.expect(pm.globals.get('g')).to.equal(2);
        pm.expect(pm.collectionVariables.get('c')).to.equal(false);
        pm.expect(pm.variables.get('c')).to.equal(false);
    )JS");
}

// A number carries as a double rather than as JSON, so the values JSON has no
// spelling for come back as themselves.
TEST_F (ScriptVariablesTest, ANumberJsonCannotSpellComesBackAsItself) {
    run (R"JS(
        pm.environment.set('nan', NaN);
        pm.environment.set('inf', -Infinity);
        pm.environment.set('negzero', -0);
    )JS");

    run (R"JS(
        pm.expect(Number.isNaN(pm.environment.get('nan'))).to.equal(true);
        pm.expect(pm.environment.get('inf')).to.equal(-Infinity);
        pm.expect(Object.is(pm.environment.get('negzero'), -0)).to.equal(true);
    )JS");
    EXPECT_EQ (scopes_.environment.at ("nan").value, "NaN");
    EXPECT_EQ (scopes_.environment.at ("negzero").value, "0");
}

// What JSON cannot write carries nothing, and the read falls back to the text
// rather than failing the script that set it.
TEST_F (ScriptVariablesTest, AValueJsonCannotWriteReadsBackAsItsText) {
    run (R"JS(
        var cycle = {};
        cycle.self = cycle;
        pm.environment.set('cycle', cycle);
        pm.environment.set('fn', function () { return 1; });
    )JS");

    run (R"JS(
        pm.expect(pm.environment.get('cycle')).to.equal('[object Object]');
        pm.expect(typeof pm.environment.get('fn')).to.equal('string');
    )JS");
}

// The text form is what `set` always wrote, so `{{name}}` and the wire are
// what they were, and what Postman substitutes.
TEST_F (ScriptVariablesTest, TheStoredTextAndTheWireAreUnchanged) {
    set_one_of_each ();

    EXPECT_EQ (scopes_.environment.at ("n").value, "1");
    EXPECT_EQ (scopes_.environment.at ("flag").value, "true");
    EXPECT_EQ (scopes_.environment.at ("list").value, "1,2,3");
    EXPECT_EQ (scopes_.environment.at ("obj").value, "[object Object]");
    EXPECT_EQ (scopes_.environment.at ("nothing").value, "null");
    EXPECT_EQ (scopes_.environment.at ("n").type, "string");

    vayu::Request request;
    request.url                = "https://api.example.com/items";
    request.headers["X-Count"] = "{{n}}";
    request.headers["X-List"]  = "{{list}}";
    EXPECT_FALSE (vayu::http::routes::resolve_residual_tokens (request, scopes_));
    EXPECT_EQ (request.headers["X-Count"], "1");
    EXPECT_EQ (request.headers["X-List"], "1,2,3");

    // A script's own template substitutes the text too.
    run (R"JS(
        pm.expect(pm.variables.replaceIn('{{n}}/{{list}}')).to.equal('1/1,2,3');
    )JS");
}

// Postman keeps the variable with the value `undefined`, which its toString
// substitutes as "" - not JavaScript's "undefined".
TEST_F (ScriptVariablesTest, SetUndefinedStoresAnEmptyString) {
    run ("pm.environment.set('u', undefined);");

    EXPECT_EQ (scopes_.environment.at ("u").value, "");
    run (R"JS(
        pm.expect(pm.environment.has('u')).to.equal(true);
        pm.expect(pm.environment.get('u')).to.equal(undefined);
        pm.expect('u' in pm.environment.toObject()).to.equal(true);
        pm.expect(pm.variables.replaceIn('[{{u}}]')).to.equal('[]');
    )JS");
}

// A row whose type is declared keeps casting its text, as Postman casts a
// declared type: the carry says `0` and `[5]`, the declared types answer
// `false` and `5`. A row of the default type is the other way round.
TEST_F (ScriptVariablesTest, ADeclaredNumberTypeStillCasts) {
    scopes_.environment["flag"] = vayu::Variable{ "true", false, true, "boolean" };
    scopes_.environment["count"] = vayu::Variable{ "1", false, true, "number" };
    scopes_.environment["plain"] = vayu::Variable{ "1", false, true, "string" };

    run (R"JS(
        pm.environment.set('flag', 0);
        pm.environment.set('count', [5]);
        pm.environment.set('plain', [5]);
    )JS");

    run (R"JS(
        pm.expect(pm.environment.get('flag')).to.equal(false);
        pm.expect(pm.environment.get('count')).to.equal(5);
        pm.expect(pm.environment.get('plain')).to.eql([5]);
    )JS");
    EXPECT_EQ (scopes_.environment.at ("flag").type, "boolean");
    EXPECT_EQ (scopes_.environment.at ("count").type, "number");
}

// A row declared `json` stores an object or an array as its JSON text, so the
// row's own read parses it back and `{{name}}` substitutes the document (#2568).
// Mutation check: store `js_to_string` on every row and the stored text is
// "[object Object]", so the read answers that string.
TEST_F (ScriptVariablesTest, ADeclaredJsonRowKeepsAnObjectOrArrayAsJsonText) {
    scopes_.environment["o"] = vayu::Variable{ "{}", false, true, "json" };
    scopes_.environment["a"] = vayu::Variable{ "[]", false, true, "json" };

    run (R"JS(
        pm.environment.set('o', { a: 1, b: [true, null] });
        pm.environment.set('a', [1, { x: 'y' }]);
    )JS");

    EXPECT_EQ (scopes_.environment.at ("o").value, R"({"a":1,"b":[true,null]})");
    EXPECT_EQ (scopes_.environment.at ("a").value, R"([1,{"x":"y"}])");
    EXPECT_EQ (scopes_.environment.at ("o").type, "json");

    run (R"JS(
        pm.expect(pm.environment.get('o')).to.eql({ a: 1, b: [true, null] });
        pm.expect(pm.environment.get('a')).to.eql([1, { x: 'y' }]);
        pm.expect(pm.environment.toObject().o.a).to.equal(1);
        pm.expect(pm.variables.replaceIn('{{o}}')).to.equal('{"a":1,"b":[true,null]}');
    )JS");

    vayu::Request request;
    request.url                 = "https://api.example.com/items";
    request.headers["X-Filter"] = "{{o}}";
    EXPECT_FALSE (vayu::http::routes::resolve_residual_tokens (request, scopes_));
    EXPECT_EQ (request.headers["X-Filter"], R"({"a":1,"b":[true,null]})");
}

// Only the declared type changes the stored text: a string stays as given on a
// json row, a value JSON cannot write falls back to the string conversion, and
// a default-type row keeps Postman's text.
TEST_F (ScriptVariablesTest, OnlyADeclaredJsonRowChangesTheStoredText) {
    scopes_.environment["j"]     = vayu::Variable{ "{}", false, true, "json" };
    scopes_.environment["plain"] = vayu::Variable{ "x", false, true, "string" };

    run (R"JS(
        pm.environment.set('j', '{"keep":"as given"}');
        pm.environment.set('plain', { a: 1 });
        pm.environment.set('fresh', { a: 1 });
    )JS");
    EXPECT_EQ (scopes_.environment.at ("j").value, R"({"keep":"as given"})");
    EXPECT_EQ (scopes_.environment.at ("plain").value, "[object Object]");
    EXPECT_EQ (scopes_.environment.at ("fresh").value, "[object Object]");

    run (R"JS(
        var cycle = {};
        cycle.self = cycle;
        pm.environment.set('j', cycle);
    )JS");
    EXPECT_EQ (scopes_.environment.at ("j").value, "[object Object]");

    run (R"JS(
        pm.expect(pm.environment.get('plain')).to.eql({ a: 1 });
    )JS");
}

// A string carries nothing, so a later string set retires an earlier typed
// value rather than leaving it to answer.
TEST_F (ScriptVariablesTest, AStringSetReplacesAnEarlierTypedValue) {
    run (R"JS(
        pm.environment.set('n', 5);
        pm.environment.set('n', '5');
    )JS");

    run ("pm.expect(pm.environment.get('n')).to.equal('5');");
}

// An `extract.*` element writes a whole new variable (`set_scope_variable`),
// so the value a script set before it is gone and the extracted text answers.
TEST_F (ScriptVariablesTest, AnExtractAfterASetReplacesTheTypedValue) {
    run ("pm.environment.set('token', 5);");

    vayu::http::routes::set_scope_variable (scopes_, "env", "token", "abc");

    run ("pm.expect(pm.environment.get('token')).to.equal('abc');");
}

// A load run keeps a VU's writes in its `ScopeOverlay`, which holds whole
// variables, so the typed value reaches that VU's next step; an `extract.*`
// under load (`ScopeOverlay::set`) replaces it the way it does in a design run.
TEST_F (ScriptVariablesTest, ALoadRunsOverlayCarriesTheTypedValueToTheNextStep) {
    vayu::http::routes::ScopeOverlay overlay;
    const ScriptVariableScopes base;

    scopes_ = overlay.materialize (base);
    run ("pm.environment.set('n', 0); pm.environment.set('list', [1]);");
    overlay.replace_from (scopes_);

    scopes_ = overlay.materialize (base);
    run ("pm.environment.set('n', pm.environment.get('n') + 1);");
    overlay.replace_from (scopes_);
    overlay.set ("env", "list", "extracted");

    scopes_ = overlay.materialize (base);
    run (R"JS(
        pm.expect(pm.environment.get('n')).to.equal(1);
        pm.expect(pm.environment.get('list')).to.equal('extracted');
    )JS");
}

// ---------------------------------------------------------------------------
// The run-local scope behind pm.variables.set (#2564)
// ---------------------------------------------------------------------------

// `unset` and `clear` reach the local scope alone: unsetting a local that
// shadowed an environment variable uncovers it, and clearing leaves every
// named scope as it was.
TEST_F (ScriptVariablesTest, LocalUnsetAndClearTouchOnlyTheLocalScope) {
    scopes_.environment["x"] = vayu::Variable{ "from-env", false, true };

    run (R"JS(
        pm.variables.set('x', 'local');
        pm.variables.set('a', 1);
        pm.variables.set('b', 2);
    )JS");
    run (R"JS(
        pm.expect(pm.variables.get('x')).to.equal('local');
        pm.variables.unset('x');
        pm.expect(pm.variables.get('x')).to.equal('from-env');
        pm.variables.unset('never-set');
        pm.variables.clear();
        pm.expect(pm.variables.has('a')).to.equal(false);
        pm.expect(pm.variables.get('b')).to.equal(undefined);
        pm.expect(pm.variables.get('x')).to.equal('from-env');
    )JS");

    EXPECT_TRUE (scopes_.local.empty ());
    ASSERT_EQ (scopes_.environment.count ("x"), 1U);
    EXPECT_EQ (scopes_.environment.at ("x").value, "from-env");
}

// A load VU's local scope rides its `ScopeOverlay` from one step's script to
// the next, typed, and above the environment on the residual pass's map; a
// new iteration clears it. Mutation check: drop `local` from
// `ScopeOverlay::materialize` and the second step reads `undefined`.
TEST_F (ScriptVariablesTest, ALoadRunsOverlayCarriesTheLocalScopeToTheNextStep) {
    vayu::http::routes::ScopeOverlay overlay;
    ScriptVariableScopes base;
    base.environment["n"] = vayu::Variable{ "from-env", false, true };

    scopes_ = overlay.materialize (base);
    run ("pm.variables.set('n', 0);");
    overlay.replace_from (scopes_);

    scopes_ = overlay.materialize (base);
    run ("pm.variables.set('n', pm.variables.get('n') + 1);");
    overlay.replace_from (scopes_);

    auto vars = vayu::http::routes::flatten_variable_scopes (base);
    overlay.apply_onto (vars);
    EXPECT_EQ (vars["n"], "1");
    EXPECT_FALSE (base.local.contains ("n")) << "a VU's write reached the base";

    overlay.clear ();
    scopes_ = overlay.materialize (base);
    run ("pm.expect(pm.variables.get('n')).to.equal('from-env');");
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

    ScriptVariableScopes load () {
        return load_script_variable_scopes (*db_, run_);
    }

    static void run_script (ScriptVariableScopes& scopes, const std::string& source) {
        vayu::runtime::ScriptContext ctx;
        vayu::http::routes::bind_variable_scopes (ctx, scopes);
        vayu::runtime::ScriptEngine engine;
        const auto result = engine.execute (source, ctx);
        ASSERT_TRUE (result.success) << result.error_message;
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::db::Run run_;
};

// The reported bug: sending a request stripped `createdAt` from all three
// scopes, so the next variable the user added sorted above rows created before
// it. Nothing here modifies a variable - a plain Send must leave the blobs
// exactly as the app wrote them.
TEST_F (PersistScriptVariablesTest, ARunThatChangesNothingLeavesEveryScopeUntouched) {
    persist_script_variables (*db_, load ());

    EXPECT_EQ (stored_environment_variables (), APP_BLOB);
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
    // Not rewritten at all, so a Send no longer moves a collection's "Updated".
    EXPECT_EQ (stored_collection_updated_at (), 1);
}

// When a script *does* write, the scope is rewritten - and the untouched
// fields of the untouched variables still survive the trip.
TEST_F (PersistScriptVariablesTest, AScriptWriteKeepsTheOrderingKeyOfEveryOtherVariable) {
    auto scopes = load ();

    // What pm.collectionVariables.set("fresh", ...) leaves behind: a new key
    // stamped with its own creation time, every existing key untouched.
    vayu::Variable fresh;
    fresh.value                = "new";
    fresh.created_at           = 1784967999999;
    scopes.collection["fresh"] = fresh;

    persist_script_variables (*db_, scopes);

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

// A set on a row the user unticked ticks it (#2479), which is a change to more
// than the value, so the stored row is written whole - and still carries the
// secret flag, type and creation time the script never touched.
TEST_F (PersistScriptVariablesTest, ASetOnADisabledRowStoresItEnabledWithTheNewValue) {
    auto environment = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (environment);
    environment->variables =
    R"({"token":{"value":"old","enabled":false,"secret":true,"type":"json","createdAt":1784967810149}})";
    db_->save_environment (*environment);

    auto scopes = load ();
    run_script (scopes, "pm.environment.set('token', 'new');");
    persist_script_variables (*db_, scopes);

    auto stored = json::parse (stored_environment_variables ());
    EXPECT_EQ (stored["token"]["value"], "new");
    EXPECT_EQ (stored["token"]["enabled"], true);
    EXPECT_EQ (stored["token"]["secret"], true);
    EXPECT_EQ (stored["token"]["type"], "json");
    EXPECT_EQ (stored["token"]["createdAt"], 1784967810149LL);
}

// The typed value a set carries is run-local (#2529): setting the number 5 on
// a row that already holds the text "5" changes nothing a row stores, so the
// row is not rewritten. Mutation check: make `ScriptValue::operator==` compare
// its fields and the row is rewritten, `updated_at` with it.
TEST_F (PersistScriptVariablesTest, TypedValuesDoNotMakeTheRowLookEdited) {
    auto environment = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (environment);
    const std::string blob =
    R"({"n":{"value":"5","enabled":true,"secret":false,"type":"string","createdAt":1784967810149}})";
    environment->variables = blob;
    db_->save_environment (*environment);

    auto scopes = load ();
    run_script (scopes, "pm.environment.set('n', 5);");
    persist_script_variables (*db_, scopes);

    EXPECT_EQ (stored_environment_variables (), blob);
    auto after = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->updated_at, 1)
    << "a typed set of the same text rewrote the row";
}

// A typed set that does change the text is still a value-only delta, so a
// flag another client changed on the row meanwhile survives it - the same
// rule a string set follows. Under the mutation above this one fails too: the
// carry makes the change look like more than the value, and the row is
// written whole.
TEST_F (PersistScriptVariablesTest, ATypedSetKeepsAFlagAnotherClientChanged) {
    auto scopes    = load ();
    auto variables = json::parse (stored_environment_variables ());
    variables["token"]["enabled"] = false;
    ASSERT_EQ (vayu::http::routes::update_environment_response (
               *db_, "env_1", json{ { "variables", variables } })
               .first,
    200);

    run_script (scopes, "pm.environment.set('token', [1, 2]);");
    persist_script_variables (*db_, scopes);

    auto stored = json::parse (stored_environment_variables ());
    EXPECT_EQ (stored["token"]["value"], "[1,2]"); // the row is declared json (#2568)
    EXPECT_EQ (stored["token"]["enabled"], false) << stored.dump ();
    EXPECT_EQ (stored["token"]["type"], "json");
}

// `pm.variables.set` writes the run-local scope (#2564): read first, above a
// bound data row and every named scope, carried to the run's next script, and
// never stored. Mutation check: drop `local` from `bind_variable_scopes` and
// the second script reads the row again.
TEST_F (PersistScriptVariablesTest, LocalSetIsReadFirstAndNeverPersisted) {
    auto environment = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (environment);
    const std::string blob = R"({"x":{"value":"from-env","enabled":true}})";
    environment->variables = blob;
    db_->save_environment (*environment);

    auto scopes              = load ();
    const nlohmann::json row = { { "x", "from-row" } };
    const auto run_with_row  = [&scopes, &row] (const std::string& source) {
        vayu::runtime::ScriptContext ctx;
        vayu::http::routes::bind_variable_scopes (ctx, scopes);
        ctx.iteration_data = &row;
        vayu::runtime::ScriptEngine engine;
        const auto result = engine.execute (source, ctx);
        EXPECT_TRUE (result.success) << result.error_message;
    };

    run_with_row (R"JS(
        pm.expect(pm.variables.get('x')).to.equal('from-row');
        pm.variables.set('x', 1);
        pm.expect(pm.variables.get('x')).to.equal(1);
    )JS");
    run_with_row (R"JS(
        pm.expect(pm.variables.get('x')).to.equal(1);
        pm.expect(pm.variables.has('x')).to.equal(true);
        pm.expect(pm.variables.toObject().x).to.equal(1);
        pm.expect(pm.variables.replaceIn('{{x}}|{{data.x}}')).to.equal('1|from-row');
        pm.expect(pm.iterationData.get('x')).to.equal('from-row');
        pm.expect(pm.environment.get('x')).to.equal('from-env');
    )JS");

    ASSERT_EQ (scopes.local.count ("x"), 1U);
    EXPECT_EQ (scopes.local.at ("x").value, "1");
    EXPECT_EQ (scopes.environment.at ("x").value, "from-env");

    persist_script_variables (*db_, scopes);

    EXPECT_EQ (stored_environment_variables (), blob);
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_updated_at (), 1);
}

// A run with no environment and no request must not touch the scopes it has no
// business writing, and must not fail on the lookups that return nothing.
TEST_F (PersistScriptVariablesTest, ARunWithoutAnEnvironmentOrRequestWritesOnlyGlobals) {
    vayu::db::Run bare = run_;
    bare.id            = "run_2";
    bare.request_id.reset ();
    bare.environment_id.reset ();

    auto scopes               = load_script_variable_scopes (*db_, bare);
    scopes.globals["g"].value = "1";

    persist_script_variables (*db_, scopes);

    EXPECT_EQ (json::parse (stored_globals_variables ())["g"]["value"], "1");
    EXPECT_EQ (stored_environment_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
}

// `pm.environment.unset()` (#184) is the first thing that can make a scope
// *smaller*, and a removal is the write most easily lost: every other one shows
// up as a changed value, while this one shows up only as a key that is no
// longer there. The delta carries it as a name the run loaded and no longer
// holds.
TEST_F (PersistScriptVariablesTest, AnUnsetVariableIsRemovedFromTheStoredBlob) {
    auto scopes = load ();

    ASSERT_EQ (scopes.environment.count ("token"), 1U);
    scopes.environment.erase ("token"); // what pm.environment.unset("token") leaves behind
    scopes.environment["kept"] = vayu::Variable{ "still here", false, true };

    persist_script_variables (*db_, scopes);

    auto stored = json::parse (stored_environment_variables ());
    EXPECT_FALSE (stored.contains ("token")) << stored.dump ();
    EXPECT_EQ (stored["kept"]["value"], "still here");
}

// `clear()` empties one scope and no other. An empty blob is `{}`, not a
// scope left untouched because "nothing to write" was mistaken for "no change".
TEST_F (PersistScriptVariablesTest, AClearedScopeIsStoredAsEmptyAndTheOthersAreUntouched) {
    auto scopes = load ();

    scopes.environment.clear (); // what pm.environment.clear() leaves behind

    persist_script_variables (*db_, scopes);

    EXPECT_EQ (stored_environment_variables (), "{}");
    EXPECT_EQ (stored_globals_variables (), APP_BLOB);
    EXPECT_EQ (stored_collection_variables (), APP_BLOB);
}

// ---------------------------------------------------------------------------
// persist_script_variables against another writer (issue #1878)
//
// A send, a stream or a collection run loads its scopes at the start and
// persists at the end, seconds or minutes later. Anything another client wrote
// to the same row in between - the editor's autosave, `POST /globals`, another
// send's own persist - must survive. Each case runs once per writable scope.
// ---------------------------------------------------------------------------

enum class Scope : std::uint8_t { Environment, Globals, Collection };

std::string scope_name (const ::testing::TestParamInfo<Scope>& info) {
    switch (info.param) {
    case Scope::Environment: return "Environment";
    case Scope::Globals: return "Globals";
    case Scope::Collection: return "Collection";
    }
    return "Unknown";
}

class PersistAgainstAnotherWriterTest : public PersistScriptVariablesTest,
                                        public ::testing::WithParamInterface<Scope> {
    protected:
    /// The script object that writes this scope.
    static std::string pm_scope () {
        switch (GetParam ()) {
        case Scope::Environment: return "pm.environment";
        case Scope::Globals: return "pm.globals";
        case Scope::Collection: return "pm.collectionVariables";
        }
        return "";
    }

    static vayu::Environment& written (ScriptVariableScopes& scopes) {
        switch (GetParam ()) {
        case Scope::Environment: return scopes.environment;
        case Scope::Globals: return scopes.globals;
        case Scope::Collection: return scopes.collection;
        }
        return scopes.collection;
    }

    /// Another client replacing the scope's whole variables map, the way the
    /// app's editor and `POST /globals` do, through the route core.
    void write_from_another_client (const json& variables) {
        const json body{ { "variables", variables } };
        int status = 0;
        switch (GetParam ()) {
        case Scope::Environment:
            status = vayu::http::routes::update_environment_response (*db_, "env_1", body)
                     .first;
            break;
        case Scope::Globals:
            status = vayu::http::routes::save_globals_response (*db_, body).first;
            break;
        case Scope::Collection:
            status =
            vayu::http::routes::update_collection_response (*db_, "col_1", body).first;
            break;
        }
        ASSERT_EQ (status, 200);
    }

    /// The stored map with one more variable, `region`, beside it.
    void add_region_from_another_client () {
        auto variables      = json::parse (stored ());
        variables["region"] = json{ { "value", "eu" }, { "enabled", true } };
        write_from_another_client (variables);
    }

    std::string stored () {
        switch (GetParam ()) {
        case Scope::Environment: return stored_environment_variables ();
        case Scope::Globals: return stored_globals_variables ();
        case Scope::Collection: return stored_collection_variables ();
        }
        return "";
    }

    int64_t stored_updated_at () {
        switch (GetParam ()) {
        case Scope::Environment: {
            auto row = db_->get_environment ("env_1");
            return row ? row->updated_at : 0;
        }
        case Scope::Globals: {
            auto row = db_->get_globals ();
            return row ? row->updated_at : 0;
        }
        case Scope::Collection: return stored_collection_updated_at ();
        }
        return 0;
    }
};

INSTANTIATE_TEST_SUITE_P (EveryWritableScope,
PersistAgainstAnotherWriterTest,
::testing::Values (Scope::Environment, Scope::Globals, Scope::Collection),
scope_name);

// The acceptance case: an edit made while the run was in flight and the
// run's own script write both reach disk. Persisting the run's snapshot
// instead reverts `region`.
TEST_P (PersistAgainstAnotherWriterTest, AnEditMadeDuringTheRunSurvivesTheRunsScriptWrite) {
    auto scopes = load ();
    add_region_from_another_client ();
    run_script (scopes, pm_scope () + ".set('token', 'from-the-run');");

    persist_script_variables (*db_, scopes);

    auto stored_now = json::parse (stored ());
    EXPECT_EQ (stored_now["token"]["value"], "from-the-run") << stored_now.dump ();
    EXPECT_EQ (stored_now["region"]["value"], "eu") << stored_now.dump ();
}

// No script write is no write at all, even though the row no longer matches
// what the run loaded (#135): the row stays exactly as the other client left
// it, `updated_at` included.
TEST_P (PersistAgainstAnotherWriterTest, ARunThatSetsNothingLeavesAnotherClientsEditAlone) {
    auto scopes = load ();
    add_region_from_another_client ();
    const std::string after_edit = stored ();
    const int64_t edited_at      = stored_updated_at ();

    persist_script_variables (*db_, scopes);

    EXPECT_EQ (stored (), after_edit);
    EXPECT_EQ (stored_updated_at (), edited_at);
}

// `set()` changes a value and nothing else, so only the value is carried: a
// flag another client changed on the same variable meanwhile survives.
TEST_P (PersistAgainstAnotherWriterTest, AValueSetKeepsAFlagAnotherClientChanged) {
    auto scopes                   = load ();
    auto variables                = json::parse (stored ());
    variables["token"]["enabled"] = false;
    write_from_another_client (variables);
    run_script (scopes, pm_scope () + ".set('token', 'from-the-run');");

    persist_script_variables (*db_, scopes);

    auto stored_now = json::parse (stored ());
    EXPECT_EQ (stored_now["token"]["value"], "from-the-run");
    EXPECT_EQ (stored_now["token"]["enabled"], false) << stored_now.dump ();
    EXPECT_EQ (stored_now["token"]["secret"], true);
    EXPECT_EQ (stored_now["token"]["createdAt"], 1784967810149LL);
}

// An `extract.*` write replaces the whole variable (`set_scope_variable`), so
// more than its value changed: the run's variable is written whole, not as a
// value onto the stored entry, while the variable another client added
// meanwhile still survives.
TEST_P (PersistAgainstAnotherWriterTest,
AWholeVariableReplacementIsWrittenWholeBesideAnotherClientsEdit) {
    auto scopes = load ();
    add_region_from_another_client ();
    written (scopes)["token"] = vayu::Variable{ "extracted", false, true, "string" };

    persist_script_variables (*db_, scopes);

    auto stored_now = json::parse (stored ());
    EXPECT_EQ (stored_now["token"]["value"], "extracted") << stored_now.dump ();
    EXPECT_EQ (stored_now["token"]["secret"], false) << stored_now.dump ();
    EXPECT_EQ (stored_now["token"]["type"], "string") << stored_now.dump ();
    EXPECT_FALSE (stored_now["token"].contains ("createdAt")) << stored_now.dump ();
    EXPECT_EQ (stored_now["region"]["value"], "eu") << stored_now.dump ();
}

// An unset removes the name the run loaded, and only that name: a variable
// another client added meanwhile is not the run's to remove.
TEST_P (PersistAgainstAnotherWriterTest, AnUnsetRemovesOnlyTheLoadedName) {
    auto scopes = load ();
    add_region_from_another_client ();
    run_script (scopes, pm_scope () + ".unset('token');");

    persist_script_variables (*db_, scopes);

    auto stored_now = json::parse (stored ());
    EXPECT_FALSE (stored_now.contains ("token")) << stored_now.dump ();
    EXPECT_EQ (stored_now["region"]["value"], "eu") << stored_now.dump ();
}

// `clear()` is an unset of every name the run loaded, never "store empty".
TEST_P (PersistAgainstAnotherWriterTest, AClearRemovesOnlyWhatTheRunLoaded) {
    auto scopes = load ();
    add_region_from_another_client ();
    run_script (scopes, pm_scope () + ".clear();");

    persist_script_variables (*db_, scopes);

    auto stored_now = json::parse (stored ());
    EXPECT_EQ (stored_now.size (), 1U) << stored_now.dump ();
    EXPECT_EQ (stored_now["region"]["value"], "eu") << stored_now.dump ();
}

// The read, the merge and the write are one lock scope: a second send
// persisting its own write into the window waits for this one to commit and
// then merges onto it. Without the lock it writes first and this persist,
// holding a read from before it, overwrites `session`.
TEST_P (PersistAgainstAnotherWriterTest, AnotherSendPersistingInsideTheWindowIsNotLost) {
    auto first                        = load ();
    auto second                       = load ();
    written (first)["token"].value    = "from-the-first-send";
    written (second)["session"].value = "from-the-second-send";

    vayu::tests::CompetingWriter other_send (
    [this, &second] { persist_script_variables (*db_, second); });
    persist_script_variables (*db_, first, other_send.probe ());
    other_send.join ();

    auto stored_now = json::parse (stored ());
    EXPECT_EQ (stored_now["token"]["value"], "from-the-first-send")
    << stored_now.dump ();
    EXPECT_EQ (stored_now["session"]["value"], "from-the-second-send")
    << stored_now.dump ();
}

// A row deleted while the run was in flight stays deleted: the persist edits
// a fresh read and has nothing to edit.
TEST_F (PersistScriptVariablesTest, ACollectionDeletedDuringTheRunIsNotRecreated) {
    auto scopes = load ();
    db_->delete_collection ("col_1");
    scopes.collection["cursor"].value = "abc";

    persist_script_variables (*db_, scopes);

    EXPECT_FALSE (db_->get_collection ("col_1").has_value ());
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
// collection only. If a read merged the chain into the writable map, the delta
// would report the ancestor's variables as set and write them into the leaf
// permanently.
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

    persist_script_variables (*db_, scopes);

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
    ASSERT_HAS_VALUE (root);
    EXPECT_EQ (root->updated_at, 1);
}

// ---------------------------------------------------------------------------
// secret_variable_values - what a run snapshot masks (#1803)
// ---------------------------------------------------------------------------

// Every scope a composition reads is searched, an ancestor included, and a
// disabled secret is still a secret. A non-secret value is never collected.
TEST (SecretVariableValues, CollectsEverySecretFlaggedValueAcrossTheScopes) {
    vayu::http::routes::ScriptVariableScopes scopes;
    scopes.globals["g"]         = vayu::Variable{ "global-secret", true, true };
    scopes.environment["e"]     = vayu::Variable{ "env-secret", true, false };
    scopes.environment["plain"] = vayu::Variable{ "not-a-secret", false, true };
    scopes.collection["c"]      = vayu::Variable{ "leaf-secret", true, true };
    scopes.collection_ancestors.push_back (
    { { "a", vayu::Variable{ "root-secret", true, true } },
    { "empty", vayu::Variable{ "", true, true } } });

    const auto values = vayu::http::routes::secret_variable_values (scopes);
    EXPECT_EQ (values,
    (std::vector<std::string>{ "global-secret", "env-secret", "leaf-secret", "root-secret" }));
}

} // namespace
