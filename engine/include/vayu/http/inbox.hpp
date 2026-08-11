#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"

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

/** The wire shape of an inbox, shared by start, list and update. */
nlohmann::json inbox_info_json (const InboxInfo& info);

/** The wire shape of one capture, shared by the list and the live stream. */
nlohmann::json inbox_capture_json (const vayu::db::InboxRequest& capture);

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

    /// nullopt when no such inbox exists. Applies to a stopped inbox too - it
    /// is the configuration a restart would use, not the listener's state.
    std::optional<InboxInfo> update_response (const std::string& inbox_id,
    const InboxCannedResponse& response);

    /**
     * Claim the single live-stream slot for an inbox.
     *
     * Each SSE stream occupies one cpp-httplib pool thread for as long as it is
     * open (the server uses the default task queue), so an unbounded number of
     * watchers on one inbox is an unbounded number of parked threads. Returns
     * false when the inbox does not exist or is already watched; the caller
     * must `release_live` whatever it claimed.
     */
    bool try_claim_live (const std::string& inbox_id);
    void release_live (const std::string& inbox_id);

    private:
    struct Inbox;
    std::mutex mutex_;
    std::map<std::string, std::unique_ptr<Inbox>> inboxes_;

    void teardown_locked (Inbox& inbox);
};

} // namespace vayu::http
