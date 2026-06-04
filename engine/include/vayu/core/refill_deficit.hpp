#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <algorithm>
#include <cstddef>

namespace vayu::core {

/**
 * @brief Pure closed-loop refill decision: how many requests to submit now to
 * bring in-flight toward the target, never exceeding the remaining budget.
 *
 * @param target           desired in-flight count at this instant (target(t))
 * @param in_flight         current in-flight count (requests_sent - completed)
 * @param budget_remaining  max additional submissions allowed (SIZE_MAX for
 *                          time-bounded modes; M - requests_sent for iterations)
 * @return number of requests to submit this tick (>= 0)
 */
[[nodiscard]] inline size_t compute_refill_deficit (size_t target,
size_t in_flight,
size_t budget_remaining) {
    size_t need = target > in_flight ? target - in_flight : 0;
    return std::min (need, budget_remaining);
}

} // namespace vayu::core
