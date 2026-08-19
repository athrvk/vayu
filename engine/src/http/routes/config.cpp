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

#include <algorithm>
#include <chrono>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
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
    // What the value measures ("ms", "sec", "days", "bytes"), omitted rather
    // than sent as null when the entry measures nothing - the same shape as
    // `min`/`max`/`options` above, so a client has one rule for optional
    // scalars on this payload rather than one per field. Absent means "this
    // number is a count", which is the only other thing it can be.
    if (entry.unit) {
        entry_json["unit"] = *entry.unit;
    }
    if (entry.options) {
        // Stored as a JSON-array string (JSON-in-TEXT, same convention as
        // every other structured column); parse it back to a real array so
        // the wire shape is `"options": [...]`, not a string of one.
        //
        // Guarded for the same reason the enum branch of apply_config_update
        // is: an unguarded parse here would turn one malformed row into a 500
        // on the whole of GET /config, taking the entire settings screen down
        // rather than one entry. Omitting the key leaves an enum entry with no
        // option list, which a renderer can show as unavailable.
        //
        // Only seed_default_config writes this column today, so a malformed
        // value means the stored row was tampered with or truncated. Log it -
        // silently dropping the key would make the setting vanish from the UI
        // with no trail to follow.
        try {
            entry_json["options"] = nlohmann::json::parse (*entry.options);
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("config entry '" + entry.key +
            "' has malformed options JSON, omitting it: " + e.what ());
        }
    }
    // Always present, both of them: a consumer that has to distinguish "false"
    // from "this engine does not send it" is back to guessing, which is the
    // habit the typed flag replaced.
    entry_json["requiresRestart"] = entry.requires_restart;
    entry_json["advanced"]        = entry.advanced;
    // Search terms, and always an array - empty for the entries that declare
    // none. Unlike `options`, which is omitted when it cannot be parsed, this
    // key is never dropped: a client that had to tell "no keywords" from "this
    // engine does not send them" would be back to guessing, and an empty list
    // is the honest answer to both a malformed row and an entry with none.
    nlohmann::json keywords = nlohmann::json::array ();
    try {
        auto parsed = nlohmann::json::parse (entry.keywords);
        if (parsed.is_array ()) {
            keywords = std::move (parsed);
        } else {
            vayu::utils::log_warning ("config entry '" + entry.key +
            "' has non-array keywords JSON, sending an empty list");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("config entry '" + entry.key +
        "' has malformed keywords JSON, sending an empty list: " + e.what ());
    }
    entry_json["keywords"]  = std::move (keywords);
    entry_json["updatedAt"] = entry.updated_at;
    return entry_json;
}

// A /config validation failure, which names its own code rather than taking the
// per-status default. Thin wrapper over the shared builder so the shape stays in
// one place (routes.hpp).
nlohmann::json config_error (const std::string& message) {
    return error_body (400, message, "invalid_config");
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
        } else if (existing->type == "enum") {
            std::vector<std::string> allowed;
            std::string allowed_list;
            if (existing->options) {
                try {
                    for (const auto& option : nlohmann::json::parse (*existing->options)) {
                        std::string opt_value = option.at ("value").get<std::string> ();
                        allowed.push_back (opt_value);
                        allowed_list += (allowed_list.empty () ? "" : ", ") + opt_value;
                    }
                } catch (const std::exception&) {
                    // Malformed options - fall through with an empty allowed
                    // list so the value is rejected rather than accepted.
                }
            }
            if (std::find (allowed.begin (), allowed.end (), value) == allowed.end ()) {
                reason = "'" + key + "' must be one of [" + allowed_list +
                "] (got '" + value + "')";
            }
        }

        // Per-key rule, the way the proxy URL's lives in `proxy_url_rejection`:
        // the type system says "text" and only this key knows that the text has
        // to be PEM. Rejected at the boundary rather than at handshake time,
        // because a pasted key or a truncated block would otherwise be stored,
        // materialized, and reported as an unrelated verification failure on
        // every request afterwards (issue #706).
        if (reason.empty () && key == "customCaCertificates" && !value.empty ()) {
            if (const auto rejection = vayu::http::ca_pem_rejection (value)) {
                reason = "'customCaCertificates' is not a usable PEM bundle: " + *rejection;
            }
        }

        // The app writes this one from the operating system's answer (issue
        // #708), and the same rule applies to it as to a hand-typed `proxyUrl`:
        // a shape libcurl has no proxy support for would be stored, read under
        // `system` mode, and fall back to the environment with only a log line
        // to say so. Empty is not a rejection - it is how the app records "this
        // machine has no proxy", and clearing it is how `system` goes direct.
        if (reason.empty () && key == "proxySystemUrl" && !value.empty ()) {
            if (const auto rejection = vayu::http::proxy_url_rejection (value)) {
                reason = "'proxySystemUrl' is not usable: " + *rejection;
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

    // Cross-field rule: `manual` mode with no usable URL would accept the
    // write, say "Manual" in Settings and send every request direct - the
    // invisible failure issue #705 exists to end. Judged against the state the
    // batch would *leave*, not against either half alone, because the two keys
    // may arrive in one request or in either order across two.
    if (errors.empty () &&
    (updates.count ("proxyMode") != 0 || updates.count ("proxyUrl") != 0)) {
        const auto effective = [&] (const char* key) {
            const auto it = updates.find (key);
            if (it != updates.end ()) {
                return it->second;
            }
            const auto stored = db.get_config_entry (key);
            return stored ? stored->value : std::string ();
        };
        const std::string mode = effective ("proxyMode");
        const std::string url  = effective ("proxyUrl");
        if (vayu::http::proxy_mode_from_string (mode) == vayu::http::ProxyMode::Manual) {
            if (const auto rejection = vayu::http::proxy_url_rejection (url)) {
                errors.push_back ("'proxyUrl' is required when 'proxyMode' is "
                                  "'manual': " +
                *rejection);
            }
        } else if (!url.empty ()) {
            // A URL stored under another mode is inert rather than wrong - it
            // is how someone keeps their proxy while temporarily switching it
            // off - so it is validated but not required.
            if (const auto rejection = vayu::http::proxy_url_rejection (url)) {
                errors.push_back ("'proxyUrl' is not usable: " + *rejection);
            }
        }
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
