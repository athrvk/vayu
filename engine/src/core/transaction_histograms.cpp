/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/transaction_histograms.hpp"

#include <algorithm>
#include <stdexcept>

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"

namespace vayu::core {

namespace {

/// Every `control.transaction` name the plan declares, in first-seen plan
/// order - deterministic, so the report's row order does not depend on
/// `unordered_map` iteration. Read through the registry's own `category`,
/// never a `kind ==` comparison outside `core/elements` (#1512's
/// extensibility contract, rule 1).
std::vector<std::string> collect_transaction_names (const ScenarioPlan& plan) {
    std::vector<std::string> names;
    const auto& registry = Registry::instance ();
    for (const auto& step : plan.steps) {
        if (!step.elements) {
            continue;
        }
        for (const auto& element : *step.elements) {
            const auto* kind = registry.find (element.kind);
            if (kind == nullptr || kind->category != "transaction") {
                continue;
            }
            const std::string name = element.config.value ("name", "");
            if (std::find (names.begin (), names.end (), name) == names.end ()) {
                names.push_back (name);
            }
        }
    }
    return names;
}

} // namespace

TransactionHistograms::TransactionHistograms (const ScenarioPlan& plan) {
    for (const auto& name : collect_transaction_names (plan)) {
        auto entry = std::make_unique<Entry> ();
        if (hdr_init (1, constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,
            constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES,
            &entry->histogram) != 0 ||
        entry->histogram == nullptr) {
            throw std::runtime_error (
            "Failed to initialize HdrHistogram for transaction '" + name + "'");
        }
        index_of_name_[name] = entries_.size ();
        names_.push_back (name);
        entries_.push_back (std::move (entry));
    }
}

TransactionHistograms::~TransactionHistograms () {
    for (const auto& entry : entries_) {
        if (entry->histogram != nullptr) {
            hdr_close (entry->histogram);
        }
    }
}

void TransactionHistograms::record (const std::string& name, int64_t latency_ms, bool errored) {
    const auto found = index_of_name_.find (name);
    if (found == index_of_name_.end ()) {
        return; // Not a name the plan declared - defensively ignored.
    }
    Entry& entry = *entries_[found->second];
    entry.count.fetch_add (1, std::memory_order_relaxed);
    if (errored) {
        entry.errors.fetch_add (1, std::memory_order_relaxed);
    }
    hdr_record_value_atomic (entry.histogram, std::max<int64_t> (0, latency_ms) * 1000);
}

nlohmann::json TransactionHistograms::build () const {
    nlohmann::json array = nlohmann::json::array ();
    for (size_t index = 0; index < entries_.size (); ++index) {
        const std::string& name = names_[index];
        const Entry& entry      = *entries_[index];
        const size_t count      = entry.count.load (std::memory_order_relaxed);
        if (count == 0) {
            continue; // Never ran under this run - omitted, not a row of zeros.
        }
        auto* h = entry.histogram;
        auto ms = [] (int64_t us) { return static_cast<double> (us) / 1000.0; };
        array.push_back ({ { "name", name }, { "count", count },
        { "errors", entry.errors.load (std::memory_order_relaxed) },
        { "latency",
        { { "min", ms (hdr_min (h)) }, { "p50", ms (hdr_value_at_percentile (h, 50.0)) },
        { "p90", ms (hdr_value_at_percentile (h, 90.0)) },
        { "p95", ms (hdr_value_at_percentile (h, 95.0)) },
        { "p99", ms (hdr_value_at_percentile (h, 99.0)) }, { "max", ms (hdr_max (h)) } } } });
    }
    return array;
}

} // namespace vayu::core
