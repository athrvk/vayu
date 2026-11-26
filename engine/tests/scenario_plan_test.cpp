/**
 * @file tests/scenario_plan_test.cpp
 * @brief Tests for scenario plan resolution (issue #352, phase 1 of the
 * collection runner).
 *
 * Three contracts are pinned here, and each of them is one a later phase builds
 * on rather than a detail of this one:
 *
 *  - **Ordering.** The order the sidebar displays: direct requests by
 *    `requests.order`, and - recursively - a collection's sub-folders and
 *    requests as one sibling list (#2535), a request where it sits and a
 *    sub-folder's whole subtree where the sub-folder sits, depth-first. Driven
 *    case by case from
 *    `fixtures/recursive-run-order-conformance.json`, which the renderer's
 *    `CollectionTree.run-order.conformance.test.tsx` reads as well, so the run
 *    and the tree cannot disagree without one of the two suites failing (issue
 *    #431). A `parent_id` cycle terminates instead of hanging the DB mutex.
 *  - **No second copy of composition.** A step's request and joined scripts
 *    equal what `POST /compose` returns for the same `requestId`, so a Send and
 *    a scenario step cannot drift apart.
 *  - **The snapshot manifest is credential-free.** It records the *stored* URL
 *    and no `Authorization` header, which is the decision the whole
 *    "never persist the composed plan" rule rests on.
 *
 * Plus every row of the issue's robustness table: each is a loud `400`, never a
 * silently smaller run.
 *
 * DB-backed tests drive the extracted core against a real database file, no
 * in-process HTTP server - the same shape as the suite's other route tests. The
 * `ScenarioPlanTest` fixture is in `scenario_plan_fixture.hpp`, and the `{{data.*}}`
 * token and credential cases are in `scenario_plan_tokens_test.cpp`.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/sse_stream.hpp"

#include "scenario_plan_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_plan::ScenarioPlanTest;

namespace {

json load_run_order_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "recursive-run-order-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

// --- Ordering ----------------------------------------------------------------

TEST_F (ScenarioPlanTest, DirectRequestsAreOrderedByRequestOrder) {
    seed_collection ("col", "");
    seed_request ("third", "col", /*order=*/2);
    seed_request ("first", "col", /*order=*/0);
    seed_request ("second", "col", /*order=*/1);

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan),
    (std::vector<std::string>{ "first", "second", "third" }));
    // The index is the plan position, not the row's `order`.
    for (size_t i = 0; i < resolved.plan.steps.size (); ++i) {
        EXPECT_EQ (resolved.plan.steps[i].index, i);
    }
}

TEST_F (ScenarioPlanTest, RecursiveDescentRunsEachChildWhereItSits) {
    //   root
    //     root_a        (request, order 0)
    //     child_a       (folder, order 1)
    //       a_1         (request, order 0)
    //       grandchild  (folder, order 1)
    //         g_1
    //     root_b        (request, order 2)
    //     child_b       (folder, order 3)
    //       b_1
    //
    // One sibling list per collection (#2535): a request runs where it sits
    // and a folder's subtree where the folder sits, which is the order the
    // sidebar shows top to bottom. Mutation check: restore the two-block walk
    // (every sub-folder's subtree before the folder's own requests) in
    // `Database::get_requests_in_subtree` and this reddens, along with every
    // interleaved fixture case.
    seed_collection ("root", "");
    seed_collection ("child_b", "root", /*order=*/3);
    seed_collection ("child_a", "root", /*order=*/1);
    seed_collection ("grandchild", "child_a", /*order=*/1);
    seed_request ("root_a", "root", /*order=*/0);
    seed_request ("root_b", "root", /*order=*/2);
    seed_request ("b_1", "child_b");
    seed_request ("a_1", "child_a", /*order=*/0);
    seed_request ("g_1", "grandchild");

    const auto resolved = vayu::core::resolve_scenario (
    *db_, block ("root", /*recursive=*/true), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan),
    (std::vector<std::string>{ "root_a", "a_1", "g_1", "root_b", "b_1" }));
}

// Each step names the folder its request sits in, not the collection being
// run: the runner reads that folder's variable chain for the step (#3248).
TEST_F (ScenarioPlanTest, EachStepNamesTheCollectionItsRequestSitsIn) {
    seed_collection ("root", "");
    seed_collection ("child", "root", /*order=*/1);
    seed_collection ("grandchild", "child", /*order=*/1);
    seed_request ("root_a", "root", /*order=*/0);
    seed_request ("c_1", "child", /*order=*/0);
    seed_request ("g_1", "grandchild");

    const auto resolved = vayu::core::resolve_scenario (
    *db_, block ("root", /*recursive=*/true), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    std::vector<std::string> collections;
    collections.reserve (resolved.plan.steps.size ());
    for (const auto& step : resolved.plan.steps) {
        collections.push_back (step.collection_id);
    }
    EXPECT_EQ (collections, (std::vector<std::string>{ "root", "child", "grandchild" }));
}

// --- The cross-consumer order (fixture-driven) --------------------------------

TEST_F (ScenarioPlanTest, RunOrderConformanceFixtureIsNonEmpty) {
    // Guards the scan itself: a fixture that failed to load would make every
    // case below vacuously pass.
    const json fixture = load_run_order_fixture ();
    ASSERT_TRUE (fixture.contains ("cases"));
    EXPECT_GE (fixture["cases"].size (), 9u);
}

TEST_F (ScenarioPlanTest, RecursiveRunFollowsTheSidebarOrderInEveryFixtureCase) {
    // The other half of this fixture is
    // app/src/modules/collections/CollectionTree.run-order.conformance.test.tsx,
    // which renders the same trees and reads the request rows out of the DOM. A
    // rule that changes on one side only fails there or here.
    //
    // Named, not subscripted inline: `load_run_order_fixture ()["cases"]`
    // returns a reference into a temporary the full expression destroys, so
    // the loop would walk freed memory - and in practice walk nothing.
    // `cases_run` guards against exactly that.
    const json fixture = load_run_order_fixture ();
    size_t cases_run   = 0;
    for (const auto& c : fixture["cases"]) {
        const std::string name = c["name"].get<std::string> ();
        reset_database (); // Ids repeat across cases.

        for (const auto& col : c["collections"]) {
            seed_collection (col["id"].get<std::string> (),
            col["parentId"].is_null () ? "" : col["parentId"].get<std::string> (),
            col["order"].get<int> (), /*auth=*/"", /*pre_script=*/"",
            col["createdAt"].get<int64_t> ());
        }
        for (const auto& req : c["requests"]) {
            seed_request (req["id"].get<std::string> (),
            req["collectionId"].get<std::string> (), req["order"].get<int> (),
            /*url=*/"https://example.test/", /*auth=*/"", /*post_script=*/"",
            req["createdAt"].get<int64_t> ());
        }

        std::vector<std::string> expected;
        for (const auto& id : c["expected"]) {
            expected.push_back (id.get<std::string> ());
        }

        const auto resolved = vayu::core::resolve_scenario (*db_,
        block (c["rootId"].get<std::string> (), /*recursive=*/true), options ());
        ASSERT_TRUE (resolved.ok) << "case: " << name << ": " << resolved.error;
        EXPECT_EQ (step_ids (resolved.plan), expected) << "case: " << name;
        ++cases_run;
    }
    EXPECT_GE (cases_run, 9u) << "the fixture loop asserted nothing";
}

TEST_F (ScenarioPlanTest, TiedOrdersRunInTheSameSequenceTheSidebarShows) {
    // Every request created before explicit orders existed sits at 0, so this is
    // the common case, not an edge one: what "run this folder" executes must be
    // what the tree displays. The rule is `order`, then `created_at`, then `id`
    // (issue #360, pinned by fixtures/tree-order-conformance.json) - not the
    // rowid, which an unrelated edit reassigns.
    seed_collection ("root", "");
    seed_request ("later", "root", /*order=*/0);
    seed_request ("earlier", "root", /*order=*/0);
    auto make_older = [&] (const std::string& id, int64_t created_at) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row);
        row->created_at = created_at;
        db_->save_request (*row);
    };
    make_older ("earlier", 1000);
    make_older ("later", 2000);

    const auto resolved =
    vayu::core::resolve_scenario (*db_, block ("root"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan), (std::vector<std::string>{ "earlier", "later" }));
}

TEST_F (ScenarioPlanTest, NonRecursiveIgnoresSubCollections) {
    seed_collection ("root", "");
    seed_collection ("child", "root");
    seed_request ("root_only", "root");
    seed_request ("child_only", "child");

    const auto resolved =
    vayu::core::resolve_scenario (*db_, block ("root"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan), (std::vector<std::string>{ "root_only" }));
}

TEST_F (ScenarioPlanTest, ParentIdCycleTerminatesAndVisitsEachCollectionOnce) {
    // A -> B -> A. Write-time validation prevents this now, but rows predating
    // it exist, and an unguarded walk grows forever holding the DB mutex.
    seed_collection ("a", "b");
    seed_collection ("b", "a");
    seed_request ("in_a", "a");
    seed_request ("in_b", "b");

    const auto resolved =
    vayu::core::resolve_scenario (*db_, block ("a", /*recursive=*/true), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    // What is pinned is termination and each collection contributing once. The
    // sequence follows from the sibling order - "b" is a child of "a" at the
    // same `order` as "a"'s request, and a folder ranks first on a tie - and a
    // cycle has no displayed order to agree with, since the sidebar renders
    // such a row as an orphaned root.
    EXPECT_EQ (step_ids (resolved.plan), (std::vector<std::string>{ "in_b", "in_a" }));
}

TEST_F (ScenarioPlanTest, SelfParentingCollectionTerminates) {
    seed_collection ("loop", "loop");
    seed_request ("only", "loop");

    const auto resolved = vayu::core::resolve_scenario (
    *db_, block ("loop", /*recursive=*/true), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan), (std::vector<std::string>{ "only" }));
}

// --- Composition is the engine's own, not a copy ------------------------------

TEST_F (ScenarioPlanTest, StepMatchesWhatComposeReturnsForTheSameRequest) {
    seed_collection ("col", "", /*order=*/0, /*auth=*/"",
    /*pre_script=*/"const fromCollection = 1;");
    seed_request ("req", "col", /*order=*/0, "https://{{host}}/orders/{{id}}",
    /*auth=*/R"({"mode":"bearer","token":"{{token}}"})",
    /*post_script=*/"pm.test('ok', () => {});");
    seed_environment ("env",
    R"({"host":{"value":"api.example.test","enabled":true},
        "id":{"value":"42","enabled":true},
        "token":{"value":"s3cret","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    const auto& step = resolved.plan.steps[0];

    // The independent reference: the same by-id composition POST /compose runs.
    auto [status, payload] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req" }, { "environmentId", "env" } });
    ASSERT_EQ (status, 200) << payload.dump ();

    EXPECT_EQ (step.request.url, payload["url"].get<std::string> ());
    EXPECT_EQ (to_string (step.request.method), payload["method"].get<std::string> ());

    // Non-empty, so the equality below is comparing something: both a
    // script.pre and a script.post element should be present, matching what
    // `POST /compose` resolved independently.
    ASSERT_TRUE (step.elements);
    ASSERT_EQ (step.elements->size (), payload["elements"].size ());
    bool saw_pre  = false;
    bool saw_post = false;
    for (size_t i = 0; i < step.elements->size (); ++i) {
        const auto& compiled = (*step.elements)[i];
        EXPECT_EQ (compiled.kind, payload["elements"][i]["kind"].get<std::string> ());
        EXPECT_EQ (compiled.config, payload["elements"][i]["config"]);
        saw_pre |= compiled.kind == "script.pre";
        saw_post |= compiled.kind == "script.post";
    }
    EXPECT_TRUE (saw_pre);
    EXPECT_TRUE (saw_post);

    // The collection's pre-request script runs before this step, so its names
    // wait for the pass after it (#2521) and its credential for the auth
    // applied after it (#2473) - not written into the plan.
    EXPECT_EQ (step.request.url, "https://{{host}}/orders/{{id}}");
    EXPECT_EQ (step.request.headers.count ("Authorization"), 0u);
    EXPECT_TRUE (step.auth_after_scripts);

    EXPECT_EQ (step.name, "Request req");
    EXPECT_EQ (step.stored_url, "https://{{host}}/orders/{{id}}");
}

// The same request with no pre-request script above it: the plan carries the
// environment's values and the applied auth, exactly as before #2521.
TEST_F (ScenarioPlanTest, AnUnscriptedStepResolvesItsNamesAndAuthIntoThePlan) {
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://{{host}}/orders/{{id}}",
    /*auth=*/R"({"mode":"bearer","token":"{{token}}"})");
    seed_environment ("env",
    R"({"host":{"value":"api.example.test","enabled":true},
        "id":{"value":"42","enabled":true},
        "token":{"value":"s3cret","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps.at (0);
    EXPECT_EQ (step.request.url, "https://api.example.test/orders/42");
    ASSERT_EQ (step.request.headers.count ("Authorization"), 1u);
    EXPECT_EQ (step.request.headers.at ("Authorization"), "Bearer s3cret");
    EXPECT_FALSE (step.auth_after_scripts);
}

// An `mcp` step's label is exported unredacted (#3829), so it is read off the
// stored body: a tool name a secret environment variable answers is sent
// substituted, and labelled by the method alone. Mutation check: label the
// step from `step.request.body.content` in `resolve_step`
// (`scenario_plan.cpp`) and this reddens.
TEST_F (ScenarioPlanTest, AnMcpStepsLabelNeverCarriesASubstitutedValue) {
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://mcp.example.test/mcp",
    /*auth=*/"", /*post_script=*/"", /*created_at=*/1, /*headers=*/"",
    json{ { "mode", "mcp" }, { "content", R"({"method":"tools/call","params":{"name":"{{secret_tool}}"}})" } }
    .dump ());
    seed_environment ("env",
    R"({"secret_tool":{"value":"s3cret-tool","enabled":true,"secret":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps.at (0);
    // The premise: what is sent carries the value.
    ASSERT_NE (step.request.body.content.find ("s3cret-tool"), std::string::npos)
    << step.request.body.content;
    EXPECT_EQ (step.mcp_label, "tools/call");
}

// --- A plan with a step that writes a variable (#2521) ------------------------
//
// One answer for the whole plan: an earlier step's extractor or test script can
// set the value a later, element-free step reads, so every step leaves its
// scope names for the send. Mutation check for the block: make
// `plan_variable_deferral` (scenario_plan.cpp) answer `WhenScripted` and the
// first case's later step is resolved into the plan; drop its `run.end`
// exclusion and the second case's teardown defers every step.

TEST_F (ScenarioPlanTest, AnExtractorOnOneStepLeavesEveryStepsNamesForTheSend) {
    seed_collection ("col", "");
    seed_request ("login", "col", 0, "https://api.example.test/login");
    set_request_elements ("login",
    json::array ({ { { "id", "el_token" }, { "kind", "extract.json" }, { "enabled", true },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "scope", "env" } } } } }));
    seed_request ("use", "col", 1, "https://{{host}}/me",
    /*auth=*/R"({"mode":"bearer","token":"{{token}}"})");
    seed_environment ("env",
    R"({"host":{"value":"api.example.test","enabled":true},
        "token":{"value":"old","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& use = resolved.plan.steps.at (1);
    EXPECT_EQ (use.request.url, "https://{{host}}/me");
    EXPECT_EQ (use.request.headers.count ("Authorization"), 0u);
    EXPECT_TRUE (use.auth_after_scripts);
}

// Elements that write nothing, and a teardown that writes only after the last
// send, leave the plan resolved at composition exactly as before.
TEST_F (ScenarioPlanTest, APlanWhoseElementsWriteNoVariableBeforeASendResolvesAtComposition) {
    seed_collection ("col", "");
    set_collection_elements ("col",
    json::array ({ { { "id", "el_down" }, { "kind", "script.teardown" }, { "enabled", true },
    { "config", { { "script", "pm.environment.set('token', 'after');" } } } } }));
    seed_request ("check", "col", 0, "https://api.example.test/health");
    set_request_elements ("check",
    json::array ({ { { "id", "el_ok" }, { "kind", "assert.status" },
    { "enabled", true }, { "config", { { "in", json::array ({ 200 }) } } } } }));
    seed_request ("use", "col", 1, "https://{{host}}/me",
    /*auth=*/R"({"mode":"bearer","token":"{{token}}"})");
    seed_environment ("env",
    R"({"host":{"value":"api.example.test","enabled":true},
        "token":{"value":"s3cret","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& use = resolved.plan.steps.at (1);
    EXPECT_EQ (use.request.url, "https://api.example.test/me");
    ASSERT_EQ (use.request.headers.count ("Authorization"), 1u);
    EXPECT_EQ (use.request.headers.at ("Authorization"), "Bearer s3cret");
    EXPECT_FALSE (use.auth_after_scripts);
}

// A scripted step under the run's deferred generators (#995, #2521): the
// generator is still split into the per-iteration template, once, and the
// deferred name is not - the residual pass after the script answers it.
TEST_F (ScenarioPlanTest, AScriptedStepSplitsItsGeneratorAndLeavesItsNameToThePass) {
    seed_collection ("col", "", /*order=*/0, /*auth=*/"",
    /*pre_script=*/"pm.environment.set('id', '9');");
    seed_request ("req", "col", 0, "https://api.example.test/{{$randomUUID}}/{{id}}");
    seed_environment ("env", R"({"id":{"value":"42","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps.at (0);

    EXPECT_EQ (step.request.url, "https://api.example.test/{{$randomUUID}}/{{id}}");
    ASSERT_EQ (step.data_template.fields.size (), 1u);
    EXPECT_EQ (step.data_template.fields[0].tokens, std::vector<std::string>{ "$randomUUID" });
}

// Issue #995. A plan step is composed once and sent per iteration, so its
// composition defers the generator family: the token survives into the step's
// request and is split into the template every executor joins before a send.
TEST_F (ScenarioPlanTest, AStepKeepsItsGeneratorTokensForThePerIterationBind) {
    seed_collection ("col", "");
    seed_request ("req", "col", 0, "https://api.example.test/{{$randomUUID}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    const auto& step = resolved.plan.steps[0];

    EXPECT_EQ (step.request.url, "https://api.example.test/{{$randomUUID}}")
    << "the plan resolved the generator, so every iteration would send one id";
    EXPECT_FALSE (step.data_template.empty ())
    << "the deferred token was not split, so nothing would ever bind it";
    // Not a data token: a run carrying only these needs no data set behind it,
    // and the refusal that guards `{{data.*}}` must not claim this one.
    EXPECT_FALSE (step.data_template.first_data_token ().has_value ());
}

// The other half of the same rule, and the reason a token-free plan pays
// nothing: a step spelling no generator has nothing left to split.
TEST_F (ScenarioPlanTest, AStepWithoutAGeneratorCarriesAnEmptyTemplate) {
    seed_collection ("col", "");
    seed_request ("req", "col", 0, "https://api.example.test/ping");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    EXPECT_TRUE (resolved.plan.steps[0].data_template.empty ());
}

TEST_F (ScenarioPlanTest, StepsResolveAgainstTheRunsEnvironment) {
    // Without the run's environmentId reaching composition, every {{env var}}
    // in the plan silently keeps its braces (issue #1009) instead of
    // resolving - the failure this guards.
    seed_collection ("col", "");
    seed_request ("req", "col", 0, "https://{{host}}/ping");
    seed_environment ("env", R"({"host":{"value":"api.example.test"}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://api.example.test/ping");
}

// --- A stored stream runs as one (#3235) ---------------------------------------

// Composition drops the row's `stream`, so the plan reads it off the row.
// Mutation check: drop the `row.stream` copy in `resolve_step` and the
// streaming step's assertions fail.
TEST_F (ScenarioPlanTest, AStoredStreamingStepCarriesTheRunsStreamBounds) {
    seed_collection ("col", "");
    seed_request ("sse", "col", 0, "https://example.test/events");
    seed_request ("plain", "col", 1, "https://example.test/ping");
    mark_streaming ("sse");

    auto opts                          = options ();
    opts.stream_bounds.max_duration_ms = 2000;
    opts.stream_bounds.max_events      = 7;
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 2u);

    const auto& streaming = resolved.plan.steps[0].request.stream_bounds;
    ASSERT_HAS_VALUE (streaming);
    EXPECT_EQ (streaming->max_duration_ms, 2000);
    EXPECT_EQ (streaming->max_events, 7);
    EXPECT_FALSE (resolved.plan.steps[1].request.stream_bounds.has_value ())
    << "a step whose stored request does not stream is sent as an ordinary one";

    const auto longest = vayu::core::longest_stream_bounds (resolved.plan);
    ASSERT_HAS_VALUE (longest);
    EXPECT_EQ (longest->max_duration_ms, 2000);
}

// The route's resolution, which `POST /runs` hands the plan: the run's own
// caps over the `sse*` settings, each cap on its own.
TEST_F (ScenarioPlanTest, AStreamingStepFallsBackToTheStreamSettingsCapByCap) {
    set_config ("sseMaxStreamDurationMs", "45000");
    set_config ("sseMaxStreamEvents", "12");
    seed_collection ("col", "");
    seed_request ("sse", "col", 0, "https://example.test/events");
    mark_streaming ("sse");

    const auto defaults =
    vayu::http::default_stream_bounds (vayu::http::read_sse_limits (*db_));
    const auto resolve_with = [&] (const json& run_config) {
        auto opts = options ();
        opts.stream_bounds = vayu::http::resolve_stream_bounds (run_config, defaults);
        return vayu::core::resolve_scenario (*db_, block ("col"), opts);
    };

    const auto from_settings = resolve_with (json::object ());
    ASSERT_TRUE (from_settings.ok) << from_settings.error;
    const auto& settled = from_settings.plan.steps.at (0).request.stream_bounds;
    ASSERT_HAS_VALUE (settled);
    EXPECT_EQ (settled->max_duration_ms, 45000);
    EXPECT_EQ (settled->max_events, 12);

    const auto mixed = resolve_with (
    json{ { "maxStreamEvents", 3 }, { "maxStreamDurationMs", nullptr } });
    ASSERT_TRUE (mixed.ok) << mixed.error;
    const auto& capped = mixed.plan.steps.at (0).request.stream_bounds;
    ASSERT_HAS_VALUE (capped);
    EXPECT_EQ (capped->max_duration_ms, 45000) << "a null cap is an absent one";
    EXPECT_EQ (capped->max_events, 3);
}

TEST_F (ScenarioPlanTest, APlanWithNoStreamingStepHasNoStreamBounds) {
    seed_collection ("col", "");
    seed_request ("plain", "col");
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (vayu::core::longest_stream_bounds (resolved.plan).has_value ());
}

// --- The snapshot manifest ----------------------------------------------------

TEST_F (ScenarioPlanTest, ManifestCarriesStoredUrlsAndNoCredentialMaterial) {
    seed_collection ("col", "");
    // Two shapes, because they leak differently: bearer lands in a header, and
    // an apikey with `in: "query"` puts a live key in the composed URL.
    seed_request ("bearer_req", "col", /*order=*/0, "https://{{host}}/private",
    R"({"mode":"bearer","token":"{{token}}"})");
    seed_request ("apikey_req", "col", /*order=*/1, "https://{{host}}/search",
    R"({"mode":"apikey","key":"api_key","value":"{{token}}","in":"query"})");
    seed_environment ("env",
    R"({"host":{"value":"api.example.test","enabled":true},
        "token":{"value":"s3cret","enabled":true}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 2u);

    // The plan itself is credential-grade - that is why it is never persisted.
    ASSERT_EQ (resolved.plan.steps[0].request.headers.count ("Authorization"), 1u);
    EXPECT_NE (resolved.plan.steps[1].request.url.find ("s3cret"), std::string::npos);

    const json manifest =
    vayu::core::build_scenario_manifest (resolved.request, resolved.plan);
    const std::string text = manifest.dump ();
    EXPECT_EQ (text.find ("s3cret"), std::string::npos) << text;
    EXPECT_EQ (text.find ("Authorization"), std::string::npos) << text;

    ASSERT_EQ (manifest["steps"].size (), 2u);
    EXPECT_EQ (manifest["steps"][0]["url"], "https://{{host}}/private");
    EXPECT_EQ (manifest["steps"][1]["url"], "https://{{host}}/search");
    EXPECT_EQ (manifest["steps"][0]["index"], 0);
    EXPECT_EQ (manifest["steps"][0]["requestId"], "bearer_req");
    EXPECT_EQ (manifest["steps"][0]["name"], "Request bearer_req");
    EXPECT_EQ (manifest["steps"][0]["method"], "GET");

    EXPECT_EQ (manifest["source"], "collection");
    EXPECT_EQ (manifest["collectionId"], "col");
    EXPECT_EQ (manifest["recursive"], false);
    EXPECT_EQ (manifest["iterations"], 1);
    EXPECT_EQ (manifest["dataRowCount"], 0);
}

// Issue #2051 added the file's name and content hash beside the count. Mutation
// check: drop the `stamp_data_file_fields` call in `build_scenario_manifest`
// and the two file assertions red.
TEST_F (ScenarioPlanTest, ManifestRecordsTheDataRowCountAndFileButNeverTheRows) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" } }, json{ { "user", "bob" } } });
    scenario["dataFileName"] = "users.csv";
    scenario["dataFileHash"] = std::string (64, 'a');
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    const json manifest =
    vayu::core::build_scenario_manifest (resolved.request, resolved.plan);
    EXPECT_EQ (manifest["dataRowCount"], 2);
    EXPECT_EQ (manifest.at ("dataFileName"), "users.csv");
    EXPECT_EQ (manifest.at ("dataFileHash"), std::string (64, 'a'));
    // Absent `iterations` with a data set means one pass per row.
    EXPECT_EQ (manifest["iterations"], 2);
    EXPECT_EQ (manifest.dump ().find ("alice"), std::string::npos);

    // The rows themselves ride the resolution to the run's worker, which is
    // what `pm.iterationData` reads - they are kept out of the *manifest*, not
    // out of the run.
    ASSERT_EQ (resolved.data_rows.size (), 2u);
    EXPECT_EQ (resolved.data_rows[0]["user"], "alice");
    EXPECT_EQ (resolved.data_rows[1]["user"], "bob");
}

// A run that named no file stores no key at all: absent, never `null` or an
// empty string a reader would print as a blank file name. Mutation check: stamp
// the two keys unconditionally in `stamp_data_file_fields` and this reds.
TEST_F (ScenarioPlanTest, ManifestOmitsTheDataFileWhenNoneWasNamed) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    const json manifest =
    vayu::core::build_scenario_manifest (resolved.request, resolved.plan);
    EXPECT_EQ (manifest["dataRowCount"], 1);
    EXPECT_FALSE (manifest.contains ("dataFileName")) << manifest.dump ();
    EXPECT_FALSE (manifest.contains ("dataFileHash")) << manifest.dump ();
    EXPECT_FALSE (manifest.contains ("dataFileCastNumbers")) << manifest.dump ();
}

// Issue #2540: whether the client read the file's numbers as numbers is stored
// with the file, because the hash is of the bytes and cannot tell two readings
// apart. Recorded only when true. Mutation check: drop `dataFileCastNumbers`
// from `known_scenario_keys` and the block is refused; stamp it only when false
// and both halves red.
TEST_F (ScenarioPlanTest, ManifestRecordsADataFileReadWithNumbersCastAndOmitsOneReadAsText) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    const auto manifest_for = [this] (bool cast) {
        json scenario            = block ("col");
        scenario["data"]         = json::array ({ json{ { "plan", 3 } } });
        scenario["dataFileName"] = "plans.csv";
        scenario["dataFileCastNumbers"] = cast;
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_TRUE (resolved.ok) << resolved.error;
        EXPECT_EQ (resolved.request.data_file.cast_numbers, cast);
        return vayu::core::build_scenario_manifest (resolved.request, resolved.plan);
    };

    EXPECT_EQ (manifest_for (true).at ("dataFileCastNumbers"), true);
    EXPECT_FALSE (manifest_for (false).contains ("dataFileCastNumbers"));
}

// Each refusal is a 400 in the block's own wording, never a dropped field
// (#1503). Mutation check: make `read_data_file_fields` return nothing and
// every case reds; drop its `has_data` check and the two "without" cases red.
TEST_F (ScenarioPlanTest, TheDataFileFieldsAreRefusedWhenMalformedOrWithoutRows) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    const auto refusal = [this] (const json& scenario) {
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_FALSE (resolved.ok) << "accepted: " << scenario.dump ();
        return resolved.error;
    };
    const auto with_rows = [] () {
        json scenario    = block ("col");
        scenario["data"] = json::array ({ json{ { "user", "alice" } } });
        return scenario;
    };

    json scenario            = with_rows ();
    scenario["dataFileName"] = 7;
    auto error               = refusal (scenario);
    EXPECT_NE (
    error.find ("'scenario.dataFileName' must be a non-empty string"), std::string::npos)
    << error;

    scenario                 = with_rows ();
    scenario["dataFileName"] = "";
    error                    = refusal (scenario);
    EXPECT_NE (error.find ("'scenario.dataFileName'"), std::string::npos) << error;

    scenario                 = block ("col");
    scenario["dataFileName"] = "users.csv";
    error                    = refusal (scenario);
    EXPECT_NE (error.find ("'scenario.dataFileName'"), std::string::npos) << error;
    EXPECT_NE (error.find ("without it"), std::string::npos) << error;

    // Uppercase is a second spelling of the same digest, so it is refused
    // rather than stored as one that never compares equal.
    for (const auto& bad : { std::string (63, 'a'), std::string (64, 'A'),
         std::string (63, 'a') + "g", std::string (65, 'a') }) {
        scenario                 = with_rows ();
        scenario["dataFileHash"] = bad;
        error                    = refusal (scenario);
        EXPECT_NE (error.find ("'scenario.dataFileHash' must be the SHA-256"),
        std::string::npos)
        << bad << ": " << error;
    }

    scenario                 = block ("col");
    scenario["dataFileHash"] = std::string (64, '0');
    error                    = refusal (scenario);
    EXPECT_NE (error.find ("'scenario.dataFileHash'"), std::string::npos) << error;
    EXPECT_NE (error.find ("without it"), std::string::npos) << error;

    scenario                        = with_rows ();
    scenario["dataFileCastNumbers"] = "true";
    error                           = refusal (scenario);
    EXPECT_NE (error.find (
               "'scenario.dataFileCastNumbers' must be a boolean (got string)"),
    std::string::npos)
    << error;

    // `false` describes a file as much as `true` does.
    scenario                        = block ("col");
    scenario["dataFileCastNumbers"] = false;
    error                           = refusal (scenario);
    EXPECT_NE (error.find ("'scenario.dataFileCastNumbers'"), std::string::npos) << error;
    EXPECT_NE (error.find ("without it"), std::string::npos) << error;
}

// A display name, never a path (#2051): a caller that sends the path it read
// the file from is refused, so no path is stored. Mutation check: drop the
// separator check in `read_data_file_fields` and every case reds.
TEST_F (ScenarioPlanTest, ADataFileNameHoldingAPathIsRefused) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    for (const auto* path :
    { "/home/u/users.csv", "exports/users.csv", "C:\\data\\users.csv", "users\\" }) {
        json scenario    = block ("col");
        scenario["data"] = json::array ({ json{ { "user", "alice" } } });
        scenario["dataFileName"] = path;
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_FALSE (resolved.ok) << "accepted: " << path;
        EXPECT_NE (resolved.error.find (
                   "'scenario.dataFileName' is the file's name, never a path"),
        std::string::npos)
        << path << ": " << resolved.error;
    }
}

// `null` is absent, on this block's existing rule for `recursive` and `data`.
TEST_F (ScenarioPlanTest, NullDataFileFieldsAreAbsent) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario                   = block ("col");
    scenario["dataFileName"]        = nullptr;
    scenario["dataFileHash"]        = nullptr;
    scenario["dataFileCastNumbers"] = nullptr;
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_TRUE (resolved.request.data_file.name.empty ());
    EXPECT_TRUE (resolved.request.data_file.hash.empty ());
    EXPECT_FALSE (resolved.request.data_file.cast_numbers);
}

TEST_F (ScenarioPlanTest, ARunWithoutDataResolvesToNoRows) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_TRUE (resolved.data_rows.empty ());
    EXPECT_EQ (resolved.request.iterations, 1u);
}

// A set that is rejected binds nothing at all - not even the rows before the
// one at fault, which would be a partial data set the caller never sent.
TEST_F (ScenarioPlanTest, ARejectedRowLeavesNoRowsBehind) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } }, json ("bob") });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    ASSERT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("row 1"), std::string::npos) << resolved.error;
    EXPECT_TRUE (resolved.data_rows.empty ());
}

TEST_F (ScenarioPlanTest, ExplicitIterationsWinsOverTheRowCount) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario          = block ("col");
    scenario["data"]       = json::array ({ json{ { "user", "alice" } } });
    scenario["iterations"] = 5;
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.request.iterations, 5u);
    EXPECT_EQ (resolved.request.data_row_count, 1u);
}

// --- The robustness table -----------------------------------------------------

TEST_F (ScenarioPlanTest, UnknownCollectionIdIsRejectedAndEchoed) {
    const auto resolved =
    vayu::core::resolve_scenario (*db_, block ("col_missing"), options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("col_missing"), std::string::npos)
    << resolved.error;
}

TEST_F (ScenarioPlanTest, EmptyCollectionIsRejected) {
    seed_collection ("col", "");
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("no requests"), std::string::npos)
    << resolved.error;
}

TEST_F (ScenarioPlanTest, EmptyIsJudgedAfterRecursiveIsApplied) {
    // Requests exist, but only below a sub-collection this run does not descend
    // into - so the sequence really is empty.
    seed_collection ("root", "");
    seed_collection ("child", "root");
    seed_request ("child_only", "child");

    EXPECT_FALSE (
    vayu::core::resolve_scenario (*db_, block ("root"), options ()).ok);
    EXPECT_TRUE (vayu::core::resolve_scenario (
    *db_, block ("root", /*recursive=*/true), options ())
    .ok);
}

TEST_F (ScenarioPlanTest, AStepThatCannotComposeNamesTheOffendingRequest) {
    seed_collection ("col", "");
    seed_request ("ok_req", "col", /*order=*/0);
    // OAuth 2.0 with auto-fetch off and nothing in the token cache: the auth
    // cannot be resolved, so this step has no execute-ready request.
    seed_request ("broken_req", "col", /*order=*/1, "https://example.test/x",
    R"({"mode":"oauth2","config":{"autoFetchToken":false,"tokenUrl":"https://auth.test/token","clientId":"c"}})");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("broken_req"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("Request broken_req"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("step 1"), std::string::npos) << resolved.error;
}

TEST_F (ScenarioPlanTest, PlanOverMaxStepsIsRejectedWithCountAndCap) {
    seed_collection ("col", "");
    for (int i = 0; i < 3; ++i) {
        seed_request ("req_" + std::to_string (i), "col", i);
    }

    const auto resolved =
    vayu::core::resolve_scenario (*db_, block ("col"), options (/*max_steps=*/2));
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("3 steps"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ('2'), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("maxScenarioSteps"), std::string::npos)
    << resolved.error;
}

/**
 * The end-to-end shape of #1007 on the path an imported collection takes.
 *
 * A step's composition is the engine's own (`compose_request_core` by id), so
 * the dataset's columns reach it from here rather than from a client - and the
 * step must come back with the bare token still written as it stands, ready for
 * the per-iteration bind, even though the environment defines the same name.
 *
 * Mutation-check: stop passing `dataColumns` into the compose body and the URL
 * comes back carrying "from-the-environment"; stop passing the set to
 * `tokenize_bindable_fields` and the template is empty, so nothing binds.
 */
TEST_F (ScenarioPlanTest, ARunsColumnsDeferTheirBareTokensAndSplitThem) {
    seed_collection ("col", "");
    seed_request ("req", "col", 0, "https://api.test/u/{{username}}?r={{region}}");
    seed_environment ("env",
    R"({"username":{"value":"from-the-environment"},"region":{"value":"eu"}})");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "username", "ada" } }, json{ { "username", "grace" } } });
    auto opts           = options ();
    opts.environment_id = "env";

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    const auto& step = resolved.plan.steps[0];
    // The column deferred, the ordinary variable resolved.
    EXPECT_EQ (step.request.url, "https://api.test/u/{{username}}?r=eu");
    // And the step carries the split, so the bind has something to join.
    ASSERT_FALSE (step.data_template.empty ());

    vayu::Request bound = step.request;
    ASSERT_TRUE (vayu::core::apply_iteration_template (bound, step.data_template,
    vayu::core::IterationBinding{ &resolved.data_rows[1], 1, {} })
    .ok);
    EXPECT_EQ (bound.url, "https://api.test/u/grace?r=eu");
}

/**
 * A collection run's steps - sequential and load alike, both read this plan -
 * take their `:name` path variables from each request's own path rows through
 * the same composition a Send uses (issue #1764): two requests on `:id` send
 * their own values, and a data column in a value is bound per iteration.
 *
 * Mutation-check: drop `substitute_compose_path_variables` from
 * `compose_request_core` and every URL here keeps its `:id`.
 */
TEST_F (ScenarioPlanTest, AStepSendsItsOwnPathVariablesAndBindsAColumnInOne) {
    seed_collection ("col", "");
    const auto with_path_row = [&] (const std::string& id, int order,
                               const std::string& value) {
        seed_request (id, "col", order, "https://api.test/users/:id?r=eu");
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row);
        row->params = json::array (
        { { { "key", "id" }, { "value", value }, { "enabled", true },
        { "in",
        "path" } } }).dump ();
        db_->save_request (*row);
    };
    with_path_row ("one", 0, "1");
    with_path_row ("two", 1, "2");
    with_path_row ("bound", 2, "{{username}}");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "username", "a b?c" } } });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 3u);
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://api.test/users/1?r=eu");
    EXPECT_EQ (resolved.plan.steps[1].request.url, "https://api.test/users/2?r=eu");
    // The bound value waits for its row: its segment stays `:id`.
    EXPECT_EQ (resolved.plan.steps[2].request.url, "https://api.test/users/:id?r=eu");

    // The cell is encoded as composition encodes a value it could answer
    // itself. Mutation check: join the token into the URL at composition (the
    // pre-fix behaviour) and this reads `/users/a b?c`, a query.
    vayu::Request bound = resolved.plan.steps[2].request;
    ASSERT_TRUE (vayu::core::apply_iteration_template (bound,
    resolved.plan.steps[2].data_template,
    vayu::core::IterationBinding{ resolved.data_rows.data (), 0, {} })
    .ok);
    EXPECT_EQ (bound.url, "https://api.test/users/a%20b%3Fc?r=eu");
    EXPECT_TRUE (bound.path_variables.empty ());
}

/**
 * A path value holding a token a row does not answer waits past the bind for
 * the residual pass, which writes the value a pre-request script set, encoded as
 * Postman encodes it (issue #1764); a column in the same value is bound first.
 */
TEST_F (ScenarioPlanTest, APathValueTheScriptAnswersIsEncodedByTheResidualPass) {
    seed_collection ("col", "");
    seed_request ("one", "col", 0, "https://api.test/users/:id");
    auto row = db_->get_request ("one");
    ASSERT_HAS_VALUE (row);
    row->params = json::array (
    { { { "key", "id" }, { "value", "{{username}}-{{fromScript}}" }, { "enabled", true },
    { "in",
    "path" } } }).dump ();
    db_->save_request (*row);

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "username", "a b" } } });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    vayu::Request request = resolved.plan.steps[0].request;
    ASSERT_TRUE (vayu::core::apply_iteration_template (request,
    resolved.plan.steps[0].data_template,
    vayu::core::IterationBinding{ resolved.data_rows.data (), 0, {} })
    .ok);
    EXPECT_EQ (request.url, "https://api.test/users/:id");
    ASSERT_EQ (request.path_variables.size (), 1u);
    EXPECT_EQ (request.path_variables[0].value, "a b-{{fromScript}}");

    vayu::http::VariableValues vars{ { "fromScript", "c?d" } };
    ASSERT_FALSE (vayu::http::routes::resolve_residual_tokens (request, vars));
    EXPECT_EQ (request.url, "https://api.test/users/a%20b-c%3Fd");
    EXPECT_TRUE (request.path_variables.empty ());
}

TEST_F (ScenarioPlanTest, ARunWithoutRowsResolvesABareNameFromTheScopesAsItAlwaysDid) {
    // The both-ways half of the rule at the plan level: with no data block, the
    // same collection composes exactly as it did before #1007.
    seed_collection ("col", "");
    seed_request ("req", "col", 0, "https://api.test/u/{{username}}");
    seed_environment ("env", R"({"username":{"value":"from-the-environment"}})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://api.test/u/from-the-environment");
    EXPECT_TRUE (resolved.plan.steps[0].data_template.empty ());
}

TEST_F (ScenarioPlanTest, PresentButEmptyDataIsRejected) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario    = block ("col");
    scenario["data"] = json::array ();
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("empty"), std::string::npos) << resolved.error;
}

TEST_F (ScenarioPlanTest, DataRowsOverTheCapAreRejectedWithCountAndCap) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json rows = json::array ();
    for (int i = 0; i < 4; ++i) {
        rows.push_back (json{ { "n", i } });
    }
    json scenario    = block ("col");
    scenario["data"] = rows;

    const auto resolved = vayu::core::resolve_scenario (
    *db_, scenario, options (/*max_steps=*/200, /*max_data_rows=*/3));
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("4 rows"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("maxScenarioDataRows"), std::string::npos)
    << resolved.error;
}

TEST_F (ScenarioPlanTest, ANonObjectDataRowIsRejectedByIndex) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } }, "bob" });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("row 1"), std::string::npos) << resolved.error;
}

// A cell nested past MAX_READ_DEPTH is refused before the row is dumped or
// copied, both of which recurse (#2362). The deep value is built by moving, and
// only the short refusal is ever streamed.
TEST_F (ScenarioPlanTest, ADataCellNestedPastTheDepthBoundIsRejectedNamingRowAndColumn) {
    seed_collection ("col", "");
    seed_request ("req", "col");
    constexpr size_t bound = vayu::core::constants::spec_document::MAX_READ_DEPTH;

    json bad_row   = { { "user", "bob" } };
    bad_row["tag"] = vayu::tests::nested_array (bound + 1);
    json scenario  = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" } }, std::move (bad_row) });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_EQ (resolved.error,
    "'scenario.data' row 1 column 'tag' is nested deeper than " +
    std::to_string (bound) + " levels");
    // Nothing of the rows before the bad one survives.
    EXPECT_TRUE (resolved.data_rows.empty ());
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, ADataCellNestedExactlyAtTheDepthBoundResolves) {
    seed_collection ("col", "");
    seed_request ("req", "col");
    constexpr size_t bound = vayu::core::constants::spec_document::MAX_READ_DEPTH;

    json row         = { { "tag", vayu::tests::nested_array (bound) } };
    json scenario    = block ("col");
    scenario["data"] = json::array ({ std::move (row) });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.data_rows.size (), 1u);
}

// `refuse_overdeep_data` is what `POST /runs` asks before it snapshots the body,
// so it has to answer for every shape `data` can take, not only an array of
// objects (#2362). Each too-deep value is moved into place: a copy recurses.
namespace {

constexpr size_t kDepthBound = vayu::core::constants::spec_document::MAX_READ_DEPTH;

std::string overdeep_message (const std::string& where) {
    return where + " is nested deeper than " + std::to_string (kDepthBound) + " levels";
}

} // namespace

TEST (RefuseOverdeepData, ANonArrayDataTooDeepIsRefusedAsAWhole) {
    json object = json::object ();
    object["a"] = vayu::tests::nested_array (kDepthBound + 1);
    EXPECT_EQ (vayu::core::refuse_overdeep_data (object, "data"),
    overdeep_message ("'data'"));
    EXPECT_EQ (vayu::core::refuse_overdeep_data (object, "scenario.data"),
    overdeep_message ("'scenario.data'"));
}

TEST (RefuseOverdeepData, ANonObjectRowTooDeepIsRefusedByIndexAndRowsBeforeItAreSkipped) {
    json data = json::array ();
    data.push_back (1);
    data.push_back (json{ { "ok", 1 } });
    data.push_back (vayu::tests::nested_array (kDepthBound + 1));

    EXPECT_EQ (vayu::core::refuse_overdeep_data (data, "scenario.data"),
    overdeep_message ("'scenario.data' row 2"));
}

TEST (RefuseOverdeepData, ANonObjectRowDoesNotStopTheWalkBeforeALaterDeepCell) {
    json deep_row   = json::object ();
    deep_row["tag"] = vayu::tests::nested_array (kDepthBound + 1);
    json data       = json::array ();
    data.push_back (1);
    data.push_back (std::move (deep_row));

    EXPECT_EQ (vayu::core::refuse_overdeep_data (data, "data"),
    overdeep_message ("'data' row 1 column 'tag'"));
}

TEST (RefuseOverdeepData, WrongShapesWithinTheBoundAreLeftToReadDataRows) {
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (json{ { "a", 1 } }, "data"));
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (json ("text"), "data"));
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (json::array ({ 1, "bob" }), "data"));
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (json::array (), "data"));

    json at_bound = json::array ();
    at_bound.push_back (vayu::tests::nested_array (kDepthBound));
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (at_bound, "data"));
    EXPECT_FALSE (vayu::core::refuse_overdeep_data (
    json{ { "a", vayu::tests::nested_array (kDepthBound - 1) } }, "data"));
}

TEST_F (ScenarioPlanTest, SmallObjectAndArrayCellsStillResolveAndBindAsCompactJson) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario    = block ("col");
    scenario["data"] = json::array (
    { json{ { "profile", { { "id", 7 } } }, { "ids", json::array ({ 1, 2 }) } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.data_rows.size (), 1u);
    EXPECT_EQ (resolved.data_rows[0]["profile"].dump (), R"({"id":7})");
    EXPECT_EQ (resolved.data_rows[0]["ids"].dump (), "[1,2]");
}

TEST_F (ScenarioPlanTest, AnOversizedDataBlockIsRejectedByItsByteBound) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    // Two rows - comfortably inside `maxScenarioDataRows` - carrying far more
    // than the byte bound between them. The row count cannot catch this, which
    // is the whole reason the byte bound exists: without it the payload is
    // bounded only by the transport's body cap, which names nothing.
    json scenario = block ("col");
    scenario["data"] = json::array ({ json{ { "blob", std::string (400, 'x') } },
    json{ { "blob", std::string (400, 'y') } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario,
    options (/*max_steps=*/200, /*max_data_rows=*/1000, /*max_data_bytes=*/500));

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("500 bytes"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("maxScenarioDataBytes"), std::string::npos)
    << resolved.error;
    // A rejected set leaves nothing behind, exactly as a ragged one does.
    EXPECT_TRUE (resolved.data_rows.empty ());
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, ADataBlockInsideTheByteBoundResolves) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario,
    options (/*max_steps=*/200, /*max_data_rows=*/1000, /*max_data_bytes=*/500));

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.data_rows.size (), 1u);
}

TEST_F (ScenarioPlanTest, AnUnknownSourceDoesNotFallThroughToTheCollectionPath) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario      = block ("col");
    scenario["source"] = "stored";
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("source"), std::string::npos) << resolved.error;
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, AMissingSourceIsRejectedRatherThanAssumed) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario = block ("col");
    scenario.erase ("source");
    EXPECT_FALSE (vayu::core::resolve_scenario (*db_, scenario, options ()).ok);
}

TEST_F (ScenarioPlanTest, MalformedBlockFieldsAreRejected) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    const auto rejected = [&] (const json& scenario) {
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_FALSE (resolved.ok) << scenario.dump ();
        EXPECT_FALSE (resolved.error.empty ());
    };

    rejected (json ("not an object"));
    rejected (json{ { "source", "collection" } }); // no collectionId
    rejected (json{ { "source", "collection" }, { "collectionId", "" } });
    rejected (json{ { "source", "collection" }, { "collectionId", 7 } });
    {
        json s         = block ("col");
        s["recursive"] = "yes";
        rejected (s);
    }
    {
        json s          = block ("col");
        s["iterations"] = 0;
        rejected (s);
    }
    {
        json s          = block ("col");
        s["iterations"] = 1.5;
        rejected (s);
    }
    {
        json s          = block ("col");
        s["iterations"] = "3";
        rejected (s);
    }
    {
        json s    = block ("col");
        s["data"] = json::object ();
        rejected (s);
    }
}

// A key this block does not read used to change nothing and still answer
// 202 (issue #1503) - every future scenario field would have inherited the
// same silence. Mutation check: remove the unknown-key scan in
// `parse_scenario_request` and this reds, since every other check here
// leaves an unrecognised key untouched.
TEST_F (ScenarioPlanTest, AnUnknownScenarioKeyIsRejectedByName) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario       = block ("col");
    scenario["delayMs"] = 100;
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("scenario.delayMs"), std::string::npos)
    << resolved.error;
    // The refusal lists the known keys by hand, so a key added to the set is
    // pinned here too.
    EXPECT_NE (resolved.error.find ("dataFileCastNumbers"), std::string::npos)
    << resolved.error;
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, ResolutionNeverWritesARunRow) {
    // The route returns before `create_run`, and resolution itself must have no
    // way to strand a row - a rejected scenario leaves nothing behind, and so
    // does an accepted one until the runner exists to start it.
    seed_collection ("col", "");
    seed_request ("req", "col");

    EXPECT_FALSE (
    vayu::core::resolve_scenario (*db_, block ("col_missing"), options ()).ok);
    EXPECT_TRUE (vayu::core::resolve_scenario (*db_, block ("col"), options ()).ok);
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

} // namespace
