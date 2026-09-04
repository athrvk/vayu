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
#include <format>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "vayu/http/default_headers.hpp"
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

// One config value as the string the store holds. Shared by the two body
// shapes below so a number or a boolean cannot mean different text depending
// on which of them carried it.
std::string config_value_string (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_number ()) {
        return std::to_string (value.get<double> ());
    }
    if (value.is_boolean ()) {
        return value.get<bool> () ? "true" : "false";
    }
    return value.dump ();
}

/**
 * The key/value pairs a POST /config body asks to write, in either shape the
 * route accepts.
 *
 * @return why the body is neither of them, or nothing.
 */
std::optional<std::string> read_config_updates (const nlohmann::json& json,
std::unordered_map<std::string, std::string>& out) {
    // Bulk update format: { "entries": { "key": "value", ... } }
    if (json.contains ("entries") && json["entries"].is_object ()) {
        for (const auto& [key, value] : json["entries"].items ()) {
            out[key] = config_value_string (value);
        }
    }
    // Single update format: { "key": "key1", "value": "value1" }
    else if (json.contains ("key") && json.contains ("value")) {
        out[json["key"].get<std::string> ()] =
        config_value_string (json["value"]);
    } else {
        return "Invalid request format. Expected { \"entries\": {...} } "
               "or { \"key\": \"...\", \"value\": \"...\" }";
    }
    if (out.empty ()) {
        return "No updates provided";
    }
    return std::nullopt;
}

/**
 * Why @p value is not a number this entry accepts, or an empty string.
 *
 * The bounds are parsed inside the same `try` as the value on purpose: a stored
 * `min` that does not parse is a broken row, and rejecting the write is the
 * safe direction for a validator that cannot tell whether the bound was met.
 */
template <typename Value, typename Parse>
std::string numeric_rejection (const vayu::db::ConfigEntry& entry,
const std::string& key,
const std::string& value,
const char* expected,
Parse parse) {
    try {
        const Value parsed = parse (value);
        if (entry.min_value && parsed < parse (*entry.min_value)) {
            return std::format (
            "'{}' must be at least {} (got {})", key, *entry.min_value, value);
        }
        if (entry.max_value && parsed > parse (*entry.max_value)) {
            return std::format (
            "'{}' must be at most {} (got {})", key, *entry.max_value, value);
        }
    } catch (...) {
        return std::format ("'{}' must be {} (got '{}')", key, expected, value);
    }
    return {};
}

/** Why @p value is not one of this enum entry's options, or an empty string. */
std::string enum_rejection (const vayu::db::ConfigEntry& entry,
const std::string& key,
const std::string& value) {
    std::vector<std::string> allowed;
    std::string allowed_list;
    if (entry.options) {
        try {
            for (const auto& option : nlohmann::json::parse (*entry.options)) {
                std::string opt_value = option.at ("value").get<std::string> ();
                allowed.push_back (opt_value);
                allowed_list += (allowed_list.empty () ? "" : ", ") + opt_value;
            }
        } catch (const std::exception&) {
            // @deliberate: malformed options fall through with an empty
            // allowed list, so the value is rejected rather than
            // accepted - the safe direction for a validator.
        }
    }
    if (std::find (allowed.begin (), allowed.end (), value) == allowed.end ()) {
        return std::format ("'{}' must be one of [{}] (got '{}')", key, allowed_list, value);
    }
    return {};
}

/** Why @p value does not satisfy the entry's declared type, or an empty string. */
std::string type_rejection (const vayu::db::ConfigEntry& entry,
const std::string& key,
const std::string& value) {
    if (entry.type == "integer") {
        return numeric_rejection<int> (entry, key, value, "an integer",
        [] (const std::string& text) { return std::stoi (text); });
    }
    if (entry.type == "number") {
        return numeric_rejection<double> (entry, key, value, "a number",
        [] (const std::string& text) { return std::stod (text); });
    }
    if (entry.type == "boolean") {
        if (value != "true" && value != "false") {
            return std::format ("'{}' must be 'true' or 'false' (got '{}')", key, value);
        }
        return {};
    }
    if (entry.type == "enum") {
        return enum_rejection (entry, key, value);
    }
    return {};
}

/**
 * The rules a single key carries beyond its declared type, the way the proxy
 * URL's lives in `proxy_url_rejection`: the type system says "text" and only
 * the key knows what the text has to be.
 *
 * `customCaCertificates` is rejected at the boundary rather than at handshake
 * time, because a pasted key or a truncated block would otherwise be stored,
 * materialized, and reported as an unrelated verification failure on every
 * request afterwards (issue #706).
 *
 * `proxySystemUrl` the app writes from the operating system's answer (issue
 * #708), and the same rule applies to it as to a hand-typed `proxyUrl`: a shape
 * libcurl has no proxy support for would be stored, read under `system` mode,
 * and fall back to the environment with only a log line to say so. Empty is not
 * a rejection - it is how the app records "this machine has no proxy", and
 * clearing it is how `system` goes direct.
 */
std::string key_rejection (const std::string& key, const std::string& value) {
    // `correlationIdHeader` is a header *name*, and a name that is not one
    // would put a broken line on every request afterwards - the same shape of
    // invisible failure the proxy URL is refused for (issue #1229).
    if (key == std::string (vayu::http::CORRELATION_ID_HEADER_KEY)) {
        if (const auto rejection = vayu::http::unusable_header_name (value)) {
            return "'correlationIdHeader' is not usable: " + *rejection;
        }
    }
    if (key == "customCaCertificates" && !value.empty ()) {
        if (const auto rejection = vayu::http::ca_pem_rejection (value)) {
            return "'customCaCertificates' is not a usable PEM bundle: " + *rejection;
        }
    }
    if (key == "proxySystemUrl" && !value.empty ()) {
        if (const auto rejection = vayu::http::proxy_url_rejection (value)) {
            return "'proxySystemUrl' is not usable: " + *rejection;
        }
    }
    return {};
}

/**
 * The cross-field proxy rule: `manual` mode with no usable URL would accept the
 * write, say "Manual" in Settings and send every request direct - the invisible
 * failure issue #705 exists to end. Judged against the state the batch would
 * *leave*, not against either half alone, because the two keys may arrive in one
 * request or in either order across two.
 */
std::optional<std::string> proxy_batch_rejection (vayu::db::Database& db,
const std::unordered_map<std::string, std::string>& updates) {
    if (updates.count ("proxyMode") == 0 && updates.count ("proxyUrl") == 0) {
        return std::nullopt;
    }
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
            return "'proxyUrl' is required when 'proxyMode' is 'manual': " + *rejection;
        }
        return std::nullopt;
    }
    // A URL stored under another mode is inert rather than wrong - it is how
    // someone keeps their proxy while temporarily switching it off - so it is
    // validated but not required.
    if (!url.empty ()) {
        if (const auto rejection = vayu::http::proxy_url_rejection (url)) {
            return "'proxyUrl' is not usable: " + *rejection;
        }
    }
    return std::nullopt;
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
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body) {
    nlohmann::json json;
    try {
        json = nlohmann::json::parse (body);
    } catch (const nlohmann::json::parse_error& e) {
        vayu::utils::log_error (
        "POST /config - JSON parse error: " + std::string (e.what ()));
        return { 400, config_error ("Invalid JSON: " + std::string (e.what ())) };
    }

    std::unordered_map<std::string, std::string> updates;
    if (const auto rejection = read_config_updates (json, updates)) {
        return { 400, config_error (*rejection) };
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

        std::string reason = type_rejection (*existing, key, value);
        if (reason.empty ()) {
            reason = key_rejection (key, value);
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

    if (errors.empty ()) {
        if (const auto rejection = proxy_batch_rejection (db, updates)) {
            errors.push_back (*rejection);
        }
    }

    if (!errors.empty ()) {
        std::string joined;
        for (const auto& error : errors) {
            joined += (joined.empty () ? "" : "; ") + error;
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

/**
 * @brief What the engine will add to a request that names none of it.
 *
 * The body of `GET /request-defaults`, split out for the reason
 * `apply_config_update` is: it is the whole of the route, and a test that has a
 * `Database` should not need a live server to read it.
 *
 * A client renders these as the auto rows beside a request's own headers, and
 * sends the names it wants back off as `disabledDefaultHeaders`. It is
 * deliberately the engine that declares them: a renderer re-deriving the set
 * from the config entries would be a second definition of the same rule, which
 * is how the two came to disagree before issue #1229.
 */
nlohmann::json request_defaults_json (vayu::db::Database& db) {
    const auto policy = vayu::http::resolve_default_header_policy (
    db, vayu::http::DefaultHeaderScope::Design);

    nlohmann::json headers = nlohmann::json::array ();
    for (const auto& header : vayu::http::declared_default_headers (policy)) {
        nlohmann::json row;
        row["name"] = header.name;
        // A generated value has none to show until the send makes one, so the
        // field is absent rather than an empty string a client would print.
        if (!header.generated) {
            row["value"] = header.value;
        }
        row["generated"] = header.generated;
        if (!header.config_key.empty ()) {
            row["configKey"] = header.config_key;
        }
        headers.push_back (std::move (row));
    }

    nlohmann::json response;
    response["headers"] = std::move (headers);
    return response;
}

void register_config_routes (RouteContext& ctx) {
    /**
     * GET /request-defaults
     * What the engine adds to a request that does not name it (issue #1229).
     */
    ctx.server.Get ("/request-defaults",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        try {
            res.set_content (request_defaults_json (ctx.db).dump (2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /request-defaults - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

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
