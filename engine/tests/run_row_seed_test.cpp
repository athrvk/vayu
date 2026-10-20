/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_row_seed_test.cpp
 * @brief The run row's timestamp invariant, held at the two insert sites.
 *
 * The design-mode insert used to stamp `start_time` and nothing else, leaving
 * `end_time` indeterminate (the field had no default). Normal completion hid
 * it - `update_run_status` stamps `end_time` on every terminal write - but a
 * run orphaned by a daemon crash is marked Failed with `end_time` *as
 * recorded*, so the garbage reached the report, where the reader's
 * `end_time > 0 ? end_time : now_ms()` guard rescued it only by luck.
 *
 * `seed_run_times` is the one place that stamps both, so testing it covers
 * both inserts (the suite has no in-process HTTP route harness); the field
 * default is the backstop for a future insert site that forgets to call it,
 * and is asserted in db_test.cpp against the real reconcile path.
 *
 * `scenario_snapshot` sits here for the same reason: it is the other thing
 * `POST /runs` does to a row before writing it, and what it keeps out of the
 * store is a security property rather than a formatting choice.
 *
 * `with_default_headers_snapshot` sits here for a related but distinct
 * reason (issue #1488): what it adds to the row is not user data at all, so
 * there is nothing to keep out - the property under test is that the merge
 * happens and survives whatever the other two rewrites already did.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/core/load_strategy.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http::routes {
// Both declared in execution.cpp.
void seed_run_times (vayu::db::Run& run, int64_t started_at);
std::string scenario_snapshot (const std::string& sanitized, const nlohmann::json& manifest);
std::string load_data_snapshot (const std::string& sanitized,
const vayu::core::LoadDataSet& data);
std::string with_default_headers_snapshot (const std::string& snapshot,
const vayu::http::DefaultHeaderPolicy& header_policy);
vayu::http::DefaultHeaderScope compression_scope_of (vayu::RunType type);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::http::DefaultHeaderPolicy;
using vayu::http::routes::compression_scope_of;
using vayu::http::routes::load_data_snapshot;
using vayu::http::routes::scenario_snapshot;
using vayu::http::routes::seed_run_times;
using vayu::http::routes::with_default_headers_snapshot;

TEST (SeedRunTimes, SeedsEndTimeAlongsideStartTime) {
    vayu::db::Run run;
    seed_run_times (run, 1'700'000'000'000);

    EXPECT_EQ (run.start_time, 1'700'000'000'000);
    // Not left at 0: a crash-orphaned run keeps whatever is recorded here, and
    // 0 would make the report substitute the (arbitrarily much later) read time.
    EXPECT_EQ (run.end_time, 1'700'000'000'000);
}

TEST (SeedRunTimes, RunEndTimeDefaultsToZeroBeforeAnySeed) {
    // The backstop: an insert site that never calls seed_run_times still
    // stores a value every reader's `> 0` guard understands, rather than
    // whatever happened to be on the stack.
    vayu::db::Run run;
    EXPECT_EQ (run.end_time, 0);
}

// The `data` rows are the point: they are user data of unknown sensitivity and
// are never snapshotted, so the manifest (which records only their count) has
// to *replace* the block rather than sit beside it. `sanitize_config_snapshot`
// would keep them - it withholds credentials, not user data.
TEST (ScenarioSnapshot, ReplacesTheSentBlockWithTheManifest) {
    const json manifest{ { "source", "collection" }, { "collectionId", "col_1" },
        { "recursive", false }, { "iterations", 2 }, { "dataRowCount", 2 },
        { "steps",
        json::array ({ json{ { "index", 0 }, { "requestId", "req_1" }, { "name", "Login" },
        { "method", "POST" }, { "url", "https://api.test/login?key={{apiKey}}" } } }) } };

    const std::string sanitized =
    json{ { "scenario",
          json{ { "source", "collection" }, { "collectionId", "col_1" },
          { "data", json::array ({ json{ { "password", "hunter2" } }, json{ { "password", "hunter3" } } }) } } },
        { "environmentId", "env_1" } }
    .dump ();

    auto stored = json::parse (scenario_snapshot (sanitized, manifest));

    EXPECT_EQ (stored["scenario"], manifest);
    EXPECT_FALSE (stored["scenario"].contains ("data"));
    EXPECT_EQ (stored.dump ().find ("hunter2"), std::string::npos);
    // Everything else the client sent is left alone.
    EXPECT_EQ (stored["environmentId"], "env_1");
    // The step URL is the stored one, so a resolved `apikey` in a query string
    // never reaches the run store - build_scenario_manifest's contract, kept.
    EXPECT_NE (stored["scenario"]["steps"][0]["url"].get<std::string> ().find ("{{apiKey}}"),
    std::string::npos);
}

// A collection run's top-level options ride the stored snapshot beside the
// manifest, through both rewrites a scenario snapshot takes - which is what
// keeps two runs differing only in `stopOnError` (issue #2526) or
// `failOnSchemaError` from reading as the same run.
TEST (ScenarioSnapshot, KeepsTheRunsTopLevelOptionsBesideTheManifest) {
    const json manifest{ { "source", "collection" }, { "collectionId", "col_1" } };
    const auto stored_with = [&manifest] (bool stop_on_error) {
        const json body{ { "scenario",
                         { { "source", "collection" }, { "collectionId", "col_1" } } },
            { "stopOnError", stop_on_error }, { "failOnSchemaError", true } };
        return json::parse (scenario_snapshot (
        vayu::json::sanitize_config_snapshot (body.dump (), 1024, {}), manifest));
    };

    const auto stopping   = stored_with (true);
    const auto continuing = stored_with (false);
    ASSERT_TRUE (stopping.contains ("stopOnError")) << stopping.dump ();
    ASSERT_TRUE (continuing.contains ("stopOnError")) << continuing.dump ();
    ASSERT_TRUE (stopping.contains ("failOnSchemaError")) << stopping.dump ();
    EXPECT_EQ (stopping["stopOnError"], true);
    EXPECT_EQ (continuing["stopOnError"], false);
    EXPECT_EQ (stopping["failOnSchemaError"], true);
    EXPECT_NE (stopping, continuing);
}

// A snapshot that is not JSON is passed through by sanitize_config_snapshot,
// and there is no request in it to describe - rebuilding one from the manifest
// alone would invent a payload the client never sent.
TEST (ScenarioSnapshot, LeavesANonObjectSnapshotAlone) {
    EXPECT_EQ (scenario_snapshot ("not json at all", json::object ()), "not json at all");
    EXPECT_EQ (scenario_snapshot ("[1,2,3]", json::object ()), "[1,2,3]");
}

// The same rule one field over: a single-request load run's rows (issue #993)
// are the same user data a scenario's are, so the stored snapshot keeps their
// count and not the set.
TEST (LoadDataSnapshot, ReplacesTheRowsWithTheirCount) {
    // Built field by field rather than as one brace-init: the payload a load
    // run sends is flat, and a nested literal here formats differently under
    // the two clang-format majors this repo has seen.
    json rows = json::array ();
    rows.push_back (json{ { "password", "hunter2" } });
    rows.push_back (json{ { "password", "hunter3" } });

    json payload;
    payload["method"]        = "POST";
    payload["url"]           = "https://api.test/login";
    payload["data"]          = rows;
    payload["environmentId"] = "env_1";

    vayu::core::LoadDataSet set;
    set.rows          = rows;
    const auto stored = json::parse (load_data_snapshot (payload.dump (), set));

    EXPECT_FALSE (stored.contains ("data"));
    EXPECT_EQ (stored["dataRowCount"], 2);
    EXPECT_EQ (stored.dump ().find ("hunter2"), std::string::npos)
    << "a row's cell reached the run store";
    // A set sent without a file name stores no key, never an empty one.
    EXPECT_FALSE (stored.contains ("dataFileName"));
    EXPECT_FALSE (stored.contains ("dataFileHash"));
    // Everything else the client sent is left alone.
    EXPECT_EQ (stored["environmentId"], "env_1");
    EXPECT_EQ (stored["url"], "https://api.test/login");
}

// Issue #2051: the file the rows came from is recorded beside their count, by
// name and content hash, while the rows themselves still never are. Written
// from the validated set, so a body whose copy the sanitizer altered cannot
// decide it. Mutation check: drop the `stamp_data_file_fields` call in
// `load_data_snapshot` and the name and hash assertions red.
TEST (LoadDataSnapshot, RecordsTheFilesNameAndHashBesideTheCount) {
    json rows = json::array ();
    rows.push_back (json{ { "password", "hunter2" } });

    json payload;
    payload["method"] = "POST";
    payload["url"]    = "https://api.test/login";
    payload["data"]   = rows;

    vayu::core::LoadDataSet set;
    set.rows      = rows;
    set.file_name = "users.csv";
    set.file_hash = std::string (64, 'f');

    const auto stored = json::parse (load_data_snapshot (payload.dump (), set));

    EXPECT_EQ (stored.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (stored.value ("dataFileHash", ""), std::string (64, 'f'));
    EXPECT_EQ (stored["dataRowCount"], 1);
    EXPECT_FALSE (stored.contains ("data"));
    EXPECT_EQ (stored.dump ().find ("hunter2"), std::string::npos)
    << "a row's cell reached the run store";
}

TEST (LoadDataSnapshot, LeavesANonObjectSnapshotAlone) {
    vayu::core::LoadDataSet set;
    set.rows.push_back (json::object ());
    EXPECT_EQ (load_data_snapshot ("not json at all", set), "not json at all");
    EXPECT_EQ (load_data_snapshot ("[1,2,3]", set), "[1,2,3]");
}

// A baseline pinned before loadNegotiateCompression's 0.26 default flip (or
// any later config change) needs to say what it measured under - issue
// #1488. userAgent is recorded verbatim; requestId/acceptEncoding collapse
// to whether each was negotiated at all.
TEST (DefaultHeadersSnapshot, RecordsUserAgentRequestIdAndAcceptEncoding) {
    DefaultHeaderPolicy policy;
    policy.user_agent         = "Vayu/0.26.0";
    policy.correlation_header = "X-Vayu-Request-Id";
    policy.accept_encoding    = "gzip, br, deflate";

    const std::string sanitized =
    json{ { "method", "POST" }, { "url", "https://api.test/" } }.dump ();
    const auto stored = json::parse (with_default_headers_snapshot (sanitized, policy));

    ASSERT_TRUE (stored.contains ("defaultHeaders"));
    const auto& headers = stored["defaultHeaders"];
    EXPECT_EQ (headers["userAgent"], "Vayu/0.26.0");
    EXPECT_EQ (headers["requestId"], true);
    EXPECT_EQ (headers["acceptEncoding"], true);
    // Everything else the client sent is left alone.
    EXPECT_EQ (stored["method"], "POST");
    EXPECT_EQ (stored["url"], "https://api.test/");
}

TEST (DefaultHeadersSnapshot, RecordsFalseWhenNegotiationIsOff) {
    DefaultHeaderPolicy policy; // correlation_header / accept_encoding default-empty
    ASSERT_TRUE (policy.correlation_header.empty ());
    ASSERT_TRUE (policy.accept_encoding.empty ());

    const auto stored =
    json::parse (with_default_headers_snapshot (json::object ().dump (), policy));

    EXPECT_EQ (stored["defaultHeaders"]["requestId"], false);
    EXPECT_EQ (stored["defaultHeaders"]["acceptEncoding"], false);
}

TEST (DefaultHeadersSnapshot, LeavesANonObjectSnapshotAlone) {
    DefaultHeaderPolicy policy;
    EXPECT_EQ (with_default_headers_snapshot ("not json at all", policy), "not json at all");
    EXPECT_EQ (with_default_headers_snapshot ("[1,2,3]", policy), "[1,2,3]");
}

// A load run (including a scenario carrying a load mode) reads the load
// scope's own compression key; a sequential collection run negotiates the
// way any other collection send does (issue #1488).
TEST (CompressionScopeOf, PicksLoadForLoadAndDesignForScenario) {
    EXPECT_EQ (compression_scope_of (vayu::RunType::Load),
    vayu::http::DefaultHeaderScope::Load);
    EXPECT_EQ (compression_scope_of (vayu::RunType::Scenario),
    vayu::http::DefaultHeaderScope::Design);
}

} // namespace
