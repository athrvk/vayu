/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/run_result_summary.hpp"

#include <string>
#include <utility>

namespace vayu::core {

namespace {

std::optional<AssertionTotals>
read_assertion_totals (const nlohmann::json& parent, const char* key) {
    const auto stored = parent.find (key);
    if (stored == parent.end () || !stored->is_object ()) {
        return std::nullopt;
    }
    const auto passed = stored->find ("passed");
    const auto failed = stored->find ("failed");
    if (passed == stored->end () || !passed->is_number_unsigned () ||
    failed == stored->end () || !failed->is_number_unsigned ()) {
        return std::nullopt;
    }
    return AssertionTotals{ .passed = passed->get<size_t> (),
        .failed                     = failed->get<size_t> () };
}

std::optional<size_t> read_count (const nlohmann::json& parent, const char* key) {
    const auto stored = parent.find (key);
    if (stored == parent.end () || !stored->is_number_unsigned ()) {
        return std::nullopt;
    }
    return stored->get<size_t> ();
}

// An element row whose `failed` is a failed assertion: an `assert.*` outcome,
// or a `script.*` run whose `pm.test` failed.
bool is_assertion_row (const nlohmann::json& row) {
    const auto kind = row.find ("kind");
    if (kind == row.end () || !kind->is_string ()) {
        return false;
    }
    const auto& name = kind->get_ref<const std::string&> ();
    return name.starts_with ("assert.") || name.starts_with ("script.");
}

// A single-request summary stored before the block: its `elements` rows,
// counted per execution as #3458's row read them. A required `extract.*` miss
// is `missing` there and stays out; the stored block counts it.
std::optional<AssertionTotals> legacy_element_assertions (const nlohmann::json& summary) {
    const auto elements = summary.find ("elements");
    if (elements == summary.end () || !elements->is_array ()) {
        return std::nullopt;
    }
    AssertionTotals totals;
    bool recorded = false;
    for (const auto& row : *elements) {
        const auto failed = read_count (row, "failed");
        if (!failed || !is_assertion_row (row)) {
            continue;
        }
        recorded = true;
        totals.failed += *failed;
        totals.passed += read_count (row, "passed").value_or (0);
    }
    if (!recorded) {
        return std::nullopt;
    }
    return totals;
}

// What the readers before the block derived (#2820, #3458), and only that, so
// a stored run keeps the reading it had.
std::optional<RunAssertions> derive_legacy_assertions (const nlohmann::json& summary) {
    RunAssertions derived;
    if (const auto scenario = summary.find ("scenario"); scenario != summary.end ()) {
        derived.exact = read_assertion_totals (*scenario, "assertions");
    } else {
        derived.exact   = legacy_element_assertions (summary);
        derived.sampled = read_assertion_totals (summary, "tests");
    }
    if (!derived.exact && !derived.sampled) {
        return std::nullopt;
    }
    return derived;
}

// The stored whole-run p95, unless the run timed no request: a stored 0 there
// is no measurement, the marker the report's latency reader honours too. A
// summary written before `latency.count` existed has none, so its p95 stands.
std::optional<double> read_timed_p95 (const nlohmann::json& summary) {
    const auto latency = summary.find ("latency");
    if (latency == summary.end () || !latency->is_object ()) {
        return std::nullopt;
    }
    const auto count = latency->find ("count");
    if (count != latency->end () && count->is_number () && count->get<double> () <= 0) {
        return std::nullopt;
    }
    const auto p95 = latency->find ("p95");
    if (p95 == latency->end () || !p95->is_number ()) {
        return std::nullopt;
    }
    return p95->get<double> ();
}

// The budget verdict the stored summary recorded, or no key when no budget
// judged the run - as stored, so a stopped run keeps the verdict it was given.
void record_verdict (const nlohmann::json& summary, nlohmann::json& outcome) {
    if (const auto thresholds = read_threshold_outcome (summary)) {
        outcome["verdict"] = thresholds->verdict ();
    }
}

// The assertion block a load row carries (#3537), the report's own, beside
// `assertionsPassed` / `assertionsFailed` over both populations for readers
// older than it (#2820, #3458). All three or none.
void record_assertions (const nlohmann::json& summary, nlohmann::json& outcome) {
    if (const auto assertions = read_run_assertions (summary)) {
        outcome["assertions"]       = run_assertions_json (*assertions);
        outcome["assertionsPassed"] = assertions->passed ();
        outcome["assertionsFailed"] = assertions->failed ();
    }
}

// The drain a Stop cut (#3538), beside the stored `verdict` it leaves as it
// is: a reader judges a cut run not judged once no budget failed it.
void record_drain_cut (const nlohmann::json& summary, nlohmann::json& outcome) {
    if (const auto drain_cut = read_drain_cut (summary)) {
        outcome["drainCut"] = drain_cut_json (*drain_cut);
    }
}

// --- the row's verdict ------------------------------------------------------
//
// Each helper below is one function of `run-outcome.ts`, under the renderer's
// truthiness: a member that is absent, or not a number, counts as none.

const nlohmann::json& member (const nlohmann::json& parent, const char* key) {
    static const nlohmann::json absent;
    if (!parent.is_object ()) {
        return absent;
    }
    const auto found = parent.find (key);
    return found == parent.end () ? absent : *found;
}

bool above_zero (const nlohmann::json& value) {
    return value.is_number () && value.get<double> () > 0;
}

bool verdict_is (const nlohmann::json& result_summary, const char* verdict) {
    const auto& stored = member (result_summary, "verdict");
    return stored.is_string () && stored.get_ref<const std::string&> () == verdict;
}

// `drainCutCancelledOf`: a positive integer, or no cut.
bool drain_was_cut (const nlohmann::json& result_summary) {
    const auto& cancelled = member (member (result_summary, "drainCut"), "cancelled");
    return cancelled.is_number_integer () && above_zero (cancelled);
}

// `failedCheckPhrases` over `failedChecksOf (rowAssertionsOf (...))` is
// non-empty.
bool a_check_failed (const nlohmann::json& result_summary) {
    const auto& assertions = member (result_summary, "assertions");
    return above_zero (member (member (assertions, "exact"), "failed")) ||
    above_zero (member (member (assertions, "sampled"), "failed")) ||
    above_zero (member (assertions, "errored")) ||
    above_zero (member (assertions, "teardownFailed"));
}

// `judgeRun`, its reasons dropped.
std::optional<RunOutcome> judge_load_row (RunStatus status, const nlohmann::json& result_summary) {
    if (status == RunStatus::Stopped) {
        return RunOutcome::NotJudged;
    }
    if (status != RunStatus::Completed && status != RunStatus::Failed) {
        return std::nullopt;
    }
    if (status == RunStatus::Failed || verdict_is (result_summary, "failed")) {
        return RunOutcome::Failed;
    }
    if (drain_was_cut (result_summary)) {
        return RunOutcome::NotJudged;
    }
    if (!verdict_is (result_summary, "passed")) {
        return RunOutcome::NotJudged;
    }
    const bool undercut = above_zero (member (result_summary, "errorRate")) ||
    a_check_failed (result_summary);
    return undercut ? RunOutcome::NotJudged : RunOutcome::Passed;
}

// `judgeCollection` over the row's counts and its unnamed budget verdict.
std::optional<RunOutcome>
judge_collection_row (RunStatus status, const nlohmann::json& result_summary) {
    if (status != RunStatus::Completed) {
        return std::nullopt;
    }
    const bool unclean = verdict_is (result_summary, "failed") ||
    above_zero (member (result_summary, "failed")) ||
    above_zero (member (result_summary, "errored"));
    return unclean ? std::optional<RunOutcome> (RunOutcome::Failed) : std::nullopt;
}

} // namespace

void copy_optional_number (const nlohmann::json& from,
const char* from_key,
nlohmann::json& to,
const char* to_key) {
    if (from.contains (from_key) && from[from_key].is_number ()) {
        to[to_key] = from[from_key];
    }
}

std::optional<StoredThresholds> read_threshold_outcome (const nlohmann::json& summary) {
    if (!summary.contains ("thresholds") || !summary["thresholds"].is_object ()) {
        return std::nullopt;
    }
    const auto& thresholds = summary["thresholds"];
    if (!thresholds.contains ("checks") || !thresholds["checks"].is_array () ||
    thresholds["checks"].empty ()) {
        return std::nullopt;
    }
    StoredThresholds outcome;
    outcome.checks = thresholds["checks"];
    read_number (thresholds, "passed", outcome.passed);
    read_number (thresholds, "failed", outcome.failed);
    return outcome;
}

std::optional<RunAssertions> read_run_assertions (const nlohmann::json& summary) {
    const auto block = summary.find ("assertions");
    if (block == summary.end () || !block->is_object ()) {
        return derive_legacy_assertions (summary);
    }
    return RunAssertions{ .exact = read_assertion_totals (*block, "exact"),
        .sampled                 = read_assertion_totals (*block, "sampled"),
        .errored                 = read_count (*block, "errored"),
        .teardown_failed         = read_count (*block, "teardownFailed") };
}

nlohmann::json assertion_totals_json (const AssertionTotals& totals) {
    return { { "passed", totals.passed }, { "failed", totals.failed } };
}

nlohmann::json run_assertions_json (const RunAssertions& assertions) {
    nlohmann::json block = nlohmann::json::object ();
    if (const auto& exact = assertions.exact) {
        block["exact"] = assertion_totals_json (*exact);
    }
    if (const auto& sampled = assertions.sampled) {
        block["sampled"] = assertion_totals_json (*sampled);
    }
    if (const auto& errored = assertions.errored) {
        block["errored"] = *errored;
    }
    if (const auto& teardown_failed = assertions.teardown_failed) {
        block["teardownFailed"] = *teardown_failed;
    }
    return block;
}

std::optional<size_t> read_drain_cut (const nlohmann::json& summary) {
    const auto block = summary.find ("drainCut");
    if (block == summary.end () || !block->is_object ()) {
        return std::nullopt;
    }
    const auto cancelled = read_count (*block, "cancelled");
    return cancelled.value_or (0) > 0 ? cancelled : std::nullopt;
}

nlohmann::json drain_cut_json (size_t cancelled) {
    return { { "cancelled", cancelled } };
}

std::optional<nlohmann::json> read_capacity_headline (const nlohmann::json& stored) {
    if (!stored.contains ("levels") || !stored["levels"].is_array ()) {
        return std::nullopt;
    }
    nlohmann::json headline;
    headline["stopReason"] =
    stored.contains ("stop_reason") && stored["stop_reason"].is_string () ?
    stored["stop_reason"].get<std::string> () :
    std::string{};
    copy_optional_number (stored, "max_healthy_concurrency", headline, "maxHealthyConcurrency");
    copy_optional_number (stored, "knee_concurrency", headline, "kneeConcurrency");
    return std::optional<nlohmann::json> (std::in_place, std::move (headline));
}

std::map<int, size_t> read_status_codes (const nlohmann::json& codes) {
    std::map<int, size_t> distribution;
    for (const auto& [code_str, count] : codes.items ()) {
        try {
            distribution[std::stoi (code_str)] = count.get<size_t> ();
        } catch (...) {
            // @deliberate: skip an unparseable code rather than losing the
            // whole map - every other key is still an honest count.
        }
    }
    return distribution;
}

nlohmann::json load_result_summary (const std::string& summary_json) {
    nlohmann::json outcome = nlohmann::json::object ();
    const auto summary =
    nlohmann::json::parse (summary_json, nullptr, /*allow_exceptions=*/false);
    if (!summary.is_object ()) {
        return outcome;
    }

    if (summary.contains ("rps") && summary["rps"].is_number ()) {
        outcome["rps"] = summary["rps"];
    }
    if (const auto p95 = read_timed_p95 (summary)) {
        outcome["p95Ms"] = *p95;
    }
    if (summary.contains ("status_codes") && summary["status_codes"].is_object ()) {
        const auto failures = vayu::count_status_failures (
        read_status_codes (summary["status_codes"]));
        // No request recorded is no rate at all, not a run with 0% errors.
        if (failures.total > 0) {
            outcome["errorRate"] = failures.error_rate ();
        }
    }
    record_verdict (summary, outcome);
    record_assertions (summary, outcome);
    record_drain_cut (summary, outcome);
    if (summary.contains ("capacity") && summary["capacity"].is_object ()) {
        if (auto headline = read_capacity_headline (summary["capacity"])) {
            outcome["capacity"] = std::move (*headline);
        }
    }
    return outcome;
}

nlohmann::json scenario_result_summary (const std::string& summary_json) {
    nlohmann::json outcome = nlohmann::json::object ();
    const auto summary =
    nlohmann::json::parse (summary_json, nullptr, /*allow_exceptions=*/false);
    if (!summary.is_object () || !summary.contains ("scenario") ||
    !summary["scenario"].is_object ()) {
        return outcome;
    }

    const auto& scenario = summary["scenario"];
    copy_optional_number (scenario, "passed", outcome, "passed");
    copy_optional_number (scenario, "failed", outcome, "failed");
    copy_optional_number (scenario, "skipped", outcome, "skipped");
    copy_optional_number (scenario, "errored", outcome, "errored");
    copy_optional_number (scenario, "stopped", outcome, "stopped");
    record_verdict (summary, outcome);
    return outcome;
}

bool carries_result_summary (const vayu::db::Run& run) {
    const bool summarised =
    run.type == vayu::RunType::Load || run.type == vayu::RunType::Scenario;
    return summarised && !run.summary.empty () && vayu::is_terminal (run.status);
}

nlohmann::json terminal_result_summary (const vayu::db::Run& run) {
    return run.type == vayu::RunType::Scenario ?
    scenario_result_summary (run.summary) :
    load_result_summary (run.summary);
}

std::optional<RunOutcome>
judge_run_row (RunType type, RunStatus status, const nlohmann::json& result_summary) {
    if (!result_summary.is_object () || result_summary.empty ()) {
        return std::nullopt;
    }
    switch (type) {
    case RunType::Load: return judge_load_row (status, result_summary);
    case RunType::Scenario:
        return judge_collection_row (status, result_summary);
    case RunType::Design: return std::nullopt;
    }
    return std::nullopt;
}

std::optional<RunOutcome> stored_run_outcome (const vayu::db::Run& run) {
    if (!carries_result_summary (run)) {
        return std::nullopt;
    }
    return judge_run_row (run.type, run.status, terminal_result_summary (run));
}

} // namespace vayu::core
