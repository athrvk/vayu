#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>

#include "vayu/db/database.hpp"

namespace vayu::core {

/**
 * The `workers` setting's effective value: the configured count when it is
 * non-zero, otherwise the detected core count - the same auto-detect rule
 * `execute_load_test` resolves independently for the event loop. `/health`
 * calls this so it reports what a run would actually use rather than the
 * unconditional core count it used to.
 */
int resolve_worker_count (vayu::db::Database& db);

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
