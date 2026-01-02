#pragma once

/**
 * @file utils/json.hpp
 * @brief JSON utilities for request/response serialization
 */

#include "vayu/types.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace vayu::json
{

    using Json = nlohmann::json;

    /**
     * @brief Parse a JSON string
     *
     * @param str The JSON string to parse
     * @return Result<Json> The parsed JSON or an error
     */
    [[nodiscard]] Result<Json> parse(const std::string &str);

    /**
     * @brief Serialize a Request to JSON
     */
    [[nodiscard]] Json serialize(const Request &request);

    /**
     * @brief Deserialize a Request from JSON
     */
    [[nodiscard]] Result<Request> deserialize_request(const Json &json);

    /**
     * @brief Deserialize a Request from a JSON string
     */
    [[nodiscard]] Result<Request> deserialize_request(const std::string &str);

    /**
     * @brief Serialize a Response to JSON
     */
    [[nodiscard]] Json serialize(const Response &response);

    /**
     * @brief Serialize a Response to JSON string
     */
    [[nodiscard]] std::string serialize_string(const Response &response, int indent = 2);

    /**
     * @brief Serialize an Error to JSON
     */
    [[nodiscard]] Json serialize(const Error &error);

    /**
     * @brief Serialize test results to JSON
     */
    [[nodiscard]] Json serialize(const ScriptResult &result);

    /**
     * @brief Pretty-print JSON with colors for terminal output
     */
    [[nodiscard]] std::string pretty_print(const Json &json, bool color = true);

    /**
     * @brief Check if a string is valid JSON
     */
    [[nodiscard]] bool is_valid_json(const std::string &str);

    /**
     * @brief Try to parse response body as JSON
     */
    [[nodiscard]] std::optional<Json> try_parse_body(const std::string &body);

} // namespace vayu::json
