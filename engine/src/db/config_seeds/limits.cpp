/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"

#include <string>

namespace vayu::db::config_seeds {

// =============================================================================
// LIMITS (limits) - added by #703
// The sizes and counts a run or a collection may not exceed. Every entry here
// is arrived at from a message that names the setting, which is why they
// deserve one shelf instead of hiding among infrastructure. All but one
// refuse the oversized input outright and say which knob refused it;
// `maxDesignResponseBodyBytes` (issue #1157) is the exception and belongs
// here anyway, because what it bounds is a read in flight rather than
// anything kept on disk - it stops reading at the bound and the response
// viewer says the rest was never read. A bound on what is *stored* is the
// shelf above.
// =============================================================================
void seed_limits (ConfigSeeder& seed, int64_t now) {
    seed (ConfigEntry{ "maxScenarioSteps",
    std::to_string (vayu::core::constants::scenario::MAX_STEPS), "integer", "Max Scenario Steps",
    "Largest number of requests one collection run may resolve to. The whole "
    "sequence is composed before the first send and held in memory for the "
    "run, and a load-mode scenario allocates a latency histogram per step, so "
    "this bounds memory rather than expressing a preference. A collection that "
    "resolves to more steps is rejected outright, never silently truncated.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_STEPS), "1",
    "10000", std::nullopt, now });

    seed (ConfigEntry{ "maxScenarioDataRows",
    std::to_string (vayu::core::constants::scenario::MAX_DATA_ROWS), "integer", "Max Scenario Data Rows",
    "Largest data set one collection run may carry. The app parses the CSV or "
    "JSON file and sends the rows on the run payload - the engine never reads "
    "a file from disk - so this bounds how big that payload may get. A larger "
    "data set is rejected rather than truncated.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_DATA_ROWS),
    "1", "1000000", std::nullopt, now });

    seed (unit ("bytes") (ConfigEntry{ "maxScenarioDataBytes",
    std::to_string (vayu::core::constants::scenario::MAX_DATA_BYTES), "integer", "Max Scenario Data Size",
    "Largest data set one collection run may carry, measured over its JSON. "
    "The row limit alone does not bound the payload - one row is free to hold "
    "a "
    "megabyte in a single cell - and the HTTP body cap above this would drop "
    "the connection instead of explaining itself. A larger data set is "
    "rejected "
    "with a message naming this setting.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_DATA_BYTES),
    "1024", "104857600", std::nullopt, now }));

    seed (unit ("bytes") (
    keywords ({ "swagger" }) (ConfigEntry{ "maxSpecDocumentBytes",
    std::to_string (vayu::core::constants::spec_document::MAX_BYTES), "integer", "Max OpenAPI Document Size",
    "Largest OpenAPI document one collection may bind. The document is stored "
    "verbatim and parsed back by every feature that reads it, so this bounds "
    "both the row and that parse. A larger document is rejected with a message "
    "naming this setting, never stored truncated.",
    "limits", std::to_string (vayu::core::constants::spec_document::MAX_BYTES),
    "1024", "104857600", std::nullopt, now })));

    seed (unit ("bytes") (ConfigEntry{ "maxResponseBodyBytes",
    std::to_string (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES),
    "integer", "Max Load-Test Response Body",
    "Largest response body a single load-test request will read into "
    "memory. A larger response fails that request with an error instead of "
    "being buffered, so load testing a big download or a streaming endpoint "
    "cannot exhaust memory - every in-flight request holds its own body. "
    "Design-mode sends are not affected: they read their own bound, "
    "Max Design Response Body, and keep what they read instead of failing.",
    "limits", std::to_string (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES),
    "1024",       // 1KB
    "1073741824", // 1GB
    std::nullopt, now }));

    seed (unit ("bytes") (ConfigEntry{ "maxDesignResponseBodyBytes",
    std::to_string (vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES),
    "integer", "Max Design Response Body",
    "Largest response body a single Send - or one step of a collection "
    "run - reads into memory. A larger response stops being read at this "
    "point: the response viewer shows what arrived and says the rest was "
    "not read, rather than the whole of it being buffered by the engine and "
    "held again by the app. Re-sending reads the same amount, so raise this "
    "to see more of a big download.",
    "limits", std::to_string (vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES),
    "1024",       // 1KB
    "1073741824", // 1GB
    std::nullopt, now }));

    seed (unit ("bytes") (ConfigEntry{ "maxElementBodyBytes",
    std::to_string (vayu::core::constants::elements::MAX_BODY_BYTES), "integer", "Max Element Body",
    "Largest response body an extract.json or assert.jsonpath element will "
    "parse as JSON. A larger response is not parsed at all: every "
    "JSON-reading element on that step reports skipped, with the reason, "
    "instead of paying for - or failing on - a parse of an oversized body. "
    "The one shared parse is reused by every such element on the same step, "
    "so this is a per-step cost, not a per-element one.",
    "limits", std::to_string (vayu::core::constants::elements::MAX_BODY_BYTES),
    "1024",       // 1KB
    "1073741824", // 1GB
    std::nullopt, now }));

    seed (advanced (keywords ({ "infinite loop" }) (
    ConfigEntry{ "maxStepsPerIteration", "0", "integer", "Max Steps Per Iteration",
    "How many requests one iteration of a collection run may send before it is "
    "stopped. It exists because a script can redirect the sequence with "
    "pm.execution.setNextRequest, and two steps pointing at each other would "
    "otherwise run forever. 0 derives the limit from the collection - ten "
    "times its request count, never fewer than 100.",
    "limits", "0", "0", "1000000", std::nullopt, now })));
}

} // namespace vayu::db::config_seeds
