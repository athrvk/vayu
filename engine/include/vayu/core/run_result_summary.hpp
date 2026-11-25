#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief What a terminal run's stored `summary` says on its `GET /runs` row:
 *        the `resultSummary` (#2130, #2954), and the verdict the renderer
 *        draws from it, which `runs.outcome` stores (#3547).
 *
 * The readers here are the one reading of the stored summary's `thresholds`,
 * `assertions` (and what stood for it before #3537), `drainCut` and
 * `capacity` blocks, shared with the report route (`routes/runs.cpp`), so a
 * row and a report cannot read one stored run two ways.
 *
 * @ref judge_run_row is the renderer's `rowOutcome`
 * (`app/src/components/shared/run-outcome.ts`) over the same `resultSummary`
 * the row carries; `tests/fixtures/run-row-outcome-conformance.json` pins the
 * two. Everything here is pure: no database, no clock.
 */

#include <cstddef>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

#include "vayu/core/threshold_eval.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/// Read a number out of a JSON object, leaving @p out untouched when the key is
/// absent or not a number - so a summary written by an older engine (or a
/// partial one from a crashed run) falls back to the caller's value instead of
/// zeroing it.
template <typename T>
void read_number (const nlohmann::json& obj, const char* key, T& out) {
    if (obj.contains (key) && obj[key].is_number ()) {
        out = obj[key].get<T> ();
    }
}

/// Copy a stored number to @p to under the reader's name, or leave the key
/// absent: a summary written before a figure existed measured nothing, and
/// reading that as 0 would report something nothing checked.
void copy_optional_number (const nlohmann::json& from,
const char* from_key,
nlohmann::json& to,
const char* to_key);

/// The run's verdict against its declared budgets, as its stored summary's
/// `thresholds` object recorded it: read for both the report's
/// `thresholdValidation` and a row's `resultSummary.verdict`.
struct StoredThresholds {
    // Per-budget rows verbatim from the summary, already in the report's
    // camelCase shape - the evaluator writes the wire keys.
    nlohmann::json checks = nlohmann::json::array ();
    size_t passed         = 0;
    size_t failed         = 0;

    // Derived rather than stored so it cannot contradict the counts beside it.
    [[nodiscard]] const char* verdict () const {
        return failed == 0 ? "passed" : "failed";
    }
};

/// The stored summary's budget verdict, or nothing when the run was never
/// judged. A stored object with no readable `checks` is treated as absent
/// rather than reported as a run that passed and failed nothing.
[[nodiscard]] std::optional<StoredThresholds> read_threshold_outcome (
const nlohmann::json& summary);

/// A load run's assertion block (#3537), what every verdict reads as a failed
/// check. A member is empty when the summary recorded no such figure: a
/// summary stored before the block yields only what the readers of that time
/// derived.
struct RunAssertions {
    std::optional<AssertionTotals> exact;
    std::optional<AssertionTotals> sampled;
    std::optional<size_t> errored;
    std::optional<size_t> teardown_failed;

    // Over both populations: the list row's flat `assertionsPassed` /
    // `assertionsFailed`, kept for readers older than the block.
    [[nodiscard]] size_t passed () const {
        return exact.value_or (AssertionTotals{}).passed +
        sampled.value_or (AssertionTotals{}).passed;
    }
    [[nodiscard]] size_t failed () const {
        return exact.value_or (AssertionTotals{}).failed +
        sampled.value_or (AssertionTotals{}).failed;
    }
};

/// The run's `assertions` block, or nothing when it recorded none. The one
/// reader of it, and the one place a summary stored before the block is read
/// for it: a scenario load run's exact pair (#2820), a single-request run's
/// element rows and replay (#3458), neither deriving `errored` or
/// `teardownFailed`, which no verdict read then.
[[nodiscard]] std::optional<RunAssertions> read_run_assertions (const nlohmann::json& summary);

[[nodiscard]] nlohmann::json assertion_totals_json (const AssertionTotals& totals);

/// @p assertions in the stored block's shape, each member only when recorded.
[[nodiscard]] nlohmann::json run_assertions_json (const RunAssertions& assertions);

/// The requests a Stop cut from the run's drain (#3538), or nothing when the
/// summary records no cut (or a cut of zero).
[[nodiscard]] std::optional<size_t> read_drain_cut (const nlohmann::json& summary);

[[nodiscard]] nlohmann::json drain_cut_json (size_t cancelled);

/// A stored `capacity` section's headline in the report's names: why the
/// search stopped and, each only when stored, the highest level it held and
/// the level it broke at (#2930). Nothing when the section carries no `levels`.
[[nodiscard]] std::optional<nlohmann::json> read_capacity_headline (
const nlohmann::json& stored);

/// A stored summary's `status_codes` object as the distribution it records,
/// an unparseable code skipped rather than losing the whole map.
[[nodiscard]] std::map<int, size_t> read_status_codes (const nlohmann::json& codes);

/**
 * @brief A terminal load run's `resultSummary` (#2130): throughput, tail
 * latency, error rate, budget verdict, its assertion block (#3537), the drain
 * a Stop cut (#3538) or, for a capacity run, the search's headline (#2930).
 *
 * Each key is omitted when the summary does not record it, never zeroed: no
 * `verdict` means no budget judged the run. `errorRate` is a percentage
 * (0-100) by `vayu::count_status_failures`, absent when no request was
 * recorded. An empty or unreadable summary answers an empty object, which the
 * row leaves off. Parses and nothing more, because `RunSummaryCache` calls it
 * under its lock.
 */
[[nodiscard]] nlohmann::json load_result_summary (const std::string& summary_json);

/**
 * @brief A terminal collection (sequential scenario) run's `resultSummary`
 * (#2954): its step counts (`passed`, `failed`, `skipped`, `errored`,
 * `stopped`, #3397) and the budget verdict, each only when recorded. A summary
 * with no `scenario` object answers an empty object.
 */
[[nodiscard]] nlohmann::json scenario_result_summary (const std::string& summary_json);

/// Whether a row of @p run carries a `resultSummary` built from its stored
/// summary: a load or collection run at a terminal status with a summary
/// stored. A Pending or Running row's summary is not final yet, and neither is
/// an empty one: the inactive branch of `POST /runs/:id/stop` writes Stopped
/// before the worker writes its summary.
[[nodiscard]] bool carries_result_summary (const vayu::db::Run& run);

/// @ref scenario_result_summary or @ref load_result_summary by the run's type.
[[nodiscard]] nlohmann::json terminal_result_summary (const vayu::db::Run& run);

/**
 * @brief The verdict a `GET /runs` row draws from its own `resultSummary`: the
 * renderer's `rowOutcome`, rule for rule.
 *
 * A `failed` status is failed for every run type, ahead of everything below
 * and with no `resultSummary` needed: the list draws the failed mark from the
 * status alone, so a failed design run, a run that failed before a summary
 * was written and a crash orphan with no tick are failed too (#3643).
 *
 * Any other row with no or an empty `resultSummary`, a design run, and every
 * row below that answers no verdict has nothing (it keeps its status glyph).
 *
 * A load row is judged in this order: `stopped` is not judged; any other
 * status but `completed` is nothing; a missed budget (`verdict: "failed"`) is
 * failed; a Stop that cut the drain (`drainCut.cancelled` a positive integer)
 * is not judged; no budget
 * (`verdict` absent) is not judged; met budgets are passed unless the error
 * rate is above zero or a check failed (`assertions` `exact.failed`,
 * `sampled.failed`, `errored`, `teardownFailed`), which is not judged. The
 * renderer also reads a flat `assertionsFailed` on a row without the block,
 * from an engine before #3537; this engine writes the two together, so the
 * block is the whole input here.
 *
 * A collection row is failed when it `completed` with a missed budget or a
 * step that failed or errored, and nothing otherwise: a collection run is
 * never judged passed, and a stopped one says nothing.
 */
[[nodiscard]] std::optional<RunOutcome>
judge_run_row (RunType type, RunStatus status, const nlohmann::json& result_summary);

/// What `runs.outcome` stores for @p run: @ref judge_run_row over the
/// `resultSummary` its row carries (an empty one when it carries none, which
/// only a failed status judges).
[[nodiscard]] std::optional<RunOutcome> stored_run_outcome (const vayu::db::Run& run);

} // namespace vayu::core
