/**
 * @file tests/scenario_plan_test.cpp
 * @brief Tests for scenario plan resolution (issue #352, phase 1 of the
 * collection runner).
 *
 * Three contracts are pinned here, and each of them is one a later phase builds
 * on rather than a detail of this one:
 *
 *  - **Ordering.** The order the sidebar displays: direct requests by
 *    `requests.order`, and - recursively - each sub-collection's whole subtree
 *    ahead of its parent's own requests, sub-collections by `collections.order`,
 *    depth-first. Driven case by case from
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
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
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
        col.name               = "Collection " + id;
        col.auth               = auth;
        col.pre_request_script = pre_script;
        col.data_schema        = data_schema;
        col.order              = order;
        col.created_at         = created_at;
        col.updated_at         = created_at;
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
        r.id                  = id;
        r.collection_id       = collection_id;
        r.name                = "Request " + id;
        r.method              = vayu::HttpMethod::GET;
        r.url                 = url;
        r.headers             = headers;
        r.body                = body;
        r.auth                = auth;
        r.post_request_script = post_script;
        r.order               = order;
        r.created_at          = created_at;
        r.updated_at          = created_at;
        db_->save_request (r);
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

TEST_F (ScenarioPlanTest, RecursiveDescentRunsEachSubtreeBeforeTheFoldersOwnRequests) {
    //   root            [root_a, root_b]
    //     child_b (order 1)  [b_1]
    //     child_a (order 0)  [a_1]
    //       grandchild       [g_1]
    //
    // The sidebar renders every subfolder above every request at each depth
    // (`CollectionItem.tsx`), so `g_1` (deepest) is the first row a user sees
    // under `root` and the root's own requests are the last two. The walk used
    // to be pre-order - `root_a, root_b, a_1, g_1, b_1` - which is an order the
    // tree never showed (issue #431). Mutation check: restore the pre-order push
    // in `collect_requests` and this reddens, along with every fixture case.
    seed_collection ("root", "");
    seed_collection ("child_b", "root", /*order=*/1);
    seed_collection ("child_a", "root", /*order=*/0);
    seed_collection ("grandchild", "child_a", /*order=*/0);
    seed_request ("root_a", "root", /*order=*/0);
    seed_request ("root_b", "root", /*order=*/1);
    seed_request ("b_1", "child_b");
    seed_request ("a_1", "child_a");
    seed_request ("g_1", "grandchild");

    const auto resolved = vayu::core::resolve_scenario (
    *db_, block ("root", /*recursive=*/true), options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (step_ids (resolved.plan),
    (std::vector<std::string>{ "g_1", "a_1", "b_1", "root_a", "root_b" }));
}

// --- The cross-consumer order (fixture-driven) --------------------------------

TEST_F (ScenarioPlanTest, RunOrderConformanceFixtureIsNonEmpty) {
    // Guards the scan itself: a fixture that failed to load would make every
    // case below vacuously pass.
    const json fixture = load_run_order_fixture ();
    ASSERT_TRUE (fixture.contains ("cases"));
    EXPECT_GE (fixture["cases"].size (), 5u);
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
    EXPECT_GE (cases_run, 5u) << "the fixture loop asserted nothing";
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
    // sequence follows from the subfolders-first rule - "b" is a child of "a",
    // so its request runs first - and a cycle has no displayed order to agree
    // with, since the sidebar renders such a row as an orphaned root.
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

    // Non-empty, so the equalities below are comparing something.
    const std::string expected_pre = vayu::http::read_pre_request_script (payload);
    const std::string expected_post = vayu::http::read_post_request_script (payload);
    ASSERT_FALSE (expected_pre.empty ());
    ASSERT_FALSE (expected_post.empty ());
    EXPECT_EQ (step.pre_script, expected_pre);
    EXPECT_EQ (step.post_script, expected_post);

    // Environment variables resolved, and auth applied into the plan.
    EXPECT_EQ (step.request.url, "https://api.example.test/orders/42");
    ASSERT_EQ (step.request.headers.count ("Authorization"), 1u);
    EXPECT_EQ (step.request.headers.at ("Authorization"), "Bearer s3cret");

    EXPECT_EQ (step.name, "Request req");
    EXPECT_EQ (step.stored_url, "https://{{host}}/orders/{{id}}");
}

TEST_F (ScenarioPlanTest, StepsResolveAgainstTheRunsEnvironment) {
    // Without the run's environmentId reaching composition, every {{env var}}
    // in the plan silently resolves to "" - the failure this guards.
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

TEST_F (ScenarioPlanTest, ManifestRecordsOnlyTheDataRowCount) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    json scenario = block ("col");
    scenario["data"] =
    json::array ({ json{ { "user", "alice" } }, json{ { "user", "bob" } } });
    const auto resolved = vayu::core::resolve_scenario (*db_, scenario, options ());
    ASSERT_TRUE (resolved.ok) << resolved.error;

    const json manifest =
    vayu::core::build_scenario_manifest (resolved.request, resolved.plan);
    EXPECT_EQ (manifest["dataRowCount"], 2);
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

TEST_F (ScenarioPlanTest, AnOversizedDataBlockIsRejectedByItsByteBound) {
    seed_collection ("col", "");
    seed_request ("req", "col");

    // Two rows - comfortably inside `maxScenarioDataRows` - carrying far more
    // than the byte bound between them. The row count cannot catch this, which
    // is the whole reason the byte bound exists: without it the payload runs
    // into the transport's own body cap and the user gets a dropped connection
    // instead of a sentence.
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
    // `{{data.}}` names no column, so composition resolves it to "" like any
    // other unknown name and nothing survives for the scan to find. Refusing it
    // would block a run over a token that never reaches the wire.
    seed_collection ("col", "");
    seed_request ("req", "col", /*order=*/0, "https://example.test/u/{{data.}}");

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("col"), options ());

    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.plan.steps[0].request.url, "https://example.test/u/");
}

// --- Data tokens in the credentials (issue #591) ------------------------------

namespace {

/// The `Authorization` a step is carrying, or "" when it carries none.
std::string authorization_of (const vayu::Request& request) {
    const auto header = request.headers.find ("Authorization");
    return header == request.headers.end () ? std::string{} : header->second;
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
    const auto bound =
    vayu::core::bind_step_row (request, step, resolved.data_rows[0], /*row_index=*/0);
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
        const auto bound =
        vayu::core::bind_step_row (request, step, resolved.data_rows[row], row);
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
        const auto result     = vayu::core::bind_step_row (
        request, resolved.plan.steps[0], resolved.data_rows[0], /*row_index=*/0);
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
    const auto bound      = vayu::core::bind_step_row (
    request, resolved.plan.steps[0], resolved.data_rows[0], /*row_index=*/0);
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
    // The one mode deferral cannot serve: the token is acquired here, once, so
    // no iteration exists for a row to reach. Refused by name rather than sent
    // to the token endpoint as the literal text.
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
    EXPECT_EQ (authorization_of (step.request),
    "Basic " + vayu::utils::base64_encode ("alice:s3cret"));

    // And `bind_step_row` is the no-op the executors call unconditionally.
    vayu::Request request = step.request;
    const auto bound =
    vayu::core::bind_step_row (request, step, resolved.data_rows[0], /*row_index=*/0);
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
    const auto bound      = vayu::core::bind_step_row (
    request, resolved.plan.steps[0], resolved.data_rows[0], /*row_index=*/0);
    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (authorization_of (request), "Bearer mine");
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
