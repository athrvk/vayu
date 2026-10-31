/**
 * @file tests/scenario_load_test.cpp
 * @brief The load-mode scenario executor: the per-VU state machine, per-VU
 *        cookies and per-step histograms (issue #357).
 *
 * These drive `execute_scenario_load` directly against an in-process mock,
 * which is what lets them assert the *sequence* a virtual user actually sent
 * rather than only the totals a run reports. The mock records every path and
 * `Cookie` header it saw, in order, because the two properties this phase turns
 * on - a VU walks its own plan, and two VUs never share a session - are not
 * visible in any aggregate.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>

#include "basic_auth_pair.hpp"
#include "echo_server.hpp"
#include "log_capture.hpp"
#include "mock_server.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;

/**
 * @brief A mock that issues a distinct session per `/login` and echoes back the
 *        `Cookie` header every other path was called with.
 *
 * `/login` can be made to wait for a second concurrent caller, which is what
 * makes "two VUs overlapped, and still did not share a session" a deterministic
 * assertion rather than a race the test hopes to win.
 */
class ScenarioMockServer {
    public:
    static constexpr int64_t SLOW_MS = 20;

    struct Hit {
        std::string path;
        std::string cookie; // The `Cookie` header as received; "" when absent.
        std::string body;   // The request body as received; "" for a GET.
        // The `Authorization` as received; "" when absent. Read off the wire
        // because a credential bound from a data row is only correct once it is
        // encoded, and the encoding is what used to hide the bug (issue #591).
        std::string authorization;
    };

    explicit ScenarioMockServer (size_t login_rendezvous = 0)
    : login_rendezvous_ (login_rendezvous) {
        svr.new_task_queue = vayu::tests::pooled_task_queue (64);

        svr.Get ("/login", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/login");
            if (login_rendezvous_ > 0) {
                std::unique_lock<std::mutex> lock (rendezvous_mtx_);
                ++waiting_;
                rendezvous_cv_.notify_all ();
                // Bounded, so a single-VU run (or a lost wakeup) cannot wedge
                // the binary - the assertion, not the timeout, is what fails.
                rendezvous_cv_.wait_for (lock, std::chrono::seconds (5),
                [this] { return waiting_ >= login_rendezvous_; });
            }
            const size_t id = ++session_counter_;
            res.set_header ("Set-Cookie", "sid=" + std::to_string (id) + "; Path=/");
            // A per-session token, distinct per login, so a test can prove
            // step 2 saw *this* VU's own extracted value rather than
            // whichever login happened to run last (issue #1495).
            res.set_content (R"({"token": "tok-)" + std::to_string (id) + R"("})",
            "application/json");
        });

        // A 200 that is a page, not JSON: what a gateway answers in an outage
        // (#3041).
        svr.Get ("/html", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/html");
            res.set_content ("<html><body>Service Unavailable</body></html>", "text/html");
        });

        for (const char* path : { "/echo", "/s0", "/s1", "/s2" }) {
            svr.Get (path, [this, path] (const httplib::Request& req, httplib::Response& res) {
                record (req, path);
                res.set_content ("{}", "application/json");
            });
        }

        // A target that takes a known time per request, so a run's time on the
        // wire is a measurable share of it (#2821).
        svr.Get ("/slow", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/slow");
            std::this_thread::sleep_for (std::chrono::milliseconds (SLOW_MS));
            res.set_content ("{}", "application/json");
        });

        // A response that arrived and is still an error (#2134): unlike the
        // refused port the transport-error tests use, it has a status.
        svr.Get ("/fail500", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/fail500");
            res.status = 500;
            res.set_content (R"({"error":"boom"})", "application/json");
        });

        // The body a bind produced, read off the wire rather than off the plan:
        // a body that binds cleanly and is then re-encoded downstream is still
        // a corrupt request (issue #593).
        svr.Post ("/body", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/body");
            res.set_content ("{}", "application/json");
        });

        // A `{{data.*}}` token substitutes into the path, so the row a virtual
        // user bound is readable off the wire rather than inferred from a
        // counter the test also owns.
        svr.Get (R"(/row/(.*))", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/row/" + req.matches[1].str ());
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~ScenarioMockServer () {
        {
            std::lock_guard<std::mutex> lock (rendezvous_mtx_);
            login_rendezvous_ = 0;
        }
        rendezvous_cv_.notify_all ();
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    ScenarioMockServer (const ScenarioMockServer&)            = delete;
    ScenarioMockServer& operator= (const ScenarioMockServer&) = delete;
    ScenarioMockServer (ScenarioMockServer&&)                 = delete;
    ScenarioMockServer& operator= (ScenarioMockServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    [[nodiscard]] std::vector<Hit> hits () const {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        return hits_;
    }

    [[nodiscard]] std::vector<Hit> hits_for (const std::string& path) const {
        std::vector<Hit> matching;
        for (const auto& hit : hits ()) {
            if (hit.path == path)
                matching.push_back (hit);
        }
        return matching;
    }

    private:
    void record (const httplib::Request& req, const std::string& path) {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        hits_.push_back ({ path, req.get_header_value ("Cookie"), req.body,
        req.get_header_value ("Authorization") });
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;

    mutable std::mutex hits_mtx_;
    std::vector<Hit> hits_;

    std::atomic<size_t> session_counter_{ 0 };
    std::mutex rendezvous_mtx_;
    std::condition_variable rendezvous_cv_;
    size_t login_rendezvous_ = 0;
    size_t waiting_          = 0;
};

constexpr const char* TEST_DB_PATH = "test_scenario_load.db";

class ScenarioLoadTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (TEST_DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    /// A plan whose steps hit @p urls in order, named `step0`, `step1`, ...
    static vayu::core::ScenarioExecution plan_over (const std::vector<std::string>& urls) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";
        for (size_t i = 0; i < urls.size (); ++i) {
            vayu::core::ScenarioStep step;
            step.index              = i;
            step.request_id         = "req_" + std::to_string (i);
            step.name               = "step" + std::to_string (i);
            step.request.method     = vayu::HttpMethod::GET;
            step.request.url        = urls[i];
            step.request.timeout_ms = 5000;
            step.stored_url         = urls[i];
            execution.plan.steps.push_back (std::move (step));
        }
        return execution;
    }

    /// Run the executor to completion and drain, the way `execute_load_test`
    /// does around it - the tallies are only final after the drain.
    ///
    /// @param pool_size The event loop's `max_concurrent`, which is also the
    ///        number of curl handles pre-created per worker. The cookie tests
    ///        set it to exactly the virtual-user count so the pool *wraps* and
    ///        every transfer after the first reuses a handle a previous one
    ///        finished with. At the default (hundreds) a short test never
    ///        reuses a handle at all, so it could not observe a session leaking
    ///        through one - the pool would be doing the isolating, not the code
    ///        under test.
    ///
    /// @param environment_id The stored environment the run loads, as
    ///        `POST /runs`' `environmentId` names one.
    std::shared_ptr<vayu::core::ScenarioLoadState> run (const json& config,
    const vayu::core::ScenarioExecution& execution,
    size_t pool_size                                 = 500,
    const std::optional<std::string>& environment_id = std::nullopt) {
        auto context =
        std::make_shared<vayu::core::RunContext> ("test-scenario-load", config);
        // Set the way `execute_load_test` does, so the deferred validation pass
        // finds the plan where production leaves it rather than where a test
        // handed it over.
        context->scenario =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        vayu::http::EventLoopConfig loop_config;
        loop_config.max_concurrent = pool_size;
        loop_config.max_per_host   = 500;
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        auto base_scopes = vayu::http::routes::load_script_variable_scopes (
        *db_, environment_id, context->scenario->request.collection_id);
        auto state = vayu::core::execute_scenario_load (
        context, *db_, *context->scenario, std::move (base_scopes));
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        context_ = context;
        return state;
    }

    /// Tokenise every step of @p execution the way plan resolution does.
    /// Going through `tokenize_bindable_fields` rather than hand-building a
    /// template is deliberate: a test that built its own would pass against a
    /// splitter the resolver never uses.
    ///
    /// Rows are a separate question - a deferred generator (issue #995) and the
    /// iteration identity bind off the iteration alone - so a run without a
    /// data set splits its steps through this and stops here.
    static void split_steps (vayu::core::ScenarioExecution& execution) {
        for (auto& step : execution.plan.steps) {
            step.data_template = vayu::core::tokenize_bindable_fields (step.request);
        }
    }

    /// @copydoc split_steps, and give the run @p rows.
    static void with_data (vayu::core::ScenarioExecution& execution,
    const std::vector<json>& rows) {
        split_steps (execution);
        execution.data_rows = rows;
    }

    /// A two-step plan (issue #1495): `/login` (step 0) then @p url with an
    /// `Authorization: Bearer {{token}}` header (step 1) - the shape every
    /// inline-element test below correlates a step-0 extraction through.
    /// `{{token}}` is neither a data nor an identity token, so it reaches
    /// this file's new residual-token pass untouched by `bind_step_iteration`
    /// - exactly the gap issue #1495 closes.
    static vayu::core::ScenarioExecution
    plan_login_then_bearer (ScenarioMockServer& server, const std::string& url) {
        auto execution = plan_over ({ server.url ("/login"), url });
        execution.plan.steps[1].request.headers["Authorization"] =
        "Bearer {{token}}";
        return execution;
    }

    /// Give every step the deferred auth `resolve_scenario` leaves behind for
    /// credentials carrying a `{{data.*}}` token - through the resolver's own
    /// two calls, for the same reason `with_data` uses the real splitter.
    static void with_deferred_auth (vayu::core::ScenarioExecution& execution,
    const json& auth) {
        for (auto& step : execution.plan.steps) {
            step.auth          = vayu::http::parse_auth (auth);
            step.auth_template = vayu::core::tokenize_auth_fields (step.auth);
        }
    }

    /// A one-step plan resolved by `resolve_scenario` from a stored request
    /// GETting @p url under @p auth, for a case whose subject is a decision
    /// the resolver makes rather than one this file can hand-build.
    vayu::core::ScenarioExecution resolve_one_step (const std::string& url,
    const json& auth,
    const json& elements,
    const json& data = json ()) {
        vayu::db::Collection collection;
        collection.id         = "col_test";
        collection.name       = "Collection";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        vayu::db::Request request;
        request.id            = "req_0";
        request.collection_id = collection.id;
        request.name          = "step0";
        request.method        = vayu::HttpMethod::GET;
        request.url           = url;
        request.auth          = auth.dump ();
        request.elements      = elements.dump ();
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);

        json scenario{ { "source", "collection" }, { "collectionId", collection.id } };
        if (!data.is_null ()) {
            scenario["data"] = data;
        }
        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.limits.max_steps     = 10;
        options.limits.max_data_rows = 100;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        vayu::core::ScenarioExecution execution;
        execution.request   = std::move (resolved.request);
        execution.plan      = std::move (resolved.plan);
        execution.data_rows = std::move (resolved.data_rows);
        return execution;
    }

    /// `plan_login_then_bearer`, stored and planned by `resolve_scenario` as a
    /// load run plans it (#2521): `col_test` holds `token=old`, step 0 GETs
    /// `/login` carrying @p login_elements, and step 1 GETs `/echo` sending
    /// `Bearer {{token}}` with no element of its own.
    vayu::core::ScenarioExecution
    resolve_login_then_bearer (const ScenarioMockServer& server, const json& login_elements) {
        vayu::db::Collection collection;
        collection.id         = "col_test";
        collection.name       = "Collection";
        collection.variables  = R"({"token":{"value":"old","enabled":true}})";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        const auto save = [&] (const std::string& id, int order, const std::string& path,
                          const json& headers, const json& elements) {
            vayu::db::Request request;
            request.id            = id;
            request.collection_id = collection.id;
            request.name          = id;
            request.method        = vayu::HttpMethod::GET;
            request.url           = server.url (path);
            request.headers       = headers.dump ();
            request.elements      = elements.dump ();
            request.order         = order;
            request.created_at    = 1;
            request.updated_at    = 1;
            db_->save_request (request);
        };
        save ("login", 0, "/login", json::array (), login_elements);
        save ("use", 1, "/echo",
        json::array ({ { { "key", "Authorization" },
        { "value", "Bearer {{token}}" }, { "enabled", true } } }),
        json::array ());

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.limits.max_steps     = 10;
        options.limits.max_data_rows = 100;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
        auto resolved = vayu::core::resolve_scenario (*db_,
        json{ { "source", "collection" }, { "collectionId", collection.id } }, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        vayu::core::ScenarioExecution execution;
        execution.request = std::move (resolved.request);
        execution.plan    = std::move (resolved.plan);
        return execution;
    }

    /// Run @p execution as a scenario load run through `RunManager`, the
    /// production path that stores the summary, and answer its report.
    json run_to_report (json config, const vayu::core::ScenarioExecution& execution) {
        config["scenario"] = { { "source", "collection" }, { "collectionId", "col_test" } };
        const std::string run_id = "run_report";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        // Wall-clock dated: an epoch-dated run is pruned the moment it finishes.
        run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        run.end_time = run.start_time;
        db_->create_run (run);

        vayu::core::RunManager manager;
        EXPECT_TRUE (manager.start_run (run_id, config, *db_,
        std::make_shared<const vayu::core::ScenarioExecution> (execution)));
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return manager.get_run (run_id) == nullptr; }))
        << "the run never finished";
        manager.shutdown ();
        return vayu::http::routes::run_report_response (*db_, run_id).second;
    }

    /// Run @p execution @p iterations times through the sequential runner, as
    /// `POST /runs` starts a collection run, and answer its report: the
    /// other run kind `run_to_report`'s figures are held to.
    json run_sequentially_to_report (vayu::core::ScenarioExecution execution, size_t iterations) {
        execution.request.iterations = iterations;
        const json config            = { { "scenario",
        { { "source", "collection" }, { "collectionId", "col_test" },
        { "iterations", iterations } } } };
        const std::string run_id     = "run_sequential_report";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Scenario;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        run.end_time = run.start_time;
        db_->create_run (run);

        vayu::http::CookieJar jar;
        vayu::core::RunManager manager;
        EXPECT_TRUE (manager.start_scenario_run (run_id, config,
        std::make_shared<const vayu::core::ScenarioExecution> (std::move (execution)),
        *db_, jar));
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return manager.get_run (run_id) == nullptr; }))
        << "the run never finished";
        manager.shutdown ();
        return vayu::http::routes::run_report_response (*db_, run_id).second;
    }

    /// One run of each kind over the same plan, for #2974's comparison.
    struct BothRuns {
        json load;       ///< The load run's report `scenario` section.
        json sequential; ///< The collection run's.
        /// What each run sent to each path, in the order asked for.
        std::vector<size_t> load_hits;
        std::vector<size_t> sequential_hits;
        /// The collection run's stored step rows that carry an error.
        std::vector<std::string> sequential_errors;
    };

    /// @p execution as a one-VU load run of @p iterations, then as a collection
    /// run of as many, counting what each sent to @p paths on @p server.
    BothRuns run_both (const ScenarioMockServer& server,
    const vayu::core::ScenarioExecution& execution,
    const std::vector<std::string>& paths,
    size_t iterations) {
        const auto hits_now = [&] () {
            std::vector<size_t> counts;
            counts.reserve (paths.size ());
            for (const auto& path : paths) {
                counts.push_back (server.hits_for (path).size ());
            }
            return counts;
        };
        BothRuns runs;
        runs.load = run_to_report (
        json{ { "mode", "iterations" }, { "iterations", iterations }, { "concurrency", 1 } }, execution)
                    .at ("scenario");
        runs.load_hits = hits_now ();
        runs.sequential = run_sequentially_to_report (execution, iterations).at ("scenario");
        runs.sequential_hits = hits_now ();
        for (size_t i = 0; i < paths.size (); ++i) {
            runs.sequential_hits[i] -= runs.load_hits[i];
        }
        for (const auto& row : db_->get_results ("run_sequential_report")) {
            if (!row.error.empty ()) {
                runs.sequential_errors.push_back (row.error);
            }
        }
        return runs;
    }

    /// Override a seeded config value, keeping the rest of its row intact.
    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not a seeded config key";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
};

} // namespace

// ============================================================================
// Mode validation - the one rule with teeth
// ============================================================================

TEST (ScenarioLoadConfig, ConstantRpsIsRefusedForAScenario) {
    const json config = { { "scenario", { { "collectionId", "c" } } },
        { "mode", "constant_rps" }, { "duration", "10s" } };

    ASSERT_TRUE (vayu::core::is_scenario_load_run (config));
    const auto refusal = vayu::core::validate_scenario_load_config (config);
    ASSERT_HAS_VALUE (refusal)
    << "constant_rps with a scenario must be refused, not silently run "
       "closed-loop";
    EXPECT_NE (refusal->find ("constant_rps"), std::string::npos)
    << "the refusal must name the mode it refused: " << *refusal;
}

TEST (ScenarioLoadConfig, CapacityIsRefusedForAScenario) {
    const json config = { { "scenario", { { "collectionId", "c" } } },
        { "mode", "capacity" }, { "duration", "10s" } };

    ASSERT_TRUE (vayu::core::is_scenario_load_run (config));
    const auto refusal = vayu::core::validate_scenario_load_config (config);
    ASSERT_HAS_VALUE (refusal)
    << "capacity with a scenario must be refused: the search judges one "
       "p99 per level and a sequence has one per step";
    EXPECT_NE (refusal->find ("capacity"), std::string::npos)
    << "the refusal must name the mode it refused: " << *refusal;
}

TEST (ScenarioLoadConfig, AnArrivalRateIsRefusedOnEveryScenarioMode) {
    // `rps` is what puts ConstantLoadStrategy on its open-loop path regardless
    // of the declared mode, so refusing only `mode: constant_rps` would leave
    // the open-loop door open.
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations" }) {
        const json config = { { "scenario", { { "collectionId", "c" } } },
            { "mode", mode }, { "targetRps", 500.0 } };
        EXPECT_TRUE (vayu::core::validate_scenario_load_config (config).has_value ())
        << "targetRps was accepted on scenario mode " << mode;
    }
}

TEST (ScenarioLoadConfig, TheClosedLoopModesAreAccepted) {
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations" }) {
        const json config = { { "scenario", { { "collectionId", "c" } } },
            { "mode", mode }, { "duration", "5s" } };
        EXPECT_FALSE (vayu::core::validate_scenario_load_config (config).has_value ())
        << "scenario mode " << mode << " was refused";
    }
}

TEST (ScenarioLoadConfig, AScenarioWithoutAModeIsStillADesignModeRun) {
    // The absence of `mode` cannot start meaning something new: every caller
    // sent exactly this shape before load-mode scenarios existed.
    const json config = { { "scenario", { { "collectionId", "c" } } } };
    EXPECT_FALSE (vayu::core::is_scenario_load_run (config));

    const json load_config = { { "mode", "constant_concurrency" } };
    EXPECT_FALSE (vayu::core::is_scenario_load_run (load_config))
    << "a single-request load run has no scenario to execute";
}

// ============================================================================
// The virtual-user state machine
// ============================================================================

// A VU walks every step of its iteration in order, then starts the next
// iteration at step 0. One VU makes the recorded order the VU's own order.
TEST_F (ScenarioLoadTest, AVirtualUserWalksItsPlanInOrderThenRestartsAtStepZero) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    std::vector<std::string> order;
    for (const auto& hit : server.hits ()) {
        order.push_back (hit.path);
    }
    EXPECT_EQ (order,
    (std::vector<std::string>{ "/s0", "/s1", "/s2", "/s0", "/s1", "/s2", "/s0", "/s1", "/s2" }));
    EXPECT_EQ (state->iterations_completed.load (), 3u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);
    EXPECT_EQ (state->steps_executed.load (), 9u);
}

// `iterations` is a total across the pool, and a VU is never abandoned partway
// through a sequence to reach it: every started iteration ran to its last step.
TEST_F (ScenarioLoadTest, AnIterationsRunStopsStartingIterationsWithoutStrandingOne) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 4 },
        { "concurrency", 3 } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->iterations_started.load (), 4u);
    EXPECT_EQ (state->iterations_completed.load (), 4u);
    EXPECT_EQ (state->steps_executed.load (), 12u)
    << "4 iterations x 3 steps; a VU stopped mid-sequence would send fewer";
    EXPECT_EQ (server.hits_for ("/s2").size (), 4u)
    << "every started iteration must reach its last step";
}

// Per-VU cookies, and the iteration boundary that clears them. One VU, so the
// order is deterministic: login, echo, login, echo.
TEST_F (ScenarioLoadTest, CookiesRideAnIterationAndAreClearedAtTheNextOne) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    // One handle in the pool, so every step after the first reuses the handle
    // the previous one left behind - which is where a cookie engine that is
    // enabled but never flushed leaks one VU's session into the next request.
    run (config, execution, /*pool_size=*/1);

    const auto logins = server.hits_for ("/login");
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (logins.size (), 2u);
    ASSERT_EQ (echoes.size (), 2u);

    // The session the step before it established reaches the next step - which
    // is the whole point of a multi-step load run.
    EXPECT_EQ (echoes[0].cookie, "sid=1");
    EXPECT_EQ (echoes[1].cookie, "sid=2");

    // Empty at the start of each iteration: a new iteration is a new user, not
    // the same one logging in twice.
    EXPECT_EQ (logins[0].cookie, "");
    EXPECT_EQ (logins[1].cookie, "")
    << "the second iteration's first step carried the first iteration's "
       "session - per-VU cookies are not being cleared at the iteration "
       "boundary";
}

// Issue #1765, the read half: a step with `disableCookies` sends none of the
// VU's session, and the session survives it for the step after. Mutation
// checks: `request.track_cookies = true` in `submit_one` reds the first
// expectation; handing `finish_step` the jar-off step's own (empty)
// `response.cookie_lines` instead of `&vu->cookies` clears the session and
// reds the second.
TEST_F (ScenarioLoadTest, AStepWithTheJarOffSendsNoCookieAndKeepsTheSession) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/echo"), server.url ("/s0") });
    execution.plan.steps[1].request.disable_cookies = true;

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    const auto echoes = server.hits_for ("/echo");
    const auto after  = server.hits_for ("/s0");
    ASSERT_EQ (echoes.size (), 1u);
    ASSERT_EQ (after.size (), 1u);
    EXPECT_EQ (echoes[0].cookie, "")
    << "a jar-off step carried the VU's session";
    EXPECT_EQ (after[0].cookie, "sid=1")
    << "a jar-off step dropped the VU's session";
}

// The write half: a `Set-Cookie` answering a jar-off step does not replace
// the VU's session. Mutation check: set `request.track_cookies = true` for
// every step in `submit_one` and hand `finish_step` the captured
// `&response.cookie_lines` for a jar-off step too - the pair a driver that
// ignored the flag would be - and the echo carries `sid=2`.
TEST_F (ScenarioLoadTest, AStepWithTheJarOffStoresNoSetCookie) {
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/login"), server.url ("/login"), server.url ("/echo") });
    execution.plan.steps[1].request.disable_cookies = true;

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].cookie, "sid=1")
    << "the jar-off step's Set-Cookie (sid=2) replaced the VU's session";
}

// Two VUs, both held inside `/login` at the same time, must still leave with
// their own session. A shared jar - or a cookie engine left on a pooled handle
// - hands one of them the other's.
TEST_F (ScenarioLoadTest, TwoVirtualUsersDoNotShareCookieState) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    const auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    // Two handles for two VUs: the pool wraps, so the second iteration's
    // transfers run on handles the first iteration's finished with.
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].cookie, "")
    << "no session reached the second step at all";
    EXPECT_NE (echoes[0].cookie, echoes[1].cookie)
    << "both virtual users sent the same session - cookie state is shared "
       "between VUs rather than private to each";
}

// An inline script reads the cookie the step before it established for its
// own virtual user, not the other VU's (issue #1501). `pm.cookies` used to
// throw unconditionally under load; step 1's inline `script.pre` here reads
// what step 0's `/login` set for that same VU and stamps it onto the
// request, so the assertion is on the wire, the same way the correlation
// tests above prove per-VU state rather than trusting an in-process read.
//
// Mutation check: drop `script_ctx.cookie_read_lines = &vu.cookies;` in
// `run_step_before`, and the inline script throws instead of reading a
// value, so `echo.authorization` never gets set and this reds.
TEST_F (ScenarioLoadTest, AnInlineScriptReadsThisVirtualUsersOwnCookieFromTheStepBeforeIt) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.request.headers.upsert('Authorization', 'Bearer ' + pm.cookies.get('sid'));",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization)
    << "both virtual users read the same cookie value - the per-VU view is "
       "shared rather than private to each";
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        const std::string session_id = echo.cookie.substr (4);
        EXPECT_EQ (echo.authorization, "Bearer " + session_id)
        << "pm.cookies.get did not read this VU's own cookie from the step "
           "before it";
    }
}

// An errored step ends its iteration and the VU starts the next one. A VU that
// stranded instead would send step 0 once and then nothing, permanently
// shrinking effective concurrency.
TEST_F (ScenarioLoadTest, AnErroredStepEndsItsIterationWithoutStrandingTheVirtualUser) {
    ScenarioMockServer server;
    // Port 1 on loopback refuses immediately - a transport error, not a 5xx, so
    // the failure is the one that ends an iteration.
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 3u)
    << "the virtual user was stranded by the errored step - it never started "
       "another iteration";
    EXPECT_EQ (server.hits_for ("/s2").size (), 0u)
    << "the iteration continued past a step that errored";
    EXPECT_EQ (state->iterations_abandoned.load (), 3u);
    EXPECT_EQ (state->iterations_completed.load (), 0u);
    EXPECT_EQ (state->steps_errored.load (), 3u);
}

// #2914: every iteration abandons at step 0, so step 1 is never sent. The
// start-of-run expected count (iterations x steps = 20) is only an upper bound;
// a natural end settles it to what was sent, so progress reaches 100%.
// Mutation check: drop the settling assignment at the end of
// `execute_scenario_load` and `requestsExpected` stays 20.
TEST_F (ScenarioLoadTest, AnAbandonedIterationSettlesTheExpectedCountToWhatWasSent) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ "http://127.0.0.1:1/unreachable", server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 10 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->iterations_abandoned.load (), 10u);
    EXPECT_EQ (context_->requests_sent.load (), 10u);
    EXPECT_EQ (context_->requests_expected.load (), context_->requests_sent.load ())
    << "a natural end left the upper bound in place, so progress stops short "
       "of 100%";
}

// #2914: a stopped run keeps the start-of-run upper bound, which is what it
// fell short of. Mutation check: drop the `should_stop` guard on the settling
// assignment and `requestsExpected` drops to the sent count.
TEST_F (ScenarioLoadTest, AStoppedIterationsRunKeepsTheExpectedUpperBound) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.hang_url (), upstream.hang_url () });
    for (auto& step : execution.plan.steps) {
        step.request.timeout_ms = 120000;
    }

    const json config = { { "mode", "iterations" }, { "iterations", 1000 },
        { "concurrency", 2 } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-stop-expected", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    std::thread stopper ([&context] () {
        EXPECT_TRUE (vayu::tests::wait_until (
        [&context] () { return context->event_loop->active_count () >= 2; }))
        << "both virtual users never had a transfer in flight";
        context->should_stop = true;
        context->notify_refill ();
    });
    auto base_scopes = vayu::http::routes::load_script_variable_scopes (
    *db_, std::nullopt, context->scenario->request.collection_id);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    stopper.join ();
    context->event_loop->stop (false);

    ASSERT_GT (context->requests_sent.load (), 0u)
    << "nothing was sent; nothing is proven";
    EXPECT_EQ (context->requests_expected.load (), 2000u)
    << "a stopped run's expected count was settled to what it sent";
}

// #2136: a step a user Stop cancelled neither ran nor failed. It is counted as
// cancelled and moves no step tally - no step error, no abandoned iteration,
// no coverage send - while its virtual user is still released.
TEST_F (ScenarioLoadTest, AStepTheStopCancelledMovesNoStepTally) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.hang_url () });
    execution.plan.steps[0].request.timeout_ms = 120000;
    execution.plan.steps[0].spec_operation =
    R"({"operationId":"hang","method":"GET","path":"/hang"})";
    vayu::core::DeclaredOperation hang;
    hang.operation_id                  = "hang";
    hang.method                        = "GET";
    hang.path                          = "/hang";
    hang.responses                     = { "200" };
    execution.spec.spec_id             = "spec_1";
    execution.spec.declared_operations = { hang };

    const json config = { { "mode", "iterations" }, { "iterations", 1000 },
        { "concurrency", 2 } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-stop", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    // Stops once both virtual users have a transfer in flight, the way the
    // stop route does: flag, wake, then the run lets go of the loop.
    std::thread stopper ([&context] () {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (5);
        while (context->event_loop->active_count () < 2 &&
        std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        context->should_stop = true;
        context->notify_refill ();
    });
    auto base_scopes = vayu::http::routes::load_script_variable_scopes (
    *db_, std::nullopt, context->scenario->request.collection_id);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    stopper.join ();
    context->event_loop->stop (false);

    ASSERT_GT (context->requests_sent.load (), 0u)
    << "nothing was sent; nothing is proven";
    EXPECT_EQ (context->metrics_collector->cancelled (), context->requests_sent.load ());
    EXPECT_EQ (context->metrics_collector->total_errors (), 0u);
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (state->steps_errored.load (), 0u);
    EXPECT_EQ (state->steps.errors (0), 0u);
    EXPECT_EQ (state->steps_executed.load (), 0u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);

    const auto coverage = vayu::core::build_scenario_load_coverage (*state);
    ASSERT_FALSE (coverage.empty ()) << "a bound run must report coverage";
    ASSERT_EQ (coverage["operations"].size (), 1u);
    EXPECT_EQ (coverage["operations"][0]["sent"], 0)
    << "a cancelled send was counted against its operation";
}

// A step that answered 500 is an error in its own row of the breakdown, but a
// response arrived, so the iteration goes on to the next step (#2134). With no
// assertion to fail it is a `passed` step, never `failed` or `errored` (#2824):
// the status is the step's `httpErrors`, not its outcome. Mutation checks: drop
// the `record_failed_status` call in the completion callback and the error
// counts read 0; make an HTTP error status set `errored` there and `/s2` is
// never reached.
TEST_F (ScenarioLoadTest, AStepAnsweringAnHttpErrorCountsAsAnErrorWithoutEndingItsIteration) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/fail500"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (server.hits_for ("/fail500").size (), 3u);
    EXPECT_EQ (server.hits_for ("/s2").size (), 3u)
    << "an HTTP error response ended the iteration as if nothing had answered";

    EXPECT_EQ (state->steps.completed (1), 3u);
    EXPECT_EQ (state->steps.errors (1), 3u)
    << "a step that answered 500 on every send reported no errors";
    EXPECT_EQ (state->steps.http_errors (1), 3u);
    EXPECT_EQ (state->steps.no_response (1), 0u);
    EXPECT_EQ (state->steps.errors (0), 0u);
    EXPECT_EQ (state->steps.errors (2), 0u);
    EXPECT_EQ (state->steps_errored.load (), 0u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);
    EXPECT_EQ (state->iterations_completed.load (), 3u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps_executed"], 9);
    EXPECT_EQ (summary["errored"], 0);
    EXPECT_EQ (summary["iterations_abandoned"], 0);
    EXPECT_EQ (summary["failed"], 0)
    << "a 500 no assertion judged failed its step";
    EXPECT_EQ (summary["passed"], 9);
    const auto& failing = summary["steps"][1];
    EXPECT_EQ (failing["errors"], 3);
    EXPECT_EQ (failing["httpErrors"], 3);
    EXPECT_EQ (failing["noResponse"], 0);
}

// The other half of the error definition: a step nothing answered is a
// `noResponse` error, and that one does end its iteration.
TEST_F (ScenarioLoadTest, AStepWithNoResponseCountsAsNoResponseAndEndsItsIteration) {
    ScenarioMockServer server;
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s2").size (), 0u);
    EXPECT_EQ (state->steps.errors (1), 2u);
    EXPECT_EQ (state->steps.no_response (1), 2u);
    EXPECT_EQ (state->steps.http_errors (1), 0u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 2);
    EXPECT_EQ (summary["iterations_abandoned"], 2);
    EXPECT_EQ (summary["failed"], 0);
    EXPECT_EQ (summary["passed"], 2);
    const auto& unanswered = summary["steps"][1];
    EXPECT_EQ (unanswered["errors"], 2);
    EXPECT_EQ (unanswered["noResponse"], 2);
    EXPECT_EQ (unanswered["httpErrors"], 0);
}

// One definition of the step outcomes for both runners (#2824). Rows alternate
// gold and silver: a silver iteration skips step 0 and sends step 1 to a 500
// that both of its `assert.status` elements reject, and step 2 answers 500 with
// nothing asserting on it every time. The four outcomes are disjoint and sum to
// `steps_executed`, which counts every step reached, a skipped one included;
// a step's `executed` counts only the steps that ran. Two failed assertions in
// one execution are one `failed` step. Mutation check: restore `failed` as the
// sum of every step's `httpErrors` in `build_scenario_load_summary` and it
// reads 6.
TEST_F (ScenarioLoadTest, LoadStepOutcomesAreDisjointAndSumToStepsExecuted) {
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/{{data.path}}"), server.url ("/fail500") });
    with_data (execution,
    { json{ { "tier", "gold" }, { "path", "s1" } },
    json{ { "tier", "silver" }, { "path", "fail500" } } });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
    { "config", { { "condition", "{{data.tier}} == gold" } } } } });
    const auto status_ok = [] (const std::string& id) {
        return json{ { "id", id }, { "kind", "assert.status" }, { "enabled", true },
            { "config", { { "in", json::array ({ 200 }) } } } };
    };
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { status_ok ("el_status"), status_ok ("el_status_again") });

    constexpr size_t ITERATIONS = 4;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto count = [&summary] (const char* key) {
        return summary.at (key).get<size_t> ();
    };

    EXPECT_EQ (count ("steps_executed"), 3 * ITERATIONS) << summary.dump ();
    EXPECT_EQ (count ("skipped"), ITERATIONS / 2) << summary.dump ();
    EXPECT_EQ (count ("failed"), ITERATIONS / 2)
    << "one failed execution per silver iteration, however many assertions "
       "failed in it, and never the unasserted 500s: "
    << summary.dump ();
    EXPECT_EQ (count ("errored"), 0u) << summary.dump ();
    EXPECT_EQ (count ("passed"), 8u) << summary.dump ();
    EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") + count ("skipped"),
    count ("steps_executed"));

    size_t ran = 0;
    for (const auto& step : summary.at ("steps")) {
        ran += step.at ("executed").get<size_t> ();
    }
    EXPECT_EQ (ran + count ("skipped"), count ("steps_executed")) << summary.dump ();
    EXPECT_EQ (summary["steps"][2]["httpErrors"], ITERATIONS)
    << "an unasserted 500 is still the step's HTTP error";
    EXPECT_EQ (state->inline_tests_failed.load (), ITERATIONS)
    << "both assertions fail in each silver iteration";
}

// An execution with no response is `errored` and nothing else (#2824), whatever
// its assertions said, as the sequential runner's `classify_step` decides it.
// Mutation check: test `assertion_failed` before `no_response` in
// `classify_execution` and `failed` reads 2.
TEST_F (ScenarioLoadTest, AnExecutionWithNoResponseIsErroredAndNotAlsoFailed) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });", /*inline_script=*/true) });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    ASSERT_EQ (state->inline_tests_failed.load (), 2u)
    << "the pre-request assertion never ran, so this proves nothing";
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["passed"], 0) << summary.dump ();
    EXPECT_EQ (summary["steps_executed"], 2) << summary.dump ();
}

namespace {

/// Both identities a load summary's outcomes answer to (#2824): the four
/// outcomes sum to `steps_executed`, and so do the steps' `executed` plus
/// `skipped`.
void expect_load_outcome_identities (const json& summary) {
    const auto count = [&summary] (const char* key) {
        return summary.at (key).get<size_t> ();
    };
    EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") + count ("skipped"),
    count ("steps_executed"))
    << summary.dump ();
    size_t ran = 0;
    for (const auto& step : summary.at ("steps")) {
        ran += step.at ("executed").get<size_t> ();
    }
    EXPECT_EQ (ran + count ("skipped"), count ("steps_executed")) << summary.dump ();
}

json one_inline_script (const char* kind, const std::string& script) {
    return vayu::tests::script_element_json ("el_script", kind, script, /*inline_script=*/true);
}

} // namespace

// #2947: an inline script that threw on a step that answered 200 is `errored`,
// as the sequential runner's `classify_step` decides it, and the iteration
// still goes on to step 1, so the target receives the load it did before.
// Mutation checks: drop `script_threw` from `classify_execution` and `errored`
// reads 0, `passed` 6; abandon the iteration for a thrown script in
// `finish_step` and `/s1` is never reached, `iterations_abandoned` reads 3.
TEST_F (ScenarioLoadTest, AnInlineScriptPostThatThrewIsErroredWithoutAbandoningItsIteration) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.post", "throw new Error('x');") });

    constexpr size_t ITERATIONS = 3;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s1").size (), ITERATIONS)
    << "a thrown script ended its iteration";
    EXPECT_EQ (summary["errored"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["passed"], ITERATIONS)
    << "only step 1 passed: " << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_completed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0)
    << "a thrown script is not a step that got no response";
    expect_load_outcome_identities (summary);
}

// The same for `script.pre`: the request it ran before still goes out, as it
// did before #2947, and the step is `errored` rather than `passed`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreThatThrewIsErroredAndItsRequestStillSent) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');") });

    constexpr size_t ITERATIONS = 3;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s0").size (), ITERATIONS);
    EXPECT_EQ (server.hits_for ("/s1").size (), ITERATIONS);
    EXPECT_EQ (summary["errored"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// An inline script's `pm.execution` call throws on a load run (no sequence to
// redirect from inside a script), so `skipRequest()` there errors its step and
// skips nothing: the request still goes out.
TEST_F (ScenarioLoadTest, AnInlineSkipRequestThrowsSoItsStepIsErroredAndStillSent) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "pm.execution.skipRequest();") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s0").size (), 2u);
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["skipped"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// A script that failed an assertion and then threw is one `errored` execution,
// not also a `failed` one: the throw outranks the assertion, as in
// `classify_step`. The assertion still reaches the exact population. Mutation
// check: test `assertion_failed` before `script_threw` in
// `classify_execution` and `failed` reads 2, `errored` 0.
TEST_F (ScenarioLoadTest, AThrowOutranksAFailedAssertionInTheSameExecution) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });\n"
    "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    ASSERT_EQ (state->inline_tests_failed.load (), 2u)
    << "the assertion never ran, so this proves nothing";
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["passed"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// A step a controller skipped whose `script.pre` then threw is `errored`, not
// `skipped` (`classify_step` checks the throw first). It still sends nothing
// and ends no iteration, and it counts in its step's `executed`, which is what
// keeps `sum(executed) + skipped == steps_executed`. Mutation checks: test
// `!sent` before `script_threw` in `classify_execution` and `skipped` reads 2;
// drop `record_unsent` from `count_outcome` and the second identity is 2 short.
TEST_F (ScenarioLoadTest, ASkippedStepWhosePreScriptThrewIsErroredNotSkipped) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{never_set}} exists" } } } },
    one_inline_script ("script.pre", "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_TRUE (server.hits_for ("/s0").empty ())
    << "the skipped step was sent";
    EXPECT_EQ (server.hits_for ("/s1").size (), 2u);
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["skipped"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["executed"], 2) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// A step that got no response is `errored` once, by `count_outcome`, even
// when its script threw too. Mutation check: count `steps_errored` for a
// no-response execution in `finish_step` as well and `errored` reads 4.
TEST_F (ScenarioLoadTest, ANoResponseStepWhoseScriptThrewIsErroredOnce) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 2) << summary.dump ();
    EXPECT_EQ (summary["steps_executed"], 2) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// #2947's acceptance: the same stored collection, one request whose test
// script throws on a 200, reports the same outcomes run as a load run and as
// a collection run. Mutation check: as the first #2947 case above; the load
// report's `errored` reads 0 against the collection run's 3.
TEST_F (ScenarioLoadTest, ALoadRunAndACollectionRunCountAThrownScriptTheSame) {
    ScenarioMockServer server;
    const auto execution =
    resolve_one_step (server.url ("/s0"), json{ { "mode", "none" } },
    json::array ({ one_inline_script ("script.post", "throw new Error('x');") }));

    constexpr size_t ITERATIONS = 3;
    const auto load             = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } }, execution)
                      .at ("scenario");
    const auto sequential =
    run_sequentially_to_report (execution, ITERATIONS).at ("scenario");

    for (const char* key : { "stepsExecuted", "passed", "failed", "skipped", "errored" }) {
        EXPECT_EQ (load.at (key), sequential.at (key))
        << key << "\nload: " << load.dump () << "\ncollection: " << sequential.dump ();
    }
    EXPECT_EQ (load.at ("errored"), ITERATIONS) << load.dump ();
    EXPECT_EQ (load.at ("iterationsAbandoned"), 0) << load.dump ();
}

// #3127: a load run says why an inline script failed and what it logged, on
// the step's element row: the throw, the failing test by name and the console
// line, each once however many iterations said it. Mutation check: drop the
// `outcome_messages` assignment from `run_step_script` (script_kinds.cpp) and
// the row carries neither `messages` nor `console`.
TEST_F (ScenarioLoadTest, AnInlineScriptsThrowTestFailureAndConsoleReachTheStepsRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    "console.log('saw ' + pm.response.code);\n"
    "pm.test('status is 201', function () {"
    " pm.expect(pm.response.code).to.equal(201); });\n"
    "throw new Error('boom');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 2 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    const auto& row = summary.at ("steps").at (0).at ("elements").at (0);
    EXPECT_EQ (row.at ("error").get<int> (), 4) << row.dump ();
    EXPECT_EQ (row.value ("console", json ()),
    (json::array ({ { { "level", "log" }, { "text", "saw 200" } } })))
    << row.dump ();
    const auto messages = row.value ("messages", json::array ());
    ASSERT_EQ (messages.size (), 2u) << row.dump ();
    EXPECT_EQ (messages[0].at ("kind").get<std::string> (), "error");
    EXPECT_NE (messages[0].at ("text").get<std::string> ().find ("boom"), std::string::npos)
    << row.dump ();
    EXPECT_EQ (messages[1].at ("kind").get<std::string> (), "test");
    EXPECT_TRUE (
    messages[1].at ("text").get<std::string> ().starts_with ("status is 201: "))
    << row.dump ();
    EXPECT_FALSE (row.contains ("messagesDropped")) << row.dump ();
}

// ============================================================================
// Flow control is read the same on both run kinds (#2974)
// ============================================================================

namespace {

/// A step's `control.switch` that routes every execution to @p target:
/// `{{which}}` resolves to nothing here, so it stays its own literal and the
/// case keyed on that literal always matches.
json switch_to (const std::string& target) {
    return json{ { "id", "el_switch" }, { "kind", "control.switch" }, { "enabled", true },
        { "config", { { "variable", "which" }, { "cases", { { "{{which}}", target } } } } } };
}

/// The same outcome counts on both run kinds, the four outcomes summing to
/// `stepsExecuted` on each, and the load run's steps' `executed` plus
/// `skipped` summing to it too.
void expect_same_outcomes (const json& load, const json& sequential) {
    for (const char* key : { "stepsExecuted", "passed", "failed", "skipped", "errored" }) {
        EXPECT_EQ (load.at (key), sequential.at (key))
        << key << "\nload: " << load.dump () << "\ncollection: " << sequential.dump ();
    }
    for (const json* scenario : { &load, &sequential }) {
        const auto count = [scenario] (const char* key) {
            return scenario->at (key).get<size_t> ();
        };
        EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") + count ("skipped"),
        count ("stepsExecuted"))
        << scenario->dump ();
    }
    size_t ran = 0;
    for (const auto& step : load.at ("steps")) {
        ran += step.at ("executed").get<size_t> ();
    }
    EXPECT_EQ (ran + load.at ("skipped").get<size_t> (),
    load.at ("stepsExecuted").get<size_t> ())
    << load.dump ();
}

} // namespace

// A step whose inline script threw has its own jump dropped on a load run, as
// on a collection run: the iteration walks on to step 1, and step 2 is reached
// only by walking. Mutation check: read `next_target_from_before` in
// `read_flow_control` whatever the outcome, and `/s1` gets 0 load hits
// against the collection run's 3.
TEST_F (ScenarioLoadTest, AThrownStepsSwitchIsDroppedOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');"), switch_to ("step2") });

    constexpr size_t ITERATIONS = 3;
    const auto runs = run_both (server, execution, { "/s0", "/s1", "/s2" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS, ITERATIONS }))
    << "the thrown step's switch was honoured: " << runs.load.dump ();
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// The same for an inline `setNextRequest` followed by a throw: a collection run
// records the jump and drops it with the throw, and on a load run the call
// itself throws. Either way the step is `errored` and the iteration walks on.
TEST_F (ScenarioLoadTest, AThrownStepsSetNextRequestIsDroppedOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({ one_inline_script (
    "script.pre", "pm.execution.setNextRequest('step2');\nthrow new Error('x');") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1", "/s2" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS, ITERATIONS }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A thrown step whose switch names no step is `errored` once and abandons
// nothing: its jump is dropped before anything tries to resolve it, so it can
// never also be a jump the run could not honour.
TEST_F (ScenarioLoadTest, AThrownStepsUnresolvableSwitchIsDroppedNotRefused) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.post", "throw new Error('x');"), switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A jump past `maxStepsPerIteration` is the error of the step that set it, on
// both run kinds, under the same text naming the steps that cycled. The
// iteration still ends there, so step 1 is never reached, and on the load run
// it is still abandoned. Each iteration runs step 0 five times: four jumps
// honoured, the fifth refused. Mutation check: drop the `outcome =
// StepOutcome::Errored` for an abandoned step in `finish_step` and the load
// run's `errored` reads 0 against the collection run's 2.
TEST_F (ScenarioLoadTest, AJumpPastTheStepCapErrorsItsStepOnBothRunKinds) {
    set_config ("maxStepsPerIteration", "5");
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ switch_to ("step0") });

    constexpr size_t ITERATIONS = 2;
    const vayu::tests::LogCapture log;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ 5 * ITERATIONS, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("passed"), 4 * ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("errors"), 0)
    << "a refused jump is not a request error: " << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);

    ASSERT_EQ (runs.sequential_errors.size (), ITERATIONS);
    EXPECT_NE (runs.sequential_errors[0].find (
               "step0 -> step0 -> step0 -> step0 -> step0"),
    std::string::npos)
    << runs.sequential_errors[0];
    const auto lines = log.with_msg_prefix ("Scenario load run: iteration ");
    ASSERT_EQ (lines.size (), ITERATIONS);
    EXPECT_EQ (lines[0].at ("stepError"), runs.sequential_errors[0]) << lines[0].dump ();
}

// A target no step answers to is the same: `errored` on the step that set it,
// the iteration abandoned, and the collection run's text in the log.
TEST_F (ScenarioLoadTest, AnUnresolvableJumpErrorsItsStepOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const vayu::tests::LogCapture log;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), ITERATIONS) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);

    ASSERT_EQ (runs.sequential_errors.size (), ITERATIONS);
    const auto lines = log.with_msg_prefix ("Scenario load run: iteration ");
    ASSERT_EQ (lines.size (), ITERATIONS);
    EXPECT_EQ (lines[0].at ("stepError"), runs.sequential_errors[0]) << lines[0].dump ();
}

// A refused jump on a step that also failed an assertion is one `errored`
// execution, not also a `failed` one: the refusal is decided before the outcome
// is counted. Mutation check: count the outcome in `finish_step` before
// `decide_next_position` runs and `failed` reads 2 on the load run.
TEST_F (ScenarioLoadTest, ARefusedJumpOutranksAFailedAssertionOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_status" }, { "kind", "assert.status" },
      { "enabled", true }, { "config", { { "in", json::array ({ 201 }) } } } },
    switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("failed"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A skipped step whose `control.loop` repeat is refused is `errored`, not
// `skipped`, and joins its step's `executed` though it sent nothing, which is
// what keeps the steps' `executed` plus `skipped` equal to `stepsExecuted`.
// Each iteration: skipped twice, then the third pass is refused. Mutation
// check: drop `record_unsent` for an `errored` execution that was not sent in
// `count_outcome` and the second identity is 2 short.
TEST_F (ScenarioLoadTest, ASkippedStepsRefusedRepeatIsErroredOnBothRunKinds) {
    set_config ("maxStepsPerIteration", "3");
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{never_set}} exists" } } } },
    { { "id", "el_loop" }, { "kind", "control.loop" }, { "enabled", true },
    { "config", { { "count", 10 } } } } });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ 0, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("skipped"), 2 * ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("executed"), ITERATIONS)
    << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("noResponse"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// ============================================================================
// Per-step metrics
// ============================================================================

// One histogram per step, and the whole-run aggregate is their union: every
// completion is counted exactly once, in exactly one step.
TEST_F (ScenarioLoadTest, PerStepHistogramsPartitionTheRunsCompletions) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 2 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.step_count (), 3u)
    << "histograms are allocated once from the plan's step count";

    size_t union_of_steps = 0;
    for (size_t i = 0; i < state->steps.step_count (); ++i) {
        EXPECT_EQ (state->steps.completed (i), 5u) << "step " << i;
        EXPECT_EQ (state->steps.errors (i), 0u) << "step " << i;
        EXPECT_GT (state->steps.percentiles (i).p50, 0.0)
        << "step " << i << " recorded no latency";
        union_of_steps += state->steps.completed (i);
    }
    EXPECT_EQ (union_of_steps, context_->total_requests ())
    << "the per-step histograms and the run aggregate disagree about how many "
       "completions there were";
}

// A step no VU ever reached reports zeros, not the INT64_MAX an empty
// HdrHistogram answers `min` with.
TEST_F (ScenarioLoadTest, AnUnreachedStepReportsZeroesRatherThanAnEmptyHistogramsMin) {
    ScenarioMockServer server;
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.completed (2), 0u);
    const auto unreached = state->steps.percentiles (2);
    EXPECT_EQ (unreached.min, 0.0);
    EXPECT_EQ (unreached.max, 0.0);
}

// #2384: a step whose transfer ran and failed (here a timeout) joins its own
// histogram at its duration, so the step's p99 and the run's describe the same
// attempts, and `finish_step` still counts it once. Mutation check: drop the
// `record_failed_transfer` call in `record_step_response` and the step holds
// no samples and reports a 0 ms max beside a run p99 at the timeout.
TEST_F (ScenarioLoadTest, AStepThatTimedOutJoinsItsHistogramAtItsDuration) {
    vayu::tests::SlowMockServer upstream;
    constexpr int64_t TIMEOUT_MS = 300;
    auto execution = plan_over ({ upstream.fast_url (), upstream.hang_url () });
    execution.plan.steps[1].request.timeout_ms = TIMEOUT_MS;

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (1), 3u)
    << "the hanging step did not time out";
    EXPECT_EQ (state->steps.completed (1), 3u)
    << "a failed transfer was counted as executed more than once";
    EXPECT_EQ (state->steps_executed.load (), 6u);
    EXPECT_EQ (state->steps.latency_samples (1), 3u);
    const auto timed_out = state->steps.percentiles (1);
    EXPECT_GE (timed_out.min, 0.9 * static_cast<double> (TIMEOUT_MS))
    << "a timed-out step's duration is about its timeout";

    auto& collector = *context_->metrics_collector;
    EXPECT_EQ (collector.latency_samples (),
    state->steps.latency_samples (0) + state->steps.latency_samples (1))
    << "the run's histogram and the steps' hold different attempts";
    const auto whole_run = collector.calculate_percentiles ();
    EXPECT_NEAR (whole_run.p99, timed_out.p99, 0.001 * timed_out.p99);
    EXPECT_NEAR (whole_run.max, timed_out.max, 0.001 * timed_out.max);
}

// The other side of #2384's line: a step refused before the wire (a scheme
// nothing sends) is a noResponse error with no duration to record. Mutation
// check: record a failed transfer whether or not it ran and the step reports
// samples it never took.
TEST_F (ScenarioLoadTest, AStepRefusedBeforeTheWireRecordsNoLatency) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), "ftp://127.0.0.1/never-sent" });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (1), 2u)
    << "the ftp step was not refused";
    EXPECT_EQ (state->steps.completed (1), 2u);
    EXPECT_EQ (state->steps.latency_samples (1), 0u)
    << "a step that never reached the wire recorded a duration";
    EXPECT_EQ (state->steps.percentiles (1).max, 0.0);
    EXPECT_EQ (state->steps.latency_samples (0), 2u);
    EXPECT_EQ (context_->metrics_collector->latency_samples (), 2u);
}

// #2384, step 6: `control.transaction` always summed an errored member, and the
// run's histogram now holds that member's failed transfer too, so a mixed
// transaction (one answered member, one that timed out) and the run describe
// one set of attempts: the transaction is the sum of its members' durations.
TEST_F (ScenarioLoadTest, AMixedTransactionAgreesWithTheRunsHistogram) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.fast_url (), upstream.hang_url () });
    execution.plan.steps[1].request.timeout_ms = 300;
    // One element id on both steps is one folder's inherited occurrence.
    for (auto& step : execution.plan.steps) {
        step.elements = vayu::tests::compiled_elements (
        { json{ { "id", "el_txn" }, { "kind", "control.transaction" },
        { "enabled", true }, { "config", { { "name", "checkout" } } } } });
    }

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);
    ASSERT_EQ (state->steps.no_response (1), 1u)
    << "the hanging member did not time out";

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary.contains ("transactions")) << summary.dump ();
    ASSERT_EQ (summary["transactions"].size (), 1u) << summary.dump ();
    const auto& transaction = summary["transactions"][0];
    EXPECT_EQ (transaction["count"], 1);
    EXPECT_EQ (transaction["errors"], 1);

    auto& collector = *context_->metrics_collector;
    ASSERT_EQ (collector.latency_samples (), 2u)
    << "the run's histogram left out the member that timed out";
    const auto whole_run = collector.calculate_percentiles ();
    const double members =
    state->steps.percentiles (0).max + state->steps.percentiles (1).max;
    // Both sides are microsecond sums read back through a histogram, each
    // within 0.1% above the true value.
    EXPECT_NEAR (transaction["latency"]["max"].get<double> (), members, 0.002 * members);
    EXPECT_NEAR (
    whole_run.max, state->steps.percentiles (1).max, 0.001 * whole_run.max);
}

// Contract coverage under load (issue #629). What this pins that the tally's
// own tests cannot: the completion callback records on the real event loop, so
// every virtual user's send lands on the right operation - and the count is
// exact rather than derived from the bounded store the mode thins.
TEST_F (ScenarioLoadTest, ALoadRunCountsEveryCompletionAgainstItsOperation) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].spec_operation =
    R"({"operationId":"listPets","method":"GET","path":"/pets"})";
    // Step 1 names no operation at all, so its sends land in the off-contract
    // tally rather than on a row they do not belong to.
    vayu::core::DeclaredOperation listed;
    listed.operation_id = "listPets";
    listed.method       = "GET";
    listed.path         = "/pets";
    listed.responses    = { "200", "404" };
    vayu::core::DeclaredOperation never;
    never.operation_id                 = "deletePet";
    never.method                       = "DELETE";
    never.path                         = "/pets/{petId}";
    never.responses                    = { "204" };
    execution.spec.spec_id             = "spec_1";
    execution.spec.declared_operations = { listed, never };

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto coverage = vayu::core::build_scenario_load_coverage (*state);
    ASSERT_FALSE (coverage.empty ()) << "a bound run must report coverage";
    EXPECT_EQ (coverage["operationsTotal"], 2);
    EXPECT_EQ (coverage["operationsCovered"], 1);
    // Three iterations, one send of step 0 each - exact, not a sample.
    for (const auto& row : coverage["operations"]) {
        if (row["path"] == "/pets") {
            EXPECT_EQ (row["sent"], 3);
            EXPECT_EQ (row["declaredHit"], json::array ({ "200" }));
            EXPECT_EQ (row["declaredMissed"], json::array ({ "404" }));
        }
    }
    EXPECT_EQ (coverage["undeclaredOperationRequests"], 3);
}

// The other half of the per-mode rule: a load run of an unbound collection - the
// overwhelming majority - writes no coverage at all rather than a contract of
// zero operations.
TEST_F (ScenarioLoadTest, AnUnboundLoadRunReportsNoCoverageAtAll) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (vayu::core::build_scenario_load_coverage (*state).empty ());
}

// The breakdown carries each step's identity beside its numbers, and the
// summary keeps the keys the report route already reads for a scenario run.
TEST_F (ScenarioLoadTest, TheSummaryCarriesAPerStepBreakdownAndTheSharedScenarioKeys) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    // Shared with the design-mode runner's payload, so one report section
    // covers both executors.
    EXPECT_EQ (summary["iterations"], 2);
    EXPECT_EQ (summary["iterations_completed"], 2);
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 0);
    EXPECT_EQ (summary["passed"], 4);
    EXPECT_EQ (summary["failed"], 0);
    // This mode's own.
    EXPECT_EQ (summary["virtual_users"], 1);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    EXPECT_EQ (summary["steps"][0]["index"], 0);
    EXPECT_EQ (summary["steps"][0]["name"], "step0");
    EXPECT_EQ (summary["steps"][0]["requestId"], "req_0");
    EXPECT_EQ (summary["steps"][0]["method"], "GET");
    EXPECT_EQ (summary["steps"][0]["executed"], 2);
    EXPECT_EQ (summary["steps"][0]["errors"], 0);
    EXPECT_EQ (summary["steps"][0]["httpErrors"], 0);
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0);
    EXPECT_EQ (summary["steps"][1]["name"], "step1");
    EXPECT_TRUE (summary["steps"][0]["latency"].contains ("p99"));
}

// A load run resolves no residual pass over what it binds (issue #1503): a
// step whose URL still carries `{{missing}}` after composition sends it
// literally on every iteration, and the run counts rather than refuses it -
// both per step, in the breakdown, and once for the whole run, in the
// metrics collector the top-level `warnings` line reads. Mutation check:
// remove the `unresolved_token_names` scan in `submit_one` and this reds,
// because nothing else in the load path ever looks for a `{{`.
TEST_F (ScenarioLoadTest, AStepWithAnUnresolvedTokenCountsAndWarnsWithoutRefusingTheRun) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0") + "?token={{missing}}", server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0]["unresolvedTokens"], 2)
    << "both iterations of step0 carried the unresolved token";
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 0)
    << "step1 carries no token and must not be charged for step0's";

    EXPECT_EQ (context_->metrics_collector->unresolved_token_requests (), 2u);
    const auto names = context_->metrics_collector->unresolved_token_names ();
    ASSERT_EQ (names.size (), 1u);
    EXPECT_EQ (names[0], "missing");

    // Never refused: both requests were still sent and completed.
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 0);
}

// An un-inlined pre-request script never runs under load (see this file's
// header comment on the executor); the breakdown says so per step instead of
// leaving the report silent about it, and a step with no script carries no
// such key. Mutation check: drop the `step_has_deferred_script` check in
// `build_step_breakdown` and step0's entry loses the field.
TEST_F (ScenarioLoadTest, AStepCarryingAPreRequestScriptReportsItSkippedInTheBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_pre_script (
    "pm.environment.set('x', '1');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0]["preRequestScript"], "skipped");
    EXPECT_FALSE (summary["steps"][1].contains ("preRequestScript"))
    << "a step with no pre-request script must not report one as skipped";
}

// The run-level `pre_request_script_skipped` warning and the per-step
// `preRequestScript` marker read one rule (issue #1938): a `script.pre` that ran
// inline is neither warned about nor marked, one that did not is both. Driven
// through the real executor so the mode reaches the summary the way production
// hands it over. Mutation check: make `step_has_deferred_script` ignore its
// mode (back to `step_has_script`) and the two inline cases red.
class PreScriptSkippedTest : public ScenarioLoadTest {
    protected:
    /// Run a two-step plan whose step 0 carries a non-blank `script.pre`,
    /// marked inline or not, under @p scripts_mode (an `elements.scripts` value,
    /// empty for a payload that names none).
    std::shared_ptr<vayu::core::ScenarioLoadState> run_with_pre_script (
    ScenarioMockServer& server,
    bool marked_inline,
    const std::string& scripts_mode) {
        auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
        execution.plan.steps[0].elements =
        vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
        "el_pre", "script.pre", "pm.environment.set('x', '1');", marked_inline) });
        execution_ = execution;

        json config = { { "mode", "iterations" }, { "iterations", 1 },
            { "concurrency", 1 } };
        if (!scripts_mode.empty ()) {
            config["elements"] = { { "scripts", scripts_mode } };
        }
        return run (config, execution_);
    }

    /// The `pre_request_script_skipped` entries of the run's `warnings` array.
    json skipped_warnings () const {
        json found = json::array ();
        for (const auto& warning : vayu::core::build_run_warnings (context_)) {
            if (warning["code"] == "pre_request_script_skipped") {
                found.push_back (warning);
            }
        }
        return found;
    }

    json step0_breakdown (const vayu::core::ScenarioLoadState& state) const {
        return vayu::core::build_scenario_load_summary (
        state, execution_.plan)["steps"][0];
    }

    vayu::core::ScenarioExecution execution_;
};

TEST_F (PreScriptSkippedTest, AnUnmarkedPreScriptUnderAsMarkedIsWarnedAndMarkedSkipped) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/false, "asMarked");

    const auto warnings = skipped_warnings ();
    ASSERT_EQ (warnings.size (), 1u) << warnings.dump ();
    EXPECT_EQ (warnings[0]["steps"], 1);
    EXPECT_EQ (step0_breakdown (*state)["preRequestScript"], "skipped");
}

TEST_F (PreScriptSkippedTest, AllInlineRunsAnUnmarkedPreScriptSoNothingIsWarnedOrMarked) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/false, "allInline");

    EXPECT_TRUE (skipped_warnings ().empty ()) << skipped_warnings ().dump ();
    const auto step0 = step0_breakdown (*state);
    EXPECT_FALSE (step0.contains ("preRequestScript")) << step0.dump ();
    ASSERT_TRUE (step0.contains ("elements")) << step0.dump ();
    EXPECT_EQ (step0["elements"][0]["kind"], "script.pre");
    EXPECT_EQ (step0["elements"][0]["passed"], 1)
    << "the script ran, so the breakdown reports its real outcome";
}

TEST_F (PreScriptSkippedTest, APreScriptMarkedInlineIsNotWarnedWhenTheRunNamesNoOverride) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/true, "");

    EXPECT_TRUE (skipped_warnings ().empty ()) << skipped_warnings ().dump ();
    EXPECT_FALSE (step0_breakdown (*state).contains ("preRequestScript"));
}

TEST_F (PreScriptSkippedTest, AllDeferredOverridesAnInlineMarkSoItIsWarnedAndMarked) {
    ScenarioMockServer server;
    auto state = run_with_pre_script (server, /*marked_inline=*/true, "allDeferred");

    const auto warnings = skipped_warnings ();
    ASSERT_EQ (warnings.size (), 1u) << warnings.dump ();
    EXPECT_EQ (warnings[0]["steps"], 1);
    EXPECT_EQ (step0_breakdown (*state)["preRequestScript"], "skipped");
}

// A blank script is inert (#1609) and a step without the kind carries nothing
// to leave behind, so neither counts as deferred whatever the mode.
TEST (StepHasDeferredScript, CountsOnlyANonBlankScriptOfTheNamedKindThatDidNotRunInline) {
    using vayu::core::ScriptsOverrideMode;
    using vayu::core::step_has_deferred_script;
    vayu::core::ScenarioStep step;
    step.elements =
    vayu::tests::step_elements_with_pre_script ("pm.test('t', () => {});");
    EXPECT_TRUE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked));
    EXPECT_TRUE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AllDeferred));
    EXPECT_FALSE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AllInline));
    EXPECT_FALSE (step_has_deferred_script (step, "script.post", ScriptsOverrideMode::AsMarked))
    << "a step carrying only a script.pre has no deferred script.post";

    step.elements = vayu::tests::step_elements_with_pre_script ("   \n");
    EXPECT_FALSE (step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked))
    << "a blank script carries no behaviour to warn about";

    step.elements.reset ();
    EXPECT_FALSE (
    step_has_deferred_script (step, "script.pre", ScriptsOverrideMode::AsMarked));
}

// Scripts stay deferred: a load-mode scenario runs none of them inline, and the
// run acquires no run-level script to stand in for the steps' own. What it does
// acquire (issue #450) is a per-step sample store for the steps that carry one,
// which the deferred pass below replays against.
TEST_F (ScenarioLoadTest, AScenarioLoadRunRunsNoInlineScriptsAndSamplesOnlyScriptedSteps) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    // A step that carries scripts, so "none ran inline" is a property of the
    // executor rather than of an empty plan.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_scripts (
    "pm.environment.set('x', '1');", "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    EXPECT_TRUE (context_->test_scripts.empty ())
    << "a scenario load run must not acquire a run-level test script";
    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.response_samples ().size (), 0u)
    << "a scenario run must not fill the run-level store - its scripts are per "
       "step";
    EXPECT_GT (mc.step_response_samples (0).size (), 0u)
    << "the step carrying a post-request script was never sampled, so its "
       "assertions can never be checked";
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u)
    << "a step with no script was sampled - a body-sized copy nothing will "
       "read";
}

// Issue #1500's acceptance criterion, the load-path half: a metric.record
// trend runs inline on every VU's `step.after` - declarative kinds always
// run there, unlike script.* - and lands in the run's own MetricsCollector,
// with a count equal to that step's completions.
TEST_F (ScenarioLoadTest, MetricRecordProducesCustomMetricsWithTheStepsCompletionCount) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { nlohmann::json{ { "id", "el_metric" }, { "kind", "metric.record" },
    { "config",
    { { "name", "ttfb2" }, { "type", "trend" }, { "source", { { "latency", true } } } } } } });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto summaries = context_->metrics_collector->custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    ASSERT_EQ (summaries->count ("ttfb2"), 1u);
    EXPECT_EQ (summaries->at ("ttfb2").type, vayu::core::CustomMetricType::Trend);
    EXPECT_EQ (summaries->at ("ttfb2").count, 5u);
}

// A plan whose steps assert nothing gets no stores at all, which is what keeps
// the report's section absent rather than showing zeros.
TEST_F (ScenarioLoadTest, APlanWithNoScriptsSamplesNothing) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.step_response_samples (0).size (), 0u);
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u);
    EXPECT_EQ (mc.response_samples_dropped (), 0u)
    << "a step nothing will validate must not be counted as a thinned sample";

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    EXPECT_FALSE (validation.run.has_value ())
    << "a run that validated nothing must omit the section, not report zeros";
}

// Sampling is keyed per step, so the last step of a long plan is sampled even
// when the run budget is far smaller than the number of completions.
//
// Mutation-check: revert to the flat whole-run reservoir and every one of these
// stores is empty - the run's samples all land in `response_samples()`, where
// nothing can tell which step produced them.
TEST_F (ScenarioLoadTest, EveryScriptedStepIsSampledIncludingTheLast) {
    ScenarioMockServer server;
    // Four steps over three distinct paths - the plan is what is long here, not
    // the mock. Every step asserts, so every step competes for the budget.
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1"),
    server.url ("/s2"), server.url ("/echo") });
    for (auto& step : execution.plan.steps) {
        step.elements = vayu::tests::step_elements_with_post_script (
        "pm.test('ok', function () { });");
    }

    // A budget of exactly one slot per scripted step, so the split is what
    // decides coverage rather than a budget large enough to hide it.
    const json config = { { "mode", "iterations" }, { "iterations", 6 },
        { "concurrency", 1 }, { "max_response_samples", 4 },
        { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc  = *context_->metrics_collector;
    size_t retained = 0;
    for (size_t step = 0; step < execution.plan.steps.size (); ++step) {
        EXPECT_GT (mc.step_response_samples (step).size (), 0u)
        << "step " << step << " was never sampled, so its assertions are never checked";
        retained += mc.step_response_samples (step).size ();
    }
    EXPECT_LE (retained, 4u) << "the run budget was handed to each step whole "
                                "instead of split across them";
    EXPECT_GT (mc.response_samples_dropped (), 0u)
    << "24 completions into a 4-sample budget must report what was thinned";
}

// ============================================================================
// Deferred per-step script validation (issue #450)
// ============================================================================

// Each step's own `post_script` is replayed against that step's samples, and a
// step with no script reports no tallies at all.
TEST_F (ScenarioLoadTest, EachStepsScriptIsReplayedAgainstItsOwnSamples) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 2u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step)
    << "the scripted step reported no tallies, so its assertions went "
       "unchecked";
    EXPECT_EQ (first_step->sampled, 3u);
    EXPECT_EQ (first_step->passed, 3u);
    EXPECT_EQ (first_step->failed, 0u);
    EXPECT_FALSE (validation.steps[1].has_value ())
    << "a step with no script must report nothing rather than a row of zeros";

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 3u);
    EXPECT_EQ (validation.run->passed, 3u);
}

// A failing assertion is attributed to the step that made it, not to the run -
// which is the whole reason the tallies are per step.
TEST_F (ScenarioLoadTest, AFailingAssertionIsAttributedToItsOwnStep) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});");
    execution.plan.steps[1].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('wrong', function () { pm.expect(pm.response.code).to.equal(500); "
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 3u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->failed, 0u);
    EXPECT_EQ (first_step->passed, 2u);
    const auto& second_step = validation.steps[1];
    ASSERT_HAS_VALUE (second_step);
    EXPECT_EQ (second_step->failed, 2u)
    << "step 2's failing assertion was not attributed to step 2";
    EXPECT_EQ (second_step->passed, 0u);
    EXPECT_FALSE (validation.steps[2].has_value ());

    // The run's headline still says something failed; the breakdown says where.
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 2u);
    EXPECT_EQ (validation.run->passed, 2u);
}

// A script whose `pm.test` calls are a mix of passing and failing must not
// collapse to one opaque failure (issue #1502): every test result is tallied
// and every failure is named.
TEST_F (ScenarioLoadTest, AMixedPassAndFailScriptReportsBothTalliesAndNamesTheFailure) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('status is 200', function () { "
    "pm.expect(pm.response.code).to.equal(200); });"
    "pm.test('body has a unicorn', function () { "
    "pm.expect(undefined).to.equal('yes'); });");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u)
    << "the passing assertion was discarded once a sibling assertion failed";
    EXPECT_EQ (first_step->failed, 1u);

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("body has a unicorn: AssertionError: Expected "
                           "undefined to equal 'yes'"),
    std::string::npos)
    << trace;
    EXPECT_EQ (trace.find ("Script error: "), std::string::npos)
    << "a named assertion failure was reported as an opaque script error: " << trace;
}

// A script can run a test to completion and still throw afterwards - that is
// a second, distinct failure and must not vanish just because the test that
// already ran is tallied (issue #1502).
TEST_F (ScenarioLoadTest, AScriptThatThrowsAfterAPassingTestStillReportsTheThrow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { pm.expect(1).to.equal(1); });"
    "throw new Error('late boom');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u)
    << "the test that ran before the throw was dropped";
    EXPECT_EQ (first_step->failed, 1u)
    << "the throw after the test was silently dropped";

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("Script error: "), std::string::npos) << trace;
    EXPECT_NE (trace.find ("late boom"), std::string::npos)
    << "the thrown message was dropped: " << trace;
}

// A script that throws before ever calling `pm.test` has no tests to tally,
// so it still takes the script-error path - but with the real thrown message,
// never an empty one (issue #1502).
TEST_F (ScenarioLoadTest, AThrowingScriptWithNoTestsNamesTheThrownMessage) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::step_elements_with_post_script ("throw new Error('boom');");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 0u);
    EXPECT_EQ (first_step->failed, 1u);

    const auto results = db_->get_results ("test-scenario-load");
    ASSERT_FALSE (results.empty ());
    const std::string& trace = results.back ().trace_data;
    EXPECT_NE (trace.find ("Script error: "), std::string::npos) << trace;
    EXPECT_NE (trace.find ("boom"), std::string::npos)
    << "the thrown message was dropped, leaving an empty \"Script error: \": " << trace;
}

// The replayed script reads the iteration it actually ran in and the data row
// that iteration was bound to - a real index, not a reservoir position.
TEST_F (ScenarioLoadTest, ADeferredStepScriptReadsItsIterationAndDataRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "a" } }, json{ { "id", "b" } } });
    // Two iterations bind rows 0 and 1, so a script that pairs the iteration
    // with its row passes only if both bindings are the real ones.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('bound', function () {"
    "  var expected = pm.info.iteration === 0 ? 'a' : 'b';"
    "  if (pm.iterationData.get('id') !== expected) {"
    "    throw new Error('iteration ' + pm.info.iteration + ' saw ' +"
    "      pm.iterationData.get('id'));"
    "  }"
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 2u);
    EXPECT_EQ (first_step->failed, 0u);
}

// `pm.execution` still throws, naming itself: a script that has already run
// against a recorded response cannot redirect a sequence that already happened.
TEST_F (ScenarioLoadTest, PmExecutionStillThrowsInADeferredStepScript) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    // The assertion passes only if the call threw *and* the sentence named the
    // method - so a silently accepted call fails this test rather than reading
    // as a pass.
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('refused', function () {"
    "  var message = '';"
    "  try { pm.execution.setNextRequest('somewhere'); }"
    "  catch (e) { message = String(e && e.message ? e.message : e); }"
    "  if (message.indexOf('setNextRequest') === -1) {"
    "    throw new Error('not refused by name: ' + message);"
    "  }"
    "});");

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& first_step = validation.steps[0];
    ASSERT_HAS_VALUE (first_step);
    EXPECT_EQ (first_step->passed, 1u);
    EXPECT_EQ (first_step->failed, 0u);
}

// The tallies land on the step they belong to in the stored summary, which is
// what the report route hands the app verbatim.
TEST_F (ScenarioLoadTest, PerStepTalliesAreAttachedToTheStoredBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('ok', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    auto state        = run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);
    auto summary =
    vayu::core::build_scenario_load_summary (*state, context_->scenario->plan);
    vayu::core::attach_step_test_totals (summary, validation.steps);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    ASSERT_TRUE (summary["steps"][0].contains ("tests"));
    EXPECT_EQ (summary["steps"][0]["tests"]["sampled"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["passed"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["failed"], 0);
    EXPECT_FALSE (summary["steps"][1].contains ("tests"))
    << "a step that asserted nothing must carry no tests object at all";
}

// ============================================================================
// The element pipeline on the load paths (issue #1495)
// ============================================================================

// A declarative element (extract.json) always runs inline under load - no
// `inline` mark needed, only a `script.*` element opts in explicitly. Two VUs
// held inside `/login` at the same time must each carry their *own* login's
// token on their own step 1, never the other's - the correlation bug this
// issue exists to fix, proven the same way cookie isolation is proven above.
//
// Mutation check: remove the residual-token-pass call in `submit_one`, and
// step 1 sends the literal `{{token}}` for both VUs instead of either one's
// real value.
TEST_F (ScenarioLoadTest, AnInlineExtractCorrelatesPerVirtualUserAcrossSteps) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization)
    << "both virtual users sent the same token - the extraction is shared "
       "rather than per-VU";
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        const std::string session_id = echo.cookie.substr (4);
        EXPECT_EQ (echo.authorization, "Bearer tok-" + session_id)
        << "step 1 carried a token that does not match this VU's own login "
           "session - the two are not being bound to the same VU";
    }
}

// The same correlation, through an inline `script.post` instead of a
// declarative `extract.json` - proving the opt-in itself works, not just the
// overlay it writes through.
TEST_F (ScenarioLoadTest, AScriptPostMarkedInlineCorrelatesPerVirtualUserTheSameWayExtractDoes) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization);
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0);
        EXPECT_EQ (echo.authorization, "Bearer tok-" + echo.cookie.substr (4));
    }
}

namespace {

/// What an inline script reads about its own execution, as one string:
/// `vu/iteration/row/bare-column|replaceIn(vu/iteration/data.user)`. The row
/// half is guarded so an unbound row reads `no-row` rather than throwing,
/// which keeps a failure's message about the value that was wrong.
constexpr const char* SEEN_IDENTITY_JS =
"(pm.info.vu + '/' + pm.info.iteration + '/' +"
" (pm.iterationData ? pm.iterationData.get('user') : 'no-row') + '/' +"
" pm.variables.get('user') + '|' +"
" pm.variables.replaceIn('{{$vu}}/{{$iteration}}/{{data.user}}'))";

/// What the binder itself writes for @ref SEEN_IDENTITY_JS's fields, sent as
/// `X-Bound`, so a script's reading can be compared with the request it ran
/// beside.
constexpr const char* BOUND_IDENTITY_TEMPLATE =
"{{$vu}}/{{$iteration}}/{{data.user}}/{{data.user}}|"
"{{$vu}}/{{$iteration}}/{{data.user}}";

} // namespace

// #3124: an inline `script.pre` under load reads the virtual user, the
// iteration and the row its own execution was bound with - two users, so the
// pairing is per execution rather than per run. Mutation check: pass a null
// row to `bind_step_identity` in `run_step_before` and every `X-Seen` reads
// `.../no-row/undefined|.../{{data.user}}`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreReadsTheRowIterationAndUserItsStepWasBoundWith) {
    constexpr size_t ITERATIONS = 4;
    vayu::tests::EchoServer echo;
    auto execution = plan_over ({ echo.url () });
    execution.plan.steps[0].request.headers["X-Bound"] = BOUND_IDENTITY_TEMPLATE;
    with_data (execution, { json{ { "user", "ada" } }, json{ { "user", "bob" } } });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.pre",
    std::string ("pm.request.headers['X-Seen'] = ") + SEEN_IDENTITY_JS + ";") });

    run (json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 2 } },
    execution, /*pool_size=*/2);

    const auto bound = echo.header_per_request ("X-Bound");
    ASSERT_EQ (bound.size (), ITERATIONS);
    EXPECT_EQ (std::set<std::string> (bound.begin (), bound.end ()).size (), ITERATIONS)
    << "two executions were bound as the same user and iteration";
    EXPECT_EQ (echo.header_per_request ("X-Seen"), bound);
}

// The completion side: an inline `script.post` reads what the request it ran
// beside was bound with. Mutation check: pass a null row to
// `bind_step_identity` in `run_step_after` and this test fails.
TEST_F (ScenarioLoadTest, AnInlineScriptPostReadsTheRowIterationAndUserOfTheRequestItRanBeside) {
    constexpr size_t ITERATIONS = 4;
    vayu::tests::EchoServer echo;
    auto execution = plan_over ({ echo.url () });
    execution.plan.steps[0].request.headers["X-Bound"] = BOUND_IDENTITY_TEMPLATE;
    with_data (execution, { json{ { "user", "ada" } }, json{ { "user", "bob" } } });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    std::string ("pm.test('beside', function () { pm.expect(") +
    SEEN_IDENTITY_JS + ").to.equal(pm.request.headers.get('X-Bound')); });") });

    const auto state = run (json{ { "mode", "iterations" },
                            { "iterations", ITERATIONS }, { "concurrency", 2 } },
    execution, /*pool_size=*/2);

    EXPECT_EQ (state->inline_tests_passed.load (), ITERATIONS);
    EXPECT_EQ (state->inline_tests_failed.load (), 0u);
}

// #2521: the same correlation through a plan `resolve_scenario` composed from
// stored requests, whose collection already holds a `token`. The bearer step
// carries no element, so only the plan-wide rule leaves its `{{token}}` for the
// per-VU pass. Mutation check: make `plan_variable_deferral` (scenario_plan.cpp)
// answer `WhenScripted`, and every VU sends `Bearer old`.
TEST_F (ScenarioLoadTest, APlannedStepSendsTheTokenAnEarlierStepExtractedNotTheStoredOne) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    const auto execution = resolve_login_then_bearer (server,
    json::array ({ vayu::tests::extract_json_element_json ("el_token", "$.token", "token") }));

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        EXPECT_EQ (echo.authorization, "Bearer tok-" + echo.cookie.substr (4));
    }
}

// The same through an inline `script.post`, the test-script login.
TEST_F (ScenarioLoadTest, APlannedStepSendsTheTokenAnEarlierInlineTestScriptSet) {
    ScenarioMockServer server;
    const auto execution = resolve_login_then_bearer (server,
    json::array ({ vayu::tests::script_element_json ("el_post", "script.post",
    "pm.collectionVariables.set('token', pm.response.json().token);",
    /*inline_script=*/true) }));

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer tok-" + std::to_string (i + 1));
    }
}

// ============================================================================
// What an iteration boundary resets (#3044): the session and the run-local
// scope, never the variables a virtual user saved
// ============================================================================

namespace {

/// `/login` fired once per virtual user, its `$.token` saved as `token`.
std::shared_ptr<const std::vector<vayu::core::CompiledElement>> login_once_elements () {
    return vayu::tests::compiled_elements (
    { json{ { "id", "el_once" }, { "kind", "control.once" },
      { "enabled", true }, { "config", json::object () } },
    vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
}

} // namespace

// The issue's repro: a `control.once` login extracts the token in iteration 1
// and every later iteration's step 1 still sends it, while the login's cookie
// is gone from iteration 2 on. Mutation check: clear the whole overlay in
// `end_iteration` and iterations 2 and 3 send the literal `Bearer {{token}}`.
TEST_F (ScenarioLoadTest, AControlOnceLoginsTokenReachesEveryLaterIteration) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = login_once_elements ();

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    ASSERT_EQ (server.hits_for ("/login").size (), 1u)
    << "control.once let the login run again";
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer tok-1")
        << "iteration " << i + 1 << " lost the token the login saved";
    }
    EXPECT_EQ (echoes[0].cookie, "sid=1");
    EXPECT_EQ (echoes[1].cookie, "")
    << "the login's session outlived its iteration";
    EXPECT_EQ (echoes[2].cookie, "");
}

// A `pm.variables.set` value is the run-local scope, which starts every
// iteration empty: step 1 reads this iteration's value, and the next
// iteration's step 0 finds none. Mutation check: make `clear_local` a no-op
// and the second `/echo` sends `Bearer local-0`.
TEST_F (ScenarioLoadTest, ALocalValueLastsOneIteration) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/s0") });
    for (auto& step : execution.plan.steps) {
        step.request.headers["Authorization"] = "Bearer {{seen}}";
    }
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.variables.set('seen', 'local-' + pm.info.iteration);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    const auto after  = server.hits_for ("/s0");
    ASSERT_EQ (echoes.size (), 2u);
    ASSERT_EQ (after.size (), 2u);
    EXPECT_EQ (after[0].authorization, "Bearer local-0");
    EXPECT_EQ (after[1].authorization, "Bearer local-1");
    EXPECT_EQ (echoes[0].authorization, "Bearer {{seen}}");
    EXPECT_EQ (echoes[1].authorization, "Bearer {{seen}}")
    << "iteration 1's run-local value reached iteration 2";
}

// A bare data column is bound from the iteration's own row before any saved
// variable is read, so a name the VU saved in iteration 1 cannot answer for
// iteration 2's row.
TEST_F (ScenarioLoadTest, ASavedVariableDoesNotShadowTheNextRowsColumn) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{id}}"), server.url ("/login") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_id", "$.token", "id") });
    execution.data_rows = { json{ { "id", "0" } }, json{ { "id", "1" } } };
    const auto columns  = vayu::core::bound_columns_of (execution.data_rows);
    for (auto& step : execution.plan.steps) {
        step.data_template = vayu::core::tokenize_bindable_fields (step.request, columns);
    }

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    EXPECT_EQ (rows, (std::vector<std::string>{ "/row/0", "/row/1" }))
    << "iteration 1's saved `id` answered for iteration 2's row";
}

// Two virtual users each keep their own login's token across iterations,
// never the other's. Step 1 sends to `/row/{{$vu}}`, so each echo names the
// user that sent it.
TEST_F (ScenarioLoadTest, TwoVirtualUsersKeepTheirOwnSavedTokenAcrossIterations) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/row/{{$vu}}"));
    execution.plan.steps[0].elements = login_once_elements ();
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 6 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    ASSERT_EQ (server.hits_for ("/login").size (), 2u);
    std::map<std::string, std::set<std::string>> tokens_by_vu;
    size_t echoes = 0;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            tokens_by_vu[hit.path].insert (hit.authorization);
            ++echoes;
        }
    }
    EXPECT_EQ (echoes, 6u);
    ASSERT_EQ (tokens_by_vu.size (), 2u) << "both users must have sent step 1";
    std::set<std::string> distinct;
    for (const auto& [vu, tokens] : tokens_by_vu) {
        ASSERT_EQ (tokens.size (), 1u) << vu << " sent more than one token across its iterations";
        EXPECT_EQ (tokens.begin ()->rfind ("Bearer tok-", 0), 0u)
        << vu << " sent " << *tokens.begin ();
        distinct.insert (*tokens.begin ());
    }
    EXPECT_EQ (distinct.size (), 2u) << "the two users sent the same token";
}

// ----------------------------------------------------------------------------
// An extractor's miss unsets the variable (#3053): the VU's own earlier value
// goes, and the run's stored value is hidden for that VU alone.
// ----------------------------------------------------------------------------

namespace {

/// `col_test`, the collection `plan_over` names, storing `token=old`: the
/// shared base value an overlay cannot erase, only hide.
void store_old_token (vayu::db::Database& db) {
    vayu::db::Collection collection;
    collection.id         = "col_test";
    collection.name       = "Collection";
    collection.variables  = R"({"token":{"value":"old","enabled":true}})";
    collection.created_at = 1;
    collection.updated_at = 1;
    db.create_collection (collection);
}

} // namespace

// Each row picks the endpoint step 0 extracts from: `/login` answers a token,
// `/s0` answers `{}`. Mutation check: drop the `unset` in `write_miss`
// (extract_kinds.cpp) and the second iteration sends `Bearer tok-1` again.
TEST_F (ScenarioLoadTest, AMissSendsTheUnresolvedNameNotTheLastIterationsValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/{{data.from}}"), server.url ("/echo") });
    execution.plan.steps[1].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution,
    { json{ { "from", "login" } }, json{ { "from", "s0" } }, json{ { "from", "login" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    EXPECT_EQ (echoes[0].authorization, "Bearer tok-1");
    EXPECT_EQ (echoes[1].authorization, "Bearer {{token}}")
    << "iteration 2's miss left iteration 1's token in use";
    EXPECT_EQ (echoes[2].authorization, "Bearer tok-2")
    << "a later hit sets it again";
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 1);
    // The one miss, on the step that missed (#3053); the step with no
    // extractor carries no key. Mutation check: drop the `is_extractor_miss`
    // count in `StepElementTallies::record` (scenario_load.cpp) and this fails.
    EXPECT_EQ (summary["steps"][0].value ("extractorMisses", 0), 1);
    EXPECT_FALSE (summary["steps"][1].contains ("extractorMisses"));
}

// A step whose request fails in transport (#3089) runs its extractors against
// the status-0 response like the sequential run: the variable is unset and the
// miss counted. The refused port is one a server bound and released, so no
// port is fixed. Mutation check: drop the `run_step_after` call in the
// completion callback's response branch (scenario_load.cpp) and the miss count
// reads 0.
TEST_F (ScenarioLoadTest, ATransportFailedExtractingStepUnsetsItsVariableAndCountsAMiss) {
    int dead_port = 0;
    {
        httplib::Server released;
        dead_port = released.bind_to_any_port ("127.0.0.1");
    }
    ASSERT_GT (dead_port, 0);

    ScenarioMockServer server;
    auto execution = plan_over ({ "{{data.from}}", server.url ("/echo") });
    execution.plan.steps[1].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution,
    { json{ { "from", server.url ("/login") } },
    json{ { "from", "http://127.0.0.1:" + std::to_string (dead_port) + "/login" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_GE (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer tok-1");
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0].value ("extractorMisses", 0), 1)
    << summary["steps"][0];
}

// Every iteration hits, or misses into a `default`: neither is a miss, and
// the key is absent rather than `0`.
TEST_F (ScenarioLoadTest, AHitOrADefaultAnsweredMissCountsNoExtractorMiss) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto rescued = vayu::tests::extract_json_element_json ("el_id", "$.absent", "id");
    rescued["config"]["default"]     = "none";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token"), rescued });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_EQ (summary["steps"][0]["executed"], 2);
    EXPECT_FALSE (summary["steps"][0].contains ("extractorMisses"))
    << summary["steps"][0];
}

// A `control.once` login that misses: the stored `token=old` is hidden from
// iteration 1 on, through the inline script after the extractor
// (`materialize`, then `replace_from`) and every later iteration's
// `clear_local`. Mutation check: drop the tombstone in `apply_onto` and
// iterations 2 and 3 send `Bearer old`.
TEST_F (ScenarioLoadTest, AMissHidesTheStoredValueForEveryLaterIteration) {
    store_old_token (*db_);
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_once" }, { "kind", "control.once" },
      { "enabled", true }, { "config", json::object () } },
    vayu::tests::extract_json_element_json ("el_token", "$.absent", "token"),
    vayu::tests::script_element_json ("el_post", "script.post",
    "pm.collectionVariables.set('seen', 'yes');", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    ASSERT_EQ (server.hits_for ("/login").size (), 1u);
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer {{token}}")
        << "iteration " << i + 1 << " sent the stored value the miss unset";
    }
}

// Two VUs over one stored `token=old`: the `s0` row's VU runs the extractor
// and misses, the `s1` row's VU skips step 0 (`control.if`) and extracts
// nothing. The `/login` rendezvous holds the second until the first has
// missed, so a tombstone that reached the shared base would show. Each step 2
// names its row's VU.
TEST_F (ScenarioLoadTest, AMissHidesTheStoredValueForThatVirtualUserAlone) {
    store_old_token (*db_);
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/{{data.from}}"),
    server.url ("/login"), server.url ("/row/{{data.from}}") });
    execution.plan.steps[2].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{data.from}} == s0" } } } },
    vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution, { json{ { "from", "s0" } }, json{ { "from", "s1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto missed  = server.hits_for ("/row/s0");
    const auto skipped = server.hits_for ("/row/s1");
    ASSERT_EQ (missed.size (), 1u);
    ASSERT_EQ (skipped.size (), 1u);
    EXPECT_EQ (missed[0].authorization, "Bearer {{token}}");
    EXPECT_EQ (skipped[0].authorization, "Bearer old")
    << "one virtual user's unset reached another's view of the stored value";
}

// ----------------------------------------------------------------------------
// A script's own `pm.environment.unset` of a stored name (#3088) is kept the
// way an extractor's miss is: hidden for that VU until it sets the name again.
// ----------------------------------------------------------------------------

namespace {

constexpr const char* TOKEN_ENVIRONMENT_ID = "env_test";

/// An environment storing `tok=stored`, the shared base value a script's
/// unset can only hide.
void store_environment_token (vayu::db::Database& db) {
    vayu::db::Environment environment;
    environment.id         = TOKEN_ENVIRONMENT_ID;
    environment.name       = "Environment";
    environment.variables  = R"({"tok":{"value":"stored","enabled":true}})";
    environment.created_at = 1;
    environment.updated_at = 1;
    db.save_environment (environment);
}

json inline_post_script (const std::string& id, const std::string& source) {
    return vayu::tests::script_element_json (id, "script.post", source, /*inline_script=*/true);
}

} // namespace

// Step 0 unsets, step 1 sends `{{tok}}` and then sets it, step 2 sends it
// again. Mutation check: skip the base-name loop in
// `ScopeOverlay::replace_from` and step 1 sends `Bearer stored`.
TEST_F (ScenarioLoadTest, AScriptsUnsetOfAStoredNameSticksUntilAScriptSetsItAgain) {
    store_environment_token (*db_);
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/echo"), server.url ("/row/after-set") });
    execution.plan.steps[1].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[2].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { inline_post_script ("el_unset", "pm.environment.unset('tok');") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { inline_post_script ("el_set", "pm.environment.set('tok', 'again');") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1, TOKEN_ENVIRONMENT_ID);

    const auto unset = server.hits_for ("/echo");
    const auto reset = server.hits_for ("/row/after-set");
    ASSERT_EQ (unset.size (), 1u);
    ASSERT_EQ (reset.size (), 1u);
    EXPECT_EQ (unset[0].authorization, "Bearer {{tok}}")
    << "the stored value answered after the script unset it";
    EXPECT_EQ (reset[0].authorization, "Bearer again");
}

// Two VUs over one stored `tok`: the `s0` row's VU runs step 0's unsetting
// script, the `s1` row's VU skips step 0 (`control.if`). The `/login`
// rendezvous holds the second until the first has unset, so a tombstone that
// reached the shared base would show. Each step 2 names its row's VU.
TEST_F (ScenarioLoadTest, AScriptsUnsetOfAStoredNameHidesItForThatVirtualUserAlone) {
    store_environment_token (*db_);
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/{{data.from}}"),
    server.url ("/login"), server.url ("/row/{{data.from}}") });
    execution.plan.steps[2].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{data.from}} == s0" } } } },
    inline_post_script ("el_unset", "pm.environment.unset('tok');") });
    with_data (execution, { json{ { "from", "s0" } }, json{ { "from", "s1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2, TOKEN_ENVIRONMENT_ID);

    const auto unsetting = server.hits_for ("/row/s0");
    const auto skipping  = server.hits_for ("/row/s1");
    ASSERT_EQ (unsetting.size (), 1u);
    ASSERT_EQ (skipping.size (), 1u);
    EXPECT_EQ (unsetting[0].authorization, "Bearer {{tok}}");
    EXPECT_EQ (skipping[0].authorization, "Bearer stored")
    << "one virtual user's unset reached another's view of the stored value";
}

// Without the `inline` mark, a `script.post` element stays exactly where it
// always was - deferred to the post-run replay - and the run's wire traffic
// is byte-for-byte what it was before issue #1495: `{{token}}` reaches the
// wire literally, and it counts as an unresolved token rather than silently
// vanishing.
//
// Mutation check: mark the element `inline` (as the test above does) and this
// assertion reds - the literal token would resolve instead.
TEST_F (ScenarioLoadTest, WithoutTheInlineMarkAScriptPostStaysDeferredAndTheWireIsUnchanged) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);") }); // no inline mark

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer {{token}}")
    << "an un-inlined script must not affect this run's wire traffic at all";

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 1)
    << "the literal token must still be counted, exactly as an unresolved "
       "token always has been";
}

// A `script.pre` marked `inline` reaches the wire on *every* submission, not
// only the first - proving the hook runs from the producer's own steady-state
// loop rather than once at setup.
TEST_F (ScenarioLoadTest, AScriptPreMarkedInlineReachesTheWireOnEverySubmission) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.request.headers.upsert('Authorization', 'Bearer injected');",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (echo.authorization, "Bearer injected");
    }
}

// A step's recorded latency is its transfer alone by default - an inline
// element's own time is not folded in - and `elements.includeScriptTime`
// opts a run into folding it back. Asserted as a *relative* difference
// between two otherwise-identical runs, one with the override and one
// without, rather than against an absolute millisecond floor: a shared CI
// machine's baseline transfer latency is itself noisy, but the gap this
// deliberately slow inline script (a bounded busy loop - a sandboxed script
// cannot sleep) opens between the two runs is not - tens of milliseconds of
// real interpreted work, well past any jitter one more request on the same
// mock could introduce.
TEST_F (ScenarioLoadTest, IncludeScriptTimeFoldsThePipelinesTimeIntoTheRecordedLatency) {
    ScenarioMockServer server;
    const std::string slow_script =
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }";

    auto excluded_execution = plan_over ({ server.url ("/echo") });
    excluded_execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
    "el_post", "script.post", slow_script, /*inline_script=*/true) });
    const json excluded_config    = { { "mode", "iterations" },
        { "iterations", 1 }, { "concurrency", 1 } };
    auto excluded_state           = run (excluded_config, excluded_execution);
    const double excluded_latency = vayu::core::build_scenario_load_summary (
    *excluded_state, excluded_execution.plan)["steps"][0]["latency"]["min"];

    auto included_execution = plan_over ({ server.url ("/echo") });
    included_execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
    "el_post", "script.post", slow_script, /*inline_script=*/true) });
    const json included_config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "includeScriptTime", true } } } };
    auto included_state           = run (included_config, included_execution);
    const double included_latency = vayu::core::build_scenario_load_summary (
    *included_state, included_execution.plan)["steps"][0]["latency"]["min"];

    EXPECT_GT (included_latency - excluded_latency, 15.0)
    << "excluded=" << excluded_latency << "ms included=" << included_latency
    << "ms - `elements.includeScriptTime` must fold the slow script's own "
       "time into the recorded latency, which this margin should show "
       "however noisy the machine's own baseline transfer latency is";
}

namespace {
/// The step and the run record one completion's latency as the same double,
/// in histograms of the same precision, so their maxima differ by no more
/// than the microsecond the run's histogram floors a value to.
constexpr double HISTOGRAM_ROUNDING_MS = 0.001;
} // namespace

// The step's latency and the run's are one population under
// `includeScriptTime` (#2792): a run whose max sat below a step's reported a
// step slower than any request of the run. Compared within one run, so the
// machine's speed cancels out; the flag-off run shows the run's figure moves
// as far as the step's does. Mutation check: drop `annotations.script_ms`
// from the run's latency in record_successful_response and the run's max
// falls to the transfer alone, below the step's.
TEST_F (ScenarioLoadTest, IncludeScriptTimeMovesTheRunsLatencyWithTheSteps) {
    ScenarioMockServer server;
    const std::string slow_script =
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }";
    struct Maxima {
        double step = 0.0;
        double run  = 0.0;
    };
    const auto measure = [&] (bool include_script_time) {
        auto execution = plan_over ({ server.url ("/echo") });
        execution.plan.steps[0].elements =
        vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
        "el_post", "script.post", slow_script, /*inline_script=*/true) });
        const json config = { { "mode", "iterations" }, { "iterations", 1 },
            { "concurrency", 1 },
            { "elements", { { "includeScriptTime", include_script_time } } } };
        auto state        = run (config, execution);
        return Maxima{ state->steps.percentiles (0).max,
            context_->metrics_collector->calculate_percentiles ().max };
    };

    const Maxima excluded = measure (false);
    const Maxima included = measure (true);

    EXPECT_GE (included.run, included.step - HISTOGRAM_ROUNDING_MS)
    << "step=" << included.step << "ms run=" << included.run
    << "ms - the run's max sits below its own step's";
    EXPECT_GE (included.run - excluded.run,
    (included.step - excluded.step) - (2.0 * HISTOGRAM_ROUNDING_MS))
    << "the flag moved the step's max by " << (included.step - excluded.step)
    << "ms and the run's by only " << (included.run - excluded.run) << "ms";
}

// The same rule for a failed transfer (#2384): under `includeScriptTime` the
// step's duration carries its pipeline time, and so does the run's, so the
// run's max is at least the step's (#2792). Mutation check: drop
// `annotations.script_ms` from the AttemptDuration in record_failed_response
// and the run's max falls to the transfer alone, below the step's.
TEST_F (ScenarioLoadTest, IncludeScriptTimeFoldsThePipelineIntoAFailedTransfersRunLatency) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }",
    /*inline_script=*/true) });
    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "includeScriptTime", true } } } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (0), 1u) << "port 1 answered";
    ASSERT_EQ (state->steps.latency_samples (0), 1u);
    const double step_ms = state->steps.percentiles (0).max;
    const double run_ms = context_->metrics_collector->calculate_percentiles ().max;
    EXPECT_GE (run_ms, step_ms - HISTOGRAM_ROUNDING_MS)
    << "step=" << step_ms << "ms run=" << run_ms
    << "ms - the run's max left out the failed step's script time";
}

// `elements.scripts: "allInline"` forces every `script.*` element inline
// regardless of its own `config.inline` - the override, not the per-element
// mark, decides.
TEST_F (ScenarioLoadTest, ElementsScriptsAllInlineForcesAnUnmarkedScriptInline) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);") }); // no inline mark

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "scripts", "allInline" } } } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_NE (echoes[0].authorization, "Bearer {{token}}")
    << "the run override must force the unmarked script inline";
}

// `elements.scripts: "allDeferred"` forces every `script.*` element deferred
// regardless of its own `inline` mark.
TEST_F (ScenarioLoadTest, ElementsScriptsAllDeferredIgnoresAPerElementInlineMark) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "scripts", "allDeferred" } } } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer {{token}}")
    << "the run override must defer the marked script regardless of its own "
       "mark";
}

// Per-step, per-element pass/fail/skip tallies (issue #1495): an inline
// element that ran reports its outcome under `elements`, and a step with no
// elements carries no such key at all.
TEST_F (ScenarioLoadTest, PerStepElementTalliesAreAttachedToTheBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements"));
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 1u);
    EXPECT_EQ (elements[0]["id"], "el_token");
    EXPECT_EQ (elements[0]["kind"], "extract.json");
    EXPECT_EQ (elements[0]["passed"], 2);
    EXPECT_EQ (elements[0]["failed"], 0);
    EXPECT_EQ (elements[0]["skipped"], 0);
    EXPECT_EQ (elements[0]["deferred"], 0);
    EXPECT_FALSE (summary["steps"][1].contains ("elements"))
    << "a step with no elements at all must carry no such key";
}

// A miss and an error are tallied as themselves (#3051), not folded into
// `skipped` and `failed`, and each row names its element: its label, the level
// it came from, and that it is required, which is what turns a miss into a
// failed step. Mutation check: fold `"missing"` back into `skipped` in
// `ElementOutcomeCounts::record` (pipeline.cpp) and `missing` reads 0.
TEST_F (ScenarioLoadTest, AMissAndAnErrorAreTalliedAsThemselvesOnANamedRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto required =
    vayu::tests::extract_json_element_json ("el_needed", "$.nope", "needed");
    required["name"]   = "Session id";
    required["origin"] = { { "kind", "request" }, { "scope", "request" },
        { "id", "req_login" } };
    required["config"]["required"] = true;
    // Not a JSONPath (no leading `$`): compiled directly, past the validation
    // that would refuse it, so it errors on every response.
    auto broken = vayu::tests::extract_json_element_json ("el_broken", "token", "broken");
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ required, broken });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 2u) << summary.dump ();
    const auto& needed = elements[0];
    EXPECT_EQ (needed["id"], "el_needed");
    EXPECT_EQ (needed["name"], "Session id");
    EXPECT_EQ (needed["origin"]["id"], "req_login");
    EXPECT_EQ (needed["required"], true);
    EXPECT_EQ (needed["missing"], 2) << needed.dump ();
    EXPECT_EQ (needed["skipped"], 0) << needed.dump ();
    EXPECT_EQ (needed["failed"], 0) << needed.dump ();

    const auto& errored = elements[1];
    EXPECT_EQ (errored["id"], "el_broken");
    EXPECT_FALSE (errored.contains ("name"));
    EXPECT_FALSE (errored.contains ("origin"));
    EXPECT_FALSE (errored.contains ("required"));
    EXPECT_EQ (errored["error"], 2) << errored.dump ();
    EXPECT_EQ (errored["failed"], 0) << errored.dump ();
}

// Ids are unique within a level, not across one: a collection's element and
// the request's own can share one. Each keeps its own row, counts and label,
// told apart by its origin. Mutation check: match `ElementSlotIndex::find`
// (pipeline.cpp) by id alone and the two rows fold into one of 4 misses.
TEST_F (ScenarioLoadTest, ElementsSharingAnIdAcrossLevelsKeepTheirOwnRows) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto inherited = vayu::tests::extract_json_element_json ("el_1", "$.nope", "a");
    inherited["name"]   = "From the collection";
    inherited["origin"] = { { "kind", "collection" }, { "scope", "collection" },
        { "id", "col_1" } };
    auto own = vayu::tests::extract_json_element_json ("el_1", "$.nope", "b");
    own["name"] = "The request's own";
    own["origin"] = { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" } };
    own["config"]["required"] = true;
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ inherited, own });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 2u) << summary.dump ();
    EXPECT_EQ (elements[0]["name"], "From the collection");
    EXPECT_EQ (elements[0]["origin"]["id"], "col_1");
    EXPECT_FALSE (elements[0].contains ("required"));
    EXPECT_EQ (elements[0]["missing"], 2) << elements[0].dump ();
    EXPECT_EQ (elements[1]["name"], "The request's own");
    EXPECT_EQ (elements[1]["origin"]["id"], "req_1");
    EXPECT_EQ (elements[1]["required"], true);
    EXPECT_EQ (elements[1]["missing"], 2) << elements[1].dump ();
}

// A deferral is its own count (#2144): an un-inlined `script.post` is left to
// the post-run replay, so it runs - later - and must not read as a script
// that was never run. The two skips that are not deferrals stay `skipped`:
// an un-inlined `script.pre` has no replay to go to, and a disabled element
// is never offered to the deferral hook at all.
TEST_F (ScenarioLoadTest, AnUninlinedScriptPostTalliesDeferredNotSkipped) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    auto disabled  = vayu::tests::script_element_json (
    "el_disabled", "script.post", "pm.test('never', function () {});");
    disabled["enabled"]              = false;
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({
    vayu::tests::script_element_json ("el_post",
    "script.post", "pm.test('status', function () { pm.expect(pm.response.code).to.equal(200); });"),
    vayu::tests::script_element_json ("el_pre", "script.pre", "pm.variables.set('a', '1');"),
    disabled,
    });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements")) << summary.dump ();
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 3u) << summary.dump ();
    const auto row = [&elements] (const std::string& id) {
        for (const auto& entry : elements) {
            if (entry["id"] == id) {
                return entry;
            }
        }
        return json ();
    };

    EXPECT_EQ (row ("el_post")["deferred"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_post")["skipped"], 0) << summary.dump ();
    EXPECT_EQ (row ("el_pre")["skipped"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_pre")["deferred"], 0) << summary.dump ();
    EXPECT_EQ (row ("el_disabled")["skipped"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_disabled")["deferred"], 0) << summary.dump ();
}

// Every un-inlined, enabled `script.post` of a step is replayed, the way a
// single-request run joins them, so the `deferred` tally and the replay count
// the same elements (#2167). A disabled one never runs.
TEST_F (ScenarioLoadTest, EveryUninlinedScriptPostOfAStepIsReplayedAndADisabledOneIsNot) {
    ScenarioMockServer server;
    auto execution      = plan_over ({ server.url ("/echo") });
    auto disabled       = vayu::tests::script_element_json ("el_disabled",
    "script.post", "pm.test('never', function () { throw new Error('x'); });");
    disabled["enabled"] = false;
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({
    vayu::tests::script_element_json ("el_a",
    "script.post", "pm.test('a', function () { pm.expect(pm.response.code).to.equal(200); });"),
    disabled,
    vayu::tests::script_element_json ("el_b",
    "script.post", "pm.test('b', function () { pm.expect(pm.response.code).to.equal(200); });"),
    });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& step = validation.steps[0];
    ASSERT_HAS_VALUE (step);
    EXPECT_EQ (step->failed, 0u) << "the disabled script ran";
    EXPECT_EQ (step->passed, 4u)
    << "both enabled scripts must replay on each of the 2 samples";
}

// ============================================================================
// The exact assertion population (issues #1497, #2892): assert.* outcomes and
// an inline script's own pm.test calls, judged by maxAssertionFailureRatePct.
// ============================================================================

// Each assert.* outcome counts once: the counters already hold it, so adding
// the element tallies on top (the shape before #2892) doubled it. Mutation
// check: double the passed counter in `exact_assertion_totals` and passed
// reads 6.
TEST_F (ScenarioLoadTest, ExactAssertionTotalsCountEachAssertOutcomeOnce) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_status" }, { "kind", "assert.status" }, { "enabled", true },
      { "config", { { "in", json::array ({ 200 }) } } } },
    // A non-required extractor beside it adds no test result, so it must
    // not inflate the count.
    vayu::tests::extract_json_element_json ("el_extract", "$.ok", "ok") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 3u);
    EXPECT_EQ (totals.failed, 0u);
}

TEST_F (ScenarioLoadTest, AFailingAssertStatusElementCountsAsAFailedAssertion) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_status" }, { "kind", "assert.status" }, { "enabled", true },
    { "config", { { "in", json::array ({ 404 }) } } } } }); // /echo answers 200

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 0u);
    EXPECT_EQ (totals.failed, 2u);
}

// A 200 whose body is not JSON is a failed assertion, not a skipped one, and a
// required extractor fails too (#3041). Mutation check: restore the `skipped`
// branch in `AssertJsonPathElement` and `failed` reads 0 (the extractor's
// failure alone then leaves it at 3).
TEST_F (ScenarioLoadTest, AnUnreadableBodyCountsAsAFailedAssertion) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/html") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_assert" }, { "kind", "assert.jsonpath" }, { "enabled", true },
      { "config", { { "path", "$.ok" }, { "exists", true } } } },
    { { "id", "el_extract" }, { "kind", "extract.json" }, { "enabled", true },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "required", true } } } } });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 0u);
    EXPECT_EQ (totals.failed, 6u);
}

// The gap this issue closes: `script_kinds.cpp`'s `apply` reports the
// element's own outcome as "did the script throw", never whether its
// `pm.test` calls passed - so before this, a failing inline assertion was
// invisible at run level. Mutation check: remove the `pre_result.tests` /
// `post_result.tests` loops in `scenario_load.cpp`'s `run_step_before` /
// `run_step_after` and both counters here stay zero.
TEST_F (ScenarioLoadTest, AnInlineScriptsPmTestCallsAreTalliedSeparatelyFromItsElementOutcome) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.test('passes', function () { pm.expect(1).to.equal(1); });"
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    // `ScriptResult::success` already folds a failed `pm.test` into "did the
    // script run cleanly" (`script_engine.cpp`'s post-eval loop over
    // `result.tests`), so `StepElementTallies` - a single pass/fail bit per
    // script *run* - already marks this element failed; that part predates
    // this issue. What did not exist before this PR is the assertion-level
    // count behind that one bit: one `pm.test` call passed and one failed,
    // and only `inline_tests_passed`/`_failed` can tell the two apart
    // from a run where *both* calls failed - the element tally reads
    // identically either way.
    EXPECT_EQ (state->inline_tests_passed.load (), 1u);
    EXPECT_EQ (state->inline_tests_failed.load (), 1u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements"));
    EXPECT_EQ (summary["steps"][0]["elements"][0]["passed"], 0);
    EXPECT_EQ (summary["steps"][0]["elements"][0]["failed"], 1);
}

// #2820: the exact population reaches the report, beside the HTTP figures it is
// not folded into. The second step asserts text no `/echo` body holds, so each
// iteration fails it once while every response is a 200. Mutation check: drop
// the `assertions` write in `collect_summary_inputs` and the key is missing.
TEST_F (ScenarioLoadTest, AFailingAssertContainsReachesTheReportsScenarioAssertions) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_contains" }, { "kind", "assert.contains" }, { "enabled", true },
    { "config", { { "field", "body" }, { "text", "never in the body" } } } } });

    constexpr size_t ITERATIONS = 4;
    const json report           = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const json& scenario = report.at ("scenario");
    EXPECT_EQ (scenario.value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << scenario.dump ();
    EXPECT_DOUBLE_EQ (report.at ("summary").at ("errorRate").get<double> (), 0.0);
    // The step outcomes count executions (#2824): each iteration's second
    // step failed an assertion, though every response was a 200.
    EXPECT_EQ (scenario.at ("passed").get<size_t> (), ITERATIONS) << scenario.dump ();
    EXPECT_EQ (scenario.at ("failed").get<size_t> (), ITERATIONS) << scenario.dump ();
}

// #3043: an assertion that cannot run fails its step under load and is in the
// exact population, beside the element tally that already booked it failed.
// Mutation check: put the bare `outcome_status = "error"` back in
// `AssertJsonPathElement::apply` and `assertions` is absent, the steps passed.
TEST_F (ScenarioLoadTest, AnAssertionThatCannotRunFailsItsStepAndIsCounted) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_jsonpath" }, { "kind", "assert.jsonpath" },
    { "enabled", true }, { "config", { { "path", "$.method" } } } } });

    constexpr size_t ITERATIONS = 3;
    const json report           = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const json& scenario = report.at ("scenario");
    EXPECT_EQ (scenario.value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << scenario.dump ();
    EXPECT_EQ (scenario.at ("passed").get<size_t> (), ITERATIONS) << scenario.dump ();
    EXPECT_EQ (scenario.at ("failed").get<size_t> (), ITERATIONS) << scenario.dump ();
}

// An inline script's `pm.test` is in the exact population; an un-inlined one is
// the deferred replay's, reported under `testValidation` and kept out of it.
// Mutation check: add `validation.run` to the figure in `collect_summary_inputs`
// and `failed` reads 6.
TEST_F (ScenarioLoadTest, ScenarioAssertionsCountAnInlinePmTestAndNotADeferredOne) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    const std::string failing =
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_inline", "script.post", failing,
    /*inline_script=*/true) });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_deferred", "script.post", failing) });

    constexpr size_t ITERATIONS = 3;
    const json report =
    run_to_report (json{ { "mode", "iterations" }, { "iterations", ITERATIONS },
                   { "concurrency", 1 }, { "response_sample_rate", 1 } },
    execution);
    EXPECT_EQ (report.at ("scenario").value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << report.at ("scenario").dump ();
    ASSERT_TRUE (report.contains ("testValidation"))
    << "the deferred replay never ran";
    EXPECT_GT (report["testValidation"].value ("testsFailed", 0), 0)
    << report["testValidation"].dump ();
}

// A run that asserted nothing has no figure, never `{0, 0}`. Mutation check:
// drop the `total () > 0` guard in `collect_summary_inputs` and the key appears.
TEST_F (ScenarioLoadTest, AScenarioRunThatAssertedNothingHasNoScenarioAssertions) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });

    const json report = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    ASSERT_TRUE (report.contains ("scenario")) << report.dump ();
    EXPECT_FALSE (report.at ("scenario").contains ("assertions"))
    << report.at ("scenario").dump ();
}

// ============================================================================
// Data rows in load mode (issue #449)
// ============================================================================

// The cursor is shared across the whole run and wraps: 5 iterations over a
// 3-row set bind 0,1,2,0,1. One VU, so the recorded order is the claim order.
TEST_F (ScenarioLoadTest, TheSharedRowCursorWrapsWhenTheRowsRunOut) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution,
    { json{ { "id", "0" } }, json{ { "id", "1" } }, json{ { "id", "2" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> paths;
    for (const auto& hit : server.hits ()) {
        paths.push_back (hit.path);
    }
    EXPECT_EQ (paths,
    (std::vector<std::string>{ "/row/0", "/row/1", "/row/2", "/row/0", "/row/1" }));
}

// Two virtual users running concurrently bind *different* rows. Make the cursor
// per-VU and this fails - which is the whole reason it is one run-wide counter:
// two users of a credentials file must not both be user 0.
TEST_F (ScenarioLoadTest, ConcurrentVirtualUsersBindDifferentRows) {
    // The rendezvous holds both VUs inside step 0 at once, so "concurrently" is
    // an assertion rather than a race the test hopes to win.
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_NE (rows[0], rows[1])
    << "both virtual users bound the same row - the row cursor is per-VU "
       "rather than shared across the run";
}

// The other side of the claim, and the one the api-reference sentence used to
// deny: with fewer rows than concurrent virtual users the cursor wraps while
// both are live, so they bind the *same* row at the same time. Exclusivity
// holds only while unclaimed rows remain.
TEST_F (ScenarioLoadTest, FewerRowsThanVirtualUsersMeansConcurrentUsersShareARow) {
    // Same rendezvous as the test above, for the same reason: it holds both VUs
    // inside step 0 at once, so "at the same time" is asserted rather than
    // hoped for.
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (rows, (std::vector<std::string>{ "/row/0", "/row/0" }))
    << "the single row was not reused - a wrapping cursor is what makes a run "
       "longer than its data set possible at all";
}

// Every step of one iteration binds the same row: a checkout that used a
// different row than its login is not a user.
TEST_F (ScenarioLoadTest, EveryStepOfAnIterationBindsTheSameRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}"),
    server.url ("/row/{{data.id}}"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> paths;
    for (const auto& hit : server.hits ()) {
        paths.push_back (hit.path);
    }
    EXPECT_EQ (paths,
    (std::vector<std::string>{ "/row/0", "/row/0", "/row/0", "/row/1", "/row/1", "/row/1" }));
}

// The zero-cost claim, where the executor reads it: a step with no data token
// carries an empty template, which is what it tests before joining anything.
TEST_F (ScenarioLoadTest, AStepWithoutADataTokenCarriesNoTemplate) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } } });

    EXPECT_TRUE (execution.plan.steps[0].data_template.empty ())
    << "a step with no {{data.*}} token must do no per-iteration join work";
    EXPECT_FALSE (execution.plan.steps[1].data_template.empty ());

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 1u)
    << "the untemplated step was still sent unchanged";
}

// A credentials file, end to end and read off the wire: every virtual user
// sends its *own* row's credentials, base64-encoded after the bind rather than
// around it. Before this, the header on every one of these was
// base64("{{data.user}}:{{data.pass}}") - a literal token nobody ever saw,
// because the encoding hid it (issue #591).
TEST_F (ScenarioLoadTest, ACredentialsFileBindsPerIterationOnTheWire) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_data (execution,
    { json{ { "user", "alice" }, { "pass", "pw0" } },
    json{ { "user", "bob" }, { "pass", "pw1" } } });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "{{data.user}}" },
    { "password", "{{data.pass}}" } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> sent;
    for (const auto& hit : server.hits_for ("/echo")) {
        sent.push_back (hit.authorization);
    }
    EXPECT_EQ (sent,
    (std::vector<std::string>{ "Basic " + vayu::utils::base64_encode ("alice:pw0"),
    "Basic " + vayu::utils::base64_encode ("bob:pw1") }));
}

// The same bind on a collection run that carries **no data set at all** (issue
// #1055). This is the run shape the old rule could not serve: deferral was
// keyed to the run having rows, so a step's `{{$vu}}` credential went out
// base64-encoded as written. Two virtual users, so the assertion is about each
// binding its *own* number rather than both binding `1` - which is what a bind
// that dropped the caller's identity would produce.
TEST_F (ScenarioLoadTest, AStepCredentialBindsTheIdentityWithNoDataSet) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "user-{{$vu}}" }, { "password", "pw" } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 }, { "vus", 2 } };
    run (config, execution);

    std::vector<std::string> sent;
    for (const auto& hit : server.hits_for ("/echo")) {
        sent.push_back (hit.authorization);
    }
    std::sort (sent.begin (), sent.end ());
    ASSERT_FALSE (sent.empty ()) << "no step reached the wire";
    for (const auto& authorization : sent) {
        EXPECT_NE (authorization.find ("Basic "), std::string::npos) << authorization;
    }
    // Every credential that left carries a bound number rather than the token
    // text, and the set of numbers is the set of users that sent.
    for (const auto& authorization : sent) {
        EXPECT_EQ (authorization.find ("{{$vu}}"), std::string::npos)
        << "the token text reached the wire base64-encoded as written: " << authorization;
    }
    EXPECT_TRUE (std::find (sent.begin (), sent.end (),
                 "Basic " + vayu::utils::base64_encode ("user-1:pw")) != sent.end ())
    << "virtual user 1 must authenticate as itself";
}

// The credential half of the failure path: a column the row does not carry ends
// the step before the send, exactly as one in the URL does - never a request
// with a blank password.
TEST_F (ScenarioLoadTest, AnAbsentColumnInACredentialErrorsTheStepInsteadOfSendingIt) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_data (execution, { json{ { "user", "alice" } } });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "{{data.user}}" },
    { "password", "{{data.missing}}" } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/echo").size (), 0u)
    << "a request whose credentials could not bind reached the wire";
    EXPECT_EQ (state->steps_errored.load (), 1u);
    EXPECT_EQ (context_->in_flight (), 0u);

    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.missing}}"), std::string::npos)
    << errors[0].error_message;
}

// Issue #2473 on the load path: a password an inline `script.pre` sets reaches
// every submission's basic pair, applied after the residual pass rather than
// encoded around the token when the plan resolved. Mutation check: drop
// `auth_after_scripts` from the resolution in `resolve_step`
// (scenario_plan.cpp) and the wire carries `user:{{password}}`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreSetsAPasswordThatReachesTheWireThroughLateAuth) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "basic" }, { "username", "user" }, { "password", "{{password}}" } },
    json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.environment.set('password', 's3cret');", /*inline_script=*/true) }));
    ASSERT_EQ (execution.plan.steps.size (), 1u);

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (vayu::tests::basic_pair_of (echo.authorization), "user:s3cret");
    }
}

// #3131 on a scenario load: an inline `script.pre` that assigns
// `pm.request.auth` replaces the step's own credential on every submission.
TEST_F (ScenarioLoadTest, AnInlineScriptPreAssignedAuthReplacesTheStepsOwn) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "bearer" }, { "token", "step-token" } },
    json::array ({ vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.request.auth = { type: 'basic', basic: { username: 'ada', password: 'pw' } };",
    /*inline_script=*/true) }));
    ASSERT_EQ (execution.plan.steps.size (), 1u);

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (vayu::tests::basic_pair_of (echo.authorization), "ada:pw");
    }
}

// The count-only rule (#1503) holds for a credential that waited: nothing
// answered it, so it is encoded as written and sent, never refused.
TEST_F (ScenarioLoadTest, ACredentialNothingAnswersIsSentAsWrittenThroughLateAuth) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "basic" }, { "username", "user" }, { "password", "{{password}}" } },
    json::array ());

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u) << "the step was refused rather than sent";
    EXPECT_EQ (vayu::tests::basic_pair_of (echoes[0].authorization), "user:{{password}}");
    EXPECT_EQ (state->steps_errored.load (), 0u);
}

// A token naming a column the bound row does not carry fails the step loudly:
// nothing goes on the wire, the step's own error count moves, and the run's
// error list carries the sentence that names the token, the row and the columns.
TEST_F (ScenarioLoadTest, AnAbsentColumnErrorsTheStepInsteadOfSendingIt) {
    ScenarioMockServer server;
    // The bad token sits in the middle, so "the iteration ended here" is
    // visible as the last step never being reached.
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/row/{{data.missing}}"), server.url ("/s2") });
    with_data (execution, { json{ { "id", "0" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 2u)
    << "the virtual user was stranded by a step that never reached the wire";
    EXPECT_EQ (server.hits_for ("/s2").size (), 0u);
    for (const auto& hit : server.hits ()) {
        EXPECT_NE (hit.path.rfind ("/row/", 0), 0u)
        << "a request with an unbound token reached the wire: " << hit.path;
    }

    EXPECT_EQ (state->steps.errors (1), 2u)
    << "the failure was not attributed to the step that could not bind";
    EXPECT_EQ (state->steps.completed (1), 2u);
    EXPECT_EQ (state->steps.latency_samples (1), 0u)
    << "a step that was never sent recorded a duration (#2384)";
    EXPECT_EQ (state->steps_errored.load (), 2u);
    EXPECT_EQ (state->iterations_abandoned.load (), 2u);
    EXPECT_EQ (context_->in_flight (), 0u)
    << "a step that was never sent left an in-flight slot leaked";

    // Loud: the message reaches the run's error store, naming what to fix.
    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.missing}}"), std::string::npos)
    << errors[0].error_message;
    EXPECT_NE (errors[0].error_message.find ("step1"), std::string::npos)
    << "the message does not name the step it failed on: " << errors[0].error_message;
}

// A quote-bearing cell used to put invalid JSON on the wire, silently, at the
// run's full rate (issue #593). Asserted off the wire because that is where the
// corruption was: the bind, the build and the wire encoding all have to agree.
TEST_F (ScenarioLoadTest, AQuoteBearingCellReachesTheWireAsValidJson) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method    = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content = R"({"who":"u","note":"{{data.note}}"})";
    with_data (execution, { json{ { "note", R"(has,comma "quoted")" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto hits = server.hits_for ("/body");
    ASSERT_EQ (hits.size (), 1u);
    const auto sent = json::parse (hits[0].body, nullptr, false);
    ASSERT_FALSE (sent.is_discarded ())
    << "a bound body reached the wire unparseable: " << hits[0].body;
    EXPECT_EQ (sent.at ("note").get<std::string> (), R"(has,comma "quoted")");
}

// Issue #995, on the scenario path and across virtual users: every send
// generates its own value, so an id shared between two virtual users' iterations
// - or between two iterations of one - shows up here as a short set rather than
// as eight distinct paths.
//
// What this does *not* test is a data race, and the distinction is worth
// keeping: a run binds on its own driver thread, which is the event loop's sole
// producer, so the generators run there rather than on the transfer workers.
// Two runs at once are two driver threads, and what makes that safe is the
// `thread_local` engine `request_composer.cpp`'s table has always drawn from -
// unchanged here, and already load-bearing for concurrent `POST /compose`.
TEST_F (ScenarioLoadTest, EveryIterationOfEveryUserGeneratesItsOwnValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{$randomUUID}}") });
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 8 },
        { "concurrency", 4 } };
    run (config, execution);

    const auto hits = server.hits ();
    ASSERT_EQ (hits.size (), 8u);
    std::set<std::string> distinct;
    for (const auto& hit : hits) {
        EXPECT_NE (hit.path, "/row/{{$randomUUID}}")
        << "the token reached the wire as it stands";
        distinct.insert (hit.path);
    }
    EXPECT_EQ (distinct.size (), hits.size ())
    << "two sends carried the same generated id";
}

// A generated value is written for the document it lands in, exactly as a
// cell is: inside a JSON string literal it is escaped, so the body stays
// parseable whatever the table produced.
TEST_F (ScenarioLoadTest, AGeneratedValueBindsIntoAJsonBodyAsAStringsContent) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method    = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content =
    R"({"who":"u","id":"{{$guid}}","note":"{{$randomLoremSentence}}"})";
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto hits = server.hits_for ("/body");
    ASSERT_EQ (hits.size (), 1u);
    const auto sent = json::parse (hits[0].body, nullptr, false);
    ASSERT_FALSE (sent.is_discarded ())
    << "a bound body reached the wire unparseable: " << hits[0].body;
    EXPECT_NE (sent.at ("id").get<std::string> (), "{{$guid}}");
    EXPECT_FALSE (sent.at ("note").get<std::string> ().empty ());
}

// A null cell is refused under load the same way a missing column is: nothing
// is sent, and the run's error store carries the sentence that names it.
TEST_F (ScenarioLoadTest, ANullCellErrorsTheStepInsteadOfErasingTheValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method       = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode    = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content = R"({"n":{{data.n}}})";
    with_data (execution, { json{ { "n", nullptr } } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (server.hits_for ("/body").empty ())
    << "a body with an erased value reached the wire";
    EXPECT_EQ (state->steps_errored.load (), 1u);

    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.n}}"), std::string::npos)
    << errors[0].error_message;
    EXPECT_NE (errors[0].error_message.find ("null"), std::string::npos)
    << errors[0].error_message;
}

// A recorded result carries the row it was bound to, so a failure under load is
// attributable to a row rather than only to a step.
TEST_F (ScenarioLoadTest, ARecordedResultCarriesItsDataRowIndex) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    // Every completion retained as a sampled trace, so the assertion is about
    // what a record carries rather than about which budget claimed it.
    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "save_timing_breakdown", true },
        { "success_sample_rate", 1 }, { "slow_threshold_ms", 0 } };
    run (config, execution);

    const auto results = context_->metrics_collector->success_results ();
    ASSERT_FALSE (results.empty ());
    std::vector<int> rows;
    for (const auto& result : results) {
        const auto trace = json::parse (result.trace_data, nullptr, false);
        ASSERT_FALSE (trace.is_discarded ()) << result.trace_data;
        ASSERT_TRUE (trace.contains ("dataRowIndex"))
        << "a sampled load result carries no row: " << result.trace_data;
        rows.push_back (trace["dataRowIndex"].get<int> ());
    }
    std::sort (rows.begin (), rows.end ());
    EXPECT_EQ (rows, (std::vector<int>{ 0, 1 }));
}

// A run sent without `data` carries no row at all - the record must not gain a
// zero that reads like row 0.
TEST_F (ScenarioLoadTest, ARunWithoutRowsRecordsNoDataRowIndex) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "save_timing_breakdown", true },
        { "success_sample_rate", 1 }, { "slow_threshold_ms", 0 } };
    run (config, execution);

    const auto results = context_->metrics_collector->success_results ();
    ASSERT_FALSE (results.empty ());
    for (const auto& result : results) {
        const auto trace = json::parse (result.trace_data, nullptr, false);
        ASSERT_FALSE (trace.is_discarded ());
        EXPECT_FALSE (trace.contains ("dataRowIndex")) << result.trace_data;
    }
}

// `concurrency` is the number of virtual users, and in-flight is bounded by it
// by construction - which is why maxInFlight is moot for a scenario run.
TEST_F (ScenarioLoadTest, ConcurrencyIsTheVirtualUserCountAndBoundsInFlight) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const size_t VUS  = 8;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "1s" }, { "concurrency", VUS } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->vus.size (), VUS);
    EXPECT_LE (context_->peak_in_flight.load (), VUS)
    << "in-flight exceeded the virtual-user count, so a VU sent two steps at "
       "once";
    EXPECT_GT (state->steps_executed.load (), 0u);
}

// #2913: the scenario controller shares the ramp, so a ramp as long as the run
// reaches its last virtual user at the end rather than stopping one short.
// `/hang` answers nothing while the run lasts, so no virtual user finishes a
// step and the peak is what the controller started, with no completion to race
// it. The final refill (`MaintainConcurrency` in load_strategy_test.cpp) is
// what holds this when no wake lands in the ramp's last tick. Driven here
// rather than through `run`, whose drain would wait out every held transfer.
TEST_F (ScenarioLoadTest, ARampAsLongAsTheRunPeaksAtTheConfiguredUserCount) {
    vayu::tests::SlowMockServer upstream;
    const auto execution = plan_over ({ upstream.hang_url () });

    const size_t VUS  = 8;
    const json config = { { "mode", "ramp_up" }, { "duration", "1s" },
        { "rampUpDuration", "1s" }, { "startConcurrency", 1 }, { "concurrency", VUS } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-ramp-end", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    auto base_scopes = vayu::http::routes::load_script_variable_scopes (
    *db_, std::nullopt, context->scenario->request.collection_id);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    context->event_loop->stop (false);

    EXPECT_EQ (state->vus.size (), VUS);
    EXPECT_EQ (context->peak_in_flight.load (), VUS);
}

// #2821: a virtual user in a think wait has nothing on the wire, so the run's
// mean in flight is its share of time spent sending: two 20 ms steps around a
// 200 ms think is about 0.17 of each user, under 2 of 10 here, and 10 if the
// think wait were counted. Mutation check: divide the latency sum by the
// completion count in `MetricsCollector::average_in_flight` and this reads the
// mean latency, about 20. The 1 Hz peak sample is the instantaneous gauge this
// mean replaces, so it is only bounded here, not pinned (#2397 item 3).
TEST_F (ScenarioLoadTest, AThinkTimeRunsMeanInFlightIsItsShareOfTimeOnTheWire) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/slow"), server.url ("/slow") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_think" }, { "kind", "timer.think" },
    { "enabled", true }, { "config", { { "ms", 200 } } } } });

    const size_t VUS = 10;
    const json report = run_to_report (json{ { "mode", "constant_concurrency" },
                                       { "duration", "1s" }, { "concurrency", VUS } },
    execution);
    const json& summary = report.at ("summary");
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    EXPECT_EQ (report.at ("scenario").at ("virtualUsers").get<size_t> (), VUS)
    << report.at ("scenario").dump ();
    const double avg_in_flight = summary.at ("avgInFlight").get<double> ();
    EXPECT_GT (avg_in_flight, 0.0);
    // A virtual user is on the wire for its two requests and idle for the
    // 200 ms think, so its share of time in flight is L / (L + 200) with L the
    // report's own mean latency over two requests. The bound follows the
    // runner's measured latency (a slow leg raises both sides) and sits far
    // below the user count, which a mean that counted the think waits would
    // read.
    constexpr double THINK_MS = 200.0;
    const double wire_ms = 2.0 * report.at ("latency").at ("avg").get<double> ();
    const double bound =
    ((static_cast<double> (VUS) * wire_ms / (wire_ms + THINK_MS)) * 1.5) + 0.5;
    EXPECT_LT (avg_in_flight, bound)
    << "the run's mean in flight counted the virtual users' think waits: "
    << summary.dump ();
    EXPECT_LE (summary.at ("peakConcurrency").get<size_t> (), VUS);
}

// With no think time every virtual user has a request in flight almost all the
// time, so the mean is about the user count: the sanity check of the
// definition. The bound is wide because the gap between one completion and the
// next submission is the runner's, and it never exceeds the count.
TEST_F (ScenarioLoadTest, ANoThinkTimeRunsMeanInFlightIsAboutItsUserCount) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/slow"), server.url ("/slow") });

    const size_t VUS = 10;
    const json report = run_to_report (json{ { "mode", "constant_concurrency" },
                                       { "duration", "1s" }, { "concurrency", VUS } },
    execution);
    const json& summary = report.at ("summary");
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    const double avg_in_flight = summary.at ("avgInFlight").get<double> ();
    EXPECT_GT (avg_in_flight, static_cast<double> (VUS) / 2.0) << summary.dump ();
    EXPECT_LE (avg_in_flight, static_cast<double> (VUS) + 1e-6) << summary.dump ();
}

// ============================================================================
// Cross-VU shared pacing (issue #1570)
// ============================================================================

// `timer.pacing(perUser: false)` holds one cadence across every virtual
// user, not one cadence per user (which `perUser: true` already gave under
// load). Every VU's own first entry is unthrottled (the element has no
// history yet), so ten VUs produce an initial burst of about ten
// completions; every entry after that claims the next slot of the same
// shared 200ms clock, however many VUs are contending for it. Over a 2s run
// that is roughly ten (the burst) plus one more per 200ms tick - nowhere
// near the ~110 ten *independently* paced 200ms cadences would produce in
// the same window (each doing its own burst-of-one plus about nine ticks).
//
// Mutation check: making `TimerPacingElement::scheduled_ready_delay_ms`
// ignore `per_user_` and always take the per-VU `pacing_state` branch
// reproduces that old per-VU rate here too - completions clear 50 - and
// this test reds.
TEST_F (ScenarioLoadTest, SharedPacingHoldsOneCadenceAcrossEveryVirtualUser) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::timer_pacing_element_json (
    "el_pacing", /*every_ms=*/200, /*scope_entry=*/true, /*per_user=*/false) });

    const size_t VUS  = 10;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "2s" }, { "concurrency", VUS } };
    auto state        = run (config, execution);

    const size_t completed = state->steps.completed (0);
    EXPECT_GE (completed, VUS) << "not even the unthrottled first-entry burst "
                                  "completed - the shared clock is holding "
                                  "back requests it never saw before";
    EXPECT_LT (completed, 50u)
    << "completed " << completed
    << " over 2s at a shared 200ms cadence - "
       "looks like every virtual user paced itself independently instead "
       "of sharing one clock (ten independent 200ms cadences would clear "
       "100 in this window)";
}

// ============================================================================
// Deferred schema validation over the sampled responses (issue #682)
// ============================================================================

namespace {

/// The stored `response_schemas` text for a plan whose steps are bound to
/// `step<i>` operations, each declaring one 200 response.
///
/// Built through the wire shape rather than a hand-made index so a change to
/// what the app stores fails here rather than passing against a private fixture.
std::string schema_index_for (const std::vector<json>& schemas) {
    json operations = json::array ();
    for (size_t i = 0; i < schemas.size (); ++i) {
        operations.push_back (json{ { "operationId", "step" + std::to_string (i) },
        { "method", "GET" }, { "path", "/s" + std::to_string (i) },
        { "responses",
        json::array ({ json{ { "status", "200" },
        { "contentType", "application/json" }, { "schema", schemas[i] } } }) } });
    }
    return json{ { "refRoots", json::object () }, { "operations", operations } }.dump ();
}

/// Bind every step of @p execution to the operation of the same index, and give
/// the run the index those operations are declared in.
void bind_to_schemas (vayu::core::ScenarioExecution& execution,
const std::vector<json>& schemas) {
    execution.spec.spec_id          = "spec_1";
    execution.spec.spec_hash        = "hash_1";
    execution.spec.response_schemas = schema_index_for (schemas);
    for (size_t i = 0; i < execution.plan.steps.size (); ++i) {
        execution.plan.steps[i].spec_operation = json{
            { "operationId", "step" + std::to_string (i) }, { "method", "GET" },
            { "path", "/s" + std::to_string (i) }
        }.dump ();
    }
}

/// The mock answers every step with `{}`, so this passes and `strict_schema`
/// does not - which is what lets one run produce both verdicts.
json open_schema () {
    return json{ { "type", "object" } };
}

json strict_schema () {
    return json{ { "type", "object" }, { "required", json::array ({ "id" }) } };
}

} // namespace

// A step bound to an operation is sampled even when it carries no script - the
// contract is the second reason to keep a response, and without it a bound
// collection that asserts nothing would validate nothing at all.
//
// Mutation-check: restore the scripted-only condition in `execute_scenario_load`
// and both stores are empty, so every assertion below reddens.
TEST_F (ScenarioLoadTest, ABoundStepIsSampledWithNoScriptOfItsOwn) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_GT (mc.step_response_samples (0).size (), 0u)
    << "a step bound to an operation was never sampled, so its contract can "
       "never be checked";
    EXPECT_GT (mc.step_response_samples (1).size (), 0u);
}

// The run's own binding decides it: a plan whose steps name no operation is
// sampled exactly as it was before this existed, so an unbound collection pays
// nothing for a feature it cannot use.
TEST_F (ScenarioLoadTest, AnUnboundPlanStillSamplesOnlyItsScriptedSteps) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_GT (mc.step_response_samples (0).size (), 0u);
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u)
    << "an unbound step with no script was sampled - a body-sized copy nothing "
       "will read";
}

TEST_F (ScenarioLoadTest, ABoundRunReportsTalliesOverItsSampledResponses) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    // One operation the mock's `{}` satisfies and one it does not, so a single
    // run produces both verdicts and the partition is observable.
    bind_to_schemas (execution, { open_schema (), strict_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);

    EXPECT_EQ (totals.sampled, 6u);
    EXPECT_EQ (totals.checked, 6u);
    EXPECT_EQ (totals.valid, 3u);
    EXPECT_EQ (totals.failed, 3u);
    ASSERT_FALSE (totals.failure_examples.empty ());
    EXPECT_EQ (totals.failure_examples.front ().step, "step1")
    << "the failing step must be named, or a reader cannot act on the example";
    EXPECT_EQ (totals.failure_examples.front ().status, 200);
}

// The gate the whole block turns on: a run of an unbound collection is not a
// run that passed its contract.
//
// Mutation-check: drop the `response_schemas.empty()` guard in
// `validate_sampled_responses` and this reports a block of zeros instead.
TEST_F (ScenarioLoadTest, AnUnboundRunValidatesNothingAtAll) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_EQ (totals.sampled, 0u);
    EXPECT_TRUE (vayu::core::build_sampled_validation_payload (totals).empty ())
    << "an unbound run must carry no block at all, never one saying nothing "
       "failed";
}

// A binding whose document carries no schema index is "not measured" too - the
// same spelling coverage gives a document stored before its index existed.
TEST_F (ScenarioLoadTest, ABindingWithNoSchemaIndexValidatesNothing) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    bind_to_schemas (execution, { open_schema () });
    execution.spec.response_schemas.clear ();

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    EXPECT_EQ (vayu::core::validate_sampled_responses (context_).sampled, 0u);
}

// A step the document does not declare is checked and named, rather than
// silently dropped: a collection drifting off its contract is exactly what the
// block is read for.
TEST_F (ScenarioLoadTest, AStepTheDocumentDoesNotDeclareIsCountedByReason) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });
    // The second step's identity moved off the contract.
    execution.plan.steps[1].spec_operation =
    json{ { "method", "GET" }, { "path", "/ghosts" } }.dump ();

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_EQ (totals.checked, 2u);
    EXPECT_EQ (totals.failed, 0u)
    << "an undeclared operation is not a response that broke its contract";
    EXPECT_EQ (totals.unchecked_reasons.at ("operation_not_declared"), 2u);
}

// The thinning is disclosed rather than hidden: a run whose reservoirs dropped
// candidates reports tallies over what it kept, and the retention counter says
// what it did not.
TEST_F (ScenarioLoadTest, ARunWhoseSamplesWereThinnedStillReportsHonestly) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 8 },
        { "concurrency", 1 }, { "max_response_samples", 4 },
        { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_GT (totals.sampled, 0u);
    EXPECT_LE (totals.sampled, 4u)
    << "the pass validated more than the reservoirs could hold";
    EXPECT_LT (totals.sampled, 16u)
    << "16 completions into a 4-sample budget must have been thinned";
    EXPECT_GT (context_->metrics_collector->response_samples_dropped (), 0u)
    << "what was thinned must be reported, or the tallies read as the whole "
       "run";
}
