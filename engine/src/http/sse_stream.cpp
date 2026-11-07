/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/sse_stream.cpp
 * @brief The streaming execution core (issue #573).
 */

#include "vayu/http/sse_stream.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/run_manager.hpp"
#include "vayu/core/sample_capture.hpp"
#include "vayu/http/cookie_warnings.hpp"
#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/redirect_policy.hpp"
#include "vayu/http/sse_parser.hpp"
#include "vayu/http/status.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/parse.hpp"

namespace vayu::http {

namespace constants = vayu::core::constants;

namespace {
/// Wall-clock milliseconds, matching what the run rows and the routes stamp.
int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}
} // namespace

const char* to_string (SseEndReason reason) {
    switch (reason) {
    case SseEndReason::Completed: return "completed";
    case SseEndReason::Stopped: return "stopped";
    case SseEndReason::MaxEvents: return "maxStreamEvents";
    case SseEndReason::MaxDuration: return "maxStreamDurationMs";
    case SseEndReason::Idle: return "idleTimeout";
    case SseEndReason::Error: return "error";
    }
    return "unknown";
}

SseLimits read_sse_limits (vayu::db::Database& db) {
    const SseLimits defaults;
    // A value outside the seeded range can only reach here from a hand-edited
    // row - POST /config rejects one against each key's min/max - and a ring of
    // 0 or an idle timeout of 0 would quietly turn every stream into an empty
    // one. Fall back rather than trust it, as read_inbox_limits does.
    auto read = [&db] (const char* key, int64_t fallback, int64_t low, int64_t high) {
        const auto value =
        static_cast<int64_t> (db.get_config_int (key, static_cast<int> (fallback)));
        return (value >= low && value <= high) ? value : fallback;
    };

    SseLimits limits;
    limits.max_retained_events = static_cast<std::size_t> (
    read ("sseMaxRetainedEvents", static_cast<int64_t> (defaults.max_retained_events),
    static_cast<int64_t> (constants::sse::MIN_RETAINED_EVENTS),
    static_cast<int64_t> (constants::sse::RETAINED_EVENTS_CEILING)));
    limits.max_event_bytes = static_cast<std::size_t> (
    read ("sseMaxEventBytes", static_cast<int64_t> (defaults.max_event_bytes),
    static_cast<int64_t> (constants::sse::MIN_EVENT_BYTES),
    static_cast<int64_t> (constants::sse::EVENT_BYTES_CEILING)));
    limits.max_stored_events = static_cast<std::size_t> (
    read ("sseMaxStoredEvents", static_cast<int64_t> (defaults.max_stored_events),
    0, static_cast<int64_t> (constants::sse::STORED_EVENTS_CEILING)));
    limits.max_stream_duration_ms = read ("sseMaxStreamDurationMs",
    defaults.max_stream_duration_ms, constants::sse::MIN_STREAM_DURATION_MS,
    constants::sse::STREAM_DURATION_MS_CEILING);
    limits.max_stream_events = read ("sseMaxStreamEvents", defaults.max_stream_events,
    constants::sse::MIN_STREAM_EVENTS, constants::sse::STREAM_EVENTS_CEILING);
    limits.idle_timeout_ms = read ("sseIdleTimeoutMs", defaults.idle_timeout_ms,
    constants::sse::MIN_IDLE_TIMEOUT_MS, constants::sse::IDLE_TIMEOUT_MS_CEILING);
    return limits;
}

vayu::StreamBounds default_stream_bounds (const SseLimits& limits) {
    vayu::StreamBounds bounds;
    bounds.max_duration_ms = limits.max_stream_duration_ms;
    bounds.max_events      = limits.max_stream_events;
    return bounds;
}

vayu::StreamBounds resolve_stream_bounds (const nlohmann::json& config,
const vayu::StreamBounds& defaults) {
    const auto cap = [&config] (const char* key, int64_t fallback) {
        const auto field = config.find (key);
        return field == config.end () || field->is_null () ? fallback :
                                                             field->get<int64_t> ();
    };
    vayu::StreamBounds bounds;
    bounds.max_duration_ms = cap ("maxStreamDurationMs", defaults.max_duration_ms);
    bounds.max_events = cap ("maxStreamEvents", defaults.max_events);
    return bounds;
}

// ---------------------------------------------------------------------------
// SseStreamContext
// ---------------------------------------------------------------------------

SseStreamContext::SseStreamContext (std::string id, SseLimits stream_limits)
: run_id (std::move (id)), limits (stream_limits) {
}

void SseStreamContext::append (const std::string& event_name, const nlohmann::json& data) {
    // The data may carry arbitrary upstream bytes; the parser already replaced
    // invalid UTF-8, and `error_handler_t::replace` is the belt for anything
    // that reaches here another way (a header value, say).
    std::string payload =
    data.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
    std::lock_guard<std::mutex> lock (mutex_);
    const std::size_t offset = base_offset_ + ring_.size ();
    append_locked (vayu::core::build_sse_frame (event_name, payload, offset));
}

void SseStreamContext::append_locked (std::string payload) {
    ring_.push_back (std::move (payload));
    // A loop, not an `if`: nothing stops the cap being smaller than the ring
    // already is on the first append after a resize.
    while (ring_.size () > limits.max_retained_events) {
        ring_.pop_front ();
        ++base_offset_;
    }
    published_count_.store (base_offset_ + ring_.size (), std::memory_order_release);
}

void SseStreamContext::record_event (const SseEvent& event) {
    nlohmann::json payload = sse_event_node (event);
    payload["receivedAt"]  = now_ms ();

    total_events_.fetch_add (1, std::memory_order_acq_rel);
    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (stored_.size () < limits.max_stored_events) {
            stored_.push_back (payload);
        }
    }
    append ("message", payload);
}

SseStreamContext::EventBatch SseStreamContext::events_since (std::size_t from) const {
    std::lock_guard<std::mutex> lock (mutex_);
    const std::size_t end = base_offset_ + ring_.size ();
    if (from >= end) {
        return { {}, from };
    }
    const std::size_t start = from < base_offset_ ? base_offset_ : from;
    auto begin_it = ring_.begin () + static_cast<std::ptrdiff_t> (start - base_offset_);
    return { { begin_it, ring_.end () }, end };
}

void SseStreamContext::record_end (SseEndReason reason) {
    std::lock_guard<std::mutex> lock (mutex_);
    if (!end_reason_) {
        end_reason_ = reason;
    }
}

void SseStreamContext::close (SseEndReason reason) {
    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (closed_.load (std::memory_order_acquire)) {
            return;
        }
        if (!end_reason_) {
            end_reason_ = reason;
        }
    }
    completed_at_ms_.store (now_ms (), std::memory_order_release);
    // Released last, so a relay that observes `closed` also observes the reason
    // and the timestamp that were published before it.
    closed_.store (true, std::memory_order_release);
}

SseEndReason SseStreamContext::end_reason () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return end_reason_.value_or (SseEndReason::Completed);
}

std::vector<nlohmann::json> SseStreamContext::stored_events () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return stored_;
}

void SseStreamContext::note_response_open (int status_code,
std::string status_text,
const Headers& headers) {
    nlohmann::json open;
    open["statusCode"] = status_code;
    open["statusText"] = std::move (status_text);
    open["headers"]    = headers;
    append ("open", open);
}

std::optional<LiveClaim> SseStreamContext::try_claim () {
    std::lock_guard<std::mutex> lock (claim_mutex_);
    return claim_.try_claim (std::chrono::milliseconds (
    constants::sse::RELAY_KEEPALIVE_MS * constants::sse::RELAY_CLAIM_STALE_INTERVALS));
}

bool SseStreamContext::note_claim_write (LiveClaim claim) {
    std::lock_guard<std::mutex> lock (claim_mutex_);
    return claim_.note_write (claim);
}

void SseStreamContext::release_claim (LiveClaim claim) {
    std::lock_guard<std::mutex> lock (claim_mutex_);
    claim_.release (claim);
}

nlohmann::json stream_completion_json (const SseStreamContext& context) {
    nlohmann::json out;
    out["runId"]       = context.run_id;
    out["reason"]      = to_string (context.end_reason ());
    out["totalEvents"] = context.total_events ();
    return out;
}

nlohmann::json sse_event_node (const SseEvent& event) {
    nlohmann::json payload;
    payload["event"] = event.event;
    payload["data"]  = event.data;
    if (!event.id.empty ()) {
        // The upstream id, kept apart from the relay's own frame id: a client
        // resuming *our* stream sends the frame offset, while this is what the
        // origin would want back. Conflating them would make one of the two
        // resumes silently wrong.
        payload["sourceId"] = event.id;
    }
    if (event.truncated) {
        // In band, always: a reader must never have to infer that what it is
        // looking at is a prefix. Same shape as `bodyTruncated`/`bodyBytes`.
        payload["dataTruncated"] = true;
        payload["dataBytes"]     = event.data_bytes;
    }
    return payload;
}

nlohmann::json buffered_stream_events_node (std::string_view body,
const SseLimits& limits,
int64_t total_events,
bool body_complete) {
    nlohmann::json items = nlohmann::json::array ();

    // Fed in one call and finished, because the whole body is already here -
    // the incremental path exists for a socket, not for a string. `finish()`
    // still matters: a capture cut mid-frame, or a server that closed without
    // the terminating blank line, leaves a dispatchable event behind.
    SseParser parser (limits.max_event_bytes);
    const auto append = [&items, &limits] (const std::vector<SseEvent>& parsed) {
        for (const auto& event : parsed) {
            if (items.size () >= limits.max_stored_events) {
                return;
            }
            items.push_back (sse_event_node (event));
        }
    };
    append (parser.feed (body));
    append (parser.finish ());

    nlohmann::json node;
    node["items"] = std::move (items);
    // The wire count, not the parsed one: a body cut by the capture budget
    // still delivered every event the counter saw, and reporting the shorter
    // number would make a truncated capture read as a shorter stream.
    node["totalEvents"] = total_events;
    node["eventsTruncated"] =
    !body_complete || std::cmp_greater (total_events, node["items"].size ());
    return node;
}

nlohmann::json stream_trace_node (const SseStreamContext& context) {
    const auto stored = context.stored_events ();
    nlohmann::json node;
    node["items"]       = stored;
    node["totalEvents"] = context.total_events ();
    // Truthful rather than derived from the cap: a stream that ended under the
    // cap and one whose tail was dropped must be distinguishable without the
    // reader knowing what the cap was when the run happened.
    node["eventsTruncated"] = std::cmp_greater (context.total_events (), stored.size ());
    node["endReason"] = to_string (context.end_reason ());
    return node;
}

// ---------------------------------------------------------------------------
// The consumer transfer
// ---------------------------------------------------------------------------

namespace {

/// What one in-flight stream needs from its callbacks, across every hop of its
/// redirect chain.
struct TransferState {
    const SseStreamRequest* request = nullptr;
    SseStreamContext* context       = nullptr;
    SseParser* parser               = nullptr;
    vayu::Response* response        = nullptr;
    /// The transport policy's connect-time state. It counts the requests
    /// libcurl has written on a made connection, which, against the count the
    /// hop in flight started at, is how the progress callback knows the hop's
    /// connect phase is over.
    detail::ConnectedPeerCheck* peer_check = nullptr;
    /// Redirects the chain followed before the hop in flight.
    int hop = 0;
    /// `peer_check->requests_started` as the hop's transfer began, so a
    /// request libcurl re-sent for an earlier hop (#2799) is not read as this
    /// hop's.
    int hop_requests_before = 0;
    /// Numeric status of the header block being read, 0 before the first one.
    int block_status = 0;
    /// Set at the end of a header block the chain follows (a redirect with a
    /// `Location`): that hop's body is no part of the stream, so it reaches no
    /// `open` frame, no parser and no byte count.
    bool discard = false;
    /// Set at the final hop's first body byte, so the `open` frame is
    /// published once per chain.
    bool announced = false;
    /// Set by the callback or the chain that ended the stream by a rule, so the
    /// resulting `CURLE_ABORTED_BY_CALLBACK` can name which rule fired rather
    /// than being reported as a generic failure.
    std::optional<SseEndReason> abort_reason;
    /// The caps this transfer runs under, already resolved from the request's
    /// overrides and the configured defaults.
    int64_t max_events      = 0;
    int64_t max_duration_ms = 0;
    /// Set once, before the first hop, so the duration cap spans the chain.
    std::chrono::steady_clock::time_point started_at;
    /// When the connection last showed life: a body byte or a header line.
    /// Empty until the progress callback first sees a hop connected, so the
    /// connect and TLS phases, which have their own bound, never count as
    /// silence.
    std::optional<std::chrono::steady_clock::time_point> last_byte_at;
    /// The hop that stamped `last_byte_at`. A stamp from an earlier hop says
    /// nothing about the current connection: the redirect response's last
    /// header line predates the next hop's DNS, TCP and TLS, and libcurl runs
    /// no progress callback while a hop connects.
    int last_byte_hop       = 0;
    int64_t idle_timeout_ms = 0;
    /// Body bytes the current hop delivered, kept or not. Reset per hop, so it
    /// ends as the final response's count.
    std::size_t delivered_bytes = 0;
    /// Whether the current hop's bytes are also kept as `Response::body`.
    /// Decided at the hop's first body byte, from its own `Content-Type`.
    std::optional<bool> keeps_body;
    /// Where a `Set-Cookie` line is counted, or null for a stream with no jar:
    /// libcurl's cookie engine is off then and drops nothing.
    IncomingCookieWatch* incoming_cookies = nullptr;
};

/// Whether @p headers announce an event stream, whose bytes are its events
/// rather than a body. A missing `Content-Type` is not one.
bool announces_event_stream (const Headers& headers) {
    const auto found = headers.find ("content-type");
    return found != headers.end () && vayu::core::media_type (found->second) == "text/event-stream";
}

/// Whether the current hop's bytes are kept as a body. Read at a body byte,
/// when the hop's header block is complete, and decided once per hop.
bool hop_keeps_body (TransferState& state) {
    if (!state.keeps_body) {
        state.keeps_body = !announces_event_stream (state.response->headers);
    }
    return *state.keeps_body;
}

/// Append @p bytes to the body up to the request's bound, marking the body a
/// prefix once a byte is refused.
void hold_body_bytes (TransferState& state, std::string_view bytes) {
    vayu::Response& response = *state.response;
    const std::size_t bound  = state.request->max_body_bytes;
    const std::size_t room   = bound - std::min (bound, response.body.size ());
    if (bytes.size () > room) {
        response.body_truncated = true;
    }
    response.body.append (bytes.substr (0, room));
}

/// Forget what an earlier header block (a followed redirect, a 1xx) left
/// behind, so the response describes the final hop alone.
void begin_response_hop (TransferState& state) {
    vayu::Response& response = *state.response;
    response.headers.clear ();
    response.header_lines.clear ();
    response.body.clear ();
    response.body_truncated = false;
    state.delivered_bytes   = 0;
    state.keeps_body.reset ();
    state.discard = false;
}

void note_activity (TransferState& state) {
    state.last_byte_at  = std::chrono::steady_clock::now ();
    state.last_byte_hop = state.hop;
}

size_t stream_write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* state             = static_cast<TransferState*> (userdata);
    const size_t total_size = size * nmemb;
    note_activity (*state);
    if (state->discard) {
        return total_size;
    }
    const std::string_view bytes (ptr, total_size);

    // The header block is complete by the time the first body byte arrives, so
    // this is where the run learns what it connected to - published as the
    // ring's first frame so even a relay that attaches later replays it. The
    // frame carries the folded map only: `Response::header_lines` is read by
    // the completed trace, and a client without the lines falls back to the map.
    if (!state->announced) {
        state->announced = true;
        state->context->note_response_open (state->response->status_code,
        state->response->status_text, state->response->headers);
    }

    // A reply that is not an event stream (a JSON 404, NDJSON) still goes
    // through the parser below, so a server that streams SSE under the wrong
    // type keeps working; what it gains is a body to read (#3238).
    state->delivered_bytes += total_size;
    if (hop_keeps_body (*state)) {
        hold_body_bytes (*state, bytes);
    }

    for (auto& event : state->parser->feed (bytes)) {
        state->context->record_event (event);
        if (state->context->total_events () >= state->max_events) {
            state->abort_reason = SseEndReason::MaxEvents;
            // Returning short of `total_size` is how a write callback aborts a
            // transfer; the events already parsed out of this chunk are kept,
            // since they arrived before the cap was reached.
            return 0;
        }
    }
    return total_size;
}

size_t stream_header_callback (char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* state             = static_cast<TransferState*> (userdata);
    const size_t total_size = size * nitems;
    note_activity (*state);
    std::string line (buffer, total_size);
    while (!line.empty () && (line.back () == '\r' || line.back () == '\n')) {
        line.pop_back ();
    }
    auto* response = state->response;
    if (line.empty ()) {
        state->discard = state->request->request.follow_redirects &&
        is_redirect_status (state->block_status) &&
        location_of (response->header_lines).has_value ();
        return total_size;
    }
    if (line.starts_with ("HTTP/")) {
        state->block_status    = 0;
        const auto first_space = line.find (' ');
        if (first_space != std::string::npos) {
            const auto second_space = line.find (' ', first_space + 1);
            response->status_text =
            (second_space != std::string::npos && second_space + 1 < line.size ()) ?
            line.substr (second_space + 1) :
            std::string{};
            // Read off the status line rather than left to the
            // `CURLINFO_RESPONSE_CODE` read after the transfer: the `open`
            // frame is published from the *first body byte*, and a stream's
            // transfer does not finish for minutes. Waiting would publish `0`
            // as the status of a perfectly healthy 200.
            const auto code_end =
            second_space == std::string::npos ? line.size () : second_space;
            // Whole-token, so a code with a tail glued to it ("200OK") leaves
            // the status unread rather than reporting the digits it starts
            // with - a malformed status line is not a 200.
            const std::string_view code = std::string_view (line).substr (
            first_space + 1, code_end - first_space - 1);
            const std::optional<int> parsed = vayu::utils::parse_number<int> (code);
            if (parsed.has_value ()) {
                response->status_code = *parsed;
                state->block_status   = *parsed;
            }
        }
        // Every block starts the record over, so the final hop's headers and
        // body are what the run reports.
        begin_response_hop (*state);
        if (state->incoming_cookies != nullptr) {
            state->incoming_cookies->limits.start_response ();
        }
        return total_size;
    }
    vayu::http::detail::ingest_header_line (line, response->headers, &response->header_lines);
    watch_set_cookie (state->incoming_cookies, line, total_size);
    return total_size;
}

/// Collects libcurl's cookie notices into the `CookieNotices` at @p userptr,
/// at any log verbosity: a warning is the response's, not the log's. Every
/// other frame is dropped, a stream's data above all, and nothing is logged.
int stream_debug_callback (CURL*, curl_infotype type, char* data, size_t size, void* userptr) {
    if (type == CURLINFO_TEXT) {
        note_cookie_notice (
        *static_cast<CookieNotices*> (userptr), std::string_view (data, size));
    }
    return 0;
}

/// Whether the hop in flight has written its request on a made connection,
/// which ends the connect phase the connect bound judges.
bool hop_connected (const TransferState& state) {
    return state.peer_check->requests_started > state.hop_requests_before;
}

/// Whether the connection has been silent for the idle window. The clock waits
/// while the current hop is connecting and is armed by the first progress call
/// that finds the hop connected, unless a byte of this hop armed it already.
/// libcurl calls the progress callback about once a second while idle, and a
/// connection that completes between two calls arms the clock up to a second
/// late, so a quiet stream ends within a couple of seconds of its setting, not
/// at the millisecond.
bool idle_window_elapsed (TransferState& state) {
    const auto now = std::chrono::steady_clock::now ();
    if (!hop_connected (state)) {
        return false;
    }
    if (!state.last_byte_at || state.last_byte_hop != state.hop) {
        state.last_byte_at  = now;
        state.last_byte_hop = state.hop;
    }
    const auto silent_for =
    std::chrono::duration_cast<std::chrono::milliseconds> (now - *state.last_byte_at);
    return silent_for.count () >= state.idle_timeout_ms;
}

/// Whether a stop or the duration cap ends the stream now, recording which.
/// Asked by the progress callback during a transfer and by the chain before a
/// redirected hop's, so neither rule loses its hold between two hops.
bool stopped_or_out_of_time (TransferState& state) {
    if (state.context->should_stop.load (std::memory_order_acquire)) {
        state.abort_reason = SseEndReason::Stopped;
        return true;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - state.started_at)
                         .count ();
    if (elapsed >= state.max_duration_ms) {
        state.abort_reason = SseEndReason::MaxDuration;
        return true;
    }
    return false;
}

int stream_progress_callback (void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* state = static_cast<TransferState*> (userdata);
    if (stopped_or_out_of_time (*state)) {
        return 1;
    }
    if (idle_window_elapsed (*state)) {
        state->abort_reason = SseEndReason::Idle;
        return 1;
    }
    return 0;
}

/// How a stream's redirect chain ended, for `consume_sse_stream` to build the
/// response from.
struct StreamChainOutcome {
    /// The last transfer's code.
    CURLcode code = CURLE_OK;
    /// The chain's own failure, which no transfer reported: a redirect it will
    /// not follow, or its limit.
    std::optional<Error> refusal;
    /// Every hop's timers, summed.
    detail::CurlPhaseTimes phases;
    /// The registry entry the last transfer presented, or null.
    const ClientCertRule* certificate = nullptr;
    int followed                      = 0;
};

/**
 * @brief Runs the stream as one transfer per hop, following redirects itself
 *        rather than through `CURLOPT_FOLLOWLOCATION` (#3301).
 *
 * `Client::send`'s `run_chain` shape on the same `RedirectChain`: the handle is
 * never reset in between, so its cookie engine and connections serve the whole
 * chain, and the transport policy is applied per hop, which matches the client
 * certificate against that hop's own origin. Nothing a stream counts restarts
 * at a hop: the duration clock, the event cap and the `open` frame are the
 * state's, and a stop or the cap is checked before each redirected hop too.
 * Ending there leaves the last transfer's `CURLE_OK` with an `abort_reason`.
 */
StreamChainOutcome
run_stream_chain (CURL* curl, TransferState& state, RedirectChain& chain, CurlErrorBuffer& errors) {
    StreamChainOutcome out;
    const SseStreamRequest& spec = *state.request;
    std::optional<HopCookies> cookies;
    if (spec.request.follow_redirects && spec.cookie_jar != nullptr) {
        cookies.emplace (curl);
    }
    while (true) {
        const Hop& hop = chain.hop ();
        if (hop.followed > 0) {
            if (stopped_or_out_of_time (state)) {
                return out;
            }
            errors.clear ();
        }
        state.hop                 = hop.followed;
        state.hop_requests_before = state.peer_check->requests_started;
        out.certificate = detail::apply_transport_policy (curl, spec.transport,
        spec.request.verify_ssl, hop.url, state.peer_check);
        if (cookies) {
            cookies->before_hop (hop.url);
        }
        out.code = curl_easy_perform (curl);
        if (cookies) {
            cookies->after_hop ();
        }
        detail::add_phase_times (out.phases, detail::read_phase_times (curl));
        if (out.code != CURLE_OK) {
            return out;
        }
        long status = 0;
        get_info<CURLINFO_RESPONSE_CODE> (curl, &status);
        auto next = chain.redirect_target (
        state.response->header_lines, static_cast<int> (status));
        if (!next) {
            return out;
        }
        if (!next->has_value ()) {
            out.refusal = std::move (next->error ());
            return out;
        }
        chain.advance (curl, static_cast<int> (status), std::move (**next));
        out.followed = chain.hop ().followed;
    }
}

/**
 * @brief The rule the stream ended by, with the failure recorded on
 *        @p response when it is an error.
 *
 * An `abort_reason` is "we ended it" in any of its three spellings: the
 * progress callback's abort, the write callback's short return, or the chain
 * stopping before a hop (the last transfer's `CURLE_OK`). Either way the
 * transfer did what it was asked to, so it is not an error. An abort with no
 * reason is the transport's pre-request refusal (#2355), an error like any
 * other. `CURLE_OPERATION_TIMEDOUT` is an error too: the connect bound is the
 * only timeout set, and its expiry is an error like a refused connect.
 */
SseEndReason settle_end_reason (vayu::Response& response,
const TransferState& state,
const StreamChainOutcome& chain,
CURL* curl,
const CurlErrorBuffer& errors) {
    const bool ended_by_rule = chain.code == CURLE_ABORTED_BY_CALLBACK ||
    chain.code == CURLE_WRITE_ERROR || chain.code == CURLE_OK;
    if (!chain.refusal && state.abort_reason && ended_by_rule) {
        return *state.abort_reason;
    }
    if (!chain.refusal && chain.code == CURLE_OK) {
        return SseEndReason::Completed;
    }
    // The handle describes the hop that failed, so the code is that hop's.
    const Error error      = chain.refusal ?
    *chain.refusal :
    detail::curl_to_error (curl, chain.code, errors, &state.request->request);
    response.status_code   = 0;
    response.status_text   = vayu::http::status_text (0);
    response.error_code    = error.code;
    response.error_message = error.message;
    return SseEndReason::Error;
}

} // namespace

vayu::Response consume_sse_stream (const SseStreamRequest& request, SseStreamContext& context) {
    vayu::Response response;

    // The same gate both other drivers apply: a request curl cannot send as
    // written is refused as a status-0 response rather than sent as something
    // else.
    if (auto invalid = detail::validate_transferable (request.request)) {
        vayu::Response refused  = detail::error_response (*invalid);
        refused.request_headers = request.request.headers;
        context.record_end (SseEndReason::Error);
        return refused;
    }

    CURL* curl = curl_easy_init ();
    if (!curl) {
        vayu::Response failed = detail::error_response (
        vayu::Error{ vayu::ErrorCode::InternalError, "Failed to initialize curl" });
        failed.request_headers = request.request.headers;
        context.record_end (SseEndReason::Error);
        return failed;
    }

    CurlErrorBuffer errors;
    SseParser parser (request.limits.max_event_bytes);
    // The transport policy's connect-time state; the idle rule reads its count
    // of requests written to learn each hop's connection is made.
    detail::ConnectedPeerCheck peer_check;

    TransferState state;
    state.request         = &request;
    state.context         = &context;
    state.parser          = &parser;
    state.response        = &response;
    state.peer_check      = &peer_check;
    state.idle_timeout_ms = request.limits.idle_timeout_ms;
    state.max_events = request.max_events.value_or (request.limits.max_stream_events);
    state.max_duration_ms =
    request.max_duration_ms.value_or (request.limits.max_stream_duration_ms);
    state.started_at = std::chrono::steady_clock::now ();

    errors.attach (curl);
    detail::BodySource body_source;
    detail::apply_method_and_body (curl, request.request, body_source);
    // The request lines are recorded from the first hop's list; a later hop's
    // is filtered from it.
    RedirectChain chain (request.request,
    detail::build_request_header_list (
    request.request, request.default_headers, &response.request_headers),
    body_source);
    set_opt<CURLOPT_URL> (curl, chain.hop ().url.c_str ());
    if (chain.first_headers () != nullptr) {
        set_opt<CURLOPT_HTTPHEADER> (curl, chain.first_headers ());
    }
    detail::apply_default_header_options (curl, request.request, request.default_headers);

    set_opt<CURLOPT_WRITEFUNCTION> (curl, stream_write_callback);
    set_opt<CURLOPT_WRITEDATA> (curl, &state);
    set_opt<CURLOPT_HEADERFUNCTION> (curl, stream_header_callback);
    set_opt<CURLOPT_HEADERDATA> (curl, &state);
    set_opt<CURLOPT_NOPROGRESS> (curl, 0L);
    set_opt<CURLOPT_XFERINFOFUNCTION> (curl, stream_progress_callback);
    set_opt<CURLOPT_XFERINFODATA> (curl, &state);

    // **No `CURLOPT_TIMEOUT_MS`.** A whole-transfer deadline is exactly what
    // made a stream unusable before this path existed: it kills a healthy
    // stream at an arbitrary moment and reports it as a timeout. What a stream
    // needs bounded is silence, so the deadline is an *idle* one, kept by the
    // progress callback (`idle_window_elapsed`), and the duration cap above
    // ends a stream that is talking forever, by a rule that can say its own
    // name. Not `CURLOPT_LOW_SPEED_LIMIT`/`_TIME`: libcurl judges those against
    // an averaged speed, which in some releases lets a quiet stream outlive its
    // setting by about six seconds (#3241). The idle window only runs while a
    // connection carries the request, so the connect phase (TCP and TLS) of
    // every hop gets a bound of its own (#2835), and its expiry is an error,
    // never an idle end.
    set_opt<CURLOPT_CONNECTTIMEOUT_MS> (curl,
    static_cast<long> (constants::server::connect_timeout_ms (request.request.timeout_ms)));

    // The transport policy (TLS, the proxy, the client certificate) goes on
    // per hop, in `run_stream_chain`, through the one shared applier: until
    // #705 this path set no proxy option at all, and a configured proxy
    // silently skipped streams.
    set_opt<CURLOPT_HTTP_VERSION> (
    curl, vayu::http::to_curl_http_version (request.request.http_version));

    // libcurl names a jar cookie it withheld only on its debug channel, so
    // every stream runs verbose; `stream_debug_callback` keeps nothing else.
    // The notices outlive `curl_easy_cleanup`, which can still call it.
    CookieNotices cookie_notices;
    set_opt<CURLOPT_VERBOSE> (curl, 1L);
    set_opt<CURLOPT_DEBUGFUNCTION> (curl, stream_debug_callback);
    set_opt<CURLOPT_DEBUGDATA> (curl, &cookie_notices);

    std::vector<std::string> jar_seeded_from;
    IncomingCookieWatch incoming_cookies;
    if (request.cookie_jar) {
        jar_seeded_from = detail::apply_jar_cookies (
        curl, *request.cookie_jar, request.cookie_scope, request.cookie_writes);
        state.incoming_cookies = &incoming_cookies;
    }

    const auto submitted_at = std::chrono::steady_clock::now ();
    const StreamChainOutcome outcome = run_stream_chain (curl, state, chain, errors);
    const auto completion = std::chrono::steady_clock::now ();
    // Onto the response the stored trace is built from (`build_result_trace`):
    // the route answered `202` long ago, and no relay frame carries them.
    apply_cookie_notices (cookie_notices, response);
    apply_incoming_cookies (incoming_cookies, response);

    if (request.cookie_jar) {
        detail::capture_jar_cookies (
        curl, *request.cookie_jar, request.cookie_scope, jar_seeded_from);
    }

    // Whatever the server left unterminated still arrived - dispatch it before
    // the ring closes, or a well-behaved-but-abrupt server loses its last event.
    // Not after the event cap: the write callback stopped mid-chunk, so the
    // parser's tail is an event the cap already refused, and flushing it would
    // store the cap plus one with the ones between skipped.
    if (state.abort_reason != SseEndReason::MaxEvents) {
        for (auto& event : parser.finish ()) {
            context.record_event (event);
        }
    }

    const double perceived_ms =
    std::chrono::duration<double, std::milli> (completion - submitted_at).count ();
    detail::apply_transfer_timing (response.timing, outcome.phases, perceived_ms);
    // A followed hop was answered, so a later hop's refusal still timed a send.
    response.transfer_attempted =
    outcome.followed > 0 || detail::curl_transfer_attempted (curl, outcome.code);
    response.body_size         = response.body.size ();
    response.stream_body_bytes = state.delivered_bytes;
    // The identity the last hop presented: see Response::client_certificate.
    response.client_certificate =
    outcome.certificate != nullptr ? client_cert_label (*outcome.certificate) : "";

    long negotiated_version = 0;
    get_info<CURLINFO_HTTP_VERSION> (curl, &negotiated_version);
    response.http_version = vayu::http::http_version_from_curl (negotiated_version);

    long http_code = 0;
    get_info<CURLINFO_RESPONSE_CODE> (curl, &http_code);
    if (http_code > 0) {
        response.status_code = static_cast<int> (http_code);
        if (response.status_text.empty ()) {
            response.status_text = vayu::http::status_text (response.status_code);
        }
    }

    const SseEndReason reason = settle_end_reason (response, state, outcome, curl, errors);
    if (response.status_code == 0 && reason != SseEndReason::Error) {
        // A stream ended by a cap before any status line arrived is still not
        // an error, but it has nothing to report either - say so rather than
        // leaving a 0 that reads as a transport failure.
        response.status_text = vayu::http::status_text (0);
    }

    curl_easy_cleanup (curl);
    context.record_end (reason);
    return response;
}

// ---------------------------------------------------------------------------
// SseStreamManager
// ---------------------------------------------------------------------------

namespace {

/**
 * @brief Report a failure from a frame that must not let one escape.
 *
 * The `noexcept` is the point, not decoration. Both callers are frames where an
 * escaping exception ends the process rather than being handled - a destructor,
 * and a `std::thread` entry function - so their handlers cannot themselves be
 * allowed to throw, and building a log message allocates. Routing the report
 * through a function that cannot throw is what makes those handlers total.
 */
void log_unrecoverable (std::string_view what, std::string_view detail) noexcept {
    try {
        vayu::utils::log_error ("http", std::string (what) + ": " + std::string (detail));
    } catch (...) {
        // @deliberate the logger failed while reporting a failure in a frame
        // that terminates if anything escapes it. There is nowhere left to
        // report to, and dropping the message is this handler's whole job.
    }
}

/// Run the transfer, then hand its result to `on_complete`. A failure in
/// either is logged rather than thrown: the run must still reach a terminal
/// state, and the worker has no handler above it to do that.
void consume_and_record (const SseStreamRequest& spec, SseStreamContext& context) {
    vayu::Response response;
    try {
        response = consume_sse_stream (spec, context);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "SSE stream failed: " + context.run_id + ": " + e.what ());
        response.status_code   = 0;
        response.status_text   = vayu::http::status_text (0);
        response.error_code    = vayu::ErrorCode::InternalError;
        response.error_message = e.what ();
        context.record_end (SseEndReason::Error);
    }
    if (!spec.on_complete) {
        return;
    }
    try {
        spec.on_complete (spec.request, response, context);
    } catch (const std::exception& e) {
        vayu::utils::log_error ("http",
        "Failed to record SSE stream result: " + context.run_id + ": " + e.what ());
    }
}

/// Close @p context on every path the worker takes, after the result is stored
/// or has failed to be: an open context strands its relay and holds
/// `POST /runs/:id/stop` for its whole budget. `Error` is only the fallback for
/// a stream that never recorded its end.
void close_after_recording (SseStreamContext& context) noexcept {
    try {
        context.close (SseEndReason::Error);
    } catch (...) {
        log_unrecoverable ("SSE stream close failed", context.run_id);
    }
}

} // namespace

SseStreamManager::SseStreamManager () = default;

SseStreamManager::~SseStreamManager () {
    // `shutdown` takes the manager's lock and joins every worker, and both of
    // those throw `std::system_error` when the OS refuses. A destructor that
    // lets one out calls `std::terminate`, so this frame turns a teardown
    // failure into a log line - which a process already on its way down can
    // still use, unlike a crash. Only the Windows leg's clang-tidy reports it
    // (`bugprone-exception-escape`, #1023): MSVC's STL marks these surfaces
    // differently from libstdc++, and the defect is real on both.
    try {
        shutdown ();
    } catch (const std::exception& e) {
        log_unrecoverable ("SSE stream manager shutdown failed", e.what ());
    } catch (...) {
        log_unrecoverable ("SSE stream manager shutdown failed", "unknown exception");
    }
}

void SseStreamManager::shutdown () {
    std::map<std::string, Stream> draining;
    {
        std::lock_guard<std::mutex> lock (mutex_);
        shutting_down_ = true;
        draining       = std::move (streams_);
        streams_.clear ();
    }
    // Signalled first, joined second: asking all of them to stop before waiting
    // on any one means teardown costs one stream's stop latency, not the sum.
    for (auto& [id, stream] : draining) {
        stream.context->should_stop.store (true, std::memory_order_release);
    }
    for (auto& [id, stream] : draining) {
        if (stream.worker.joinable ()) {
            stream.worker.join ();
        }
    }
}

std::shared_ptr<SseStreamContext> SseStreamManager::start (SseStreamRequest request) {
    auto context = std::make_shared<SseStreamContext> (request.run_id, request.limits);

    std::lock_guard<std::mutex> lock (mutex_);
    if (shutting_down_) {
        return nullptr;
    }
    const std::string run_id = request.run_id;
    // The engine owns every run id and never reuses one, so this can only be a
    // `generate_id` collision - refused rather than overwritten, since
    // overwriting would drop a live worker's handle and terminate on its
    // destructor.
    if (streams_.contains (run_id)) {
        return nullptr;
    }
    auto& stream   = streams_[run_id];
    stream.context = context;
    // The `try` below is a real fix and does not depend on a linter asking for
    // it. `bugprone-exception-escape` used to report this lambda on the Windows
    // leg alone, for a path that is not in the body: MSVC's `<thread>` invokes
    // the callable from `_Invoke(void*) noexcept`, whose own operations it can
    // see throw, so the diagnostic landed on the lambda that invoker wraps.
    // That reading is what took the check out of `engine/.clang-tidy` (#1023,
    // 33 findings on Windows against 0 on Linux over the same commit); the
    // reasoning is recorded there and the handler stays here regardless.
    stream.worker = std::thread ([context, spec = std::move (request)] () mutable {
        // The outermost frame this thread has: `std::thread` calls
        // `std::terminate` if its entry function throws. The inner handlers
        // recover the *stream*, and each of them allocates while doing so, so
        // a second failure raised inside one of them would escape by exactly
        // the route they exist to close. This stays whether or not the linter
        // asks for it.
        try {
            consume_and_record (spec, *context);
        } catch (...) {
            log_unrecoverable ("SSE stream worker failed unrecoverably", context->run_id);
        }
        // After the run row is written, so `event: complete` means the report
        // already holds the result (#3239), and outside the `try`, so a failure
        // above still ends the relay.
        close_after_recording (*context);
    });
    return context;
}

std::shared_ptr<SseStreamContext> SseStreamManager::get (const std::string& run_id) const {
    std::lock_guard<std::mutex> lock (mutex_);
    const auto it = streams_.find (run_id);
    return it == streams_.end () ? nullptr : it->second.context;
}

bool SseStreamManager::request_stop (const std::string& run_id) {
    std::shared_ptr<SseStreamContext> context;
    {
        std::lock_guard<std::mutex> lock (mutex_);
        const auto it = streams_.find (run_id);
        if (it == streams_.end ()) {
            return false;
        }
        context = it->second.context;
    }
    // A stream that already finished is not stopped again: the reason it
    // recorded is the true one, and overwriting it would rewrite history to say
    // the user ended a stream the server had already closed.
    if (context->closed ()) {
        return false;
    }
    context->should_stop.store (true, std::memory_order_release);
    return true;
}

void SseStreamManager::sweep_retained (int64_t retention_ms) {
    std::vector<std::thread> reaped;
    {
        std::lock_guard<std::mutex> lock (mutex_);
        const int64_t now = now_ms ();
        for (auto it = streams_.begin (); it != streams_.end ();) {
            const int64_t completed = it->second.context->completed_at_ms ();
            if (completed == 0 || now - completed < retention_ms) {
                ++it;
                continue;
            }
            reaped.push_back (std::move (it->second.worker));
            it = streams_.erase (it);
        }
    }
    // Joined outside the lock: a worker's `on_complete` can be mid-write, and
    // holding the manager's lock through that would block every other route
    // that touches a stream.
    for (auto& worker : reaped) {
        if (worker.joinable ()) {
            worker.join ();
        }
    }
}

std::size_t SseStreamManager::size () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return streams_.size ();
}

} // namespace vayu::http
