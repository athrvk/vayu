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
 * in-process HTTP server - the same shape as the suite's other route tests.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/utils/encoding.hpp"

using nlohmann::json;

namespace {

json load_run_order_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "recursive-run-order-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

class ScenarioPlanTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scenario_plan.db";

    void SetUp () override {
        reset_database ();
    }
    /// A fresh database on one path. The old handle is closed *before* the
    /// files are removed and the new one opens, so a test that needs a clean
    /// tree mid-run (the fixture loop, whose cases repeat ids) cannot end up
    /// with two connections to a file one of them has already deleted.
    void reset_database () {
        db_.reset ();
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

    // `created_at` is the second sort key, so only a test about a tie needs to
    // state it; everything else shares one timestamp and sorts on `order`.
    void seed_collection (const std::string& id,
    const std::string& parent_id,
    int order                      = 0,
    const std::string& auth        = "",
    const std::string& pre_script  = "",
    int64_t created_at             = 1,
    const std::string& data_schema = "{}") {
        vayu::db::Collection col;
        col.id = id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.name = "Collection " + id;
        col.auth = auth;
        if (!pre_script.empty ()) {
            col.elements = nlohmann::json::array (
            { nlohmann::json{ { "id", "el_pre_" + id }, { "kind", "script.pre" },
            { "enabled", true }, { "config", { { "script", pre_script } } } } })
                           .dump ();
        }
        col.data_schema = data_schema;
        col.order       = order;
        col.created_at  = created_at;
        col.updated_at  = created_at;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    int order                      = 0,
    const std::string& url         = "https://example.test/{{path}}",
    const std::string& auth        = "",
    const std::string& post_script = "",
    int64_t created_at             = 1,
    const std::string& headers     = "",
    const std::string& body        = "") {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = url;
        r.headers       = headers;
        r.body          = body;
        r.auth          = auth;
        if (!post_script.empty ()) {
            r.elements = nlohmann::json::array (
            { nlohmann::json{ { "id", "el_post_" + id }, { "kind", "script.post" },
            { "enabled", true }, { "config", { { "script", post_script } } } } })
                         .dump ();
        }
        r.order      = order;
        r.created_at = created_at;
        r.updated_at = created_at;
        db_->save_request (r);
    }

    /// Replace the stored `elements` of request @p id.
    void set_request_elements (const std::string& id, const json& elements) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row) << id;
        row->elements = elements.dump ();
        db_->save_request (*row);
    }

    /// Replace the stored `elements` of collection @p id.
    void set_collection_elements (const std::string& id, const json& elements) {
        auto row = db_->get_collection (id);
        ASSERT_HAS_VALUE (row) << id;
        row->elements = elements.dump ();
        db_->create_collection (*row); // a replace, keyed on the id
    }

    void seed_environment (const std::string& id, const std::string& variables) {
        vayu::db::Environment env;
        env.id         = id;
        env.name       = "Env " + id;
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    // Generous bounds unless a test is about a bound.
    static vayu::core::ScenarioResolveOptions options (size_t max_steps = 200,
    size_t max_data_rows                                                = 1000,
    size_t max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES) {
        vayu::core::ScenarioResolveOptions opts;
        opts.timeout_ms            = 30000;
        opts.limits.max_steps      = max_steps;
        opts.limits.max_data_rows  = max_data_rows;
        opts.limits.max_data_bytes = max_data_bytes;
        return opts;
    }

    static json block (const std::string& collection_id, bool recursive = false) {
        return json{ { "source", "collection" },
            { "collectionId", collection_id }, { "recursive", recursive } };
    }

    std::vector<std::string> step_ids (const vayu::core::ScenarioPlan& plan) {
        std::vector<std::string> ids;
        ids.reserve (plan.steps.size ());
        for (const auto& step : plan.steps) {
            ids.push_back (step.request_id);
        }
        return ids;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

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

// --- A data token with no data set (issue #415) -------------------------------

TEST_F (ScenarioPlanTest, ADataTokenWithNoDataSetIsRefusedNamingTheStepAndTheToken) {
    // Composition leaves `{{data.id}}` written as it stands on purpose, so a run
    // started without rows has nothing to bind it and would put the literal text
    // on the wire. Revert the scan in `resolve_scenario` and this resolves,
    // which is the shipped-through-to-the-server behaviour the issue reports.
    seed_collection ("col", "");
    seed_request ("clean", "col", /*order=*/0, "https://example.test/health");
    seed_request ("bound", "col", /*order=*/1, "https://example.test/u/{{data.id}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    // The step it names is the offending one, not the first one composed.
    EXPECT_NE (resolved.error.find ("step 1"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("Request bound"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("{{data.id}}"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("scenario.data"), std::string::npos)
    << resolved.error;
    // No partial plan, exactly as every other resolution failure leaves none.
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

// The identity shares the data namespace's template, and the refusal above must
// not follow it there: `{{$vu}}` needs no rows behind it, so a plan carrying
// only identity tokens is perfectly runnable (issue #994). Point the refusal's
// scan at `first_token` again instead of `first_data_token` and this reddens,
// with a run refused for lacking a data set it never needed.
TEST_F (ScenarioPlanTest, AnIdentityTokenNeedsNoDataSetAndIsNotRefusedForLackingOne) {
    seed_collection ("col", "");
    seed_request ("identity", "col", /*order=*/0,
    "https://example.test/u/{{$vu}}/i/{{$iteration}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    // Split for the bind and left written for it: the executor substitutes
    // them, so the plan still carries the tokens as composed.
    EXPECT_FALSE (resolved.plan.steps[0].data_template.empty ())
    << "the step's identity tokens were not split, so nothing would bind them";
    EXPECT_FALSE (resolved.plan.steps[0].data_template.first_data_token ().has_value ())
    << "an identity token must not read as a data token - that is what the "
       "no-data refusal scans for";
    EXPECT_NE (resolved.plan.steps[0].request.url.find ("{{$vu}}"), std::string::npos);
}

TEST_F (ScenarioPlanTest, TheSameCollectionResolvesWhenTheRunCarriesADataSet) {
    // The other half of the rule: the refusal is about the *absent* data set, not
    // about the token. A run with rows still resolves, and the token still
    // survives composition - the runner binds it per iteration, not here.
    seed_collection ("col", "");
    seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "id", "7" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    EXPECT_NE (resolved.plan.steps[0].request.url.find ("{{data.id}}"), std::string::npos)
    << resolved.plan.steps[0].request.url;
}

TEST_F (ScenarioPlanTest, ADataTokenOutsideTheUrlIsRefusedToo) {
    // The scan walks what `bind_data_row` substitutes, so every field the binder
    // would have bound must be a field the refusal sees. One field per case, so a
    // hole names itself instead of hiding behind the URL.
    const auto refused = [&] (const std::string& headers, const std::string& body) {
        reset_database ();
        seed_collection ("col", "");
        seed_request ("req", "col", /*order=*/0, "https://example.test/ok",
        /*auth=*/"", /*post_script=*/"", /*created_at=*/1, headers, body);

        const auto resolved =
        vayu::core::resolve_scenario (*db_, block ("col"), options ());
        EXPECT_FALSE (resolved.ok) << headers << " | " << body;
        EXPECT_NE (resolved.error.find ("{{data.id}}"), std::string::npos)
        << resolved.error;
    };

    refused (R"([{"key":"X-Id","value":"{{data.id}}","enabled":true}])", "");
    refused (R"([{"key":"{{data.id}}","value":"x","enabled":true}])", "");
    refused ("", R"({"mode":"json","content":"{\"id\":\"{{data.id}}\"}"})");
    refused ("", R"({"mode":"form-data","fields":[{"key":"id","value":"{{data.id}}","enabled":true}]})");
}

TEST_F (ScenarioPlanTest, TheNoDataRefusalCitesTheCollectionsDeclaredColumns) {
    // The reader that makes storing a contract worth anything (issue #599).
    // `resolve_scenario` already loaded this collection and threw it away;
    // capturing it is what lets the refusal say which file to run with rather
    // than only that one is missing. Revert the capture and this reddens.
    seed_collection ("col", "", /*order=*/0, /*auth=*/"", /*pre_script=*/"",
    /*created_at=*/1, R"({"columns":["id","email"],"declaredAt":1700000000000})");
    seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("declared columns: id, email"), std::string::npos)
    << resolved.error;
}

TEST_F (ScenarioPlanTest, TheNoDataRefusalStaysUnchangedWithoutAContract) {
    // The other half: a collection that declares nothing must not grow an empty
    // parenthetical, and a schema that is not one degrades to no tail at all
    // rather than to a message about columns that are not column names.
    for (const char* schema :
    { "{}", "", "not json", R"({"columns":"id"})", R"({"columns":[7]})" }) {
        reset_database ();
        seed_collection ("col", "", /*order=*/0, /*auth=*/"", /*pre_script=*/"",
        /*created_at=*/1, schema);
        seed_request ("bound", "col", /*order=*/0, "https://example.test/u/{{data.id}}");

        const auto resolved =
        vayu::core::resolve_scenario (*db_, block ("col"), options ());

        EXPECT_FALSE (resolved.ok) << schema;
        EXPECT_EQ (resolved.error.find ("declared columns"), std::string::npos)
        << schema << " -> " << resolved.error;
    }
}

TEST_F (ScenarioPlanTest, ThePrefixAloneDoesNotBlockARunWithoutData) {
    // `{{data.}}` names no column, so composition treats it as any other
    // unknown name - since #1009 that means the token is left written as it
    // stands, and the scan for *columns* still finds nothing. Refusing the run
    // would block it over a token that binds to nothing either way.
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://example.test/u/{{data.}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://example.test/u/{{data.}}");
}

// --- Data tokens in the credentials (issue #591) ------------------------------

namespace {

/// The `Authorization` a step is carrying, or "" when it carries none.
std::string authorization_of (const vayu::Request& request) {
    const auto header = request.headers.find ("Authorization");
    return header == request.headers.end () ? std::string{} : header->value;
}

/// `bind_step_iteration` for row @p row_index, for a step whose auth the plan
/// did not hold for the scripts: what these cases assert is what the bind
/// applies.
vayu::core::DataBindResult bind_step (vayu::Request& request,
const vayu::core::ScenarioStep& step,
const std::vector<json>& rows,
size_t row_index) {
    std::optional<vayu::http::Auth> late_auth;
    auto bound = vayu::core::bind_step_iteration (
    request, step, rows, row_index, vayu::core::IterationIdentity{}, late_auth);
    EXPECT_FALSE (late_auth.has_value ())
    << "the bind held auth for the scripts";
    return bound;
}

} // namespace

TEST_F (ScenarioPlanTest, BasicAuthCredentialsBindPerIterationRatherThanEncodingTheToken) {
    // The canonical data-driven run: a credentials file behind basic auth. Bind
    // the credentials after `apply_auth` and every iteration sends
    // `base64("{{data.user}}:{{data.pass}}")` - the literal token text - as an
    // ordinary-looking 401. Nothing in the plan can see it once it is encoded,
    // which is why the plan must not encode it.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{data.pass}}"})");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" }, { "pass", "s3cret" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.plan.steps.size (), 1u);
    const auto& step = resolved.plan.steps[0];

    // Deferred: the plan carries no credential at all for this step, so there
    // is nothing on it for the token text to have been baked into.
    EXPECT_FALSE (step.auth_template.empty ())
    << "the step's credentials carry a data token, so its auth must be "
       "deferred";
    EXPECT_EQ (authorization_of (step.request), "")
    << "auth was applied at plan time, which is what hid the token";

    vayu::Request request = step.request;
    const auto bound = bind_step (request, step, resolved.data_rows, /*row_index=*/0);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request),
    "Basic " + vayu::utils::base64_encode ("alice:s3cret"));
}

TEST_F (ScenarioPlanTest, EachRowGetsItsOwnCredentialsFromTheSamePlan) {
    // The plan is resolved once and shared by every iteration and virtual user,
    // so a bind that leaked into it would give every row the first row's
    // credentials. Two rows through one step is what shows it does not.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" } }, json{ { "user", "bob" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    std::vector<std::string> sent;
    for (size_t row = 0; row < resolved.data_rows.size (); ++row) {
        vayu::Request request = step.request;
        const auto bound = bind_step (request, step, resolved.data_rows, row);
        ASSERT_TRUE (bound.ok) << bound.error;
        sent.push_back (authorization_of (request));
    }

    EXPECT_EQ (sent[0], "Basic " + vayu::utils::base64_encode ("alice:pw"));
    EXPECT_EQ (sent[1], "Basic " + vayu::utils::base64_encode ("bob:pw"));
}

TEST_F (ScenarioPlanTest, BearerAndApiKeyCredentialsBindByContract) {
    // These two passed before this existed, but only by accident: their values
    // land verbatim in header text, so the request-side binder happened to walk
    // them. An api key in the *query* did not even manage that - `apply_auth`
    // percent-encoded the token's braces before the binder ever saw it. Pinned
    // so the accident cannot regress and the query placement stays fixed.
    const auto bound_request = [&] (const std::string& auth,
                               const std::string& url, const json& row) {
        reset_database ();
        seed_collection ("col", "");
        seed_request ("req", "col", /*order=*/0, url, auth);

        json scenario    = block ("col");
        scenario["data"] = json::array ({ row });

        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_TRUE (resolved.ok) << resolved.error;
        vayu::Request request = resolved.plan.steps[0].request;
        const auto result     = bind_step (
        request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
        EXPECT_TRUE (result.ok) << result.error;
        return request;
    };

    EXPECT_EQ (authorization_of (bound_request (R"({"mode":"bearer","token":"{{data.token}}"})",
               "https://example.test/x", json{ { "token", "t0ken" } })),
    "Bearer t0ken");

    const auto api_key_header =
    bound_request (R"({"mode":"apikey","key":"X-Key","value":"{{data.key}}"})",
    "https://example.test/x", json{ { "key", "k3y" } });
    ASSERT_EQ (api_key_header.headers.count ("X-Key"), 1u);
    EXPECT_EQ (api_key_header.headers.at ("X-Key"), "k3y");

    // The value is percent-encoded *after* the bind, so a cell with a space is
    // one query parameter rather than two.
    const auto api_key_query = bound_request (
    R"({"mode":"apikey","key":"token","value":"{{data.key}}","in":"query"})",
    "https://example.test/x", json{ { "key", "k 3y" } });
    EXPECT_EQ (api_key_query.url, "https://example.test/x?token=k%203y");
}

TEST_F (ScenarioPlanTest, AMissingColumnInACredentialEndsTheStepByName) {
    // The failure path: a credential naming a column the row does not carry is
    // the same loud error as one in the URL, not a request sent with a blank
    // password.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{data.missing}}"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    vayu::Request request = resolved.plan.steps[0].request;
    const auto bound =
    bind_step (request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
    EXPECT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("{{data.missing}}"), std::string::npos)
    << bound.error;
    EXPECT_EQ (authorization_of (request), "")
    << "a failed credential bind must send nothing, not a half-built header";
}

TEST_F (ScenarioPlanTest, ADataTokenInTheCredentialsWithNoDataSetIsRefused) {
    // The #415 guard, reached through the auth block. Before the credentials
    // were kept out of the base64 this run started and sent
    // `base64("{{data.user}}:")` on every request.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("{{data.user}}"), std::string::npos)
    << resolved.error;
    EXPECT_NE (resolved.error.find ("scenario.data"), std::string::npos)
    << resolved.error;
    EXPECT_TRUE (resolved.plan.steps.empty ());
}

TEST_F (ScenarioPlanTest, ADataTokenInAnOAuth2ConfigIsRefusedWithOrWithoutData) {
    // The one mode the row bind cannot serve: the token is acquired against
    // the endpoint, never bound per iteration. Refused by name rather than
    // sent to the token endpoint as the literal text.
    const auto refused = [&] (const json& scenario) {
        const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
        EXPECT_FALSE (resolved.ok);
        EXPECT_NE (resolved.error.find ("{{data.secret}}"), std::string::npos)
        << resolved.error;
        EXPECT_NE (resolved.error.find ("OAuth 2.0"), std::string::npos)
        << resolved.error;
        EXPECT_NE (resolved.error.find ("Request oauth_req"), std::string::npos)
        << resolved.error;
    };

    seed_collection ("col", "");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"tokenUrl":"https://auth.test/token",
        "clientId":"c","clientSecret":"{{data.secret}}"}})");

    refused (block ("col"));

    json with_rows    = block ("col");
    with_rows["data"] = json::array ({ json{ { "secret", "s" } } });
    refused (with_rows);
}

// #2521: a scripted step's OAuth 2.0 config waits for its script on a
// sequential plan, whose executor acquires after it; a load plan acquires
// once, here, from the stored values, keyed by the resolved config. Mutation
// check: make `resolve_step` compose with `AtComposition` whatever
// `oauth2_after_scripts` says, and the sequential plan carries the token.
TEST_F (ScenarioPlanTest, AScriptedOAuth2StepWaitsForItsScriptOnASequentialPlanOnly) {
    seed_collection ("col", "", /*order=*/0, /*auth=*/"",
    /*pre_script=*/"pm.environment.set('client', 'new');");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"grantType":"client_credentials","autoFetchToken":false,
        "accessTokenUrl":"https://auth.test/token","clientId":"{{client}}"}})");
    seed_environment ("env", R"({"client":{"value":"stored","enabled":true}})");
    // Cached under the stored config's key, so the load plan's acquisition
    // reads it with no endpoint behind it; non-expiring.
    vayu::db::OAuthToken token;
    token.cache_key    = vayu::http::oauth::cache_key (json{
    { "accessTokenUrl", "https://auth.test/token" }, { "clientId", "stored" } });
    token.access_token = "AT-stored";
    token.created_at   = 1;
    db_->save_oauth_token (token);

    auto sequential                 = options ();
    sequential.environment_id       = "env";
    sequential.oauth2_after_scripts = true;
    const auto waits = vayu::core::resolve_scenario (*db_, block ("col"), sequential);
    ASSERT_TRUE (waits.ok) << waits.error;
    const auto& late = waits.plan.steps.at (0);
    EXPECT_TRUE (late.auth_after_scripts);
    EXPECT_EQ (late.request.headers.count ("Authorization"), 0u);
    const auto* oauth2 = std::get_if<vayu::http::OAuth2Auth> (&late.auth);
    ASSERT_NE (oauth2, nullptr);
    EXPECT_EQ (oauth2->config.at ("clientId"), "{{client}}");

    auto load           = options ();
    load.environment_id = "env";
    const auto planned = vayu::core::resolve_scenario (*db_, block ("col"), load);
    ASSERT_TRUE (planned.ok) << planned.error;
    const auto& now = planned.plan.steps.at (0);
    EXPECT_FALSE (now.auth_after_scripts);
    ASSERT_EQ (now.request.headers.count ("Authorization"), 1u);
    EXPECT_EQ (now.request.headers.at ("Authorization"), "Bearer AT-stored");
}

// A name nothing answers: a load plan, which acquires before any script, has
// no moment left to resolve it and refuses it by name rather than asking the
// endpoint with the literal token; a sequential plan leaves it to the send.
TEST_F (ScenarioPlanTest, ALoadPlanRefusesAnOAuth2NameNothingAnswers) {
    seed_collection ("col", "");
    seed_request ("oauth_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"oauth2","config":{"grantType":"client_credentials",
        "accessTokenUrl":"https://auth.test/token","clientId":"{{client}}"}})");

    const auto refused = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    EXPECT_FALSE (refused.ok);
    EXPECT_NE (refused.error.find ("{{client}}"), std::string::npos) << refused.error;
    EXPECT_NE (refused.error.find ("Request oauth_req"), std::string::npos)
    << refused.error;

    auto sequential                 = options ();
    sequential.oauth2_after_scripts = true;
    const auto waits = vayu::core::resolve_scenario (*db_, block ("col"), sequential);
    ASSERT_TRUE (waits.ok) << waits.error;
    EXPECT_TRUE (waits.plan.steps.at (0).auth_after_scripts);
}

TEST_F (ScenarioPlanTest, CredentialsWithoutADataTokenAreStillResolvedIntoThePlan) {
    // Deferral must not widen: the ordinary step still pays its auth once, at
    // plan time, and carries an executable credential without any per-iteration
    // work. Drop the `auth_template.empty()` test in `resolve_scenario` and
    // this step arrives at the wire with no `Authorization` at all.
    seed_collection ("col", "");
    seed_request ("static_req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"basic","username":"alice","password":"s3cret"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "unused" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_TRUE (step.auth_template.empty ());
    EXPECT_FALSE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request),
    "Basic " + vayu::utils::base64_encode ("alice:s3cret"));

    // And `bind_step_iteration` is the no-op the executors call unconditionally.
    vayu::Request request = step.request;
    const auto bound = bind_step (request, step, resolved.data_rows, /*row_index=*/0);
    EXPECT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request), authorization_of (step.request));
}

TEST_F (ScenarioPlanTest, AUserSuppliedAuthorizationHeaderStillWinsOverBoundCredentials) {
    // `apply_auth`'s precedence rule is the deferred path's too, because it is
    // the same `apply_auth` - a header the user wrote is never overwritten,
    // whichever iteration the credentials came from.
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://example.test/x",
    R"({"mode":"basic","username":"{{data.user}}","password":"pw"})",
    /*post_script=*/"", /*created_at=*/1,
    R"([{"key":"Authorization","value":"Bearer mine","enabled":true}])");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    vayu::Request request = resolved.plan.steps[0].request;
    const auto bound =
    bind_step (request, resolved.plan.steps[0], resolved.data_rows, /*row_index=*/0);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request), "Bearer mine");
}

// --- Credentials that wait on a script (issue #2473) -------------------------

namespace {

/// The basic pair @p auth holds, as `user:password`, or a note saying what it
/// is instead.
std::string basic_pair_held (const std::optional<vayu::http::Auth>& auth) {
    if (!auth) {
        return "<no auth held>";
    }
    const auto* basic = std::get_if<vayu::http::BasicAuth> (&*auth);
    return basic == nullptr ? "<not basic>" : basic->username + ":" + basic->password;
}

} // namespace

TEST_F (ScenarioPlanTest, ACredentialOnlyAScriptCanAnswerIsHeldForTheScripts) {
    // `{{password}}` survives composition because no scope defines it yet; a
    // step's pre-request script may. Encoded here it would be base64 of the
    // token text, which no later pass can read. Mutation check: drop
    // `auth_after_scripts` from the resolution in `resolve_step` and the step
    // carries `Basic base64(user:{{password}})` with nothing held.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"user","password":"{{password}}"})");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_TRUE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request), "")
    << "auth was encoded at plan time, around the token";

    vayu::Request request = step.request;
    std::optional<vayu::http::Auth> late_auth;
    const auto bound = vayu::core::bind_step_iteration (request, step,
    resolved.data_rows, std::nullopt, vayu::core::IterationIdentity{}, late_auth);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (basic_pair_held (late_auth), "user:{{password}}");
    EXPECT_EQ (authorization_of (request), "")
    << "the bind applied what it was meant to hold";
}

TEST_F (ScenarioPlanTest, ARowTokenBesideAScriptTokenBindsTheRowAndHoldsTheRest) {
    // Mixed credentials: the row answers its half at the bind, before anything
    // is encoded, and the script's half still waits.
    seed_collection ("col", "");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{password}}"})");

    json scenario    = block ("col");
    scenario["data"] = json::array ({ json{ { "user", "alice" } } });

    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];
    EXPECT_TRUE (step.auth_after_scripts);
    EXPECT_FALSE (step.auth_template.empty ());

    vayu::Request request = step.request;
    std::optional<vayu::http::Auth> late_auth;
    const auto bound = vayu::core::bind_step_iteration (request, step,
    resolved.data_rows, /*row_index=*/0, vayu::core::IterationIdentity{}, late_auth);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (basic_pair_held (late_auth), "alice:{{password}}");
    EXPECT_EQ (basic_pair_held (step.auth), "{{data.user}}:{{password}}")
    << "the bind wrote into the plan every iteration shares";
}

TEST_F (ScenarioPlanTest, ACredentialAScopeAnsweredAtComposeIsStillResolvedIntoThePlan) {
    // No behaviour change for the ordinary step: composition substituted the
    // name, so nothing waits, and the plan pays the auth once as it always did.
    seed_collection ("col", "");
    seed_environment ("env", R"({"password":{"value":"s3cret"}})");
    seed_request ("login", "col", /*order=*/0, "https://example.test/login",
    R"({"mode":"basic","username":"user","password":"{{password}}"})");

    auto opts           = options ();
    opts.environment_id = "env";
    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), opts);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const auto& step = resolved.plan.steps[0];

    EXPECT_FALSE (step.auth_after_scripts);
    EXPECT_EQ (authorization_of (step.request),
    "Basic " + vayu::utils::base64_encode ("user:s3cret"));
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
