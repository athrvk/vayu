#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <atomic>
#include <memory>
#include <vector>

#include "vayu/http/event_loop.hpp"

namespace vayu::http::detail {

// Forward declarations
struct TransferData;
class EventLoopWorker;

/**
 * @brief Split an aggregate rate-limit budget into one worker's share.
 *
 * Each worker owns a private token bucket and submissions are sharded
 * round-robin, so handing every worker the full `target_rps` made the real
 * aggregate cap `num_workers x target_rps` - the limiter enforced nothing.
 *
 * The one-token burst floor is load-bearing, not cosmetic: `refill_tokens()`
 * clamps the bucket to `burst_size`, so a share below a single token could
 * never accumulate one and that worker would never start a transfer (any run
 * with `target_rps < num_workers`).
 *
 * @return @p config with `target_rps`/`burst_size` scaled to one worker.
 */
EventLoopConfig per_worker_config (const EventLoopConfig& config, size_t num_workers);

/**
 * @brief EventLoop implementation managing a pool of workers
 *
 * Coordinates multiple EventLoopWorker instances, distributing
 * requests across them using round-robin scheduling and aggregating
 * statistics from all workers.
 */
class EventLoopImpl {
    public:
    explicit EventLoopImpl (EventLoopConfig cfg);
    ~EventLoopImpl ();

    void start ();
    void stop (bool wait_for_pending);

    size_t submit (const Request& request, RequestCallback callback, ProgressCallback progress);
    RequestHandle submit_async (const Request& request);
    bool cancel (size_t request_id);
    BatchResult execute_batch (const std::vector<Request>& requests);

    size_t active_count () const;
    size_t pending_count () const;
    size_t total_processed () const;
    EventLoopStats stats () const;

    std::atomic<bool> running{ false };

    private:
    void submit (std::unique_ptr<TransferData> data);

    EventLoopConfig config;
    std::vector<std::unique_ptr<EventLoopWorker>> workers;
    std::atomic<size_t> next_worker{ 0 };
    std::atomic<size_t> next_request_id{ 1 };
};

} // namespace vayu::http::detail
