#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>

namespace vayu::core {

/**
 * @brief A run's cumulative counters at one metrics tick, on the steady clock.
 *
 * Every counter only grows over a run, so the difference between two samples
 * is what happened between them. TrailingWindow relies on that: a sample
 * pushed with a smaller count than the one before it is a caller's bug.
 */
struct CumulativeCounters {
    int64_t steady_ms        = 0;
    size_t completed         = 0; // MetricsCollector::total_requests
    size_t sent              = 0; // RunContext::requests_sent
    size_t latency_samples   = 0; // MetricsCollector::latency_samples
    double latency_sum_ms    = 0.0;
    double queue_wait_sum_ms = 0.0;
};

/**
 * @brief What the run did over the trailing window ending at one tick
 *        (#2393): the live frame's `currentRps` / `currentSendRate` /
 *        `windowAvg*` keys and the stored row's snake_case twins.
 */
struct WindowReading {
    double completed_per_s = 0.0;
    double sent_per_s      = 0.0;
    /// Means over the latency samples the window gained; nullopt when it
    /// gained none, so an idle window never reads as an instant answer.
    std::optional<double> avg_latency_ms;
    std::optional<double> avg_queue_wait_ms;
};

/**
 * @brief Rates and means over a trailing window of at least `span_ms`.
 *
 * Holds the samples of the last `span_ms` plus one older one, which is the
 * window's base: the newest sample at least `span_ms` before the one pushed.
 * The reading divides by the window's actual span (between `span_ms` and
 * `span_ms` plus one tick interval), never a nominal one. Until a sample that
 * old exists the base is the first sample, so early readings cover everything
 * since it. A first sample, or a window with no time in it, reads zero.
 *
 * Owned by one thread (the metrics thread); not synchronised.
 */
class TrailingWindow {
    public:
    explicit TrailingWindow (int64_t span_ms) : span_ms_ (span_ms) {
    }

    /// Add the counters at @p now and read the window ending there.
    WindowReading push (const CumulativeCounters& now) {
        samples_.push_back (now);
        while (samples_.size () > 1 && samples_.at (1).steady_ms <= now.steady_ms - span_ms_) {
            samples_.pop_front ();
        }
        return reading_between (samples_.front (), now);
    }

    /// Samples held, the base included; bounded by the span over the cadence.
    [[nodiscard]] size_t size () const {
        return samples_.size ();
    }

    private:
    [[nodiscard]] static WindowReading
    reading_between (const CumulativeCounters& base, const CumulativeCounters& now) {
        WindowReading reading;
        const int64_t span_ms = now.steady_ms - base.steady_ms;
        if (span_ms <= 0) {
            return reading;
        }
        const double seconds = static_cast<double> (span_ms) / 1000.0;
        reading.completed_per_s =
        static_cast<double> (now.completed - base.completed) / seconds;
        reading.sent_per_s = static_cast<double> (now.sent - base.sent) / seconds;

        const size_t samples = now.latency_samples - base.latency_samples;
        if (samples == 0) {
            return reading;
        }
        const auto count = static_cast<double> (samples);
        reading.avg_latency_ms = (now.latency_sum_ms - base.latency_sum_ms) / count;
        reading.avg_queue_wait_ms =
        (now.queue_wait_sum_ms - base.queue_wait_sum_ms) / count;
        return reading;
    }

    int64_t span_ms_;
    std::deque<CumulativeCounters> samples_;
};

} // namespace vayu::core
