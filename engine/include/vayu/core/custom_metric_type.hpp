#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file custom_metric_type.hpp
 * @brief `CustomMetricType` alone, in its own header (issue #1500).
 *
 * `core/elements.hpp` (a `metric.record` element's `ElementContext::record_metric`
 * callback) and `runtime/script_engine.hpp` (`pm.metrics`'s `ScriptContext`
 * field) both need this enum but neither should pull in the rest of
 * `core/metrics_collector.hpp` - a `Database`-and-HdrHistogram header - just
 * to name three values. `metrics_collector.hpp` includes this one too, so
 * `MetricsCollector`'s own API is the single place the enum's *meaning* is
 * documented; this file only keeps three modules from disagreeing about its
 * values.
 */

#include <cstdint>

namespace vayu::core {

/// What a `metric.record` element or a `pm.metrics` call names its value as
/// (issue #1500) - k6's own three kinds. See `MetricsCollector::record_custom_metric`
/// for what each does with a recorded value.
enum class CustomMetricType : std::uint8_t {
    Trend,   ///< A distribution; reported as count/p50/p95/p99/max.
    Counter, ///< A running total, incremented by each recorded value.
    Rate,    ///< Share of recorded values that were true, as a percentage.
};

} // namespace vayu::core
