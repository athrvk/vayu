#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/ramp_lag_tracker.hpp
 * @brief Tracks how far achieved RampUp concurrency-time area lags the
 *        configured ramp curve, as a percentage in [0, 100].
 *
 * Each RampUpLoadStrategy loop iteration calls update() with the wall-time
 * delta since the previous iteration, the configured concurrency for the
 * current instant, and whether this iteration was blocked by backpressure.
 * Backpressured intervals do NOT contribute to the achieved area (the
 * generator failed to deliver load during them) while elapsed time still
 * advances, so the gap against the expected integral grows — that gap,
 * divided by the expected integral, is the ramp lag.
 */

#include <algorithm>
#include <cstddef>
#include <cstdint>

#include "vayu/core/ramp_curve.hpp"

namespace vayu::core {

class RampLagTracker {
    public:
    RampLagTracker (int64_t ramp_ms, size_t start_concurrency, size_t target_concurrency)
    : ramp_ms_ (ramp_ms), start_ (start_concurrency), target_ (target_concurrency) {
    }

    /**
     * @param elapsed_ms             time since ramp start at this iteration
     * @param dt_ms                  wall time since the previous update() call
     * @param configured_concurrency the ramp's intended concurrency now
     * @param backpressured          true if this iteration could not submit
     * @return ramp lag percentage in [0, 100]
     */
    double update (int64_t elapsed_ms,
                   double dt_ms,
                   size_t configured_concurrency,
                   bool backpressured) {
        if (!backpressured) {
            achieved_integral_ms_ += static_cast<double> (configured_concurrency) * dt_ms;
        }
        double expected = ramp_curve_integral (elapsed_ms, ramp_ms_, start_, target_);
        if (expected <= 0.0) {
            return 0.0;
        }
        return std::max (0.0, (expected - achieved_integral_ms_) / expected * 100.0);
    }

    [[nodiscard]] double achieved_integral_ms () const {
        return achieved_integral_ms_;
    }

    private:
    int64_t ramp_ms_;
    size_t  start_;
    size_t  target_;
    double  achieved_integral_ms_ = 0.0;
};

} // namespace vayu::core
