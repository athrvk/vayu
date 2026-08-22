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
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/types.hpp"

namespace vayu::http::routes {
// Both declared in execution.cpp.
void seed_run_times (vayu::db::Run& run, int64_t started_at);
std::string scenario_snapshot (const std::string& sanitized, const nlohmann::json& manifest);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::http::routes::scenario_snapshot;
using vayu::http::routes::seed_run_times;

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
// would keep them - it only strips credentials out of `auth`.
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

// A snapshot that is not JSON is passed through by sanitize_config_snapshot,
// and there is no request in it to describe - rebuilding one from the manifest
// alone would invent a payload the client never sent.
TEST (ScenarioSnapshot, LeavesANonObjectSnapshotAlone) {
    EXPECT_EQ (scenario_snapshot ("not json at all", json::object ()), "not json at all");
    EXPECT_EQ (scenario_snapshot ("[1,2,3]", json::object ()), "[1,2,3]");
}

} // namespace
