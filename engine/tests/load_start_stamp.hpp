#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/load_start_stamp.hpp
 * @brief `stamp_load_start` - give a bare `RunContext` the load-start stamp
 *        `execute_load_test` writes once setup is done (issue #2881).
 */

#include <chrono>

#include "vayu/core/run_manager.hpp"

namespace vayu::tests {

/// No metric tick is stored before load start, so a test that drives
/// `collect_metrics` on a context no worker stamped must stamp it first.
inline void stamp_load_start (vayu::core::RunContext& context) {
    context.load_start_steady_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
                                   .count ();
}

} // namespace vayu::tests
