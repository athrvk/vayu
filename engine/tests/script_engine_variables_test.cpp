/**
 * @file script_engine_variables_test.cpp
 * @brief pm.environment and the variable scopes: pm.variables, pm.globals,
 *        pm.collectionVariables and the collection chain.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <regex>
#include <string>
#include <vector>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

// ============================================================================
// pm.environment Tests
// ============================================================================

TEST_F (ScriptEngineTest, EnvironmentGet) {
    auto result = engine.execute_test (R"(
        pm.test("Can get env var", function() {
            var baseUrl = pm.environment.get("base_url");
            pm.expect(baseUrl).to.equal("https://api.example.com");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, EnvironmentSet) {
    auto result = engine.execute_test (R"(
        pm.environment.set("new_var", "new_value");
        pm.test("Can set env var", function() {
            pm.expect(pm.environment.get("new_var")).to.equal("new_value");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (env["new_var"].value, "new_value");
}

// Regression for #110: pm.*.set() on an existing key must preserve the
// variable's secret flag and type - only the value changes (and `enabled` is
// ticked, see SetOnADisabledRowMakesItReadable). The pre-fix whole-record
// replace silently un-masked a secret variable in the UI and reset its type.
// Mutation-check: restore the Variable{value,false,true} assignment in
// set_variable_preserving and the secret/type asserts here fail.
TEST_F (ScriptEngineTest, SetPreservesSecretFlagAndType) {
    env["token"] = Variable{ "old", true, true, "json" };

    auto result = engine.execute_test (R"(
        pm.environment.set("token", "rotated");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (env["token"].value, "rotated"); // value updated
    EXPECT_TRUE (env["token"].secret);         // secret preserved
    EXPECT_TRUE (env["token"].enabled);
    EXPECT_EQ (env["token"].type, "json"); // type preserved
}

// #2479: a set is a write of a value the script means to use, so it ticks a row
// the user had unticked. Left unticked, the script's own get/has/replaceIn and
// the execute-time residual pass look past the row it just wrote.
TEST_F (ScriptEngineTest, SetOnADisabledRowMakesItReadable) {
    env["token"] = Variable{ "old", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('token', 'new');
        pm.environment.set('got', String(pm.environment.get('token')));
        pm.environment.set('has', String(pm.environment.has('token')));
        pm.environment.set('repl', pm.variables.replaceIn('[{{token}}]'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["got"].value, "new");
    EXPECT_EQ (env["has"].value, "true");
    EXPECT_EQ (env["repl"].value, "[new]");
    EXPECT_TRUE (env["token"].enabled);
}

// Ticking the row changes nothing else about it.
TEST_F (ScriptEngineTest, SetOnADisabledRowKeepsItsSecretFlagTypeAndCreationTime) {
    Variable disabled{ "old", true, false, "json" };
    disabled.created_at = 1784967810149;
    env["token"]        = disabled;

    auto result =
    engine.execute_prerequest ("pm.environment.set('token', 'new');", request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["token"].value, "new");
    EXPECT_TRUE (env["token"].enabled);
    EXPECT_TRUE (env["token"].secret);
    EXPECT_EQ (env["token"].type, "json");
    EXPECT_EQ (env["token"].created_at, 1784967810149);
}

// The same for the other two scopes' setters, which share the helper.
TEST_F (ScriptEngineTest, GlobalsAndCollectionSetOnADisabledRowMakeItReadable) {
    Environment globals;
    globals["g"] = Variable{ "old", false, false };
    Environment collVars;
    collVars["c"] = Variable{ "old", false, false };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('g', 'new-g');
        pm.collectionVariables.set('c', 'new-c');
        pm.environment.set('gGot', String(pm.globals.get('g')));
        pm.environment.set('cGot', String(pm.collectionVariables.get('c')));
        pm.environment.set('repl', pm.variables.replaceIn('{{g}}/{{c}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (globals["g"].enabled);
    EXPECT_TRUE (collVars["c"].enabled);
    EXPECT_EQ (env["gGot"].value, "new-g");
    EXPECT_EQ (env["cGot"].value, "new-c");
    EXPECT_EQ (env["repl"].value, "new-g/new-c");
}

// A set lands in the leaf: a row an ancestor collection holds unticked stays
// as it was, and the leaf gains its own enabled key.
TEST_F (ScriptEngineTest, CollectionSetOverADisabledAncestorRowLandsEnabledInTheLeaf) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, false };
    Environment leaf;
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('before', String(pm.collectionVariables.has('token')));
        pm.collectionVariables.set('token', 'from-leaf');
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["before"].value, "false");
    EXPECT_EQ (globals["after"].value, "from-leaf");
    ASSERT_EQ (leaf.count ("token"), 1U);
    EXPECT_TRUE (leaf["token"].enabled);
    EXPECT_EQ (leaf["token"].value, "from-leaf");
    EXPECT_EQ (ancestors[0]["token"].value, "from-root");
    EXPECT_FALSE (ancestors[0]["token"].enabled);
}

// A brand-new key still gets the current defaults (not secret, enabled, string).
TEST_F (ScriptEngineTest, SetNewKeyGetsDefaults) {
    auto result = engine.execute_test (R"(
        pm.environment.set("fresh", "value");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_TRUE (env.count ("fresh"));
    EXPECT_EQ (env["fresh"].value, "value");
    EXPECT_FALSE (env["fresh"].secret);
    EXPECT_TRUE (env["fresh"].enabled);
    EXPECT_EQ (env["fresh"].type, "string");
}

// Guards that the collectionVariables setter is wired to the shared helper too
// (all three setters must preserve, not just pm.environment).
TEST_F (ScriptEngineTest, CollectionVariableSetPreservesSecretFlagAndType) {
    Environment collVars;
    collVars["cv_token"] = Variable{ "old", true, true, "json" };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.response            = &response;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"(
        pm.collectionVariables.set("cv_token", "rotated");
    )",
    ctx);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (collVars["cv_token"].value, "rotated");
    EXPECT_TRUE (collVars["cv_token"].secret);
    EXPECT_EQ (collVars["cv_token"].type, "json");
}

// ============================================================================
// The `pm` surface the docs and the app teach
// ============================================================================
//
// Same reason as the two above: a name that is written down but not installed
// throws in the user's face, and nothing else notices. `scripting.md` taught
// `pm.variables` and the Tests panel's quick reference taught
// `pm.response.headers.get()`; neither had ever existed. `pm.variables` has
// since been built (#184), so the tests below now pin it as *present* and its
// documented precedence; `pm.response.headers.get()` is still absent and stays
// pinned that way, so implementing it flips a test red and forces the doc to be
// rewritten with it.

// Every scope answers the same six names, and the merged accessor exists (#184).
// This is the list both script docs promise, checked against the runtime rather
// than against itself - a method dropped from setup_pm_variable_scope shows up
// here as a name, not as a mysteriously undefined call somewhere downstream.
TEST_F (ScriptEngineTest, EveryVariableScopeExposesTheSameSurfaceAndPmVariablesExists) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        var scopes = ['environment', 'globals', 'collectionVariables'];
        var methods = ['get', 'set', 'has', 'unset', 'clear', 'toObject'];
        for (var i = 0; i < scopes.length; i++) {
            var scope = pm[scopes[i]];
            if (!scope) { missing.push(scopes[i]); continue; }
            for (var j = 0; j < methods.length; j++) {
                if (typeof scope[methods[j]] !== 'function') {
                    missing.push(scopes[i] + '.' + methods[j]);
                }
            }
        }
        // The merged accessor reads across scopes; it deliberately has no
        // unset/clear, since it owns no scope to remove a name from.
        var merged = ['get', 'has', 'toObject', 'replaceIn', 'set'];
        for (var k = 0; k < merged.length; k++) {
            if (!pm.variables || typeof pm.variables[merged[k]] !== 'function') {
                missing.push('variables.' + merged[k]);
            }
        }
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "a variable-scope method both script docs teach is not installed";
}

TEST_F (ScriptEngineTest, HasIsTrueOnlyForAVariableGetCanRead) {
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('present', String(pm.environment.has('base_url')));
        pm.environment.set('absent', String(pm.environment.has('nope')));
        // A row the user unticked reads as absent, the same way get() skips it.
        pm.environment.set('disabledIsHidden', String(pm.environment.has('disabled')));
        pm.environment.set('noArgument', String(pm.environment.has()));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["present"].value, "true");
    EXPECT_EQ (env["absent"].value, "false");
    EXPECT_EQ (env["disabledIsHidden"].value, "false");
    EXPECT_EQ (env["noArgument"].value, "false");
}

// The method with no workaround before #184: setting a variable to "" leaves an
// enabled empty variable behind, which {{template}} resolution still finds.
TEST_F (ScriptEngineTest, UnsetRemovesTheVariableRatherThanEmptyingIt) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.unset('api_key');
        pm.environment.set('readBack', String(pm.environment.get('api_key')));
        pm.environment.unset('never_existed');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("api_key"), 0U) << "the key is still in the map";
    EXPECT_EQ (env["readBack"].value, "undefined");
}

// A disabled variable is invisible to get/has but is still a key, so unset and
// clear remove it - they were asked to delete a name, not to read one.
TEST_F (ScriptEngineTest, UnsetAndClearRemoveDisabledVariablesToo) {
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.unset('disabled');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("disabled"), 0U);
}

TEST_F (ScriptEngineTest, ClearEmptiesOnlyItsOwnScope) {
    Environment globals;
    globals["g"] = Variable{ "kept", false, true };
    Environment collVars;
    collVars["c"] = Variable{ "kept", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.environment.clear();
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (env.empty ());
    EXPECT_EQ (globals.size (), 1U)
    << "clear() reached a scope it was not called on";
    EXPECT_EQ (collVars.size (), 1U);
}

TEST_F (ScriptEngineTest, ToObjectSnapshotsEnabledVariablesWithTheirDeclaredTypes) {
    env["count"]    = Variable{ "42", false, true, "number" };
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        var snapshot = pm.environment.toObject();
        pm.environment.set('baseUrl', snapshot['base_url']);
        // Cast by declared type, exactly as get() would answer it.
        pm.environment.set('countType', typeof snapshot['count']);
        pm.environment.set('hasDisabled', String('disabled' in snapshot));
        // A snapshot, not a view: writing to it must not reach the scope.
        snapshot['base_url'] = 'mutated';
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["baseUrl"].value, "https://api.example.com");
    EXPECT_EQ (env["countType"].value, "number");
    EXPECT_EQ (env["hasDisabled"].value, "false");
    EXPECT_EQ (env["base_url"].value, "https://api.example.com")
    << "toObject() handed out a live view of the scope";
}

// The precedence pm.variables resolves in - environment, then collection, then
// global - is the order {{name}} already uses app-side, so a script and a URL
// in the same request cannot read one name two ways.
TEST_F (ScriptEngineTest, PmVariablesResolvesEnvironmentThenCollectionThenGlobal) {
    Environment globals;
    globals["everywhere"]  = Variable{ "from-globals", false, true };
    globals["only_global"] = Variable{ "global-only", false, true };
    Environment collVars;
    collVars["everywhere"] = Variable{ "from-collection", false, true };
    collVars["in_two"]     = Variable{ "from-collection", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "from-environment", false, true };
    environment["disabled"]   = Variable{ "hidden", false, false };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('winner', String(pm.variables.get('everywhere')));
        pm.globals.set('lowestOnly', String(pm.variables.get('only_global')));
        pm.globals.set('middle', String(pm.variables.get('in_two')));
        pm.globals.set('nowhere', String(pm.variables.get('missing')));
        pm.globals.set('hasLowest', String(pm.variables.has('only_global')));
        pm.globals.set('hasNowhere', String(pm.variables.has('missing')));
        // A disabled variable is not a hit, so resolution keeps looking.
        pm.globals.set('hasDisabled', String(pm.variables.has('disabled')));
        var merged = pm.variables.toObject();
        pm.globals.set('mergedWinner', String(merged['everywhere']));
        pm.globals.set('mergedKeeps', String(merged['only_global']));
        pm.globals.set('mergedHasDisabled', String('disabled' in merged));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["winner"].value, "from-environment");
    EXPECT_EQ (globals["middle"].value, "from-collection");
    EXPECT_EQ (globals["lowestOnly"].value, "global-only");
    EXPECT_EQ (globals["nowhere"].value, "undefined");
    EXPECT_EQ (globals["hasLowest"].value, "true");
    EXPECT_EQ (globals["hasNowhere"].value, "false");
    EXPECT_EQ (globals["hasDisabled"].value, "false");
    // The merged snapshot agrees with get() name for name, or it is a second
    // answer to the same question.
    EXPECT_EQ (globals["mergedWinner"].value, "from-environment");
    EXPECT_EQ (globals["mergedKeeps"].value, "global-only");
    EXPECT_EQ (globals["mergedHasDisabled"].value, "false");
}

// pm.variables.replaceIn - the sanctioned way to use {{...}} inside a script
// (script *text* is never interpolated; see D16 in issue #226). Semantics must
// match the engine's compose-time resolver: same precedence, same unknown-name
// rule, same nested resolution, raw stored strings.
TEST_F (ScriptEngineTest, ReplaceInResolvesScopesLikeTheRequestFieldsDo) {
    Environment globals;
    globals["everywhere"] = Variable{ "from-globals", false, true };
    Environment collVars;
    collVars["everywhere"] = Variable{ "from-collection", false, true };
    collVars["nested"]     = Variable{ "{{everywhere}}", false, true };
    collVars["selfRef"]    = Variable{ "{{selfRef}}", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "from-environment", false, true };
    environment["disabled"]   = Variable{ "hidden", false, false };
    environment["$guid"]      = Variable{ "pinned-guid", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('winner', pm.variables.replaceIn('{{everywhere}}'));
        pm.globals.set('unknownPlain', pm.variables.replaceIn('[{{missing}}]'));
        pm.globals.set('unknownDollar', pm.variables.replaceIn('{{$notAGenerator}}'));
        pm.globals.set('definedDollar', pm.variables.replaceIn('{{$guid}}'));
        pm.globals.set('disabledIsInvisible', pm.variables.replaceIn('[{{disabled}}]'));
        // Nested, like every other {{}} in Vayu since #1009: a value that
        // itself holds {{other}} resolves through it, to the same bound.
        pm.globals.set('nestedResolves', pm.variables.replaceIn('{{nested}}'));
        pm.globals.set('cycleStopsLiteral', pm.variables.replaceIn('{{selfRef}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["winner"].value, "from-environment");
    // Both halves of #1009's unknown-name rule: the token is what a script
    // gets back, so a name nothing defines is visible rather than vanished.
    EXPECT_EQ (globals["unknownPlain"].value, "[{{missing}}]");
    EXPECT_EQ (globals["unknownDollar"].value, "{{$notAGenerator}}");
    EXPECT_EQ (globals["definedDollar"].value, "pinned-guid");
    EXPECT_EQ (globals["disabledIsInvisible"].value, "[{{disabled}}]");
    EXPECT_EQ (globals["nestedResolves"].value, "from-environment");
    EXPECT_EQ (globals["cycleStopsLiteral"].value, "{{selfRef}}");
}

// The identity namespace inside replaceIn (issue #1057). It resolves here for
// one reason: the request beside this script was already bound with these two
// numbers, so a token left written would make the script and the wire disagree
// about one send. Reserved ahead of every scope, exactly as at composition.
TEST_F (ScriptEngineTest, ReplaceInResolvesTheIdentityTheRequestBesideItWasBoundWith) {
    Environment globals;
    Environment environment;
    // A variable someone named `$vu` cannot answer for the identity - the same
    // rule composition holds, and what makes the name bindable at all.
    environment["$vu"] = Variable{ "from-environment", false, true };

    ScriptContext ctx;
    ctx.request     = &request;
    ctx.environment = &environment;
    ctx.globals     = &globals;
    ctx.vu          = 7;
    ctx.iteration   = 3;

    auto result = engine.execute (R"JS(
        pm.globals.set('vu', pm.variables.replaceIn('user-{{$vu}}@example.com'));
        pm.globals.set('iteration', pm.variables.replaceIn('{{$iteration}}'));
        // A `$name` that only looks like the identity follows the
        // unknown-$name rule, here as at composition.
        pm.globals.set('nearMiss', pm.variables.replaceIn('{{$vus}}'));
        // The two APIs answer one question about one send, so they agree.
        pm.globals.set('agreesWithInfo',
            String(pm.variables.replaceIn('{{$vu}}') === String(pm.info.vu)));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["vu"].value, "user-7@example.com");
    EXPECT_EQ (globals["iteration"].value, "3");
    EXPECT_EQ (globals["nearMiss"].value, "{{$vus}}");
    EXPECT_EQ (globals["agreesWithInfo"].value, "true");
}

// The other direction of the same rule: a send that is nobody's iteration
// still binds `1` and `0` into its request (`POST /execute`, issue #994), so
// that is what replaceIn answers. `pm.info` stays absent there, and that is not
// a disagreement - it answers which iteration of which run this is, and there
// is no run.
TEST_F (ScriptEngineTest, ReplaceInAnswersTheRunOfOneWhereNothingSetsTheIdentity) {
    Environment globals;

    ScriptContext ctx;
    ctx.request = &request;
    ctx.globals = &globals;

    auto result = engine.execute (R"JS(
        pm.globals.set('vu', pm.variables.replaceIn('{{$vu}}'));
        pm.globals.set('iteration', pm.variables.replaceIn('{{$iteration}}'));
        pm.globals.set('infoIsAbsent', String(typeof pm.info.vu === 'undefined'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["vu"].value, "1");
    EXPECT_EQ (globals["iteration"].value, "0");
    EXPECT_EQ (globals["infoIsAbsent"].value, "true");
}

// Both reserved namespaces in one resolution, which is the case the shared
// resolver exists for: a row bound beside the identity, and a column a file
// happens to name `$vu` losing to the reserved name rather than answering for
// it.
TEST_F (ScriptEngineTest, ReplaceInReadsTheIdentityAheadOfABoundRowsColumns) {
    Environment globals;
    const nlohmann::json row = { { "$vu", "from-the-row" }, { "id", "42" } };

    ScriptContext ctx;
    ctx.request        = &request;
    ctx.globals        = &globals;
    ctx.iteration_data = &row;
    ctx.vu             = 2;
    ctx.iteration      = 5;

    auto result = engine.execute (R"JS(
        pm.globals.set('both', pm.variables.replaceIn('{{$vu}}/{{$iteration}}/{{data.id}}/{{id}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["both"].value, "2/5/42/42");
}

// ============================================================================
// The collection chain in a script (issue #234)
//
// `{{name}}` has always walked the whole collection ancestor chain, while the
// script scopes saw the request's immediate parent alone - so the same name,
// and after replaceIn the same *notation*, answered differently in a URL and
// in a script. These pin the walk: reads see the chain, writes stay on the
// leaf.
// ============================================================================

TEST_F (ScriptEngineTest, CollectionReadsWalkTheAncestorChain) {
    // Collections API (root) -> Users (leaf); the request lives in Users.
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"]     = Variable{ "from-root", false, true };
    ancestors[0]["root_only"] = Variable{ "root-value", false, true };
    Environment leaf;
    leaf["leaf_only"] = Variable{ "leaf-value", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('inherited', String(pm.collectionVariables.get('token')));
        pm.globals.set('hasInherited', String(pm.collectionVariables.has('token')));
        pm.globals.set('ownKey', String(pm.collectionVariables.get('leaf_only')));
        var snapshot = pm.collectionVariables.toObject();
        pm.globals.set('snapshotInherited', String(snapshot['token']));
        pm.globals.set('snapshotOwn', String(snapshot['leaf_only']));
        // The merged accessor and {{}} resolution ride on the same walk.
        pm.globals.set('merged', String(pm.variables.get('root_only')));
        pm.globals.set('replaced', pm.variables.replaceIn('{{token}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["inherited"].value, "from-root");
    EXPECT_EQ (globals["hasInherited"].value, "true");
    EXPECT_EQ (globals["ownKey"].value, "leaf-value");
    EXPECT_EQ (globals["snapshotInherited"].value, "from-root");
    EXPECT_EQ (globals["snapshotOwn"].value, "leaf-value");
    EXPECT_EQ (globals["merged"].value, "root-value");
    // The whole point of the issue: {{token}} in the URL and replaceIn in the
    // script must not answer one name two ways.
    EXPECT_EQ (globals["replaced"].value, "from-root");
}

// Inheritance can be shadowed from below but not deleted from below. `set` on
// the leaf hides the ancestor's value; `unset` removes the leaf's copy and the
// ancestor's shows through again.
TEST_F (ScriptEngineTest, TheLeafShadowsAnAncestorAndUnsetUnShadowsIt) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, true };
    Environment leaf;
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('before', String(pm.collectionVariables.get('token')));
        pm.collectionVariables.set('token', 'from-leaf');
        pm.globals.set('shadowed', String(pm.collectionVariables.get('token')));
        pm.collectionVariables.unset('token');
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
        pm.globals.set('stillThere', String(pm.collectionVariables.has('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["before"].value, "from-root");
    EXPECT_EQ (globals["shadowed"].value, "from-leaf");
    EXPECT_EQ (globals["after"].value, "from-root");
    EXPECT_EQ (globals["stillThere"].value, "true");
    // The write landed on the leaf and the unset took it away again; the
    // ancestor was never a write target.
    EXPECT_EQ (leaf.count ("token"), 0U);
    EXPECT_EQ (ancestors[0]["token"].value, "from-root");
}

// The copy-down hazard #226 kept D2 open for, at the map level: a script that
// reads an inherited name and then writes must leave the leaf map holding its
// own variables only. persist_script_variables writes every name that map
// gained since it was loaded, so anything the walk leaked into it would be
// written into the leaf collection permanently.
TEST_F (ScriptEngineTest, WritingTheCollectionScopeNeverCopiesAnAncestorIntoTheLeaf) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["inherited"] = Variable{ "from-root", false, true };
    Environment leaf;
    leaf["own"] = Variable{ "leaf-value", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('read', String(pm.collectionVariables.get('inherited')));
        pm.collectionVariables.set('fresh', 'written');
        pm.collectionVariables.unset('missing');
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["read"].value, "from-root");
    EXPECT_EQ (leaf.count ("inherited"), 0U)
    << "an ancestor's variable was copied down into the leaf collection";
    EXPECT_EQ (leaf.size (), 2U); // own + fresh, nothing inherited
    EXPECT_EQ (ancestors[0].size (), 1U);
}

// clear() is the destructive twin of the copy-down: emptying the leaf must not
// reach up the chain, and the inherited names it was hiding come back.
TEST_F (ScriptEngineTest, ClearEmptiesTheLeafAndLeavesAncestorsIntact) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, true };
    Environment leaf;
    leaf["token"] = Variable{ "from-leaf", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.collectionVariables.clear();
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (leaf.empty ());
    EXPECT_EQ (ancestors[0].size (), 1U) << "clear() reached up the chain";
    EXPECT_EQ (globals["after"].value, "from-root");
}

// Precedence across the whole stack: environment beats any collection, and
// within the collections the nearest definition wins. A disabled row is looked
// past wherever it sits, so unticking a name in the leaf falls through to the
// ancestor rather than hiding it.
TEST_F (ScriptEngineTest, PrecedenceRunsEnvironmentThenLeafThenAncestorThenGlobals) {
    std::vector<Environment> ancestors (2);
    ancestors[0]["depth"]     = Variable{ "root", false, true }; // root
    ancestors[0]["only_root"] = Variable{ "root-only", false, true };
    ancestors[0]["unticked"]  = Variable{ "root-value", false, true };
    ancestors[1]["depth"]     = Variable{ "middle", false, true }; // middle
    Environment leaf;
    leaf["unticked"] = Variable{ "leaf-value", false, false }; // disabled
    Environment globals;
    globals["depth"] = Variable{ "globals", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "environment", false, true };
    leaf["everywhere"]        = Variable{ "leaf", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('nearest', String(pm.collectionVariables.get('depth')));
        pm.globals.set('farthest', String(pm.collectionVariables.get('only_root')));
        pm.globals.set('acrossScopes', String(pm.variables.get('everywhere')));
        // The leaf's row is unticked, so the read keeps walking.
        pm.globals.set('unticked', String(pm.collectionVariables.get('unticked')));
        var merged = pm.variables.toObject();
        pm.globals.set('mergedNearest', String(merged['depth']));
        pm.globals.set('mergedAcross', String(merged['everywhere']));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["nearest"].value, "middle");
    EXPECT_EQ (globals["farthest"].value, "root-only");
    EXPECT_EQ (globals["acrossScopes"].value, "environment");
    EXPECT_EQ (globals["unticked"].value, "root-value");
    // The snapshot must agree with get() name for name, or it is a second
    // answer to the same question.
    EXPECT_EQ (globals["mergedNearest"].value, "middle");
    EXPECT_EQ (globals["mergedAcross"].value, "environment");
}

// A run that carries no chain at all - every request outside a nested
// collection - must behave exactly as it did before the walk existed.
TEST_F (ScriptEngineTest, ANullAncestorListReadsAsNoChainRatherThanThrowing) {
    Environment leaf;
    leaf["token"] = Variable{ "from-leaf", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf; // collectionAncestors stays null

    auto result = engine.execute (R"JS(
        pm.globals.set('own', String(pm.collectionVariables.get('token')));
        pm.globals.set('missing', String(pm.collectionVariables.get('nowhere')));
        pm.globals.set('snapshotKeys', String(Object.keys(pm.collectionVariables.toObject()).length));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["own"].value, "from-leaf");
    EXPECT_EQ (globals["missing"].value, "undefined");
    EXPECT_EQ (globals["snapshotKeys"].value, "1");
}

TEST_F (ScriptEngineTest, ReplaceInGeneratesDynamicVariablesPerOccurrence) {
    auto result = engine.execute_prerequest (R"JS(
        var pair = pm.variables.replaceIn('{{$guid}}|{{$guid}}').split('|');
        pm.environment.set('a', pair[0]);
        pm.environment.set('b', pair[1]);
        pm.environment.set('ts', pm.variables.replaceIn('{{$timestamp}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    const std::regex uuid_v4 (
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    EXPECT_TRUE (std::regex_match (env["a"].value, uuid_v4)) << env["a"].value;
    EXPECT_TRUE (std::regex_match (env["b"].value, uuid_v4)) << env["b"].value;
    // Once per occurrence - two {{$guid}} in one template are two ids.
    EXPECT_NE (env["a"].value, env["b"].value);
    EXPECT_FALSE (env["ts"].value.empty ());
}

// The map is built at call time, so - unlike {{}} in the URL, which was
// composed before the script started (D1) - a value the script itself just
// set resolves. This is the property that makes replaceIn useful for
// building signed payloads mid-script.
TEST_F (ScriptEngineTest, ReplaceInSeesAVariableSetEarlierInTheSameScript) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('minted', 'fresh-value');
        pm.environment.set('resolved', pm.variables.replaceIn('{{minted}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["resolved"].value, "fresh-value");
}

TEST_F (ScriptEngineTest, ReplaceInRejectsANonStringArgument) {
    for (const char* bad : { "pm.variables.replaceIn()", "pm.variables.replaceIn(42)",
         "pm.variables.replaceIn(undefined)", "pm.variables.replaceIn({})" }) {
        auto result = engine.execute_prerequest (bad, request, env);
        EXPECT_FALSE (result.success) << bad;
        EXPECT_NE (result.error_message.find ("replaceIn expects a string"), std::string::npos)
        << bad << " -> " << result.error_message;
    }
}

// pm.environment / pm.globals / pm.collectionVariables .replaceIn (#3133):
// Postman resolves against the scope it is called on and nothing else. Every
// scope holds a `shared` name and one of its own, the other scopes and the
// run-local scope hold their own values too, and the template names them all,
// so the answer shows which maps were read: a name only another scope defines
// stays `{{name}}`, a disabled row is invisible, and the collection scope alone
// reads its ancestors.
//
// Mutation-check: leave the binding off `setup_pm_variable_scope` and every
// case throws "not a function"; hand the resolver the merged map instead and
// each scope answers the others' names.
TEST_F (ScriptEngineTest, ScopedReplaceInResolvesFromItsOwnScopeAndNoOther) {
    struct ScopeCase {
        const char* accessor;
        const char* expected;
    };
    const std::array<ScopeCase, 3> cases{ {
    { "environment",
    "from-environment|e1|{{globalsOnly}}|{{collOnly}}|"
    "{{localOnly}}|{{hidden}}|{{ancestorOnly}}" },
    { "globals",
    "from-globals|{{envOnly}}|g1|{{collOnly}}|{{localOnly}}|"
    "{{hidden}}|{{ancestorOnly}}" },
    { "collectionVariables",
    "from-collection|{{envOnly}}|{{globalsOnly}}|"
    "c1|{{localOnly}}|{{hidden}}|from-ancestor" },
    } };

    for (const auto& scope : cases) {
        Environment environment;
        environment["shared"]  = Variable{ "from-environment", false, true };
        environment["envOnly"] = Variable{ "e1", false, true };
        environment["hidden"]  = Variable{ "env-hidden", false, false };
        Environment globals;
        globals["shared"]      = Variable{ "from-globals", false, true };
        globals["globalsOnly"] = Variable{ "g1", false, true };
        globals["hidden"]      = Variable{ "globals-hidden", false, false };
        Environment collVars;
        collVars["shared"]   = Variable{ "from-collection", false, true };
        collVars["collOnly"] = Variable{ "c1", false, true };
        collVars["hidden"]   = Variable{ "coll-hidden", false, false };
        Environment local;
        local["shared"]    = Variable{ "from-local", false, true };
        local["localOnly"] = Variable{ "l1", false, true };
        Environment ancestor;
        ancestor["shared"]       = Variable{ "from-ancestor", false, true };
        ancestor["ancestorOnly"] = Variable{ "from-ancestor", false, true };
        const std::vector<Environment> ancestors{ ancestor };

        ScriptContext ctx;
        ctx.request             = &request;
        ctx.environment         = &environment;
        ctx.globals             = &globals;
        ctx.collectionVariables = &collVars;
        ctx.collectionAncestors = &ancestors;
        ctx.local               = &local;

        auto result =
        engine.execute (std::string ("pm.variables.set('out', pm.") + scope.accessor +
        ".replaceIn('{{shared}}|{{envOnly}}|{{globalsOnly}}|{{collOnly}}|"
        "{{localOnly}}|{{hidden}}|{{ancestorOnly}}'));",
        ctx);

        ASSERT_TRUE (result.success) << scope.accessor << ": " << result.error_message;
        EXPECT_EQ (local["out"].value, scope.expected) << scope.accessor;
    }
}

// What is not a scope answers on a scoped replaceIn exactly as it does on
// pm.variables.replaceIn: the dynamic names, the iteration identity and a bound
// row. The row sits above the scope's own value, and the run-local scope, which
// is a scope of its own, stays out even where it outranks the row on the merged
// path.
TEST_F (ScriptEngineTest, ScopedReplaceInStillAnswersTheNamesThatAreNotScopes) {
    const nlohmann::json row{ { "city", "Portland" }, { "userId", "1001" } };

    for (const char* accessor : { "environment", "globals", "collectionVariables" }) {
        Environment environment;
        Environment globals;
        Environment collVars;
        Environment local;
        local["userId"]         = Variable{ "from-local", false, true };
        Environment* under_test = &collVars;
        if (std::string (accessor) == "environment") {
            under_test = &environment;
        } else if (std::string (accessor) == "globals") {
            under_test = &globals;
        }
        (*under_test)["userId"]    = Variable{ "from-scope", false, true };
        (*under_test)["scopeOnly"] = Variable{ "s1", false, true };

        ScriptContext ctx;
        ctx.request             = &request;
        ctx.environment         = &environment;
        ctx.globals             = &globals;
        ctx.collectionVariables = &collVars;
        ctx.local               = &local;
        ctx.iteration_data      = &row;
        ctx.vu                  = 7;
        ctx.iteration           = 3;

        const std::string call = std::string ("pm.") + accessor + ".replaceIn";
        std::string script = "var pair = " + call + "('{{$guid}}|{{$guid}}').split('|');\n";
        script += "pm.variables.set('first', pair[0]);\n";
        script += "pm.variables.set('second', pair[1]);\n";
        script += "pm.variables.set('rest', " + call;
        script +=
        "('{{$vu}}/{{$iteration}}/{{data.city}}/{{userId}}/{{scopeOnly}}'));";
        auto result = engine.execute (script, ctx);

        ASSERT_TRUE (result.success) << accessor << ": " << result.error_message;
        const std::regex uuid_v4 ("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]"
                                  "[0-9a-f]{3}-[0-9a-f]{12}$");
        EXPECT_TRUE (std::regex_match (local["first"].value, uuid_v4))
        << accessor << ": " << local["first"].value;
        EXPECT_TRUE (std::regex_match (local["second"].value, uuid_v4))
        << accessor << ": " << local["second"].value;
        EXPECT_NE (local["first"].value, local["second"].value) << accessor;
        EXPECT_EQ (local["rest"].value, "7/3/Portland/1001/s1") << accessor;
    }
}

// The refusals name the call the script wrote, not pm.variables.replaceIn.
TEST_F (ScriptEngineTest, ScopedReplaceInRefusesWhatTheMergedOneRefusesUnderItsOwnName) {
    const nlohmann::json row{ { "userId", "1001" } };

    for (const char* accessor : { "environment", "globals", "collectionVariables" }) {
        const std::string call = std::string ("pm.") + accessor + ".replaceIn";

        for (const char* argument : { "", "42", "undefined", "{}" }) {
            auto result =
            engine.execute_prerequest (call + "(" + argument + ")", request, env);
            EXPECT_FALSE (result.success) << call << "(" << argument << ")";
            EXPECT_NE (result.error_message.find (call + " expects a string"),
            std::string::npos)
            << call << "(" << argument << ") -> " << result.error_message;
        }

        ScriptContext ctx;
        ctx.request        = &request;
        ctx.iteration_data = &row;
        auto missing       = engine.execute (call + "('{{data.nosuch}}')", ctx);
        EXPECT_FALSE (missing.success) << call;
        EXPECT_NE (missing.error_message.find (call + ": {{data.nosuch}} names a column"),
        std::string::npos)
        << call << " -> " << missing.error_message;
        EXPECT_NE (missing.error_message.find ("columns: userId"), std::string::npos)
        << call << " -> " << missing.error_message;
    }
}

// pm.variables.set writes the local scope (#2564), never a named one. A context
// that binds no local scope - this convenience entry point binds only the
// environment - still gives the script one for its own duration, so the write
// reads back rather than reporting success and landing nowhere.
TEST_F (ScriptEngineTest, PmVariablesSetWritesTheLocalScopeAndNoNamedOne) {
    env["token"] = Variable{ "from-env", false, true };

    auto result = engine.execute_prerequest (R"JS(
        pm.variables.set('token', 'local');
        pm.environment.set('read', pm.variables.get('token'));
        pm.environment.set('replaced', pm.variables.replaceIn('{{token}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["read"].value, "local");
    EXPECT_EQ (env["replaced"].value, "local");
    EXPECT_EQ (env["token"].value, "from-env")
    << "the local write reached the environment";
}

// A run can be given fewer than three scopes - a design run with no active
// environment, for instance. Every method has to read that as an empty scope: a
// script cannot see which scopes it was handed, so a throw here would fail it
// for a reason its author cannot inspect.
TEST_F (ScriptEngineTest, AScopeTheRunDoesNotCarryBehavesAsEmptyRatherThanThrowing) {
    ScriptContext ctx;
    ctx.request     = &request;
    ctx.environment = &env; // globals and collectionVariables stay null

    auto result = engine.execute (R"JS(
        pm.globals.set('ignored', 'value');
        pm.globals.unset('ignored');
        pm.globals.clear();
        pm.environment.set('absentGet', String(pm.globals.get('anything')));
        pm.environment.set('absentHas', String(pm.globals.has('anything')));
        pm.environment.set('absentKeys', Object.keys(pm.globals.toObject()).join(','));
        pm.environment.set('mergedStillReads', String(pm.variables.get('base_url')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["absentGet"].value, "undefined");
    EXPECT_EQ (env["absentHas"].value, "false");
    EXPECT_EQ (env["absentKeys"].value, "");
    EXPECT_EQ (env["mergedStillReads"].value, "https://api.example.com");
}

// `pm.response.body` never existed - `setup_pm_response` binds json(), text(),
// reason(), size() and headers, and no `body` property - but scripting.md
// documented it as "Raw body string" for long enough that someone would write
// it and read `undefined` (issue #112). The doc line is gone; this pins the
// contract so a future `body` binding has to be a deliberate change that
// updates the docs with it, rather than quietly making the old line true again.
TEST_F (ScriptEngineTest, ResponseExposesTextNotABodyProperty) {
    response.body = R"({"n":1})";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('bodyType', typeof pm.response.body);
        pm.test("text() is how a script reads the body", function() {
            pm.expect(pm.response.text()).to.equal('{"n":1}');
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["bodyType"].value, "undefined");
}
