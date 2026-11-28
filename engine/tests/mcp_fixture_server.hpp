#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file mcp_fixture_server.hpp
 * @brief An in-process MCP endpoint, modern-era unless `speak_legacy` says
 *        otherwise, that checks a POST's headers against its body the way the
 *        specification makes a server check them (#3762).
 *
 * Written from the specification's server-side rules, never from the engine's
 * derivation, so a header the engine stops deriving, or derives wrongly, is
 * answered `400` with JSON-RPC code `-32020` (HeaderMismatch) exactly as a real
 * server would answer it. A request that passes is answered `200` with a
 * `tools/call`-shaped result whose text is `MCP_RESULT_TEXT`.
 *
 * `reply_with` chooses how that answer arrives - one JSON object, a
 * request-scoped event stream of two progress notifications and then the
 * response, that stream cut before the response, or progress notifications
 * that never end - and what it says: the result, a tool error, a JSON-RPC
 * error, a `-32022` version refusal, the plain `400` a legacy-era server
 * answers a modern request with, or a `403` naming the scope the token lacks.
 * `reply_in_turn` gives each call its own outcome from a list, for a run that
 * has to mix them, and `delay_tool` holds every call of one tool back, for a
 * run whose tools have to differ in latency.
 *
 * The tool it knows is `execute_sql`, whose `region` argument the schema
 * mirrors as `Mcp-Param-Region` (`execute_sql_tool_json`).
 *
 * The discovery and list methods an import reads (#3838) are answered from
 * what the test configures: `server/discover` (`discover_as`), `tools/list`,
 * `resources/list` and `prompts/list` in pages (`set_tools` and its kin), and
 * `resources/templates/list` in one. Any other method keeps the `tools/call`-shaped answer above.
 * Every request is recorded (`calls`), so a test asserts the order of methods
 * and the cursors a client sent back.
 *
 * `speak_legacy` turns it into a legacy-era server (#3840), checked by that
 * era's rules instead of the header-against-body ones: `initialize` negotiates
 * `MCP_LEGACY_FIXTURE_VERSION` and issues a fresh `Mcp-Session-Id`, every later
 * POST and the `DELETE` that ends the session must carry a live one and that
 * version, and anything else is the plain `400` (so `server/discover` gets it,
 * unless `discover_as` picks the JSON-RPC `400` a reference SDK server sends, #3989).
 * `hang_method` receives a method's requests and never answers them, for a
 * client whose own bound is under test; `delay_cursor_pages` and
 * `hang_cursor_pages` hold back a list's later pages alone (#3824).
 */

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <set>
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
    /// Progress notifications until the client hangs up; the response never
    /// comes, so only a cap can end the stream (#3831).
    EventStreamEndless,
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
    /// JSON-RPC `-32601` in a `200`, as a modern-era server with no such method
    /// answers it.
    MethodNotFound,
    /// The same `-32601`, under a `400`: still a modern server's answer (#3989).
    MethodNotFoundBadRequest,
    /// The plain-text `400` a legacy-era server answers a modern request with.
    LegacyBadRequest,
    /// The TypeScript SDK's refusal of a session-less POST: `400`, JSON-RPC
    /// `-32000`, `id: null` (#3989).
    LegacyTypeScriptSessionRequired,
    /// The Python SDK's: `400`, JSON-RPC `INVALID_REQUEST` (`-32600`),
    /// `id: "server-error"` (#3989).
    LegacyPythonInvalidRequest,
};

/// One request the fixture received, in arrival order.
struct McpRecordedCall {
    /// The HTTP method: `POST`, or `DELETE` for a session's end.
    std::string verb;
    /// The body's `method`, empty when the body was not a JSON-RPC object.
    std::string method;
    /// The `Mcp-Session-Id` header as sent, absent when none was.
    std::optional<std::string> session_id;
    /// The `MCP-Protocol-Version` header as sent, absent when none was.
    std::optional<std::string> protocol_version;
    /// The body's `params.cursor`, absent when none was sent.
    std::optional<std::string> cursor;
    /// The `Authorization` header as sent, absent when none was.
    std::optional<std::string> authorization;
    /// The body as sent.
    std::string body;
};

/// The version the fixture's `server/discover` result names.
inline constexpr std::string_view MCP_DISCOVER_VERSION = "2026-07-28";

/// The version a legacy-era fixture's `initialize` negotiates, whatever the
/// client offered, and every later request of the session must name.
inline constexpr std::string_view MCP_LEGACY_FIXTURE_VERSION = "2025-06-18";

/// The `serverInfo.name` a legacy-era fixture's `initialize` answers.
inline constexpr std::string_view MCP_LEGACY_FIXTURE_NAME =
"vayu-legacy-fixture";

/// How a legacy-era fixture keeps sessions.
enum class McpLegacySessions : std::uint8_t {
    /// `initialize` issues an `Mcp-Session-Id` every later request must carry.
    Issued,
    /// `initialize` issues none and no request is asked for one.
    Stateless,
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
            const std::size_t call = requests_++;
            if (const auto delay = delay_for (req.body); delay.count () > 0) {
                std::this_thread::sleep_for (delay);
            }
            const Settings settings = record (req, call);
            if (is_hung (settings, req.body)) {
                hold_until_stopped ();
                return;
            }
            if (const auto legacy = settings.legacy) {
                answer_legacy (req, res, settings, *legacy);
                return;
            }
            answer (req, res, settings);
        });
        svr_.Delete ("/mcp", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::size_t call  = requests_++;
            const Settings settings = record (req, call);
            end_session (req, res, settings);
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~McpFixtureServer () {
        stopping_.store (true);
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

    /// Answers as a legacy-era server from now on (#3840); the list methods
    /// keep answering what `set_tools` and its kin configured. With
    /// @p names_version false, `initialize`'s result names no `protocolVersion`.
    void speak_legacy (McpLegacySessions sessions = McpLegacySessions::Issued,
    bool names_version                            = true) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.legacy               = sessions;
        settings_.legacy_names_version = names_version;
    }

    /// Every request for @p method from now on is received and recorded and
    /// never answered, until the fixture stops.
    void hang_method (std::string method) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.hung_methods.insert (std::move (method));
    }

    /// Answers @p method with JSON-RPC `-32601` in a `200`, as a modern-era
    /// server that does not implement it would (the modern path only).
    void leave_out_method (std::string method) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.unimplemented_methods.insert (std::move (method));
    }

    /// The session ids issued and not yet ended by a `DELETE`.
    std::set<std::string> live_sessions () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return live_sessions_;
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

    /// What `resources/list` answers, @p page_size to a page as `set_tools`
    /// pages its list.
    void set_resources (nlohmann::json resources, std::size_t page_size = 0) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.resources           = std::move (resources);
        settings_.resources_page_size = page_size;
    }

    /// What `resources/templates/list` answers; one page, no cursor.
    void set_resource_templates (nlohmann::json templates) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.resource_templates = std::move (templates);
    }

    /// What `prompts/list` answers, @p page_size to a page as `set_tools`
    /// pages its list.
    void set_prompts (nlohmann::json prompts, std::size_t page_size = 0) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.prompts           = std::move (prompts);
        settings_.prompts_page_size = page_size;
    }

    /// The n-th call from now on answered with @p turns `[n % size]`, so a
    /// run's mix of outcomes is exact whatever order its calls arrive in.
    void reply_in_turn (McpReplyShape shape, std::vector<McpReplyOutcome> turns) {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.shape      = shape;
        settings_.turns      = std::move (turns);
        settings_.turns_from = requests_.load ();
    }

    /// Every `tools/call` of @p tool from now on answered @p delay late.
    void delay_tool (std::string tool, std::chrono::milliseconds delay) {
        std::lock_guard<std::mutex> lock (mutex_);
        tool_delays_[std::move (tool)] = delay;
    }

    /// Every request carrying a `params.cursor` from now on answered @p delay
    /// late, for a step whose later list pages have to take measurable time.
    void delay_cursor_pages (std::chrono::milliseconds delay) {
        std::lock_guard<std::mutex> lock (mutex_);
        cursor_page_delay_ = delay;
    }

    /// Every request carrying a `params.cursor` from now on is received and
    /// recorded and never answered, until the fixture stops.
    void hang_cursor_pages () {
        std::lock_guard<std::mutex> lock (mutex_);
        settings_.hang_cursor_pages = true;
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
        std::size_t resources_page_size   = 0;
        nlohmann::json resource_templates = nlohmann::json::array ();
        nlohmann::json prompts            = nlohmann::json::array ();
        std::size_t prompts_page_size     = 0;
        /// Set by `speak_legacy`: the legacy era's rules answer every call.
        std::optional<McpLegacySessions> legacy;
        bool legacy_names_version = true;
        std::set<std::string> hung_methods;
        bool hang_cursor_pages = false;
        std::set<std::string> unimplemented_methods;
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

    /// How long `delay_tool` or `delay_cursor_pages` holds back the call
    /// @p body makes.
    std::chrono::milliseconds delay_for (const std::string& body) const {
        const auto call = nlohmann::json::parse (body, nullptr, false);
        if (call.is_object () &&
        string_at (call, nlohmann::json::json_pointer ("/params/cursor"))) {
            std::lock_guard<std::mutex> lock (mutex_);
            return cursor_page_delay_;
        }
        if (!call.is_object () ||
        string_at (call, nlohmann::json::json_pointer ("/method")) != "tools/call") {
            return std::chrono::milliseconds{ 0 };
        }
        const auto tool = string_at (call, nlohmann::json::json_pointer ("/params/name"));
        std::lock_guard<std::mutex> lock (mutex_);
        const auto found = tool ? tool_delays_.find (*tool) : tool_delays_.end ();
        return found == tool_delays_.end () ? std::chrono::milliseconds{ 0 } :
                                              found->second;
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

    /// The pause between an endless stream's notifications, which only paces
    /// the writes; no assertion reads it.
    static constexpr std::chrono::milliseconds ENDLESS_EVENT_PACE{ 5 };

    /// A progress notification; @p total absent, as on an endless stream.
    static std::string progress_event (int progress, std::optional<int> total = 2) {
        nlohmann::json params{ { "progressToken", "p1" }, { "progress", progress } };
        if (total) {
            params["total"] = *total;
        }
        const nlohmann::json note{ { "jsonrpc", "2.0" },
            { "method", "notifications/progress" }, { "params", params } };
        return "event: message\ndata: " + note.dump () + "\n\n";
    }

    /// Ends when a write fails, which is the client hanging up, or when the
    /// fixture stops.
    void stream_endlessly (httplib::Response& res) const {
        res.set_chunked_content_provider (
        "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
            for (int progress = 1; !stopping_.load (); ++progress) {
                const std::string note = progress_event (progress, std::nullopt);
                if (!sink.write (note.data (), note.size ())) {
                    return false;
                }
                std::this_thread::sleep_for (ENDLESS_EVENT_PACE);
            }
            sink.done ();
            return true;
        });
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

    /// One list's paging, as a list method's answer reads it.
    struct PagedList {
        const char* key             = "";
        const nlohmann::json* items = nullptr;
        std::size_t page_size       = 0;
        bool repeat_cursor          = false;
    };

    /// The page of @p list the call's `params.cursor` names, the first when it
    /// names none.
    static nlohmann::json list_page_frame (const nlohmann::json& call,
    const nlohmann::json& id,
    const PagedList& list) {
        const std::size_t total = list.items->size ();
        std::size_t offset      = 0;
        const auto cursor =
        string_at (call, nlohmann::json::json_pointer ("/params/cursor"));
        if (cursor) {
            const auto start = cursor_offset (*cursor, total, list.page_size);
            if (!start) {
                return error_frame (id, -32602, "Invalid cursor: " + *cursor);
            }
            offset = *start;
        }
        const std::size_t end =
        list.page_size == 0 ? total : (std::min)(total, offset + list.page_size);
        nlohmann::json page = nlohmann::json::array ();
        for (std::size_t at = offset; at < end; ++at) {
            page.push_back (list.items->at (at));
        }
        nlohmann::json result{ { list.key, std::move (page) } };
        if (cursor && list.repeat_cursor) {
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
            return std::make_optional (list_page_frame (call, id,
            { "tools", &settings.tools, settings.tools_page_size, settings.repeat_tools_cursor }));
        }
        if (method == "resources/list") {
            return std::make_optional (list_page_frame (call, id,
            { "resources", &settings.resources, settings.resources_page_size, false }));
        }
        if (method == "resources/templates/list") {
            return std::make_optional (result_frame (
            id, { { "resourceTemplates", settings.resource_templates } }));
        }
        if (method == "prompts/list") {
            return std::make_optional (list_page_frame (call, id,
            { "prompts", &settings.prompts, settings.prompts_page_size, false }));
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
        switch (discovery) {
        case McpDiscovery::Modern: return false;
        case McpDiscovery::MethodNotFound:
            send_error (res, id, 200, -32601, "Method not found");
            return true;
        case McpDiscovery::MethodNotFoundBadRequest:
            send_error (res, id, 400, -32601, "Method not found");
            return true;
        case McpDiscovery::LegacyBadRequest:
            res.status = 400;
            res.set_content ("Bad Request: No valid session ID provided", "text/plain");
            return true;
        case McpDiscovery::LegacyTypeScriptSessionRequired:
            send_error (res, nullptr, 400, -32000,
            "Bad Request: Mcp-Session-Id header is required");
            return true;
        case McpDiscovery::LegacyPythonInvalidRequest:
            send_error (res, "server-error", 400, -32600, "Bad Request: Missing session ID");
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
        call.verb   = req.method;
        call.method = body_string (body, "/method").value_or ("");
        if (req.has_header ("Mcp-Session-Id")) {
            call.session_id = req.get_header_value ("Mcp-Session-Id");
        }
        if (req.has_header ("MCP-Protocol-Version")) {
            call.protocol_version =
            req.get_header_value ("MCP-Protocol-Version");
        }
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

    /// How often a hung request looks for the fixture stopping.
    static constexpr std::chrono::milliseconds HOLD_POLL{ 5 };

    static bool is_hung (const Settings& settings, const std::string& body) {
        const auto call   = nlohmann::json::parse (body, nullptr, false);
        const auto method = body_string (call, "/method");
        if (settings.hang_cursor_pages && body_string (call, "/params/cursor")) {
            return true;
        }
        return method && settings.hung_methods.contains (*method);
    }

    void hold_until_stopped () const {
        while (!stopping_.load ()) {
            std::this_thread::sleep_for (HOLD_POLL);
        }
    }

    void answer (const httplib::Request& req, httplib::Response& res, const Settings& settings) const {
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
        if (method && settings.unimplemented_methods.contains (*method)) {
            send_error (res, id, 200, -32601, "Method not found");
            return;
        }
        if (settings.shape == McpReplyShape::EventStreamEndless) {
            stream_endlessly (res);
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

    static constexpr std::string_view SESSION_HEADER = "Mcp-Session-Id";

    static void refuse_plainly (httplib::Response& res, int status, std::string_view text) {
        res.status = status;
        res.set_content (std::string (text), "text/plain");
    }

    /// `initialize`: the session opened, when the fixture issues them.
    void open_session (httplib::Response& res,
    const nlohmann::json& call,
    const nlohmann::json& id,
    const Settings& settings,
    McpLegacySessions sessions) {
        if (!string_at (call, nlohmann::json::json_pointer ("/params/protocolVersion"))) {
            send_error (res, id, 400, -32602, "initialize names no protocolVersion");
            return;
        }
        if (sessions == McpLegacySessions::Issued) {
            std::lock_guard<std::mutex> lock (mutex_);
            const std::string session =
            "legacy-session-" + std::to_string (++sessions_issued_);
            live_sessions_.insert (session);
            res.set_header (std::string (SESSION_HEADER), session);
        }
        nlohmann::json result{ { "capabilities",
                               { { "tools", nlohmann::json::object () },
                               { "resources", nlohmann::json::object () },
                               { "prompts", nlohmann::json::object () } } },
            { "serverInfo", { { "name", MCP_LEGACY_FIXTURE_NAME }, { "version", "1.0.0" } } } };
        if (settings.legacy_names_version) {
            result["protocolVersion"] = MCP_LEGACY_FIXTURE_VERSION;
        }
        res.set_content (result_frame (id, result).dump (), "application/json");
    }

    static constexpr std::string_view UNSUPPORTED_VERSION_TEXT =
    "Bad Request: Unsupported protocol version";

    /// Whether @p req carries the version `initialize` negotiated; a server
    /// whose `initialize` named none negotiated none to hold a request to.
    static bool carries_negotiated_version (const httplib::Request& req,
    const Settings& settings) {
        return !settings.legacy_names_version ||
        req.get_header_value ("MCP-Protocol-Version") == MCP_LEGACY_FIXTURE_VERSION;
    }

    /// Why a legacy-era server refuses @p req, a request after `initialize`,
    /// as a status and the plain text it answers; nothing when it is accepted.
    std::optional<std::pair<int, std::string_view>> legacy_refusal (
    const httplib::Request& req,
    const Settings& settings,
    McpLegacySessions sessions) const {
        if (sessions == McpLegacySessions::Issued) {
            if (!req.has_header (std::string (SESSION_HEADER))) {
                return std::make_pair (400, "Bad Request: No valid session ID provided");
            }
            std::lock_guard<std::mutex> lock (mutex_);
            if (!live_sessions_.contains (
                req.get_header_value (std::string (SESSION_HEADER)))) {
                return std::make_pair (404, "Session not found");
            }
        }
        if (!carries_negotiated_version (req, settings)) {
            return std::make_pair (400, UNSUPPORTED_VERSION_TEXT);
        }
        return std::nullopt;
    }

    void answer_legacy (const httplib::Request& req,
    httplib::Response& res,
    const Settings& settings,
    McpLegacySessions sessions) {
        const std::string accept = req.get_header_value ("Accept");
        if (accept.find ("application/json") == std::string::npos ||
        accept.find ("text/event-stream") == std::string::npos) {
            refuse_plainly (res,
            406, "Not Acceptable: Client must accept both application/json and text/event-stream");
            return;
        }
        const auto call = nlohmann::json::parse (req.body, nullptr, false);
        if (!call.is_object ()) {
            send_error (res, nullptr, 400, -32700, "Parse error");
            return;
        }
        const nlohmann::json id = call.value ("id", nlohmann::json ());
        const auto method = string_at (call, nlohmann::json::json_pointer ("/method"));
        if (method == "initialize") {
            open_session (res, call, id, settings, sessions);
            return;
        }
        if (method == "server/discover" && refuse_discovery (res, id, settings.discovery)) {
            return;
        }
        if (const auto refusal = legacy_refusal (req, settings, sessions)) {
            refuse_plainly (res, refusal->first, refusal->second);
            return;
        }
        if (!call.contains ("id")) {
            res.status = 202; // A notification is accepted with no body.
            return;
        }
        if (method == "server/discover") {
            send_error (res, id, 200, -32601, "Method not found");
            return;
        }
        if (const auto known = known_method_frame (method, call, id, settings)) {
            send_frame (res, *known, McpReplyShape::Json);
            return;
        }
        send_frame (res, response_frame (id, McpReplyOutcome::Result), McpReplyShape::Json);
    }

    /// A `DELETE`: the session it names ended, when it names a live one and the
    /// negotiated version. The modern era and a stateless server have none,
    /// which is the `405` the specification allows.
    void end_session (const httplib::Request& req, httplib::Response& res, const Settings& settings) {
        if (settings.legacy != McpLegacySessions::Issued) {
            refuse_plainly (res, 405, "Method Not Allowed");
            return;
        }
        if (!req.has_header (std::string (SESSION_HEADER))) {
            refuse_plainly (res, 400, "Bad Request: No valid session ID provided");
            return;
        }
        if (!carries_negotiated_version (req, settings)) {
            refuse_plainly (res, 400, UNSUPPORTED_VERSION_TEXT);
            return;
        }
        std::lock_guard<std::mutex> lock (mutex_);
        if (live_sessions_.erase (req.get_header_value (std::string (SESSION_HEADER))) == 0) {
            refuse_plainly (res, 404, "Session not found");
            return;
        }
        res.status = 200;
    }

    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    mutable std::mutex mutex_;
    httplib::Headers headers_;
    Settings settings_;
    std::vector<McpRecordedCall> calls_;
    std::map<std::string, std::chrono::milliseconds> tool_delays_;
    std::chrono::milliseconds cursor_page_delay_{ 0 };
    std::set<std::string> live_sessions_;
    std::size_t sessions_issued_ = 0;
    std::atomic<std::size_t> requests_{ 0 };
    std::atomic<bool> stopping_{ false };
};

} // namespace vayu::tests
