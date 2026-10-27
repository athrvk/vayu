/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/globals.cpp
 * @brief Global variables routes: `GET /globals` and `POST /globals`, both
 *        answering the row's `ETag`, the write judging an optional `If-Match`
 *        (#2988).
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/// The singleton's one id: a row saved under any other is never read back.
constexpr const char* GLOBALS_ID = "globals";

/**
 * The body both routes answer. A never-written row is `updatedAt: 0`, a real
 * version: its `W/"0"` is what a first conditional write names.
 */
nlohmann::json globals_body (const std::optional<vayu::db::Globals>& row) {
    nlohmann::json body;
    body["id"]        = row ? row->id : std::string (GLOBALS_ID);
    body["updatedAt"] = row ? row->updated_at : int64_t{ 0 };
    body["variables"] = nlohmann::json::object ();
    if (row) {
        auto parsed = nlohmann::json::parse (row->variables, nullptr, false);
        if (!parsed.is_discarded ()) {
            body["variables"] = std::move (parsed);
        }
    }
    return body;
}

/** The read-judge-write of POST /globals, run under the caller's lock. */
std::pair<int, nlohmann::json> save_globals_locked (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    const auto existing             = db.get_globals ();
    const int64_t stored_updated_at = existing ? existing->updated_at : 0;
    if (auto held = check_if_match (if_match, stored_updated_at); !held) {
        return as_response (held.error ());
    }

    vayu::db::Globals g;
    g.id = GLOBALS_ID;
    if (auto outcome =
        apply_json_field (json, "variables", g.variables, "{}", /*is_create=*/true);
    !outcome) {
        return as_response (outcome.error ());
    }
    g.updated_at = next_updated_at (stored_updated_at);

    int var_count = 0;
    if (json.contains ("variables") && json["variables"].is_object ()) {
        var_count = static_cast<int> (json["variables"].size ());
    }
    vayu::utils::log_info ("http", "Saving global variables", { { "count", var_count } });

    if (before_write) {
        before_write ();
    }
    db.save_globals (g);
    return { 200, globals_body (g) };
}

} // namespace

/**
 * Testable core of POST /globals, returning {http_status, json_body}.
 *
 * Globals is a singleton with no create/update split - there is one row, always
 * addressed by the same id, so `POST /globals` saves it whole. That makes every
 * write a "create" as far as the one null-vs-absent rule is concerned (issue
 * #95, helpers in routes.hpp): absent and `null` both mean the default, `{}`.
 * A `null` once stored the text `null`, which `GET /globals` read back as no
 * globals at all; the shared helper is what keeps this resource from drifting
 * from the other three again.
 *
 * **The read, the precondition and the write are one lock scope**: a client
 * that merges across two round trips (MCP's `update_globals`) closes its own
 * window with @p if_match, judged against the row this write replaces (#2988).
 * The never-written row is version 0.
 *
 * @param if_match The request's `If-Match`; a row it no longer names is a 412.
 * @param before_write Test seam, invoked inside the lock scope with the new
 *        row staged and immediately before it is written.
 */
std::pair<int, nlohmann::json> save_globals_response (vayu::db::Database& db,
const nlohmann::json& json,
const std::optional<vayu::http::IfMatch>& if_match,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock (
    [&] { result = save_globals_locked (db, json, if_match, before_write); });
    return result;
}

std::pair<int, nlohmann::json>
save_globals_response (vayu::db::Database& db, const nlohmann::json& json) {
    return save_globals_response (db, json, std::nullopt, nullptr);
}

void register_globals_routes (RouteContext& ctx) {
    /**
     * GET /globals
     * Retrieves the global variables; an engine that never saved any answers
     * the empty set at `updatedAt: 0`.
     * Returns: Object with id, variables, and updatedAt, with its ETag.
     */
    ctx.server.Get ("/globals", [&ctx] (const httplib::Request&, httplib::Response& res) {
        const nlohmann::json body = globals_body (ctx.db.get_globals ());
        set_entity_tag (res, 200, body);
        res.set_content (body.dump (), "application/json");
    });

    /**
     * POST /globals
     * Saves the global variables whole (a replace, not a merge).
     * Body params: variables (object)
     * Headers: If-Match (optional) - the row's `W/"<updatedAt>"` (#2988).
     * Returns: The saved globals object with its ETag, 412 if If-Match no
     * longer names the stored row, or 400.
     */
    ctx.server.Post ("/globals", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "POST /globals", json.error ());
            return;
        }
        const auto if_match = read_if_match (req);
        if (!if_match) {
            refuse_request_body (res, "POST /globals", if_match.error ());
            return;
        }
        try {
            auto [status, body] = save_globals_response (ctx.db, *json, *if_match, nullptr);
            res.status = status;
            set_entity_tag (res, status, body);
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /globals - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });
}

} // namespace vayu::http::routes
