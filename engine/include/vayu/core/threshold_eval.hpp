#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file threshold_eval.hpp
 * @brief Pure core for a run's pass/fail budgets: what a `thresholds` object
 *        may say, and what verdict the run's own numbers give it.
 *
 * A load run measures everything and, before this, judged nothing - the report
 * carried percentiles and an error rate, and "did that meet the budget" was a
 * question only a human reading numbers could answer. The two halves live
 * together here on purpose: `validate_thresholds` (the route's gate) and
 * `evaluate_thresholds` (the run's verdict) read the *same* metric table, so a
 * key the route accepts cannot be one the evaluator silently ignores.
 *
 * Both are total functions over arbitrary JSON: the route's copy is handed a
 * client body, and the evaluator's is handed a stored config snapshot which may
 * have been written by an older engine or hand-edited.
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

// Declared, not included: `evaluate_thresholds` reads the same whole-run
// results the summary is built from, and run_manager.hpp includes this header
// for `ThresholdOutcome`. Taking it by const reference keeps that one-way.
struct RunSummaryInputs;

/// One declared budget and how the run measured against it.
struct ThresholdCheck {
    /// The wire key the budget was declared under, e.g. "latencyP99Ms".
    std::string metric;
    double limit  = 0.0;
    double actual = 0.0;
    bool passed   = false;
};

/// Every declared budget's verdict. `failed == 0` is the run's pass.
struct ThresholdOutcome {
    std::vector<ThresholdCheck> checks;
    size_t passed = 0;
    size_t failed = 0;
};

/**
 * @brief Reject a `thresholds` object the run could not act on.
 *
 * Reads @p config (the whole run config), and looks only at its `thresholds`
 * key - an absent one is valid, since budgets are opt-in. Present means it must
 * be usable: an object, carrying at least one known budget, every key drawn
 * from the metric table and every value finite and in range. A `null` value is
 * read as absent, the same rule the flat numeric fields follow, so a client
 * that sends its unset fields as nulls is not punished for it - but an object
 * that says nothing after that is rejected rather than stored as a budget the
 * report will never mention.
 *
 * @return Why the object is unusable, or `std::nullopt` if it is.
 */
[[nodiscard]] std::optional<std::string> validate_thresholds (const nlohmann::json& config);

/**
 * @brief Judge a completed run against the budgets its config declared.
 *
 * Evaluated off the same @ref RunSummaryInputs the stored summary is built
 * from, so the verdict and the numbers printed beside it cannot disagree. The
 * error rate is derived the way the report derives its own - every status
 * outside 2xx/3xx counts as a failure, including the transport errors recorded
 * under code 0 - rather than from the collector's transport-error-only count,
 * which would call a run of nothing but 500s clean.
 *
 * @return `std::nullopt` when the config declared no usable budgets, which is
 *         what keeps the report's section absent rather than zeroed. A run
 *         stopped early still reports what it measured.
 */
[[nodiscard]] std::optional<ThresholdOutcome>
evaluate_thresholds (const nlohmann::json& config, const RunSummaryInputs& inputs);

} // namespace vayu::core
