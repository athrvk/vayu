/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/load_data_test.cpp
 * @brief Data rows on a **single-request** load run (issue #993).
 *
 * `{{data.column}}` bound on the scenario path alone until this, so the
 * canonical load shape - one request, N users, a row each - was expressible
 * only by wrapping the request in a one-step collection, which most users would
 * never discover. The rows ride the run payload's top-level `data` now.
 *
 * Two halves, and both are here because neither is worth much alone: the
 * route's reader (what a row set may be, and what the credentials do about a
 * token) and the executor (what actually leaves on the wire, per submission).
 * The wire is what the second half asserts on - a bind that produced the right
 * string and then lost it downstream is still a request nobody meant to send,
 * which is the reasoning `scenario_load_test.cpp` records for its own listener.
 *
 * The **rows-off** path is asserted here too, and deliberately: it is the
 * throughput guard #992 states, and a guard nothing tests is a guard that
 * decays into a branch someone deletes.
 */

#include <gtest/gtest.h>

#include <algorithm>
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
#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/encoding.hpp"

namespace {

using nlohmann::json;
using vayu::core::LoadDataSet;
using vayu::http::routes::read_load_data_set;

/**
 * @brief A listener that records the path and `Authorization` of every request
 *        it answers.
 *
 * Read off the wire rather than off the request the strategy built: a
 * credential bound from a row is only correct once `apply_auth` has encoded it,
 * and that encoding is what used to hide a token binding in the wrong order
 * (issue #591).
 */
class RecordingServer {
    public:
    struct Hit {
        std::string path;
        std::string authorization;
    };

    RecordingServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (64);

        // A `{{data.*}}` token substitutes into the path, so the row a
        // submission bound is readable off the wire rather than inferred from a
        // counter the test also owns.
        svr.Get (R"(/row/(.*))", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/row/" + req.matches[1].str ());
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/plain", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/plain");
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

    [[nodiscard]] std::vector<Hit> hits () const {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        return hits_;
    }

    [[nodiscard]] std::vector<std::string> paths () const {
        std::vector<std::string> out;
        for (const auto& hit : hits ())
            out.push_back (hit.path);
        return out;
    }

    private:
    void record (const httplib::Request& req, const std::string& path) {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        hits_.push_back ({ path, req.get_header_value ("Authorization") });
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex hits_mtx_;
    std::vector<Hit> hits_;
};

constexpr const char* TEST_DB_PATH = "test_load_data.db";

/// The engine's seeded limits, as the route resolves them.
vayu::core::ScenarioLimits stock_limits () {
    vayu::core::ScenarioLimits limits;
    limits.max_data_rows  = vayu::core::constants::scenario::MAX_DATA_ROWS;
    limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
    return limits;
}

class LoadDataTest : public ::testing::Test {
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
     * strategy: the route's reader, the same build the run performs, the split
     * `build_load_request` makes, then drain - the tallies are only final after
     * it.
     *
     * Every step goes through production's own function rather than a
     * hand-built equivalent, for the reason `scenario_load_test`'s `with_data`
     * records: a test that built its own template would pass against a splitter
     * the engine never runs.
     */
    void run (const json& payload) {
        auto read = read_load_data_set (payload, stock_limits (), /*is_scenario=*/false);
        ASSERT_TRUE (read.ok) << read.error;

        auto built = vayu::http::build_request (payload, db_.get (), /*timeout_ms=*/5000,
        read.set ? read.set->auth_resolution () : vayu::http::AuthResolution::Apply);
        ASSERT_TRUE (built.ok) << built.error_message;
        if (read.set) {
            read.set->fields = vayu::core::tokenize_data_fields (built.request);
        }

        auto context =
        std::make_shared<vayu::core::RunContext> ("test-load-data", payload);
        context->load_data = std::move (read.set);
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

    /// What the deferred pass recorded as failures, for an assertion that has
    /// to say *why* a replay failed rather than only that it did - the pass
    /// stores them as a result row rather than returning them.
    std::string replay_failures () {
        std::string joined;
        for (const auto& result : db_->get_results ("test-load-data")) {
            const auto trace = nlohmann::json::parse (result.trace_data, nullptr, false);
            if (trace.is_discarded () || !trace.contains ("failures")) {
                continue;
            }
            for (const auto& failure : trace["failures"]) {
                joined += failure.get<std::string> () + "; ";
            }
        }
        return joined;
    }

    /// An iterations payload against @p url, retaining every completion so an
    /// assertion is about what a record carries rather than which budget
    /// claimed it.
    static json iterations_payload (const std::string& url, size_t iterations) {
        return json{ { "method", "GET" }, { "url", url }, { "mode", "iterations" },
            { "iterations", iterations }, { "concurrency", 1 },
            { "save_timing_breakdown", true }, { "success_sample_rate", 1 },
            { "slow_threshold_ms", 0 }, { "response_sample_rate", 1 } };
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
};

// ============================================================================
// The route's reader - what a row set may be, before any run row exists
// ============================================================================

TEST (ReadLoadDataSet, AbsentAndNullAreNoRows) {
    const json absent = { { "url", "https://example.test/" } };
    auto read         = read_load_data_set (absent, stock_limits (), false);
    EXPECT_TRUE (read.ok);
    // No set at all, rather than an empty one: that emptiness is what keeps
    // the rows-off path free of per-submission work.
    EXPECT_EQ (read.set, nullptr) << "a run without rows carries a set";

    const json null_rows = { { "url", "https://example.test/" }, { "data", nullptr } };
    read = read_load_data_set (null_rows, stock_limits (), false);
    EXPECT_TRUE (read.ok);
    EXPECT_EQ (read.set, nullptr);
}

TEST (ReadLoadDataSet, RowsAreKeptInPayloadOrder) {
    const json payload = { { "url", "https://example.test/" },
        { "data", json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } }) } };

    const auto read = read_load_data_set (payload, stock_limits (), false);
    ASSERT_TRUE (read.ok) << read.error;
    ASSERT_NE (read.set, nullptr);
    ASSERT_EQ (read.set->rows.size (), 2u);
    EXPECT_EQ (read.set->rows[0]["id"], "a");
    EXPECT_EQ (read.set->rows[1]["id"], "b");
    EXPECT_EQ (read.set->auth_resolution (), vayu::http::AuthResolution::Apply)
    << "static credentials must still be applied by the build, exactly as they "
       "were before rows existed";
}

// The refusals are the scenario path's, because they are the same reader -
// which is the point of sharing it rather than writing a second one.
TEST (ReadLoadDataSet, TheRefusalsMatchTheScenarioPathAndNameThisField) {
    const auto refusal = [] (const json& data) {
        const json payload = { { "url", "https://example.test/" }, { "data", data } };
        const auto read = read_load_data_set (payload, stock_limits (), false);
        EXPECT_FALSE (read.ok) << "accepted: " << data.dump ();
        return read.error;
    };

    EXPECT_NE (refusal (json::object ()).find ("must be an array of objects"),
    std::string::npos);
    // A set that binds nothing is a mistake, not an empty run.
    EXPECT_NE (refusal (json::array ()).find ("present but empty"), std::string::npos);
    const auto row_error = refusal (json::array ({ json{ { "id", "a" } }, 7 }));
    EXPECT_NE (row_error.find ("row 1"), std::string::npos) << row_error;
    EXPECT_NE (row_error.find ("name/value pairs"), std::string::npos) << row_error;

    // Every one of them names `data`, not `scenario.data`: the caller has to be
    // told which field of *theirs* was wrong.
    EXPECT_NE (refusal (json::array ()).find ("'data'"), std::string::npos);
    EXPECT_EQ (refusal (json::array ()).find ("scenario.data"), std::string::npos);
}

TEST (ReadLoadDataSet, TheLimitsAreTheOnesACollectionRunIsHeldTo) {
    vayu::core::ScenarioLimits tight;
    tight.max_data_rows  = 1;
    tight.max_data_bytes = 1024;
    const json payload   = { { "url", "https://example.test/" },
          { "data", json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } }) } };

    auto read = read_load_data_set (payload, tight, false);
    EXPECT_FALSE (read.ok);
    EXPECT_NE (read.error.find ("maxScenarioDataRows"), std::string::npos)
    << read.error;
    EXPECT_EQ (read.set, nullptr) << "a refused set must leave nothing behind";

    tight.max_data_rows  = 10;
    tight.max_data_bytes = 4;
    read                 = read_load_data_set (payload, tight, false);
    EXPECT_FALSE (read.ok);
    EXPECT_NE (read.error.find ("maxScenarioDataBytes"), std::string::npos)
    << read.error;
}

// A collection run states its rows inside the block that names the collection,
// and the two bind differently - one row per iteration shared by every step
// there, one per submission here. Refused rather than dropped: a caller whose
// rows were ignored would read a run of literal tokens as the feature working.
TEST (ReadLoadDataSet, TopLevelRowsBesideAScenarioBlockAreRefusedByName) {
    const json block = { { "source", "collection" }, { "collectionId", "c" } };
    const json payload = { { "scenario", block },
        { "data", json::array ({ json{ { "id", "a" } } }) } };

    const auto read = read_load_data_set (payload, stock_limits (), /*is_scenario=*/true);
    EXPECT_FALSE (read.ok);
    EXPECT_NE (read.error.find ("scenario.data"), std::string::npos)
    << "the refusal must say where a collection run's rows belong: " << read.error;
    EXPECT_EQ (read.set, nullptr);
}

TEST (ReadLoadDataSet, CredentialsCarryingATokenDeferTheBuild) {
    const json payload = { { "url", "https://example.test/" },
        { "auth", { { "mode", "basic" }, { "username", "{{data.user}}" }, { "password", "pw" } } },
        { "data", json::array ({ json{ { "user", "alice" } } }) } };

    const auto read = read_load_data_set (payload, stock_limits (), false);
    ASSERT_TRUE (read.ok) << read.error;
    ASSERT_NE (read.set, nullptr);
    EXPECT_FALSE (read.set->credentials.empty ());
    EXPECT_EQ (read.set->auth_resolution (), vayu::http::AuthResolution::Defer)
    << "a credential carrying a row value must not be encoded by the build - "
       "after `apply_auth` the token is base64 of its own literal text";
}

// The one mode deferral cannot serve: the token is acquired against the token
// endpoint before the run starts, so no submission exists for a row to reach.
TEST (ReadLoadDataSet, ADataTokenInAnOAuth2ConfigIsRefused) {
    const json payload = { { "url", "https://example.test/" },
        { "auth",
        { { "mode", "oauth2" },
        { "config",
        { { "tokenUrl", "https://auth.test/token" }, { "clientId", "c" },
        { "clientSecret", "{{data.secret}}" } } } } },
        { "data", json::array ({ json{ { "secret", "s" } } }) } };

    const auto read = read_load_data_set (payload, stock_limits (), false);
    EXPECT_FALSE (read.ok);
    EXPECT_NE (read.error.find ("{{data.secret}}"), std::string::npos) << read.error;
    EXPECT_EQ (read.set, nullptr);
}

// ============================================================================
// The executor - what reaches the wire, per submission
// ============================================================================

// The headline: six submissions over three rows send three distinct values,
// each row claimed in turn and the cursor wrapping when the set runs out.
TEST_F (LoadDataTest, RowsBindPerSubmissionAndWrapWhenTheSetRunsOut) {
    RecordingServer server;
    json payload    = iterations_payload (server.url ("/row/{{data.id}}"), 6);
    payload["data"] = json::array (
    { json{ { "id", "a" } }, json{ { "id", "b" } }, json{ { "id", "c" } } });

    run (payload);

    auto paths = server.paths ();
    ASSERT_EQ (paths.size (), 6u);
    // One virtual submitter, so the order is the claim order.
    EXPECT_EQ (paths,
    (std::vector<std::string>{ "/row/a", "/row/b", "/row/c", "/row/a", "/row/b", "/row/c" }))
    << "the rows were not claimed in turn, or the cursor did not wrap";
}

// The rows-off path, which is the throughput guard made structural: no set on
// the context at all, so there is no template to walk and no row to claim.
TEST_F (LoadDataTest, ARunWithoutRowsCarriesNoSetAndAnnotatesNothing) {
    RecordingServer server;
    const json payload = iterations_payload (server.url ("/plain"), 2);

    run (payload);

    EXPECT_EQ (context_->load_data, nullptr)
    << "a run sent without `data` must carry no set - the strategies test "
       "exactly this pointer before doing any per-submission work";
    const auto results = context_->metrics_collector->success_results ();
    ASSERT_FALSE (results.empty ());
    for (const auto& result : results) {
        const auto trace = json::parse (result.trace_data, nullptr, false);
        ASSERT_FALSE (trace.is_discarded ()) << result.trace_data;
        EXPECT_FALSE (trace.contains ("dataRowIndex"))
        << "a row-free run gained a row index that reads like row 0: "
        << result.trace_data;
    }
}

// Which row produced which result is the question a data-driven run exists to
// answer, so every retained record carries it.
TEST_F (LoadDataTest, ARecordedResultCarriesItsDataRowIndex) {
    RecordingServer server;
    json payload = iterations_payload (server.url ("/row/{{data.id}}"), 2);
    payload["data"] = json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } });

    run (payload);

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

// A column the row does not carry is the loud failure the whole namespace
// exists for - and the submission it refuses must still be accounted for, or
// the closed loop counts an in-flight request that will never complete.
TEST_F (LoadDataTest, AnAbsentColumnErrorsTheSubmissionInsteadOfSendingIt) {
    RecordingServer server;
    json payload = iterations_payload (server.url ("/row/{{data.missing}}"), 2);
    payload["data"] = json::array ({ json{ { "id", "a" } } });

    run (payload);

    EXPECT_TRUE (server.paths ().empty ())
    << "a request whose token could not bind reached the wire";
    const auto errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_EQ (errors[0].error_code, vayu::ErrorCode::DataBindingFailed);
    EXPECT_NE (errors[0].error_message.find ("{{data.missing}}"), std::string::npos)
    << "the error must name the token that could not bind: " << errors[0].error_message;
    // Sent minus completed is what the refill controller reads, so a refused
    // submission counts on both sides or the run leaks a slot for good.
    EXPECT_EQ (context_->requests_sent.load (), context_->total_requests ())
    << "a bind failure left the run believing a request was still in flight";
}

// The credentials half: a basic-auth username bound per submission, read off
// the wire because base64 is where a wrongly ordered bind hides.
TEST_F (LoadDataTest, CredentialsBindPerSubmissionOnTheWire) {
    RecordingServer server;
    json payload    = iterations_payload (server.url ("/plain"), 2);
    payload["auth"] = { { "mode", "basic" }, { "username", "{{data.user}}" },
        { "password", "pw" } };
    payload["data"] =
    json::array ({ json{ { "user", "alice" } }, json{ { "user", "bob" } } });

    run (payload);

    std::vector<std::string> sent;
    for (const auto& hit : server.hits ())
        sent.push_back (hit.authorization);
    std::sort (sent.begin (), sent.end ());
    ASSERT_EQ (sent.size (), 2u);
    EXPECT_EQ (sent[0], "Basic " + vayu::utils::base64_encode ("alice:pw"));
    EXPECT_EQ (sent[1], "Basic " + vayu::utils::base64_encode ("bob:pw"));
}

// The deferred `tests` script reads the row its sample was bound to, which is
// what makes an assertion about the row meaningful rather than a comparison
// against whichever row happened to be first.
TEST_F (LoadDataTest, TheDeferredScriptReadsTheRowItsSampleBound) {
    RecordingServer server;
    json payload = iterations_payload (server.url ("/row/{{data.id}}"), 2);
    payload["data"] = json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } });
    // Passes only if each sample carries its own row: a replay bound to row 0
    // for both would see 'a' twice and the set below would hold one entry.
    payload["tests"] = R"js(pm.test('bound', function () {
  var id = pm.iterationData.get('id');
  if (id !== 'a' && id !== 'b') { throw new Error('sample saw ' + id); }
});)js";

    run (payload);

    // The samples the replay ran against carry the rows they were sent with -
    // both of them, not one row twice. Asserted beside the script's own verdict
    // because the tallies alone cannot tell "each read its row" from "both read
    // the same row and the assertion happened to accept it".
    std::vector<size_t> sampled_rows;
    for (const auto& sample : context_->metrics_collector->response_samples ()) {
        ASSERT_HAS_VALUE (sample.data_row_index) << "a sample carries no row";
        sampled_rows.push_back (*sample.data_row_index);
    }
    std::sort (sampled_rows.begin (), sampled_rows.end ());
    EXPECT_EQ (sampled_rows, (std::vector<size_t>{ 0, 1 }));

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << replay_failures ();
    EXPECT_EQ (validation.run->passed, 2u)
    << "both samples must replay, each against the row it actually sent";
}

// A run sent without rows leaves the scope `undefined`, which is the distinction
// `pm.iterationData` has always kept between "no data set" and "an empty row".
TEST_F (LoadDataTest, WithoutRowsTheDeferredScriptSeesNoIterationData) {
    RecordingServer server;
    json payload = iterations_payload (server.url ("/plain"), 1);
    // `pm.iterationData` is the binding that is absent, not a column of it: a
    // row-free run leaves the whole scope `undefined`, so a script reaching
    // through it for a column would throw rather than read `undefined`.
    payload["tests"] = R"js(pm.test('absent', function () {
  if (typeof pm.iterationData !== 'undefined') {
    throw new Error('a row-free run bound a row');
  }
});)js";

    run (payload);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << replay_failures ();
    EXPECT_EQ (validation.run->passed, 1u);
}

// Every pacing mode binds, not just the one whose submit path was written
// first: the strategies share one submission helper, and this is what says so.
TEST_F (LoadDataTest, EveryPacingModeBindsItsRows) {
    // `constant_rps` included deliberately: it is the one mode whose submission
    // goes through the rate-limited tick loop rather than the closed-loop
    // controller, so a bind wired into only one of the two would pass every
    // other case here.
    for (const char* mode : { "constant_concurrency", "constant_rps", "ramp_up", "capacity" }) {
        RecordingServer server;
        json payload = { { "method", "GET" }, { "url", server.url ("/row/{{data.id}}") },
            { "mode", mode }, { "duration", "300ms" }, { "concurrency", 2 },
            { "targetRps", 50.0 }, { "startConcurrency", 1 },
            { "stepDuration", "100ms" }, { "rampUpDuration", "100ms" } };
        payload["data"] = json::array ({ json{ { "id", "a" } }, json{ { "id", "b" } } });

        run (payload);

        const auto paths = server.paths ();
        ASSERT_FALSE (paths.empty ()) << "mode " << mode << " sent nothing";
        for (const auto& path : paths) {
            EXPECT_TRUE (path == "/row/a" || path == "/row/b")
            << "mode " << mode << " sent an unbound path: " << path;
        }
    }
}

} // namespace
