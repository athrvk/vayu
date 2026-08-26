/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/events.cpp
 * @brief `GET /runs/:id/events` - the relay that hands a streaming run's events
 *        to a client (issue #573).
 *
 * An assembly of machinery that already exists rather than new invention: the
 * bounded ring and its replay-then-tail read are `GET /runs/:id/live`'s
 * (pattern B), the resume parsing and the one-stream claim are
 * `GET /inbox/:id/live`'s (pattern A). What is new is only the source - a
 * consumer worker's ring instead of a metrics thread's.
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/inbox.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/logger.hpp"

#include <chrono>
#include <string>
#include <thread>

namespace vayu::http::routes {

namespace {

namespace sse_constants = vayu::core::constants::sse;

/// How long a finished stream stays readable, reusing the live-metrics
/// retention knob: both answer the same question - how long after a run ends
/// may a dashboard still attach and replay it - and two settings for it would
/// only ever disagree.
int64_t stream_retention_ms (vayu::db::Database& db) {
    return static_cast<int64_t> (db.get_config_int ("liveRetentionMs", 60000));
}

} // namespace

namespace {

/** What one poll of the relay leaves the stream in. */
enum class RelayStep {
    Wrote,     ///< Frames went out; poll again without waiting.
    Idle,      ///< Nothing to send - wait before the next poll.
    Drained,   ///< The producer has closed and the ring is empty.
    Closed,    ///< The client is gone - a write failed.
    ClaimLost, ///< A reconnect took the slot over; this stream is no longer it.
};

/**
 * One poll: the frames since @p offset, and - when there are none - a
 * keep-alive if this stream has been quiet for long enough.
 *
 * A write that lands is the only evidence the socket is alive, and therefore
 * what holds the claim: losing it means a reconnect already took the slot over,
 * so the stream ends without releasing what is no longer its own.
 */
RelayStep relay_events_step (const std::shared_ptr<vayu::http::SseStreamContext>& context,
vayu::http::LiveClaim claim,
size_t& offset,
std::chrono::steady_clock::time_point& last_write,
httplib::DataSink& sink) {
    auto batch = context->events_since (offset);
    for (const auto& payload : batch.payloads) {
        if (!sink.write (payload.data (), payload.size ())) {
            return RelayStep::Closed;
        }
    }
    // Adopt the producer's offset rather than advancing by the batch size: a
    // resume from before the retained window skips ahead instead of
    // re-requesting evicted ids forever.
    offset = batch.next_offset;

    if (!batch.payloads.empty ()) {
        if (!context->note_claim_write (claim)) {
            return RelayStep::ClaimLost;
        }
        last_write = std::chrono::steady_clock::now ();
        return RelayStep::Wrote;
    }

    // Terminate only once the producer has published its final frame AND the
    // ring is drained - never on the worker's liveness, which flips before the
    // last frame lands.
    if (context->closed () && offset >= context->published_count ()) {
        return RelayStep::Drained;
    }

    const auto since = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - last_write)
                       .count ();
    if (since >= sse_constants::RELAY_KEEPALIVE_MS) {
        const std::string keep_alive = ": keep-alive\n\n";
        if (!sink.write (keep_alive.data (), keep_alive.size ())) {
            return RelayStep::Closed;
        }
        if (!context->note_claim_write (claim)) {
            return RelayStep::ClaimLost;
        }
        last_write = std::chrono::steady_clock::now ();
    }
    return RelayStep::Idle;
}

/**
 * The relay itself, from @p resume_from to the producer's last frame.
 *
 * Always answers `false` - the provider is done when this returns. Every stream
 * ends with a statement of why, including one whose consumer had already drained
 * the ring: the reason is the answer to "did I see everything?", so it cannot be
 * inferable only from having been connected at the right moment. The exception
 * is a lost claim, where the slot - and the completion frame with it - belongs
 * to the stream that took it over.
 */
bool relay_run_events (const std::shared_ptr<vayu::http::SseStreamContext>& context,
size_t resume_from,
vayu::http::LiveClaim claim,
httplib::DataSink& sink) {
    auto offset     = resume_from;
    auto last_write = std::chrono::steady_clock::now ();

    while (sink.is_writable ()) {
        const RelayStep step =
        relay_events_step (context, claim, offset, last_write, sink);
        if (step == RelayStep::Closed) {
            context->release_claim (claim);
            return false;
        }
        if (step == RelayStep::ClaimLost) {
            return false;
        }
        if (step == RelayStep::Drained) {
            break;
        }
        if (step == RelayStep::Idle) {
            std::this_thread::sleep_for (
            std::chrono::milliseconds (sse_constants::RELAY_POLL_INTERVAL_MS));
        }
    }

    const std::string payload = vayu::core::build_sse_frame ("complete",
    stream_completion_json (*context).dump (), context->published_count ());
    sink.write (payload.data (), payload.size ());
    context->release_claim (claim);
    return false;
}

void handle_run_events (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const std::string run_id = req.matches[1];

    // Swept before the lookup, the same cadence `/runs/:id/live` sweeps at:
    // a run whose retention has expired must not answer as though it were
    // still live.
    ctx.sse_manager.sweep_retained (stream_retention_ms (ctx.db));

    auto context = ctx.sse_manager.get (run_id);
    if (!context) {
        res.status = 404;
        nlohmann::json error;
        error["error"] = "No event stream for this run";
        error["hint"]  = "The stream has expired; the stored events are in "
                         "GET /runs/" +
        run_id + "/report";
        res.set_content (error.dump (), "application/json");
        return;
    }

    const auto resume_point = parse_live_resume_point (
    req.get_header_value ("Last-Event-ID"), req.get_param_value ("lastEventId"));
    if (!resume_point) {
        const auto& refusal = resume_point.error ();
        send_error (res, refusal.http_status, refusal.message, refusal.code);
        return;
    }
    // Frame ids start at 0, so - unlike the inbox's capture ids - "0" is a
    // real resume point and cannot double as "absent". Presence decides,
    // and a resume starts at the frame *after* the last one seen.
    const bool resuming = !req.get_header_value ("Last-Event-ID").empty () ||
    !req.get_param_value ("lastEventId").empty ();
    const auto resume_from =
    resuming ? static_cast<size_t> (*resume_point) + 1 : static_cast<size_t> (0);

    const auto claim = context->try_claim ();
    if (!claim) {
        send_error (res, 409,
        "This run's events are already being streamed; close the other "
        "stream first",
        "run_events_in_use");
        return;
    }

    res.set_content_provider ("text/event-stream",
    [context, resume_from, claim = *claim] (size_t, httplib::DataSink& sink) {
        return relay_run_events (context, resume_from, claim, sink);
    });
}

} // namespace

void register_event_stream_routes (RouteContext& ctx) {
    /**
     * GET /runs/:runId/events
     *
     * Replays the run's retained events, then tails until the stream ends, and
     * closes with `event: complete` naming the termination reason. `id:` is the
     * frame's absolute offset, so `?lastEventId=` / `Last-Event-ID` resumes
     * exactly where a dropped consumer left off - or is fast-forwarded to the
     * oldest retained frame when it asks for one already evicted.
     *
     * One consumer at a time: each stream parks a cpp-httplib pool thread for
     * its whole life. A second concurrent watcher is a 409, but a claim whose
     * holder has stopped writing is taken over instead of refused (issue #506)
     * - `EventSource` treats a 409 as fatal, so refusing a reconnect that
     * raced the previous socket's death would kill the stream for good.
     */
    ctx.server.Get (R"(/runs/([^/]+)/events)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_run_events (ctx, req, res);
    });
}

} // namespace vayu::http::routes
