/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file assert_snapshot_pages_load_test.cpp
 * @brief `assert.snapshot` over a paged list in both load-run shapes (#3824):
 *        the completion reads every page, the pages count toward that step's
 *        recorded latency, and they are no submission of their own.
 *
 * The binder cases drive `vayu::http::LoadListPages` over a reply sent to
 * `McpFixtureServer`; the run cases start scenario and single-request load
 * runs through `RunManager`, whose `configure_event_loop` resolves the run's
 * route out as production does.
 *
 * Mutation checks: leave `send_list_page` unbound in `run_step_after` or in
 * `run_request_elements_after_submission` and that shape's unchanged-list case
 * reports the element failed; record `result` instead of the paged response in
 * either completion and its latency case reads the first page alone; also
 * record the received response in the scenario completion (a page counted as
 * a completion) and the request-count case reads double; drop
 * `pages.page_ms ()` from `run_step_after`'s pipeline time and the
 * `includeScriptTime` case reads both pages twice; drop the jar seed in
 * `LoadListPages::start_paging` and the session case sends page 2 with no
 * cookie; drop the `lines_for` copy in `take` and the next step loses the
 * page's cookie; drop `config_.cancel` and the Stop case waits out the page
 * timeout and reports it failed; leave the view on the received response in
 * `start_paging` and the copy case reads no page time.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "mcp_fixture_server.hpp"
#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "temp_database.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/snapshot_page_send.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

#include "scenario_load_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::tests::McpFixtureServer;
using vayu::tests::scenario_load::ScenarioMockServer;

json tool_item (const std::string& name, const std::string& type = "string") {
    return { { "name", name }, { "description", "does " + name },
        { "inputSchema",
        { { "type", "object" }, { "properties", { { "x", { { "type", type } } } } } } } };
}

const json& three_tools () {
    static const json tools =
    json::array ({ tool_item ("alpha"), tool_item ("beta"), tool_item ("gamma") });
    return tools;
}

json snapshot_element (const json& baseline) {
    return { { "id", "n1" }, { "kind", "assert.snapshot" }, { "enabled", true },
        { "config", { { "method", "tools/list" }, { "baseline", baseline } } } };
}

/// A `tools/list` call to @p server, as `POST /runs` reads a request.
json list_payload (const McpFixtureServer& server) {
    return json{ { "method", "POST" }, { "url", server.url () }, { "timeout", 5000 },
        { "body",
        { { "mode", "mcp" }, { "content", json{ { "method", "tools/list" } }.dump () } } } };
}

vayu::Request request_from (const json& payload) {
    auto request = vayu::json::deserialize_request (payload);
    if (!request.is_ok ()) {
        ADD_FAILURE () << request.error ().message;
        return {};
    }
    return std::move (request).value ();
}

/// The row a load report's step keeps for the element @p id, or null.
json element_row (const json& step, const std::string& id) {
    for (const auto& row : step.value ("elements", json::array ())) {
        if (row.value ("id", "") == id) {
            return row;
        }
    }
    return nullptr;
}

size_t count_of (const json& row, const char* bucket) {
    return row.is_object () ? row.value (bucket, size_t{ 0 }) : 0;
}

// ---------------------------------------------------------------------------
// The binder, over one reply the event loop would have delivered.
// ---------------------------------------------------------------------------

class LoadListPagesTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// What one `step.after` run through the binder left.
    struct BoundRun {
        std::vector<vayu::core::ElementOutcome> outcomes;
        vayu::Response received;
        std::optional<vayu::Response> paged;
        double page_ms = 0;
    };

    /// The fixture's first `tools/list` page, judged as the event loop judges
    /// it, then the snapshot run over it with the binder bound.
    BoundRun run (const json& baseline) {
        vayu::Request request = request_from (list_payload (*server_));
        BoundRun bound;
        bound.received = vayu::http::Client ().send (request).value ();
        vayu::http::attach_mcp_reply (request, bound.received);

        vayu::runtime::ScriptSendInputs route;
        vayu::http::LoadListPages pages (route, bound.received);
        std::optional<vayu::Response> unwrapped;
        vayu::ScriptResult pre;
        vayu::ScriptResult post;
        vayu::core::ElementContext ctx{
            .request = request,
            .response = vayu::http::mcp_element_view (bound.received, unwrapped),
            .run_pre_script     = {},
            .run_post_script    = {},
            .pre_script_result  = pre,
            .post_script_result = post,
            .set_variable       = {},
            .should_stop        = {},
            .record_metric      = {},
        };
        pages.bind (ctx);
        vayu::core::ElementPipeline::run (vayu::core::Phase::StepAfter, ctx,
        vayu::core::compile_elements (json::array ({ snapshot_element (baseline) })),
        bound.outcomes);
        bound.page_ms = pages.page_ms ();
        bound.paged   = pages.take ();
        return bound;
    }

    std::unique_ptr<McpFixtureServer> server_;
};

// The message a person reads in the run's sample names the item and where it
// changed, page 2's change included.
TEST_F (LoadListPagesTest, AChangeOnPageTwoFailsNamingTheToolAndItsPointer) {
    server_->set_tools (json::array ({ tool_item ("alpha"),
                        tool_item ("beta", "integer"), tool_item ("delta") }),
    1);
    const auto bound = run (three_tools ());
    ASSERT_EQ (bound.outcomes.size (), 1u);
    EXPECT_EQ (bound.outcomes[0].status, "failed");
    EXPECT_EQ (bound.outcomes[0].message.value_or (""),
    "tools/list changed: removed 'gamma'; added 'delta'; 'beta' differs at "
    "/inputSchema/properties/x/type");
}

// Every page's time lands on the copy, the received response is left as the
// event loop delivered it, and the reply counts its pages. The figures are the
// recorded ones, so no clock is read here.
TEST_F (LoadListPagesTest, ThePagesLandOnACopyOfTheStepsResponse) {
    server_->set_tools (three_tools (), 1);
    const auto bound = run (three_tools ());
    ASSERT_EQ (bound.outcomes.size (), 1u);
    EXPECT_EQ (bound.outcomes[0].status, "ok")
    << bound.outcomes[0].message.value_or ("");

    ASSERT_HAS_VALUE (bound.paged);
    EXPECT_DOUBLE_EQ (bound.paged->timing.total_ms,
    bound.received.timing.total_ms + bound.page_ms);
    EXPECT_GT (bound.page_ms, 0.0);
    ASSERT_HAS_VALUE (bound.paged->mcp_reply);
    EXPECT_EQ (bound.paged->mcp_reply->pages, 3u);
    ASSERT_HAS_VALUE (bound.received.mcp_reply);
    EXPECT_EQ (bound.received.mcp_reply->pages, 1u);
}

TEST_F (LoadListPagesTest, AnUnpagedReplyCopiesNothing) {
    server_->set_tools (three_tools ());
    const auto bound = run (three_tools ());
    EXPECT_EQ (bound.outcomes.at (0).status, "ok");
    EXPECT_FALSE (bound.paged.has_value ());
    EXPECT_EQ (bound.page_ms, 0.0);
}

// ---------------------------------------------------------------------------
// Load runs through `RunManager`.
// ---------------------------------------------------------------------------

constexpr size_t ITERATIONS = 3;

class AssertSnapshotPagesLoadTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_assert_snapshot_pages_load.db";

    void SetUp () override {
        vayu::http::global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        mcp_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        db_.reset ();
        mcp_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        vayu::http::global_cleanup ();
    }

    /// A plan step sending @p payload, carrying @p elements.
    static vayu::core::ScenarioStep step_of (const json& payload,
    const std::string& name,
    const std::vector<json>& elements = {}) {
        vayu::core::ScenarioStep step;
        step.index      = 0;
        step.request_id = "req_" + name;
        step.name       = name;
        step.request    = request_from (payload);
        step.stored_url = step.request.url;
        if (!elements.empty ()) {
            step.elements = vayu::tests::compiled_elements (elements);
        }
        return step;
    }

    /// The one-step plan of the fixture's `tools/list` under @p baseline.
    [[nodiscard]] std::vector<vayu::core::ScenarioStep> list_plan (const json& baseline) const {
        std::vector<vayu::core::ScenarioStep> steps;
        steps.push_back (
        step_of (list_payload (*mcp_), "list", { snapshot_element (baseline) }));
        return steps;
    }

    /// Starts the run @p config describes; the scenario run when @p steps
    /// are given, the single-request run of @p config's own request when not.
    std::string start (json config, std::vector<vayu::core::ScenarioStep> steps = {}) {
        const std::string run_id = "run_snapshot_pages_" + std::to_string (++runs_);
        std::shared_ptr<const vayu::core::ScenarioExecution> scenario;
        if (!steps.empty ()) {
            config["scenario"] = { { "source", "collection" },
                { "collectionId", "col_pages" } };
            auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
            execution->request.source        = "collection";
            execution->request.collection_id = "col_pages";
            for (size_t i = 0; i < steps.size (); ++i) {
                steps[i].index = i;
                execution->plan.steps.push_back (std::move (steps[i]));
            }
            scenario = std::move (execution);
        }
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        // Wall-clock dated: an epoch-dated run is pruned the moment it ends.
        run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        run.end_time = run.start_time;
        db_->create_run (run);
        EXPECT_TRUE (manager_.start_run (run_id, config, *db_, scenario));
        return run_id;
    }

    /// `GET /runs/:id/report`'s body once @p run_id has finished.
    json report_when_done (const std::string& run_id) {
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return manager_.get_run (run_id) == nullptr; }))
        << "the run never finished";
        auto [status, body] = vayu::http::routes::run_report_response (*db_, run_id);
        EXPECT_EQ (status, 200) << body.dump ();
        return body;
    }

    json run_scenario (std::vector<vayu::core::ScenarioStep> steps,
    size_t iterations       = ITERATIONS,
    const json& run_options = json::object ()) {
        json config = { { "mode", "iterations" }, { "iterations", iterations },
            { "concurrency", 1 } };
        config.update (run_options);
        return report_when_done (start (std::move (config), std::move (steps)));
    }

    json run_single_request (const json& baseline, size_t iterations = ITERATIONS) {
        json config = list_payload (*mcp_);
        config.update (json{ { "mode", "iterations" },
        { "iterations", iterations }, { "concurrency", 1 },
        { "requestElements", json::array ({ snapshot_element (baseline) }) } });
        return report_when_done (start (std::move (config)));
    }

    /// The `tools/list` requests the fixture received.
    [[nodiscard]] size_t list_requests () const {
        return mcp_->tools_list_cursors ().size ();
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<McpFixtureServer> mcp_;
    vayu::core::RunManager manager_;
    size_t runs_ = 0;
};

/// The single-request report's element row for the snapshot.
json request_element_row (const json& report) {
    for (const auto& row : report.value ("elements", json::array ())) {
        if (row.value ("id", "") == "n1") {
            return row;
        }
    }
    ADD_FAILURE () << "no element row for the snapshot: " << report.dump ();
    return nullptr;
}

// Page one alone holds only `alpha`, so a run that compared it alone, or could
// not follow the cursor, would fail every iteration.
TEST_F (AssertSnapshotPagesLoadTest, AScenarioLoadRunComparesAnUnchangedPagedListWhole) {
    mcp_->set_tools (three_tools (), 1);
    const auto report = run_scenario (list_plan (three_tools ()));
    const json& step  = report.at ("scenario").at ("steps").at (0);
    const json row    = element_row (step, "n1");
    EXPECT_EQ (count_of (row, "passed"), ITERATIONS) << step.dump ();
    EXPECT_EQ (count_of (row, "failed"), 0u) << step.dump ();
    EXPECT_EQ (list_requests (), 3 * ITERATIONS);
}

TEST_F (AssertSnapshotPagesLoadTest, ARenameOnPageTwoFailsTheScenarioLoadStep) {
    mcp_->set_tools (
    json::array ({ tool_item ("alpha"), tool_item ("beta-renamed"), tool_item ("gamma") }), 2);
    const auto report    = run_scenario (list_plan (three_tools ()));
    const json& scenario = report.at ("scenario");
    const json row       = element_row (scenario.at ("steps").at (0), "n1");
    EXPECT_EQ (count_of (row, "failed"), ITERATIONS) << scenario.dump ();
    EXPECT_EQ (scenario.value ("failed", size_t{ 0 }), ITERATIONS) << scenario.dump ();
}

// The pages are part of their step: every iteration sent two `tools/list`
// requests, and the run counts one request and one execution per iteration.
TEST_F (AssertSnapshotPagesLoadTest, PagesAreNoRequestsOrIterationsOfTheirOwn) {
    mcp_->set_tools (three_tools (), 2);
    const auto report = run_scenario (list_plan (three_tools ()));
    EXPECT_EQ (list_requests (), 2 * ITERATIONS);
    EXPECT_EQ (report.at ("summary").value ("totalRequests", size_t{ 0 }), ITERATIONS)
    << report.at ("summary").dump ();
    const json& step = report.at ("scenario").at ("steps").at (0);
    EXPECT_EQ (step.value ("executed", size_t{ 0 }), ITERATIONS) << step.dump ();
}

// Page 2 is held `PAGE_DELAY`, so a step whose latency carries its pages reads
// at least that, and one that drops them reads the first page's few
// milliseconds. Lower bounds only, which a slow runner cannot fail; the run's
// own latency population is held to the same figure as the step's.
TEST_F (AssertSnapshotPagesLoadTest, APagesTimeCountsTowardTheScenarioStepsLatency) {
    constexpr std::chrono::milliseconds PAGE_DELAY{ 300 };
    mcp_->set_tools (three_tools (), 2);
    mcp_->delay_cursor_pages (PAGE_DELAY);
    const auto report     = run_scenario (list_plan (three_tools ()), 2);
    const double delay_ms = static_cast<double> (PAGE_DELAY.count ());
    const json& step      = report.at ("scenario").at ("steps").at (0);
    EXPECT_GE (step.at ("latency").value ("min", 0.0), delay_ms) << step.dump ();
    EXPECT_GE (report.at ("latency").value ("min", 0.0), delay_ms)
    << report.at ("latency").dump ();
}

// `includeScriptTime` adds the pipeline's own time, which holds the page sends:
// the pages are already the step's, so they are taken out of it. A healthy
// reading is `PAGE_DELAY` (500 ms) and a few milliseconds of pipeline; one that
// counted the page twice is at least twice that (1000 ms). The bound sits
// halfway, 250 ms from either.
TEST_F (AssertSnapshotPagesLoadTest, IncludeScriptTimeCountsAPageOnce) {
    constexpr std::chrono::milliseconds PAGE_DELAY{ 500 };
    mcp_->set_tools (three_tools (), 2);
    mcp_->delay_cursor_pages (PAGE_DELAY);
    const auto report     = run_scenario (list_plan (three_tools ()), 1,
    json{ { "elements", { { "includeScriptTime", true } } } });
    const double delay_ms = static_cast<double> (PAGE_DELAY.count ());
    const json& latency = report.at ("scenario").at ("steps").at (0).at ("latency");
    EXPECT_GE (latency.value ("max", 0.0), delay_ms) << latency.dump ();
    EXPECT_LT (latency.value ("max", 0.0), 1.5 * delay_ms) << latency.dump ();
}

// Neither loop stop compares part of the list: each fails the assertion after
// the pages it read, which the fixture counts.
TEST_F (AssertSnapshotPagesLoadTest, ARepeatedCursorOrThePageCapFailsTheLoadStep) {
    mcp_->set_tools (three_tools (), 1);
    mcp_->repeat_tools_cursor ();
    auto report = run_scenario (list_plan (three_tools ()), 1);
    EXPECT_EQ (
    count_of (element_row (report.at ("scenario").at ("steps").at (0), "n1"), "failed"), 1u)
    << report.at ("scenario").dump ();
    EXPECT_EQ (list_requests (), 2u);

    mcp_->repeat_tools_cursor (false);
    json many = json::array ();
    for (size_t i = 0; i <= vayu::core::constants::elements::MAX_SNAPSHOT_PAGES; ++i) {
        many.push_back (tool_item ("t" + std::to_string (i)));
    }
    mcp_->set_tools (many, 1);
    report = run_scenario (list_plan (many), 1);
    EXPECT_EQ (
    count_of (element_row (report.at ("scenario").at ("steps").at (0), "n1"), "failed"), 1u)
    << report.at ("scenario").dump ();
    EXPECT_EQ (list_requests (), 2 + vayu::core::constants::elements::MAX_SNAPSHOT_PAGES);
}

// A page carries the session the VU's earlier steps left, and the session the
// page left reaches the VU's next step. `/login` and the fixture share a host,
// whose cookies are not kept per port.
TEST_F (AssertSnapshotPagesLoadTest, APageCarriesAndKeepsTheVirtualUsersSession) {
    ScenarioMockServer origin;
    mcp_->set_tools (three_tools (), 2);
    mcp_->set_cookie_on_cursor_pages ("paged=yes; Path=/");
    std::vector<vayu::core::ScenarioStep> steps;
    steps.push_back (step_of (
    json{ { "method", "GET" }, { "url", origin.url ("/login") }, { "timeout", 5000 } }, "login"));
    steps.push_back (
    step_of (list_payload (*mcp_), "list", { snapshot_element (three_tools ()) }));
    steps.push_back (step_of (
    json{ { "method", "GET" }, { "url", origin.url ("/echo") }, { "timeout", 5000 } }, "echo"));

    const auto report = run_scenario (std::move (steps), 1);
    EXPECT_EQ (
    count_of (element_row (report.at ("scenario").at ("steps").at (1), "n1"), "passed"), 1u)
    << report.at ("scenario").dump ();
    ASSERT_EQ (list_requests (), 2u);
    EXPECT_EQ (mcp_->header ("Cookie"), "sid=1");
    const auto echoed = origin.hits_for ("/echo");
    ASSERT_EQ (echoed.size (), 1u);
    EXPECT_NE (echoed[0].cookie.find ("sid=1"), std::string::npos) << echoed[0].cookie;
    EXPECT_NE (echoed[0].cookie.find ("paged=yes"), std::string::npos)
    << echoed[0].cookie;
}

// A Stop while a page is in flight is the run ending: the assertion records no
// verdict, and the run does not wait out the page's timeout.
TEST_F (AssertSnapshotPagesLoadTest, AStopWhileAPageIsInFlightIsNoVerdict) {
    mcp_->set_tools (three_tools (), 2);
    mcp_->hang_cursor_pages ();
    const std::string run_id = start (
    json{ { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } },
    list_plan (three_tools ()));
    ASSERT_TRUE (vayu::tests::wait_until ([&] { return list_requests () == 2; }));
    const auto context = manager_.get_run (run_id);
    ASSERT_NE (context, nullptr);
    context->request_stop ();

    const auto report = report_when_done (run_id);
    const json row = element_row (report.at ("scenario").at ("steps").at (0), "n1");
    EXPECT_EQ (count_of (row, "skipped"), 1u) << report.at ("scenario").dump ();
    EXPECT_EQ (count_of (row, "failed"), 0u) << report.at ("scenario").dump ();
}

TEST_F (AssertSnapshotPagesLoadTest, ASingleRequestLoadRunComparesAnUnchangedPagedListWhole) {
    mcp_->set_tools (three_tools (), 1);
    const auto report = run_single_request (three_tools ());
    const json row    = request_element_row (report);
    EXPECT_EQ (count_of (row, "passed"), ITERATIONS) << report.dump ();
    EXPECT_EQ (count_of (row, "failed"), 0u) << report.dump ();
    EXPECT_EQ (list_requests (), 3 * ITERATIONS);
    EXPECT_EQ (report.at ("summary").value ("totalRequests", size_t{ 0 }), ITERATIONS);
}

TEST_F (AssertSnapshotPagesLoadTest, ARenameOnPageTwoFailsASingleRequestLoadRun) {
    mcp_->set_tools (
    json::array ({ tool_item ("alpha"), tool_item ("beta-renamed"), tool_item ("gamma") }), 2);
    const auto report = run_single_request (three_tools ());
    EXPECT_EQ (count_of (request_element_row (report), "failed"), ITERATIONS)
    << report.dump ();
}

// Lower bound only, as in the scenario case.
TEST_F (AssertSnapshotPagesLoadTest, APagesTimeCountsTowardASingleRequestRunsLatency) {
    constexpr std::chrono::milliseconds PAGE_DELAY{ 300 };
    mcp_->set_tools (three_tools (), 2);
    mcp_->delay_cursor_pages (PAGE_DELAY);
    const auto report = run_single_request (three_tools (), 2);
    EXPECT_GE (report.at ("latency").value ("min", 0.0),
    static_cast<double> (PAGE_DELAY.count ()))
    << report.at ("latency").dump ();
}

} // namespace
