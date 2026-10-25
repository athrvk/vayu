#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_compare.hpp
 * @brief Two load-run reports diffed the way the app diffs them: the
 *        comparison block of the run-report export (#2127).
 *
 * The third implementation of `compareReports`, beside the renderer's
 * `app/src/lib/run-compare.ts` and the MCP server's `app/electron/mcp/compare.ts`.
 * All three replay `engine/tests/fixtures/run-compare-conformance.json`, so a
 * metric, a direction or a comparability rule changed on one side alone reds
 * the side that did not follow. Change the three together.
 */

#include <nlohmann/json.hpp>

#include <array>
#include <string_view>

namespace vayu::core {

/// Which way is better for a metric. `neutral` is a metric that moves with
/// how long a run was told to run, so neither way is an improvement.
inline constexpr std::string_view LOWER_IS_BETTER  = "lower-is-better";
inline constexpr std::string_view HIGHER_IS_BETTER = "higher-is-better";
inline constexpr std::string_view NEUTRAL          = "neutral";

/// One metric the comparison diffs: `report[section][key]`, named
/// `<section>.<key>`.
struct ComparedMetric {
    std::string_view section;
    std::string_view key;
    std::string_view direction;
};

/// The metrics `compareReports` diffs, in its order (latency, throughput,
/// reliability).
inline constexpr auto COMPARED_METRICS = std::to_array<ComparedMetric> ({
{ "latency", "p50", LOWER_IS_BETTER },
{ "latency", "p90", LOWER_IS_BETTER },
{ "latency", "p95", LOWER_IS_BETTER },
{ "latency", "p99", LOWER_IS_BETTER },
{ "latency", "avg", LOWER_IS_BETTER },
{ "latency", "max", LOWER_IS_BETTER },
{ "summary", "avgRps", HIGHER_IS_BETTER },
{ "summary", "throughput", HIGHER_IS_BETTER },
{ "summary", "errorRate", LOWER_IS_BETTER },
{ "summary", "totalRequests", NEUTRAL },
});

/**
 * @p target against @p base, both `GET /runs/:id/report` bodies:
 * `{differences, deltas, statusCodes}`.
 *
 * - `differences[]`: `{field, base, target}`, every way the two runs were not
 *   the same experiment, in `compareReports`' `comparability` order
 *   (`run_type` first), values formatted as the app shows them. When both
 *   reports carry `metadata.runType`, a `mode`, `concurrency` or `target_rps`
 *   only one recorded is a difference, its missing side `not recorded`;
 *   otherwise a field only one report carries is unknown, not a difference
 *   (a data file excepted).
 * - `deltas[]`: `{metric, base, target, delta, pctChange, direction}` per
 *   @ref COMPARED_METRICS; a value a report lacks is `null`, and so is every
 *   figure computed from it. A report whose `summary.summaryMissing` is `true`
 *   has no recorded counts or latency, and one whose `summary.partial` is
 *   `true` no recorded latency (#2904): those figures are `null` on that side,
 *   judged per report. `pctChange` is `null` against a zero base.
 * - `statusCodes`: `{code: {base, target}}` over both runs' codes, a code one
 *   run never saw counting 0.
 */
[[nodiscard]] nlohmann::ordered_json
compare_run_reports (const nlohmann::json& base, const nlohmann::json& target);

} // namespace vayu::core
