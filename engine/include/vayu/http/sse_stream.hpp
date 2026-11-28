#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The streaming execution core (#573): a managed consumer of one
 *        `text/event-stream` response, the bounded ring its events land in, and
 *        the manager that owns both.
 *
 * Why it exists: `POST /execute` is synchronous end to end on one cpp-httplib
 * pool thread and returns one JSON body, so a stream sent through it is
 * buffered rather than delivered, and ends only at a byte bound or the
 * whole-transfer timeout. A live stream needs a different delivery path - a
 * worker that owns the transfer, a bounded in-memory ring, and an SSE endpoint
 * that relays it.
 *
 * Two disciplines this file exists to hold:
 *
 * - **Every stream ends, and says why.** Server close, user stop, engine
 *   shutdown, a named cap (`maxStreamEvents`, `maxStreamDurationMs`), the idle
 *   timeout or a failed transfer - never "the whole-transfer timeout happened
 *   to fire". `SseEndReason` is that statement, and it reaches the relay's
 *   `event: complete` and the run's trace alike.
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
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/json_path.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/live_claim.hpp"
#include "vayu/http/sse_parser.hpp"
#include "vayu/http/stream_content_marker.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::runtime {
struct ScriptContext;
} // namespace vayu::runtime

namespace vayu::http {

/**
 * Why a stream ended. Always one of these - a stream that simply stopped
 * producing is `Idle`, not an unexplained silence.
 */
enum class SseEndReason : std::uint8_t {
    /// The server closed the stream. The ordinary end of a finite stream.
    Completed,
    /// `POST /runs/:id/stop`.
    Stopped,
    /// The engine shut down under the stream (`SseStreamManager::shutdown`),
    /// which no user asked for.
    Shutdown,
    /// `maxStreamEvents` reached.
    MaxEvents,
    /// `maxStreamDurationMs` elapsed.
    MaxDuration,
    /// No bytes arrived for the idle timeout after the connection was made. A
    /// stream that hangs must not hold its worker forever.
    Idle,
    /// The transfer failed (connection, TLS, protocol, a connect phase past its
    /// timeout). The run's error fields carry what libcurl said.
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
 * The caps a stream the load event loop drives defaults to: the
 * `sseMaxStreamDurationMs` / `sseMaxStreamEvents` settings @p limits holds,
 * the same two a design stream defaults from (#576).
 */
[[nodiscard]] vayu::StreamBounds default_stream_bounds (const SseLimits& limits);

/**
 * The caps a run's streams are bounded by: @p config's own
 * `maxStreamDurationMs` / `maxStreamEvents` where it names one, @p defaults
 * otherwise. A single-request run applies them to its request when it sets
 * `stream`; a collection run, to each step whose stored request streams
 * (#3235). `POST /runs` has range-checked both caps before a run exists, so
 * this only chooses; `null` is absent, as the check reads it.
 */
[[nodiscard]] vayu::StreamBounds resolve_stream_bounds (const nlohmann::json& config,
const vayu::StreamBounds& defaults);

/**
 * @p path compiled for every response a run's stream reads (#3773): null when
 * it is outside the JSONPath subset, which only a hand-edited row can hold
 * once the write routes have checked it, and which reads as no path, as a
 * stored trace's does.
 */
[[nodiscard]] std::shared_ptr<const vayu::StreamTextPath>
compile_stream_text_path (std::string_view path);

/**
 * @p marker compiled once for every transfer a run's stream sends (#3774):
 * null when it is empty, which `StreamContentMarker` refuses and only a
 * hand-edited row can hold once the write routes have checked it; it reads
 * as no marker.
 */
[[nodiscard]] std::shared_ptr<const StreamContentMarker>
compile_stream_content_marker (std::string_view marker);

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
    SseStreamContext (std::string run_id,
    SseLimits limits,
    std::optional<std::string> text_path = std::nullopt);

    /// The run this stream belongs to. Const after construction.
    const std::string run_id;
    /// The bounds this stream was started with. Const after construction.
    const SseLimits limits;
    /// The request's `streamTextPath` (#3773), which the trace stores so a
    /// reader derives the same `text` again. Const after construction.
    const std::optional<std::string> text_path;

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
     * Record one parsed upstream event: count it, publish it to the ring (with
     * its `text` when the stream declares a text path), and keep its arrival
     * time for the trace while the stored cap allows.
     *
     * The three happen together because they are three views of one arrival and
     * every one of them is read - the count by the completion record, the ring
     * by the relay, the arrival time by the run's trace. Splitting them is how a
     * field ends up written and never read. The event itself is not kept: the
     * response body holds its bytes, and the trace's list is parsed back from
     * them (#3770).
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

    /// True once the stream is over **and** its run row and trace are stored
    /// (#3239): the manager's worker closes after `on_complete` returns, so the
    /// relay's `event: complete` is a promise that `GET /runs/:id/report`
    /// already reads the result. The relay ends only when this is set **and**
    /// it has drained the ring. Not a drain: the worker thread is still
    /// unwinding, and only joining it (`SseStreamManager::shutdown`) is.
    [[nodiscard]] bool closed () const {
        return closed_.load (std::memory_order_acquire);
    }

    /// Ask the transfer to end for a user's `POST /runs/:id/stop`.
    void request_stop ();
    /// Ask the transfer to end because the engine is shutting down.
    void request_shutdown ();
    /// The end a stop request asked for, read by the transfer's progress
    /// callback and before each redirected hop. The first request wins, so a
    /// shutdown after a Stop the transfer has not read yet does not rewrite why
    /// the user's stream ended.
    [[nodiscard]] std::optional<SseEndReason> requested_end () const;

    /// Record why the stream ended, without closing it, so the completion
    /// callback can read `end_reason()` while `closed()` is still false. The
    /// first reason wins, so a cap that fired while the server was closing is
    /// not overwritten by the close that followed it.
    void record_end (SseEndReason reason);
    /// Publish the terminal state: `record_end (reason)`, then `closed()`.
    /// Idempotent, and an end already recorded wins over @p reason, which is
    /// therefore the fallback for a stream that never recorded one.
    void close (SseEndReason reason);
    /// The recorded end. Before one is recorded it is `Error`, logged, because
    /// an end nobody recorded is not known to be a completion.
    [[nodiscard]] SseEndReason end_reason () const;
    /// 0 while running; stamped at `close()`.
    [[nodiscard]] int64_t completed_at_ms () const {
        return completed_at_ms_.load (std::memory_order_acquire);
    }

    /// Stamp the moment the transfer began, once: a repeat keeps the first.
    void note_transfer_start ();
    /// 0 until `note_transfer_start`; a stream refused before its transfer
    /// began never has one.
    [[nodiscard]] int64_t transfer_started_at_ms () const {
        return transfer_started_at_ms_.load (std::memory_order_acquire);
    }

    /// How many upstream events this stream received, including those the ring
    /// has since evicted and those the trace will not store.
    [[nodiscard]] int64_t total_events () const {
        return total_events_.load (std::memory_order_acquire);
    }

    /// When each of the first `max_stored_events` events arrived, in arrival
    /// order: the `receivedAt` the trace pairs with the events it parses back.
    [[nodiscard]] std::vector<int64_t> stored_arrivals () const;

    /// The initial response's status line and headers, recorded as soon as they
    /// arrive so the relay can report what the stream is even before its first
    /// event. Zero status means nothing has been received yet.
    void note_response_open (int status_code, std::string status_text, const Headers& headers);

    /// The single-watcher slot. Guarded by `claim_mutex_` rather than the ring
    /// lock: a relay claiming or releasing must not contend with the producer.
    [[nodiscard]] std::optional<LiveClaim> try_claim ();
    [[nodiscard]] bool note_claim_write (LiveClaim claim);
    void release_claim (LiveClaim claim);

    private:
    void append_locked (std::string payload);

    /// `text_path` compiled once; empty when none was declared.
    const std::optional<std::vector<vayu::core::detail::JsonPathStep>> text_steps_;

    mutable std::mutex mutex_;
    std::deque<std::string> ring_;
    /// Absolute index of `ring_.front()`. Guarded by `mutex_`.
    std::size_t base_offset_ = 0;
    std::atomic<std::size_t> published_count_{ 0 };
    std::atomic<bool> closed_{ false };
    std::atomic<int64_t> completed_at_ms_{ 0 };
    std::atomic<int64_t> transfer_started_at_ms_{ 0 };
    std::atomic<int64_t> total_events_{ 0 };
    /// Guarded by `mutex_`; empty until `record_end` or `close`.
    std::optional<SseEndReason> end_reason_;
    /// Guarded by `mutex_`; empty until `request_stop` or `request_shutdown`.
    std::optional<SseEndReason> requested_end_;
    /// Guarded by `mutex_`; capped at `limits.max_stored_events`.
    std::vector<int64_t> stored_arrivals_;

    mutable std::mutex claim_mutex_;
    LiveClaimSlot claim_;
};

/// What one stream's relay writes as its `event: complete` payload, and what
/// the trace records about how the stream ended.
[[nodiscard]] nlohmann::json stream_completion_json (const SseStreamContext& context);

/**
 * @brief What a completed design stream stores as its trace's `events` node:
 *        everything about its events that its bytes cannot say (#3770).
 *
 * `{totalEvents, endReason, maxEventBytes, receivedAt: [ms, ...],
 * streamTextPath?, startedAt?}`, and no list. `startedAt` is when the transfer
 * began (epoch ms, the clock `receivedAt` reads), absent for a stream that never
 * began one, so a reader can tell the wait for the first event from the stream's
 * whole span. The stream's bytes are the trace's response body, so the list is
 * parsed back from them when the trace is read (`expand_stored_stream_events`)
 * rather than stored a second time (#657). `receivedAt` holds one arrival time
 * per event the stored cap kept, which also bounds how many events the parse may
 * report; `maxEventBytes` is the per-event cap the live parser ran under, so the
 * parse back cuts an event where the live one did whatever the setting says by
 * then. `streamTextPath` is the declared path (#3773), so the parse back derives
 * each `text` and the joined `streamText` from the bytes rather than from a
 * stored copy.
 */
[[nodiscard]] nlohmann::json stream_trace_node (const SseStreamContext& context);

/**
 * What a declared stream text path (#3773) reads off one event: the first
 * match of @p path in the event's `data` parsed as JSON, a string as it is and
 * any other scalar as compact JSON. Nothing for a match that is `null`, an
 * array or an object, for no match, for data that is not JSON (`[DONE]`, a
 * keep-alive) and for an event the per-event cap cut, whose data is a prefix
 * of the JSON it was.
 */
[[nodiscard]] std::optional<std::string> sse_event_text (const SseEvent& event,
const std::vector<vayu::core::detail::JsonPathStep>& path);

/**
 * Whether @p event reports a failure (#3996): it is named `error`, or it is
 * whole and its `data` is a JSON object whose top-level `error` member is
 * neither `null` nor `false`. A truncated event's data is a prefix, so only
 * its name can mark it. No provider's shape is read: an `error` nested below
 * the top level is not one. Data that does not open with `{` (after
 * whitespace) or holds no `"error"` bytes is judged without a parse.
 */
[[nodiscard]] bool sse_event_is_error (const SseEvent& event);

/// One parsed event in the shape every stored `items` array uses - `event`,
/// `data`, `sourceId` when the origin sent an id, the in-band
/// `dataTruncated` / `dataBytes` pair when the per-event cap cut it,
/// `isError: true` when `sse_event_is_error` holds (absent otherwise, and with
/// or without @p text_path), and `text` when @p text_path is given and
/// `sse_event_text` reads one. The data is parsed at most once for both.
///
/// No `receivedAt`: only a live consumer knows when an event arrived, and
/// `buffered_stream_events_node` adds the one it was given. A node built from
/// bytes nobody watched arrive says nothing rather than inventing one.
[[nodiscard]] nlohmann::json sse_event_node (const SseEvent& event,
const std::vector<vayu::core::detail::JsonPathStep>* text_path = nullptr);

/**
 * @brief The `events` node for a stream whose bytes were *buffered* rather than
 *        consumed live - the load path (#657).
 *
 * The design path records events as they arrive; a load transfer buffers the
 * whole `text/event-stream` body and counts frames with `SseFrameCounter`. The
 * body is therefore the event list, and this parses it back with the same
 * `SseParser` the live path feeds, so "what is an event" has one definition
 * rather than two that can drift.
 *
 * @param body            The buffered response body, which may itself be a
 *                        prefix - see @p body_complete.
 * @param limits          `max_event_bytes` bounds one event's data,
 *                        `max_stored_events` bounds the list.
 * @param total_events    Events the transfer actually delivered
 *                        (`Response::stream_events`), counted on the wire and
 *                        so truthful even when the body was cut.
 * @param body_complete   False when the stored bytes are a prefix of the
 *                        response (a truncated capture): the list is then a
 *                        prefix whatever the counts say.
 * @param arrivals        When a live consumer watched the events arrive, the
 *                        `receivedAt` of each one it kept: item `i` carries
 *                        `arrivals[i]`, and the list stops at its size in place
 *                        of `max_stored_events`. Absent for a load sample.
 * @param text_path       A design stream's compiled `streamTextPath` (#3773):
 *                        each item carries its `text` and the node gains
 *                        `streamText`, every event's text joined. Null for none.
 *
 * The list never holds more than @p total_events: the body can run past the
 * last event the transfer counted, because the event cap stops the transfer
 * mid-chunk and the whole chunk was already held.
 *
 * `streamText` joins every event the body holds up to @p total_events, the
 * ones past the stored-events cap included, so it is the whole reply unless
 * the body is a prefix (@p body_complete false, which `eventsTruncated` and
 * the trace's `bodyCapped` / `bodyTruncated` already say).
 *
 * `eventsTruncated` is the union of the two ways a reader can be looking at
 * less than the whole stream - the stored-events cap and a cut body - because
 * both mean the same thing to whoever reads the list, and neither may be left
 * to be inferred from a row count.
 *
 * No `endReason`: a load stream ends by server close or by one of two caps
 * (`Request::stream_bounds`), and `Response::stream_capped` does not say which
 * of the two fired. The run report's `stream.capped` carries that fact for the
 * run; naming a reason here would mean inventing one per sample.
 */
[[nodiscard]] nlohmann::json buffered_stream_events_node (std::string_view body,
const SseLimits& limits,
int64_t total_events,
bool body_complete,
std::optional<std::span<const int64_t>> arrivals               = std::nullopt,
const std::vector<vayu::core::detail::JsonPathStep>* text_path = nullptr);

/**
 * @brief The `events` node a design stream's reader sees: the list parsed from
 *        @p body, paired with what @p stored (a `stream_trace_node`) recorded.
 *
 * `{items, totalEvents, eventsTruncated, endReason, streamText?, startedAt?}`,
 * each item carrying its `receivedAt`, and its `text` when @p stored names a
 * `streamTextPath`; `startedAt` is copied from @p stored when it has one, so a
 * row stored without it is served without it. The completion pass binds it for
 * the post-request script and `expand_stored_stream_events` builds it again from
 * the stored trace, so the script and every later reader parse one set of bytes
 * by one rule.
 */
[[nodiscard]] nlohmann::json stream_events_node (std::string_view body,
bool body_complete,
const nlohmann::json& stored);

/**
 * @brief Replace a stored trace's `events` sidecar with the list its response
 *        body holds, as `stream_events_node` builds it. Called by every route
 *        that serves a stored trace.
 *
 * A trace whose `events` node is not a sidecar (one stored before #3770
 * carries its `items`; an ordinary send has none) is left as stored. The body
 * is decoded when `bodyEncoding` says base64, and is complete unless the trace
 * marks it `bodyCapped` (the design bound) or `bodyTruncated` (the storage
 * cap).
 */
void expand_stored_stream_events (nlohmann::json& trace);

/**
 * @brief Binds `pm.response.events` for a post-request script that reads a
 *        stream's *buffered* bytes (#3769): a collection run's streaming step,
 *        a load run's inline `script.post` and the deferred replay.
 *
 * When @p response was a bounded stream (`Response::stream_events` set), fills
 * @p slot with `buffered_stream_events_node` over its body, reading each
 * event's `text` and the joined `streamText` through its
 * `Response::stream_text_path` when the request declared one (#3773), and
 * points `ScriptContext::response_events` at it. Otherwise it leaves both
 * untouched, so the script reads an absent field rather than an empty list.
 *
 * @p slot is the caller's, and must outlive every execute that reads
 * @p script_ctx. `Response::body_truncated` decides whether the body is
 * complete; a load response never sets it.
 */
void bind_buffered_stream_events (vayu::runtime::ScriptContext& script_ctx,
const vayu::Response& response,
const SseLimits& limits,
nlohmann::json& slot);

/** Everything a stream needs to start. */
struct SseStreamRequest {
    /// The run row this stream reports against. Never empty - a stream is
    /// identified by its run, which is what `eventsUrl` names.
    std::string run_id;
    /// The composed, auth-resolved request, exactly as `POST /execute` built it.
    vayu::Request request;
    SseLimits limits;
    /// What the final hop may hold as its body, an event stream's bytes
    /// included (`maxDesignResponseBodyBytes`, #3238, #3770): the route
    /// resolves it beside `limits`. Bytes past it are still counted, and still
    /// parsed as events, but not kept; `Response::body_truncated` says so.
    std::size_t max_body_bytes = vayu::core::constants::http::MAX_DESIGN_RESPONSE_BODY_BYTES;
    /// Per-request caps, already validated. Absent means the configured default.
    std::optional<int64_t> max_duration_ms;
    std::optional<int64_t> max_events;
    /// `streamTextPath` (#3773), already checked against the JSONPath subset;
    /// absent for none.
    std::optional<std::string> text_path;
    /// The design-mode jar this transfer reads and writes, or null to send no
    /// stored cookie and keep none - the same opt-in `ClientConfig` makes.
    CookieJar* cookie_jar = nullptr;
    std::string cookie_scope{ NO_ENVIRONMENT_SCOPE };
    /// What the pre-request script's `pm.cookies.jar()` staged, applied on top
    /// of the stored lines for this transfer alone. Carried here rather than
    /// written into the jar for the reason cookie_jar.hpp gives: the transfer
    /// applies them and its capture reconciles them into the scope, so they
    /// happen exactly once and in the order the send decides - the same route
    /// the non-streaming client's `ClientConfig::cookie_writes` takes.
    std::vector<CookieWrite> cookie_writes;
    /// How this stream reaches the network (#705). Resolved by the route
    /// alongside `limits`, for the same reason: read once when the stream
    /// starts, so a settings change applies to the next stream and one transfer
    /// is never reconfigured underneath itself.
    TransportPolicy transport;
    /// What this stream adds to a request that names none of it (#1229),
    /// resolved by the route alongside `transport` and for the same reason.
    DefaultHeaderPolicy default_headers;
    /**
     * Called on the worker thread once the stream has terminated, with the
     * request as sent and the response the exchange produced. The context's
     * `end_reason()` is final here and `closed()` is still false: the worker
     * closes only after this returns or throws (#3239).
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
 * Thread-safe. `shutdown()` asks every worker to stop and joins it, so the
 * `Database` and `CookieJar` a worker touches must outlive the manager: it is
 * declared before `server_` in server.hpp for that reason, alongside the
 * listener-owning managers.
 *
 * **Every owner must drain before the state its workers reach through is torn
 * down** - which is not the same instant as "the manager is destroyed". A
 * worker writes its run row through a `Database&` and runs curl to the last
 * byte, so `Server::stop()` calls `shutdown()` while both are still standing,
 * the way `RunManager::shutdown()` is called for the load workers (#125). A
 * fixture that owns a manager beside a `Database` it resets in `TearDown` owes
 * the same order (#646).
 */
class SseStreamManager {
    public:
    SseStreamManager ();
    ~SseStreamManager ();

    SseStreamManager (const SseStreamManager&)            = delete;
    SseStreamManager& operator= (const SseStreamManager&) = delete;
    SseStreamManager (SseStreamManager&&)                 = delete;
    SseStreamManager& operator= (SseStreamManager&&)      = delete;

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

    /**
     * End every live stream as `Shutdown` and **join** its worker, then refuse
     * to start another. Terminal and idempotent, exactly like
     * `RunManager::shutdown()`: a manager that has drained cannot be reopened,
     * because the caller drains only when the `Database` and `CookieJar` its
     * workers hold are about to go away, and a stream started after that has
     * nothing left to write to.
     *
     * Called by `Server::stop()` and by the destructor. Draining an idle
     * manager returns immediately.
     */
    void shutdown ();

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
 * Records the end reason (`SseStreamContext::record_end`) and does **not**
 * close @p context: closing is its owner's, after whatever the result has to
 * be stored by (the manager's worker runs `on_complete` first). A caller that
 * relays the context must close it, or the relay never ends.
 *
 * @return The response the exchange produced: the final hop's status line,
 *         headers and timings, with the error fields set when the transfer
 *         failed. `stream_body_bytes` counts what that hop delivered and `body`
 *         holds it up to `max_body_bytes`, whatever its type (#3770): the
 *         elements and the post-request script read the same bytes a load
 *         run buffers. An `mcp` request's carries `mcp_reply`, read from the
 *         events as they arrived (`McpReplyStream`, #3762).
 *         Never an `Error` - `Client::send`'s contract, which every `/execute`
 *         caller relies on, holds on this path too.
 */
vayu::Response consume_sse_stream (const SseStreamRequest& request, SseStreamContext& context);

} // namespace vayu::http
