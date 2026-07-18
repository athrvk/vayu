/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/config.cpp
 * @brief Configuration management routes
 */

#include <chrono>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

namespace {

// Serialize a config entry to the wire JSON shape shared by the GET and POST
// responses (keeps the two paths from drifting).
nlohmann::json config_entry_json (const vayu::db::ConfigEntry& entry) {
    nlohmann::json entry_json;
    entry_json["key"]         = entry.key;
    entry_json["value"]       = entry.value;
    entry_json["type"]        = entry.type;
    entry_json["label"]       = entry.label;
    entry_json["description"] = entry.description;
    entry_json["category"]    = entry.category;
    entry_json["default"]     = entry.default_value;
    if (entry.min_value) {
        entry_json["min"] = *entry.min_value;
    }
    if (entry.max_value) {
        entry_json["max"] = *entry.max_value;
    }
    entry_json["updatedAt"] = entry.updated_at;
    return entry_json;
}

// Build the nested error body the app's http-client reads
// (`errorData.error.message`); the flat `{"error": "..."}` shape is dropped by
// the client and surfaces only as a bare "HTTP 400".
nlohmann::json config_error (const std::string& message) {
    return nlohmann::json{ { "error",
    { { "code", "invalid_config" }, { "message", message } } } };
}

} // namespace

/**
 * @brief Parse, validate, and apply a POST /config request body.
 *
 * Split out of the route handler so the validation path (and the specific
 * failure reason it now returns) is unit-testable without a live server.
 *
 * @return {http_status, json_body}. On validation failure the body carries the
 *         specific reason(s) - which key, and why (bad type / out of range) -
 *         so the app can show it instead of a generic "check the logs".
 */
std::pair<int, nlohmann::json> apply_config_update (vayu::db::Database& db,
const std::string& body) {
    nlohmann::json json;
    try {
        json = nlohmann::json::parse (body);
    } catch (const nlohmann::json::parse_error& e) {
        vayu::utils::log_error (
        "POST /config - JSON parse error: " + std::string (e.what ()));
        return { 400, config_error ("Invalid JSON: " + std::string (e.what ())) };
    }

    std::unordered_map<std::string, std::string> updates;

    // Bulk update format: { "entries": { "key": "value", ... } }
    if (json.contains ("entries") && json["entries"].is_object ()) {
        for (const auto& [key, value] : json["entries"].items ()) {
            if (value.is_string ()) {
                updates[key] = value.get<std::string> ();
            } else if (value.is_number ()) {
                updates[key] = std::to_string (value.get<double> ());
            } else if (value.is_boolean ()) {
                updates[key] = value.get<bool> () ? "true" : "false";
            } else {
                updates[key] = value.dump ();
            }
        }
    }
    // Single update format: { "key": "key1", "value": "value1" }
    else if (json.contains ("key") && json.contains ("value")) {
        std::string key = json["key"].get<std::string> ();
        std::string value;
        const auto& v = json["value"];
        if (v.is_string ()) {
            value = v.get<std::string> ();
        } else if (v.is_number ()) {
            value = std::to_string (v.get<double> ());
        } else if (v.is_boolean ()) {
            value = v.get<bool> () ? "true" : "false";
        } else {
            value = v.dump ();
        }
        updates[key] = value;
    } else {
        return { 400,
        config_error ("Invalid request format. Expected { \"entries\": {...} } "
                      "or { \"key\": \"...\", \"value\": \"...\" }") };
    }

    if (updates.empty ()) {
        return { 400, config_error ("No updates provided") };
    }

    // Validate every key first; apply nothing unless all pass (all-or-nothing).
    std::vector<vayu::db::ConfigEntry> to_update;
    std::vector<std::string> errors;

    for (const auto& [key, value] : updates) {
        auto existing = db.get_config_entry (key);
        if (!existing) {
            errors.push_back ("Unknown config key '" + key + "'");
            continue;
        }

        std::string reason;
        if (existing->type == "integer") {
            try {
                int int_val = std::stoi (value);
                if (existing->min_value && int_val < std::stoi (*existing->min_value)) {
                    reason = "'" + key + "' must be at least " + *existing->min_value +
                    " (got " + value + ")";
                } else if (existing->max_value &&
                int_val > std::stoi (*existing->max_value)) {
                    reason = "'" + key + "' must be at most " + *existing->max_value +
                    " (got " + value + ")";
                }
            } catch (...) {
                reason = "'" + key + "' must be an integer (got '" + value + "')";
            }
        } else if (existing->type == "number") {
            try {
                double double_val = std::stod (value);
                if (existing->min_value && double_val < std::stod (*existing->min_value)) {
                    reason = "'" + key + "' must be at least " + *existing->min_value +
                    " (got " + value + ")";
                } else if (existing->max_value &&
                double_val > std::stod (*existing->max_value)) {
                    reason = "'" + key + "' must be at most " + *existing->max_value +
                    " (got " + value + ")";
                }
            } catch (...) {
                reason = "'" + key + "' must be a number (got '" + value + "')";
            }
        } else if (existing->type == "boolean") {
            if (value != "true" && value != "false") {
                reason = "'" + key + "' must be 'true' or 'false' (got '" + value + "')";
            }
        }

        if (!reason.empty ()) {
            errors.push_back (reason);
            continue;
        }

        vayu::db::ConfigEntry updated = *existing;
        updated.value                 = value;
        updated.updated_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                             .count ();
        to_update.push_back (updated);
    }

    if (!errors.empty ()) {
        std::string joined;
        for (size_t i = 0; i < errors.size (); ++i) {
            if (i > 0) {
                joined += "; ";
            }
            joined += errors[i];
        }
        vayu::utils::log_error ("POST /config - Validation failed: " + joined);
        return { 400, config_error (joined) };
    }

    for (const auto& entry : to_update) {
        db.save_config_entry (entry);
    }

    vayu::utils::log_info ("POST /config - Updated " +
    std::to_string (to_update.size ()) + " config entries");

    nlohmann::json entries_array = nlohmann::json::array ();
    for (const auto& entry : db.get_all_config_entries ()) {
        entries_array.push_back (config_entry_json (entry));
    }

    nlohmann::json response;
    response["entries"] = entries_array;
    response["success"] = true;
    return { 200, response };
}

void register_config_routes (RouteContext& ctx) {
    /**
     * GET /config
     * Retrieves all configuration entries with metadata for UI display.
     */
    ctx.server.Get ("/config", [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info ("GET /config - Fetching configuration entries");
        try {
            nlohmann::json entries_array = nlohmann::json::array ();
            for (const auto& entry : ctx.db.get_all_config_entries ()) {
                entries_array.push_back (config_entry_json (entry));
            }

            nlohmann::json response;
            response["entries"] = entries_array;
            res.set_content (response.dump (2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /config - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /config
     * Updates configuration entries.
     * Body: { "entries": { "key1": "value1", "key2": "value2", ... } }
     * Or: { "key": "key1", "value": "value1" } for single update
     */
    ctx.server.Post ("/config", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info ("POST /config - Updating configuration");
        try {
            auto [status, response_body] = apply_config_update (ctx.db, req.body);
            res.status = status;
            res.set_content (response_body.dump (2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /config - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
