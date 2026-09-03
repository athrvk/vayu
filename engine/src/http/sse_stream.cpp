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
#include <string_view>
#include <utility>

#include "vayu/core/run_manager.hpp"
#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
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

void SseStreamContext::close (SseEndReason reason) {
    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (closed_.load (std::memory_order_acquire)) {
            return;
        }
        end_reason_ = reason;
    }
    completed_at_ms_.store (now_ms (), std::memory_order_release);
    // Released last, so a relay that observes `closed` also observes the reason
    // and the timestamp that were published before it.
    closed_.store (true, std::memory_order_release);
}

SseEndReason SseStreamContext::end_reason () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return end_reason_;
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

/// What one in-flight stream transfer needs from its callbacks.
struct TransferState {
    const SseStreamRequest* request = nullptr;
    SseStreamContext* context       = nullptr;
    SseParser* parser               = nullptr;
    vayu::Response* response        = nullptr;
    /// Set the moment the initial response's header block is complete, so the
    /// `open` frame is published once even across a redirect chain.
    bool announced = false;
    /// Set by the progress callback when it aborts the transfer, so the
    /// resulting `CURLE_ABORTED_BY_CALLBACK` can name which rule fired rather
    /// than being reported as a generic failure.
    std::optional<SseEndReason> abort_reason;
    /// The caps this transfer runs under, already resolved from the request's
    /// overrides and the configured defaults.
    int64_t max_events      = 0;
    int64_t max_duration_ms = 0;
    std::chrono::steady_clock::time_point started_at;
};

size_t stream_write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* state             = static_cast<TransferState*> (userdata);
    const size_t total_size = size * nmemb;

    // The header block is complete by the time the first body byte arrives, so
    // this is where the run learns what it connected to - published as the
    // ring's first frame so even a relay that attaches later replays it.
    if (!state->announced) {
        state->announced = true;
        state->context->note_response_open (state->response->status_code,
        state->response->status_text, state->response->headers);
    }

    for (auto& event : state->parser->feed (std::string_view (ptr, total_size))) {
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
    std::string line (buffer, total_size);
    while (!line.empty () && (line.back () == '\r' || line.back () == '\n')) {
        line.pop_back ();
    }
    if (line.empty ()) {
        return total_size;
    }
    auto* response = state->response;
    if (line.starts_with ("HTTP/")) {
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
            }
        }
        // Headers are cleared between redirect hops so the final hop's set is
        // what the run reports - the same rule client.cpp's callback follows.
        response->headers.clear ();
        return total_size;
    }
    vayu::http::detail::ingest_header_line (line, response->headers);
    return total_size;
}

int stream_progress_callback (void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* state = static_cast<TransferState*> (userdata);
    if (state->context->should_stop.load (std::memory_order_acquire)) {
        state->abort_reason = SseEndReason::Stopped;
        return 1;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - state->started_at)
                         .count ();
    if (elapsed >= state->max_duration_ms) {
        state->abort_reason = SseEndReason::MaxDuration;
        return 1;
    }
    return 0;
}

/// The idle timeout as `CURLOPT_LOW_SPEED_TIME` takes it: whole seconds,
/// rounded **up** so a sub-second setting is never silently rounded to "no
/// timeout at all". The config floor is a second, so this only rounds a
/// hand-edited row.
long idle_timeout_seconds (int64_t idle_timeout_ms) {
    const int64_t seconds = (idle_timeout_ms + 999) / 1000;
    return static_cast<long> (std::max<int64_t> (1, seconds));
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
        context.close (SseEndReason::Error);
        return refused;
    }

    CURL* curl = curl_easy_init ();
    if (!curl) {
        vayu::Response failed = detail::error_response (
        vayu::Error{ vayu::ErrorCode::InternalError, "Failed to initialize curl" });
        failed.request_headers = request.request.headers;
        context.close (SseEndReason::Error);
        return failed;
    }

    CurlErrorBuffer errors;
    SseParser parser (request.limits.max_event_bytes);

    TransferState state;
    state.request  = &request;
    state.context  = &context;
    state.parser   = &parser;
    state.response = &response;
    state.max_events = request.max_events.value_or (request.limits.max_stream_events);
    state.max_duration_ms =
    request.max_duration_ms.value_or (request.limits.max_stream_duration_ms);
    state.started_at = std::chrono::steady_clock::now ();

    errors.attach (curl);
    set_opt<CURLOPT_URL> (curl, vayu::http::wire_url (request.request).c_str ());
    curl_mime* mime = detail::apply_method_and_body (curl, request.request);

    struct curl_slist* headers_list = detail::build_request_header_list (
    request.request, request.default_headers, &response.request_headers);
    if (headers_list) {
        set_opt<CURLOPT_HTTPHEADER> (curl, headers_list);
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
    // needs bounded is silence, so the deadline is an *idle* one -
    // `CURLOPT_LOW_SPEED_LIMIT`/`_TIME`, the first use of the pair in this
    // codebase - and the duration cap above ends a stream that is talking
    // forever, by a rule that can say its own name.
    set_opt<CURLOPT_LOW_SPEED_LIMIT> (curl, 1L);
    set_opt<CURLOPT_LOW_SPEED_TIME> (
    curl, idle_timeout_seconds (request.limits.idle_timeout_ms));

    if (request.request.follow_redirects) {
        set_opt<CURLOPT_FOLLOWLOCATION> (curl, 1L);
        set_opt<CURLOPT_MAXREDIRS> (curl, static_cast<long> (request.request.max_redirects));
    }
    // Until #705 this path set no proxy option at all, so a configured proxy
    // covered every send and every load run and silently skipped streams. The
    // shared applier is what makes that unrepeatable.
    if (const ClientCertRule* certificate = detail::apply_transport_policy (curl,
        request.transport, request.request.verify_ssl, request.request.url)) {
        response.client_certificate = client_cert_label (*certificate);
    }
    set_opt<CURLOPT_HTTP_VERSION> (
    curl, vayu::http::to_curl_http_version (request.request.http_version));
    if (request.cookie_jar) {
        detail::apply_jar_cookies (
        curl, *request.cookie_jar, request.cookie_scope, request.cookie_writes);
    }

    const auto submitted_at = std::chrono::steady_clock::now ();
    const CURLcode result   = curl_easy_perform (curl);
    const auto completion   = std::chrono::steady_clock::now ();

    if (headers_list) {
        curl_slist_free_all (headers_list);
    }
    if (mime) {
        curl_mime_free (mime);
    }
    if (request.cookie_jar) {
        detail::capture_jar_cookies (curl, *request.cookie_jar, request.cookie_scope);
    }

    // Whatever the server left unterminated still arrived - dispatch it before
    // the ring closes, or a well-behaved-but-abrupt server loses its last event.
    for (auto& event : parser.finish ()) {
        context.record_event (event);
    }

    const detail::CurlPhaseTimes phase_times = detail::read_phase_times (curl);
    const double perceived_ms =
    std::chrono::duration<double, std::milli> (completion - submitted_at).count ();
    response.timing.total_ms = perceived_ms;
    response.timing.wire_ms  = phase_times.total * 1000.0;
    response.timing.queue_wait_ms =
    std::max (0.0, perceived_ms - response.timing.wire_ms);
    detail::apply_phase_timings (response.timing, phase_times);

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

    SseEndReason reason = SseEndReason::Completed;
    if (result == CURLE_ABORTED_BY_CALLBACK ||
    (result == CURLE_WRITE_ERROR && state.abort_reason)) {
        // Both spellings of "we ended it": the progress callback's abort and
        // the write callback's short return. Either way the transfer did what
        // it was asked to, so it is not an error - the reason says which rule.
        reason = state.abort_reason.value_or (SseEndReason::Stopped);
    } else if (result == CURLE_OPERATION_TIMEDOUT) {
        // The only timeout configured is the low-speed one, so this is silence
        // rather than a deadline on a healthy stream.
        reason = SseEndReason::Idle;
    } else if (result != CURLE_OK) {
        reason                 = SseEndReason::Error;
        const Error error      = detail::curl_to_error (curl, result, errors);
        response.status_code   = 0;
        response.status_text   = vayu::http::status_text (0);
        response.error_code    = error.code;
        response.error_message = error.message;
    }

    if (response.status_code == 0 && reason != SseEndReason::Error) {
        // A stream ended by a cap before any status line arrived is still not
        // an error, but it has nothing to report either - say so rather than
        // leaving a 0 that reads as a transport failure.
        response.status_text = vayu::http::status_text (0);
    }

    curl_easy_cleanup (curl);
    context.close (reason);
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
        vayu::utils::log_error (std::string (what) + ": " + std::string (detail));
    } catch (...) {
        // @deliberate the logger failed while reporting a failure in a frame
        // that terminates if anything escapes it. There is nowhere left to
        // report to, and dropping the message is this handler's whole job.
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
        // below recover the *stream*, and each of them allocates while doing
        // so, so a second failure raised inside one of them would escape by
        // exactly the route they exist to close. This stays whether or not the
        // linter asks for it.
        try {
            vayu::Response response;
            try {
                response = consume_sse_stream (spec, *context);
            } catch (const std::exception& e) {
                // A worker thread has no handler above it, and a stream that
                // threw must still reach a terminal state or its run is
                // stranded running forever.
                vayu::utils::log_error (
                "SSE stream failed: " + context->run_id + ": " + e.what ());
                response.status_code   = 0;
                response.status_text   = vayu::http::status_text (0);
                response.error_code    = vayu::ErrorCode::InternalError;
                response.error_message = e.what ();
                context->close (SseEndReason::Error);
            }
            if (spec.on_complete) {
                try {
                    spec.on_complete (spec.request, response, *context);
                } catch (const std::exception& e) {
                    vayu::utils::log_error (
                    "Failed to record SSE stream result: " + context->run_id +
                    ": " + e.what ());
                }
            }
        } catch (...) {
            log_unrecoverable ("SSE stream worker failed unrecoverably", context->run_id);
        }
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
