/**
 * @file utils/json.cpp
 * @brief JSON utilities implementation
 */

#include "vayu/utils/json.hpp"

#include <sstream>

namespace vayu::json
{

    // ============================================================================
    // Parsing
    // ============================================================================

    Result<Json> parse(const std::string &str)
    {
        try
        {
            return Json::parse(str);
        }
        catch (const Json::parse_error &e)
        {
            return Error{ErrorCode::InternalError, e.what()};
        }
    }

    bool is_valid_json(const std::string &str)
    {
        return Json::accept(str);
    }

    std::optional<Json> try_parse_body(const std::string &body)
    {
        if (body.empty())
        {
            return std::nullopt;
        }
        try
        {
            return Json::parse(body);
        }
        catch (...)
        {
            return std::nullopt;
        }
    }

    // ============================================================================
    // Request Serialization
    // ============================================================================

    Json serialize(const Request &request)
    {
        Json json;

        json["method"] = to_string(request.method);
        json["url"] = request.url;

        if (!request.headers.empty())
        {
            json["headers"] = request.headers;
        }

        if (request.body.mode != BodyMode::None)
        {
            Json body_json;

            switch (request.body.mode)
            {
            case BodyMode::Json:
                body_json["mode"] = "json";
                // Try to parse as JSON for proper nesting
                if (auto parsed = try_parse_body(request.body.content))
                {
                    body_json["content"] = *parsed;
                }
                else
                {
                    body_json["content"] = request.body.content;
                }
                break;
            case BodyMode::Text:
                body_json["mode"] = "text";
                body_json["content"] = request.body.content;
                break;
            case BodyMode::Form:
                body_json["mode"] = "form";
                body_json["content"] = request.body.content;
                break;
            case BodyMode::FormData:
                body_json["mode"] = "formdata";
                body_json["content"] = request.body.content;
                break;
            case BodyMode::Binary:
                body_json["mode"] = "binary";
                body_json["content"] = request.body.content;
                break;
            case BodyMode::GraphQL:
                body_json["mode"] = "graphql";
                body_json["content"] = request.body.content;
                break;
            default:
                break;
            }

            json["body"] = body_json;
        }

        json["timeout"] = request.timeout_ms;
        json["followRedirects"] = request.follow_redirects;
        json["maxRedirects"] = request.max_redirects;
        json["verifySSL"] = request.verify_ssl;

        return json;
    }

    Json serialize(const vayu::db::Run &run)
    {
        Json json;
        json["id"] = run.id;
        json["type"] = to_string(run.type);
        json["status"] = to_string(run.status);
        json["startTime"] = run.start_time;
        json["endTime"] = run.end_time;
        // Try to parse configSnapshot as JSON if possible, otherwise string
        if (auto parsed = try_parse_body(run.config_snapshot))
        {
            json["configSnapshot"] = *parsed;
        }
        else
        {
            json["configSnapshot"] = run.config_snapshot;
        }

        if (run.request_id)
            json["requestId"] = *run.request_id;
        if (run.environment_id)
            json["environmentId"] = *run.environment_id;
        return json;
    }

    Json serialize(const vayu::db::Metric &metric)
    {
        Json json;
        json["id"] = metric.id;
        json["runId"] = metric.run_id;
        json["timestamp"] = metric.timestamp;
        json["name"] = to_string(metric.name);
        json["value"] = metric.value;
        if (!metric.labels.empty())
        {
            if (auto parsed = try_parse_body(metric.labels))
            {
                json["labels"] = *parsed;
            }
            else
            {
                json["labels"] = metric.labels;
            }
        }
        return json;
    }

    Result<Request> deserialize_request(const Json &json)
    {
        try
        {
            Request request;

            // Method (required)
            if (!json.contains("method"))
            {
                return Error{ErrorCode::InvalidMethod, "Missing 'method' field"};
            }
            auto method = parse_method(json["method"].get<std::string>());
            if (!method)
            {
                return Error{ErrorCode::InvalidMethod, "Invalid HTTP method"};
            }
            request.method = *method;

            // URL (required)
            if (!json.contains("url"))
            {
                return Error{ErrorCode::InvalidUrl, "Missing 'url' field"};
            }
            request.url = json["url"].get<std::string>();

            // Headers (optional)
            if (json.contains("headers") && json["headers"].is_object())
            {
                for (auto &[key, value] : json["headers"].items())
                {
                    request.headers[key] = value.get<std::string>();
                }
            }

            // Body (optional)
            if (json.contains("body") && json["body"].is_object())
            {
                const auto &body_json = json["body"];

                if (body_json.contains("mode"))
                {
                    std::string mode = body_json["mode"].get<std::string>();

                    if (mode == "json")
                    {
                        request.body.mode = BodyMode::Json;
                    }
                    else if (mode == "text")
                    {
                        request.body.mode = BodyMode::Text;
                    }
                    else if (mode == "form")
                    {
                        request.body.mode = BodyMode::Form;
                    }
                    else if (mode == "formdata")
                    {
                        request.body.mode = BodyMode::FormData;
                    }
                    else if (mode == "binary")
                    {
                        request.body.mode = BodyMode::Binary;
                    }
                    else if (mode == "graphql")
                    {
                        request.body.mode = BodyMode::GraphQL;
                    }
                }

                if (body_json.contains("content"))
                {
                    if (body_json["content"].is_string())
                    {
                        request.body.content = body_json["content"].get<std::string>();
                    }
                    else
                    {
                        // Serialize nested JSON
                        request.body.content = body_json["content"].dump();
                    }
                }
            }

            // Options
            if (json.contains("timeout"))
            {
                request.timeout_ms = json["timeout"].get<int>();
            }
            if (json.contains("followRedirects"))
            {
                request.follow_redirects = json["followRedirects"].get<bool>();
            }
            if (json.contains("maxRedirects"))
            {
                request.max_redirects = json["maxRedirects"].get<int>();
            }
            if (json.contains("verifySSL"))
            {
                request.verify_ssl = json["verifySSL"].get<bool>();
            }

            return request;
        }
        catch (const std::exception &e)
        {
            return Error{ErrorCode::InternalError, e.what()};
        }
    }

    Result<Request> deserialize_request(const std::string &str)
    {
        auto json_result = parse(str);
        if (json_result.is_error())
        {
            return json_result.error();
        }
        return deserialize_request(json_result.value());
    }

    // ============================================================================
    // Response Serialization
    // ============================================================================

    Json serialize(const Response &response)
    {
        Json json;

        json["status"] = response.status_code;
        json["statusText"] = response.status_text;
        json["headers"] = response.headers;
        json["bodySize"] = response.body_size;

        // Try to parse body as JSON
        if (auto parsed = try_parse_body(response.body))
        {
            json["body"] = *parsed;
        }
        else
        {
            json["body"] = nullptr;
        }
        json["bodyRaw"] = response.body;

        // Timing
        Json timing;
        timing["total"] = response.timing.total_ms;
        timing["dns"] = response.timing.dns_ms;
        timing["connect"] = response.timing.connect_ms;
        timing["tls"] = response.timing.tls_ms;
        timing["firstByte"] = response.timing.first_byte_ms;
        timing["download"] = response.timing.download_ms;
        json["timing"] = timing;

        return json;
    }

    std::string serialize_string(const Response &response, int indent)
    {
        return serialize(response).dump(indent);
    }

    // ============================================================================
    // Error Serialization
    // ============================================================================

    Json serialize(const Error &error)
    {
        Json json;
        json["error"]["code"] = to_string(error.code);
        json["error"]["message"] = error.message;
        return json;
    }

    // ============================================================================
    // Script Result Serialization
    // ============================================================================

    Json serialize(const ScriptResult &result)
    {
        Json json;

        json["success"] = result.success;

        Json tests = Json::array();
        for (const auto &test : result.tests)
        {
            Json test_json;
            test_json["name"] = test.name;
            test_json["passed"] = test.passed;
            if (!test.error_message.empty())
            {
                test_json["error"] = test.error_message;
            }
            else
            {
                test_json["error"] = nullptr;
            }
            tests.push_back(test_json);
        }
        json["testResults"] = tests;

        json["consoleOutput"] = result.console_output;

        if (!result.error_message.empty())
        {
            json["error"] = result.error_message;
        }

        return json;
    }

    // ============================================================================
    // Pretty Printing
    // ============================================================================

    namespace
    {

        // ANSI color codes
        constexpr const char *RESET = "\033[0m";
        constexpr const char *CYAN = "\033[36m";    // Keys
        constexpr const char *GREEN = "\033[32m";   // Strings
        constexpr const char *YELLOW = "\033[33m";  // Numbers
        constexpr const char *MAGENTA = "\033[35m"; // Booleans/null
        constexpr const char *WHITE = "\033[37m";   // Brackets

        void pretty_print_impl(std::ostringstream &ss, const Json &json,
                               int indent, int current_indent, bool color)
        {
            const std::string indent_str(static_cast<size_t>(current_indent), ' ');
            const std::string next_indent_str(static_cast<size_t>(current_indent + indent), ' ');

            if (json.is_object())
            {
                ss << (color ? WHITE : "") << "{" << (color ? RESET : "") << "\n";

                size_t i = 0;
                for (auto &[key, value] : json.items())
                {
                    ss << next_indent_str;
                    ss << (color ? CYAN : "") << "\"" << key << "\"" << (color ? RESET : "");
                    ss << ": ";
                    pretty_print_impl(ss, value, indent, current_indent + indent, color);

                    if (++i < json.size())
                    {
                        ss << ",";
                    }
                    ss << "\n";
                }

                ss << indent_str << (color ? WHITE : "") << "}" << (color ? RESET : "");
            }
            else if (json.is_array())
            {
                ss << (color ? WHITE : "") << "[" << (color ? RESET : "") << "\n";

                for (size_t i = 0; i < json.size(); ++i)
                {
                    ss << next_indent_str;
                    pretty_print_impl(ss, json[i], indent, current_indent + indent, color);

                    if (i < json.size() - 1)
                    {
                        ss << ",";
                    }
                    ss << "\n";
                }

                ss << indent_str << (color ? WHITE : "") << "]" << (color ? RESET : "");
            }
            else if (json.is_string())
            {
                ss << (color ? GREEN : "") << "\"" << json.get<std::string>() << "\""
                   << (color ? RESET : "");
            }
            else if (json.is_number())
            {
                ss << (color ? YELLOW : "") << json.dump() << (color ? RESET : "");
            }
            else if (json.is_boolean())
            {
                ss << (color ? MAGENTA : "") << (json.get<bool>() ? "true" : "false")
                   << (color ? RESET : "");
            }
            else if (json.is_null())
            {
                ss << (color ? MAGENTA : "") << "null" << (color ? RESET : "");
            }
        }

    } // namespace

    std::string pretty_print(const Json &json, bool color)
    {
        std::ostringstream ss;
        pretty_print_impl(ss, json, 2, 0, color);
        return ss.str();
    }

} // namespace vayu::json
