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
 *        `core/mcp_import.hpp`'s; the handler is registered beside the other
 *        import routes in `import.cpp`.
 *
 * Every call goes through `vayu::http::Client` as an `mcp` body, so the
 * envelope, `_meta` and the derived headers are the ones a stored request
 * sends, the reply is read by the one reader (`read_mcp_reply`), and the
 * reserved-port guard and the transport policy apply as on any send.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/mcp_import.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/ordered_json.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

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

namespace {

using ordered_json = nlohmann::ordered_json;
namespace limits   = vayu::core::constants::import_mcp;

template <typename T> using Refusable = std::expected<T, RouteError>;

constexpr std::int64_t METHOD_NOT_FOUND = -32601;

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

/// The connection, the request and the budget every call of one import shares.
struct McpSession {
    vayu::http::Client client;
    vayu::Request base;
    ImportBudget budget;
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

/// One call, sent within what is left of the import's deadline and counted
/// against its byte budget.
Refusable<McpCall>
send_call (McpSession& session, std::string_view method, ordered_json params) {
    ImportBudget& budget = session.budget;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds> (
    budget.deadline - std::chrono::steady_clock::now ());
    if (remaining.count () <= 0) {
        return std::unexpected (deadline_refusal (budget, method));
    }
    vayu::Request request = session.base;
    request.timeout_ms    = static_cast<int> (
    std::min<long long> (limits::CALL_TIMEOUT_MS, remaining.count ()));
    ordered_json call    = ordered_json::object ();
    call["method"]       = std::string (method);
    call["params"]       = std::move (params);
    request.body.content = call.dump ();

    McpCall sent;
    auto result = session.client.send (request);
    if (result.is_ok ()) {
        sent.response = std::move (result).value ();
    } else {
        sent.response.error_code    = result.error ().code;
        sent.response.error_message = result.error ().message;
    }
    if (sent.response.error_code == ErrorCode::Timeout &&
    std::chrono::steady_clock::now () >= budget.deadline) {
        return std::unexpected (deadline_refusal (budget, method));
    }
    budget.bytes += sent.response.body.size ();
    if (budget.bytes > budget.max_bytes) {
        return route_error (413,
        "The server's replies came to more than " +
        std::to_string (budget.max_bytes) + " bytes, the most one import reads");
    }
    sent.reply = read_mcp_reply (request, sent.response);
    return sent;
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

/// A server older than `server/discover`: `-32601`, or the plain `400` a
/// legacy-era server answers a modern request with. A failed transfer is not.
bool discovery_unanswered (const McpCall& call) {
    if (is_method_not_found (call)) {
        return true;
    }
    return call.reply.error_class == McpErrorClass::Transport &&
    !call.response.has_error () && call.response.status_code == 400 &&
    !call.reply.code.has_value ();
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

/// `serverInfo.name` from `server/discover`, or empty when the server is
/// older than the method or names nothing. Any other failure fails the import.
Refusable<std::string> discover_server_name (McpSession& session) {
    auto sent = send_call (session, "server/discover", ordered_json::object ());
    if (!sent) {
        return std::unexpected (sent.error ());
    }
    const McpCall& call = *sent;
    if (discovery_unanswered (call)) {
        return std::string ();
    }
    if (call.reply.error_class) {
        return std::unexpected (call_refusal ("server/discover", call));
    }
    const auto result = call_result (call);
    if (!result) {
        return std::string ();
    }
    const auto info = result->find ("serverInfo");
    if (info == result->end () || !info->is_object ()) {
        return std::string ();
    }
    const auto name = info->find ("name");
    return name != info->end () && name->is_string () ? name->get<std::string> () :
                                                        std::string ();
}

/// The array a list page keeps its entries under, or null when it has none.
ordered_json* page_rows (ordered_json& result, const char* key) {
    const auto rows = result.find (key);
    return rows == result.end () || !rows->is_array () ? nullptr : &*rows;
}

/// Every entry @p list answers, following `nextCursor` until a page carries
/// none; nothing for a `may_be_unknown` method the server does not know.
/// A cursor the server hands back a second time is refused: the list would
/// never end. Entries count against `MAX_ITEMS` across the whole import.
Refusable<std::optional<ordered_json>> list_all (McpSession& session, const ListMethod& list) {
    const std::string method (list.method);
    const auto no_list = [&] {
        return route_error (502, method + " answered with no '" + list.key + "' list");
    };
    ordered_json entries = ordered_json::array ();
    std::optional<std::string> cursor;
    std::set<std::string> sent_cursors;
    for (std::size_t pages = 0; pages < limits::MAX_PAGES; ++pages) {
        ordered_json params = ordered_json::object ();
        if (cursor) {
            params["cursor"] = *cursor;
            sent_cursors.insert (*cursor);
        }
        auto sent = send_call (session, list.method, std::move (params));
        if (!sent) {
            return std::unexpected (sent.error ());
        }
        const McpCall& call = *sent;
        if (pages == 0 && list.may_be_unknown && is_method_not_found (call)) {
            return std::optional<ordered_json> ();
        }
        if (call.reply.error_class) {
            return std::unexpected (call_refusal (list.method, call));
        }
        auto result = call_result (call);
        if (!result) {
            return no_list ();
        }
        ordered_json& page = *result;
        ordered_json* rows = page_rows (page, list.key);
        if (rows == nullptr) {
            return no_list ();
        }
        session.budget.items += rows->size ();
        if (session.budget.items > limits::MAX_ITEMS) {
            return route_error (413,
            "The server lists more than " + std::to_string (limits::MAX_ITEMS) +
            " tools, resources and prompts, the most one import reads");
        }
        for (auto& entry : *rows) {
            entries.push_back (std::move (entry));
        }
        const auto next = page.find ("nextCursor");
        if (next == page.end () || !next->is_string () ||
        next->get_ref<const std::string&> ().empty ()) {
            return std::optional<ordered_json> (std::in_place, std::move (entries));
        }
        cursor = next->get<std::string> ();
        if (sent_cursors.contains (*cursor)) {
            return route_error (502,
            method + " repeated a cursor it had already been sent, so the list would never end");
        }
    }
    return route_error (502,
    method + " still had a nextCursor after " +
    std::to_string (limits::MAX_PAGES) + " pages, the most one import follows");
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

Refusable<vayu::core::McpServerListing>
read_listing (McpSession& session, const McpImportTarget& target) {
    auto name = discover_server_name (session);
    if (!name) {
        return std::unexpected (name.error ());
    }
    vayu::core::McpServerListing listing;
    listing.url = target.base.url;
    listing.name = name->empty () ? url_host (target.base.url) : std::move (*name);
    listing.headers = target.caller_headers;
    listing.bearer  = target.bearer;

    using Listing    = vayu::core::McpServerListing;
    const auto steps = std::to_array<ListStep> ({
    { target.include.tools, &TOOLS_LIST, &Listing::tools },
    { target.include.resources, &RESOURCES_LIST, &Listing::resources },
    { target.include.resources, &TEMPLATES_LIST, &Listing::resource_templates },
    { target.include.prompts, &PROMPTS_LIST, &Listing::prompts },
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
 * `server/discover` is best effort, for its `serverInfo.name`: a server older
 * than the method (`-32601`, or a legacy-era plain `400`) is read on, while a
 * version refusal or any other failure fails the import with what the reply
 * reader said. Then each included list method, every page.
 *
 * @param transport `resolve_transport_policy (db)`, required for the reason
 *                  `import_fetch`'s is.
 * @param cancel    `RouteContext::server_stopping` (#2683).
 * @return {http_status, json_body}: 200 with the tree; 400 for a body that
 *         names no usable server, headers or auth, or a URL with userinfo;
 *         413 for a reply over `MAX_REPLY_BYTES`, replies over
 *         `MAX_TOTAL_BYTES` or a listing over `MAX_ITEMS`; 502 for a call
 *         that failed, a reply with no list, a repeated cursor, a list past
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
    auto target = read_target (body);
    if (!target) {
        return as_response (target.error ());
    }
    McpSession session{ vayu::http::Client (mcp_client_config (transport, cancel)),
        target->base,
        ImportBudget{ .deadline = std::chrono::steady_clock::now () + total_timeout,
        .total     = total_timeout,
        .max_bytes = max_total_bytes } };
    auto listing = read_listing (session, *target);
    if (!listing) {
        return as_response (listing.error ());
    }
    // A copy: `ordered_json` to `json` is a conversion, never a move.
    nlohmann::json result = vayu::core::mcp_import_result (*listing);
    return { 200, std::move (result) };
}

} // namespace vayu::http::routes
