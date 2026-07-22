// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// GET /run/:id carries the stored exchange for a design run.
//
// A design run IS one request and one response, so the exchange belongs with
// the run. Before this, the only way to read it was GET /run/:id/report, which
// is a load-test aggregate: for a design run its summary is computed from a
// single sample and its metadata carries no configuration at all.

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
