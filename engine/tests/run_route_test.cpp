// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// GET /run/:id carries the stored exchange for a design run.
//
// A design run IS one request and one response, so the exchange belongs with
// the run. Before this, the only way to read it was GET /run/:id/report, which
// is a load-test aggregate: for a design run its summary is computed from a
// single sample and its metadata carries no configuration at all.
//
// These tests cover vayu::json::attach_design_result (the serializer) in
// isolation, not the GET /run/:id route handler itself - the suite has no
// in-process HTTP route tests. Deleting the attach_design_result call from
// runs.cpp, or the type guard around it, leaves this file green.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "vayu/db/database.hpp"
#include "vayu/utils/json.hpp"

namespace {

vayu::db::Run make_run (const std::string& id, vayu::RunType type) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = type;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1;
    run.end_time        = 2;
    run.config_snapshot = R"({"method":"GET","url":"http://x/"})";
    return run;
}

vayu::db::Result make_result (const std::string& run_id) {
    vayu::db::Result r;
    r.run_id      = run_id;
    r.timestamp   = 10;
    r.status_code = 200;
    r.status_text = "OK";
    r.latency_ms  = 2.5;
    r.trace_data  = R"({"request":{"method":"GET","url":"http://x/"},)"
                    R"("response":{"headers":{},"body":"hi"}})";
    return r;
}

} // namespace

TEST (RunRoute, DesignRunCarriesItsResult) {
    // Build the payload the route builds, through the same serializer.
    auto run  = make_run ("run_design", vayu::RunType::Design);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, { make_result ("run_design") });

    ASSERT_TRUE (json.contains ("result"));
    EXPECT_EQ (json["result"]["statusCode"], 200);
    EXPECT_EQ (json["result"]["statusText"], "OK");
    EXPECT_EQ (json["result"]["trace"]["response"]["body"], "hi");
}

TEST (RunRoute, LoadRunCarriesNoResult) {
    auto run  = make_run ("run_load", vayu::RunType::Load);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, { make_result ("run_load") });

    EXPECT_FALSE (json.contains ("result"));
}

TEST (RunRoute, DesignRunWithNoResultsStaysQuiet) {
    auto run  = make_run ("run_empty", vayu::RunType::Design);
    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, {});

    EXPECT_FALSE (json.contains ("result"));
}

// A truncated design-run trace round-trips: the bodyTruncated / bodyBytes keys
// store_result writes survive parsing and reach GET /runs/:id's result.trace, so
// the app readers can surface the notice.
TEST (RunRoute, DesignRunPassesTruncationFieldsThrough) {
    auto run    = make_run ("run_trunc", vayu::RunType::Design);
    auto result = make_result ("run_trunc");
    result.trace_data =
    R"({"request":{"method":"POST","url":"http://x/","body":"REQ",)"
    R"("bodyTruncated":true,"bodyBytes":2048},)"
    R"("response":{"headers":{},"body":"RES","bodyTruncated":true,"bodyBytes":4096}})";

    auto json = vayu::json::serialize (run);
    vayu::json::attach_design_result (json, run, { result });

    ASSERT_TRUE (json.contains ("result"));
    const auto& trace = json["result"]["trace"];
    EXPECT_TRUE (trace["response"]["bodyTruncated"].get<bool> ());
    EXPECT_EQ (trace["response"]["bodyBytes"].get<int> (), 4096);
    EXPECT_TRUE (trace["request"]["bodyTruncated"].get<bool> ());
    EXPECT_EQ (trace["request"]["bodyBytes"].get<int> (), 2048);
}
