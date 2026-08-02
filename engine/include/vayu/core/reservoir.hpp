#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstddef>
#include <cstdint>

namespace vayu::core {

/**
 * @brief Where a candidate lands in a bounded store, per Algorithm R.
 *
 * `accepted == false` means the candidate is discarded. Otherwise it either
 * extends the store (`append`) or overwrites the record at `index`, which
 * displaces whatever was there - both cases the caller counts as a drop.
 */
struct ReservoirSlot {
    bool accepted = false;
    bool append   = false;
    size_t index  = 0;
};

/**
 * @brief Reservoir sampling (Algorithm R) decision for one candidate.
 *
 * A load run's completions arrive as a stream whose length is not known when
 * the store fills, so a hard stop at capacity retains the run's *opening* -
 * the least representative part, before connection reuse and DNS caching
 * settle - and nothing after it. Algorithm R keeps every retained record drawn
 * uniformly from the whole stream instead: candidate k (0-based) past capacity
 * is kept with probability capacity/(k+1), replacing a uniformly chosen
 * incumbent.
 *
 * Pure and total so the retention rule is testable without a collector, a run
 * or a thread: the caller supplies the randomness rather than the function
 * owning a generator.
 *
 * @param seen     how many candidates were offered before this one
 * @param capacity how many records the store retains (0 retains nothing - the
 *                 "0 means unlimited" config convention belongs to the caller,
 *                 which must not call here in that case)
 * @param random   an arbitrary 64-bit value; only its remainder is used
 */
[[nodiscard]] constexpr ReservoirSlot
reservoir_slot (size_t seen, size_t capacity, uint64_t random) {
    if (capacity == 0) {
        return ReservoirSlot{ false, false, 0 };
    }
    if (seen < capacity) {
        return ReservoirSlot{ true, true, seen };
    }
    // seen + 1 is the stream length including this candidate, so the modulus
    // cannot be zero and every position - incumbent or newcomer - is equally
    // likely to be the one that survives.
    const size_t index =
    static_cast<size_t> (random % (static_cast<uint64_t> (seen) + 1));
    return ReservoirSlot{ index < capacity, false, index };
}

} // namespace vayu::core
