#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file mcp_fixture_server.hpp
 * @brief An in-process modern-era MCP endpoint that checks a POST's headers
 *        against its body the way the specification makes a server check them
 *        (#3762).
 *
 * Written from the specification's server-side rules, never from the engine's
 * derivation, so a header the engine stops deriving, or derives wrongly, is
 * answered `400` with JSON-RPC code `-32020` (HeaderMismatch) exactly as a real
 * server would answer it. A request that passes is answered `200` with a
 * `tools/call`-shaped result.
 *
 * The tool it knows is `execute_sql`, whose `region` argument the schema
 * mirrors as `Mcp-Param-Region` (`execute_sql_tool_json`).
 */

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

#include "task_queue.hpp"
#include "vayu/utils/encoding.hpp"

namespace vayu::tests {

/// The `mcpTool` a stored request carries for the fixture's one annotated tool.
inline nlohmann::json execute_sql_tool_json () {
    return nlohmann::json::parse (R"({"name":"execute_sql","inputSchema":{
        "type":"object","properties":{
          "region":{"type":"string","x-mcp-header":"Region"},
          "query":{"type":"string"}}}})");
}

class McpFixtureServer {
    public:
    McpFixtureServer () {
        svr_.new_task_queue = pooled_task_queue (2);
        svr_.Post ("/mcp", [this] (const httplib::Request& req, httplib::Response& res) {
            {
                std::lock_guard<std::mutex> lock (mutex_);
                headers_ = req.headers;
            }
            answer (req, res);
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~McpFixtureServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    McpFixtureServer (const McpFixtureServer&)            = delete;
    McpFixtureServer& operator= (const McpFixtureServer&) = delete;
    McpFixtureServer (McpFixtureServer&&)                 = delete;
    McpFixtureServer& operator= (McpFixtureServer&&)      = delete;

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/mcp";
    }

    /// One header of the last request, or nothing when it was not sent.
    std::optional<std::string> header (const std::string& name) const {
        std::lock_guard<std::mutex> lock (mutex_);
        const auto found = headers_.find (name);
        if (found == headers_.end ()) {
            return std::nullopt;
        }
        return found->second;
    }

    private:
    static constexpr std::string_view SENTINEL_PREFIX = "=?base64?";
    static constexpr std::string_view SENTINEL_SUFFIX = "?=";

    /// A sentinel-encoded value decoded, any other value as sent.
    static std::optional<std::string> decoded (const std::string& value) {
        if (!value.starts_with (SENTINEL_PREFIX) || !value.ends_with (SENTINEL_SUFFIX)) {
            return value;
        }
        const std::string_view inner =
        std::string_view (value).substr (SENTINEL_PREFIX.size (),
        value.size () - SENTINEL_PREFIX.size () - SENTINEL_SUFFIX.size ());
        return vayu::utils::base64_decode (inner);
    }

    /// Why @p header disagrees with the body's @p expected, or nothing.
    static std::optional<std::string> mismatch (const httplib::Request& req,
    const std::string& header,
    const std::optional<std::string>& expected,
    bool may_encode) {
        const bool sent = req.has_header (header);
        if (!expected) {
            return sent ? std::make_optional (header + " sent for no body value") :
                          std::nullopt;
        }
        if (!sent) {
            return header + " is missing";
        }
        const std::string value = req.get_header_value (header);
        const auto read = may_encode ? decoded (value) : std::make_optional (value);
        if (read != expected) {
            return header + " value '" + value +
            "' does not match body value '" + *expected + "'";
        }
        return std::nullopt;
    }

    static std::optional<std::string> string_at (const nlohmann::json& object,
    const nlohmann::json::json_pointer& at) {
        if (!object.contains (at) || !object.at (at).is_string ()) {
            return std::nullopt;
        }
        return object.at (at).get<std::string> ();
    }

    static std::optional<std::string>
    header_mismatch (const httplib::Request& req, const nlohmann::json& call) {
        const std::string accept = req.get_header_value ("Accept");
        if (accept.find ("application/json") == std::string::npos ||
        accept.find ("text/event-stream") == std::string::npos) {
            return "Accept must list application/json and text/event-stream";
        }
        const auto method = string_at (call, nlohmann::json::json_pointer ("/method"));
        const auto version = string_at (call,
        nlohmann::json::json_pointer (
        "/params/_meta/io.modelcontextprotocol~1protocolVersion"));
        std::optional<std::string> name;
        if (method == "tools/call" || method == "prompts/get") {
            name = string_at (call, nlohmann::json::json_pointer ("/params/name"));
        } else if (method == "resources/read") {
            name = string_at (call, nlohmann::json::json_pointer ("/params/uri"));
        }
        std::optional<std::string> region;
        if (method == "tools/call" && name == "execute_sql") {
            region = string_at (
            call, nlohmann::json::json_pointer ("/params/arguments/region"));
        }
        for (const auto& found : { mismatch (req, "MCP-Protocol-Version", version, false),
             mismatch (req, "Mcp-Method", method, false),
             mismatch (req, "Mcp-Name", name, true),
             mismatch (req, "Mcp-Param-Region", region, true) }) {
            if (found) {
                return found;
            }
        }
        return std::nullopt;
    }

    static void answer (const httplib::Request& req, httplib::Response& res) {
        const auto call = nlohmann::json::parse (req.body, nullptr, false);
        const nlohmann::json id =
        call.is_object () ? call.value ("id", nlohmann::json ()) : nlohmann::json ();
        if (!call.is_object ()) {
            res.status = 400;
            res.set_content (
            nlohmann::json{ { "jsonrpc", "2.0" }, { "id", id },
            { "error", { { "code", -32700 }, { "message", "Parse error" } } } }
            .dump (),
            "application/json");
            return;
        }
        if (const auto reason = header_mismatch (req, call)) {
            res.status = 400;
            res.set_content (
            nlohmann::json{ { "jsonrpc", "2.0" }, { "id", id },
            { "error", { { "code", -32020 }, { "message", "Header mismatch: " + *reason } } } }
            .dump (),
            "application/json");
            return;
        }
        res.set_content (
        nlohmann::json{ { "jsonrpc", "2.0" }, { "id", id },
        { "result", { { "content", { { { "type", "text" }, { "text", "ok" } } } }, { "isError", false } } } }
        .dump (),
        "application/json");
    }

    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    mutable std::mutex mutex_;
    httplib::Headers headers_;
};

} // namespace vayu::tests
