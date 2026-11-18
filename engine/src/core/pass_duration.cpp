/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/pass_duration.hpp"

#include <algorithm>
#include <stdexcept>

#include "vayu/core/constants.hpp"

namespace vayu::core {

namespace {

double us_to_ms (int64_t us) {
    return static_cast<double> (us) / 1000.0;
}

} // namespace

PassDurationRecorder::PassDurationRecorder () {
    if (hdr_init (1, constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,
        constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES, &histogram_) != 0 ||
    histogram_ == nullptr) {
        throw std::runtime_error (
        "Failed to initialize HdrHistogram for pass durations");
    }
}

PassDurationRecorder::~PassDurationRecorder () {
    if (histogram_ != nullptr) {
        hdr_close (histogram_);
    }
}

void PassDurationRecorder::record (int64_t duration_us) {
    // The sum takes the clamped value too, so the mean never exceeds `max`.
    const int64_t held = clamp_to_histogram_ceiling (std::max<int64_t> (0, duration_us));
    hdr_record_value_atomic (histogram_, held);
    sum_us_.fetch_add (static_cast<uint64_t> (held), std::memory_order_relaxed);
    count_.fetch_add (1, std::memory_order_relaxed);
}

std::optional<double> PassDurationRecorder::mean_ms () const {
    const size_t count = count_.load (std::memory_order_relaxed);
    if (count == 0) {
        return std::nullopt;
    }
    const uint64_t sum_us = sum_us_.load (std::memory_order_relaxed);
    return static_cast<double> (sum_us) / 1000.0 / static_cast<double> (count);
}

nlohmann::json PassDurationRecorder::build () const {
    const auto mean = mean_ms ();
    if (!mean) {
        return nlohmann::json::object ();
    }
    return { { "count", count_.load (std::memory_order_relaxed) },
        { "mean", *mean }, { "min", us_to_ms (hdr_min (histogram_)) },
        { "p50", us_to_ms (hdr_value_at_percentile (histogram_, 50.0)) },
        { "p95", us_to_ms (hdr_value_at_percentile (histogram_, 95.0)) },
        { "p99", us_to_ms (hdr_value_at_percentile (histogram_, 99.0)) },
        { "max", us_to_ms (hdr_max (histogram_)) } };
}

} // namespace vayu::core
