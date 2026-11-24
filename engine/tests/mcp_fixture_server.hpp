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
 * `tools/call`-shaped result whose text is `MCP_RESULT_TEXT`.
 *
 * `reply_with` chooses how that answer arrives - one JSON object, a
 * request-scoped event stream of two progress notifications and then the
 * response, or that stream cut before the response - and what it says: the
 * result, a tool error, a JSON-RPC error, a `-32022` version refusal, or the
 * plain `400` a legacy-era server answers a modern request with.
 * `reply_in_turn` gives each call its own outcome from a list, for a run that
 * has to mix them.
 *
 * The tool it knows is `execute_sql`, whose `region` argument the schema
 * mirrors as `Mcp-Param-Region` (`execute_sql_tool_json`).
 */

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

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

/// The text of the fixture's successful tool result.
inline constexpr std::string_view MCP_RESULT_TEXT = "42 rows";

/// How the fixture's answer to an accepted call arrives.
enum class McpReplyShape : std::uint8_t {
    Json,
    /// Two progress notifications, then the response.
    EventStream,
    /// The two notifications, and the stream ends there.
    EventStreamCut,
};

/// What the fixture's answer to an accepted call says.
enum class McpReplyOutcome : std::uint8_t {
    Result,
    ToolError,
    RpcError,
    UnsupportedVersion,
    LegacyBadRequest,
};

class McpFixtureServer {
    public:
    McpFixtureServer () {
        svr_.new_task_queue = pooled_task_queue (2);
        // One call per connection: a load run's event loop keeps a connection
        // per worker (one per core), and an idle kept-alive one holds a pool
        // thread until httplib's keep-alive timeout, which starves the next
        // worker's call into its request timeout on a box with more cores
        // than threads.
        svr_.set_keep_alive_max_count (1);
        svr_.Post ("/mcp", [this] (const httplib::Request& req, httplib::Response& res) {
            McpReplyShape shape     = McpReplyShape::Json;
            McpReplyOutcome outcome = McpReplyOutcome::Result;
            const std::size_t call  = requests_++;
            {
                std::lock_guard<std::mutex> lock (mutex_);
                headers_ = req.headers;
                shape    = shape_;
                outcome  = turns_.empty () ?
                outcome_ :
                turns_.at ((call - turns_from_) % turns_.size ());
            }
            answer (req, res, shape, outcome);
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

    void reply_with (McpReplyShape shape, McpReplyOutcome outcome = McpReplyOutcome::Result) {
        std::lock_guard<std::mutex> lock (mutex_);
        shape_   = shape;
        outcome_ = outcome;
        turns_.clear ();
    }

    /// The n-th call from now on answered with @p turns `[n % size]`, so a
    /// run's mix of outcomes is exact whatever order its calls arrive in.
    void reply_in_turn (McpReplyShape shape, std::vector<McpReplyOutcome> turns) {
        std::lock_guard<std::mutex> lock (mutex_);
        shape_      = shape;
        turns_      = std::move (turns);
        turns_from_ = requests_.load ();
    }

    /// Calls answered so far.
    std::size_t requests () const {
        return requests_.load ();
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

    static nlohmann::json response_frame (const nlohmann::json& id, McpReplyOutcome outcome) {
        nlohmann::json frame{ { "jsonrpc", "2.0" }, { "id", id } };
        switch (outcome) {
        case McpReplyOutcome::ToolError:
            frame["result"] = { { "content",
                                { { { "type", "text" },
                                { "text", "relation \"orders\" does not exist" } } } },
                { "isError", true } };
            break;
        case McpReplyOutcome::RpcError:
            frame["error"] = { { "code", -32602 }, { "message", "Unknown tool: execute_sql" } };
            break;
        case McpReplyOutcome::UnsupportedVersion:
            frame["error"] = { { "code", -32022 },
                { "message", "Unsupported protocol version" },
                { "data",
                { { "supported", { "2025-11-25", "2025-06-18" } },
                { "requested", "2026-07-28" } } } };
            break;
        case McpReplyOutcome::Result:
        case McpReplyOutcome::LegacyBadRequest:
            frame["result"] = { { "content",
                                { { { "type", "text" }, { "text", MCP_RESULT_TEXT } } } },
                { "isError", false } };
            break;
        }
        return frame;
    }

    static std::string progress_event (int progress) {
        const nlohmann::json note{ { "jsonrpc", "2.0" },
            { "method", "notifications/progress" },
            { "params",
            { { "progressToken", "p1" }, { "progress", progress }, { "total", 2 } } } };
        return "event: message\ndata: " + note.dump () + "\n\n";
    }

    static void send_frame (httplib::Response& res, const nlohmann::json& frame, McpReplyShape shape) {
        if (shape == McpReplyShape::Json) {
            res.set_content (frame.dump (), "application/json");
            return;
        }
        std::string stream = progress_event (1) + progress_event (2);
        if (shape == McpReplyShape::EventStream) {
            stream += "event: message\ndata: " + frame.dump () + "\n\n";
        }
        res.set_content (stream, "text/event-stream");
    }

    static void answer (const httplib::Request& req,
    httplib::Response& res,
    McpReplyShape shape,
    McpReplyOutcome outcome) {
        if (outcome == McpReplyOutcome::LegacyBadRequest) {
            res.status = 400;
            res.set_content ("Bad Request: No valid session ID provided", "text/plain");
            return;
        }
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
        if (outcome == McpReplyOutcome::UnsupportedVersion) {
            res.status = 400;
        }
        send_frame (res, response_frame (id, outcome), shape);
    }

    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    mutable std::mutex mutex_;
    httplib::Headers headers_;
    McpReplyShape shape_     = McpReplyShape::Json;
    McpReplyOutcome outcome_ = McpReplyOutcome::Result;
    std::vector<McpReplyOutcome> turns_;
    std::size_t turns_from_ = 0; // the call turns_[0] answers
    std::atomic<std::size_t> requests_{ 0 };
};

} // namespace vayu::tests
