#pragma once

/**
 * @file scenario_runner_fixture.hpp
 * @brief The `ScenarioRunnerTest` fixture and the mock server it drives, shared by every
 *        `scenario_runner*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=ScenarioRunnerTest.*`, the scratch-database RESOURCE_LOCK list and the ctest
 * regexes see it whole. The class is defined here, once, outside an anonymous namespace, so
 * each translation unit sees the same type; gtest refuses a suite whose `TEST_F`s name
 * different fixture classes, which an anonymous namespace per file would be.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

namespace vayu::tests::scenario_runner {

using nlohmann::json;
using vayu::core::ScenarioStepStore;
using vayu::core::StepOutcome;

/// One request the mock server saw, in the order it saw them.
struct SeenRequest {
    std::string path;
    /// Path *and* query string, which is where a `{{data.column}}` in a URL
    /// lands - `path` alone drops it.
    std::string target;
    std::string cookie;
    std::string marker; // the X-Marker header, which the tests' scripts set
    std::string body;   // the request body as received; "" for a GET
    /// The `Authorization` as received; "" when absent. Credentials bound from
    /// a data row are only correct once encoded, and the encoding is what used
    /// to hide the bug (issue #591), so they are asserted off the wire.
    std::string authorization;
};

/**
 * Endpoints a sequence needs: something that succeeds, something that hands out
 * a session, and something whose handler can look at the world mid-run (which
 * is how "persisted once, at run end" is asserted rather than assumed).
 */
class ScenarioMockServer {
    public:
    ScenarioMockServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (8);

        const auto record = [this] (const httplib::Request& req) {
            std::lock_guard<std::mutex> lock (mtx);
            seen.push_back ({ req.path, req.target,
            req.get_header_value ("Cookie"), req.get_header_value ("X-Marker"),
            req.body, req.get_header_value ("Authorization") });
        };

        svr.Get ("/ok", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/login", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_header ("Set-Cookie", "sid=session-1; Path=/");
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/observe",
        [this, record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            if (observer) {
                observer ();
            }
            res.set_content ("{}", "application/json");
        });
        // The body a step actually sent, which is where a `{{data.*}}` bound
        // into a JSON body has to be read (issue #593) - the plan's copy would
        // not show a downstream re-encoding.
        svr.Post ("/body", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/slow", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            std::this_thread::sleep_for (std::chrono::milliseconds (120));
            res.set_content ("{}", "application/json");
        });
        // A response that arrived with an error status, which no assertion
        // has to judge for the step's outcome to be decided.
        svr.Get ("/fail500", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.status = 500;
            res.set_content (R"({"error":"boom"})", "application/json");
        });
        // A body that satisfies the pet schema the schema-verdict tests declare,
        // and one that does not - the `id` is a string where the contract says
        // integer, which is the ordinary shape of a contract drift.
        svr.Get ("/pet", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"id":7,"name":"Rex"})", "application/json");
        });
        svr.Get ("/pet-wrong", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"id":"seven","name":"Rex"})", "application/json");
        });
        // Issue #1514's phase-0 kinds: a token to extract, and an endpoint that
        // echoes the `Authorization` header back so a step can prove it saw the
        // token the previous step extracted.
        svr.Get ("/token", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"token":"secret-abc"})", "application/json");
        });
        // A new token per login, across runs too, so a later step can prove it
        // sent this login's token rather than the one an earlier run stored.
        svr.Get ("/login-n",
        [this, record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"token":"tok-)" + std::to_string (++logins) + "\"}",
            "application/json");
        });
        // A 200 that is a page, not the JSON a step's assertions were
        // written against (#3041): what a gateway answers during an outage.
        svr.Get ("/html", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content ("<html><body>Service Unavailable</body></html>", "text/html");
        });
        svr.Get ("/echo-auth", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (
            R"({"authorization":")" + req.get_header_value ("Authorization") + "\"}",
            "application/json");
        });
        // Event streams for a stored streaming request (#3235): three events
        // over about 450 ms and a close, past any 200 ms step timeout; one
        // with an event always ready, which only a cap ends; and one that
        // answers and then says nothing until the fixture stops.
        svr.Get ("/sse-short", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                for (int event = 0; event < SHORT_STREAM_EVENTS; ++event) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (150));
                    const std::string frame = "data: tick\n\n";
                    if (!sink.write (frame.data (), frame.size ())) {
                        return false;
                    }
                }
                sink.done ();
                return true;
            });
        });
        // A model's reply as Anthropic-style deltas (#3773), with a ping
        // between them and a `[DONE]` the text path reads nothing from.
        svr.Get ("/sse-deltas",
        [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (std::string (DELTA_STREAM), "text/event-stream");
        });
        // An Anthropic-style stream (#3774): its preamble at once, its first
        // content PREAMBLE_CONTENT_DELAY_MS later.
        svr.Get ("/sse-preamble",
        [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string preamble =
                "event: message_start\ndata: {}\n\n";
                if (!sink.write (preamble.data (), preamble.size ())) {
                    return false;
                }
                std::this_thread::sleep_for (
                std::chrono::milliseconds (PREAMBLE_CONTENT_DELAY_MS));
                const std::string content =
                "event: content_block_delta\ndata: {}\n\n";
                if (!sink.write (content.data (), content.size ())) {
                    return false;
                }
                sink.done ();
                return true;
            });
        });
        svr.Get ("/sse-endless",
        [this, record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                while (!stopping.load ()) {
                    const std::string frame = "data: tick\n\n";
                    if (!sink.write (frame.data (), frame.size ())) {
                        return false;
                    }
                    std::this_thread::sleep_for (std::chrono::milliseconds (5));
                }
                sink.done ();
                return true;
            });
        });
        svr.Get ("/sse-silent",
        [this, record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                const std::string keep_alive = ": open\n\n";
                sink.write (keep_alive.data (), keep_alive.size ());
                while (!stopping.load ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (10));
                }
                sink.done ();
                return true;
            });
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~ScenarioMockServer () {
        stopping.store (true);
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    ScenarioMockServer (const ScenarioMockServer&)            = delete;
    ScenarioMockServer& operator= (const ScenarioMockServer&) = delete;
    ScenarioMockServer (ScenarioMockServer&&)                 = delete;
    ScenarioMockServer& operator= (ScenarioMockServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    [[nodiscard]] std::vector<SeenRequest> requests () const {
        std::lock_guard<std::mutex> lock (mtx);
        return seen;
    }

    /// Called on the server thread while the run is in flight.
    std::function<void ()> observer;

    /// The events `/sse-short` sends before it closes.
    static constexpr int SHORT_STREAM_EVENTS = 3;
    /// How long `/sse-preamble` holds its content behind its preamble.
    static constexpr int PREAMBLE_CONTENT_DELAY_MS = 300;
    /// What `/sse-deltas` sends: two text deltas around a ping, then `[DONE]`.
    static constexpr std::string_view DELTA_STREAM =
    "data: {\"delta\":{\"text\":\"Hel\"}}\n\n"
    "data: {\"type\":\"ping\"}\n\n"
    "data: {\"delta\":{\"text\":\"lo\"}}\n\n"
    "data: [DONE]\n\n";

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mtx;
    std::vector<SeenRequest> seen;
    std::atomic<int> logins{ 0 };
    /// Ends the streams that only a client or the fixture ends.
    std::atomic<bool> stopping{ false };
};

class ScenarioRunnerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scenario_runner.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<ScenarioMockServer> ();
    }
    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection (const std::string& id, const std::string& variables = "") {
        vayu::db::Collection col;
        col.id         = id;
        col.name       = "Collection " + id;
        col.variables  = variables;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// A collection carrying its own @p elements, under @p parent_id when one
    /// is given - a folder, whose elements every request under it inherits
    /// after its parent's (#2522).
    void seed_collection_with_elements (const std::string& id,
    const std::string& parent_id,
    const json& elements) {
        vayu::db::Collection col;
        col.id   = id;
        col.name = "Collection " + id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.elements   = elements.dump ();
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// A folder under @p parent_id carrying its own @p variables, at @p order
    /// among its parent's children.
    void seed_folder (const std::string& id,
    const std::string& parent_id,
    const std::string& variables,
    int order) {
        vayu::db::Collection col;
        col.id         = id;
        col.name       = "Folder " + id;
        col.parent_id  = parent_id;
        col.variables  = variables;
        col.order      = order;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// File the seeded request @p id under @p collection_id instead of `col_1`.
    void move_request (const std::string& id, const std::string& collection_id) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row) << id;
        row->collection_id = collection_id;
        db_->save_request (*row);
    }

    /// Give the seeded request @p id its own @p timeout_ms over the run's.
    void set_request_timeout (const std::string& id, int timeout_ms) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row) << id;
        row->timeout_ms = timeout_ms;
        db_->save_request (*row);
    }

    /// The variables stored on collection @p id now.
    vayu::Environment stored_collection_variables (const std::string& id) {
        auto row = db_->get_collection (id);
        if (!row) {
            ADD_FAILURE () << "no collection " << id;
            return {};
        }
        return vayu::json::parse_variables (row->variables);
    }

    /// Override a seeded config value, keeping the rest of its row intact.
    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not a seeded config key";
        entry->value = value;
        db_->save_config_entry (*entry);
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

    /// A request in `col_1`, ordered by @p order, pointing at the mock server.
    /// @p name defaults to one derived from @p id; flow-control tests pass it
    /// explicitly, because a `setNextRequest` target is resolved as a *name*
    /// before it is tried as an id (issue #1006).
    void seed_request (const std::string& id,
    int order,
    const std::string& path,
    const std::string& pre_script   = "",
    const std::string& post_script  = "",
    const std::string& absolute_url = "",
    const std::string& name         = "",
    const std::string& headers      = "",
    const std::string& body         = "",
    const std::string& auth         = "") {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.auth          = auth;
        r.name          = name.empty () ? "Step " + id : name;
        // A body is what a POST is for, so the two travel together rather than
        // leaving a caller to remember the method.
        r.method = body.empty () ? vayu::HttpMethod::GET : vayu::HttpMethod::POST;
        r.url     = absolute_url.empty () ? server_->url (path) : absolute_url;
        r.headers = headers;
        r.body    = body;
        json elements = json::array ();
        if (!pre_script.empty ()) {
            elements.push_back ({ { "id", "el_pre_" + id }, { "kind", "script.pre" },
            { "enabled", true }, { "config", { { "script", pre_script } } } });
        }
        if (!post_script.empty ()) {
            elements.push_back ({ { "id", "el_post_" + id }, { "kind", "script.post" },
            { "enabled", true }, { "config", { { "script", post_script } } } });
        }
        r.elements   = elements.dump ();
        r.order      = order;
        r.created_at = 1;
        r.updated_at = 1;
        db_->save_request (r);
    }

    /// A request in `col_1` stored with `stream` set, as the request editor
    /// saves one, under its own @p timeout_ms (#3235), carrying @p post_script
    /// as its `script.post` when one is given.
    void seed_streaming_request (const std::string& id,
    int order,
    const std::string& path,
    int timeout_ms,
    const std::string& post_script              = "",
    const std::optional<std::string>& text_path = std::nullopt) {
        vayu::db::Request r;
        r.id               = id;
        r.collection_id    = "col_1";
        r.name             = "Step " + id;
        r.method           = vayu::HttpMethod::GET;
        r.url              = server_->url (path);
        r.stream           = true;
        r.stream_text_path = text_path;
        r.timeout_ms       = timeout_ms;
        r.order            = order;
        r.created_at       = 1;
        r.updated_at       = 1;
        if (!post_script.empty ()) {
            r.elements = json::array (
            { { { "id", "el_post_" + id }, { "kind", "script.post" },
            { "enabled", true }, { "config", { { "script", post_script } } } } })
                         .dump ();
        }
        db_->save_request (r);
    }

    /// Every stored step's trace, in step order.
    [[nodiscard]] std::vector<json> stored_traces (const std::string& run_id) {
        std::vector<json> traces;
        for (const auto& row : db_->get_results (run_id)) {
            traces.push_back (json::parse (row.trace_data));
        }
        return traces;
    }

    /// A request in `col_1` carrying an arbitrary `elements` array (issue
    /// #1514's phase-0 kinds - `extract.*` / `assert.*` / `timer.think` -
    /// which `seed_request` above has no parameters for).
    void seed_request_with_elements (const std::string& id,
    int order,
    const std::string& path,
    const json& elements) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = "Step " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = server_->url (path);
        r.elements      = elements.dump ();
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// Stamp a request's `spec_operation`, which is what says *which* operation
    /// of the bound document a step is - the identity both coverage and schema
    /// validation resolve by.
    void stamp_spec_operation (const std::string& request_id, const json& identity) {
        auto row = db_->get_request (request_id);
        ASSERT_HAS_VALUE (row) << request_id;
        row->spec_operation = identity.dump ();
        db_->save_request (*row);
    }

    /// Store a document carrying @p response_schemas and bind `col_1` to it, as
    /// an import or a sync would leave the two rows.
    void bind_spec (const json& response_schemas, const std::string& hash = "hash-1") {
        vayu::db::SpecDocument spec;
        spec.id               = "spec_1";
        spec.content          = "openapi: 3.0.0";
        spec.hash             = hash;
        spec.fetched_at       = 1;
        spec.response_schemas = response_schemas.dump ();
        db_->save_spec_document (spec);

        auto col = db_->get_collection ("col_1");
        ASSERT_HAS_VALUE (col);
        col->openapi =
        json{ { "specId", "spec_1" }, { "specHash", hash }, { "syncedAt", 1 } }.dump ();
        db_->create_collection (*col); // a replace, keyed on the id
    }

    /// Resolve, create the run row and start the worker, exactly as POST /runs
    /// does - minus the HTTP layer.
    std::string start (size_t iterations, const std::string& environment_id = "") {
        return start_scenario (iterations, environment_id, json ());
    }

    /// As `start`, with the contract made a gate for the run.
    std::string start_gated (size_t iterations) {
        return start_scenario (iterations, "", json (), /*fail_on_schema_error=*/true);
    }

    /// As `start`, with a `thresholds` block on the run's config - issue
    /// #1564's collection-run wiring, exercised the same way `start_gated`
    /// exercises `failOnSchemaError`.
    std::string start_with_thresholds (size_t iterations, const json& thresholds) {
        return start_scenario (
        iterations, "", json (), /*fail_on_schema_error=*/false, thresholds);
    }

    /// As `start`, with `stopOnError: true` on the run's config (issue #2526).
    std::string start_stopping_on_error (size_t iterations) {
        return start_scenario (iterations, "", json (),
        /*fail_on_schema_error=*/false, json (), /*stop_on_error=*/true);
    }

    /// As `start`, with a `data` block. Pass no @p iterations to leave the key
    /// off the payload entirely, which is how "the row count is the default"
    /// is exercised rather than assumed.
    std::string start_with_data (const json& data,
    std::optional<size_t> iterations  = std::nullopt,
    const std::string& environment_id = "") {
        return start_scenario (iterations, environment_id, data);
    }

    std::string start_scenario (std::optional<size_t> iterations,
    const std::string& environment_id,
    const json& data,
    bool fail_on_schema_error = false,
    const json& thresholds    = json (),
    bool stop_on_error        = false) {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" } };
        if (iterations) {
            scenario["iterations"] = *iterations;
        }
        if (recursive_) {
            scenario["recursive"] = true;
        }
        if (!data.is_null ()) {
            scenario["data"] = data;
        }

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.environment_id       = environment_id;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
        // This fixture runs the sequential runner, as `POST /runs` resolves
        // its plan.
        options.oauth2_after_scripts = true;
        if (stream_bounds_) {
            options.stream_bounds = *stream_bounds_;
        }

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request = std::move (resolved.request);
        execution->plan    = std::move (resolved.plan);
        execution->data_rows = std::move (resolved.data_rows);
        // The binding the plan resolved against, carried exactly as POST /runs
        // carries it: without this the runner would judge every run of a bound
        // collection as unbound, and every schema assertion below would pass by
        // measuring nothing.
        execution->spec = std::move (resolved.spec);

        json config{ { "scenario", scenario } };
        if (!environment_id.empty ()) {
            config["environmentId"] = environment_id;
        }
        if (fail_on_schema_error) {
            config["failOnSchemaError"] = true;
        }
        if (!thresholds.is_null ()) {
            config["thresholds"] = thresholds;
        }
        if (stop_on_error) {
            config["stopOnError"] = true;
        }
        if (allow_script_requests_) {
            config["allowScriptRequests"] = true;
        }

        // A new id per start, so a test can run the same collection again.
        const std::string run_id = "run_scenario_" + std::to_string (++runs_started_);
        vayu::db::Run run;
        run.id     = run_id;
        run.type   = vayu::RunType::Scenario;
        run.status = vayu::RunStatus::Pending;
        if (!environment_id.empty ()) {
            run.environment_id = environment_id;
        }
        run.config_snapshot = config.dump ();
        // A real wall-clock stamp, not a token 1: reaching a terminal status
        // prunes the run history by the retention knobs, and a run dated 1970
        // is pruned - with its results - the moment it finishes.
        const auto started_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                                .count ();
        run.start_time = started_at;
        run.end_time   = started_at;
        db_->create_run (run);
        if (before_worker_) {
            before_worker_ (run_id);
        }

        EXPECT_TRUE (manager_.start_scenario_run (run_id, config, execution, *db_, jar_));
        return run_id;
    }

    /// Block until the run leaves `pending`/`running`, or give up loudly.
    vayu::RunStatus await_terminal (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (30);
        while (std::chrono::steady_clock::now () < deadline) {
            auto run = db_->get_run (run_id);
            if (run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
                // The worker writes the status before its last acts (closed,
                // then retain_run, which takes it out of the active map); wait
                // for those rather than a fixed moment, so an assertion on
                // them cannot race it.
                (void)vayu::tests::wait_until (
                [&] () { return manager_.get_run (run_id) == nullptr; },
                std::chrono::seconds (5));
                return run->status;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        ADD_FAILURE () << "Run " << run_id << " never reached a terminal status";
        return vayu::RunStatus::Failed;
    }

    /// Stop @p run_id once @p in_flight holds, the sign its step is waiting on
    /// a peer, and answer how long it then took to end, which must be Stopped.
    std::chrono::steady_clock::duration stop_once (const std::string& run_id,
    const std::function<bool ()>& in_flight) {
        auto context = manager_.get_run (run_id);
        if (!context) {
            ADD_FAILURE () << "run " << run_id << " ended before its step was in flight";
            return {};
        }
        EXPECT_TRUE (vayu::tests::wait_until (in_flight))
        << "the step never reached its peer";
        const auto stopped_at = std::chrono::steady_clock::now ();
        context->request_stop ();
        EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Stopped);
        return std::chrono::steady_clock::now () - stopped_at;
    }

    /// The run's context, whether or not it has finished.
    ///
    /// `get_run` reads `active_runs_` alone, and `retain_run` - the scenario
    /// worker's last act - moves a finished run out of there into
    /// `retained_runs_`. So a test holding a run id has no way to know which
    /// map answers for it: a one-iteration run against a loopback mock can
    /// reach `retain_run` before the test's next line, which is what failed
    /// the v0.19.0 release build on macOS. `get_run_or_retained` reads both
    /// and is what `GET /runs/:id/metrics` already uses for the same question.
    ///
    /// A helper rather than the call spelled out at each site: five tests want
    /// this handle, and a hand-written sixth would reach for `get_run` exactly
    /// as these did.
    [[nodiscard]] std::shared_ptr<vayu::core::RunContext> context_for (
    const std::string& run_id) {
        auto context = manager_.get_run_or_retained (run_id);
        EXPECT_TRUE (context != nullptr) << "No context for run " << run_id;
        return context;
    }

    /// The run's `step` frames alone, in order.
    ///
    /// The stream opens with the plan's size (issue #1398), so a test that
    /// indexed the ring directly to reach a step would be counting past a
    /// frame it is not asking about. Filtering here keeps each such test
    /// asserting its own subject.
    [[nodiscard]] static std::vector<std::string> step_frames (
    const std::shared_ptr<vayu::core::RunContext>& context) {
        std::vector<std::string> steps;
        for (const auto& payload : context->ticks_since (0).payloads) {
            if (payload.find ("event: step\n") != std::string::npos) {
                steps.push_back (payload);
            }
        }
        return steps;
    }

    [[nodiscard]] json summary_of (const std::string& run_id) {
        auto run = db_->get_run (run_id);
        if (!run.has_value ()) {
            ADD_FAILURE () << "no run is stored under " << run_id;
            return json::object ();
        }
        return json::parse (run->summary);
    }

    /// Run the collection @p runs times in `env_1`, each after the last one
    /// finished and stored what its scripts set, and answer the
    /// `Authorization` every `/echo-auth` send carried, in order.
    std::vector<std::string> authorizations_over_runs (int runs) {
        for (int run = 0; run < runs; ++run) {
            EXPECT_EQ (await_terminal (start (/*iterations=*/1, "env_1")),
            vayu::RunStatus::Completed);
        }
        std::vector<std::string> sent;
        for (const auto& hit : server_->requests ()) {
            if (hit.path == "/echo-auth") {
                sent.push_back (hit.authorization);
            }
        }
        return sent;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<ScenarioMockServer> server_;
    vayu::core::RunManager manager_;
    vayu::http::CookieJar jar_;
    size_t runs_started_ = 0;
    /// Runs `col_1` with its sub-folders (`scenario.recursive`).
    bool recursive_ = false;
    /// Lets the steps' scripts call `pm.sendRequest` (`allowScriptRequests`).
    bool allow_script_requests_ = false;
    /// The caps a streaming step is bounded by, as `POST /runs` resolves them;
    /// unset keeps the plan's compiled-in default.
    std::optional<vayu::StreamBounds> stream_bounds_;
    /// Called with the run id between the row's insert and its worker's
    /// registration, the window a Stop that finds no context lands in.
    std::function<void (const std::string&)> before_worker_;
};

} // namespace vayu::tests::scenario_runner
