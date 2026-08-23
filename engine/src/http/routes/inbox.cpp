/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/inbox.cpp
 * @brief The webhook inbox: an engine-hosted listener that records the requests
 *        sent to it (issue #480), plus the routes that drive it. Lives with the
 *        routes for the same reason oauth_authorize.cpp does - the listener
 *        needs httplib, which is linked into the engine and the tests.
 */

#include "vayu/http/inbox.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/http/managed_listener.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <httplib.h>

#include <algorithm>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <expected>
#include <optional>
#include <string_view>
#include <thread>

namespace vayu::http {

namespace constants = vayu::core::constants;

namespace {

std::string lower (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char ch) { return static_cast<char> (std::tolower (ch)); });
    return value;
}

/// The engine's own listener answers on 9876; an inbox must not be told to
/// fight it for the port, and 0 means "pick one".
bool is_valid_port (int port) {
    return port >= 0 && port <= 65535;
}

/**
 * Collapse httplib's header multimap into a JSON object, joining a repeated
 * name with ", " as RFC 9110 §5.3 permits. Repeated headers are recorded rather
 * than the last one winning: `Set-Cookie` and `Forwarded` legitimately repeat,
 * and a capture that showed one of two is a capture that lies.
 */
// nlohmann's internal `swap` inlined into the object build: GCC cannot see that
// a `basic_json` it just constructed holds a value, and reports the move as a
// potential null dereference. See utils/diagnostics.hpp.
VAYU_IGNORE_FALSE_NULL_DEREFERENCE
nlohmann::json headers_to_json (const httplib::Headers& headers) {
    nlohmann::json out = nlohmann::json::object ();
    for (const auto& [name, value] : headers) {
        if (auto it = out.find (name); it != out.end ()) {
            *it = it->get<std::string> () + ", " + value;
        } else {
            out[name] = value;
        }
    }
    return out;
}
VAYU_DIAGNOSTIC_POP

/// The raw query string of a request target, without the '?'.
std::string query_of (const std::string& target) {
    const auto pos = target.find ('?');
    return pos == std::string::npos ? std::string{} : target.substr (pos + 1);
}

/// Read a canned response's content type without assuming the caller's casing.
std::string content_type_of (const std::map<std::string, std::string>& headers) {
    for (const auto& [name, value] : headers) {
        if (lower (name) == "content-type") {
            return value;
        }
    }
    return {};
}

} // namespace

InboxLimits read_inbox_limits (vayu::db::Database& db) {
    const InboxLimits defaults;
    // A value outside the seeded range can only reach here from a hand-edited
    // row - POST /config rejects one against each key's min/max - and a body cap
    // of 0 or a retention of 0 would quietly turn every capture into an empty
    // row. Fall back rather than trust it, as read_auth_refresh_tuning does.
    auto read = [&db] (const char* key, int64_t fallback, int64_t low, int64_t high) {
        const auto value =
        static_cast<int64_t> (db.get_config_int (key, static_cast<int> (fallback)));
        return (value >= low && value <= high) ? value : fallback;
    };

    InboxLimits limits;
    limits.max_body_bytes = read ("inboxMaxBodyBytes", defaults.max_body_bytes,
    constants::inbox::MIN_BODY_BYTES,
    static_cast<int64_t> (constants::inbox::MAX_PAYLOAD_BYTES));
    limits.max_captures   = read ("inboxMaxCaptures", defaults.max_captures,
      constants::inbox::MIN_CAPTURES, constants::inbox::CAPTURES_CEILING);
    limits.live_poll_interval_ms =
    static_cast<int> (read ("inboxLivePollIntervalMs",
    defaults.live_poll_interval_ms, constants::inbox::MIN_LIVE_POLL_INTERVAL_MS,
    constants::inbox::MAX_LIVE_POLL_INTERVAL_MS));
    return limits;
}

namespace {

/**
 * The first octet of @p bind when it is a dotted-quad IPv4 literal, otherwise
 * `std::nullopt`.
 *
 * A parse rather than a prefix match: a *hostname* like `127.example.com` also
 * starts with `127.` but resolves wherever DNS says, so treating it as loopback
 * would bind wide while reporting `loopback: true` and skipping the
 * confirmation gate. Shorthand forms (`127.1`) are not addresses here either -
 * they only cost their user an explicit `confirmNonLoopback`, which is the safe
 * direction to be wrong in.
 */
std::optional<unsigned> ipv4_first_octet (std::string_view bind) {
    unsigned first    = 0;
    std::size_t start = 0;
    for (int octet = 0; octet < 4; ++octet) {
        const std::size_t dot = bind.find ('.', start);
        const bool is_last    = octet == 3;
        if (is_last == (dot != std::string_view::npos)) {
            return std::nullopt; // A missing separator, or a fifth octet.
        }
        const std::string_view part =
        bind.substr (start, is_last ? std::string_view::npos : dot - start);
        if (part.empty () || part.size () > 3) {
            return std::nullopt;
        }
        unsigned value        = 0;
        const auto* const end = part.data () + part.size ();
        const auto [ptr, ec]  = std::from_chars (part.data (), end, value);
        if (ec != std::errc () || ptr != end || value > 255) {
            return std::nullopt;
        }
        if (octet == 0) {
            first = value;
        }
        start = dot + 1;
    }
    return first;
}

} // namespace

bool is_loopback_bind (const std::string& bind) {
    if (bind == "localhost" || bind == "::1" || bind == "[::1]") {
        return true;
    }
    // The whole of 127.0.0.0/8 is loopback, not just the canonical address.
    const auto first = ipv4_first_octet (bind);
    return first.has_value () && *first == 127;
}

// ---------------------------------------------------------------------------
// Payload validation (pure - unit-tested without a listener)
// ---------------------------------------------------------------------------

namespace {

/**
 * Read the canned-response fields of @p json onto @p merged, which the caller
 * has seeded with the values an absent field should keep.
 */
std::expected<InboxCannedResponse, InboxParseError>
apply_response_fields (const nlohmann::json& json, InboxCannedResponse merged) {
    if (const auto it = json.find ("status"); it != json.end () && !it->is_null ()) {
        if (!it->is_number_integer () || it->get<int> () < 100 || it->get<int> () > 599) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code = "bad_request",
            .message =
            "Invalid 'status': must be an integer between 100 and 599" });
        }
        merged.status = it->get<int> ();
    }
    if (const auto it = json.find ("body"); it != json.end () && !it->is_null ()) {
        if (!it->is_string ()) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "bad_request",
            .message = "Invalid 'body': must be a string" });
        }
        merged.body = it->get<std::string> ();
    }
    if (const auto it = json.find ("delayMs"); it != json.end () && !it->is_null ()) {
        if (!it->is_number_integer () || it->get<int> () < 0 ||
        it->get<int> () > constants::inbox::MAX_RESPONSE_DELAY_MS) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "bad_request",
            .message = "Invalid 'delayMs': must be an integer between 0 and " +
            std::to_string (constants::inbox::MAX_RESPONSE_DELAY_MS) });
        }
        merged.delay_ms = it->get<int> ();
    }
    if (const auto it = json.find ("headers"); it != json.end () && !it->is_null ()) {
        if (!it->is_object ()) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code = "bad_request",
            .message =
            "Invalid 'headers': must be a JSON object of string values" });
        }
        std::map<std::string, std::string> headers;
        for (const auto& [name, value] : it->items ()) {
            if (!value.is_string ()) {
                return std::unexpected (InboxParseError{ .http_status = 400,
                .code = "bad_request",
                .message = "Invalid 'headers." + name + "': must be a string" });
            }
            headers[name] = value.get<std::string> ();
        }
        merged.headers = std::move (headers);
    }
    return merged;
}

} // namespace

std::expected<InboxStartRequest, InboxParseError> parse_inbox_start (
const nlohmann::json& json) {
    InboxStartRequest parsed;
    if (json.is_null ()) {
        return parsed; // No body at all - every field is optional.
    }
    if (!json.is_object ()) {
        return std::unexpected (InboxParseError{ .http_status = 400,
        .code                                                 = "bad_request",
        .message = "Request body must be a JSON object" });
    }

    if (const auto it = json.find ("port"); it != json.end () && !it->is_null ()) {
        if (!it->is_number_integer () || !is_valid_port (it->get<int> ())) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code = "bad_request",
            .message =
            "Invalid 'port': must be an integer between 0 and 65535 (0 picks a "
            "free port)" });
        }
        parsed.port = it->get<int> ();
    }

    if (const auto it = json.find ("bind"); it != json.end () && !it->is_null ()) {
        if (!it->is_string () || it->get<std::string> ().empty ()) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "bad_request",
            .message = "Invalid 'bind': must be a non-empty string" });
        }
        parsed.bind = it->get<std::string> ();
    }

    if (!is_loopback_bind (parsed.bind)) {
        const auto confirm = json.find ("confirmNonLoopback");
        const bool confirmed =
        confirm != json.end () && confirm->is_boolean () && confirm->get<bool> ();
        if (!confirmed) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "inbox_non_loopback_bind",
            .message = "Binding an inbox to '" + parsed.bind +
            "' exposes it beyond this machine; resend with "
            "\"confirmNonLoopback\": true to accept that" });
        }
    }

    if (const auto it = json.find ("response"); it != json.end () && !it->is_null ()) {
        if (!it->is_object ()) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "bad_request",
            .message = "Invalid 'response': must be a JSON object" });
        }
        auto response = apply_response_fields (*it, parsed.response);
        if (!response) {
            return std::unexpected (response.error ());
        }
        parsed.response = std::move (*response);
    }
    return parsed;
}

std::expected<InboxCannedResponse, InboxParseError>
parse_inbox_response_update (const nlohmann::json& json, const InboxCannedResponse& current) {
    if (!json.is_object ()) {
        return std::unexpected (InboxParseError{ .http_status = 400,
        .code                                                 = "bad_request",
        .message = "Request body must be a JSON object" });
    }
    // Accept the start route's own shape so a client can send back what it was
    // handed; `{"response": null}` means the same as an empty body (keep).
    if (const auto it = json.find ("response"); it != json.end ()) {
        if (it->is_null ()) {
            return current;
        }
        if (!it->is_object ()) {
            return std::unexpected (InboxParseError{ .http_status = 400,
            .code    = "bad_request",
            .message = "Invalid 'response': must be a JSON object" });
        }
        return apply_response_fields (*it, current);
    }
    return apply_response_fields (json, current);
}

nlohmann::json inbox_info_json (const InboxInfo& info) {
    nlohmann::json response;
    response["status"]  = info.response.status;
    response["body"]    = info.response.body;
    response["delayMs"] = info.response.delay_ms;
    response["headers"] = nlohmann::json::object ();
    for (const auto& [name, value] : info.response.headers) {
        response["headers"][name] = value;
    }

    nlohmann::json out;
    out["inboxId"]      = info.inbox_id;
    out["url"]          = info.url;
    out["bind"]         = info.bind;
    out["port"]         = info.port;
    out["running"]      = info.running;
    out["loopback"]     = info.loopback;
    out["captureCount"] = info.capture_count;
    out["response"]     = std::move (response);
    return out;
}

std::expected<int64_t, InboxParseError>
parse_live_resume_point (const std::string& header_value, const std::string& param_value) {
    // The header is the browser's own reconnect and therefore the more recent
    // of the two; an empty one is absent, not a resume point of "".
    const std::string& value = header_value.empty () ? param_value : header_value;
    const char* source = header_value.empty () ? "lastEventId" : "Last-Event-ID";
    if (value.empty ()) {
        return 0;
    }

    int64_t parsed_id = 0;
    const char* begin = value.data ();
    const char* end   = begin + value.size ();
    const auto parsed = std::from_chars (begin, end, parsed_id);
    if (parsed.ec != std::errc{} || parsed.ptr != end || parsed_id < 0) {
        return std::unexpected (InboxParseError{ .http_status = 400,
        .code = "invalid_last_event_id",
        .message = std::string (source) + " must be a non-negative capture id" });
    }
    return parsed_id;
}

nlohmann::json inbox_capture_json (const vayu::db::InboxRequest& capture) {
    nlohmann::json out;
    out["id"]         = capture.id;
    out["inboxId"]    = capture.inbox_id;
    out["receivedAt"] = capture.received_at;
    out["method"]     = capture.method;
    out["path"]       = capture.path;
    out["query"]      = capture.query;
    try {
        out["headers"] = nlohmann::json::parse (capture.headers);
    } catch (const std::exception&) {
        // A row this engine wrote always parses; a damaged one still lists.
        out["headers"] = nlohmann::json::object ();
    }
    out["body"]          = capture.body;
    out["bodyBytes"]     = capture.body_bytes;
    out["bodyTruncated"] = capture.body_truncated;
    out["remoteAddr"]    = capture.remote_addr;
    return out;
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

struct InboxManager::Inbox {
    std::string id;
    std::string bind;
    int port = 0;
    /// Resolved once at start and const thereafter, so every capture in one
    /// inbox was truncated and retained by the same rules.
    InboxLimits limits;
    /// One live SSE stream per inbox; see InboxManager::try_claim_live. Guarded
    /// by InboxManager::mutex_ - every accessor locks it - which is the
    /// externally-locked-by-its-owner contract LiveClaimSlot is written to.
    LiveClaimSlot live_claim;

    /// Guards `response` only. The capture handler takes this and never the
    /// manager's lock, so a teardown holding the manager lock can always join.
    std::mutex response_mutex;
    InboxCannedResponse response;

    /// Declared last so it is destroyed first: the capture handler reads the
    /// limits and the canned response above it while the accept loop is alive.
    /// Its listening state *is* the inbox's `running` - a stopped inbox keeps
    /// its record, so there is nothing else for `running` to mean.
    ManagedListener listener;

    InboxInfo info_locked () const {
        InboxInfo info;
        info.inbox_id = id;
        info.bind     = bind;
        info.port     = port;
        info.url      = "http://" + bind + ":" + std::to_string (port) + "/";
        info.running  = listener.is_listening ();
        info.loopback = is_loopback_bind (bind);
        info.response = response;
        return info;
    }
};

InboxManager::InboxManager () = default;

InboxManager::~InboxManager () {
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& [id, inbox] : inboxes_) {
        teardown_locked (*inbox);
    }
    inboxes_.clear ();
}

void InboxManager::teardown_locked (Inbox& inbox) {
    // A capture in its configured delay is still holding a listener thread, so
    // the join inside stop() waits up to inbox::MAX_RESPONSE_DELAY_MS - which
    // is why that bound exists.
    inbox.listener.stop ();
}

InboxManager::StartResult
InboxManager::start (vayu::db::Database& db, const InboxStartRequest& request) {
    StartResult out;

    auto inbox      = std::make_unique<Inbox> ();
    inbox->limits   = read_inbox_limits (db);
    inbox->id       = vayu::utils::generate_id ("inbox_");
    inbox->bind     = request.bind;
    inbox->response = request.response;
    // Reject an oversized upload at the transport rather than buffering it:
    // the handler below only ever stores a prefix anyway.
    inbox->listener.server ().set_payload_max_length (constants::inbox::MAX_PAYLOAD_BYTES);

    Inbox* raw                       = inbox.get ();
    httplib::Server::Handler capture = [raw, &db] (const httplib::Request& req,
                                       httplib::Response& res) {
        vayu::db::InboxRequest capture_row;
        capture_row.inbox_id    = raw->id;
        capture_row.received_at = routes::now_ms ();
        capture_row.method      = req.method;
        capture_row.path        = req.path;
        capture_row.query       = query_of (req.target);
        capture_row.headers     = headers_to_json (req.headers).dump ();
        capture_row.body_bytes  = static_cast<int64_t> (req.body.size ());
        capture_row.body_truncated = capture_row.body_bytes > raw->limits.max_body_bytes;
        capture_row.body        = capture_row.body_truncated ?
               req.body.substr (0, static_cast<size_t> (raw->limits.max_body_bytes)) :
               req.body;
        capture_row.remote_addr = req.remote_addr;

        try {
            db.add_inbox_request (capture_row, raw->limits.max_captures);
        } catch (const std::exception& e) {
            // The sender is told the truth: nothing was recorded. Answering the
            // canned response here would make a dropped capture invisible on
            // both sides.
            vayu::utils::log_error ("Inbox " + raw->id +
            " could not store a capture: " + std::string (e.what ()));
            res.status = 500;
            res.set_content (routes::error_body (500, "Inbox capture could not be stored", "inbox_store_failed")
                             .dump (),
            "application/json");
            return;
        }

        InboxCannedResponse canned;
        {
            std::lock_guard<std::mutex> lock (raw->response_mutex);
            canned = raw->response;
        }
        if (canned.delay_ms > 0) {
            std::this_thread::sleep_for (std::chrono::milliseconds (canned.delay_ms));
        }

        res.status                     = canned.status;
        const std::string content_type = content_type_of (canned.headers);
        for (const auto& [name, value] : canned.headers) {
            if (lower (name) != "content-type") {
                res.set_header (name, value);
            }
        }
        if (!canned.body.empty ()) {
            res.set_content (canned.body, content_type.empty () ? "text/plain" : content_type);
        } else if (!content_type.empty ()) {
            res.set_header ("Content-Type", content_type);
        }
    };

    // Every method cpp-httplib will route, on every path. CONNECT, TRACE and
    // PRI are the remainder and are not routable - a webhook is never one.
    httplib::Server& svr = inbox->listener.server ();
    svr.Get (".*", capture); // also serves HEAD
    svr.Post (".*", capture);
    svr.Put (".*", capture);
    svr.Patch (".*", capture);
    svr.Delete (".*", capture);
    svr.Options (".*", capture);

    const auto started =
    inbox->listener.start (request.bind, request.port, "inbox " + inbox->id);
    if (started.port <= 0) {
        const std::string where = request.bind + ":" +
        (request.port > 0 ? std::to_string (request.port) : std::string ("(any)"));
        out.ok            = false;
        out.http_status   = 409;
        out.error_code    = "inbox_bind_failed";
        out.error_message = started.held_by.empty () ?
        "Could not bind " + where + " - the address may be in use or unavailable" :
        "Could not bind " + where + " - " + started.held_by + " is already listening there";
        return out;
    }
    inbox->port = started.port;

    {
        std::lock_guard<std::mutex> lock (mutex_);
        {
            // The listener is already accepting, so a capture handler may be
            // reading `response` while this snapshot is taken.
            std::lock_guard<std::mutex> response_lock (inbox->response_mutex);
            out.info = inbox->info_locked ();
        }
        inboxes_[inbox->id] = std::move (inbox);
    }
    out.ok          = true;
    out.http_status = 200;
    vayu::utils::log_info (
    "Inbox started: " + out.info.inbox_id + " on " + out.info.url);
    return out;
}

bool InboxManager::stop (const std::string& inbox_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return false;
    }
    teardown_locked (*it->second);
    vayu::utils::log_info ("Inbox stopped: " + inbox_id);
    return true;
}

std::optional<int64_t>
InboxManager::remove (vayu::db::Database& db, const std::string& inbox_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return std::nullopt;
    }
    // Stop first: the join inside it is what makes "no capture can still be
    // landing" true, so the clear below cannot race a webhook into rows that
    // outlive the record. See the header for why the order is load-bearing.
    teardown_locked (*it->second);
    const int64_t deleted = db.clear_inbox_requests (inbox_id);
    inboxes_.erase (it);
    vayu::utils::log_info (
    "Inbox deleted: " + inbox_id + " (" + std::to_string (deleted) + " captures)");
    return deleted;
}

std::optional<InboxInfo> InboxManager::get (const std::string& inbox_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return std::nullopt;
    }
    std::lock_guard<std::mutex> response_lock (it->second->response_mutex);
    return it->second->info_locked ();
}

std::vector<InboxInfo> InboxManager::list () {
    std::lock_guard<std::mutex> lock (mutex_);
    std::vector<InboxInfo> out;
    out.reserve (inboxes_.size ());
    for (const auto& [id, inbox] : inboxes_) {
        std::lock_guard<std::mutex> response_lock (inbox->response_mutex);
        out.push_back (inbox->info_locked ());
    }
    return out;
}

std::optional<InboxLimits> InboxManager::limits (const std::string& inbox_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return std::nullopt;
    }
    // Const since start(); no per-inbox lock needed to read it.
    return it->second->limits;
}

std::optional<InboxInfo> InboxManager::update_response (const std::string& inbox_id,
const InboxCannedResponse& response) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return std::nullopt;
    }
    std::lock_guard<std::mutex> response_lock (it->second->response_mutex);
    it->second->response = response;
    return it->second->info_locked ();
}

namespace {

/// How long a claim may go without a successful write before it is takeable.
/// Two poll intervals, floored so that the shortest permitted cadence does not
/// make ordinary scheduler jitter look like a dead stream.
std::chrono::milliseconds live_claim_stale_after (const InboxLimits& limits) {
    const int window = std::max (constants::inbox::MIN_LIVE_CLAIM_STALE_MS,
    limits.live_poll_interval_ms * constants::inbox::LIVE_CLAIM_STALE_INTERVALS);
    return std::chrono::milliseconds (window);
}

} // namespace

std::optional<LiveClaim> InboxManager::try_claim_live (const std::string& inbox_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return std::nullopt;
    }
    Inbox& inbox = *it->second;
    return inbox.live_claim.try_claim (live_claim_stale_after (inbox.limits));
}

bool InboxManager::note_live_write (const std::string& inbox_id, LiveClaim claim) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = inboxes_.find (inbox_id);
    if (it == inboxes_.end ()) {
        return false;
    }
    return it->second->live_claim.note_write (claim);
}

void InboxManager::release_live (const std::string& inbox_id, LiveClaim claim) {
    std::lock_guard<std::mutex> lock (mutex_);
    if (auto it = inboxes_.find (inbox_id); it != inboxes_.end ()) {
        it->second->live_claim.release (claim);
    }
}

} // namespace vayu::http

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

namespace vayu::http::routes {

namespace {

/// Parse the request body, or answer 400 - the shape every write route takes.
bool read_json_body (const httplib::Request& req, httplib::Response& res, nlohmann::json& out) {
    if (req.body.empty ()) {
        out = nlohmann::json (nullptr);
        return true;
    }
    try {
        out = nlohmann::json::parse (req.body);
    } catch (const std::exception& e) {
        send_error (res, 400, std::string ("Invalid JSON body: ") + e.what ());
        return false;
    }
    return true;
}

void send_parse_error (httplib::Response& res, const InboxParseError& error) {
    send_error (res, error.http_status, error.message, error.code);
}

} // namespace

/**
 * The wire shape of an inbox with its capture count filled in.
 *
 * `captureCount` is the one field the manager cannot answer - captures are
 * database rows - so every route that hands an inbox back fills it through
 * here. One place rather than four, because the failure mode of the fourth
 * copy is not a compile error: it is a `0` that reads as "nothing to lose"
 * beside a delete confirmation. Extracted (like `inbox_captures_response`) so
 * that wiring is covered without an in-process HTTP server.
 */
nlohmann::json inbox_json (vayu::db::Database& db, InboxInfo info) {
    info.capture_count = db.count_inbox_requests (info.inbox_id);
    return inbox_info_json (info);
}

/**
 * Testable core of `GET /inbox/:id/requests`: the capture page in the
 * `{data, pagination}` envelope every list endpoint returns, or a 404 for an
 * inbox the manager does not know. Extracted so the wiring is covered without
 * an in-process HTTP server (inbox_test.cpp).
 */
std::pair<int, nlohmann::json> inbox_captures_response (vayu::db::Database& db,
InboxManager& manager,
const std::string& inbox_id,
int64_t limit,
int64_t offset) {
    if (!manager.get (inbox_id)) {
        return { 404, error_body (404, "Inbox not found") };
    }

    const int64_t total = db.count_inbox_requests (inbox_id);
    auto captures = db.get_inbox_requests_paginated (inbox_id, limit, offset);

    nlohmann::json data = nlohmann::json::array ();
    for (const auto& capture : captures) {
        data.push_back (inbox_capture_json (capture));
    }

    nlohmann::json out;
    out["data"]                 = std::move (data);
    out["pagination"]["total"]  = total;
    out["pagination"]["limit"]  = limit;
    out["pagination"]["offset"] = offset;
    out["pagination"]["hasMore"] =
    (offset + static_cast<int64_t> (captures.size ())) < total;
    out["pagination"]["returned"] = captures.size ();
    return { 200, out };
}

namespace {

/// limit: default DEFAULT_PAGE_LIMIT, invalid/<=0 -> default, capped at
/// @p retained - the inbox's configured retention, past which nothing exists to
/// return. offset: <0 -> 0.
std::pair<int64_t, int64_t>
parse_capture_pagination (const httplib::Request& req, int64_t retained) {
    int64_t limit  = constants::inbox::DEFAULT_PAGE_LIMIT;
    int64_t offset = 0;
    if (req.has_param ("limit")) {
        try {
            limit = std::stoll (req.get_param_value ("limit"));
            if (limit <= 0)
                limit = constants::inbox::DEFAULT_PAGE_LIMIT;
            if (limit > retained)
                limit = retained;
        } catch (...) {
            limit = constants::inbox::DEFAULT_PAGE_LIMIT;
        }
    }
    if (req.has_param ("offset")) {
        try {
            offset = std::stoll (req.get_param_value ("offset"));
            if (offset < 0)
                offset = 0;
        } catch (...) {
            offset = 0;
        }
    }
    return { limit, offset };
}

} // namespace

void register_inbox_routes (RouteContext& ctx) {
    /**
     * POST /inbox/start
     * Body (every field optional): {port, bind, confirmNonLoopback,
     * response: {status, body, headers, delayMs}}.
     * Returns the started inbox: {inboxId, url, bind, port, running, loopback,
     * response}.
     */
    ctx.server.Post ("/inbox/start",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        if (!read_json_body (req, res, body)) {
            return;
        }
        const auto start = parse_inbox_start (body);
        if (!start) {
            vayu::utils::log_warning ("POST /inbox/start - " + start.error ().message);
            send_parse_error (res, start.error ());
            return;
        }
        try {
            auto result = ctx.inbox_manager.start (ctx.db, *start);
            if (!result.ok) {
                vayu::utils::log_warning ("POST /inbox/start - " + result.error_message);
                send_error (res, result.http_status, result.error_message,
                result.error_code);
                return;
            }
            send_json (res, inbox_json (ctx.db, result.info));
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /inbox/start - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /inbox/:id/stop
     * Frees the listener. The record and its captures stay readable until the
     * engine exits - a stop is not a delete, and `DELETE /inbox/:id` is.
     */
    ctx.server.Post (R"(/inbox/([^/]+)/stop)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        if (!ctx.inbox_manager.stop (inbox_id)) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        auto info = ctx.inbox_manager.get (inbox_id);
        if (!info) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        send_json (res, inbox_json (ctx.db, *info));
    });

    /**
     * DELETE /inbox/:id
     * Stop the listener, drop the record, and delete its captures with it -
     * the only way a stopped inbox leaves the list before the process does.
     * A running inbox is stopped rather than refused: the caller asked for it
     * to be gone, and the teardown joins before the captures are cleared.
     *
     * `[^/]+` cannot span a `/`, so this pattern never swallows
     * `/inbox/:id/requests` - the two DELETE routes are disjoint whatever
     * order they are registered in.
     */
    ctx.server.Delete (R"(/inbox/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        try {
            const auto deleted = ctx.inbox_manager.remove (ctx.db, inbox_id);
            if (!deleted) {
                send_error (res, 404, "Inbox not found");
                return;
            }
            send_json (res,
            nlohmann::json{ { "inboxId", inbox_id }, { "capturesDeleted", *deleted } });
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /inbox/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /** GET /inbox - every inbox this process has started, running or stopped. */
    ctx.server.Get ("/inbox", [&ctx] (const httplib::Request&, httplib::Response& res) {
        nlohmann::json data = nlohmann::json::array ();
        for (const auto& info : ctx.inbox_manager.list ()) {
            data.push_back (inbox_json (ctx.db, info));
        }
        send_json (res, nlohmann::json{ { "data", std::move (data) } });
    });

    /**
     * PUT /inbox/:id
     * Merge-patch of the canned response, live: the next caller gets the new
     * one, with no restart and no captures lost.
     */
    ctx.server.Put (R"(/inbox/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        auto current               = ctx.inbox_manager.get (inbox_id);
        if (!current) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        nlohmann::json body;
        if (!read_json_body (req, res, body)) {
            return;
        }
        if (body.is_null ()) {
            body = nlohmann::json::object ();
        }
        const auto updated = parse_inbox_response_update (body, current->response);
        if (!updated) {
            vayu::utils::log_warning ("PUT /inbox/:id - " + updated.error ().message);
            send_parse_error (res, updated.error ());
            return;
        }
        auto info = ctx.inbox_manager.update_response (inbox_id, *updated);
        if (!info) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        send_json (res, inbox_json (ctx.db, *info));
    });

    /**
     * GET /inbox/:id/requests?limit=&offset=
     * The captures, newest first, in the `{data, pagination}` envelope.
     */
    ctx.server.Get (R"(/inbox/([^/]+)/requests)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        // The cap follows the inbox's own retention rather than the constant:
        // with `inboxMaxCaptures` raised, a page of 50 would otherwise be the
        // most the engine would ever hand back.
        const auto limits    = ctx.inbox_manager.limits (inbox_id);
        auto [limit, offset] = parse_capture_pagination (
        req, limits ? limits->max_captures : constants::inbox::MAX_CAPTURES);
        try {
            auto [status, body] = inbox_captures_response (
            ctx.db, ctx.inbox_manager, inbox_id, limit, offset);
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /inbox/:id/requests - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /** DELETE /inbox/:id/requests - clear the captures, keep the listener. */
    ctx.server.Delete (R"(/inbox/([^/]+)/requests)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        if (!ctx.inbox_manager.get (inbox_id)) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        try {
            const int64_t cleared = ctx.db.clear_inbox_requests (inbox_id);
            send_json (res,
            nlohmann::json{ { "inboxId", inbox_id }, { "cleared", cleared } });
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /inbox/:id/requests - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /inbox/:id/live
     * One SSE event per capture, `id:` carrying the capture id so a reconnect
     * resumes from where it left off. One stream per inbox: each holds a
     * cpp-httplib pool thread for its whole life, so a second live watcher is a
     * 409 rather than a quietly parked thread - but a claim whose holder has
     * stopped writing is taken over instead of refused (issue #506).
     */
    ctx.server.Get (R"(/inbox/([^/]+)/live)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string inbox_id = req.matches[1];
        if (!ctx.inbox_manager.get (inbox_id)) {
            send_error (res, 404, "Inbox not found");
            return;
        }
        const auto limits = ctx.inbox_manager.limits (inbox_id).value_or (InboxLimits{});

        const auto resume_point = parse_live_resume_point (
        req.get_header_value ("Last-Event-ID"), req.get_param_value ("lastEventId"));
        if (!resume_point) {
            const auto& refusal = resume_point.error ();
            send_error (res, refusal.http_status, refusal.message, refusal.code);
            return;
        }
        int64_t last_id = *resume_point;

        const auto claim = ctx.inbox_manager.try_claim_live (inbox_id);
        if (!claim) {
            send_error (res, 409,
            "This inbox is already being watched; close the other stream first",
            "inbox_live_in_use");
            return;
        }

        res.set_content_provider ("text/event-stream",
        [&ctx, inbox_id, last_id, limits, claim = *claim] (size_t, httplib::DataSink& sink) mutable {
            while (true) {
                if (!sink.is_writable ()) {
                    break;
                }
                std::vector<vayu::db::InboxRequest> fresh;
                try {
                    fresh = ctx.db.get_inbox_requests_since (inbox_id, last_id);
                } catch (const std::exception& e) {
                    vayu::utils::log_warning (
                    "GET /inbox/:id/live - " + std::string (e.what ()));
                    break;
                }
                for (const auto& capture : fresh) {
                    const std::string payload = "id: " + std::to_string (capture.id) +
                    "\ndata: " + inbox_capture_json (capture).dump () + "\n\n";
                    if (!sink.write (payload.data (), payload.size ())) {
                        ctx.inbox_manager.release_live (inbox_id, claim);
                        return false;
                    }
                    last_id = capture.id;
                }
                // A write that lands is the only evidence this socket is alive,
                // and therefore what holds the claim. Losing it means a
                // reconnect already took the slot over, so this stream ends
                // without releasing what is no longer its own.
                if (!fresh.empty () && !ctx.inbox_manager.note_live_write (inbox_id, claim)) {
                    return false;
                }
                if (fresh.empty ()) {
                    // A stopped inbox captures nothing more, but the record and
                    // its history stay - so the stream ends rather than polling
                    // a listener that is gone.
                    auto info = ctx.inbox_manager.get (inbox_id);
                    if (!info || !info->running) {
                        break;
                    }
                    const std::string keep_alive = ": keep-alive\n\n";
                    if (!sink.write (keep_alive.data (), keep_alive.size ())) {
                        ctx.inbox_manager.release_live (inbox_id, claim);
                        return false;
                    }
                    if (!ctx.inbox_manager.note_live_write (inbox_id, claim)) {
                        return false;
                    }
                    std::this_thread::sleep_for (
                    std::chrono::milliseconds (limits.live_poll_interval_ms));
                }
            }
            ctx.inbox_manager.release_live (inbox_id, claim);
            return false;
        });
    });
}

} // namespace vayu::http::routes
