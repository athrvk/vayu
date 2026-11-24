/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Configuration management routes. */

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstddef>
#include <expected>
#include <format>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "vayu/http/default_headers.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/parse.hpp"

namespace vayu::http::routes {

/**
 * @p text as a double, or nothing unless the whole of it is one.
 * `std::from_chars` would be the primitive (`utils/parse.hpp`), but its
 * floating-point overloads are missing below macOS 26 and the engine targets
 * 13.3 (`docs/engine/building.md`). `std::stod` stops at the first character it
 * cannot use, so "1.5x" is checked by how far it read, and the leading
 * whitespace it skips is refused as `parse_number` refuses it. Extern so
 * `tests/config_route_test.cpp` can drive it: no seeded entry is typed `number`
 * yet, so no route request reaches it.
 */
std::optional<double> parse_whole_double (const std::string& text) {
    if (text.empty () || std::isspace (static_cast<unsigned char> (text.front ())) != 0) {
        return std::nullopt;
    }
    try {
        std::size_t consumed = 0;
        const double parsed  = std::stod (text, &consumed);
        if (consumed != text.size ()) {
            return std::nullopt;
        }
        return parsed;
    } catch (const std::logic_error&) {
        // @deliberate: no digits (invalid_argument) or a value too large for a
        // double (out_of_range) both mean "not a number" to the caller.
        return std::nullopt;
    }
}

namespace {

// A config entry in the wire shape the GET and POST responses share.
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
    // than null when it measures nothing, like `min` / `max` / `options`, so a
    // client has one rule for this payload's optional scalars. Absent means a
    // count.
    if (entry.unit) {
        entry_json["unit"] = *entry.unit;
    }
    // The boolean sibling this entry is nested under and disabled without,
    // omitted for a standalone entry: a catalogue fact the seed checks
    // (`ConfigSeeder::validate_dependencies`), never read back by
    // `POST /config`.
    if (entry.depends_on) {
        entry_json["dependsOn"] = *entry.depends_on;
    }
    if (entry.options) {
        // Stored as a JSON-array string (JSON-in-TEXT, like every structured
        // column), parsed back so the wire shape is `"options": [...]`.
        // Guarded, as the enum branch of `apply_config_update` is: one
        // malformed row must not make all of GET /config a 500 and take the
        // settings screen down; without the key, a renderer can show the entry
        // as unavailable. Only `seed_default_config` writes the column, so a
        // malformed value is a tampered or truncated row, logged so the setting
        // does not vanish from the UI without a trail.
        try {
            entry_json["options"] = nlohmann::json::parse (*entry.options);
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("config",
            "config entry '" + entry.key +
            "' has malformed options JSON, omitting it: " + e.what ());
        }
    }
    // Always present, both: a consumer distinguishing "false" from "this engine
    // does not send it" is back to guessing.
    entry_json["requiresRestart"] = entry.requires_restart;
    entry_json["advanced"]        = entry.advanced;
    // Search terms, always an array, empty for an entry declaring none. Unlike
    // `options`, never dropped: "no keywords" and "not sent" must not need
    // telling apart, and an empty list is honest for a malformed row and an
    // entry with none.
    nlohmann::json keywords = nlohmann::json::array ();
    try {
        auto parsed = nlohmann::json::parse (entry.keywords);
        if (parsed.is_array ()) {
            keywords = std::move (parsed);
        } else {
            vayu::utils::log_warning ("config",
            "config entry '" + entry.key + "' has non-array keywords JSON, sending an empty list");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("config",
        "config entry '" + entry.key +
        "' has malformed keywords JSON, sending an empty list: " + e.what ());
    }
    entry_json["keywords"]  = std::move (keywords);
    entry_json["updatedAt"] = entry.updated_at;
    return entry_json;
}

// A /config validation failure names its own code rather than the per-status
// default; `config_error` wraps the shared builder (routes.hpp).
constexpr std::string_view INVALID_CONFIG_CODE = "invalid_config";

nlohmann::json config_error (const std::string& message) {
    return error_body (400, message, INVALID_CONFIG_CODE);
}

// Every stored config row this engine's catalogue declares (#1492), the one
// list `GET /config` and `POST /config`'s echoed `entries` serve, so a row a
// newer engine wrote reaches no client through either.
nlohmann::json catalogued_config_entries_json (vayu::db::Database& db) {
    nlohmann::json entries_array = nlohmann::json::array ();
    for (const auto& entry : db.get_all_config_entries ()) {
        if (db.is_known_config_key (entry.key)) {
            entries_array.push_back (config_entry_json (entry));
        }
    }
    return entries_array;
}

// One config value as the string the store holds, shared by both body shapes so
// a number or boolean cannot mean different text by which carried it.
std::string config_value_string (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_number ()) {
        // `dump` keeps an integer an integer: `to_string (double)` gives 16 as
        // "16.000000", which an integer entry refuses.
        return value.dump ();
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
 * Why @p value is not a number this entry accepts, or an empty string. @p parse
 * maps a whole string to a number or nothing, and the bounds go through it too:
 * a stored `min` that does not parse is a broken row, and refusing the write is
 * the safe direction for a validator that cannot tell whether the bound was
 * met.
 */
template <typename Value, typename Parse>
std::string numeric_rejection (const vayu::db::ConfigEntry& entry,
const std::string& value,
const char* expected,
Parse parse) {
    std::string malformed =
    std::format ("'{}' must be {} (got '{}')", entry.label, expected, value);

    const std::optional<Value> parsed = parse (value);
    if (!parsed) {
        return malformed;
    }
    if (entry.min_value) {
        const std::optional<Value> min = parse (*entry.min_value);
        if (!min) {
            return malformed;
        }
        if (*parsed < *min) {
            return std::format ("'{}' must be at least {} (got {})",
            entry.label, *entry.min_value, value);
        }
    }
    if (entry.max_value) {
        const std::optional<Value> max = parse (*entry.max_value);
        if (!max) {
            return malformed;
        }
        if (*parsed > *max) {
            return std::format ("'{}' must be at most {} (got {})", entry.label,
            *entry.max_value, value);
        }
    }
    return {};
}

/** Why @p value is not one of this enum entry's options, or an empty string. */
std::string enum_rejection (const vayu::db::ConfigEntry& entry, const std::string& value) {
    std::vector<std::string> allowed;
    std::string allowed_list;
    if (entry.options) {
        try {
            for (const auto& option : nlohmann::json::parse (*entry.options)) {
                std::string opt_value = option.at ("value").get<std::string> ();
                std::string opt_label = option.value ("label", opt_value);
                allowed.push_back (opt_value);
                if (!allowed_list.empty ()) {
                    allowed_list += ", ";
                }
                allowed_list += opt_label;
                allowed_list += " ('";
                allowed_list += opt_value;
                allowed_list += "')";
            }
        } catch (const std::exception&) {
            // @deliberate: malformed options fall through with an empty
            // allowed list, so the value is rejected rather than
            // accepted - the safe direction for a validator.
        }
    }
    if (std::find (allowed.begin (), allowed.end (), value) == allowed.end ()) {
        return std::format (
        "'{}' must be one of [{}] (got '{}')", entry.label, allowed_list, value);
    }
    return {};
}

/** Why @p value does not satisfy the entry's declared type, or an empty string. */
std::string type_rejection (const vayu::db::ConfigEntry& entry, const std::string& value) {
    if (entry.type == "integer") {
        return numeric_rejection<int> (
        entry, value, "an integer", [] (const std::string& text) {
            return vayu::utils::parse_number<int> (text);
        });
    }
    if (entry.type == "number") {
        return numeric_rejection<double> (entry, value, "a number", &parse_whole_double);
    }
    if (entry.type == "boolean") {
        if (value != "true" && value != "false") {
            return std::format (
            "'{}' must be 'true' or 'false' (got '{}')", entry.label, value);
        }
        return {};
    }
    if (entry.type == "enum") {
        return enum_rejection (entry, value);
    }
    return {};
}

/**
 * The rules a key carries beyond its declared type, as the proxy URL's live in
 * `proxy_url_rejection`: the type says "text" and only the key knows what the
 * text must be.
 *
 * `customCaCertificates` is refused at the boundary, not at handshake time: a
 * pasted key, a truncated block or one OpenSSL cannot parse would otherwise be
 * stored, materialized and reported as an unrelated verification failure on
 * every later request (#706, #3256).
 *
 * `proxyBypass` is judged per entry (`proxy_bypass_rejection`): libcurl reads
 * `localhost:8080` or `*.example.com` as a hostname no transfer dials, so the
 * exemption would be stored, shown in Settings and never apply.
 *
 * `proxySystemUrl`, which the app writes from the operating system's answer
 * (#708), takes a hand-typed `proxyUrl`'s rule: a shape libcurl has no proxy
 * support for would be stored, read under `system` mode and fall back to the
 * environment with only a log line. Empty is no rejection: it is how the app
 * records "no proxy here", and clearing it is how `system` goes direct.
 */
std::string key_rejection (const vayu::db::ConfigEntry& entry, const std::string& value) {
    // `correlationIdHeader` is a header name, and one that is not would put a
    // broken line on every later request, the invisible failure the proxy URL
    // is refused for (#1229).
    if (entry.key == std::string (vayu::http::CORRELATION_ID_HEADER_KEY)) {
        if (const auto rejection = vayu::http::unusable_header_name (value)) {
            return "'" + entry.label + "' is not usable: " + *rejection;
        }
    }
    if (entry.key == "customCaCertificates" && !value.empty ()) {
        if (const auto rejection = vayu::http::ca_pem_parse_rejection (value)) {
            return "'" + entry.label + "' is not a usable PEM bundle: " + *rejection;
        }
    }
    if (entry.key == "proxySystemUrl" && !value.empty ()) {
        if (const auto rejection = vayu::http::proxy_url_rejection (value)) {
            return "'" + entry.label + "' is not usable: " + *rejection;
        }
    }
    if (entry.key == "proxyBypass") {
        if (const auto rejection = vayu::http::proxy_bypass_rejection (value)) {
            return "'" + entry.label + "' is not usable: " + *rejection;
        }
    }
    return {};
}

/**
 * The cross-field proxy rule: `manual` mode with no usable URL would accept the
 * write, say "Manual" in Settings and send every request direct, the invisible
 * failure #705 exists to end. Judged against the state the batch leaves, not
 * either half alone: the two keys may arrive together or in either order across
 * two requests.
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
    // The key's catalogue label, or the wire key if the row is missing: the
    // fallback `Registry::find` callers use for an element kind.
    const auto label_of = [&] (const char* key) {
        const auto entry = db.get_config_entry (key);
        return entry ? entry->label : std::string (key);
    };
    const std::string mode = effective ("proxyMode");
    const std::string url  = effective ("proxyUrl");
    if (vayu::http::proxy_mode_from_string (mode) == vayu::http::ProxyMode::Manual) {
        if (const auto rejection = vayu::http::proxy_url_rejection (url)) {
            return "'" + label_of ("proxyUrl") + "' is required when '" +
            label_of ("proxyMode") + "' is '" +
            vayu::http::proxy_mode_label (vayu::http::ProxyMode::Manual) + "': " + *rejection;
        }
        return std::nullopt;
    }
    // A URL stored under another mode is inert, not wrong (how someone keeps a
    // proxy while switching it off), so it is validated but not required.
    if (!url.empty ()) {
        if (const auto rejection = vayu::http::proxy_url_rejection (url)) {
            return "'" + label_of ("proxyUrl") + "' is not usable: " + *rejection;
        }
    }
    return std::nullopt;
}

} // namespace

/**
 * The parse-validate-write of POST /config, run under the caller's lock.
 *
 * @param before_write Test seam, invoked inside the lock scope immediately
 *        before the batch is written: the only way to drive a competing client
 *        into the window this closes (`tests/competing_writer.hpp`).
 */
static std::pair<int, nlohmann::json> apply_config_update_locked (vayu::db::Database& db,
const std::string& body,
const std::function<void ()>& before_write) {
    const auto parsed =
    parse_request_json (body, INVALID_CONFIG_CODE, {}, INVALID_CONFIG_CODE);
    if (!parsed) {
        vayu::utils::log_error (
        "config", "POST /config - " + error_message_of (parsed.error ().body));
        return as_response (parsed.error ());
    }
    const nlohmann::json& json = *parsed;

    std::unordered_map<std::string, std::string> updates;
    if (const auto rejection = read_config_updates (json, updates)) {
        return { 400, config_error (*rejection) };
    }

    // Every key is validated before any is applied (all-or-nothing, #1453): the
    // caller's lock holds validation and write to one scope, so no reader sees
    // the passing keys land one at a time, and the write is one transaction
    // (`Database::with_lock` is a mutex, not a transaction).
    std::vector<vayu::db::ConfigEntry> to_update;
    std::vector<std::string> errors;

    for (const auto& [key, value] : updates) {
        // Against this engine's catalogue (#1492), not mere row existence: a
        // workspace a newer engine opened can hold a row for a key this build
        // does not declare and has no validator for, so the row alone would
        // admit a value this engine cannot check.
        if (!db.is_known_config_key (key)) {
            errors.push_back ("Unknown config key '" + key + "'");
            continue;
        }
        auto existing = db.get_config_entry (key);
        if (!existing) {
            // Unreachable in practice (every catalogued key is seeded before
            // the listener starts), kept as the honest answer if it ever is
            // reached.
            errors.push_back ("Unknown config key '" + key + "'");
            continue;
        }

        std::string reason = type_rejection (*existing, value);
        if (reason.empty ()) {
            reason = key_rejection (*existing, value);
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
        vayu::utils::log_error ("config", "POST /config - Validation failed: " + joined);
        return { 400, config_error (joined) };
    }

    if (before_write) {
        before_write ();
    }
    db.save_config_entries (to_update);

    vayu::utils::log_info ("config",
    "Updated " + std::to_string (to_update.size ()) + " config entries");

    nlohmann::json response;
    response["entries"] = catalogued_config_entries_json (db);
    response["success"] = true;
    return { 200, response };
}

/**
 * Parses, validates and applies a POST /config body, outside the handler so
 * validation and its failure reasons are unit-testable without a server.
 *
 * **The validation and the write are one lock scope** (#1453). Writing each row
 * under its own acquisition let a reader (`GET /config`, or
 * `resolve_transport_policy` reading `proxyMode` and `proxyUrl` in two calls)
 * land between two writes and see one key updated and the other stale, and let
 * a mid-batch failure leave the earlier rows applied. The lock across the
 * composite closes the reader window, as `update_request_response` does for a
 * merge-patch (#1440); `Database::save_config_entries` closes the failure
 * window by writing every row in one transaction.
 *
 * @return {http_status, json_body}. On validation failure the body carries the
 *         specific reasons (which key, and why: bad type, out of range), so the
 *         app can show them instead of "check the logs".
 */
std::pair<int, nlohmann::json> apply_config_update (vayu::db::Database& db,
const std::string& body,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock (
    [&] { result = apply_config_update_locked (db, body, before_write); });
    return result;
}

std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body) {
    return apply_config_update (db, body, nullptr);
}

/**
 * Which send the caller asks `GET /request-defaults` to describe. No `scope` is
 * a design send; an empty one is absent rather than a scope of "", as
 * `parse_live_resume_point` reads an empty `lastEventId`. Anything else is
 * refused: the answers differ (a load run reads `loadNegotiateCompression`), so
 * a typo served the design answer would be the misdescription #1338 ends.
 */
std::expected<vayu::http::DefaultHeaderScope, RouteError>
parse_default_header_scope (std::string_view scope) {
    if (scope.empty () || scope == "design") {
        return vayu::http::DefaultHeaderScope::Design;
    }
    if (scope == "load") {
        return vayu::http::DefaultHeaderScope::Load;
    }
    return route_error (400,
    std::format ("'scope' must be one of [design, load] (got '{}')", scope), "invalid_scope");
}

/**
 * What the engine adds to a request that names none of it: the body of
 * `GET /request-defaults`, outside the route so a test with a `Database` needs
 * no server. A client renders these as the auto rows beside a request's headers
 * and sends the names it wants off as `disabledDefaultHeaders`. The engine
 * declares them: a renderer deriving the set from config entries would be a
 * second definition (#1229). @p scope picks the compression key the answer
 * reflects, the one default a load run resolves differently from a Send
 * (#1338); the caller names it, never assumed.
 */
nlohmann::json request_defaults_json (vayu::db::Database& db,
vayu::http::DefaultHeaderScope scope) {
    const auto policy = vayu::http::resolve_default_header_policy (db, scope);

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

/**
 * @brief The whole of `GET /request-defaults`: the scope it was asked for, or
 *        the refusal of one it does not know.
 */
std::pair<int, nlohmann::json>
request_defaults_response (vayu::db::Database& db, std::string_view scope_param) {
    const auto scope = parse_default_header_scope (scope_param);
    if (!scope) {
        return as_response (scope.error ());
    }
    return { 200, request_defaults_json (db, *scope) };
}

void register_config_routes (RouteContext& ctx) {
    /**
     * GET /request-defaults
     * What the engine adds to a request that does not name it (issue #1229),
     * for the send the caller names in `?scope=` (issue #1338).
     */
    ctx.server.Get ("/request-defaults",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto [status, response_body] =
            request_defaults_response (ctx.db, req.get_param_value ("scope"));
            res.status = status;
            res.set_content (response_body.dump (2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("config",
            "GET /request-defaults - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /config
     * Every catalogued configuration entry, with metadata for UI display
     * (`catalogued_config_entries_json`).
     */
    ctx.server.Get ("/config", [&ctx] (const httplib::Request&, httplib::Response& res) {
        try {
            nlohmann::json response;
            response["entries"] = catalogued_config_entries_json (ctx.db);
            res.set_content (response.dump (2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "config", "GET /config - Error: " + std::string (e.what ()));
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
        try {
            auto [status, response_body] = apply_config_update (ctx.db, req.body);
            res.status = status;
            // `replace`: a parse refusal quotes the bytes it stopped at (#2671).
            res.set_content (response_body.dump (2, ' ', false,
                             nlohmann::json::error_handler_t::replace),
            "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "config", "POST /config - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
