/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/json.cpp
 * @brief JSON utilities implementation
 */

#include "vayu/utils/json.hpp"

#include <ostream>
#include <sstream>

#include "vayu/core/constants.hpp"

namespace vayu::json {

// ============================================================================
// Parsing
// ============================================================================

Result<Json> parse (const std::string& str) {
    try {
        return Json::parse (str);
    } catch (const Json::parse_error& e) {
        return Error{ ErrorCode::InternalError, e.what () };
    }
}

bool is_valid_json (const std::string& str) {
    return Json::accept (str);
}

std::optional<Json> try_parse_body (const std::string& body) {
    if (body.empty ()) {
        return std::nullopt;
    }
    try {
        return std::make_optional (Json::parse (body));
    } catch (...) {
        return std::nullopt;
    }
}

// ============================================================================
// Request Serialization
// ============================================================================

Json serialize (const Request& request) {
    Json json;

    json["method"] = to_string (request.method);
    json["url"]    = request.url;

    if (!request.headers.empty ()) {
        json["headers"] = request.headers;
    }

    if (request.body.mode != BodyMode::None) {
        Json body_json;

        switch (request.body.mode) {
        case BodyMode::Json:
            body_json["mode"] = "json";
            // Try to parse as JSON for proper nesting
            if (auto parsed = try_parse_body (request.body.content)) {
                body_json["content"] = *parsed;
            } else {
                body_json["content"] = request.body.content;
            }
            break;
        case BodyMode::Text:
            body_json["mode"]    = "text";
            body_json["content"] = request.body.content;
            break;
        case BodyMode::Form:
            body_json["mode"]    = "form";
            body_json["content"] = request.body.content;
            break;
        case BodyMode::FormData:
            body_json["mode"]    = "formdata";
            body_json["content"] = request.body.content;
            break;
        case BodyMode::Binary:
            body_json["mode"]    = "binary";
            body_json["content"] = request.body.content;
            break;
        case BodyMode::GraphQL:
            body_json["mode"]    = "graphql";
            body_json["content"] = request.body.content;
            break;
        default: break;
        }

        json["body"] = body_json;
    }

    json["timeout"]         = request.timeout_ms;
    json["followRedirects"] = request.follow_redirects;
    json["maxRedirects"]    = request.max_redirects;
    json["verifySSL"]       = request.verify_ssl;

    return json;
}

Json serialize (const vayu::db::Run& run) {
    Json json;
    json["id"]        = run.id;
    json["type"]      = to_string (run.type);
    json["status"]    = to_string (run.status);
    json["startTime"] = run.start_time;
    json["endTime"]   = run.end_time;
    // Try to parse configSnapshot as JSON if possible, otherwise string
    if (auto parsed = try_parse_body (run.config_snapshot)) {
        json["configSnapshot"] = *parsed;
    } else {
        json["configSnapshot"] = run.config_snapshot;
    }

    json["requestId"] =
    run.request_id.has_value () ? Json (run.request_id.value ()) : Json (nullptr);
    json["environmentId"] = run.environment_id.has_value () ?
    Json (run.environment_id.value ()) :
    Json (nullptr);
    return json;
}

void attach_design_result (nlohmann::json& json,
const vayu::db::Run& run,
const std::vector<vayu::db::Result>& results) {
    if (run.type != vayu::RunType::Design || results.empty ())
        return;

    const auto& result = results.front ();
    nlohmann::json out;
    out["timestamp"]  = result.timestamp;
    out["statusCode"] = result.status_code;
    out["statusText"] = result.status_text;
    out["latencyMs"]  = result.latency_ms;
    if (!result.error.empty ())
        out["error"] = result.error;
    if (!result.trace_data.empty ()) {
        try {
            out["trace"] = nlohmann::json::parse (result.trace_data);
        } catch (...) {
            out["trace"] = result.trace_data;
        }
    }
    json["result"] = out;
}

Json serialize (const vayu::db::Collection& c) {
    Json json;
    json["id"] = c.id;
    json["parentId"] =
    c.parent_id.has_value () ? Json (c.parent_id.value ()) : Json (nullptr);
    json["name"]        = c.name;
    json["description"] = c.description;
    json["order"]       = c.order;
    json["createdAt"]   = c.created_at;
    json["updatedAt"]   = c.updated_at;

    // Parse collection variables JSON
    if (c.variables.empty ()) {
        json["variables"] = Json::object ();
    } else {
        try {
            json["variables"] = Json::parse (c.variables);
        } catch (const std::exception&) {
            json["variables"] = Json::object ();
        }
    }

    // Parse auth JSON
    if (c.auth.empty ()) {
        json["auth"] = Json::object ({ { "mode", "none" } });
    } else {
        try {
            json["auth"] = Json::parse (c.auth);
        } catch (const std::exception&) {
            json["auth"] = Json::object ({ { "mode", "none" } });
        }
    }

    json["preRequestScript"]  = c.pre_request_script;
    json["postRequestScript"] = c.post_request_script;

    return json;
}

Json serialize (const vayu::db::Request& r) {
    Json json;
    json["id"]           = r.id;
    json["collectionId"] = r.collection_id;
    json["name"]         = r.name;
    json["description"]  = r.description;
    json["method"]       = to_string (r.method);
    json["url"]          = r.url;
    json["order"]        = r.order;

    // Query params - stored as JSON array of KeyValueEntry
    if (r.params.empty ()) {
        json["params"] = Json::array ();
    } else {
        try {
            json["params"] = Json::parse (r.params);
        } catch (const std::exception&) {
            json["params"] = Json::array ();
        }
    }

    // Headers - stored as JSON array of KeyValueEntry
    if (r.headers.empty ()) {
        json["headers"] = Json::array ();
    } else {
        try {
            json["headers"] = Json::parse (r.headers);
        } catch (const std::exception&) {
            json["headers"] = Json::array ();
        }
    }

    // Body - stored as JSON discriminated union {mode, content?} | {mode, fields?}
    if (r.body.empty ()) {
        json["body"] = Json::object ({ { "mode", "none" } });
    } else {
        try {
            json["body"] = Json::parse (r.body);
        } catch (const std::exception&) {
            json["body"] = Json::object ({ { "mode", "none" } });
        }
    }

    json["bodyType"] = r.body_type.empty () ? "none" : r.body_type;

    if (r.auth.empty ()) {
        json["auth"] = Json::object ({ { "mode", "inherit" } });
    } else {
        try {
            json["auth"] = Json::parse (r.auth);
        } catch (const std::exception&) {
            json["auth"] = Json::object ({ { "mode", "inherit" } });
        }
    }

    json["preRequestScript"]  = r.pre_request_script;
    json["postRequestScript"] = r.post_request_script;
    json["followRedirects"]   = r.follow_redirects;
    json["maxRedirects"]      = r.max_redirects;
    json["updatedAt"]         = r.updated_at;
    json["createdAt"]         = r.created_at;
    return json;
}

Json serialize (const vayu::db::Environment& e) {
    Json json;
    json["id"]          = e.id;
    json["name"]        = e.name;
    json["description"] = e.description;

    // Safely parse variables JSON with exception handling
    if (e.variables.empty ()) {
        json["variables"] = Json::object ();
    } else {
        try {
            json["variables"] = Json::parse (e.variables);
        } catch (const std::exception&) {
            json["variables"] = Json::object ();
        }
    }

    json["isActive"]  = e.is_active;
    json["updatedAt"] = e.updated_at;
    return json;
}

Json serialize (const vayu::db::Metric& metric) {
    Json json;
    json["id"]        = metric.id;
    json["runId"]     = metric.run_id;
    json["timestamp"] = metric.timestamp;
    json["name"]      = to_string (metric.name);
    json["value"]     = metric.value;
    if (!metric.labels.empty ()) {
        if (auto parsed = try_parse_body (metric.labels)) {
            json["labels"] = *parsed;
        } else {
            json["labels"] = metric.labels;
        }
    }
    return json;
}

Result<Request> deserialize_request (const Json& json) {
    try {
        Request request;

        // Method (required)
        if (!json.contains ("method")) {
            return Error{ ErrorCode::InvalidMethod, "Missing 'method' field" };
        }
        auto method = parse_method (json["method"].get<std::string> ());
        if (!method) {
            return Error{ ErrorCode::InvalidMethod, "Invalid HTTP method" };
        }
        request.method = *method;

        // URL (required)
        if (!json.contains ("url")) {
            return Error{ ErrorCode::InvalidUrl, "Missing 'url' field" };
        }
        request.url = json["url"].get<std::string> ();

        // Headers (optional)
        if (json.contains ("headers") && json["headers"].is_object ()) {
            for (auto& [key, value] : json["headers"].items ()) {
                request.headers[key] = value.get<std::string> ();
            }
        }

        // Body (optional)
        if (json.contains ("body") && json["body"].is_object ()) {
            const auto& body_json = json["body"];

            if (body_json.contains ("mode")) {
                std::string mode = body_json["mode"].get<std::string> ();

                if (mode == "json") {
                    request.body.mode = BodyMode::Json;
                } else if (mode == "text") {
                    request.body.mode = BodyMode::Text;
                } else if (mode == "form") {
                    request.body.mode = BodyMode::Form;
                } else if (mode == "formdata") {
                    request.body.mode = BodyMode::FormData;
                } else if (mode == "binary") {
                    request.body.mode = BodyMode::Binary;
                } else if (mode == "graphql") {
                    request.body.mode = BodyMode::GraphQL;
                }
            }

            if (body_json.contains ("content")) {
                if (body_json["content"].is_string ()) {
                    request.body.content = body_json["content"].get<std::string> ();
                } else {
                    // Serialize nested JSON
                    request.body.content = body_json["content"].dump ();
                }
            }
        }

        // Options
        if (json.contains ("timeout")) {
            request.timeout_ms = json["timeout"].get<int> ();
        } else {
            // Use default timeout constant if not specified
            // Note: To use a custom default, specify timeout in the request JSON
            request.timeout_ms = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
        }
        if (json.contains ("followRedirects")) {
            request.follow_redirects = json["followRedirects"].get<bool> ();
        }
        if (json.contains ("maxRedirects")) {
            request.max_redirects = json["maxRedirects"].get<int> ();
        }
        if (json.contains ("verifySSL")) {
            request.verify_ssl = json["verifySSL"].get<bool> ();
        }

        return request;
    } catch (const std::exception& e) {
        return Error{ ErrorCode::InternalError, e.what () };
    }
}

Result<Request> deserialize_request (const std::string& str) {
    auto json_result = parse (str);
    if (json_result.is_error ()) {
        return json_result.error ();
    }
    return deserialize_request (json_result.value ());
}

// ============================================================================
// Response Serialization
// ============================================================================

Json serialize (const Response& response) {
    Json json;

    json["status"]         = response.status_code;
    json["statusText"]     = response.status_text;
    json["headers"]        = response.headers;
    json["requestHeaders"] = response.request_headers;
    json["rawRequest"]     = response.raw_request;
    json["bodySize"]       = response.body_size;

    // Try to parse body as JSON
    if (auto parsed = try_parse_body (response.body)) {
        json["body"] = *parsed;
    } else {
        json["body"] = nullptr;
    }
    json["bodyRaw"] = response.body;

    // Error information (for client-side failures)
    if (response.error_code != vayu::ErrorCode::None) {
        json["errorCode"]    = vayu::to_string (response.error_code);
        json["errorMessage"] = response.error_message;
    }

    // Timing. Same `*Ms` key convention as the stored trace (store_result /
    // load_strategy), so the live response and a restored one need no renaming.
    Json timing;
    timing["totalMs"]     = response.timing.total_ms;
    timing["wireMs"]      = response.timing.wire_ms;
    timing["queueWaitMs"] = response.timing.queue_wait_ms;
    timing["dnsMs"]       = response.timing.dns_ms;
    timing["connectMs"]   = response.timing.connect_ms;
    timing["tlsMs"]       = response.timing.tls_ms;
    timing["firstByteMs"] = response.timing.first_byte_ms;
    timing["downloadMs"]  = response.timing.download_ms;
    json["timing"]        = timing;

    return json;
}

std::string serialize_string (const Response& response, int indent) {
    return serialize (response).dump (indent);
}

// ============================================================================
// Error Serialization
// ============================================================================

Json serialize (const Error& error) {
    Json json;
    json["error"]["code"]    = to_string (error.code);
    json["error"]["message"] = error.message;
    return json;
}

// ============================================================================
// Script Result Serialization
// ============================================================================

Json serialize (const ScriptResult& result) {
    Json json;

    json["success"] = result.success;

    Json tests = Json::array ();
    for (const auto& test : result.tests) {
        Json test_json;
        test_json["name"]   = test.name;
        test_json["passed"] = test.passed;
        if (!test.error_message.empty ()) {
            test_json["error"] = test.error_message;
        } else {
            test_json["error"] = nullptr;
        }
        tests.push_back (test_json);
    }
    json["testResults"] = tests;

    json["consoleOutput"] = result.console_output;

    if (!result.error_message.empty ()) {
        json["error"] = result.error_message;
    }

    return json;
}

// ============================================================================
// Pretty Printing
// ============================================================================

namespace {

// ANSI color codes
constexpr const char* RESET   = "\033[0m";
constexpr const char* CYAN    = "\033[36m"; // Keys
constexpr const char* GREEN   = "\033[32m"; // Strings
constexpr const char* YELLOW  = "\033[33m"; // Numbers
constexpr const char* MAGENTA = "\033[35m"; // Booleans/null
constexpr const char* WHITE   = "\033[37m"; // Brackets

void pretty_print_impl (std::ostringstream& ss, const Json& json, int indent, int current_indent, bool color) {
    const std::string indent_str (static_cast<size_t> (current_indent), ' ');
    const std::string next_indent_str (static_cast<size_t> (current_indent + indent), ' ');

    if (json.is_object ()) {
        ss << (color ? WHITE : "") << "{" << (color ? RESET : "") << "\n";

        size_t i = 0;
        for (auto& [key, value] : json.items ()) {
            ss << next_indent_str;
            ss << (color ? CYAN : "") << "\"" << key << "\"" << (color ? RESET : "");
            ss << ": ";
            pretty_print_impl (ss, value, indent, current_indent + indent, color);

            if (++i < json.size ()) {
                ss << ",";
            }
            ss << "\n";
        }

        ss << indent_str << (color ? WHITE : "") << "}" << (color ? RESET : "");
    } else if (json.is_array ()) {
        ss << (color ? WHITE : "") << "[" << (color ? RESET : "") << "\n";

        for (size_t i = 0; i < json.size (); ++i) {
            ss << next_indent_str;
            pretty_print_impl (ss, json[i], indent, current_indent + indent, color);

            if (i < json.size () - 1) {
                ss << ",";
            }
            ss << "\n";
        }

        ss << indent_str << (color ? WHITE : "") << "]" << (color ? RESET : "");
    } else if (json.is_string ()) {
        ss << (color ? GREEN : "") << "\"" << json.get<std::string> () << "\""
           << (color ? RESET : "");
    } else if (json.is_number ()) {
        ss << (color ? YELLOW : "") << json.dump () << (color ? RESET : "");
    } else if (json.is_boolean ()) {
        ss << (color ? MAGENTA : "") << (json.get<bool> () ? "true" : "false")
           << (color ? RESET : "");
    } else if (json.is_null ()) {
        ss << (color ? MAGENTA : "") << "null" << (color ? RESET : "");
    }
}

} // namespace

std::string pretty_print (const Json& json, bool color) {
    std::ostringstream ss;
    pretty_print_impl (ss, json, 2, 0, color);
    return ss.str ();
}

// ============================================================================
// Streaming Serialization
// ============================================================================

void serialize_to_stream (const vayu::db::Request& r, std::ostream& out) {
    const size_t max_field_size = vayu::core::constants::json::MAX_FIELD_SIZE;

    out << "{";
    out << "\"id\":" << Json (r.id).dump () << ",";
    out << "\"collectionId\":" << Json (r.collection_id).dump () << ",";
    out << "\"name\":" << Json (r.name).dump () << ",";
    out << "\"description\":" << Json (r.description).dump () << ",";
    out << "\"method\":" << Json (to_string (r.method)).dump () << ",";
    out << "\"url\":" << Json (r.url).dump () << ",";
    out << "\"order\":" << r.order << ",";

    // Query params - JSON array of KeyValueEntry
    out << "\"params\":";
    if (r.params.empty ()) {
        out << "[]";
    } else {
        try {
            if (r.params.size () > max_field_size) {
                out << "[]";
            } else {
                auto parsed = Json::parse (r.params);
                out << parsed.dump ();
            }
        } catch (const std::exception&) {
            out << "[]";
        }
    }
    out << ",";

    // Headers - JSON array of KeyValueEntry
    out << "\"headers\":";
    if (r.headers.empty ()) {
        out << "[]";
    } else {
        try {
            if (r.headers.size () > max_field_size) {
                out << "[]";
            } else {
                auto parsed = Json::parse (r.headers);
                out << parsed.dump ();
            }
        } catch (const std::exception&) {
            out << "[]";
        }
    }
    out << ",";

    // Body - JSON discriminated union
    out << "\"body\":";
    if (r.body.empty ()) {
        out << "{\"mode\":\"none\"}";
    } else {
        try {
            if (r.body.size () > max_field_size) {
                out << "{\"mode\":\"none\"}";
            } else {
                auto parsed = Json::parse (r.body);
                out << parsed.dump ();
            }
        } catch (const std::exception&) {
            out << "{\"mode\":\"none\"}";
        }
    }
    out << ",";

    out << "\"bodyType\":" << Json (r.body_type.empty () ? "none" : r.body_type).dump ()
        << ",";

    // Auth - JSON RequestAuth object
    out << "\"auth\":";
    if (r.auth.empty ()) {
        out << "{\"mode\":\"inherit\"}";
    } else {
        try {
            if (r.auth.size () > max_field_size) {
                out << "{\"mode\":\"inherit\"}";
            } else {
                auto parsed = Json::parse (r.auth);
                out << parsed.dump ();
            }
        } catch (const std::exception&) {
            out << "{\"mode\":\"inherit\"}";
        }
    }
    out << ",";

    out << "\"preRequestScript\":" << Json (r.pre_request_script).dump () << ",";
    out << "\"postRequestScript\":" << Json (r.post_request_script).dump () << ",";
    out << "\"followRedirects\":" << (r.follow_redirects ? "true" : "false") << ",";
    out << "\"maxRedirects\":" << r.max_redirects << ",";
    out << "\"updatedAt\":" << r.updated_at << ",";
    out << "\"createdAt\":" << r.created_at;
    out << "}";
}

std::string sanitize_config_snapshot (const std::string& body) {
    Json parsed;
    try {
        parsed = Json::parse (body);
    } catch (const std::exception&) {
        return body; // not JSON; store as-is
    }

    // Allowlist within the auth subtree: keep only the mode, drop every
    // credential field. Because we keep a fixed key rather than blocking known
    // secret names, no future auth field (client secrets, tokens, private keys)
    // can leak into the persisted snapshot.
    if (parsed.is_object ()) {
        if (auto it = parsed.find ("auth");
            it != parsed.end () && it->is_object ()) {
            const std::string mode = it->value ("mode", std::string{ "none" });
            *it                    = Json::object ({ { "mode", mode } });
        }
    }
    return parsed.dump ();
}

} // namespace vayu::json
