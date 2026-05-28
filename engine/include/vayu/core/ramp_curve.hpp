#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/ramp_curve.hpp
 * @brief Closed-form integral of a linear-ramp concurrency curve
 *
 * For RampUpLoadStrategy: configured concurrency is `start` at t=0, climbs
 * linearly to `target` over `ramp_ms`, then holds at `target`. The integral
 * over [0, elapsed_ms] gives the "expected concurrency-time area" that the
 * generator should have delivered. Compared against the running achieved
 * accumulator, the gap is the ramp lag.
 *
 * Units: concurrency · millisecond.
 */

#include <cstddef>
#include <cstdint>

namespace vayu::core {

inline double ramp_curve_integral (int64_t elapsed_ms,
                                    int64_t ramp_ms,
                                    size_t start_concurrency,
                                    size_t target_concurrency) {
    const double start  = static_cast<double> (start_concurrency);
    const double target = static_cast<double> (target_concurrency);
    const double T      = static_cast<double> (elapsed_ms);
    const double R      = static_cast<double> (ramp_ms);

    if (R <= 0.0) {
        // Instant ramp: integral is target × elapsed
        return target * T;
    }
    if (T <= R) {
        // Triangle (start) + ramp slope:
        //   start × T + (target - start) × T² / (2R)
        return start * T + (target - start) * T * T / (2.0 * R);
    }
    // Trapezoid up to R, then flat at target after:
    //   start × R + (target - start) × R / 2  +  target × (T - R)
    const double ramp_part = start * R + (target - start) * R / 2.0;
    return ramp_part + target * (T - R);
}

} // namespace vayu::core
