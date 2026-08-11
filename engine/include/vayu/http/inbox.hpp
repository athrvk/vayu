#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::http {

/**
 * What an inbox answers every caller with. Enough to test a webhook sender's
 * retry logic (a 500 after a delay) without being a mock server: one canned
 * answer for every method and path, because an inbox records rather than
 * serves.
 */
struct InboxCannedResponse {
    int status = 200;
    std::string body;
    std::map<std::string, std::string> headers;
    int delay_ms = 0;
};

/** A started inbox as `GET /inbox` and the start/update routes report it. */
struct InboxInfo {
    std::string inbox_id;
    std::string url; // http://<bind>:<port>/
    std::string bind;
    int port = 0;
    /// False once stopped. A stopped inbox keeps its record - and therefore its
    /// captures, which outlive the listener - until the process ends.
    bool running = true;
    /// False when `bind` is neither 127.0.0.0/8 nor ::1; the UI badges those.
    bool loopback = true;
    InboxCannedResponse response;
};

/** A validated `POST /inbox/start` payload. */
struct InboxStartRequest {
    int port         = 0; // 0 = pick an ephemeral port
    std::string bind = "127.0.0.1";
    InboxCannedResponse response;
};

/**
 * The outcome of validating a payload. `ok == false` carries the status and the
 * message the route turns into an error body - kept as plain fields so the
 * parsing cores stay free of the route helpers and testable on their own.
 */
struct InboxParseError {
    int http_status = 400;
    std::string code;
    std::string message;
};

/**
 * The user-settable bounds an inbox works within, resolved from the config
 * table. Every field here is something a user reaches for - how much of a
 * payload to keep, how many payloads, how quickly the list updates.
 *
 * Resolved as a struct rather than read per use, and taken by the decision
 * points as a resolved value rather than a `Database`, so the capture path
 * stays testable without a database - the same split
 * `read_auth_refresh_tuning` draws for the mid-run renewal knobs.
 */
struct InboxLimits {
    int64_t max_body_bytes = vayu::core::constants::inbox::MAX_BODY_BYTES;
    int64_t max_captures   = vayu::core::constants::inbox::MAX_CAPTURES;
    int live_poll_interval_ms = vayu::core::constants::inbox::LIVE_POLL_INTERVAL_MS;
};

/**
 * Read `inboxMaxBodyBytes`, `inboxMaxCaptures` and `inboxLivePollIntervalMs`.
 *
 * A value outside its seeded range can only come from a hand-edited row -
 * `POST /config` rejects one against the same bounds - and falls back to the
 * seed rather than being trusted, as `read_auth_refresh_tuning` does. Resolved
 * once when an inbox starts, so a change applies to inboxes started after it;
 * the running listener keeps the bounds it was started with, which is what
 * keeps one inbox's captures a single, consistently-truncated set.
 */
InboxLimits read_inbox_limits (vayu::db::Database& db);

/** Is @p bind an address only this machine can reach? */
bool is_loopback_bind (const std::string& bind);

/**
 * Validate a `POST /inbox/start` payload.
 *
 * Every rejection is loud rather than a fallback to the default: a canned 900
 * silently answered as 200, or a `bind` typo silently answered on loopback, is
 * a listener doing something other than what its caller asked for, and the
 * caller has no way to see it. The one deliberate exception is absence - every
 * field is optional, and an empty body starts a loopback inbox that answers
 * 200 with no body.
 *
 * A non-loopback `bind` additionally requires `confirmNonLoopback: true`: the
 * engine's management API has no route auth and CORS `*`, so binding wide is a
 * trust decision the caller states rather than one a default makes.
 */
std::optional<InboxParseError>
parse_inbox_start (const nlohmann::json& json, InboxStartRequest& out);

/**
 * Validate a `PUT /inbox/:id` payload against @p current.
 *
 * Merge-patch like the resource routes: an absent field keeps the live value,
 * so changing only the status does not silently drop the configured headers.
 * The payload may be either the canned response itself or `{"response": {...}}`
 * - the start route's shape - so a client can send back what it was given.
 */
std::optional<InboxParseError> parse_inbox_response_update (const nlohmann::json& json,
const InboxCannedResponse& current,
InboxCannedResponse& out);

/**
 * Resolve where `GET /inbox/:id/live` resumes from.
 *
 * @p header_value is `Last-Event-ID`, which the browser sets on its own
 * reconnect; @p param_value is `?lastEventId=`, which is how a client owning
 * its retry says the same thing - `EventSource` cannot set a header on a fresh
 * connection, and a 409 is fatal to it, so the app reconnects by hand (#506).
 * The header wins when both are present, being the more recent of the two.
 * Either may be empty, meaning absent: resume from the start.
 *
 * A present-but-unreadable value is an error rather than a silent 0. The engine
 * only ever emits non-negative integer ids, so anything else is a caller's bug,
 * and resuming from the start would replay every retained capture as though it
 * had just arrived.
 */
std::optional<InboxParseError> parse_live_resume_point (const std::string& header_value,
const std::string& param_value,
int64_t& out);

/** The wire shape of an inbox, shared by start, list and update. */
nlohmann::json inbox_info_json (const InboxInfo& info);

/** The wire shape of one capture, shared by the list and the live stream. */
nlohmann::json inbox_capture_json (const vayu::db::InboxRequest& capture);

/**
 * Identifies one live-stream claim on one inbox.
 *
 * Never zero and never reused, so a stream that was evicted while it was not
 * writing cannot act on the claim that replaced it - see
 * InboxManager::try_claim_live.
 */
using LiveClaim = std::uint64_t;

/**
 * Owns the engine's webhook inbox listeners (issue #480).
 *
 * Each inbox is an independent `httplib::Server` on its own thread that accepts
 * any method on any path, records what arrived, and answers the configured
 * canned response - it serves no engine route, so a non-loopback bind exposes
 * capture-and-echo and nothing else.
 *
 * Thread-safe. The destructor stops and joins every listener, so the `Database`
 * passed to `start()` must outlive the manager (see the member order in
 * server.hpp). A capture handler never takes the manager's own lock, so a
 * teardown holding it can always join.
 */
class InboxManager {
    public:
    // Out-of-line because the map holds unique_ptr<Inbox> and Inbox is
    // incomplete here (same reason as OAuth2AuthorizeManager).
    InboxManager ();
    ~InboxManager ();

    InboxManager (const InboxManager&)            = delete;
    InboxManager& operator= (const InboxManager&) = delete;

    struct StartResult {
        bool ok         = true;
        int http_status = 500;
        std::string error_code;
        std::string error_message;
        InboxInfo info;
    };

    StartResult start (vayu::db::Database& db, const InboxStartRequest& request);

    /// Stop the listener, keeping the record (and its captures) readable.
    /// False when no such inbox exists; stopping a stopped inbox is a no-op.
    bool stop (const std::string& inbox_id);

    std::optional<InboxInfo> get (const std::string& inbox_id);
    std::vector<InboxInfo> list ();

    /// The limits @p inbox_id was started with; nullopt when it does not exist.
    /// Read by the routes so a page cap and a live cadence describe the inbox
    /// they belong to rather than whatever the config says at that moment.
    std::optional<InboxLimits> limits (const std::string& inbox_id);

    /// nullopt when no such inbox exists. Applies to a stopped inbox too - it
    /// is the configuration a restart would use, not the listener's state.
    std::optional<InboxInfo> update_response (const std::string& inbox_id,
    const InboxCannedResponse& response);

    /**
     * Claim the single live-stream slot for an inbox.
     *
     * Each SSE stream occupies one cpp-httplib pool thread for as long as it is
     * open (the server uses the default task queue), so an unbounded number of
     * watchers on one inbox is an unbounded number of parked threads.
     *
     * A claim held by a **provably dead** stream is taken over rather than
     * refused (issue #506): the holder only notices its socket died when the
     * next write fails, up to one poll interval later, so a client reconnecting
     * inside that window used to meet a 409 - which `EventSource` treats as
     * fatal, killing the stream for good. A holder that has not written
     * successfully for `LIVE_CLAIM_STALE_INTERVALS` poll intervals is not
     * writing, so its slot is given to the newcomer. Every live holder writes
     * at least a keep-alive each interval, so a genuinely live stream is never
     * evicted and a second concurrent watcher is still refused.
     *
     * Returns the claim, or nullopt when the inbox does not exist or is watched
     * by a live stream. The claim identifies *which* claim the caller holds:
     * an evicted holder passing its own token to `note_live_write` /
     * `release_live` is a no-op there, so it can neither keep its successor's
     * clock alive nor release its successor's slot.
     */
    std::optional<LiveClaim> try_claim_live (const std::string& inbox_id);

    /**
     * Record that @p claim just wrote to its socket, and report whether it is
     * still the holder.
     *
     * False means the claim was taken over while this stream was not writing -
     * the caller must end its stream without releasing, since the slot now
     * belongs to someone else.
     */
    bool note_live_write (const std::string& inbox_id, LiveClaim claim);

    /// Release @p claim's slot. A no-op when @p claim is no longer the holder.
    void release_live (const std::string& inbox_id, LiveClaim claim);

    private:
    struct Inbox;
    std::mutex mutex_;
    std::map<std::string, std::unique_ptr<Inbox>> inboxes_;
    /// Source of claim tokens; monotonic so a token is never reused, and
    /// therefore never mistaken for a later claim on the same inbox.
    LiveClaim next_live_claim_ = 1;

    void teardown_locked (Inbox& inbox);
};

} // namespace vayu::http
