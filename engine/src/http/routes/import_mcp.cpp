/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/import_mcp.cpp
 * @brief `POST /import/mcp` (#3838): import from a live MCP server - the calls
 *        that read what it offers. The tree they become is
 *        `core/mcp_import.hpp`'s; the handlers are registered beside the other
 *        import routes in `import.cpp`. `POST /import/mcp/diff` (#3842) reads
 *        the server through the same calls and compares the listing with the
 *        collections an earlier import of it built (`core/mcp_diff.hpp`), and
 *        `POST /import/mcp/apply` (#3994) writes the rows of that diff a
 *        caller selects to the collection.
 *
 * Every call goes through `vayu::http::Client` as an `mcp` body, so the
 * envelope, `_meta` and the derived headers are the ones a stored request
 * sends, the reply is read by the one reader (`read_mcp_reply`), and the
 * reserved-port guard and the transport policy apply as on any send.
 *
 * A legacy-era server (#3840) is the one place an `mcp` exchange falls back:
 * the import speaks its handshake itself, as full envelopes carrying the
 * session's headers, and generates the same handshake as requests, so a run
 * holds no session the collection does not show.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/mcp_diff.hpp"
#include "vayu/core/mcp_import.hpp"
#include "vayu/core/mcp_list_pages.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/mcp_body.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/ordered_json.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

// `<httplib.h>` brings in `<resolv.h>` on Linux and `<windows.h>` on Windows,
// and both define `DELETE` as a macro, which `HttpMethod::DELETE` cannot be
// spelled through.
#ifdef DELETE
#undef DELETE
#endif

namespace vayu::http::routes {

std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

/// The same import under the whole-import bounds a test names, so a refusal
/// at either is reached without waiting out or sending `TOTAL_TIMEOUT_MS` /
/// `MAX_TOTAL_BYTES`.
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel,
std::chrono::milliseconds total_timeout,
std::size_t max_total_bytes);

/// The client config and the request every call of an import of @p body is
/// sent under, for the wiring test; nothing for a refused body. The bounds are
/// not observable from a result on any test short enough to keep - a call's
/// is `CALL_TIMEOUT_MS` - so the assertion is on these (the
/// `import_fetch_client_config` precedent).
std::optional<std::pair<vayu::http::ClientConfig, vayu::Request>>
import_mcp_call_shape (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

std::pair<int, nlohmann::json> import_mcp_diff_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

std::pair<int, nlohmann::json> import_mcp_apply_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

namespace {

using ordered_json = nlohmann::ordered_json;
namespace limits   = vayu::core::constants::import_mcp;

template <typename T> using Refusable = std::expected<T, RouteError>;

constexpr std::int64_t METHOD_NOT_FOUND    = -32601;
constexpr std::int64_t UNSUPPORTED_VERSION = -32022;

/// Which primitives the caller asked for.
struct Include {
    bool tools     = true;
    bool resources = false;
    bool prompts   = false;
};

/// A validated body: the request every call is sent as, and what to read.
struct McpImportTarget {
    /// A POST to the server with the caller's headers and the bearer line.
    vayu::Request base;
    /// The caller's own headers, before the bearer line was added.
    std::vector<HeaderLine> caller_headers;
    bool bearer = false;
    Include include;
};

/// What one import may still spend, across every call it makes.
struct ImportBudget {
    std::chrono::steady_clock::time_point deadline;
    std::chrono::milliseconds total{ 0 };
    std::size_t max_bytes = 0;
    std::size_t bytes     = 0;
    std::size_t items     = 0;
};

/// A legacy-era handshake in progress (#3840): what every call after
/// `initialize` carries.
struct LegacySession {
    /// Offered until `initialize` answers, then the one it negotiated.
    std::string protocol_version;
    /// The `Mcp-Session-Id` `initialize` issued; nothing from a stateless server.
    std::optional<std::string> session_id;
    /// The next call's JSON-RPC `id`: a session refuses one it has seen.
    std::int64_t next_id = 1;
};

/// The connection, the request and the budget every call of one import shares.
struct McpSession {
    vayu::http::Client client;
    vayu::Request base;
    ImportBudget budget;
    /// Set once the import speaks the legacy era: every call is a full
    /// envelope carrying the session's headers.
    std::optional<LegacySession> legacy;
};

/// One call and how the reply reader read it.
struct McpCall {
    vayu::Response response;
    McpReply reply;
};

/// A list method and where its page keeps the entries.
struct ListMethod {
    std::string_view method;
    const char* key = "";
    /// A server that answers `-32601` lists none, rather than failing the
    /// import: `resources/templates/list` is the one a server listing
    /// resources may leave out.
    bool may_be_unknown = false;
};

constexpr ListMethod TOOLS_LIST{ "tools/list", "tools" };
constexpr ListMethod RESOURCES_LIST{ "resources/list", "resources" };
constexpr ListMethod TEMPLATES_LIST{ "resources/templates/list", "resourceTemplates", true };
constexpr ListMethod PROMPTS_LIST{ "prompts/list", "prompts" };

/// @p body's member @p key, or null when it is absent or `null`.
const nlohmann::json* stated (const nlohmann::json& body, const char* key) {
    const auto found = body.find (key);
    return found == body.end () || found->is_null () ? nullptr : &*found;
}

Refusable<std::string> read_url (const nlohmann::json& body) {
    const nlohmann::json* url = stated (body, "url");
    if (url == nullptr || !url->is_string ()) {
        return route_error (400, "Invalid 'url': must be the server's http or https URL");
    }
    auto text = url->get<std::string> ();
    if (auto problem = vayu::http::unsendable_scheme (text)) {
        return route_error (400, "Invalid 'url': " + *problem);
    }
    // The root collection stores the URL (`mcpBaseUrl`), so a password in it
    // would be stored in the collection.
    const auto host = vayu::http::url_host_span (text);
    if (host && text.find ('@') < host->begin) {
        return route_error (400, "Invalid 'url': put credentials in auth or headers, not the URL");
    }
    if (vayu::http::url_scheme (text).empty ()) {
        return route_error (400, "Invalid 'url': must be the server's http or https URL");
    }
    return text;
}

Refusable<Include> read_include (const nlohmann::json& body) {
    Include include;
    const nlohmann::json* stated_include = stated (body, "include");
    if (stated_include == nullptr) {
        return include;
    }
    if (!stated_include->is_object ()) {
        return route_error (400, "Invalid 'include': must be an object");
    }
    const auto members = std::to_array<std::pair<const char*, bool Include::*>> (
    { { "tools", &Include::tools }, { "resources", &Include::resources },
    { "prompts", &Include::prompts } });
    for (const auto& [key, value] : stated_include->items ()) {
        const auto member = std::ranges::find_if (
        members, [&key] (const auto& entry) { return key == entry.first; });
        if (member == members.end ()) {
            return route_error (400,
            "Invalid 'include': unknown member '" + key +
            "' (tools, resources and prompts are the members)");
        }
        if (value.is_null ()) {
            continue;
        }
        if (!value.is_boolean ()) {
            return route_error (400, "Invalid 'include." + key + "': must be a boolean");
        }
        include.*(member->second) = value.get<bool> ();
    }
    if (!include.tools && !include.resources && !include.prompts) {
        return route_error (400, "Invalid 'include': nothing is included");
    }
    return include;
}

/// The POST every call is sent as, with the caller's headers read by the rule
/// `POST /execute` reads them by: `[{name, value}]` lines, or an object.
Refusable<vayu::Request>
read_base_request (const nlohmann::json& body, const std::string& url) {
    nlohmann::json shape{ { "method", "POST" }, { "url", url } };
    if (const nlohmann::json* headers = stated (body, "headers")) {
        shape["headers"] = *headers;
    }
    auto read = vayu::json::deserialize_request (shape);
    if (read.is_error ()) {
        return route_error (400, "Invalid 'headers': " + read.error ().message);
    }
    vayu::Request request    = std::move (read).value ();
    request.body.mode        = BodyMode::Mcp;
    request.follow_redirects = false;
    request.timeout_ms       = limits::CALL_TIMEOUT_MS;
    if (auto problem = vayu::http::unsendable_header_text (request)) {
        return route_error (400, "Invalid 'headers': " + *problem);
    }
    return request;
}

/// `auth`, the shape a stored request's is: `{mode: "bearer", token}`. Applied
/// by `apply_auth`, so a request header already named `Authorization` wins.
Refusable<bool> apply_bearer (const nlohmann::json& body, vayu::Request& request) {
    const nlohmann::json* auth = stated (body, "auth");
    if (auth == nullptr) {
        return false;
    }
    const bool bearer = auth->is_object () && auth->value ("mode", "") == "bearer";
    const auto token = bearer ? auth->find ("token") : auth->end ();
    if (!bearer || token == auth->end () || !token->is_string () ||
    vayu::http::trim_optional_whitespace (token->get_ref<const std::string&> ()).empty ()) {
        return route_error (
        400, "Invalid 'auth': must be {\"mode\": \"bearer\", \"token\": <non-empty string>}");
    }
    const auto applied = vayu::http::apply_auth (request, *auth, nullptr);
    if (!applied.ok) {
        return route_error (400, "Invalid 'auth': " + applied.message);
    }
    if (auto problem = vayu::http::unsendable_header_text (request)) {
        return route_error (400, "Invalid 'auth': " + *problem);
    }
    return true;
}

Refusable<McpImportTarget> read_target (const nlohmann::json& body) {
    if (!body.is_object ()) {
        return route_error (400, "Body must be a JSON object");
    }
    auto url = read_url (body);
    if (!url) {
        return std::unexpected (url.error ());
    }
    auto include = read_include (body);
    if (!include) {
        return std::unexpected (include.error ());
    }
    auto base = read_base_request (body, *url);
    if (!base) {
        return std::unexpected (base.error ());
    }
    McpImportTarget target;
    target.caller_headers = base->headers.lines ();
    auto bearer           = apply_bearer (body, *base);
    if (!bearer) {
        return std::unexpected (bearer.error ());
    }
    target.base    = std::move (*base);
    target.bearer  = *bearer;
    target.include = *include;
    return target;
}

RouteError deadline_refusal (const ImportBudget& budget, std::string_view method) {
    return route_error (502,
    "The import ran past its " + std::to_string (budget.total.count ()) +
    " ms total at " + std::string (method) + ", the longest one import takes")
    .error ();
}

/// The `Mcp-Session-Id` @p response issued, or nothing.
std::optional<std::string> issued_session (const vayu::Response& response) {
    const auto issued =
    response.headers.find (std::string (vayu::core::MCP_SESSION_HEADER));
    if (issued == response.headers.end () || issued->second.empty ()) {
        return std::nullopt;
    }
    return issued->second;
}

/// @p request sent as it stands; a failed transfer is a response carrying its
/// error, for the reply reader to name.
vayu::Response send_as_response (McpSession& session, const vayu::Request& request) {
    auto result = session.client.send (request);
    if (result.is_ok ()) {
        return std::move (result).value ();
    }
    vayu::Response failed;
    failed.error_code    = result.error ().code;
    failed.error_message = result.error ().message;
    return failed;
}

/// The session a legacy-era server's first reply issues is kept here, at the
/// transport and before the budget judges that reply: the server holds the
/// session open whatever the import makes of the answer, so a reply the byte
/// cap refuses must still be ended.
void keep_issued_session (McpSession& session, const vayu::Response& response) {
    auto& legacy = session.legacy;
    if (legacy && !legacy->session_id) {
        legacy->session_id = issued_session (response);
    }
}

/// @p request sent within what is left of the import's deadline and counted
/// against its byte budget; a failed transfer is a response carrying its
/// error, for the reply reader to name.
Refusable<vayu::Response>
transfer (McpSession& session, std::string_view method, vayu::Request request) {
    ImportBudget& budget = session.budget;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds> (
    budget.deadline - std::chrono::steady_clock::now ());
    if (remaining.count () <= 0) {
        return std::unexpected (deadline_refusal (budget, method));
    }
    request.timeout_ms = static_cast<int> (
    std::min<long long> (limits::CALL_TIMEOUT_MS, remaining.count ()));

    vayu::Response response = send_as_response (session, request);
    keep_issued_session (session, response);
    if (response.error_code == ErrorCode::Timeout &&
    std::chrono::steady_clock::now () >= budget.deadline) {
        return std::unexpected (deadline_refusal (budget, method));
    }
    budget.bytes += response.body.size ();
    if (budget.bytes > budget.max_bytes) {
        return route_error (413,
        "The server's replies came to more than " +
        std::to_string (budget.max_bytes) + " bytes, the most one import reads");
    }
    return response;
}

/// The base request with a legacy session's headers, which win over the ones
/// the `mcp` mode derives.
vayu::Request session_request (const McpSession& session) {
    vayu::Request request = session.base;
    if (const auto& legacy = session.legacy) {
        request.headers[vayu::http::mcp::PROTOCOL_VERSION_HEADER] = legacy->protocol_version;
        if (legacy->session_id) {
            request.headers[vayu::core::MCP_SESSION_HEADER] = *legacy->session_id;
        }
    }
    return request;
}

/// A call's frame up to its `params`: bare for a modern server, which the
/// engine stamps at send; in a legacy session a full envelope, which nothing
/// is stamped into, numbered because a session refuses an `id` it has seen. A
/// notification is an envelope with no `id`.
ordered_json frame_of (McpSession& session, std::string_view method, bool notification) {
    ordered_json frame = ordered_json::object ();
    if (auto& legacy = session.legacy; legacy) {
        frame["jsonrpc"] = "2.0";
        if (!notification) {
            frame["id"] = legacy->next_id++;
        }
    }
    frame["method"] = std::string (method);
    return frame;
}

Refusable<McpCall>
send_frame (McpSession& session, std::string_view method, const ordered_json& frame) {
    vayu::Request request = session_request (session);
    request.body.content  = frame.dump ();
    auto response         = transfer (session, method, request);
    if (!response) {
        return std::unexpected (response.error ());
    }
    McpCall sent{ std::move (*response), McpReply{} };
    sent.reply = read_mcp_reply (request, sent.response);
    return sent;
}

/// One call, read by the reply reader.
Refusable<McpCall>
send_call (McpSession& session, std::string_view method, ordered_json params) {
    ordered_json frame = frame_of (session, method, /*notification=*/false);
    frame["params"]    = std::move (params);
    return send_frame (session, method, frame);
}

Refusable<McpCall> send_notification (McpSession& session, std::string_view method) {
    return send_frame (session, method, frame_of (session, method, /*notification=*/true));
}

/// The failed call @p call as the import's answer: the reader's message under
/// the method's name, `413` for a reply over `MAX_REPLY_BYTES` and `502` for
/// anything else the server or the way to it did.
RouteError call_refusal (std::string_view method, const McpCall& call) {
    const int status = call.response.error_code == ErrorCode::ResponseTooLarge ? 413 : 502;
    return route_error (status, std::string (method) + " failed: " + call.reply.message)
    .error ();
}

bool is_method_not_found (const McpCall& call) {
    return call.reply.error_class == McpErrorClass::Protocol &&
    call.reply.code == METHOD_NOT_FOUND;
}

/// Whether @p call is the refusal a legacy-era server answers `server/discover`
/// with (#3762, #3989): an HTTP `400`, either bare (a status, or plain text) or
/// carrying a JSON-RPC error, as the reference SDK servers answer a session-less
/// POST (`-32000` with `id: null`, `INVALID_REQUEST` with `id: "server-error"`).
/// A modern-era server's own answers are not one: `-32022` refuses the version
/// and `-32601` has no `server/discover`. Only a `400` counts, so a `401`, a
/// `403`, a `404` or a `5xx` fails the import, as does a failed transfer.
bool is_legacy_refusal (const McpCall& call) {
    if (call.response.has_error () || call.response.status_code != 400) {
        return false;
    }
    const auto& code = call.reply.code;
    return call.reply.error_class.has_value () && code != UNSUPPORTED_VERSION &&
    code != METHOD_NOT_FOUND;
}

/// The reply's `result` object, or nothing when it carried none.
std::optional<ordered_json> call_result (const McpCall& call) {
    auto frame = vayu::utils::parse_ordered_json (
    call.reply.response, vayu::core::constants::elements::MAX_BODY_DEPTH);
    if (!frame || !frame->is_object ()) {
        return std::nullopt;
    }
    const auto result = frame->find ("result");
    if (result == frame->end () || !result->is_object ()) {
        return std::nullopt;
    }
    // In place, because an `ordered_json` converts to an optional two ways.
    return std::optional<ordered_json> (std::in_place, std::move (*result));
}

/// @p object's member @p key when it is a string, else empty.
std::string string_member (const ordered_json& object, const char* key) {
    const auto found = object.find (key);
    return found != object.end () && found->is_string () ? found->get<std::string> () :
                                                           std::string ();
}

/// @p result's `serverInfo.name`, or empty when it names none.
std::string server_name (const ordered_json& result) {
    const auto info = result.find ("serverInfo");
    return info != result.end () && info->is_object () ? string_member (*info, "name") :
                                                         std::string ();
}

/// What `server/discover` said of the server.
struct Discovery {
    /// It answered a legacy-era `400` (`is_legacy_refusal`), so the import opens
    /// a session.
    bool legacy = false;
    /// `serverInfo.name`, empty when the server named none.
    std::string name;
};

/// `server/discover`, best effort for its `serverInfo.name`. A server that
/// answers `-32601` (modern-era, with no `server/discover` of its own) is read
/// on unnamed, a legacy-era one is told apart by its `400` (`is_legacy_refusal`)
/// for its handshake, and any other failure fails the import.
Refusable<Discovery> discover (McpSession& session) {
    auto sent = send_call (session, "server/discover", ordered_json::object ());
    if (!sent) {
        return std::unexpected (sent.error ());
    }
    const McpCall& call = *sent;
    if (is_legacy_refusal (call)) {
        return Discovery{ .legacy = true, .name = std::string () };
    }
    if (is_method_not_found (call)) {
        return Discovery{};
    }
    if (call.reply.error_class) {
        return std::unexpected (call_refusal ("server/discover", call));
    }
    const auto result = call_result (call);
    return Discovery{ .legacy = false,
        .name = result ? server_name (*result) : std::string () };
}

/// `initialize`: the version it negotiated into @p legacy, and the result it
/// answered. The session it issued is already kept (`keep_issued_session`),
/// before the reply is judged, so a refused handshake still ends the session
/// it opened.
Refusable<ordered_json> initialize (McpSession& session, LegacySession& legacy) {
    auto sent = send_call (session, "initialize", vayu::core::mcp_initialize_params ());
    if (!sent) {
        return std::unexpected (sent.error ());
    }
    if (sent->reply.error_class) {
        return std::unexpected (call_refusal ("initialize", *sent));
    }
    auto result = call_result (*sent);
    if (!result) {
        return route_error (502, "initialize answered with no result");
    }
    std::string version = string_member (*result, "protocolVersion");
    if (version.empty ()) {
        return route_error (502, "initialize answered with no protocolVersion");
    }
    legacy.protocol_version = std::move (version);
    return std::move (*result);
}

/// The handshake a legacy-era server needs before anything else (#3840):
/// `initialize`, then `notifications/initialized`. Leaves @p session speaking
/// the session it opened; what the handshake settled and the server's name
/// fill @p listing.
RouteResult open_legacy_session (McpSession& session, vayu::core::McpServerListing& listing) {
    LegacySession& legacy = session.legacy.emplace (LegacySession{
    .protocol_version = std::string (vayu::core::MCP_LEGACY_PROTOCOL_VERSION),
    .session_id       = std::nullopt,
    .next_id          = 1 });
    const auto result     = initialize (session, legacy);
    if (!result) {
        return std::unexpected (result.error ());
    }
    auto note = send_notification (session, "notifications/initialized");
    if (!note) {
        return std::unexpected (note.error ());
    }
    if (note->reply.error_class) {
        return std::unexpected (call_refusal ("notifications/initialized", *note));
    }
    listing.legacy = vayu::core::McpLegacyHandshake{ .protocol_version = legacy.protocol_version,
        .session = legacy.session_id.has_value () };
    if (std::string name = server_name (*result); !name.empty ()) {
        listing.name = std::move (name);
    }
    return {};
}

/// Ends the session the import opened, best effort: nothing the server
/// answers (a `405` included, which the specification allows) changes the
/// import's answer. Sent under a bound of its own, not through `transfer`,
/// which refuses once the total deadline has passed: an import that ran out of
/// time still ends its session. Its reply is read for nothing, so it is not
/// counted against the byte budget either.
void close_legacy_session (McpSession& session) {
    const auto& legacy = session.legacy;
    if (!legacy || !legacy->session_id) {
        return;
    }
    vayu::Request request             = session_request (session);
    request.method                    = vayu::HttpMethod::DELETE;
    request.body                      = vayu::Body{};
    request.timeout_ms                = limits::SESSION_CLOSE_TIMEOUT_MS;
    [[maybe_unused]] const auto ended = send_as_response (session, request);
}

/// What a refused page of @p list becomes: the loop's own failure kinds worded
/// as the import's `502` / `413`.
RouteError list_refusal (const ListMethod& list, const vayu::core::McpListFailure& failure) {
    using Kind = vayu::core::McpListFailureKind;
    const std::string method (list.method);
    switch (failure.kind) {
    case Kind::PageCapReached:
        return route_error (502,
        method + " still had a nextCursor after " +
        std::to_string (limits::MAX_PAGES) + " pages, the most one import follows")
        .error ();
    case Kind::RepeatedCursor:
        return route_error (502, method + " repeated a cursor it had already been sent, so the list would never end")
        .error ();
    case Kind::ItemsOverBudget:
        return route_error (413,
        "The server lists more than " + std::to_string (limits::MAX_ITEMS) +
        " tools, resources and prompts, the most one import reads")
        .error ();
    case Kind::MissingList:
    case Kind::SendFailed: break;
    }
    return route_error (502, method + " answered with no '" + list.key + "' list")
    .error ();
}

/// Every entry @p list answers, through `core::collect_mcp_list_pages`; nothing
/// for a `may_be_unknown` method the server does not know. Entries count
/// against `MAX_ITEMS` across the whole import.
Refusable<std::optional<ordered_json>> list_all (McpSession& session, const ListMethod& list) {
    // The loop carries a sender's failure through untouched, so the refusal
    // the import answers with (its status, its code) is kept here whole.
    std::optional<RouteError> refused;
    bool unknown_method = false;
    const auto refuse   = [&] (RouteError error) {
        refused = std::move (error);
        return std::unexpected (vayu::core::McpPageFailure{
        .status = refused->status, .message = error_message_of (refused->body) });
    };
    const auto send = [&] (const std::optional<std::string>& cursor)
    -> std::expected<ordered_json, vayu::core::McpPageFailure> {
        ordered_json params = ordered_json::object ();
        if (cursor) {
            params["cursor"] = *cursor;
        }
        auto sent = send_call (session, list.method, std::move (params));
        if (!sent) {
            return refuse (std::move (sent.error ()));
        }
        const McpCall& call = *sent;
        if (!cursor && list.may_be_unknown && is_method_not_found (call)) {
            unknown_method = true;
            return std::unexpected (vayu::core::McpPageFailure{});
        }
        if (call.reply.error_class) {
            return refuse (call_refusal (list.method, call));
        }
        // No result object is a page with no list, which the loop names.
        return call_result (call).value_or (ordered_json ());
    };
    auto pages = vayu::core::collect_mcp_list_pages (
    send, list.key, limits::MAX_PAGES, session.budget.items, limits::MAX_ITEMS);
    if (pages) {
        return std::optional<ordered_json> (std::in_place, std::move (pages->rows));
    }
    if (unknown_method) {
        return std::optional<ordered_json> ();
    }
    if (refused) {
        return std::unexpected (std::move (*refused));
    }
    return std::unexpected (list_refusal (list, pages.error ()));
}

/// The host @p url names, the collection's name when the server names none.
std::string url_host (const std::string& url) {
    const auto span = vayu::http::url_host_span (url);
    if (!span || span->size == 0) {
        return url;
    }
    return url.substr (span->begin, span->size);
}

/// What one included list fills in.
struct ListStep {
    bool included                                                    = false;
    const ListMethod* list                                           = nullptr;
    std::optional<ordered_json> vayu::core::McpServerListing::* into = nullptr;
};

/// Every included list method, every page, into @p listing.
RouteResult read_lists (McpSession& session,
const Include& include,
vayu::core::McpServerListing& listing) {
    using Listing    = vayu::core::McpServerListing;
    const auto steps = std::to_array<ListStep> ({
    { include.tools, &TOOLS_LIST, &Listing::tools },
    { include.resources, &RESOURCES_LIST, &Listing::resources },
    { include.resources, &TEMPLATES_LIST, &Listing::resource_templates },
    { include.prompts, &PROMPTS_LIST, &Listing::prompts },
    });
    for (const auto& step : steps) {
        if (!step.included) {
            continue;
        }
        auto entries = list_all (session, *step.list);
        if (!entries) {
            return std::unexpected (entries.error ());
        }
        listing.*(step.into) = std::move (*entries);
    }
    return {};
}

Refusable<vayu::core::McpServerListing>
read_listing (McpSession& session, const McpImportTarget& target) {
    auto discovery = discover (session);
    if (!discovery) {
        return std::unexpected (discovery.error ());
    }
    vayu::core::McpServerListing listing;
    listing.url     = target.base.url;
    listing.name    = discovery->name.empty () ? url_host (target.base.url) :
                                                 std::move (discovery->name);
    listing.headers = target.caller_headers;
    listing.bearer  = target.bearer;
    RouteResult read =
    discovery->legacy ? open_legacy_session (session, listing) : RouteResult{};
    if (read) {
        read = read_lists (session, target.include, listing);
    }
    // Ended whether or not the import got this far, so a failed import leaves
    // no session open on the server.
    close_legacy_session (session);
    if (!read) {
        return std::unexpected (read.error ());
    }
    return listing;
}

vayu::http::ClientConfig mcp_client_config (const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    vayu::http::ClientConfig config;
    config.transport          = transport;
    config.max_response_bytes = limits::MAX_REPLY_BYTES;
    config.cancel             = cancel;
    return config;
}

/// What an import of @p body reads from its server, under the whole-import
/// bounds; both routes read the server through this one call.
Refusable<vayu::core::McpServerListing> fetch_listing (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel,
std::chrono::milliseconds total_timeout,
std::size_t max_total_bytes) {
    auto target = read_target (body);
    if (!target) {
        return std::unexpected (target.error ());
    }
    McpSession session{ vayu::http::Client (mcp_client_config (transport, cancel)),
        target->base,
        ImportBudget{ .deadline = std::chrono::steady_clock::now () + total_timeout,
        .total     = total_timeout,
        .max_bytes = max_total_bytes },
        std::nullopt };
    return read_listing (session, *target);
}

/// @p collection is a root an import of @p url built: it has no parent and its
/// `mcpBaseUrl` holds @p url as written, a query string included.
bool imported_from (const vayu::db::Collection& collection, const std::string& url) {
    if (collection.parent_id) {
        return false;
    }
    const vayu::Environment variables = vayu::json::parse_variables (collection.variables);
    const auto base_url =
    variables.find (std::string (vayu::core::MCP_BASE_URL_VARIABLE));
    return base_url != variables.end () && base_url->second.value == url;
}

/// Every request at or beneath @p root, in `collection_subtree_requests` order.
std::vector<vayu::db::Request> subtree_requests (vayu::db::Database& db,
const std::vector<vayu::db::Collection>& all,
const std::string& root) {
    const auto subtree = collection_subtree_ids (
    all, root, [] (const vayu::db::Collection&) { return true; });
    return collection_subtree_requests (db, all, subtree);
}

/// The MCP requests beneath one collection, as the comparison reads them.
struct StoredEntries {
    std::vector<vayu::core::McpEntry> entries;
    /// Parallel to `entries`: the stored row each was read from, borrowed
    /// from the rows `stored_entries` read.
    std::vector<const vayu::db::Request*> rows;
};

/// The requests of @p rows that are an MCP call, in their order.
StoredEntries stored_entries (const std::vector<vayu::db::Request>& rows) {
    StoredEntries out;
    for (const auto& row : rows) {
        const auto stored_body =
        nlohmann::json::parse (row.body, nullptr, /*allow_exceptions=*/false);
        auto entry = vayu::core::mcp_entry_of (row.name, row.description, stored_body);
        if (entry) {
            out.entries.push_back (std::move (*entry));
            out.rows.push_back (&row);
        }
    }
    return out;
}

nlohmann::json entry_json (const vayu::core::McpEntry& entry) {
    return nlohmann::json{
        { "kind", std::string (vayu::core::mcp_entry_kind_name (entry.kind)) },
        { "key", entry.key }, { "name", entry.name }
    };
}

/// One matched collection's answer. A changed entry carries the listing's
/// key and the stored request's name; a rename adds the key it had.
nlohmann::json match_json (const vayu::db::Collection& root,
const vayu::core::McpDiff& diff,
const std::vector<vayu::core::McpEntry>& fetched,
const StoredEntries& stored) {
    nlohmann::json added = nlohmann::json::array ();
    for (const std::size_t at : diff.added) {
        added.push_back (entry_json (fetched.at (at)));
    }
    nlohmann::json removed = nlohmann::json::array ();
    for (const std::size_t at : diff.removed) {
        nlohmann::json row = entry_json (stored.entries.at (at));
        row["requestId"]   = stored.rows.at (at)->id;
        removed.push_back (std::move (row));
    }
    nlohmann::json changed = nlohmann::json::array ();
    for (const auto& change : diff.changed) {
        const vayu::core::McpEntry& was = stored.entries.at (change.stored);
        nlohmann::json row = entry_json (fetched.at (change.fetched));
        row["name"]        = was.name;
        row["requestId"]   = stored.rows.at (change.stored)->id;
        row["fields"]      = nlohmann::json::array ();
        for (const auto field : change.fields) {
            row["fields"].push_back (std::string (vayu::core::mcp_field_name (field)));
        }
        if (change.renamed) {
            row["renamedFrom"] = was.key;
        }
        changed.push_back (std::move (row));
    }
    return nlohmann::json{ { "collectionId", root.id }, { "name", root.name },
        { "identical", diff.identical () }, { "added", std::move (added) },
        { "removed", std::move (removed) }, { "changed", std::move (changed) } };
}

// ---------------------------------------------------------------------------
// POST /import/mcp/apply (#3994)
// ---------------------------------------------------------------------------

using EntryKey = std::pair<vayu::core::McpEntryKind, std::string>;

/// What an apply was asked to write, read before the server is.
struct McpApplySelection {
    std::string collection_id;
    /// Listing entries to create, by identity, in the order asked.
    std::vector<EntryKey> added;
    /// Stored request ids to update and to delete.
    std::vector<std::string> changed;
    std::vector<std::string> removed;
};

std::optional<vayu::core::McpEntryKind> entry_kind_named (std::string_view name) {
    using vayu::core::McpEntryKind;
    for (const auto kind :
    { McpEntryKind::Tool, McpEntryKind::Resource, McpEntryKind::Prompt }) {
        if (vayu::core::mcp_entry_kind_name (kind) == name) {
            return kind;
        }
    }
    return std::nullopt;
}

std::string entry_label (const EntryKey& key) {
    return std::string (vayu::core::mcp_entry_kind_name (key.first)) + " '" +
    key.second + "'";
}

/// @p row as `{kind, key}`, or nothing when it is not one.
std::optional<EntryKey> read_entry_key (const nlohmann::json& row) {
    if (!row.is_object ()) {
        return std::nullopt;
    }
    const nlohmann::json* kind = stated (row, "kind");
    const nlohmann::json* key  = stated (row, "key");
    if (kind == nullptr || !kind->is_string () || key == nullptr ||
    !key->is_string () || key->get_ref<const std::string&> ().empty ()) {
        return std::nullopt;
    }
    const auto named = entry_kind_named (kind->get_ref<const std::string&> ());
    if (!named) {
        return std::nullopt;
    }
    return EntryKey{ *named, key->get<std::string> () };
}

/// `select.added`, each entry at most once.
Refusable<std::vector<EntryKey>> read_selected_added (const nlohmann::json* rows) {
    std::vector<EntryKey> added;
    if (rows == nullptr) {
        return added;
    }
    if (!rows->is_array ()) {
        return route_error (400, "Invalid 'select.added': must be an array");
    }
    std::set<EntryKey> seen;
    for (const auto& row : *rows) {
        auto key = read_entry_key (row);
        if (!key) {
            return route_error (400,
            "Invalid 'select.added': each entry must be {\"kind\": \"tool\", "
            "\"resource\" or \"prompt\", \"key\": <non-empty string>}");
        }
        if (!seen.insert (*key).second) {
            return route_error (400,
            "Invalid 'select.added': " + entry_label (*key) + " appears twice");
        }
        added.push_back (std::move (*key));
    }
    return added;
}

/// `select.<list>`: request ids, none named twice across the lists @p seen
/// spans.
Refusable<std::vector<std::string>> read_selected_ids (const nlohmann::json* rows,
const std::string& list,
std::set<std::string>& seen) {
    std::vector<std::string> ids;
    if (rows == nullptr) {
        return ids;
    }
    if (!rows->is_array ()) {
        return route_error (400, "Invalid 'select." + list + "': must be an array");
    }
    for (const auto& row : *rows) {
        if (!row.is_string () || row.get_ref<const std::string&> ().empty ()) {
            return route_error (400,
            "Invalid 'select." + list + "': each entry must be a request id");
        }
        if (!seen.insert (row.get<std::string> ()).second) {
            return route_error (400,
            "Invalid 'select." + list + "': request '" +
            row.get<std::string> () + "' is selected twice");
        }
        ids.push_back (row.get<std::string> ());
    }
    return ids;
}

Refusable<McpApplySelection> read_selection (const nlohmann::json& body) {
    if (!body.is_object ()) {
        return route_error (400, "Body must be a JSON object");
    }
    const nlohmann::json* id = stated (body, "collectionId");
    if (id == nullptr || !id->is_string () || id->get_ref<const std::string&> ().empty ()) {
        return route_error (
        400, "Invalid 'collectionId': must be the id of the collection an import of the server built");
    }
    McpApplySelection selection;
    selection.collection_id      = id->get<std::string> ();
    const nlohmann::json* select = stated (body, "select");
    if (select == nullptr) {
        return selection;
    }
    if (!select->is_object ()) {
        return route_error (400, "Invalid 'select': must be an object");
    }
    for (const auto& [key, value] : select->items ()) {
        if (key != "added" && key != "changed" && key != "removed") {
            return route_error (400,
            "Invalid 'select': unknown member '" + key +
            "' (added, changed and removed are the members)");
        }
    }
    auto added = read_selected_added (stated (*select, "added"));
    if (!added) {
        return std::unexpected (added.error ());
    }
    std::set<std::string> seen;
    auto changed = read_selected_ids (stated (*select, "changed"), "changed", seen);
    if (!changed) {
        return std::unexpected (changed.error ());
    }
    auto removed = read_selected_ids (stated (*select, "removed"), "removed", seen);
    if (!removed) {
        return std::unexpected (removed.error ());
    }
    selection.added   = std::move (*added);
    selection.changed = std::move (*changed);
    selection.removed = std::move (*removed);
    return selection;
}

/// The call an `mcp` @p body holds, or nothing for one whose `content` is not a
/// JSON object.
std::optional<ordered_json> call_of (const nlohmann::json& body) {
    const auto content = body.find ("content");
    if (content == body.end () || !content->is_string ()) {
        return std::nullopt;
    }
    auto call = vayu::utils::parse_ordered_json (content->get_ref<const std::string&> (),
    vayu::core::constants::request_body::MAX_JSON_DEPTH);
    if (!call || !call->is_object ()) {
        return std::nullopt;
    }
    return std::optional<ordered_json> (std::in_place, std::move (*call));
}

/// The tree an import of the listing builds now, as `import_apply_payload`'s
/// items, and each request item's identity as the diff's reader reads it.
struct ListingDrafts {
    ordered_json payload;
    /// The first item claiming each identity, as `diff_mcp` takes it.
    std::map<EntryKey, std::size_t> requests;
    /// `tempId` to index into `payload.collections`.
    std::map<std::string, std::size_t> collections;

    [[nodiscard]] const ordered_json& request (const EntryKey& key) const {
        const auto found = requests.find (key);
        if (found == requests.end ()) {
            throw std::logic_error ("broken invariant: every listed entry is a "
                                    "request of the tree it was read from");
        }
        return payload.at ("requests").at (found->second);
    }

    [[nodiscard]] const ordered_json& folder_of (const ordered_json& request) const {
        return payload.at ("collections")
        .at (collections.at (request.at ("collectionTempId").get<std::string> ()));
    }
};

ListingDrafts listing_drafts (const vayu::core::McpServerListing& listing) {
    ListingDrafts drafts{ vayu::core::import_apply_payload (
                          vayu::core::mcp_import_result (listing)),
        {}, {} };
    const ordered_json& requests = drafts.payload.at ("requests");
    for (std::size_t at = 0; at < requests.size (); ++at) {
        const ordered_json& item = requests.at (at);
        // A copy: `ordered_json` to `json` is a conversion.
        const auto entry = vayu::core::mcp_entry_of (item.value ("name", ""),
        item.value ("description", ""), nlohmann::json (item.at ("body")));
        if (entry) {
            drafts.requests.try_emplace (EntryKey{ entry->kind, entry->key }, at);
        }
    }
    const ordered_json& collections = drafts.payload.at ("collections");
    for (std::size_t at = 0; at < collections.size (); ++at) {
        drafts.collections.emplace (
        collections.at (at).at ("tempId").get<std::string> (), at);
    }
    return drafts;
}

/// What a selection is checked against, read and compared under the lock.
struct ApplyGround {
    vayu::db::Collection root;
    std::vector<vayu::db::Collection> collections;
    std::vector<vayu::db::Request> rows;
    StoredEntries stored;
    vayu::core::McpListingEntries fetched;
    vayu::core::McpDiff diff;
};

/// The collection @p selection names, when it is a root an import of
/// @p listing's URL built: `404` for none, `409` for another.
Refusable<vayu::db::Collection> applied_root (vayu::db::Database& db,
const McpApplySelection& selection,
const vayu::core::McpServerListing& listing) {
    auto root = db.get_collection (selection.collection_id);
    if (!root) {
        return route_error (404, "Collection '" + selection.collection_id + "' not found");
    }
    if (!imported_from (*root, listing.url)) {
        return route_error (409,
        "Collection '" + selection.collection_id +
        "' is not a root collection whose mcpBaseUrl holds this URL");
    }
    return std::move (*root);
}

/// The rows of the recomputed diff a selection names, in the order it names
/// them.
struct SelectedRows {
    std::vector<EntryKey> added;
    std::vector<const vayu::core::McpChange*> changed;
    std::vector<std::string> removed;
};

/// @p selection against the diff as it stands now: a row it names that the
/// diff no longer holds (the request gone, no longer changed, the entry no
/// longer added) is a `409`, and nothing is written.
Refusable<SelectedRows>
selected_rows (const McpApplySelection& selection, const ApplyGround& ground) {
    std::set<EntryKey> added;
    for (const std::size_t at : ground.diff.added) {
        const vayu::core::McpEntry& entry = ground.fetched.entries.at (at);
        added.emplace (entry.kind, entry.key);
    }
    std::map<std::string, const vayu::core::McpChange*> changed;
    for (const auto& change : ground.diff.changed) {
        changed.emplace (ground.stored.rows.at (change.stored)->id, &change);
    }
    std::set<std::string> removed;
    for (const std::size_t at : ground.diff.removed) {
        removed.insert (ground.stored.rows.at (at)->id);
    }
    const auto stale = [] (const std::string& what, const char* row) {
        return route_error (409,
        what + " is no longer " +
        row + " in this server's diff of the collection; compare again and choose from what it answers");
    };

    SelectedRows rows;
    for (const auto& key : selection.added) {
        if (!added.contains (key)) {
            return stale (entry_label (key), "an added entry");
        }
        rows.added.push_back (key);
    }
    for (const auto& id : selection.changed) {
        const auto change = changed.find (id);
        if (change == changed.end ()) {
            return stale ("Request '" + id + "'", "a changed entry");
        }
        rows.changed.push_back (change->second);
    }
    for (const auto& id : selection.removed) {
        if (!removed.contains (id)) {
            return stale ("Request '" + id + "'", "a removed entry");
        }
        rows.removed.push_back (id);
    }
    return rows;
}

/// The rows one apply writes, and the answer it builds as it goes.
struct ApplyPlan {
    vayu::db::McpApplyBatch batch;
    SiblingSlots slots;
    std::int64_t now = 0;
    /// The next JSON-RPC `id` a created legacy envelope takes.
    std::int64_t next_envelope_id = 1;
    nlohmann::json created        = nlohmann::json::array ();
};

/// One past the highest JSON-RPC `id` any of @p rows' calls carries: a legacy
/// session refuses an `id` it has seen, so a created envelope never reuses one.
std::int64_t next_envelope_id (const std::vector<vayu::db::Request>& rows) {
    std::int64_t highest = 0;
    for (const auto& row : rows) {
        const auto body =
        nlohmann::json::parse (row.body, nullptr, /*allow_exceptions=*/false);
        const auto call = body.is_object () ? call_of (body) : std::nullopt;
        if (!call) {
            continue;
        }
        const auto id = call->find ("id");
        if (id != call->end () && id->is_number_integer ()) {
            highest = (std::max)(highest, id->get<std::int64_t> ());
        }
    }
    return highest + 1;
}

/// A created request's envelope numbered past the stored ones; a bare call,
/// which the engine numbers at send, is left as it is.
void renumber_envelope (nlohmann::json& fields, ApplyPlan& plan) {
    nlohmann::json& body = fields.at ("body");
    auto call            = call_of (body);
    if (!call || !call->contains ("id")) {
        return;
    }
    (*call)["id"]   = plan.next_envelope_id++;
    body["content"] = call->dump (2);
}

/// Where a created request lands: the folder the import files its kind under
/// (`Tools`, `Resources`, `Prompts`), as the root's direct child of that name,
/// else one this apply creates, once.
class FolderPlacer {
    public:
    FolderPlacer (const vayu::db::Collection& root,
    const std::vector<vayu::db::Collection>& all)
    : root_id_ (root.id) {
        for (const auto& collection : all) {
            if (collection.parent_id && *collection.parent_id == root_id_) {
                existing_.try_emplace (collection.name, collection.id);
            }
        }
    }

    /// The id of the stored collection standing for @p folder, a payload
    /// collection item.
    Refusable<std::string>
    owner_of (vayu::db::Database& db, const ordered_json& folder, ApplyPlan& plan) {
        if (folder.at ("parentTempId").is_null ()) {
            return root_id_;
        }
        const std::string name = folder.at ("name").get<std::string> ();
        if (const auto found = existing_.find (name); found != existing_.end ()) {
            return found->second;
        }
        nlohmann::json fields (folder);
        fields.erase ("tempId");
        fields.erase ("parentTempId");
        fields.erase ("order");
        fields["parentId"] = root_id_;
        vayu::db::Collection row;
        row.id         = vayu::utils::generate_id ("col_");
        row.created_at = plan.now;
        row.updated_at = plan.now;
        if (auto applied = apply_collection_fields (db, row, fields, /*is_create=*/true);
        !applied) {
            return std::unexpected (applied.error ());
        }
        if (auto slot = plan.slots.take (db, root_id_, row.order); !slot) {
            return std::unexpected (slot.error ());
        }
        existing_.emplace (name, row.id);
        plan.batch.new_collections.push_back (row);
        return row.id;
    }

    private:
    std::string root_id_;
    std::unordered_map<std::string, std::string> existing_;
};

/// The request an import would build for @p key now, appended under its
/// folder.
RouteResult plan_created (vayu::db::Database& db,
const EntryKey& key,
const ListingDrafts& drafts,
FolderPlacer& folders,
ApplyPlan& plan) {
    const ordered_json& item = drafts.request (key);
    auto owner = folders.owner_of (db, drafts.folder_of (item), plan);
    if (!owner) {
        return std::unexpected (owner.error ());
    }
    nlohmann::json fields (item);
    fields.erase ("tempId");
    fields.erase ("collectionTempId");
    fields.erase ("order");
    fields["collectionId"] = *owner;
    renumber_envelope (fields, plan);

    vayu::db::Request row;
    row.id         = vayu::utils::generate_id ("req_");
    row.created_at = plan.now;
    row.updated_at = plan.now;
    if (auto applied = apply_request_fields (db, row, fields, /*is_create=*/true); !applied) {
        return applied;
    }
    if (auto slot = plan.slots.take (db, row.collection_id, row.order); !slot) {
        return slot;
    }
    plan.created.push_back (nlohmann::json{
    { "kind", std::string (vayu::core::mcp_entry_kind_name (key.first)) },
    { "key", key.second }, { "requestId", row.id } });
    plan.batch.created.push_back (std::move (row));
    return {};
}

/// @p body's `mcpTool` with @p member as the listing's tool states it, and
/// without it where that states none (a schema a send refuses included, which
/// the import leaves out).
void take_tool_member (nlohmann::json& body,
const nlohmann::json& listed_body,
const char* member,
const std::string& key) {
    const auto stored_tool = body.find ("mcpTool");
    nlohmann::json tool = stored_tool != body.end () && stored_tool->is_object () ?
    *stored_tool :
    nlohmann::json::object ();
    const auto listed_tool = listed_body.find ("mcpTool");
    const bool listed      = listed_tool != listed_body.end () &&
    listed_tool->is_object () && listed_tool->contains (member);
    if (listed) {
        tool[member] = listed_tool->at (member);
    } else {
        tool.erase (member);
    }
    tool["name"]    = key;
    body["mcpTool"] = std::move (tool);
}

/// A renamed tool's call names @p key, as its `mcpTool` does where the body
/// stores one; the call's `arguments` are kept as they stand.
void rename_call (nlohmann::json& body, const std::string& key) {
    if (const auto tool = body.find ("mcpTool"); tool != body.end () && tool->is_object ()) {
        (*tool)["name"] = key;
    }
    auto call = call_of (body);
    if (!call) {
        return;
    }
    const auto params = call->find ("params");
    if (params == call->end () || !params->is_object ()) {
        return;
    }
    (*params)["name"] = key;
    body["content"]   = call->dump (2);
}

/**
 * The merge-patch one selected changed row writes: the fields @p change names
 * and nothing else (#3994). A description is the request's; a schema is its
 * `mcpTool`'s; a rename is the request's name, `mcpTool.name` and the call's
 * `params.name`. Arguments, headers, auth, elements and every other field a
 * person may have edited are not part of the patch.
 */
nlohmann::json change_patch (const vayu::db::Request& stored,
const vayu::core::McpChange& change,
const vayu::core::McpEntry& listed,
const nlohmann::json& listed_body) {
    nlohmann::json patch = nlohmann::json::object ();
    const auto original_body =
    nlohmann::json::parse (stored.body, nullptr, /*allow_exceptions=*/false);
    nlohmann::json body = original_body;
    for (const auto field : change.fields) {
        switch (field) {
        case vayu::core::McpField::Description:
            patch["description"] = listed.description;
            break;
        case vayu::core::McpField::InputSchema:
            take_tool_member (body, listed_body, "inputSchema", listed.key);
            break;
        case vayu::core::McpField::OutputSchema:
            take_tool_member (body, listed_body, "outputSchema", listed.key);
            break;
        }
    }
    if (change.renamed) {
        patch["name"] = listed.name;
        rename_call (body, listed.key);
    }
    if (body != original_body) {
        patch["body"] = std::move (body);
    }
    return patch;
}

/// The stored request @p change names, patched in place: the row is kept,
/// its id included, never recreated.
RouteResult plan_updated (vayu::db::Database& db,
const vayu::core::McpChange& change,
const ApplyGround& ground,
const ListingDrafts& drafts,
ApplyPlan& plan) {
    const vayu::db::Request& stored = *ground.stored.rows.at (change.stored);
    const vayu::core::McpEntry& listed = ground.fetched.entries.at (change.fetched);
    // A copy: `ordered_json` to `json` is a conversion.
    const nlohmann::json listed_body (
    drafts.request (EntryKey{ listed.kind, listed.key }).at ("body"));
    vayu::db::Request row = stored;
    row.updated_at        = next_updated_at (stored.updated_at);
    if (auto applied = apply_request_fields (db, row,
        change_patch (stored, change, listed, listed_body), /*is_create=*/false);
    !applied) {
        return applied;
    }
    plan.batch.updated.push_back (std::move (row));
    return {};
}

/// Every selected row as the rows the batch writes.
RouteResult plan_selected (vayu::db::Database& db,
const SelectedRows& selected,
const ApplyGround& ground,
const vayu::core::McpServerListing& listing,
ApplyPlan& plan) {
    const ListingDrafts drafts = listing_drafts (listing);
    for (const auto* change : selected.changed) {
        if (auto planned = plan_updated (db, *change, ground, drafts, plan); !planned) {
            return planned;
        }
    }
    if (!selected.added.empty ()) {
        plan.next_envelope_id = next_envelope_id (ground.rows);
    }
    FolderPlacer folders (ground.root, ground.collections);
    for (const auto& key : selected.added) {
        if (auto planned = plan_created (db, key, drafts, folders, plan); !planned) {
            return planned;
        }
    }
    plan.batch.deleted = selected.removed;
    return {};
}

/// The whole apply, under the caller's lock: the collection, its requests and
/// the diff are read again here, so what is written is decided against what
/// is stored when it lands (#386).
std::pair<int, nlohmann::json> apply_listing_locked (vayu::db::Database& db,
const vayu::core::McpServerListing& listing,
const McpApplySelection& selection) {
    auto root = applied_root (db, selection, listing);
    if (!root) {
        return as_response (root.error ());
    }
    ApplyGround ground;
    ground.root        = std::move (*root);
    ground.collections = db.get_collections ();
    ground.rows    = subtree_requests (db, ground.collections, ground.root.id);
    ground.stored  = stored_entries (ground.rows);
    ground.fetched = vayu::core::mcp_listing_entries (listing);
    ground.diff    = vayu::core::diff_mcp (
    ground.fetched.entries, ground.fetched.kinds, ground.stored.entries);

    auto selected = selected_rows (selection, ground);
    if (!selected) {
        return as_response (selected.error ());
    }
    ApplyPlan plan;
    plan.batch.root_id = ground.root.id;
    plan.now           = now_ms ();
    if (auto planned = plan_selected (db, *selected, ground, listing, plan); !planned) {
        return as_response (planned.error ());
    }
    db.mcp_apply (plan.batch);

    nlohmann::json updated = nlohmann::json::array ();
    for (const auto& row : plan.batch.updated) {
        updated.push_back (row.id);
    }
    return { 200,
        nlohmann::json{ { "collectionId", ground.root.id },
        { "created", std::move (plan.created) },
        { "updated", std::move (updated) }, { "deleted", plan.batch.deleted } } };
}

} // namespace

std::optional<std::pair<vayu::http::ClientConfig, vayu::Request>>
import_mcp_call_shape (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    auto target = read_target (body);
    if (!target) {
        return std::nullopt;
    }
    return std::make_pair (
    mcp_client_config (transport, cancel), std::move (target->base));
}

/**
 * Testable core of POST /import/mcp: ask the MCP server at `body.url` what it
 * offers and answer the `ImportResult` `POST /import/parse` would, stored
 * nowhere.
 *
 * `server/discover` is best effort, for its `serverInfo.name`: a server that
 * answers `-32601` (a modern-era one with no such method) is read on, while a
 * version refusal or any other failure fails the import with what the reply
 * reader said. A legacy-era server's plain `400` opens a session first
 * (`initialize`, whose `serverInfo.name` names the collection, then
 * `notifications/initialized`), which every later call carries and a
 * best-effort `DELETE` ends. Then each included list method, every page.
 *
 * @param transport `resolve_transport_policy (db)`, required for the reason
 *                  `import_fetch`'s is.
 * @param cancel    `RouteContext::server_stopping` (#2683).
 * @return {http_status, json_body}: 200 with the tree; 400 for a body that
 *         names no usable server, headers or auth, or a URL with userinfo;
 *         413 for a reply over `MAX_REPLY_BYTES`, replies over
 *         `MAX_TOTAL_BYTES` or a listing over `MAX_ITEMS`; 502 for a call
 *         that failed, an `initialize` that negotiated no version, a reply
 *         with no list, a repeated cursor, a list past
 *         `MAX_PAGES` or an import past `TOTAL_TIMEOUT_MS` (a timeout is a
 *         `502` here, as on `POST /import/fetch`).
 */
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    return import_mcp_response (body, transport, cancel,
    std::chrono::milliseconds (limits::TOTAL_TIMEOUT_MS), limits::MAX_TOTAL_BYTES);
}

std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel,
std::chrono::milliseconds total_timeout,
std::size_t max_total_bytes) {
    auto listing = fetch_listing (body, transport, cancel, total_timeout, max_total_bytes);
    if (!listing) {
        return as_response (listing.error ());
    }
    // A copy: `ordered_json` to `json` is a conversion, never a move.
    nlohmann::json result = vayu::core::mcp_import_result (*listing);
    return { 200, std::move (result) };
}

/**
 * Testable core of POST /import/mcp/diff (#3842): read the server at
 * `body.url` exactly as `POST /import/mcp` does, then compare the listing with
 * every root collection an import of that URL built (its `mcpBaseUrl` holds
 * the URL, byte for byte). Writes nothing.
 *
 * @return {http_status, json_body}: 200 `{matches: [...]}`, one entry per such
 *         collection and an empty list for none; every refusal
 *         `POST /import/mcp` answers, for the same reasons.
 */
std::pair<int, nlohmann::json> import_mcp_diff_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    auto listing = fetch_listing (body, transport, cancel,
    std::chrono::milliseconds (limits::TOTAL_TIMEOUT_MS), limits::MAX_TOTAL_BYTES);
    if (!listing) {
        return as_response (listing.error ());
    }
    const vayu::core::McpListingEntries fetched =
    vayu::core::mcp_listing_entries (*listing);
    const auto collections = db.get_collections ();
    nlohmann::json matches = nlohmann::json::array ();
    for (const auto& root : collections) {
        if (!imported_from (root, listing->url)) {
            continue;
        }
        const std::vector<vayu::db::Request> rows =
        subtree_requests (db, collections, root.id);
        const StoredEntries stored = stored_entries (rows);
        const vayu::core::McpDiff diff =
        vayu::core::diff_mcp (fetched.entries, fetched.kinds, stored.entries);
        matches.push_back (match_json (root, diff, fetched.entries, stored));
    }
    return { 200, nlohmann::json{ { "matches", std::move (matches) } } };
}

/**
 * Testable core of POST /import/mcp/apply (#3994): read the server at
 * `body.url` exactly as `POST /import/mcp/diff` does, then write the rows of
 * its diff that `body.select` names to the collection `body.collectionId`, in
 * one transaction. The server is read before the database lock is taken, so a
 * slow server holds up no other write; the collection, its requests and the
 * diff are read again under the lock, and a selected row the diff no longer
 * holds refuses the whole apply.
 *
 * @return {http_status, json_body}: 200 `{collectionId, created, updated,
 *         deleted}`; 400 for a body that names no collection or a malformed
 *         selection, and every refusal of `POST /import/mcp`; 404 for an
 *         unknown collection; 409 for a collection no import of the URL built,
 *         or a selected row the diff no longer holds.
 */
std::pair<int, nlohmann::json> import_mcp_apply_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    auto selection = read_selection (body);
    if (!selection) {
        return as_response (selection.error ());
    }
    auto listing = fetch_listing (body, transport, cancel,
    std::chrono::milliseconds (limits::TOTAL_TIMEOUT_MS), limits::MAX_TOTAL_BYTES);
    if (!listing) {
        return as_response (listing.error ());
    }
    std::pair<int, nlohmann::json> result;
    db.with_lock (
    [&] { result = apply_listing_locked (db, *listing, *selection); });
    return result;
}

} // namespace vayu::http::routes
