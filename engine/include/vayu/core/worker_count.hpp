#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstddef>
#include <optional>

#include "vayu/db/database.hpp"

namespace vayu::core {

/// What a load run uses when the core count cannot be detected.
inline constexpr unsigned FALLBACK_WORKER_COUNT = 4;

/**
 * The worker count for a core count the OS reported. `hardware_concurrency()`
 * returns 0 when it cannot tell, and a count of 0 workers is not a count: the
 * event loop and `/health` both resolve through here so the fallback is one
 * number, not two.
 */
[[nodiscard]] constexpr unsigned effective_worker_count (unsigned detected) {
    return detected != 0 ? detected : FALLBACK_WORKER_COUNT;
}

/**
 * The `workers` setting's effective value: the configured count when it is
 * non-zero, otherwise the detected core count through
 * @ref effective_worker_count, so it is never 0 - the same rule the event
 * loop applies to a run. `/health` calls this so it reports what a run would
 * actually use rather than the unconditional core count it used to.
 */
int resolve_worker_count (vayu::db::Database& db);

/**
 * @brief The per-host connection limit each event-loop worker runs with
 *        (#2394): the `eventLoopMaxPerHost` setting, raised to the worker's
 *        share of the run's virtual users when that share is larger.
 *
 * Submission is round-robin across workers and the limit is applied per
 * worker, so a worker carries about `ceil(concurrency / workers)` transfers to
 * one host. Below that, libcurl holds the rest in its own queue while the
 * controller counts them as in flight, and the wait reads as target latency.
 * Only ever raises: a configured value above the share is kept.
 *
 * A @p workers of 0 means the count is not known yet; it is sized as one
 * worker carrying every virtual user, which can only over-raise.
 */
[[nodiscard]] constexpr std::size_t
effective_max_per_host (std::size_t configured, std::size_t concurrency, std::size_t workers) {
    const std::size_t divisor = workers != 0 ? workers : 1;
    const std::size_t share   = (concurrency + divisor - 1) / divisor;
    return configured > share ? configured : share;
}

/**
 * @brief Which logical CPU a load-generation worker should pin to, if any.
 *
 * Never 1:1 across every core: this engine shares the machine with the app
 * it is a sidecar for (Electron: main + renderer + GPU process) and the
 * engine's own non-load-gen threads (HTTP server, SQLite writer, the pacing
 * thread). Pinning every worker to every core removes the scheduler's only
 * remedy for that contention, so a worker pinned to the core the UI's
 * compositor happens to be on inherits UI jitter into its latency samples -
 * the run ends up measuring the laptop, not the target.
 *
 * Pins only when there is headroom (`num_workers < num_cpus`), to CPUs
 * `1..num_workers` inclusive, leaving CPU 0 free for the OS/UI/pacing
 * thread. With the default worker count (`hardware_concurrency()`), that
 * means the common case is unpinned; pinning only activates when an
 * operator has explicitly capped `workers` below the core count.
 *
 * Pure and header-only on purpose (no I/O, no OS call): the policy is what a
 * test needs to hold to plain integers, `platform::pin_current_thread` is
 * what actually asks the OS.
 *
 * @return The CPU index to pin to, or std::nullopt to leave the worker
 *   unpinned.
 */
[[nodiscard]] constexpr std::optional<unsigned>
worker_cpu_index (unsigned worker_index, unsigned num_workers, unsigned num_cpus) {
    if (num_cpus == 0 || num_workers >= num_cpus) {
        return std::nullopt;
    }
    return worker_index + 1; // CPU 0 reserved for the OS/UI/pacing thread
}

} // namespace vayu::core
