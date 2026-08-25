/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/event_loop_worker.hpp"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#endif

#include <algorithm>
#include <chrono>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

// ============================================================================
// DnsCache Implementation
// ============================================================================

// See the declaration for why this is a function and not a data member.
DnsCache& EventLoopWorker::dns_cache () {
    static DnsCache cache;
    return cache;
}

namespace {

/// Blocking system lookup. Returns an empty string when the host has no address.
std::string system_resolve (const std::string& hostname) {
    // Use AF_UNSPEC to allow both IPv4 and IPv6 - this matches curl's default behavior
    // and is critical for localhost which often resolves to ::1 (IPv6) on modern systems
    struct addrinfo hints = {};
    hints.ai_family       = AF_UNSPEC; // Allow both IPv4 and IPv6
    hints.ai_socktype     = SOCK_STREAM;

    struct addrinfo* result = nullptr;
    int status = getaddrinfo (hostname.c_str (), nullptr, &hints, &result);

    std::string ip;
    if (status == 0 && result) {
        // Iterate through results, preferring IPv6 for localhost (matches curl
        // behavior) For other hosts, take the first result
        struct addrinfo* best = result;

        // For localhost, prefer IPv6 if available (curl tries IPv6 first)
        if (hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1") {
            for (struct addrinfo* rp = result; rp != nullptr; rp = rp->ai_next) {
                if (rp->ai_family == AF_INET6) {
                    best = rp;
                    break;
                }
            }
        }

        // The two casts below are the sockets API's own idiom, not a defect:
        // `ai_addr` is a `sockaddr*` precisely so one field can carry either
        // family, and `ai_family` - tested first, on the same record - is what
        // says which one it is. There is no narrower spelling; POSIX defines
        // the family structs to be reinterpretable through `sockaddr`.
        if (best->ai_family == AF_INET6) {
            char ip_str[INET6_ADDRSTRLEN];
            // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
            auto* addr6 = reinterpret_cast<sockaddr_in6*> (best->ai_addr);
            inet_ntop (AF_INET6, &(addr6->sin6_addr), ip_str, INET6_ADDRSTRLEN);
            ip = ip_str;
        } else if (best->ai_family == AF_INET) {
            char ip_str[INET_ADDRSTRLEN];
            // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
            auto* addr = reinterpret_cast<sockaddr_in*> (best->ai_addr);
            inet_ntop (AF_INET, &(addr->sin_addr), ip_str, INET_ADDRSTRLEN);
            ip = ip_str;
        }
        freeaddrinfo (result);
    }

    return ip;
}

/// Deliver a terminal result to whichever consumer a transfer has. Every path
/// that gives up on a request before curl owns it ends here, so a request can
/// never be dropped without completing.
void complete_transfer (TransferData& data, Result<Response> result) {
    if (data.callback) {
        data.callback (data.request_id, result);
    }
    if (data.has_promise) {
        data.promise.set_value (std::move (result));
    }
}

/**
 * The single definition of what a cancelled transfer looks like. Both paths
 * that can cancel one - an in-flight transfer removed from curl, and a request
 * that never left the pending queue - go through here, so a stopped run's
 * accounting sees one shape rather than two. The result is an Error rather
 * than a zero-status Response because no response was ever received;
 * load_strategy::handle_result records it against the run.
 */
void complete_as_cancelled (TransferData& data) {
    complete_transfer (data, Error{ ErrorCode::InternalError, "Request cancelled" });
}

} // namespace

DnsCache::DnsCache () : resolver_ (system_resolve) {
}

DnsCache::DnsCache (Resolver resolver) : resolver_ (std::move (resolver)) {
}

bool dns_entry_is_fresh (bool negative, std::chrono::steady_clock::duration age, long ttl_seconds) {
    if (ttl_seconds == 0) {
        return false; // Caching disabled
    }

    long effective_ttl = ttl_seconds;
    if (negative) {
        const long negative_ttl = core::constants::event_loop::DNS_NEGATIVE_CACHE_SECONDS;
        effective_ttl =
        ttl_seconds < 0 ? negative_ttl : std::min (ttl_seconds, negative_ttl);
    } else if (ttl_seconds < 0) {
        return true; // Never expires
    }

    return age < std::chrono::seconds (effective_ttl);
}

bool DnsCache::is_fresh (const Entry& entry, long ttl_seconds) {
    return dns_entry_is_fresh (entry.ip.empty (),
    std::chrono::steady_clock::now () - entry.stored_at, ttl_seconds);
}

std::string DnsCache::resolve (const std::string& hostname, long ttl_seconds) {
    // Check cache first (read lock)
    {
        std::shared_lock<std::shared_mutex> lock (mutex_);
        auto it = cache_.find (hostname);
        if (it != cache_.end () && is_fresh (it->second, ttl_seconds)) {
            return it->second.ip;
        }
    }

    // Not cached, or stale - resolve (no lock during the blocking lookup)
    std::string ip = resolver_ (hostname);

    if (ttl_seconds != 0) {
        // Failures are stored too (as an empty ip), so an unresolvable host
        // does not re-block this thread on every request.
        std::unique_lock<std::shared_mutex> lock (mutex_);
        cache_[hostname] = Entry{ ip, std::chrono::steady_clock::now () };
    }

    return ip;
}

struct curl_slist*
DnsCache::get_resolve_list (const std::string& hostname, int port, long ttl_seconds) {
    std::string ip = resolve (hostname, ttl_seconds);
    if (ip.empty ()) {
        return nullptr;
    }

    // Format: "hostname:port:address"
    std::string entry = hostname + ":" + std::to_string (port) + ":" + ip;
    return curl_slist_append (nullptr, entry.c_str ());
}

void DnsCache::clear () {
    std::unique_lock<std::shared_mutex> lock (mutex_);
    cache_.clear ();
}

size_t DnsCache::size () const {
    std::shared_lock<std::shared_mutex> lock (mutex_);
    return cache_.size ();
}

// ============================================================================
// CurlHandlePool Implementation
// ============================================================================

CurlHandlePool::CurlHandlePool (size_t initial_size) {
    // Pre-create handles to avoid allocation during high-load
    for (size_t i = 0; i < initial_size; ++i) {
        CURL* handle = curl_easy_init ();
        if (handle) {
            pool_.push (handle);
            total_created_++;
        }
    }
}

CurlHandlePool::~CurlHandlePool () {
    // No lock needed - destructor runs after worker thread stops
    while (!pool_.empty ()) {
        CURL* handle = pool_.front ();
        pool_.pop ();
        curl_easy_cleanup (handle);
    }
}

CURL* CurlHandlePool::acquire () {
    // No lock needed - single-threaded access
    if (!pool_.empty ()) {
        CURL* handle = pool_.front ();
        pool_.pop ();
        curl_easy_reset (handle); // Reset is ~100x faster than init
        total_reused_++;
        return handle;
    }

    // Pool empty - create new handle
    CURL* handle = curl_easy_init ();
    if (handle) {
        total_created_++;
    }
    return handle;
}

void CurlHandlePool::release (CURL* handle) {
    if (!handle)
        return;
    // No lock needed - single-threaded access
    pool_.push (handle);
}

// ============================================================================
// EventLoopWorker Implementation
// ============================================================================

EventLoopWorker::EventLoopWorker (const EventLoopConfig& cfg)
: pending_queue (core::constants::queue::CAPACITY), // 64K capacity ring buffer
  config (cfg), rate_limiter (RateLimiterConfig{ cfg.target_rps, cfg.burst_size }),
  handle_pool_ (config.max_concurrent) { // Pre-allocate handles
    multi_handle = curl_multi_init ();
    if (!multi_handle) {
        throw std::runtime_error ("Failed to initialize curl_multi for worker");
    }

    // Set multi handle options for high-performance
    curl_multi_setopt (multi_handle, CURLMOPT_MAXCONNECTS,
    static_cast<long> (config.max_concurrent));
    curl_multi_setopt (multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS,
    static_cast<long> (config.max_per_host));

    // Allow HTTP/2 multiplexing on any transfer whose request opted into
    // HTTP/2 (curl_utils.cpp sets CURLOPT_HTTP_VERSION per request from
    // request.http_version). This setting itself is inert on an HTTP/1.1
    // transfer, so it is left unconditional here rather than gated per-run.
    curl_multi_setopt (multi_handle, CURLMOPT_PIPELINING, CURLPIPE_MULTIPLEX);

    // Set max total connections (connection pool size)
    // Higher value = more reusable connections available
    curl_multi_setopt (multi_handle, CURLMOPT_MAX_TOTAL_CONNECTIONS,
    static_cast<long> (config.max_concurrent * 2U));
}

EventLoopWorker::~EventLoopWorker () {
    if (multi_handle) {
        curl_multi_cleanup (multi_handle);
    }
}

void EventLoopWorker::start () {
    if (running.exchange (true)) {
        return;
    }
    stop_requested = false;
    thread         = std::thread (&EventLoopWorker::run_loop, this);
}

void EventLoopWorker::stop (bool wait_for_pending, std::chrono::milliseconds drain_timeout) {
    if (!running) {
        return;
    }

    // Tell run_loop whether to drain the pending queue before exiting, and by
    // when it must give up if it does. Both must be stored before
    // stop_requested so the worker reads a consistent view.
    drain_on_stop.store (wait_for_pending, std::memory_order_relaxed);
    const bool bounded =
    wait_for_pending && drain_timeout > std::chrono::milliseconds::zero ();
    drain_deadline_ticks.store (bounded ?
    (std::chrono::steady_clock::now () + drain_timeout).time_since_epoch ().count () :
    0,
    std::memory_order_relaxed);
    stop_requested.store (true, std::memory_order_release);
    queue_has_items.store (true, std::memory_order_release);
    queue_has_items.notify_one ();
    // The worker may be parked in curl_multi_poll driving transfers that will
    // never answer; without this a cancel waits out the poll timeout per pass.
    curl_multi_wakeup (multi_handle);

    if (thread.joinable ()) {
        thread.join ();
    }

    running = false;

    // Worker has exited - we are now the sole SPSC consumer. Cancel whatever it
    // left behind: on stop(false) that is the whole backlog, on a drain that
    // hit its deadline it is what was still queued, and on a completed drain it
    // is nothing. Doing it unconditionally means no path can leak an unanswered
    // callback or an unsatisfied promise.
    std::unique_ptr<TransferData> data;
    while (pending_queue.pop (data)) {
        complete_as_cancelled (*data);
    }
}

bool EventLoopWorker::drain_deadline_passed () const {
    const int64_t ticks = drain_deadline_ticks.load (std::memory_order_relaxed);
    if (ticks == 0) {
        return false; // Unbounded drain
    }
    return std::chrono::steady_clock::now ().time_since_epoch ().count () >= ticks;
}

void EventLoopWorker::cancel_active_transfers () {
    for (auto& [easy, data] : active_transfers) {
        curl_multi_remove_handle (multi_handle, easy);
        if (data) {
            complete_as_cancelled (*data);
        }
        handle_pool_.release (easy);
    }
    active_transfers.clear ();
    current_active_count.store (0, std::memory_order_relaxed);
}

void EventLoopWorker::run_loop () {
    // Adaptive spinning parameters
    constexpr int SPIN_COUNT = core::constants::queue::SPIN_COUNT;

    // Core loop optimized for latency and throughput.
    // When drain_on_stop=true (stop(true)): keep running until pending queue
    // AND active transfers are both empty, or until the drain deadline passes.
    // When drain_on_stop=false (stop(false)): cancel the in-flight transfers at
    // once and exit; the pending queue is left for the caller to cancel after
    // join(), avoiding a concurrent SPSC consumer race on Windows.
    while (!stop_requested ||
    (drain_on_stop.load (std::memory_order_relaxed) && !pending_queue.empty ()) ||
    !active_transfers.empty ()) {
        // A stop that is not draining - or a drain that has run out of time -
        // must not sit here waiting on transfers the upstream may never answer.
        // Cancel them and leave; stop() cancels anything still queued once it
        // is the sole consumer of the queue.
        if (stop_requested.load (std::memory_order_acquire) &&
        (!drain_on_stop.load (std::memory_order_relaxed) || drain_deadline_passed ())) {
            cancel_active_transfers ();
            break;
        }

        bool did_work = false;

        // 1. Process pending queue (Lock-free Consumer)
        // We avoid blocking acquisition of rate limiter tokens to keep IO loop moving

        // Use atomic load for active count check (Lock-free hot path)
        // The check is "loose" (data race only leads to trying to add and
        // finding map full, which is fine)
        size_t local_active = current_active_count.load (std::memory_order_relaxed);

        std::unique_ptr<TransferData> data;

        // Fetch Phase: Get up to max_concurrent items, BUT only if tokens available.
        // We prioritize DRIVING IO over accepting new work if rate limited.
        // When stop(false) is in progress, skip new work so the queue remains
        // untouched for the caller's post-join cancel drain.
        const bool accept_new =
        !stop_requested || drain_on_stop.load (std::memory_order_relaxed);
        while (accept_new && local_active < config.max_concurrent) {
            // Check rate limiter WITHOUT blocking (single-threaded access, no lock needed)
            if (!rate_limiter.try_acquire_unlocked ()) {
                // Rate limit reached. Stop fetching new work.
                // Go drive the IO machinery for existing requests.
                break;
            }

            // Have token, try get data
            if (!pending_queue.pop (data)) {
                // Queue empty, but we acquired a token.
                // It's a small inefficiency (wasted token) but simpler code path.
                // Given 60k RPS, a few wasted tokens are negligible noise.
                break;
            }

            did_work = true;

            // A request curl cannot put on the wire as written is refused here
            // rather than quietly sent as something else.
            if (auto invalid = validate_transferable (data->request)) {
                // Delivered as a failed *response*, the shape a request that
                // never reached the wire already has everywhere else.
                complete_transfer (*data, error_response (*invalid));
                continue;
            }

            // Acquire handle from pool (lock-free or specialized pool)
            CURL* easy = handle_pool_.acquire ();
            // Note: setup_easy_handle might take time, good to do it outside locks
            easy = setup_easy_handle (easy, data.get (), config, &dns_cache ());

            if (!easy) {
                // Handle creation failure
                complete_transfer (*data,
                Error{ ErrorCode::InternalError, "Failed to create curl handle" });
                continue;
            }

            // A handle the multi rejects never yields a completion message, so
            // tracking it as active would strand it: the run never drains and
            // stop(true) never returns.
            if (auto rejected = add_to_multi (multi_handle, easy)) {
                complete_transfer (*data, *rejected);
                handle_pool_.release (easy);
                continue;
            }

            // Track active transfer
            {
                // No lock needed - private resource
                active_transfers[easy] = std::move (data);
                // Update atomic size
                current_active_count.store (active_transfers.size (), std::memory_order_relaxed);
                local_active++; // Local cache update for loop condition
            }
        }

        // 2. Drive CURL state machine
        int still_running = 0;
        CURLMcode mc      = curl_multi_perform (multi_handle, &still_running);
        if (mc == CURLM_OK) {
            // curl_multi_perform is non-blocking, but might do some work
        }

        // 3. Process completions
        // Check often to free up slots
        int msgs_left = 0;
        CURLMsg* msg  = nullptr;
        while ((msg = curl_multi_info_read (multi_handle, &msgs_left))) {
            did_work = true;

            if (msg->msg == CURLMSG_DONE) {
                CURL* easy = msg->easy_handle;
                // `CURLMsg::data` is a union whose active member is named by
                // `msg`, and libcurl documents `CURLMSG_DONE` as the one that
                // selects `result` - the branch above is that check. A variant
                // is not on offer: the struct is libcurl's.
                // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access)
                CURLcode result = msg->data.result;

                // Named for the transfer that just finished rather than `data`,
                // which is the fetch phase's handle on the transfer being
                // *submitted* and stays in scope here (MSVC C4456).
                std::unique_ptr<TransferData> completed;
                {
                    // No lock needed - private resource
                    auto it = active_transfers.find (easy);
                    if (it != active_transfers.end ()) {
                        completed = std::move (it->second);
                        active_transfers.erase (it);
                        // Update atomic size
                        current_active_count.store (
                        active_transfers.size (), std::memory_order_relaxed);
                    }
                }

                if (completed) {
                    auto response_result =
                    extract_response (easy, completed.get (), result);
                    if (completed->callback)
                        completed->callback (completed->request_id, response_result);
                    if (completed->has_promise)
                        completed->promise.set_value (std::move (response_result));
                    local_processed.fetch_add (1, std::memory_order_relaxed);
                }

                curl_multi_remove_handle (multi_handle, easy);
                handle_pool_.release (easy);
            }
        }

        // 4. Wait Strategy
        if (!did_work) {
            if (still_running > 0) {
                // Wait for IO activity, but allow interruption via curl_multi_wakeup
                // Use a short timeout to keep checking the queue even if no IO events
                curl_multi_poll (multi_handle, nullptr, 0,
                core::constants::event_loop::POLL_TIMEOUT_MS, nullptr);
            } else if (!stop_requested) {
                // No active transfers, and no pending items recently.
                // This is the idle storage.
                // Use atomic wait instead of Condition Variable for lower
                // latency wakeup We wait on queue_has_items flag

                // Adaptive spinning before sleeping
                for (int i = 0; i < SPIN_COUNT; ++i) {
                    if (pending_queue.read_available () > 0)
                        break;
                    // Busy-wait / pause to avoid context switch
                    // std::this_thread::yield(); // REMOVED: Yield causes too much latency
                }

                if (pending_queue.read_available () == 0) {
                    // Check again before sleep
                    queue_has_items.wait (false, std::memory_order_acquire);
                }
                // Reset flag consumption is partly implicit by checking queue
                // size But we can reset it if queue is empty to allow next wait
                if (pending_queue.read_available () == 0) {
                    queue_has_items.store (false, std::memory_order_release);
                }
            }
        }
    }
}

void EventLoopWorker::submit (std::unique_ptr<TransferData> data) {
    // SPSC Queue is safe for single producer.
    while (!pending_queue.push (data)) {
        // Queue full.
        // Spin/Yield. This is backpressure to the producer.
        std::this_thread::yield ();
    }

    // Signal the worker
    bool was_empty = !queue_has_items.exchange (true, std::memory_order_release);
    // Always wake up curl_multi_poll, even if queue wasn't empty
    // (because worker might be sleeping in poll despite having items if it just processed a batch)
    curl_multi_wakeup (multi_handle);

    if (was_empty) {
        queue_has_items.notify_one ();
    }
}

size_t EventLoopWorker::active_count () const {
    // Use atomic count for lock-free read
    return current_active_count.load (std::memory_order_relaxed);
}

size_t EventLoopWorker::pending_count () const {
    // SPSC size is thread-safe for approximation
    return pending_queue.read_available ();
}

} // namespace vayu::http::detail
