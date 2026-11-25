#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** @brief How long a scenario load run's completed passes took (#3570). */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>

#include "vayu/core/metrics_collector.hpp"

namespace vayu::core {

/**
 * One histogram of pass durations, plus the exact sum and count beside it.
 *
 * Written by every event-loop worker, so a record is `hdr_record_value_atomic`
 * and two relaxed increments, with no lock. The histogram is read only after
 * the run has drained (`build`): a plain hdr read of a histogram still being
 * written races the writers (#2823). `mean_ms` reads only the two atomics,
 * which makes it safe on a gate frame.
 */
class PassDurationRecorder {
    public:
    PassDurationRecorder ();
    ~PassDurationRecorder ();

    PassDurationRecorder (const PassDurationRecorder&)            = delete;
    PassDurationRecorder& operator= (const PassDurationRecorder&) = delete;
    PassDurationRecorder (PassDurationRecorder&&)                 = delete;
    PassDurationRecorder& operator= (PassDurationRecorder&&)      = delete;

    /// One completed pass, @p duration_us long, held between 0 and the
    /// histogram's ceiling.
    void record (int64_t duration_us);

    /// The mean so far in milliseconds, or nothing before the first pass.
    /// Safe while workers record; the sum and the count are read apart, so
    /// a frame can be up to one pass per worker behind on either.
    [[nodiscard]] std::optional<double> mean_ms () const;

    /// `{count, mean, min, p50, p95, p99, max}` in milliseconds, or an empty
    /// object when no pass completed. Read after the drain only.
    [[nodiscard]] nlohmann::json build () const;

    private:
    struct hdr_histogram* histogram_ = nullptr;
    std::atomic<uint64_t> sum_us_{ 0 };
    std::atomic<size_t> count_{ 0 };
};

} // namespace vayu::core
