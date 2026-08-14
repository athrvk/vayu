#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse_stream.hpp
 * @brief The streaming execution core (issue #573): a managed consumer of one
 *        `text/event-stream` response, the bounded ring its events land in, and
 *        the manager that owns both.
 *
 * Why this exists at all: `POST /execute` is synchronous end to end on one
 * cpp-httplib pool thread and returns one JSON body, so a stream pointed at it
 * buffered without a byte cap until `CURLOPT_TIMEOUT_MS` killed the transfer
 * and reported a status-0 timeout. A live stream needs a different delivery
 * path - a worker that owns the transfer, a bounded in-memory ring, and an SSE
 * endpoint that relays it.
 *
 * Two disciplines this file exists to hold:
 *
 * - **Every stream ends, and says why.** Server close, user stop, a named cap
 *   (`maxStreamEvents`, `maxStreamDurationMs`) or the idle timeout - never "the
 *   whole-transfer timeout happened to fire". `SseEndReason` is that statement,
 *   and it reaches the relay's `event: complete` and the run's trace alike.
 * - **Nothing here is unbounded.** The parser caps the frame it assembles, the
 *   ring caps what it retains, the trace caps what it stores, and the manager
 *   joins every worker it started. `SseStreamManager` is therefore declared
 *   *before* `server_` in server.hpp, like the four listener-owning managers -
 *   see managed_listener.hpp for the one rule they all run on.
 */

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/live_claim.hpp"
#include "vayu/http/sse_parser.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * Why a stream ended. Always one of these - a stream that simply stopped
 * producing is `Idle`, not an unexplained silence.
 */
enum class SseEndReason {
    /// The server closed the stream. The ordinary end of a finite stream.
    Completed,
    /// `POST /runs/:id/stop`.
    Stopped,
    /// `maxStreamEvents` reached.
    MaxEvents,
    /// `maxStreamDurationMs` elapsed.
    MaxDuration,
    /// No bytes arrived for the idle timeout. A stream that hangs must not hold
    /// its worker forever.
    Idle,
    /// The transfer failed (connection, TLS, protocol). The run's error fields
    /// carry what libcurl said.
    Error,
};

/// The wire spelling of @p reason, as the relay and the trace report it.
[[nodiscard]] const char* to_string (SseEndReason reason);

/**
 * The bounds a stream works within, resolved from the config table.
 *
 * Resolved once when a stream starts and const for its life, so one run's
 * events are all truncated and retained by a single rule rather than by
 * whatever the settings happened to be at each arrival - the same decision
 * `InboxLimits` makes, for the same reason.
 */
struct SseLimits {
    /// Events retained in memory per run, for replay and tail.
    std::size_t max_retained_events = vayu::core::constants::sse::MAX_RETAINED_EVENTS;
    /// Bytes of one event's `data` kept; a larger event is stored truncated and
    /// flagged, never silently cut.
    std::size_t max_event_bytes = vayu::core::constants::sse::MAX_EVENT_BYTES;
    /// Events written into the completed run's trace.
    std::size_t max_stored_events = vayu::core::constants::sse::MAX_STORED_EVENTS;
    /// Default caps, overridable per request.
    int64_t max_stream_duration_ms = vayu::core::constants::sse::MAX_STREAM_DURATION_MS;
    int64_t max_stream_events = vayu::core::constants::sse::MAX_STREAM_EVENTS;
    /// How long a stream may deliver nothing before it is ended as idle.
    int64_t idle_timeout_ms = vayu::core::constants::sse::IDLE_TIMEOUT_MS;
};

/**
 * Read the six `sse*` settings.
 *
 * A value outside its seeded range can only come from a hand-edited row -
 * `POST /config` rejects one against the same bounds - and falls back to the
 * seed rather than being trusted, exactly as `read_inbox_limits` does.
 */
[[nodiscard]] SseLimits read_sse_limits (vayu::db::Database& db);

/**
 * One live stream: the ring its events land in, its termination reason, and the
 * single-watcher slot its relay claims.
 *
 * Shared by the consumer worker (the sole producer) and the relay handler (any
 * number of readers over its life, one at a time). Held by `shared_ptr` so a
 * relay that is mid-write when the run is swept keeps its context alive - the
 * discipline `RunContext` follows for the live-metrics topic.
 */
class SseStreamContext {
    public:
    SseStreamContext (std::string run_id, SseLimits limits);

    /// The run this stream belongs to. Const after construction.
    const std::string run_id;
    /// The bounds this stream was started with. Const after construction.
    const SseLimits limits;

    /**
     * Publish one already-built frame body under the ring's own lock, assigning
     * its id from the slot it lands in.
     *
     * The id must be the slot, not a separately-read counter: `Last-Event-ID`
     * resume is only coherent if every consumer agrees which frame an id names,
     * and reading the count and appending as two steps would hand two frames
     * the same id under interleaving. Framing here makes that impossible rather
     * than unlikely - the reason `RunContext::append_event` does the same.
     */
    void append (const std::string& event_name, const nlohmann::json& data);

    /**
     * Record one parsed upstream event: count it, publish it to the ring, and
     * keep it for the trace while the stored cap allows.
     *
     * The three happen together because they are three views of one arrival and
     * every one of them is read - the count by the completion record, the ring
     * by the relay, the stored list by the run's trace. Splitting them is how a
     * field ends up written and never read.
     */
    void record_event (const SseEvent& event);

    /// A batch of retained frames plus the absolute offset the consumer should
    /// ask for next. `next_offset` is not always `from + payloads.size()`: a
    /// consumer resuming from before the retained window is fast-forwarded to
    /// the oldest retained frame, and must adopt this offset or it would
    /// re-request evicted ids forever.
    struct EventBatch {
        std::vector<std::string> payloads;
        std::size_t next_offset = 0;
    };
    [[nodiscard]] EventBatch events_since (std::size_t from) const;

    /// Total frames ever published, including evicted ones. Monotonic, so ids
    /// stay meaningful across an eviction.
    [[nodiscard]] std::size_t published_count () const {
        return published_count_.load (std::memory_order_acquire);
    }

    /// True once the producer has published its final frame. The relay ends
    /// only when this is set **and** it has drained the ring - never on the
    /// worker's liveness, which flips before the last frame lands.
    [[nodiscard]] bool closed () const {
        return closed_.load (std::memory_order_acquire);
    }

    /// Set by `POST /runs/:id/stop`; read by the transfer's progress callback.
    std::atomic<bool> should_stop{ false };

    /// Publish the terminal state. Idempotent - the first reason wins, so a
    /// cap that fired while the server was closing is not overwritten by the
    /// close that followed it.
    void close (SseEndReason reason);
    [[nodiscard]] SseEndReason end_reason () const;
    /// 0 while running; stamped at `close()`.
    [[nodiscard]] int64_t completed_at_ms () const {
        return completed_at_ms_.load (std::memory_order_acquire);
    }

    /// How many upstream events this stream received, including those the ring
    /// has since evicted and those the trace will not store.
    [[nodiscard]] int64_t total_events () const {
        return total_events_.load (std::memory_order_acquire);
    }

    /// The first `max_stored_events` events, as the trace stores them.
    [[nodiscard]] std::vector<nlohmann::json> stored_events () const;

    /// The initial response's status line and headers, recorded as soon as they
    /// arrive so the relay can report what the stream is even before its first
    /// event. Zero status means nothing has been received yet.
    void note_response_open (int status_code, std::string status_text, Headers headers);

    /// The single-watcher slot. Guarded by `claim_mutex_` rather than the ring
    /// lock: a relay claiming or releasing must not contend with the producer.
    [[nodiscard]] std::optional<LiveClaim> try_claim ();
    [[nodiscard]] bool note_claim_write (LiveClaim claim);
    void release_claim (LiveClaim claim);

    private:
    void append_locked (std::string payload);

    mutable std::mutex mutex_;
    std::deque<std::string> ring_;
    /// Absolute index of `ring_.front()`. Guarded by `mutex_`.
    std::size_t base_offset_ = 0;
    std::atomic<std::size_t> published_count_{ 0 };
    std::atomic<bool> closed_{ false };
    std::atomic<int64_t> completed_at_ms_{ 0 };
    std::atomic<int64_t> total_events_{ 0 };
    SseEndReason end_reason_ = SseEndReason::Completed;
    /// Guarded by `mutex_`; capped at `limits.max_stored_events`.
    std::vector<nlohmann::json> stored_;

    mutable std::mutex claim_mutex_;
    LiveClaimSlot claim_;
};

/// What one stream's relay writes as its `event: complete` payload, and what
/// the trace records about how the stream ended.
[[nodiscard]] nlohmann::json stream_completion_json (const SseStreamContext& context);

/// The bounded `events` node a completed stream contributes to its run trace.
/// Carries `totalEvents` and `eventsTruncated` beside the list, so a reader can
/// always tell a stored slice from the whole stream - `cap_trace_bodies` does
/// not reach new nodes, so the cap is applied here, at build time.
[[nodiscard]] nlohmann::json stream_trace_node (const SseStreamContext& context);

/** Everything a stream needs to start. */
struct SseStreamRequest {
    /// The run row this stream reports against. Never empty - a stream is
    /// identified by its run, which is what `eventsUrl` names.
    std::string run_id;
    /// The composed, auth-resolved request, exactly as `POST /execute` built it.
    vayu::Request request;
    SseLimits limits;
    /// Per-request caps, already validated. Absent means the configured default.
    std::optional<int64_t> max_duration_ms;
    std::optional<int64_t> max_events;
    /// The design-mode jar this transfer reads and writes, or null to send no
    /// stored cookie and keep none - the same opt-in `ClientConfig` makes.
    CookieJar* cookie_jar = nullptr;
    std::string cookie_scope{ NO_ENVIRONMENT_SCOPE };
    std::string user_agent = vayu::core::constants::defaults::DEFAULT_USER_AGENT;
    /**
     * Called on the worker thread once the stream has terminated, with the
     * request as sent and the response the exchange produced.
     *
     * Persistence is deliberately the caller's: the route decides what a run
     * records (a transient execution records nothing at all), and a second copy
     * of that decision here is exactly the drift `record_design_result` exists
     * to prevent. Never throws past the worker - the manager catches.
     */
    std::function<void (const vayu::Request&, const vayu::Response&, const SseStreamContext&)> on_complete;
};

/**
 * Owns the engine's streaming consumers - one worker thread per live stream.
 *
 * Thread-safe. The destructor asks every worker to stop and joins it, so the
 * `Database` and `CookieJar` a worker touches must outlive the manager: it is
 * declared before `server_` in server.hpp for that reason, alongside the
 * listener-owning managers.
 */
class SseStreamManager {
    public:
    SseStreamManager ();
    ~SseStreamManager ();

    SseStreamManager (const SseStreamManager&)            = delete;
    SseStreamManager& operator= (const SseStreamManager&) = delete;

    /**
     * Start consuming @p request on a worker thread.
     *
     * @return The stream's context, or nullptr when the manager is shutting
     *         down (the run row exists but nothing will ever run it, so the
     *         route must say so rather than answer with an events URL that
     *         never produces one).
     */
    std::shared_ptr<SseStreamContext> start (SseStreamRequest request);

    /// The stream for @p run_id - live or retained - or nullptr.
    [[nodiscard]] std::shared_ptr<SseStreamContext> get (const std::string& run_id) const;

    /**
     * Ask @p run_id's stream to end, as `POST /runs/:id/stop` does.
     *
     * @return false when no such stream exists, so the stop route can fall
     *         through to its load-run handling rather than reporting a stop
     *         that stopped nothing.
     */
    bool request_stop (const std::string& run_id);

    /// Drop streams that finished more than @p retention_ms ago, joining their
    /// workers. Called by the relay before it looks a run up, the same cadence
    /// `RunManager::sweep_retained` runs at; a still-live stream is never swept.
    void sweep_retained (int64_t retention_ms);

    /// How many streams are held, live or retained. For tests and teardown
    /// assertions - production reads `get`.
    [[nodiscard]] std::size_t size () const;

    private:
    struct Stream {
        std::shared_ptr<SseStreamContext> context;
        std::thread worker;
    };

    mutable std::mutex mutex_;
    std::map<std::string, Stream> streams_;
    bool shutting_down_ = false;
};

/**
 * Consume one `text/event-stream` response into @p context. Blocks until the
 * stream terminates; this is the body of the worker thread, exposed so a test
 * can drive it on its own thread against an in-process fixture.
 *
 * @return The response the exchange produced: the initial status line, headers
 *         and timings, with the error fields set when the transfer failed.
 *         Never an `Error` - `Client::send`'s contract, which every `/execute`
 *         caller relies on, holds on this path too.
 */
vayu::Response consume_sse_stream (const SseStreamRequest& request, SseStreamContext& context);

} // namespace vayu::http
