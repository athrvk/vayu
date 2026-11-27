/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief Import endpoints - the URL proxy (`/import/fetch`) that fetches a
 *        remote collection/spec past browser CORS, and the atomic bulk write
 *        (`/import/apply`) that persists a parsed import in one call.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/log_text.hpp"
#include "vayu/utils/logger.hpp"

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

namespace vayu::http::routes {

httplib::Server::HandlerResponse reject_oversized_import (vayu::db::Database& db,
const httplib::Request& req,
httplib::Response& res) {
    if (req.method != "POST" || !req.has_header ("Content-Length")) {
        return httplib::Server::HandlerResponse::Unhandled;
    }
    if (req.path != "/import" && req.path != "/import/parse" && req.path != "/import/document" &&
    req.path != "/import/mcp" && req.path != "/import/mcp/diff") {
        return httplib::Server::HandlerResponse::Unhandled;
    }
    const size_t limit =
    vayu::core::constants::request_body::import_limit (spec_size_cap (db));
    const size_t length = req.get_header_value_u64 ("Content-Length");
    if (length <= limit) {
        return httplib::Server::HandlerResponse::Unhandled;
    }
    res.status = 413;
    res.set_content (
    error_body (413,
    "Request body is " + std::to_string (length) + " bytes, over the limit of " +
    std::to_string (limit) + " for an import (raise the 'maxSpecDocumentBytes' setting to allow more)")
    .dump (),
    "application/json");
    return httplib::Server::HandlerResponse::Handled;
}


// Defined in client_certificates.cpp; answers {http_status, json_body}.
std::pair<int, nlohmann::json>
create_client_certificate_response (vayu::db::Database& db, const nlohmann::json& json);

// Defined in import_mcp.cpp, the testable core of POST /import/mcp (#3838);
// returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

// Defined in import_mcp.cpp, the testable core of POST /import/mcp/diff
// (#3842); returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_mcp_diff_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

/**
 * One event of a streamed `/import/fetch` (#882); returns false once the
 * listener has gone. Declared here, not in `routes.hpp`, as `import_fetch` is:
 * the route's own testable seam, called only from this file and its tests.
 */
using ImportFetchEmitter =
std::function<bool (const std::string& event, const nlohmann::json& data)>;

/**
 * The client config both fetch forms build for @p request_body, for the wiring
 * test; nullopt when the body is refused. A fetch's bounds are not observable
 * from a test short enough to keep (a stall window is 30 seconds), so the test
 * asserts the config: drop the stall bound and every behavioural test stays
 * green while a 10 MB import fails at 30 seconds again. Taking the body lets
 * the test see a `reference` reach the client (#2364).
 */
std::optional<vayu::http::ClientConfig> import_fetch_client_config (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);

namespace {

/**
 * A validated fetch: what to get, the bound to get it under, and for a
 * reference (#2364) the connect-time rule it runs under. A reference is also
 * sent with redirects off: a hop is a target its document never named.
 */
struct FetchTarget {
    std::string url;
    size_t max_bytes = 0;
    std::optional<vayu::http::LocalPeerRule> reference;
};

/** The `{status, body}` answer a route sends instead of fetching anything. */
using FetchRefusal = std::pair<int, nlohmann::json>;

/// The member @p name of @p req, or null when it is absent or `null`: the
/// two spellings of "use the default".
const nlohmann::json* stated_field (const nlohmann::json& req, const char* name) {
    if (!req.is_object ()) {
        return nullptr;
    }
    const auto found = req.find (name);
    return found == req.end () || found->is_null () ? nullptr : &*found;
}

/// Whether @p url is one a fetch can be sent to: an http or https scheme,
/// stated rather than guessed.
bool names_sendable_scheme (const std::string& url) {
    return !vayu::http::unsendable_scheme (url) && !vayu::http::url_scheme (url).empty ();
}

/**
 * The caller's bound, clamped to the transport ceiling; absent or null is the
 * ceiling. Anything but a positive integer is refused, not rounded: a client
 * sending `0` or `-1` meant something, and guessing would be a silent bound.
 */
std::variant<size_t, FetchRefusal> read_max_bytes (const nlohmann::json& req) {
    const size_t ceiling = vayu::core::constants::import_fetch::MAX_BYTES;
    const nlohmann::json* stated = stated_field (req, "maxBytes");
    if (stated == nullptr) {
        return ceiling;
    }
    if (!stated->is_number_unsigned () || stated->get<uint64_t> () == 0) {
        return FetchRefusal{ 400,
            error_body (400, "Invalid 'maxBytes': must be a positive integer") };
    }
    return static_cast<size_t> (
    std::min (stated->get<uint64_t> (), static_cast<uint64_t> (ceiling)));
}

/**
 * `reference` (a boolean, default false) and `sourceUrl` (the http or https
 * URL of the document the reference was found in), as the rule a reference
 * runs under, or nullopt for a fetch a person asked for. A reference with no
 * source refuses every loopback and link-local peer. `sourceUrl` is validated
 * whether or not `reference` is set, so a malformed one is never silently
 * ignored.
 */
using ReferenceRule = std::optional<vayu::http::LocalPeerRule>;
std::variant<ReferenceRule, FetchRefusal> read_reference (const nlohmann::json& req) {
    const nlohmann::json* reference = stated_field (req, "reference");
    if (reference != nullptr && !reference->is_boolean ()) {
        return FetchRefusal{ 400, error_body (400, "Invalid 'reference': must be a boolean") };
    }

    vayu::http::LocalPeerRule rule;
    if (const nlohmann::json* source = stated_field (req, "sourceUrl")) {
        const std::string text = source->is_string () ? source->get<std::string> () : "";
        auto stated = names_sendable_scheme (text) ?
        vayu::http::local_peer_rule_for_source (text) :
        std::nullopt;
        if (!stated) {
            return FetchRefusal{ 400,
                error_body (400, "Invalid 'sourceUrl': must be an http or https URL") };
        }
        rule = std::move (*stated);
    }

    if (reference == nullptr || !reference->get<bool> ()) {
        return ReferenceRule{};
    }
    return ReferenceRule{ std::move (rule) };
}

/**
 * Reads and validates the body both fetch routes share, so the streaming route
 * judges it exactly as the buffered one does. A refusal is returned, not
 * thrown: both routes can still answer it with a status, as nothing has been
 * fetched or, when streaming, written.
 */
std::variant<FetchTarget, FetchRefusal> read_fetch_target (const std::string& request_body) {
    const auto parsed = parse_request_json (request_body);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const nlohmann::json& req = *parsed;

    if (!req.contains ("url") || !req["url"].is_string ()) {
        return FetchRefusal{ 400, error_body (400, "Invalid URL") };
    }
    const std::string url = req["url"].get<std::string> ();
    // The transfer refuses a non-HTTP scheme too (`validate_transferable`); this
    // answers it as the caller's 400, in the same words, rather than as a 502.
    // A URL naming no scheme is refused here alone: a fetch target is typed
    // whole, so there is no `{{baseUrl}}` to have left one off.
    if (auto problem = vayu::http::unsendable_scheme (url)) {
        return FetchRefusal{ 400, error_body (400, "Invalid URL: " + *problem) };
    }
    if (vayu::http::url_scheme (url).empty ()) {
        return FetchRefusal{ 400, error_body (400, "Invalid URL") };
    }

    auto max_bytes = read_max_bytes (req);
    if (auto* refusal = std::get_if<FetchRefusal> (&max_bytes)) {
        return std::move (*refusal);
    }
    auto reference = read_reference (req);
    if (auto* refusal = std::get_if<FetchRefusal> (&reference)) {
        return std::move (*refusal);
    }
    return FetchTarget{ url, std::get<size_t> (max_bytes),
        std::move (std::get<ReferenceRule> (reference)) };
}

/**
 * One finished fetch as the `{status, body}` both routes carry, the buffered
 * one as a status and the streaming one as an event: a 413 for a refused body,
 * a 502 for a failed hop or a non-2xx upstream answer, else the content and its
 * type.
 */
std::pair<int, nlohmann::json> fetch_outcome (const vayu::http::Client& client,
const Result<Response>& result) {
    if (!result.is_ok ()) {
        return { 502,
            error_body (502, "Couldn't fetch the document: " + client.last_error ()) };
    }

    const auto& resp = result.value ();
    if (resp.error_code == ErrorCode::ResponseTooLarge) {
        // Not a 502: the upstream answered, this engine refused its answer. The
        // message carries the clamped bound that applied, not the one asked
        // for, so a narrowed request reads the number that stopped it.
        return { 413, error_body (413, "Refused to fetch: " + resp.error_message) };
    }
    if (resp.has_error ()) {
        const std::string detail =
        resp.error_message.empty () ? "connection error" : resp.error_message;
        return { 502, error_body (502, "Couldn't fetch the document: " + detail) };
    }
    // The upstream answered, but not with the document: a 404 or 500 page
    // passed on as `content` would be reported as an unrecognised format,
    // blaming the file for the server's answer. The status names whose answer
    // it was.
    if (resp.status_code < 200 || resp.status_code >= 300) {
        return { 502,
            error_body (502, "The server answered HTTP " + std::to_string (resp.status_code)) };
    }
    // `Headers` compares without case and holds one value per name, so one
    // lookup covers every casing and shadows no duplicate.
    const auto declared            = resp.headers.find ("content-type");
    const std::string content_type = declared == resp.headers.end () ?
    std::string ("application/octet-stream") :
    declared->second;

    return { 200, nlohmann::json{ { "content", resp.body }, { "contentType", content_type } } };
}

/**
 * The client both fetch routes transfer on. They must not differ: `$ref`
 * bundling and spec re-fetch ride the buffered form and the import dialog the
 * streamed one, and a document timing out on only one would make the same
 * import depend on which surface asked.
 */
vayu::http::ClientConfig fetch_client_config (const FetchTarget& fetch,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    vayu::http::ClientConfig config;
    config.transport          = transport;
    config.max_response_bytes = fetch.max_bytes;
    config.local_peer_rule    = fetch.reference;
    config.cancel             = cancel;
    // A stall bound in place of the total (#882): a 30-second whole-transfer
    // timeout bounds a download's size, not its health (10 MB needs 340 KB/s
    // just to arrive). `max_response_bytes`, set above, bounds a transfer that
    // never ends.
    config.stall_timeout_ms = vayu::core::constants::import_fetch::STALL_TIMEOUT_MS;
    return config;
}

/// The GET both fetch routes send. A reference follows no redirect (#2364).
vayu::Request fetch_request (const FetchTarget& fetch) {
    vayu::Request request;
    request.method           = vayu::HttpMethod::GET;
    request.url              = fetch.url;
    request.follow_redirects = !fetch.reference.has_value ();
    return request;
}

/**
 * The refusal this body earns before anything is fetched, or none. Only the
 * streaming route needs it: `set_content_provider` commits a 200 the moment it
 * is installed, so a malformed request is caught while a status can still be
 * said.
 */
std::optional<FetchRefusal> import_fetch_refusal (const std::string& request_body) {
    auto target = read_fetch_target (request_body);
    if (const auto* refusal = std::get_if<FetchRefusal> (&target)) {
        return *refusal;
    }
    return std::nullopt;
}

} // namespace

std::optional<vayu::http::ClientConfig> import_fetch_client_config (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    const auto target = read_fetch_target (request_body);
    const auto* fetch = std::get_if<FetchTarget> (&target);
    if (fetch == nullptr) {
        return std::nullopt;
    }
    return fetch_client_config (*fetch, transport, cancel);
}

/**
 * Fetches the URL in @p request_body (`{url, maxBytes, reference,
 * sourceUrl}`) through libcurl.
 *
 * The caller states the bound (#784): this is one proxy for every URL import
 * (a Postman or Insomnia export as much as an OpenAPI document), so it has no
 * format to derive a cap from, and `maxSpecDocumentBytes` means nothing for
 * an export never stored as a `spec_documents` row; a spec fetcher passes
 * that cap itself. A bound over `constants::import_fetch::MAX_BYTES` is
 * clamped to it and an absent one is that ceiling, since a caller's bound is
 * no defence against a hostile URL. An over-bound response is a 413 naming
 * what was refused, never buffered whole (`ClientConfig::max_response_bytes`).
 *
 * `reference: true` marks a fetch a document asked for (a `$ref`, #2364): it
 * follows no redirect, so a 3xx gets any non-2xx answer's 502, and it refuses
 * a loopback or link-local peer other than `sourceUrl`'s own host and port
 * (`vayu::http::LocalPeerRule`) with a 502 naming that rule.
 *
 * @param transport How to reach the network: passed in so this stays
 *                  `Database`-free for unit tests, and required so no caller
 *                  gets a direct connection by forgetting it. Spec re-fetch
 *                  and `$ref` bundling ride this path, so it is what makes a
 *                  spec import by URL work behind a proxy (#705).
 * @param cancel    `ClientConfig::cancel`: the route's
 *                  `RouteContext::server_stopping` (#2683), required for the
 *                  reason @p transport is.
 * @return {http_status, json_body}.
 */
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    auto target = read_fetch_target (request_body);
    if (const auto* refusal = std::get_if<FetchRefusal> (&target)) {
        return *refusal;
    }
    const auto& fetch = std::get<FetchTarget> (target);

    vayu::http::Client client (fetch_client_config (fetch, transport, cancel));
    return fetch_outcome (client, client.send (fetch_request (fetch)));
}

/**
 * The same fetch, reporting the download as it arrives (#882). The buffered
 * route says nothing until libcurl has the whole body, and the wait is the
 * upstream download, so the report starts where the bytes do: the client's
 * write callback.
 *
 * Three events, the last always terminal: `progress` (`{received, total}`,
 * `total` null when the upstream declared no length), then `result`
 * (`{content, contentType}`) or `error` (`{error: {code, message}}`)
 * carrying what `import_fetch` would have answered.
 *
 * @param cancel as `import_fetch`'s.
 * @param emit one event; false once its listener has gone, which abandons the
 *             transfer rather than reading a download for nobody, and stops
 *             any further event, the outcome included.
 * @return `{400, body}` for a request refused before the fetch began, with
 *         nothing emitted, so a caller that has not committed a status can
 *         still send one; `{200, null}` otherwise, the outcome having gone
 *         out as an event.
 */
std::pair<int, nlohmann::json> import_fetch_stream (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel,
const ImportFetchEmitter& emit) {
    auto target = read_fetch_target (request_body);
    if (const auto* refusal = std::get_if<FetchRefusal> (&target)) {
        return *refusal;
    }
    const auto& fetch = std::get<FetchTarget> (target);

    bool listening             = true;
    bool reported_once         = false;
    uint64_t reported_at_bytes = 0;
    auto reported_at           = std::chrono::steady_clock::now ();

    vayu::http::ClientConfig client_config =
    fetch_client_config (fetch, transport, cancel);
    client_config.on_body_progress = [&] (uint64_t received,
                                     std::optional<uint64_t> declared_total) {
        const auto now = std::chrono::steady_clock::now ();
        const auto since =
        std::chrono::duration_cast<std::chrono::milliseconds> (now - reported_at)
        .count ();
        // The first report always goes out: it tells the dialog the download
        // started and its size, the one thing worth saying early.
        const bool due = !reported_once ||
        received - reported_at_bytes >= vayu::core::constants::import_fetch::PROGRESS_EVERY_BYTES ||
        since >= vayu::core::constants::import_fetch::PROGRESS_EVERY_MS;
        if (!due) {
            return true;
        }
        reported_once     = true;
        reported_at_bytes = received;
        reported_at       = now;
        listening = emit (vayu::core::constants::import_fetch::EVENT_PROGRESS,
        nlohmann::json{ { "received", received },
        { "total", declared_total ? nlohmann::json (*declared_total) : nlohmann::json () } });
        return listening;
    };

    vayu::http::Client client (client_config);
    const auto [status, body] =
    fetch_outcome (client, client.send (fetch_request (fetch)));

    // Nothing to a listener that has gone, including the failure its departure
    // caused (the client reports an abandoned transfer as a write error).
    if (listening) {
        if (status == 200) {
            emit (vayu::core::constants::import_fetch::EVENT_RESULT, body);
        } else {
            // The status rides inside the event, the status line having been
            // spent on the stream's 200. The error body alone would not carry
            // it (its `code` is a slug, and `default_error_code` has only
            // "error" for a 413), so a client could not tell a refused-for-size
            // document, the one distinction it acts on.
            nlohmann::json failure = body;
            failure["status"]      = status;
            emit (vayu::core::constants::import_fetch::EVENT_ERROR, failure);
        }
    }
    return { 200, nlohmann::json () };
}

namespace {

/**
 * Cap on items per `/import/apply` call. The whole payload is parsed and turned
 * into rows before anything is written, so an unbounded one is an unbounded
 * allocation; the limit sits well above any real collection (the largest
 * published Postman exports are a few thousand requests).
 */
constexpr size_t MAX_IMPORT_ITEMS = 10000;

/** A 400 about the payload as a whole. */
RouteError body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/**
 * A 400 naming the offending item by its temp id, so a client importing
 * hundreds can point at the one that failed. `item` is part of the documented
 * error shape, inside the error object beside the code and message.
 */
RouteError item_error (const std::string& message, const std::string& temp_id) {
    auto body             = error_body (400, message);
    body["error"]["item"] = temp_id;
    return { .status = 400, .body = body };
}

/**
 * One of the optional top-level arrays. Absent or null is an empty list (the
 * null-vs-absent rule's default); any other non-array is a 400 naming the
 * field, not a skipped section.
 */
RouteResult
read_items (const nlohmann::json& body, const char* key, const nlohmann::json*& out) {
    // Built on first call, not before `main`: a namespace-scope
    // `nlohmann::json` allocates during dynamic initialisation, where a throw
    // cannot be caught (`cert-err58-cpp`). Its address is what `out` hands
    // back, so it must outlive the call.
    static const nlohmann::json empty_items = nlohmann::json::array ();
    out                                     = &empty_items;
    if (!body.contains (key) || body[key].is_null ()) {
        return {};
    }
    if (!body[key].is_array ()) {
        return std::unexpected (
        body_error (std::string ("Invalid '") + key + "': must be an array"));
    }
    out = &body[key];
    return {};
}

/**
 * Validates one item's `tempId` and reserves a fresh real id for it. Temp ids
 * share one namespace across the sections because the response's `idMap` is one
 * flat map: a tempId reused between a collection and a request would make it
 * ambiguous, so it is a 400, not last-writer-wins. A supplied `id` is refused:
 * the engine owns ids here, and ignoring the field would leave a client
 * believing it was honoured.
 */
RouteResult claim_temp_id (const nlohmann::json& item,
const char* kind,
const char* prefix,
size_t index,
std::unordered_map<std::string, std::string>& id_map,
std::string& temp_id_out) {
    const std::string at = std::string (kind) + " at index " + std::to_string (index);
    if (!item.is_object ()) {
        return std::unexpected (body_error ("Invalid " + at + ": must be an object"));
    }
    if (item.contains ("id")) {
        return std::unexpected (body_error ("Invalid " +
        at + ": 'id' is not accepted - the engine assigns ids; reference items by 'tempId'"));
    }
    if (!item.contains ("tempId") || !item["tempId"].is_string () ||
    item["tempId"].get<std::string> ().empty ()) {
        return std::unexpected (
        body_error ("Invalid " + at + ": 'tempId' must be a non-empty string"));
    }
    temp_id_out = item["tempId"].get<std::string> ();
    if (id_map.contains (temp_id_out)) {
        return std::unexpected (
        item_error ("Duplicate tempId '" + temp_id_out + "'", temp_id_out));
    }
    id_map.emplace (temp_id_out, vayu::utils::generate_id (prefix));
    return {};
}

/**
 * One payload's temp-id namespace, fully resolved before any row is built:
 * the real id every tempId became, which tempIds are collections (the only legal
 * target of a reference), and each collection's parent by temp id.
 */
struct TempIds {
    std::unordered_map<std::string, std::string> real; // tempId -> engine id
    std::vector<std::string> collections;              // in payload order
    std::vector<std::string> requests;
    std::vector<std::string> environments;
    std::vector<std::string> specs;
    std::unordered_set<std::string> is_collection;
    std::unordered_set<std::string> is_spec;
    /// The engine ids the payload's spec section claimed: a collection may bind
    /// one before its row exists (`reject_unbindable_spec`'s `pending`).
    std::unordered_set<std::string> pending_spec_ids;
    std::unordered_map<std::string, std::string> parent_of; // collection -> its parent
};

/** Claims every tempId in one section, in payload order. */
RouteResult claim_section (const nlohmann::json& items,
const char* kind,
const char* prefix,
std::unordered_map<std::string, std::string>& id_map,
std::vector<std::string>& claimed) {
    claimed.reserve (items.size ());
    for (size_t i = 0; i < items.size (); ++i) {
        std::string temp;
        if (auto outcome = claim_temp_id (items[i], kind, prefix, i, id_map, temp); !outcome) {
            return outcome;
        }
        claimed.push_back (temp);
    }
    return {};
}

/** Pass 1 - claim every tempId across the four sections, then note the owners. */
RouteResult claim_all (const nlohmann::json& collections,
const nlohmann::json& requests,
const nlohmann::json& environments,
const nlohmann::json& specs,
TempIds& temps) {
    if (auto outcome = claim_section (
        collections, "collection", "col_", temps.real, temps.collections);
    !outcome) {
        return outcome;
    }
    if (auto outcome =
        claim_section (requests, "request", "req_", temps.real, temps.requests);
    !outcome) {
        return outcome;
    }
    if (auto outcome = claim_section (
        environments, "environment", "env_", temps.real, temps.environments);
    !outcome) {
        return outcome;
    }
    if (auto outcome = claim_section (specs, "spec", "spec_", temps.real, temps.specs);
    !outcome) {
        return outcome;
    }
    for (const auto& temp : temps.collections) {
        temps.is_collection.insert (temp);
    }
    for (const auto& temp : temps.specs) {
        temps.is_spec.insert (temp);
        temps.pending_spec_ids.insert (temps.real.at (temp));
    }
    return {};
}

/**
 * Pass 2a - resolve `parentTempId` against the claimed collection temp ids.
 * References may point forward, which is why this cannot happen during pass 1.
 */
RouteResult resolve_parents (const nlohmann::json& collections, TempIds& temps) {
    for (size_t i = 0; i < collections.size (); ++i) {
        const auto& item        = collections[i];
        const std::string& temp = temps.collections[i];
        if (!item.contains ("parentTempId") || item["parentTempId"].is_null ()) {
            continue;
        }
        if (!item["parentTempId"].is_string ()) {
            return std::unexpected (
            item_error ("Invalid 'parentTempId': must be a string or null", temp));
        }
        const std::string parent = item["parentTempId"].get<std::string> ();
        if (!temps.is_collection.contains (parent)) {
            return std::unexpected (
            item_error ("Unknown parentTempId '" + parent + "'", temp));
        }
        temps.parent_of.emplace (temp, parent);
    }
    return {};
}

/**
 * Pass 2b - rejects a cycle (a self-parent included) in the payload's own
 * parent graph, which `apply_collection_fields`' stored-tree walk cannot see
 * before these rows exist; a cycle makes cascade delete loop forever under the
 * global mutex (#79). Each chain is walked once: a node proven to reach a root
 * cannot start a cycle, so `acyclic` keeps this linear, not quadratic.
 */
RouteResult detect_parent_cycles (const TempIds& temps) {
    std::unordered_set<std::string> acyclic;
    for (const auto& temp : temps.collections) {
        std::vector<std::string> path;
        std::unordered_set<std::string> on_path;
        std::string cursor = temp;
        while (!acyclic.contains (cursor)) {
            if (!on_path.insert (cursor).second) {
                return std::unexpected (item_error (
                "Cycle in parentTempId references at '" + cursor + "'", temp));
            }
            path.push_back (cursor);
            auto next = temps.parent_of.find (cursor);
            if (next == temps.parent_of.end ()) {
                break;
            }
            cursor = next->second;
        }
        acyclic.insert (path.begin (), path.end ());
    }
    return {};
}

/**
 * Runs a field applier and turns either failure into a per-item 400: the
 * applier's error body (with `item` added), or a json type error from a
 * wrong-typed value, which must not escape as a 500: the payload is one
 * transaction, and the client would learn nothing of why it was lost.
 */
template <typename Apply>
RouteResult apply_item_fields (Apply apply, const char* kind, const std::string& temp_id) {
    RouteResult outcome;
    try {
        outcome = apply ();
    } catch (const nlohmann::json::exception& e) {
        return std::unexpected (
        item_error (std::string ("Invalid ") + kind + ": " + e.what (), temp_id));
    }
    if (!outcome) {
        // Inside the error object beside the applier's code and message, where
        // `item_error` puts it.
        RouteError refused            = outcome.error ();
        refused.body["error"]["item"] = temp_id;
        return std::unexpected (refused);
    }
    return {};
}

/**
 * Resolves a collection item's `openapi` binding into the shape the shared
 * applier stores. A payload-local spec is named by `openapi.specTempId`, as a
 * request names its owner by `collectionTempId`, and rewritten into the
 * `specId` the applier and readers expect. `specId` itself is accepted for a
 * document already stored (an incremental import), checked against the store by
 * `reject_unbindable_spec` with the payload's own. Both at once is a 400: two
 * answers to one question, and picking one would leave the caller believing the
 * other was honoured.
 */
RouteResult resolve_spec_binding (nlohmann::json& fields,
const TempIds& temps,
const std::string& temp) {
    auto binding = fields.find ("openapi");
    if (binding == fields.end () || binding->is_null () || !binding->is_object ()) {
        return {}; // Unbound, or a shape the applier will reject.
    }
    auto spec_temp = binding->find ("specTempId");
    if (spec_temp == binding->end () || spec_temp->is_null ()) {
        return {};
    }
    if (!spec_temp->is_string ()) {
        return std::unexpected (
        item_error ("Invalid 'openapi.specTempId': must be a string", temp));
    }
    if (binding->contains ("specId")) {
        return std::unexpected (
        item_error ("Invalid 'openapi': send either 'specTempId' (a "
                    "spec in this payload) or "
                    "'specId' (one already stored), not both",
        temp));
    }
    const std::string named = spec_temp->get<std::string> ();
    if (!temps.is_spec.contains (named)) {
        return std::unexpected (
        item_error ("Unknown openapi.specTempId '" + named + "'", temp));
    }
    binding->erase ("specTempId");
    (*binding)["specId"] = temps.real.at (named);
    return {};
}

/**
 * Refuses a collection item's `specFile` / `dataFile` (#2765): the applier
 * would store either, but a payload describes a document from elsewhere and a
 * binding is a path on this machine, which only `PUT /collections/:id` sets.
 * `null` is the default and passes.
 */
RouteResult refuse_file_bindings (const nlohmann::json& item, const std::string& temp) {
    for (const char* field : { "specFile", "dataFile" }) {
        if (item.contains (field) && !item[field].is_null ()) {
            return std::unexpected (item_error (
            std::format ("'{}' is not part of an import: it binds a file on "
                         "this machine, set with PUT /collections/:id",
            field),
            temp));
        }
    }
    return {};
}

/** Pass 3a - collection rows, through the same applier POST /collections uses. */
RouteResult build_collection_rows (vayu::db::Database& db,
const nlohmann::json& collections,
const TempIds& temps,
int64_t now,
SiblingSlots& slots,
std::vector<vayu::db::Collection>& out) {
    out.reserve (collections.size ());
    for (size_t i = 0; i < collections.size (); ++i) {
        const auto& item        = collections[i];
        const std::string& temp = temps.collections[i];

        nlohmann::json fields = item;
        auto parent           = temps.parent_of.find (temp);
        fields["parentId"]    = parent == temps.parent_of.end () ?
        nlohmann::json (nullptr) :
        nlohmann::json (temps.real.at (parent->second));

        if (auto outcome = refuse_file_bindings (item, temp); !outcome) {
            return outcome;
        }
        if (auto outcome = resolve_spec_binding (fields, temps, temp); !outcome) {
            return outcome;
        }

        vayu::db::Collection c;
        c.id         = temps.real.at (temp);
        c.created_at = now;
        c.updated_at = now;

        if (auto outcome = apply_item_fields (
            [&] {
                return apply_collection_fields (db, c, fields, /*is_create=*/true);
            },
            "collection", temp);
        !outcome) {
            return outcome;
        }

        if (!item.contains ("order") || item["order"].is_null ()) {
            if (auto outcome = apply_item_fields (
                [&] { return slots.take (db, c.parent_id, c.order); }, "collection", temp);
            !outcome) {
                return outcome;
            }
        }
        out.push_back (std::move (c));
    }
    return {};
}

/**
 * The examples nested on one request item (#481). They carry no tempId and are
 * no section: nothing references them, and ids in the shared namespace would
 * put `idMap` entries nobody asked for, so they ride their owner with engine
 * ids. They go through `apply_request_example_fields`, as
 * `POST /requests/:id/examples` does, so an imported and a created example
 * agree on defaults, required fields and the body cap.
 */
RouteResult build_example_rows (const nlohmann::json& item,
const std::string& request_id,
const std::string& temp,
int64_t now,
std::vector<vayu::db::RequestExample>& out) {
    if (!item.contains ("examples") || item["examples"].is_null ()) {
        return {};
    }
    if (!item["examples"].is_array ()) {
        return std::unexpected (
        item_error ("Invalid 'examples': must be an array", temp));
    }
    const auto& examples = item["examples"];
    if (examples.size () > vayu::core::constants::request_example::MAX_PER_REQUEST) {
        return std::unexpected (item_error (
        "Too many examples: " + std::to_string (examples.size ()) + " exceeds the limit of " +
        std::to_string (vayu::core::constants::request_example::MAX_PER_REQUEST) + " per request",
        temp));
    }

    for (size_t i = 0; i < examples.size (); ++i) {
        const auto& example = examples[i];
        if (!example.is_object ()) {
            return std::unexpected (
            item_error ("Invalid example: must be an object", temp));
        }
        if (example.contains ("id")) {
            return std::unexpected (item_error (
            "Invalid example: 'id' is not accepted - the engine assigns ids", temp));
        }

        vayu::db::RequestExample x;
        x.id         = vayu::utils::generate_id ("exa_");
        x.request_id = request_id;
        x.created_at = now;
        x.updated_at = now;

        if (auto outcome = apply_item_fields (
            [&] {
                return apply_request_example_fields (x, example, /*is_create=*/true);
            },
            "example", temp);
        !outcome) {
            return outcome;
        }
        // Payload order unless the payload states one: the create route's
        // append-scan would give every unstored row the same slot, the reason
        // `SiblingSlots` exists for collections and requests.
        if (!example.contains ("order") || example["order"].is_null ()) {
            x.order = static_cast<int> (i);
        }
        out.push_back (std::move (x));
    }
    return {};
}

/** Pass 3b - request rows, owner resolved from `collectionTempId`. */
RouteResult build_request_rows (vayu::db::Database& db,
const nlohmann::json& requests,
const TempIds& temps,
int64_t now,
SiblingSlots& slots,
std::vector<vayu::db::Request>& out,
std::vector<vayu::db::RequestExample>& examples_out) {
    out.reserve (requests.size ());
    for (size_t i = 0; i < requests.size (); ++i) {
        const auto& item        = requests[i];
        const std::string& temp = temps.requests[i];

        if (!item.contains ("collectionTempId") || !item["collectionTempId"].is_string ()) {
            return std::unexpected (
            item_error ("Invalid 'collectionTempId': must be the tempId "
                        "of a collection in this payload",
            temp));
        }
        const std::string owner = item["collectionTempId"].get<std::string> ();
        if (!temps.is_collection.contains (owner)) {
            return std::unexpected (
            item_error ("Unknown collectionTempId '" + owner + "'", temp));
        }

        nlohmann::json fields  = item;
        fields["collectionId"] = temps.real.at (owner);

        vayu::db::Request r;
        r.id         = temps.real.at (temp);
        r.created_at = now;
        r.updated_at = now;

        if (auto outcome = apply_item_fields (
            [&] {
                return apply_request_fields (db, r, fields, /*is_create=*/true);
            },
            "request", temp);
        !outcome) {
            return outcome;
        }
        if (!item.contains ("order") || item["order"].is_null ()) {
            if (auto outcome = apply_item_fields (
                [&] { return slots.take (db, r.collection_id, r.order); }, "request", temp);
            !outcome) {
                return outcome;
            }
        }
        const size_t examples_start = examples_out.size ();
        if (auto outcome = build_example_rows (item, r.id, temp, now, examples_out); !outcome) {
            return outcome;
        }
        // `mockExampleIndex` (#1649): a transient wire field naming, by
        // position among this item's examples, an OpenAPI import's
        // `x-vayu-mock` `"fixed"` target. Never stored, and resolved only now
        // that `build_example_rows` has minted the ids the parser could not
        // name.
        if (const auto index_field = item.find ("mockExampleIndex");
        index_field != item.end () && index_field->is_number_unsigned ()) {
            const size_t index = examples_start + index_field->get<size_t> ();
            if (index < examples_out.size ()) {
                r.mock_example_id = examples_out[index].id;
            }
        }
        out.push_back (std::move (r));
    }
    return {};
}

/**
 * Pass 3c - spec rows (#637). They reference nobody; collections reference
 * them, so they are claimed in pass 1 like the rest. No shared applier exists
 * (`POST /specs` is create-only with two settable fields), and the two
 * decisions that matter (the hash is computed here, never the caller's; the cap
 * is the live `maxSpecDocumentBytes`) go through the route core's helpers, so
 * the paths cannot drift.
 */
RouteResult build_spec_rows (vayu::db::Database& db,
const nlohmann::json& specs,
const TempIds& temps,
int64_t now,
std::vector<vayu::db::SpecDocument>& out) {
    out.reserve (specs.size ());
    const size_t cap = spec_size_cap (db);

    for (size_t i = 0; i < specs.size (); ++i) {
        const auto& item        = specs[i];
        const std::string& temp = temps.specs[i];

        if (!item.contains ("content") || !item["content"].is_string () ||
        item["content"].get<std::string> ().empty ()) {
            return std::unexpected (
            item_error ("Invalid 'content': must be a non-empty string", temp));
        }
        for (const char* derived : { "hash", "fetchedAt" }) {
            if (item.contains (derived)) {
                return std::unexpected (item_error (std::string ("Invalid '") +
                derived + "': computed by the engine; omit it",
                temp));
            }
        }

        vayu::db::SpecDocument s;
        s.id      = temps.real.at (temp);
        s.content = item["content"].get<std::string> ();
        if (s.content.size () > cap) {
            return std::unexpected (item_error ("Spec document is " +
            std::to_string (s.content.size ()) + " bytes, over the limit of " +
            std::to_string (cap) + " (raise the 'maxSpecDocumentBytes' setting to allow more)",
            temp));
        }
        s.hash       = spec_content_hash (s.content);
        s.fetched_at = now;
        if (auto reason = read_spec_indexes (item, s, cap)) {
            return std::unexpected (item_error (*reason, temp));
        }

        if (item.contains ("sourceUrl") && !item["sourceUrl"].is_null ()) {
            if (!item["sourceUrl"].is_string ()) {
                return std::unexpected (
                item_error ("Invalid 'sourceUrl': must be a string or null", temp));
            }
            const auto url = item["sourceUrl"].get<std::string> ();
            if (!url.empty ()) {
                s.source_url = url;
            }
        }
        out.push_back (std::move (s));
    }
    return {};
}

/** Pass 3d - environment rows; nothing to resolve, they reference nobody. */
RouteResult build_environment_rows (const nlohmann::json& environments,
const TempIds& temps,
int64_t now,
std::vector<vayu::db::Environment>& out) {
    out.reserve (environments.size ());
    for (size_t i = 0; i < environments.size (); ++i) {
        const std::string& temp = temps.environments[i];

        vayu::db::Environment e;
        e.id         = temps.real.at (temp);
        e.created_at = now;
        e.updated_at = now;

        if (auto outcome = apply_item_fields (
            [&] {
                return apply_environment_fields (e, environments[i], /*is_create=*/true);
            },
            "environment", temp);
        !outcome) {
            return outcome;
        }
        out.push_back (std::move (e));
    }
    return {};
}

} // namespace

/**
 * The existence check the shared applier cannot make, then the write: a binding
 * may name a spec this payload writes or one already stored, nothing else.
 * Checked last, under the write's lock: outside it, a binding could commit just
 * after a concurrent `DELETE /specs/:id` removed its document, the dangling
 * state the check prevents. Bounded: one JSON parse per collection row, inside
 * the transaction `import_apply` locks for anyway.
 */
RouteResult bind_and_apply_import (vayu::db::Database& db,
const TempIds& temps,
const std::unordered_map<std::string, std::string>& pending_hashes,
int64_t now,
std::vector<vayu::db::Collection>& collection_rows,
const std::vector<vayu::db::Request>& request_rows,
const std::vector<vayu::db::Environment>& environment_rows,
const std::vector<vayu::db::RequestExample>& example_rows,
const std::vector<vayu::db::SpecDocument>& spec_rows) {
    for (size_t i = 0; i < collection_rows.size (); ++i) {
        if (auto outcome = apply_item_fields (
            [&] {
                return reject_unbindable_spec (
                db, collection_rows[i].openapi, temps.pending_spec_ids);
            },
            "collection", temps.collections[i]);
        !outcome) {
            return outcome;
        }
        // Stamped here, not in `resolve_spec_binding`, so the recorded version
        // is read under the lock that proves the document exists, by the rule
        // `POST /collections` uses.
        if (auto stamped = vayu::core::stamp_spec_binding (collection_rows[i].openapi,
            [&] (const std::string& spec_id) -> std::optional<vayu::core::SpecStamp> {
                auto pending = pending_hashes.find (spec_id);
                if (pending != pending_hashes.end ()) {
                    return vayu::core::SpecStamp{ pending->second, now };
                }
                auto document = db.get_spec_document (spec_id);
                if (!document) {
                    return std::nullopt;
                }
                return vayu::core::SpecStamp{ document->hash, now };
            })) {
            collection_rows[i].openapi = std::move (*stamped);
        }
    }
    db.import_apply (collection_rows, request_rows, environment_rows, example_rows, spec_rows);
    return {};
}

/**
 * A `POST /import/apply` payload's `clientCertificates`, applied best-effort
 * after the tree's transaction commits (#1656).
 * `create_client_certificate_response` takes its own lock (#1455), so inside
 * `import_apply_response`'s `db.with_lock` it would deadlock. A candidate it
 * cannot register (a `(host, port)` claimed since the preview, an unreadable
 * file) is skipped rather than undoing a tree that does not reference it, the
 * trade `POST /globals` makes as the one write outside this payload
 * (`engine/CLAUDE.md`).
 */
void apply_client_certificate_candidates (vayu::db::Database& db,
const nlohmann::json& candidates) {
    for (const auto& candidate : candidates) {
        const auto [status, registered] = create_client_certificate_response (db, candidate);
        if (status == 200) {
            // The stored row's members, not the candidate's: the row carries
            // `hasPassphrase` where the candidate carries the passphrase.
            vayu::utils::log_info ("http",
            "POST /import/apply - registered an imported client certificate",
            { { "host", registered["host"] }, { "port", registered["port"] },
            { "certPath", registered["certPath"] } });
            continue;
        }
        vayu::utils::log_warning ("http",
        "POST /import/apply - skipped an imported client certificate candidate",
        { { "status", status },
        { "host",
        candidate.is_object () && candidate.contains ("host") &&
        candidate["host"].is_string () ?
        candidate["host"].get<std::string> () :
        std::string () } });
    }
}

/**
 * Testable core of POST /import/apply: a whole parsed import in one atomic
 * call, {http_status, json_body} (#96). The client sends opaque temp ids, the
 * engine assigns every real id through `generate_id`, and `idMap` translates;
 * one bad item is a 400 with zero rows written. The passes are separate because
 * references may point forward (a child collection before its parent) and every
 * row is built and validated before the first write. Rows go through the
 * single-item POST handlers' field appliers, so the paths agree on what a field
 * means and its default.
 */
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return as_response (body_error ("Body must be a JSON object"));
    }

    const nlohmann::json* collections  = nullptr;
    const nlohmann::json* requests     = nullptr;
    const nlohmann::json* environments = nullptr;
    const nlohmann::json* specs        = nullptr;
    // No section of the temp-id tree (a candidate names no parent and nothing
    // references it), so it gets `read_items`' shape check without joining
    // `claim_all` / `TempIds` (#1656).
    const nlohmann::json* client_certificates = nullptr;
    if (auto outcome = read_items (body, "collections", collections); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = read_items (body, "requests", requests); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = read_items (body, "environments", environments); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = read_items (body, "specs", specs); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = read_items (body, "clientCertificates", client_certificates); !outcome) {
        return as_response (outcome.error ());
    }

    // Nested examples count toward the cap: they are rows this call allocates
    // and writes, and 10000 requests each at its example maximum is the
    // unbounded payload the cap refuses.
    size_t nested_examples = 0;
    for (const auto& item : *requests) {
        if (item.is_object () && item.contains ("examples") && item["examples"].is_array ()) {
            nested_examples += item["examples"].size ();
        }
    }
    const size_t total = collections->size () + requests->size () +
    environments->size () + nested_examples + specs->size () +
    client_certificates->size ();
    if (total > MAX_IMPORT_ITEMS) {
        return as_response (body_error ("Import too large: " + std::to_string (total) +
        " items exceeds the limit of " + std::to_string (MAX_IMPORT_ITEMS) + " per call"));
    }

    TempIds temps;
    if (auto outcome = claim_all (*collections, *requests, *environments, *specs, temps);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = resolve_parents (*collections, temps); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = detect_parent_cycles (temps); !outcome) {
        return as_response (outcome.error ());
    }

    const int64_t now = now_ms ();
    std::vector<vayu::db::Collection> collection_rows;
    std::vector<vayu::db::Request> request_rows;
    std::vector<vayu::db::Environment> environment_rows;
    std::vector<vayu::db::RequestExample> example_rows;
    std::vector<vayu::db::SpecDocument> spec_rows;
    // Ahead of the collections that may bind them, so a binding is validated
    // against rows that have already been built.
    if (auto outcome = build_spec_rows (db, *specs, temps, now, spec_rows); !outcome) {
        return as_response (outcome.error ());
    }
    // One slot space per parent across both builders, so a request that
    // states no `order` lands after its folder's sub-folders (#2535).
    SiblingSlots slots;
    if (auto outcome = build_collection_rows (db, *collections, temps, now, slots, collection_rows);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = build_request_rows (
        db, *requests, temps, now, slots, request_rows, example_rows);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = build_environment_rows (*environments, temps, now, environment_rows);
    !outcome) {
        return as_response (outcome.error ());
    }

    // The hash of every spec this payload writes, by its future id: the half of
    // a binding the engine owns (#709), for documents
    // `stamp_binding_from_store` cannot look up before this transaction
    // commits.
    std::unordered_map<std::string, std::string> pending_hashes;
    pending_hashes.reserve (spec_rows.size ());
    for (const auto& row : spec_rows) {
        pending_hashes.emplace (row.id, row.hash);
    }

    // `bind_and_apply_import`'s check, under the write's lock.
    std::pair<int, nlohmann::json> result{ 200, nlohmann::json{ { "idMap", temps.real } } };
    db.with_lock ([&] {
        if (auto outcome = bind_and_apply_import (db, temps, pending_hashes, now,
            collection_rows, request_rows, environment_rows, example_rows, spec_rows);
        !outcome) {
            result = as_response (outcome.error ());
        }
    });
    if (result.first != 200) {
        return result;
    }
    apply_client_certificate_candidates (db, *client_certificates);
    return result;
}


/** Reads one optional boolean switch; present-and-not-boolean is a 400. */
RouteResult read_bool_option (const nlohmann::json& body, const char* key, bool& out) {
    const auto found = body.find (key);
    if (found == body.end () || found->is_null ()) {
        return {};
    }
    if (!found->is_boolean ()) {
        return std::unexpected (
        body_error (std::string ("Invalid '") + key + "': must be a boolean"));
    }
    out = found->get<bool> ();
    return {};
}

/** Reads one optional string field; present-and-not-a-string is a 400. */
RouteResult read_string_option (const nlohmann::json& body, const char* key, std::string& out) {
    const auto found = body.find (key);
    if (found == body.end () || found->is_null ()) {
        return {};
    }
    if (!found->is_string ()) {
        return std::unexpected (
        body_error (std::string ("Invalid '") + key + "': must be a string"));
    }
    out = found->get<std::string> ();
    return {};
}

/** Which halves of a document `POST /import/parse` is asked to read. */
RouteResult read_import_options (const nlohmann::json& body,
vayu::core::ImportOptions& options) {
    if (auto outcome = read_bool_option (body, "importEnvironments", options.import_environments);
    !outcome) {
        return outcome;
    }
    return read_bool_option (body, "importScripts", options.import_scripts);
}

/** Where the document came from, as the caller describes it. */
RouteResult read_import_source (const nlohmann::json& body, vayu::core::ImportSource& source) {
    if (auto outcome = read_string_option (body, "fileName", source.file_name); !outcome) {
        return outcome;
    }
    if (auto outcome = read_string_option (body, "sourceUrl", source.source_url); !outcome) {
        return outcome;
    }
    const auto found = body.find ("unresolvedRefs");
    if (found == body.end () || found->is_null ()) {
        return {};
    }
    if (!found->is_number_integer () || found->get<long long> () < 0) {
        return std::unexpected (body_error (
        "Invalid 'unresolvedRefs': must be a non-negative integer"));
    }
    source.unresolved_refs = found->get<int> ();
    return {};
}

/**
 * Testable core of POST /import/parse: the parse, answered, nothing written. It
 * takes a `Database` for the live cap and for the allowed folders and picked
 * files the bodies' `unresolved` is derived from (#2356).
 */
std::pair<int, nlohmann::json>
import_parse_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return as_response (body_error ("Body must be a JSON object"));
    }
    const auto content_field = body.find ("content");
    if (content_field == body.end () || !content_field->is_string ()) {
        return as_response (
        body_error ("Invalid 'content': must be the document's text"));
    }
    const auto content = content_field->get<std::string> ();
    if (content.empty ()) {
        return as_response (
        body_error ("Invalid 'content': an empty document is not an import"));
    }

    // A stored spec document's cap: an OpenAPI import stores these bytes and
    // the whole document is read into memory before anything is answered. A
    // Postman or Insomnia export is never stored but is read the same way, and
    // one bound is easier to explain than two.
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return { 413,
            error_body (413,
            "Import document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)") };
    }

    vayu::core::ImportOptions options;
    if (auto outcome = read_import_options (body, options); !outcome) {
        return as_response (outcome.error ());
    }
    vayu::core::ImportSource source;
    if (auto outcome = read_import_source (body, source); !outcome) {
        return as_response (outcome.error ());
    }

    vayu::core::ImportParse parsed = vayu::core::parse_import (content, options, source);
    if (!parsed.ok ()) {
        // Not folded into a parse failure: "Vayu does not read this kind of
        // file" and "this file is broken" are different answers, and the import
        // dialog says different things about them.
        return as_response (body_error (parsed.error));
    }
    // A copy: `ordered_json` to `json` is a conversion, never a move.
    nlohmann::json result = parsed.result;
    vayu::core::derive_import_file_trust (
    result, vayu::http::FileAccessPolicy::from_database (db));
    return { 200, std::move (result) };
}

/**
 * Testable core of POST /import/document: a document's bytes as a JSON DOM, for
 * one caller, the renderer's `ref-bundler.ts`, which inlines the files a
 * multi-file OpenAPI document references before it is parsed or stored (#649).
 * That needs the document as a tree, and a renderer YAML reader would keep
 * `js-yaml` in production `src/` (#877). So the bundler reads through
 * `core::read_document`, the reader behind `POST /specs`,
 * `POST /specs/describe` and `POST /import/parse`: exactly one parser has an
 * opinion. It stores and interprets nothing: what a document declares is
 * `POST /specs/describe`'s; this is what its bytes are.
 */
std::pair<int, nlohmann::json>
import_document_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return as_response (body_error ("Body must be a JSON object"));
    }
    const auto content_field = body.find ("content");
    if (content_field == body.end () || !content_field->is_string ()) {
        return as_response (
        body_error ("Invalid 'content': must be the document's text"));
    }
    const auto content = content_field->get<std::string> ();
    const size_t cap   = spec_size_cap (db);
    if (content.size () > cap) {
        return { 413,
            error_body (413,
            "Document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)") };
    }

    const vayu::core::DocumentRead read = vayu::core::read_document (content);
    if (!read.ok ()) {
        return as_response (body_error ("Invalid 'content': " + read.error));
    }
    return { 200, nlohmann::json{ { "document", read.root } } };
}

namespace {

/**
 * @p imported as it replaces @p stored, a global of the same name: an existing
 * variable is never restamped (`docs/engine/db-schema/indexes.md`,
 * VariableValue shape), so the stored `createdAt` (or its absence) wins over
 * the import's fresh one.
 */
nlohmann::json keep_stored_created_at (const nlohmann::json& stored, nlohmann::json imported) {
    if (!stored.is_object () || !imported.is_object ()) {
        return imported;
    }
    imported.erase ("createdAt");
    if (const auto created = stored.find ("createdAt"); created != stored.end ()) {
        imported["createdAt"] = *created;
    }
    return imported;
}

/**
 * Merges @p imported over a fresh read of the stored globals and writes the
 * result; the caller holds the DB mutex across the call. There is no merge
 * verb, and writing the import's globals alone would delete every global the
 * user had.
 *
 * @param before_write Test seam, invoked with the merged row staged and
 *        immediately before it is written.
 */
void merge_globals_locked (vayu::db::Database& db,
const nlohmann::json& imported,
const std::function<void ()>& before_write) {
    nlohmann::json merged = nlohmann::json::object ();
    if (const auto stored = db.get_globals ()) {
        const nlohmann::json existing =
        nlohmann::json::parse (stored->variables, nullptr, false);
        if (existing.is_object ()) {
            merged = existing;
        }
    }
    for (auto entry = imported.begin (); entry != imported.end (); ++entry) {
        const auto stored    = merged.find (entry.key ());
        merged[entry.key ()] = stored == merged.end () ?
        entry.value () :
        keep_stored_created_at (*stored, entry.value ());
    }
    vayu::db::Globals row;
    // Always the singleton's id: a row saved without it is one `get_globals`
    // never finds, a silent write (see `save_globals_response`).
    row.id         = "globals";
    row.variables  = merged.dump ();
    row.updated_at = now_ms ();
    if (before_write) {
        before_write ();
    }
    db.save_globals (row);
}

} // namespace

/**
 * Testable core of POST /import: parse a document and persist it, the verb
 * an agent wants (#877), since `POST /import/apply` takes a tree only a
 * renderer could build. It is `import_parse_response` and
 * `import_apply_response` with the flattening between them, not a
 * replacement: the app keeps both halves so a person gets a preview (which
 * files of a batch, what the two toggles do).
 *
 * **Globals are written last** (`ImportOrchestrator`'s rule): `POST /globals`
 * replaces the whole set, the one write here that can destroy data the import
 * did not create, so nothing can fail behind it and a failed import never
 * leaves globals half-rewritten. On a key collision the import wins: the
 * caller asked for this file's variables.
 *
 * **The globals read, merge and write are one lock scope** (#1906): a
 * `POST /globals` landing between read and write would be overwritten by a
 * merge computed without it. The client-certificate candidates are outside
 * it, applied by `import_apply_response` under their own lock.
 *
 * @param before_write Test seam, invoked inside the lock scope with the
 *        merged globals staged and immediately before they are written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> import_response (vayu::db::Database& db,
const nlohmann::json& body,
const std::function<void ()>& before_write) {
    auto [status, parsed] = import_parse_response (db, body);
    if (status != 200) {
        return { status, parsed };
    }

    const nlohmann::json payload   = vayu::core::import_apply_payload (parsed);
    auto [applied_status, applied] = import_apply_response (db, payload);
    if (applied_status != 200) {
        return { applied_status, applied };
    }

    const nlohmann::json& globals = parsed.at ("globals");
    if (!globals.empty ()) {
        db.with_lock ([&] { merge_globals_locked (db, globals, before_write); });
    }

    return { 200,
        nlohmann::json{ { "idMap", applied.at ("idMap") }, { "meta", parsed.at ("meta") },
        { "collections", payload.at ("collections").size () },
        { "requests", payload.at ("requests").size () },
        { "environments", payload.at ("environments").size () },
        { "globals", globals.size () } } };
}

std::pair<int, nlohmann::json>
import_response (vayu::db::Database& db, const nlohmann::json& body) {
    return import_response (db, body, nullptr);
}

namespace {

void handle_import_fetch (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const bool streaming =
    req.get_header_value ("Accept").find ("text/event-stream") != std::string::npos;
    vayu::utils::log_info ("http",
    std::string ("POST /import/fetch") + (streaming ? " (streaming)" : ""));

    if (!streaming) {
        auto [status, body] = import_fetch (req.body,
        vayu::http::resolve_transport_policy (ctx.db), &ctx.server_stopping);
        res.status          = status;
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
        return;
    }

    // Validated before the provider is installed, which commits a 200, so a
    // malformed body reads the same 400 on both forms. `import_fetch_stream`
    // re-reads the body (one parse of a four-field object) rather than the two
    // holding separate opinions of a valid request.
    if (const auto refusal = import_fetch_refusal (req.body)) {
        res.status = refusal->first;
        res.set_content (
        refusal->second.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
        return;
    }

    // Copied, not captured by reference: the provider runs after this
    // handler has returned and the `Request` is gone.
    const std::string body = req.body;
    const auto transport   = vayu::http::resolve_transport_policy (ctx.db);
    res.set_content_provider ("text/event-stream",
    [body, transport, &stopping = ctx.server_stopping] (size_t, httplib::DataSink& sink) {
        size_t frame = 0;
        const auto emit = [&sink, &frame] (
                          const std::string& event, const nlohmann::json& data) {
            if (!sink.is_writable ()) {
                return false;
            }
            // The shared framer, so this stream's frames cannot drift from
            // the run topics' shape.
            const std::string payload = vayu::core::build_sse_frame (event,
            data.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace), frame++);
            return sink.write (payload.data (), payload.size ());
        };
        import_fetch_stream (body, transport, &stopping, emit);
        sink.done ();
        return false;
    });
}

void handle_import_apply (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import/apply", body.error ());
        return;
    }
    // A validation failure is the core's 400; only a write or serialization
    // failure reaches this catch, and that is a 500, not the client's fault.
    try {
        auto [status, response] = import_apply_response (ctx.db, *body);
        if (status != 200) {
            vayu::utils::log_warning ("http",
            "POST /import/apply - " + std::to_string (status) + ": " +
            error_message_of (response));
        } else {
            vayu::utils::log_info ("http",
            "applied " + std::to_string (response["idMap"].size ()) + " items");
        }
        res.status = status;
        res.set_content (response.dump (), "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import/apply - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_import_parse (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import/parse", body.error ());
        return;
    }
    try {
        auto [status, response] = import_parse_response (ctx.db, *body);
        if (status != 200) {
            vayu::utils::log_warning ("http",
            "POST /import/parse - " + std::to_string (status) + ": " +
            error_message_of (response));
        } else {
            vayu::utils::log_info ("http",
            response["meta"]["format"].get<std::string> () + ", " +
            std::to_string (response["meta"]["requestCount"].get<int> ()) + " request(s)");
        }
        res.status = status;
        res.set_content (
        response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import/parse - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_import_mcp (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import/mcp", body.error ());
        return;
    }
    try {
        auto [status, response] = import_mcp_response (*body,
        vayu::http::resolve_transport_policy (ctx.db), &ctx.server_stopping);
        if (status != 200) {
            // A field, not the message: the reason can quote the server.
            vayu::utils::log_warning ("http",
            "POST /import/mcp - " + std::to_string (status),
            { { "reason", vayu::utils::bounded_log_text (error_message_of (response)) } });
        } else {
            vayu::utils::log_info ("http",
            "MCP server, " +
            std::to_string (response["meta"]["requestCount"].get<int> ()) + " request(s)");
        }
        res.status = status;
        res.set_content (
        response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import/mcp - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_import_mcp_diff (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import/mcp/diff", body.error ());
        return;
    }
    try {
        auto [status, response] = import_mcp_diff_response (ctx.db, *body,
        vayu::http::resolve_transport_policy (ctx.db), &ctx.server_stopping);
        if (status != 200) {
            // A field, not the message: the reason can quote the server.
            vayu::utils::log_warning ("http",
            "POST /import/mcp/diff - " + std::to_string (status),
            { { "reason", vayu::utils::bounded_log_text (error_message_of (response)) } });
        } else {
            vayu::utils::log_info ("http",
            "MCP server diff, " + std::to_string (response["matches"].size ()) +
            " matching collection(s)");
        }
        res.status = status;
        res.set_content (
        response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import/mcp/diff - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_import_document (RouteContext& ctx,
const httplib::Request& req,
httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import/document", body.error ());
        return;
    }
    try {
        auto [status, response] = import_document_response (ctx.db, *body);
        if (status != 200) {
            vayu::utils::log_warning ("http",
            "POST /import/document - " + std::to_string (status) + ": " +
            error_message_of (response));
        }
        res.status = status;
        res.set_content (
        response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import/document - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

void handle_import_preview (RouteContext& ctx, const httplib::Request& req, httplib::Response& res) {
    const auto body = parse_request_json (req.body);
    if (!body) {
        refuse_request_body (res, "POST /import", body.error ());
        return;
    }
    try {
        auto [status, response] = import_response (ctx.db, *body);
        if (status != 200) {
            vayu::utils::log_warning ("http",
            "POST /import - " + std::to_string (status) + ": " + error_message_of (response));
        } else {
            vayu::utils::log_info ("http",
            "imported " + std::to_string (response["requests"].get<size_t> ()) +
            " request(s) from " + response["meta"]["format"].get<std::string> ());
        }
        res.status = status;
        res.set_content (
        response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "http", "POST /import - Error: " + std::string (e.what ()));
        send_error (res, 500, e.what ());
    }
}

} // namespace

void register_import_routes (RouteContext& ctx) {
    /**
     * POST /import/fetch
     * Fetches a remote collection or spec past the renderer's CORS, for every
     * import format alike.
     * Body params: url (required, http/https), maxBytes (optional - the largest
     * response this fetch may read, clamped to the engine's transport ceiling;
     * absent means that ceiling), reference (optional boolean, default false -
     * a `$ref` fetch, #2364: no redirect is followed and a loopback or
     * link-local peer other than sourceUrl's own host and port is refused),
     * sourceUrl (optional http/https URL of the document the reference was
     * found in).
     * Returns: 200 `{"content", "contentType"}`, 400 on a bad url, maxBytes,
     * reference or sourceUrl, 413 when the response is over the bound, 502
     * when the fetch itself failed or a reference's peer was refused.
     *
     * With `Accept: text/event-stream` the same fetch streams (#882),
     * reporting the download as it arrives so a client can draw progress for
     * an 8 MB spec: `progress`, then one terminal `result` or `error`, as
     * `import_fetch_stream` describes. A malformed request is still the 400
     * above, decided before any response goes out; a caller sending no
     * `Accept` gets the buffered JSON.
     */
    ctx.server.Post ("/import/fetch",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_fetch (ctx, req, res);
    });

    /**
     * POST /import/apply
     * Persists an entire parsed import atomically: collections, requests,
     * environments and specs in one transaction, every real id generated
     * engine-side and returned in an `idMap` keyed by the client's temp ids;
     * client-certificate candidates are registered after it commits.
     * Body params: collections / requests / environments / specs /
     * clientCertificates (arrays; absent or null means none). Each tree item
     * carries a `tempId`; a collection may carry `parentTempId` and may bind a
     * spec with `openapi.specTempId` (a spec in this payload) or
     * `openapi.specId` (one already stored), a request must carry
     * `collectionTempId`, and a request may carry `examples` (written with
     * engine ids, absent from the `idMap`: nothing references them). A spec
     * item carries `content` and an optional `sourceUrl`; its `hash` and
     * `fetchedAt` are engine-computed and refused if sent. All other fields
     * are the matching POST /<resource>'s, minus `id` and a collection's
     * `specFile` / `dataFile`, refused (#2765).
     * Returns: 200 `{"idMap": {...}}`, or 400 with `error.item` naming the
     * item that failed - in which case nothing at all was written.
     */
    ctx.server.Post ("/import/apply",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_apply (ctx, req, res);
    });

    /**
     * POST /import/parse
     * Parses a raw import document - OpenAPI 2.0/3.x, Postman Collection
     * v2.0/v2.1, a Postman environment or globals export, an Insomnia v4
     * export, an Insomnia v5 collection or environment (#2119) or a JMeter
     * test plan - into the tree `POST /import/apply` then persists (#877).
     * Reads only; nothing is stored, and detection order is the app's.
     * Body params: content (required - the document's text, verbatim),
     * importEnvironments / importScripts (optional booleans, both default true),
     * fileName / sourceUrl (optional - what the caller knows about where the
     * bytes came from), unresolvedRefs (optional non-negative integer - external
     * `$ref`s a bundling pass could not reach, counted into `meta.skipped`).
     * Returns: 200 `{collections, environments, globals, meta}`, 400 for bytes
     * no format claims, an Insomnia document of a kind Vayu does not read (a
     * design document, a mock server) or a document that claimed a format and
     * is broken, 413 over `maxSpecDocumentBytes`.
     */
    ctx.server.Post ("/import/parse",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_parse (ctx, req, res);
    });

    /**
     * POST /import/mcp
     * Imports from a live MCP server (#3838): asks it what it offers and
     * answers the tree `POST /import/parse` would, so `POST /import/apply`
     * persists it unchanged. Reads only; nothing is stored.
     * Body params: url (required, http/https - the server's endpoint), headers
     * (optional - `[{name, value}]` lines or an object, as `POST /execute`
     * reads them), auth (optional - `{mode: "bearer", token}`), include
     * (optional - `{tools, resources, prompts}` booleans, default true, false,
     * false).
     * Returns: 200 `{collections, environments, globals, meta}`, 400 for a bad
     * url, headers, auth or include, 413 for a reply or a listing over its
     * bound, 502 when a call failed or a list never ended.
     */
    ctx.server.Post (
    "/import/mcp", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_mcp (ctx, req, res);
    });

    /**
     * POST /import/mcp/diff
     * What importing an MCP server again would change (#3842): reads the
     * server as `POST /import/mcp` does and compares the listing, keyed by
     * tool, prompt and resource identity, with every root collection whose
     * `mcpBaseUrl` holds the same url. Reads only; nothing is stored.
     * Body params: those of `POST /import/mcp`.
     * Returns: 200 `{matches: [{collectionId, name, identical, added, removed,
     * changed}]}` (empty when no collection matches), and every refusal of
     * `POST /import/mcp`.
     */
    ctx.server.Post ("/import/mcp/diff",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_mcp_diff (ctx, req, res);
    });

    /**
     * POST /import/document
     * Reads a document's bytes (JSON or YAML) into a JSON DOM, through the
     * engine's one reader. Stores nothing and interprets nothing - it is what
     * the bytes *are*, not what they declare (issue #877).
     * Body params: content (required - the document's text).
     * Returns: 200 `{"document": ...}`, 400 for bytes that are neither JSON nor
     * YAML, 413 over `maxSpecDocumentBytes`.
     */
    ctx.server.Post ("/import/document",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_document (ctx, req, res);
    });

    /**
     * POST /import
     * Parses a raw import document and persists it in one call (issue #877) -
     * `POST /import/parse` and `POST /import/apply` with the flattening between
     * them, for a caller with no preview to show. The tree lands atomically; the
     * globals a Postman globals export carries are merged afterwards, because
     * `POST /globals` replaces the whole set and must not run before a write
     * that can still fail.
     * Body params: the same as POST /import/parse.
     * Returns: 200 `{idMap, meta, collections, requests, environments, globals}`,
     * 400 for a document no format claims or one the apply refused, 413 over
     * `maxSpecDocumentBytes`.
     */
    ctx.server.Post ("/import", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        handle_import_preview (ctx, req, res);
    });
}

} // namespace vayu::http::routes
