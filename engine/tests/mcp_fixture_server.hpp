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
 * plain `400` a legacy-era server answers a modern request with, or a `403`
 * naming the scope the token lacks.
 * `reply_in_turn` gives each call its own outcome from a list, for a run that
 * has to mix them.
 *
 * The tool it knows is `execute_sql`, whose `region` argument the schema
 * mirrors as `Mcp-Param-Region` (`execute_sql_tool_json`).
 *
 * The discovery and list methods an import reads (#3838) are answered from
 * what the test configures: `server/discover` (`discover_as`), `tools/list`
 * in pages (`set_tools`), `resources/list`, `resources/templates/list` and
 * `prompts/list`. Any other method keeps the `tools/call`-shaped answer above.
 * Every request is recorded (`calls`), so a test asserts the order of methods
 * and the cursors a client sent back.
 */

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
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
#include "vayu/utils/parse.hpp"

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
    /// A `403` whose `WWW-Authenticate` asks for `INSUFFICIENT_SCOPES` (#3795).
    InsufficientScope,
};

/// The scopes the fixture's `403 insufficient_scope` challenge names.
inline constexpr std::string_view INSUFFICIENT_SCOPES = "db:read db:write";

/// How the fixture answers `server/discover`.
enum class McpDiscovery : std::uint8_t {
    /// A result carrying `supportedVersions`, `capabilities` and `serverInfo`.
    Modern,
    /// JSON-RPC `-32601` in a `200`, as a legacy server that knows no such method.
    MethodNotFound,
    /// The plain-text `400` a legacy-era server answers a modern request with.
    LegacyBadRequest,
};

/// One request the fixture received, in arrival order.
struct McpRecordedCall {
    /// The body's `method`, empty when the body was not a JSON-RPC object.
    std::string method;
    /// The body's `params.cursor`, absent when none was sent.
    std::optional<std::string> cursor;
    /// The `Authorization` header as sent, absent when none was.
    std::optional<std::string> authorization;
    /// The body as sent.
    std::string body;
};

/// The version the fixture's `server/discover` result names.
inline constexpr std::string_view MCP_DISCOVER_VERSION = "2026-07-28";

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
            const std::size_t call  = requests_++;
            const Settings settings = record (req, call);
            answer (req, res, settings);
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

    int port () const {
        return port_;
    }

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/mcp";
    }

    void reply_with (McpReplyShape shape, McpReplyOutcome outcome = McpReplyOutcome::Result) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.shape   = shape;
        settings_.outcome = outcome;
        settings_.turns.clear ();
    }

    /// How `server/discover` is answered; a modern result by default.
    void discover_as (McpDiscovery discovery) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.discovery = discovery;
    }

    /// The tools `tools/list` answers, @p page_size to a page. A page that
    /// leaves tools behind carries `nextCursor`; 0 answers every tool in one
    /// page with none. A cursor the fixture did not issue is a `-32602`.
    void set_tools (nlohmann::json tools, std::size_t page_size = 0) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.tools           = std::move (tools);
        settings_.tools_page_size = page_size;
    }

    /// Answers the `tools/list` that sends no cursor as an event stream whose
    /// last frame carries the result; later pages stay one JSON object.
    void first_tools_page_as_event_stream (bool on = true) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.first_tools_page_stream = on;
    }

    /// Answers a `tools/list` page asked for by a cursor with that same cursor
    /// as its `nextCursor`, as a server stuck on one page would; the first
    /// page names the second as usual.
    void repeat_tools_cursor (bool on = true) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.repeat_tools_cursor = on;
    }

    /// What `resources/list` answers; one page, no cursor.
    void set_resources (nlohmann::json resources) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.resources = std::move (resources);
    }

    /// What `resources/templates/list` answers; one page, no cursor.
    void set_resource_templates (nlohmann::json templates) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.resource_templates = std::move (templates);
    }

    /// What `prompts/list` answers; one page, no cursor.
    void set_prompts (nlohmann::json prompts) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.prompts = std::move (prompts);
    }

    /// The n-th call from now on answered with @p turns `[n % size]`, so a
    /// run's mix of outcomes is exact whatever order its calls arrive in.
    void reply_in_turn (McpReplyShape shape, std::vector<McpReplyOutcome> turns) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.shape      = shape;
        settings_.turns      = std::move (turns);
        settings_.turns_from = requests_.load ();
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

    /// Every request received, in arrival order.
    std::vector<McpRecordedCall> calls () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return calls_;
    }

    /// The `method` of every request received, in arrival order.
    std::vector<std::string> methods () const {
        std::vector<std::string> methods;
        for (const auto& call : calls ()) {
            methods.push_back (call.method);
        }
        return methods;
    }

    /// The `params.cursor` of every `tools/list` received, in arrival order;
    /// nothing for a request that sent none.
    std::vector<std::optional<std::string>> tools_list_cursors () const {
        std::vector<std::optional<std::string>> cursors;
        for (const auto& call : calls ()) {
            if (call.method == "tools/list") {
                cursors.push_back (call.cursor);
            }
        }
        return cursors;
    }

    private:
    /// What a test configured, copied out per request so an answer reads one
    /// consistent set while the test may reconfigure.
    struct Settings {
        McpReplyShape shape     = McpReplyShape::Json;
        McpReplyOutcome outcome = McpReplyOutcome::Result;
        std::vector<McpReplyOutcome> turns;
        std::size_t turns_from            = 0; // the call turns[0] answers
        McpDiscovery discovery            = McpDiscovery::Modern;
        nlohmann::json tools              = nlohmann::json::array ();
        std::size_t tools_page_size       = 0;
        bool first_tools_page_stream      = false;
        bool repeat_tools_cursor          = false;
        nlohmann::json resources          = nlohmann::json::array ();
        nlohmann::json resource_templates = nlohmann::json::array ();
        nlohmann::json prompts            = nlohmann::json::array ();
    };

    static constexpr std::string_view CURSOR_PREFIX   = "cursor-";
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
        case McpReplyOutcome::InsufficientScope:
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

    static nlohmann::json result_frame (const nlohmann::json& id, nlohmann::json result) {
        return { { "jsonrpc", "2.0" }, { "id", id }, { "result", std::move (result) } };
    }

    static nlohmann::json
    error_frame (const nlohmann::json& id, int code, const std::string& message) {
        return { { "jsonrpc", "2.0" }, { "id", id },
            { "error", { { "code", code }, { "message", message } } } };
    }

    static void send_error (httplib::Response& res,
    const nlohmann::json& id,
    int status,
    int code,
    const std::string& message) {
        res.status = status;
        res.set_content (error_frame (id, code, message).dump (), "application/json");
    }

    static nlohmann::json discover_result () {
        return { { "supportedVersions", nlohmann::json::array ({ MCP_DISCOVER_VERSION }) },
            { "capabilities",
            { { "tools", nlohmann::json::object () }, { "resources", nlohmann::json::object () },
            { "prompts", nlohmann::json::object () } } },
            { "serverInfo", { { "name", "vayu-fixture" }, { "version", "1.0.0" } } } };
    }

    static std::string cursor_at (std::size_t offset) {
        return std::string (CURSOR_PREFIX) + std::to_string (offset);
    }

    /// Where the page a @p cursor names starts, or nothing when the fixture
    /// never issued it.
    static std::optional<std::size_t>
    cursor_offset (const std::string& cursor, std::size_t total, std::size_t page_size) {
        if (page_size == 0 || !cursor.starts_with (CURSOR_PREFIX)) {
            return std::nullopt;
        }
        const auto offset = vayu::utils::parse_number<std::size_t> (
        std::string_view (cursor).substr (CURSOR_PREFIX.size ()));
        if (!offset || *offset == 0 || *offset >= total || *offset % page_size != 0) {
            return std::nullopt;
        }
        return offset;
    }

    static nlohmann::json tools_page_frame (const nlohmann::json& call,
    const nlohmann::json& id,
    const Settings& settings) {
        const std::size_t total = settings.tools.size ();
        std::size_t offset      = 0;
        const auto cursor =
        string_at (call, nlohmann::json::json_pointer ("/params/cursor"));
        if (cursor) {
            const auto start = cursor_offset (*cursor, total, settings.tools_page_size);
            if (!start) {
                return error_frame (id, -32602, "Invalid cursor: " + *cursor);
            }
            offset = *start;
        }
        const std::size_t end = settings.tools_page_size == 0 ?
        total :
        std::min (total, offset + settings.tools_page_size);
        nlohmann::json page   = nlohmann::json::array ();
        for (std::size_t at = offset; at < end; ++at) {
            page.push_back (settings.tools.at (at));
        }
        nlohmann::json result{ { "tools", std::move (page) } };
        if (cursor && settings.repeat_tools_cursor) {
            result["nextCursor"] = *cursor;
        } else if (end < total) {
            result["nextCursor"] = cursor_at (end);
        }
        return result_frame (id, std::move (result));
    }

    /// The answer to a discovery or list method the fixture knows, or nothing
    /// for any other method.
    static std::optional<nlohmann::json> known_method_frame (
    const std::optional<std::string>& method,
    const nlohmann::json& call,
    const nlohmann::json& id,
    const Settings& settings) {
        if (method == "server/discover") {
            return std::make_optional (result_frame (id, discover_result ()));
        }
        if (method == "tools/list") {
            return std::make_optional (tools_page_frame (call, id, settings));
        }
        if (method == "resources/list") {
            return std::make_optional (
            result_frame (id, { { "resources", settings.resources } }));
        }
        if (method == "resources/templates/list") {
            return std::make_optional (result_frame (
            id, { { "resourceTemplates", settings.resource_templates } }));
        }
        if (method == "prompts/list") {
            return std::make_optional (
            result_frame (id, { { "prompts", settings.prompts } }));
        }
        return std::nullopt;
    }

    static McpReplyShape known_method_shape (const std::optional<std::string>& method,
    const nlohmann::json& call,
    const Settings& settings) {
        const bool first_tools_page = method == "tools/list" &&
        !string_at (call, nlohmann::json::json_pointer ("/params/cursor"));
        return first_tools_page && settings.first_tools_page_stream ?
        McpReplyShape::EventStream :
        McpReplyShape::Json;
    }

    /// Answers a legacy-era refusal that needs no look at the body; true when it did.
    static bool refuse_before_parsing (httplib::Response& res, McpReplyOutcome outcome) {
        if (outcome == McpReplyOutcome::LegacyBadRequest) {
            res.status = 400;
            res.set_content ("Bad Request: No valid session ID provided", "text/plain");
            return true;
        }
        if (outcome == McpReplyOutcome::InsufficientScope) {
            res.status = 403;
            res.set_header ("WWW-Authenticate",
            "Bearer error=\"insufficient_scope\", scope=\"" +
            std::string (INSUFFICIENT_SCOPES) + "\"");
            res.set_content ("Forbidden", "text/plain");
            return true;
        }
        return false;
    }

    /// Answers `server/discover` as a legacy server would; false when the
    /// fixture is to answer it as a modern one.
    static bool refuse_discovery (httplib::Response& res,
    const nlohmann::json& id,
    McpDiscovery discovery) {
        if (discovery == McpDiscovery::MethodNotFound) {
            res.set_content (error_frame (id, -32601, "Method not found").dump (),
            "application/json");
            return true;
        }
        if (discovery == McpDiscovery::LegacyBadRequest) {
            res.status = 400;
            res.set_content ("Bad Request: No valid session ID provided", "text/plain");
            return true;
        }
        return false;
    }

    static std::optional<std::string>
    body_string (const nlohmann::json& body, const char* at) {
        return body.is_object () ?
        string_at (body, nlohmann::json::json_pointer (at)) :
        std::nullopt;
    }

    static McpRecordedCall recorded_call (const httplib::Request& req) {
        const auto body = nlohmann::json::parse (req.body, nullptr, false);
        McpRecordedCall call;
        call.method = body_string (body, "/method").value_or ("");
        call.cursor = body_string (body, "/params/cursor");
        call.body   = req.body;
        if (req.has_header ("Authorization")) {
            call.authorization = req.get_header_value ("Authorization");
        }
        return call;
    }

    /// Notes the request and answers the settings it is to be answered by.
    Settings record (const httplib::Request& req, std::size_t call) {
        std::lock_guard<std::mutex> lock (mutex_);
        headers_ = req.headers;
        calls_.push_back (recorded_call (req));
        Settings settings = settings_;
        if (!settings.turns.empty ()) {
            settings.outcome = settings.turns.at (
            (call - settings.turns_from) % settings.turns.size ());
        }
        return settings;
    }

    static void
    answer (const httplib::Request& req, httplib::Response& res, const Settings& settings) {
        if (refuse_before_parsing (res, settings.outcome)) {
            return;
        }
        const auto call = nlohmann::json::parse (req.body, nullptr, false);
        const nlohmann::json id =
        call.is_object () ? call.value ("id", nlohmann::json ()) : nlohmann::json ();
        if (!call.is_object ()) {
            send_error (res, id, 400, -32700, "Parse error");
            return;
        }
        const auto method = string_at (call, nlohmann::json::json_pointer ("/method"));
        if (method == "server/discover" && refuse_discovery (res, id, settings.discovery)) {
            return;
        }
        if (const auto reason = header_mismatch (req, call)) {
            send_error (res, id, 400, -32020, "Header mismatch: " + *reason);
            return;
        }
        if (settings.outcome == McpReplyOutcome::Result) {
            if (const auto known = known_method_frame (method, call, id, settings)) {
                send_frame (res, *known, known_method_shape (method, call, settings));
                return;
            }
        }
        if (settings.outcome == McpReplyOutcome::UnsupportedVersion) {
            res.status = 400;
        }
        send_frame (res, response_frame (id, settings.outcome), settings.shape);
    }

    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    mutable std::mutex mutex_;
    httplib::Headers headers_;
    Settings settings_;
    std::vector<McpRecordedCall> calls_;
    std::atomic<std::size_t> requests_{ 0 };
};

} // namespace vayu::tests
