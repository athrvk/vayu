/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/load_identity_test.cpp
 * @brief The iteration identity - `{{$vu}}` and `{{$iteration}}` (issue #994).
 *
 * A load run always knew which virtual user was sending and which of its
 * iterations this was; the request had no way of reading either, so "N users,
 * each with its own id" was expressible only through a data file. The two names
 * are a reserved namespace beside `{{data.*}}`, bound by the executor
 * immediately before the send.
 *
 * Three layers, because a bind that is right at one and wrong at the next is a
 * request nobody meant to send: the split (which fields carry a token, and what
 * a refusal calls it), the wire (what actually left, per submission and per
 * virtual user), and the deferred script (what `pm.info` reports about the
 * response it is grading).
 *
 * The **token-free** path is asserted here too, and deliberately: it is the
 * throughput guard #992 states, and a guard nothing tests is a guard that
 * decays into a branch someone deletes.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/routes.hpp"

namespace {

using nlohmann::json;
using vayu::core::apply_iteration_template;
using vayu::core::IterationBinding;
using vayu::core::IterationIdentity;
using vayu::core::tokenize_bindable_fields;

/// A GET whose URL is @p url, as every executor here submits one.
vayu::Request request_to (const std::string& url) {
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 5000;
    return request;
}

/// A listener that records the path and query of every request it answers.
///
/// Read off the wire rather than off the request the executor built: a bind
/// that produced the right string and then lost it downstream is still a
/// request nobody meant to send, which is the reasoning `load_data_test.cpp`
/// records for its own listener.
class RecordingServer {
    public:
    RecordingServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (64);

        // The identity substitutes into the path, so what a submission bound is
        // readable off the wire rather than inferred from a counter the test
        // also owns.
        svr.Get (R"(/i/(.*))", [this] (const httplib::Request& req, httplib::Response& res) {
            record ("/i/" + req.matches[1].str ());
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/plain", [this] (const httplib::Request&, httplib::Response& res) {
            record ("/plain");
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~RecordingServer () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    RecordingServer (const RecordingServer&)            = delete;
    RecordingServer& operator= (const RecordingServer&) = delete;
    RecordingServer (RecordingServer&&)                 = delete;
    RecordingServer& operator= (RecordingServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    [[nodiscard]] std::vector<std::string> paths () const {
        std::lock_guard<std::mutex> lock (paths_mtx_);
        return paths_;
    }

    private:
    void record (const std::string& path) {
        std::lock_guard<std::mutex> lock (paths_mtx_);
        paths_.push_back (path);
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex paths_mtx_;
    std::vector<std::string> paths_;
};

constexpr const char* TEST_DB_PATH = "test_load_identity.db";

class LoadIdentityTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (TEST_DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        context_.reset ();
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    /**
     * Run @p payload to completion the way `execute_load_test` does around the
     * strategy: the route's reader, the same build the run performs, the splits
     * `build_load_request` makes, then drain.
     *
     * Every step goes through production's own function rather than a
     * hand-built equivalent - a test that split its own templates would pass
     * against a splitter the engine never runs.
     */
    void run (const json& payload) {
        auto read = vayu::http::routes::read_load_data_set (
        payload, stock_limits (), /*is_scenario=*/false);
        ASSERT_TRUE (read.ok) << read.error;

        auto built = vayu::http::build_request (payload, db_.get (), /*timeout_ms=*/5000,
        read.set ? read.set->auth_resolution () : vayu::http::AuthResolution::Apply);
        ASSERT_TRUE (built.ok) << built.error_message;

        auto context =
        std::make_shared<vayu::core::RunContext> ("test-load-identity", payload);
        context->load_data     = std::move (read.set);
        context->load_template = tokenize_bindable_fields (built.request);
        context->test_script   = payload.value ("tests", std::string ());
        vayu::http::EventLoopConfig loop_config;
        loop_config.max_concurrent = 100;
        loop_config.max_per_host   = 100;
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        auto strategy = vayu::core::LoadStrategy::create (payload);
        strategy->execute (context, *db_, built.request);
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        context_ = context;
    }

    /// What the deferred pass recorded as failures, so an assertion can say
    /// *why* a replay failed rather than only that it did.
    std::string replay_failures () {
        std::string joined;
        for (const auto& result : db_->get_results ("test-load-identity")) {
            const auto trace = json::parse (result.trace_data, nullptr, false);
            if (trace.is_discarded () || !trace.contains ("failures")) {
                continue;
            }
            for (const auto& failure : trace["failures"]) {
                joined += failure.get<std::string> () + "; ";
            }
        }
        return joined;
    }

    static vayu::core::ScenarioLimits stock_limits () {
        vayu::core::ScenarioLimits limits;
        limits.max_data_rows  = vayu::core::constants::scenario::MAX_DATA_ROWS;
        limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
        return limits;
    }

    /// An iterations payload against @p url, retaining every completion so an
    /// assertion is about what a record carries rather than which budget
    /// claimed it. Concurrency 1, so the order on the wire is the claim order.
    static json iterations_payload (const std::string& url, size_t iterations) {
        return json{ { "method", "GET" }, { "url", url },
            { "mode", "iterations" }, { "iterations", iterations },
            { "concurrency", 1 }, { "save_timing_breakdown", true },
            { "success_sample_rate", 1 }, { "slow_threshold_ms", 0 },
            { "response_sample_rate", 1 }, { "max_response_samples", 100 } };
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
};

// ============================================================================
// The split - which fields carry a token, and what a refusal calls it
// ============================================================================

// The guard, stated structurally: a request naming no reserved token splits no
// fields at all, so the per-iteration join is one `empty()` test. A generator
// and an ordinary variable are deliberately in it - both are composition's, and
// neither survives to the bind.
TEST (IdentitySplit, ARequestCarryingNoReservedTokenSplitsNothing) {
    auto request = request_to ("https://api.test/users?g={{$guid}}");
    request.headers["X-Trace"] = "{{traceId}}";
    EXPECT_TRUE (tokenize_bindable_fields (request).empty ())
    << "a request with no reserved token must cost the executor nothing per "
       "iteration - a non-empty template here is walked for every submission";
}

TEST (IdentitySplit, BothNamesAreKeptOutOfEveryBindableField) {
    auto request                   = request_to ("https://api.test/u{{$vu}}");
    request.headers["X-Iteration"] = "{{$iteration}}";
    request.body.mode              = vayu::BodyMode::Json;
    request.body.content           = R"({"user":"{{$vu}}"})";

    const auto tmpl = tokenize_bindable_fields (request);
    EXPECT_EQ (tmpl.fields.size (), 3u)
    << "the URL, the header value and the body each carry one";
    // The names are kept as written, which is what lets one template hold both
    // reserved namespaces and still know where each value comes from.
    EXPECT_EQ (tmpl.fields.front ().tokens, (std::vector<std::string>{ "$vu" }));
}

// A name that only looks like the identity is somebody else's: it keeps its
// braces under the unknown-`$name` rule (#186) rather than being bound to a
// number nobody asked for.
TEST (IdentitySplit, ANameThatOnlyLooksLikeTheIdentityIsNotKept) {
    const auto tmpl = tokenize_bindable_fields (
    request_to ("https://api.test/{{$vus}}/{{$iterations}}"));
    EXPECT_TRUE (tmpl.empty ());
}

TEST (IdentityBind, TheNumbersAreWrittenWhereTheTokensWere) {
    auto request = request_to ("https://api.test/u{{$vu}}/i{{$iteration}}");
    request.headers["X-User"] = "user-{{$vu}}";

    const auto tmpl  = tokenize_bindable_fields (request);
    const auto bound = apply_iteration_template (
    request, tmpl, IterationBinding{ nullptr, 0, IterationIdentity{ 3, 7 } });

    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (request.url, "https://api.test/u3/i7");
    EXPECT_EQ (request.headers["X-User"], "user-3");
}

// Two occurrences of one name in one request are one value, which is the
// property that separates the identity from a generator: `{{$guid}}` twice is
// two guids, `{{$iteration}}` twice is one iteration.
TEST (IdentityBind, EveryOccurrenceInOneRequestReadsTheSameIteration) {
    auto request =
    request_to ("https://api.test/{{$iteration}}?also={{$iteration}}");
    const auto bound =
    apply_iteration_template (request, tokenize_bindable_fields (request),
    IterationBinding{ nullptr, 0, IterationIdentity{ 1, 42 } });

    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (request.url, "https://api.test/42?also=42");
}

// The identity rides the data namespace's own joiner, so it inherits the
// encodings *and* the refusals. This is the one refusal it can reach, and the
// message has to name the token the way the user wrote it - `{{$vu}}`, not the
// `{{data.vu}}` a namespace-blind spelling would produce.
TEST (IdentityBind, ATokenInsideAnXmlCommentIsRefusedNamingItsOwnSpelling) {
    auto request         = request_to ("https://api.test/x");
    request.body.mode    = vayu::BodyMode::Xml;
    request.body.content = "<r><!-- user {{$vu}} --></r>";

    const auto bound =
    apply_iteration_template (request, tokenize_bindable_fields (request),
    IterationBinding{ nullptr, 0, IterationIdentity{} });

    ASSERT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("{{$vu}}"), std::string::npos) << bound.error;
    EXPECT_EQ (bound.error.find ("data."), std::string::npos)
    << "an identity refusal must not describe itself as a data column: "
    << bound.error;
}

// A JSON body is a document with a quoting rule, and the identity binds through
// the rule rather than beside it - the same joiner, so the document a run sends
// stays parseable however the token was placed.
TEST (IdentityBind, ATokenInsideAJsonStringBindsAsStringContent) {
    auto request         = request_to ("https://api.test/x");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"user":"u{{$vu}}","n":{{$iteration}}})";

    const auto bound =
    apply_iteration_template (request, tokenize_bindable_fields (request),
    IterationBinding{ nullptr, 0, IterationIdentity{ 2, 5 } });

    ASSERT_TRUE (bound.ok) << bound.error;
    const auto sent = json::parse (request.body.content);
    EXPECT_EQ (sent["user"].get<std::string> (), "u2");
    EXPECT_EQ (sent["n"].get<int> (), 5) << "a typed placement stays a number";
}

// The values a send outside any run reports, which is what `POST /execute`
// binds: a run of one rather than a token reaching the wire written as it
// stands.
TEST (IdentityBind, ASendOutsideAnyRunIsARunOfOne) {
    auto request = request_to ("https://api.test/u{{$vu}}/i{{$iteration}}");
    const auto bound =
    apply_iteration_template (request, tokenize_bindable_fields (request),
    IterationBinding{ nullptr, 0, IterationIdentity{} });

    ASSERT_TRUE (bound.ok) << bound.error;
    EXPECT_EQ (request.url, "https://api.test/u1/i0");
}

// ============================================================================
// A single-request load run - one user, one iteration per submission
// ============================================================================

// The headline for this shape: four submissions are iterations 0..3 of user 1.
TEST_F (LoadIdentityTest, IterationsAreNumberedFromZeroAndTheUserIsAlwaysOne) {
    RecordingServer server;

    run (iterations_payload (server.url ("/i/{{$vu}}-{{$iteration}}"), 4));

    EXPECT_EQ (server.paths (),
    (std::vector<std::string>{ "/i/1-0", "/i/1-1", "/i/1-2", "/i/1-3" }))
    << "one request repeated is one user's iterations, numbered in claim order";
}

// The row a submission binds and the iteration it reports come off one cursor,
// so a script cannot be told it is iteration 3 while holding row 1's values.
TEST_F (LoadIdentityTest, TheIterationAndTheRowItBindsAgree) {
    RecordingServer server;
    json payload =
    iterations_payload (server.url ("/i/{{$iteration}}-{{data.id}}"), 5);
    payload["data"] = json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } });

    run (payload);

    EXPECT_EQ (server.paths (),
    (std::vector<std::string>{ "/i/0-a", "/i/1-b", "/i/2-a", "/i/3-b", "/i/4-a" }))
    << "iteration i must bind row i % rows - the two are one cursor";
}

// The throughput guard, made structural: a run whose request names neither
// token carries an empty template, which is the single test the submission path
// makes before submitting the shared request it always did.
TEST_F (LoadIdentityTest, ARunWithoutTheTokensCarriesAnEmptyTemplate) {
    RecordingServer server;

    run (iterations_payload (server.url ("/plain"), 2));

    EXPECT_TRUE (context_->load_template.empty ())
    << "a request naming neither token must leave nothing for the executor to "
       "walk per submission";
    EXPECT_EQ (server.paths ().size (), 2u);
}

// What a deferred `tests` script is told about the response it is grading. Both
// fields, because the pair is what identifies a submission - and this shape is
// where `pm.info.iteration` used to read `undefined`.
TEST_F (LoadIdentityTest, TheDeferredScriptReadsTheIterationAndUserItWasSentAs) {
    RecordingServer server;
    json payload     = iterations_payload (server.url ("/plain"), 3);
    payload["tests"] = R"js(pm.test('identity', function () {
  if (pm.info.vu !== 1) { throw new Error('vu was ' + pm.info.vu); }
  if (typeof pm.info.iteration !== 'number') { throw new Error('no iteration'); }
  if (pm.info.iteration < 0 || pm.info.iteration > 2) {
    throw new Error('iteration was ' + pm.info.iteration);
  }
});)js";

    run (payload);

    // The samples carry the iterations they were sent in - three distinct ones,
    // not one repeated, which is what the script's own verdict cannot tell.
    std::vector<size_t> iterations;
    for (const auto& sample : context_->metrics_collector->response_samples ()) {
        ASSERT_HAS_VALUE (sample.iteration) << "a sample carries no iteration";
        ASSERT_HAS_VALUE (sample.vu) << "a sample carries no virtual user";
        EXPECT_EQ (*sample.vu, 1u);
        iterations.push_back (*sample.iteration);
    }
    std::sort (iterations.begin (), iterations.end ());
    EXPECT_EQ (iterations, (std::vector<size_t>{ 0, 1, 2 }));

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << replay_failures ();
    EXPECT_EQ (validation.run->passed, 3u);
}

// The same run shape, asked the other way a script can ask (issue #1057): the
// two APIs answer one question about one submission, so a script that renders
// the identity gets what the script beside it reports reading.
TEST_F (LoadIdentityTest, ADeferredScriptResolvesTheIdentityItWasSentAs) {
    RecordingServer server;
    json payload     = iterations_payload (server.url ("/plain"), 3);
    payload["tests"] = R"js(pm.test('identity', function () {
  var resolved = pm.variables.replaceIn('{{$vu}}/{{$iteration}}');
  var reported = pm.info.vu + '/' + pm.info.iteration;
  if (resolved !== reported) {
    throw new Error(resolved + ' is not the ' + reported + ' it was sent as');
  }
});)js";

    run (payload);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << replay_failures ();
    EXPECT_EQ (validation.run->passed, 3u);
}

// Every pacing mode binds, not only the one whose submit path was written
// first: the strategies share one submission helper, and this is what says so.
TEST_F (LoadIdentityTest, EveryPacingModeBindsTheIdentity) {
    // `constant_rps` deliberately included: its submissions go through the
    // rate-limited tick loop rather than the closed-loop controller.
    for (const char* mode : { "constant_concurrency", "constant_rps", "ramp_up", "capacity" }) {
        RecordingServer server;
        const json payload = { { "method", "GET" },
            { "url", server.url ("/i/{{$vu}}-{{$iteration}}") },
            { "mode", mode }, { "duration", "300ms" }, { "concurrency", 2 },
            { "targetRps", 50.0 }, { "startConcurrency", 1 },
            { "stepDuration", "100ms" }, { "rampUpDuration", "100ms" } };

        run (payload);

        const auto paths = server.paths ();
        ASSERT_FALSE (paths.empty ()) << "mode " << mode << " sent nothing";
        for (const auto& path : paths) {
            EXPECT_EQ (path.rfind ("/i/1-", 0), 0u)
            << "mode " << mode << " sent an unbound path: " << path;
        }
    }
}

// ============================================================================
// A scenario load run - the shape where virtual users differ from one another
// ============================================================================

class ScenarioIdentityTest : public LoadIdentityTest {
    protected:
    /// A one-step plan hitting @p url, tokenised the way plan resolution
    /// tokenises it - through the real splitter, for the reason
    /// `scenario_load_test.cpp`'s own helper records.
    static vayu::core::ScenarioExecution plan_over (const std::string& url) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";
        vayu::core::ScenarioStep step;
        step.index              = 0;
        step.request_id         = "req_0";
        step.name               = "step0";
        step.request.method     = vayu::HttpMethod::GET;
        step.request.url        = url;
        step.request.timeout_ms = 5000;
        step.stored_url         = url;
        step.data_template      = tokenize_bindable_fields (step.request);
        execution.plan.steps.push_back (std::move (step));
        return execution;
    }

    std::shared_ptr<vayu::core::ScenarioLoadState> run_scenario (const json& config,
    const vayu::core::ScenarioExecution& execution) {
        auto context =
        std::make_shared<vayu::core::RunContext> ("test-load-identity", config);
        context->scenario =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        vayu::http::EventLoopConfig loop_config;
        loop_config.max_concurrent = 500;
        loop_config.max_per_host   = 500;
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        auto state = vayu::core::execute_scenario_load (context, *db_, *context->scenario);
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        context_ = context;
        return state;
    }
};

// The issue's own headline: two virtual users observe distinct `{{$vu}}` values
// and each advances its own `{{$iteration}}`. Both halves matter - a bind that
// reported the same user twice would still show iterations advancing.
TEST_F (ScenarioIdentityTest, EachVirtualUserBindsItsOwnNumberAndAdvancesItsOwnIteration) {
    RecordingServer server;
    auto execution = plan_over (server.url ("/i/{{$vu}}-{{$iteration}}"));

    run_scenario (
    json{ { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 2 } }, execution);

    // Which user runs how many iterations is the scheduler's business - a user
    // whose completion lands first is handed the next one - so the assertion is
    // the property rather than a fixed list: both users sent, each numbered
    // itself, and each counted its own iterations from zero with no repeat and
    // no gap. A bind that reported one user twice, or that froze the iteration,
    // fails on exactly this.
    std::map<std::string, std::vector<std::string>> by_user;
    for (const auto& path : server.paths ()) {
        const auto dash = path.find ('-');
        ASSERT_NE (dash, std::string::npos) << path;
        by_user[path.substr (0, dash)].push_back (path.substr (dash + 1));
    }
    EXPECT_EQ (by_user.size (), 2u)
    << "both virtual users must appear, each as itself";
    size_t total = 0;
    for (auto& [user, iterations] : by_user) {
        EXPECT_TRUE (user == "/i/1" || user == "/i/2")
        << "a user numbered outside the run's own: " << user;
        std::sort (iterations.begin (), iterations.end ());
        std::vector<std::string> expected;
        expected.reserve (iterations.size ());
        for (size_t i = 0; i < iterations.size (); ++i) {
            expected.push_back (std::to_string (i));
        }
        EXPECT_EQ (iterations, expected) << "user " << user << " did not count from zero";
        total += iterations.size ();
    }
    EXPECT_EQ (total, 4u);
}

// The deferred half on this path: a step's own script reads the user and the
// iteration its sampled response was sent as, which is what makes an assertion
// about "user 2's third request" possible at all. Both users' numbers are
// checked against the run's concurrency rather than against a fixed one, since
// which user a sample came from is the scheduler's business.
TEST_F (ScenarioIdentityTest, ADeferredStepScriptReadsTheUserAndIterationItRanAs) {
    RecordingServer server;
    auto execution = plan_over (server.url ("/plain"));
    execution.plan.steps[0].post_script =
    "pm.test('identity', function () {"
    "  if (pm.info.vu !== 1 && pm.info.vu !== 2) {"
    "    throw new Error('vu was ' + pm.info.vu);"
    "  }"
    "  if (typeof pm.info.iteration !== 'number') {"
    "    throw new Error('no iteration');"
    "  }"
    "});";

    run_scenario (json{ { "mode", "iterations" }, { "iterations", 4 },
                  { "concurrency", 2 }, { "response_sample_rate", 1 } },
    execution);

    // Every sample carries a user inside the run's own range - the assertion
    // the script cannot make about itself, since it only ever sees its own.
    for (const auto& sample : context_->metrics_collector->step_response_samples (0)) {
        ASSERT_HAS_VALUE (sample.vu) << "a step sample carries no virtual user";
        EXPECT_TRUE (*sample.vu == 1 || *sample.vu == 2) << *sample.vu;
        ASSERT_HAS_VALUE (sample.iteration)
        << "a step sample carries no iteration";
    }

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_EQ (validation.steps.size (), 1u);
    // Read through one binding rather than re-derived per assertion: the guard
    // and the uses have to be the same expression for the checker - and for a
    // reader - to connect them (engine/CLAUDE.md).
    const auto& step_tally = validation.steps[0];
    ASSERT_HAS_VALUE (step_tally);
    EXPECT_EQ (step_tally->failed, 0u) << replay_failures ();
    EXPECT_EQ (step_tally->passed, 4u);
}

// The script resolver answers the identity on the run shape where a wrong
// source would show (issue #1057): two users, four iterations, nothing pinned
// to the 1 and 0 a run of one gets. `pm.info` is what it is checked against,
// and the chain that makes that the wire's answer is the two tests above -
// `{{$vu}}` reaches the server as each user's own number, and `pm.info` reports
// the number the sample was sent as.
//
// A deferred script is also the case that needs this most: the replay hands it
// the *plan's* request, whose URL still spells the token, so before this change
// there was no way for it to read the identity as text at all.
TEST_F (ScenarioIdentityTest, AStepScriptResolvesTheIdentityItRanAs) {
    RecordingServer server;
    auto execution = plan_over (server.url ("/i/{{$vu}}-{{$iteration}}"));
    execution.plan.steps[0].post_script =
    "pm.test('identity', function () {"
    "  var resolved = pm.variables.replaceIn('{{$vu}}-{{$iteration}}');"
    "  var reported = pm.info.vu + '-' + pm.info.iteration;"
    "  if (resolved !== reported) {"
    "    throw new Error(resolved + ' is not the ' + reported + ' it ran as');"
    "  }"
    "});";

    run_scenario (json{ { "mode", "iterations" }, { "iterations", 4 },
                  { "concurrency", 2 }, { "response_sample_rate", 1 } },
    execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& step_tally = validation.steps[0];
    ASSERT_HAS_VALUE (step_tally);
    EXPECT_EQ (step_tally->failed, 0u) << replay_failures ();
    EXPECT_EQ (step_tally->passed, 4u);
}

// A plan carrying no identity token is not walked for one, which is the same
// guard the single-request path keeps - asserted on the plan the executor
// actually runs rather than on the executor's behaviour.
TEST_F (ScenarioIdentityTest, APlanWithoutTheTokensSplitsNoFields) {
    RecordingServer server;
    const auto execution = plan_over (server.url ("/plain"));
    EXPECT_TRUE (execution.plan.steps.front ().data_template.empty ());
}

} // namespace
