#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/transaction_histograms.hpp
 * @brief One HdrHistogram per declared `control.transaction` name (issue
 *        #1515), shared by the sequential run and a scenario load run.
 */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>

#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/scenario_plan.hpp"

namespace vayu::core {

/**
 * Every `control.transaction` name a plan declares gets one histogram,
 * allocated up front from a scan of the plan - never discovered mid-run - so
 * recording is index-into-a-fixed-vector-then-atomic-op, the same shape
 * `StepHistograms` uses and, like it, taking **no lock**: issue #1515's own
 * bar for a controller on the load hot path.
 *
 * A `record` naming a transaction the scan never found (there is none today
 * - every occurrence's name comes from the same config the scan reads) is
 * silently ignored rather than growing the map, which is what keeps the
 * no-lock guarantee true after construction.
 */
class TransactionHistograms {
    public:
    explicit TransactionHistograms (const ScenarioPlan& plan);
    ~TransactionHistograms ();

    TransactionHistograms (const TransactionHistograms&)            = delete;
    TransactionHistograms& operator= (const TransactionHistograms&) = delete;
    TransactionHistograms (TransactionHistograms&&)                 = delete;
    TransactionHistograms& operator= (TransactionHistograms&&)      = delete;

    /// One closed occurrence: @p latency_ms is the sum
    /// `control.transaction`'s own accumulator produced, @p errored whether
    /// any member of that pass carried a response error.
    void record (const std::string& name, int64_t latency_ms, bool errored);

    /// `scenario.transactions[]`: `{ name, count, errors, latency }` per
    /// declared name that recorded at least one occurrence - a transaction
    /// the run never reached (a folder `control.if` always skipped, say)
    /// is omitted rather than reported as a row of zeros, on the same
    /// "never ran" convention `StepElementTallies::build` follows.
    [[nodiscard]] nlohmann::json build () const;

    private:
    struct Entry {
        struct hdr_histogram* histogram = nullptr;
        std::atomic<size_t> count{ 0 };
        std::atomic<size_t> errors{ 0 };
    };

    std::unordered_map<std::string, size_t> index_of_name_;
    /// Parallel to `entries_`, in the plan's first-seen order - `build`
    /// reads this rather than `index_of_name_` so the report's row order
    /// does not depend on `unordered_map` iteration.
    std::vector<std::string> names_;
    std::vector<std::unique_ptr<Entry>> entries_;
};

} // namespace vayu::core
