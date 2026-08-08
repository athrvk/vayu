/**
 * @file tests/scenario_plan_test.cpp
 * @brief Tests for scenario plan resolution (issue #352, phase 1 of the
 * collection runner).
 *
 * Three contracts are pinned here, and each of them is one a later phase builds
 * on rather than a detail of this one:
 *
 *  - **Ordering.** Direct requests by `requests.order`, then descendant
 *    collections by `collections.order`, depth-first - and a `parent_id` cycle
 *    terminates instead of hanging the DB mutex.
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
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/script_parts.hpp"

using nlohmann::json;

namespace {

class ScenarioPlanTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scenario_plan.db";

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
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
    }

    void seed_collection (const std::string& id,
    const std::string& parent_id,
    int order                     = 0,
    const std::string& auth       = "",
    const std::string& pre_script = "") {
        vayu::db::Collection col;
        col.id = id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.name               = "Collection " + id;
        col.auth               = auth;
        col.pre_request_script = pre_script;
        col.order              = order;
        col.created_at         = 1;
        col.updated_at         = 1;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    int order                      = 0,
    const std::string& url         = "https://example.test/{{path}}",
    const std::string& auth        = "",
    const std::string& post_script = "") {
        vayu::db::Request r;
        r.id                  = id;
        r.collection_id       = collection_id;
        r.name                = "Request " + id;
        r.method              = vayu::HttpMethod::GET;
        r.url                 = url;
        r.auth                = auth;
        r.post_request_script = post_script;
        r.order               = order;
        r.created_at          = 1;
        r.updated_at          = 1;
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
    static vayu::core::ScenarioResolveOptions
    options (size_t max_steps = 200, size_t max_data_rows = 1000) {
        vayu::core::ScenarioResolveOptions opts;
        opts.timeout_ms           = 30000;
        opts.limits.max_steps     = max_steps;
        opts.limits.max_data_rows = max_data_rows;
        return opts;
    }

    static json block (const std::string& collection_id, bool recursive = false) {
        return json{ { "source", "collection" },
            { "collectionId", collection_id }, { "recursive", recursive } };
    }

    std::vector<std::string> step_ids (const vayu::core::ScenarioPlan& plan) {
        std::vector<std::string> ids;
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

TEST_F (ScenarioPlanTest, RecursiveDescentIsDepthFirstByCollectionOrder) {
    //   root            [root_a, root_b]
    //     child_b (order 1)  [b_1]
    //     child_a (order 0)  [a_1]
    //       grandchild       [g_1]
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
    (std::vector<std::string>{ "root_a", "root_b", "a_1", "g_1", "b_1" }));
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
        auto row       = db_->get_request (id);
        ASSERT_TRUE (row.has_value ());
        row->created_at = created_at;
        db_->save_request (*row);
    };
    make_older ("earlier", 1000);
    make_older ("later", 2000);

    const auto resolved = vayu::core::resolve_scenario (*db_, block ("root"), options ());
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
    EXPECT_EQ (step_ids (resolved.plan), (std::vector<std::string>{ "in_a", "in_b" }));
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
    EXPECT_NE (resolved.error.find ("2"), std::string::npos) << resolved.error;
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

    const auto rejected = [&] (json scenario) {
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
