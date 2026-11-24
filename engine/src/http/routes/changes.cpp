/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `GET /changes`, the workspace change feed (#3420): one SSE event per
 * committed write, so a client caching rows hears of another client's writes;
 * and `POST /changes/subscriptions`, the only way to get the id a stream needs.
 * The relay is `GET /runs/:id/events`' poll-and-keep-alive loop over the
 * `ChangeFeed` `Database` publishes to, with `GET /inbox/:id/live`'s resume
 * parsing. Every client reads one feed, up to `MAX_READERS` at once, each
 * stream opened with a single-use subscription id: a plain `GET` (all a web
 * page can send without an `Origin`) holds no slot, so a page cannot fill the
 * feed and lock the app out.
 */

#include "vayu/core/constants.hpp"
#include "vayu/db/change_feed.hpp"
#include "vayu/http/inbox.hpp"
#include "vayu/http/routes.hpp"

#include <atomic>
#include <chrono>
#include <optional>
#include <string>
#include <thread>

namespace vayu::http::routes {

namespace {

namespace sse_constants = vayu::core::constants::sse;
using vayu::db::ChangeFeed;

/// A `ready` or `reset` frame: the id the reader now stands at, as both the
/// frame id (so `EventSource` resumes from it) and the data.
std::string position_frame (const char* event_name, int64_t id) {
    return vayu::core::build_sse_frame (event_name,
    nlohmann::json{ { "lastEventId", id } }.dump (), static_cast<size_t> (id));
}

std::string change_frame (const vayu::db::ChangeEvent& event) {
    // Ids and names a hand-edited row carries need not be UTF-8; a strict dump
    // would end the stream on one.
    return vayu::core::build_sse_frame ("change",
    vayu::db::change_json (event.change).dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
    static_cast<size_t> (event.id));
}

/// Where a stream starts, and the frame that says so.
struct Opening {
    int64_t cursor = 0;
    std::string frame;
};

/**
 * Every stream opens with one `ready` or `reset`. A fresh one starts at the
 * newest id and says so, which gives an `EventSource` an id to resume from even
 * when it drops before the first change. A resume the ring still covers starts
 * where the reader left off; one it does not is a `reset`.
 */
Opening open_stream (const ChangeFeed& feed, std::optional<int64_t> resume_from) {
    if (!resume_from) {
        const int64_t newest = feed.last_id ();
        return Opening{ newest, position_frame ("ready", newest) };
    }
    const auto read = feed.since (*resume_from);
    if (read.reset) {
        return Opening{ read.last_id, position_frame ("reset", read.last_id) };
    }
    return Opening{ *resume_from, position_frame ("ready", *resume_from) };
}

/** What one poll of the feed leaves the stream in. */
enum class FeedStep : std::uint8_t {
    Wrote,  ///< Frames went out; poll again without waiting.
    Idle,   ///< Nothing to send - wait before the next poll.
    Closed, ///< The client is gone - a write failed.
};

bool write_frame (httplib::DataSink& sink, const std::string& frame) {
    return sink.write (frame.data (), frame.size ());
}

/**
 * One poll: the changes after @p cursor, a `reset` when they are no longer all
 * retained (a reader that fell more than a ring behind between two polls), or
 * a keep-alive once the stream has been quiet for long enough.
 */
FeedStep relay_changes_step (const ChangeFeed& feed,
int64_t& cursor,
std::chrono::steady_clock::time_point& last_write,
httplib::DataSink& sink) {
    const auto read = feed.since (cursor);
    if (read.reset) {
        if (!write_frame (sink, position_frame ("reset", read.last_id))) {
            return FeedStep::Closed;
        }
        cursor     = read.last_id;
        last_write = std::chrono::steady_clock::now ();
        return FeedStep::Wrote;
    }
    for (const auto& event : read.events) {
        if (!write_frame (sink, change_frame (event))) {
            return FeedStep::Closed;
        }
        cursor = event.id;
    }
    if (!read.events.empty ()) {
        last_write = std::chrono::steady_clock::now ();
        return FeedStep::Wrote;
    }

    const auto quiet = std::chrono::steady_clock::now () - last_write;
    if (quiet >= std::chrono::milliseconds (sse_constants::RELAY_KEEPALIVE_MS)) {
        if (!write_frame (sink, ": keep-alive\n\n")) {
            return FeedStep::Closed;
        }
        last_write = std::chrono::steady_clock::now ();
    }
    return FeedStep::Idle;
}

/**
 * The stream itself, until the client goes or the server stops (#2683). The
 * feed outlives every handler: `Server::stop()` joins them before the daemon
 * destroys the `Database` that owns it. Always answers `false`, the provider
 * being done when this returns.
 */
bool relay_changes (const ChangeFeed& feed,
std::optional<int64_t> resume_from,
const std::atomic<bool>& stopping,
httplib::DataSink& sink) {
    auto opening = open_stream (feed, resume_from);
    if (!write_frame (sink, opening.frame)) {
        return false;
    }
    auto last_write = std::chrono::steady_clock::now ();
    while (sink.is_writable () && !stopping) {
        const FeedStep step = relay_changes_step (feed, opening.cursor, last_write, sink);
        if (step == FeedStep::Closed) {
            break;
        }
        if (step == FeedStep::Idle) {
            std::this_thread::sleep_for (
            std::chrono::milliseconds (sse_constants::RELAY_POLL_INTERVAL_MS));
        }
    }
    return false;
}

/**
 * Spends the `subscription` query parameter. Answers the refusal itself and
 * false when it is absent or names no unspent id: a request that holds no
 * slot, so a loop of them cannot crowd out a reader with an id.
 */
bool redeem_subscription_param (ChangeFeed& feed,
const httplib::Request& req,
httplib::Response& res) {
    if (!req.has_param ("subscription")) {
        send_error (res, 400,
        "The subscription query parameter is required: POST "
        "/changes/subscriptions for one",
        "subscription_required");
        return false;
    }
    if (!feed.redeem_subscription (req.get_param_value ("subscription"))) {
        send_error (res, 403,
        "The subscription query parameter names no unused subscription: an "
        "id opens one stream, so POST /changes/subscriptions for another",
        "unknown_subscription");
        return false;
    }
    return true;
}

void handle_changes (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const std::string header = req.get_header_value ("Last-Event-ID");
    const std::string param  = req.get_param_value ("lastEventId");
    const auto resume_point  = parse_live_resume_point (header, param, "event");
    if (!resume_point) {
        const auto& refusal = resume_point.error ();
        send_error (res, refusal.http_status, refusal.message, refusal.code);
        return;
    }
    // Presence decides, as on `/runs/:id/events`: the parse answers 0 for an
    // absent id, and 0 is also an id a reader can hold.
    std::optional<int64_t> resume_from;
    if (!header.empty () || !param.empty ()) {
        resume_from = *resume_point;
    }

    ChangeFeed& feed = ctx.db.change_feed ();
    if (!redeem_subscription_param (feed, req, res)) {
        return;
    }
    if (!feed.try_add_reader ()) {
        // A slot whose client has gone is freed at its next keep-alive write.
        res.set_header ("Retry-After",
        std::to_string (sse_constants::RELAY_KEEPALIVE_MS / 1000));
        send_error (res, 503,
        "Too many change streams are open; close one, or retry once a "
        "closed one has been noticed",
        "change_feed_full");
        return;
    }

    // The releaser runs when the response is destroyed, whether or not the
    // provider ever ran, so a slot cannot leak on a client that left first.
    res.set_content_provider (
    "text/event-stream",
    [&feed, resume_from, &stopping = ctx.server_stopping] (size_t, httplib::DataSink& sink) {
        return relay_changes (feed, resume_from, stopping, sink);
    },
    [&feed] (bool) { feed.remove_reader (); });
}

void handle_subscribe (RouteContext& ctx, httplib::Response& res) {
    send_json (res,
    nlohmann::json{ { "subscription", ctx.db.change_feed ().issue_subscription () } });
}

} // namespace

void register_change_feed_routes (RouteContext& ctx) {
    /**
     * POST /changes/subscriptions
     *
     * `{subscription}`: an unguessable, single-use id for one `GET /changes`.
     * A `POST`, so a web page can send it only with an `Origin`, which the
     * management-API gate refuses; the page cannot learn an id or hold a slot.
     */
    ctx.server.Post ("/changes/subscriptions",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        handle_subscribe (ctx, res);
    });

    /**
     * GET /changes?subscription=<id>
     *
     * One `event: change` per committed write of a collection, request,
     * example, environment, the globals or a trash entry, data
     * `{kind, id, op, collectionId?, requestId?}` and `id:` the feed's event
     * id. Opens with `event: ready` (or `reset`), resumes from
     * `Last-Event-ID` / `?lastEventId=`, and sends `event: reset` when the
     * events since that id are no longer retained: the reader refetches
     * everything. A missing `subscription` is a 400 and an unknown or spent
     * one a 403, neither holding a slot; a full feed is a 503 that spends the
     * id. Reads only: a stream changes nothing.
     */
    ctx.server.Get ("/changes", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_changes (ctx, req, res);
    });
}

} // namespace vayu::http::routes
