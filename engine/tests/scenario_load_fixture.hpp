#pragma once

/**
 * @file scenario_load_fixture.hpp
 * @brief The `ScenarioLoadTest` fixture and the mock server it drives, shared by every
 *        `scenario_load*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=ScenarioLoadTest.*`, the scratch-database RESOURCE_LOCK list and the ctest
 * regexes see it whole. The class is defined here, once, outside an anonymous namespace, so
 * each translation unit sees the same type; gtest refuses a suite whose `TEST_F`s name
 * different fixture classes, which an anonymous namespace per file would be.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>

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
#include "vayu/http/sse_stream.hpp"
#include "wait_until.hpp"

namespace vayu::tests::scenario_load {

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
    /// The events `/sse-three` sends before it closes.
    static constexpr int STREAM_EVENTS = 3;

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

        // Cookies libcurl's engine drops (#3307): two past the 50 one
        // response may set, and one too long to store.
        svr.Get ("/many-cookies",
        [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/many-cookies");
            for (int i = 0; i < 52; ++i) {
                res.set_header ("Set-Cookie",
                "c" + std::to_string (i) + "=secret-" + std::to_string (i));
            }
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/huge-cookie", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/huge-cookie");
            res.set_header ("Set-Cookie", "huge=" + std::string (5000, 'v'));
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

        // A short event stream that closes on its own (#3769): STREAM_EVENTS
        // frames written at once, so no cap has to end it.
        svr.Get ("/sse-three", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/sse-three");
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body =
                "data: one\n\ndata: two\n\ndata: three\n\n";
                if (!sink.write (body.data (), body.size ())) {
                    return false;
                }
                sink.done ();
                return true;
            });
        });

        // A completion stream's shape (#3780): usage in the first and the
        // last data event, the last one final, then `[DONE]`.
        svr.Get ("/sse-usage", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/sse-usage");
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body =
                "data: {\"usage\": {\"completion_tokens\": 1}}\n\n"
                "data: {\"delta\": \"hi\"}\n\n"
                "data: {\"usage\": {\"completion_tokens\": 30}}\n\n"
                "data: [DONE]\n\n";
                if (!sink.write (body.data (), body.size ())) {
                    return false;
                }
                sink.done ();
                return true;
            });
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

inline constexpr const char* TEST_DB_PATH = "test_scenario_load.db";

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

        auto base_scopes =
        vayu::core::scenario_load_scopes (*db_, environment_id, *context->scenario);
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

/// Both identities a load summary's outcomes answer to (#2824): the four
/// outcomes sum to `steps_executed`, and so do the steps' `executed` plus
/// `skipped`.
inline void expect_load_outcome_identities (const json& summary) {
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

inline json one_inline_script (const char* kind, const std::string& script) {
    return vayu::tests::script_element_json ("el_script", kind, script, /*inline_script=*/true);
}

} // namespace vayu::tests::scenario_load
