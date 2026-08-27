#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "vayu/core/spsc_queue.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/rate_limiter.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;

/**
 * @brief Whether a DNS cache entry stored `age` ago may still be used.
 *
 * @param negative   The entry remembers a failed lookup rather than an address.
 * @param ttl_seconds >0 entry lifetime, 0 caching disabled, <0 never expires.
 *
 * A remembered failure lives for the shorter of the configured TTL and
 * DNS_NEGATIVE_CACHE_SECONDS - and expires even when addresses are configured
 * never to, because "this host does not resolve" is the claim most likely to
 * stop being true while the daemon runs.
 */
[[nodiscard]] bool
dns_entry_is_fresh (bool negative, std::chrono::steady_clock::duration age, long ttl_seconds);

/**
 * @brief Thread-safe DNS cache for pre-resolved hostnames
 *
 * Resolves hostnames once and caches the IP addresses to avoid overwhelming
 * the system DNS resolver under high load.
 *
 * Entries expire. The cached address is pinned onto every transfer with
 * `CURLOPT_RESOLVE`, which curl treats as authoritative - so an entry that
 * never expired would outlive a DNS change for the whole process lifetime
 * (this cache is shared by every worker and every run), and every request to
 * that host would fail until the daemon restarted. The TTL is the caller's
 * `dnsCacheTimeout`, the same setting curl's own cache uses.
 *
 * Failed lookups are cached too, briefly: `resolve` runs a blocking
 * getaddrinfo on the event loop worker thread, so an unresolvable host that
 * was never remembered re-blocked that thread - stalling every in-flight
 * transfer it owns - once per request, forever.
 */
class DnsCache {
    public:
    /// Hostname -> address, or empty string when the lookup failed.
    using Resolver = std::function<std::string (const std::string&)>;

    /// Uses the system resolver. Tests inject a stub to make TTL and
    /// negative-cache behaviour deterministic and to count lookups.
    DnsCache ();
    explicit DnsCache (Resolver resolver);

    /// Pre-resolve a hostname, honouring and refreshing the cache.
    /// @param ttl_seconds >0 entry lifetime, 0 disables caching, <0 never expires
    /// @return the resolved IP, or an empty string on failure
    std::string resolve (const std::string& hostname, long ttl_seconds);

    /// Get curl-compatible resolve entry: "hostname:port:ip"
    /// Returns nullptr if the hostname could not be resolved
    struct curl_slist* get_resolve_list (const std::string& hostname, int port, long ttl_seconds);

    /// Clear the cache
    void clear ();

    /// Number of entries currently held (including negative ones)
    size_t size () const;

    private:
    struct Entry {
        std::string ip; // Empty for a remembered failure
        std::chrono::steady_clock::time_point stored_at;
    };

    static bool is_fresh (const Entry& entry, long ttl_seconds);

    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, Entry> cache_;
    Resolver resolver_;
};

/**
 * @brief High-performance CURL handle pool (Single-Threaded)
 *
 * Reuses curl_easy handles instead of creating new ones for each request.
 * curl_easy_init() takes ~100µs, curl_easy_reset() takes ~1µs.
 * At 60k RPS, this saves ~6 seconds per second of CPU time.
 *
 * NOTE: This pool is NOT thread-safe. It is designed to be used by a single
 * EventLoopWorker thread. Each worker has its own pool instance.
 */
class CurlHandlePool {
    public:
    explicit CurlHandlePool (size_t initial_size = 100);
    ~CurlHandlePool ();

    // Prevent copying
    CurlHandlePool (const CurlHandlePool&)            = delete;
    CurlHandlePool& operator= (const CurlHandlePool&) = delete;
    CurlHandlePool (CurlHandlePool&&)                 = delete;
    CurlHandlePool& operator= (CurlHandlePool&&)      = delete;

    /// Acquire a handle from the pool (or create new if empty)
    /// The handle is reset and ready for configuration
    /// NOTE: Not thread-safe - call only from owning worker thread
    CURL* acquire ();

    /// Return a handle to the pool for reuse
    /// NOTE: Not thread-safe - call only from owning worker thread
    void release (CURL* handle);

    /// Get pool statistics
    size_t pool_size () const {
        return pool_.size ();
    }
    size_t total_created () const {
        return total_created_;
    }
    size_t total_reused () const {
        return total_reused_;
    }

    private:
    // No mutex needed - single-threaded access per worker
    std::queue<CURL*> pool_;
    size_t total_created_{ 0 };
    size_t total_reused_{ 0 };
};

/**
 * @brief Single worker thread running its own curl_multi event loop
 *
 * Each worker maintains:
 * - Its own curl_multi handle for concurrent transfers
 * - A pending queue for incoming requests
 * - Active transfers map for in-flight requests
 * - Rate limiter for controlling throughput
 */
// The analyzer would reorder the fields to save 84 padding bytes. Declaration
// order here follows the lifecycle (queue, loop state, transfers, limiter,
// flags) and is what the constructor's initialization order hangs off; one
// worker exists per thread, so the bytes saved would be a few hundred per
// process for a reordering that costs the reader the grouping.
// NOLINTNEXTLINE(clang-analyzer-optin.performance.Padding)
class EventLoopWorker {
    public:
    explicit EventLoopWorker (const EventLoopConfig& cfg);
    ~EventLoopWorker ();

    // Prevent copying
    EventLoopWorker (const EventLoopWorker&)            = delete;
    EventLoopWorker& operator= (const EventLoopWorker&) = delete;
    EventLoopWorker (EventLoopWorker&&)                 = delete;
    EventLoopWorker& operator= (EventLoopWorker&&)      = delete;

    void start ();
    /// See EventLoop::stop. `drain_timeout` bounds the drain when
    /// `wait_for_pending` is true; zero means unbounded.
    void stop (bool wait_for_pending,
    std::chrono::milliseconds drain_timeout = std::chrono::milliseconds::zero ());
    void submit (std::unique_ptr<TransferData> data);

    size_t active_count () const;
    size_t pending_count () const;

    // Thread-local stats (lock-free)
    std::atomic<size_t> local_processed{ 0 };

    private:
    // Allow EventLoopImpl to access private members for cancellation and cleanup
    friend class EventLoopImpl;

    void run_loop ();

    /// Submit what the pending queue holds, up to `max_concurrent` and up to
    /// what the rate limiter allows. Worker-thread only. @p local_active is the
    /// loop's cached active count, advanced as transfers are added.
    /// @return whether anything was taken off the queue.
    bool submit_pending_transfers (size_t& local_active);

    /// Deliver every transfer curl has finished. Worker-thread only.
    /// @return whether any completion was read.
    bool drain_completions ();

    /// Park until there is IO or new work, spinning briefly first. Worker-thread
    /// only; called only when a pass found nothing to do.
    void wait_for_work (int still_running);

    /// Remove every in-flight easy handle from curl and complete it as
    /// cancelled. Worker-thread only - `active_transfers` and the handle pool
    /// are not synchronised.
    void cancel_active_transfers ();

    /// True once a bounded drain (stop(true, t)) has run out of time. Always
    /// false when no deadline was set.
    [[nodiscard]] bool drain_deadline_passed () const;

    CURLM* multi_handle = nullptr;
    std::thread thread;
    std::atomic<bool> running{ false };
    std::atomic<bool> stop_requested{ false };
    // Set to true when stop(true) is called so the run_loop continues draining
    // the pending queue before exiting. When false (stop(false)), the worker
    // cancels its in-flight transfers and abandons the queue; the caller drains
    // the queue as sole consumer after join() to avoid a concurrent SPSC pop.
    std::atomic<bool> drain_on_stop{ true };
    // steady_clock ticks after which a drain gives up and cancels what is left.
    // 0 = no deadline. Written by the stopping thread before `stop_requested`,
    // read by the worker, so a release/acquire pair carries both.
    std::atomic<int64_t> drain_deadline_ticks{ 0 };

    // Lock-free queue for high performance
    vayu::core::SPSCQueue<std::unique_ptr<TransferData>> pending_queue;

    // Notification for worker when queue is empty
    std::atomic<bool> queue_has_items{ false };

    // Atomic counter for active transfers to avoid locking in hot loop
    std::atomic<size_t> current_active_count{ 0 };

    // Only accessed by worker thread - no mutex needed
    std::unordered_map<CURL*, std::unique_ptr<TransferData>> active_transfers;

    EventLoopConfig config;
    RateLimiter rate_limiter;

    /**
     * The DNS cache every worker shares.
     *
     * A function rather than a static data member, and the difference is not
     * cosmetic. `DnsCache`'s constructor allocates; as a data member it is
     * constructed before `main`, where a throw has no frame to land in
     * (`cert-err58-cpp`) and where its order against the other translation
     * units' statics is unspecified. Constructed on the first caller's stack
     * instead, both questions answer themselves - and C++11 guarantees the
     * initialisation is thread-safe, which is what the workers need.
     */
    static DnsCache& dns_cache ();

    // Per-worker handle pool for reusing curl handles
    CurlHandlePool handle_pool_;
};

} // namespace vayu::http::detail
