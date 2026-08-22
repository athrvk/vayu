/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/import.cpp
 * @brief Import endpoints - the URL proxy (`/import/fetch`) that fetches a
 *        remote collection/spec past browser CORS, and the atomic bulk write
 *        (`/import/apply`) that persists a parsed import in one call.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <cctype>
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

/**
 * @brief One event of a streamed `/import/fetch` (issue #882).
 *
 * Returns false once the listener has gone. Declared here rather than in
 * `routes.hpp` for the same reason `import_fetch` is: these two are the route's
 * own testable seam, and every caller is either in this file or a test that
 * names them.
 */
using ImportFetchEmitter =
std::function<bool (const std::string& event, const nlohmann::json& data)>;

/**
 * @brief The client config both fetch forms build, for the wiring test.
 *
 * The bounds a fetch runs under are not observable from its result on any test
 * short enough to keep - a stall window is 30 seconds - so the assertion is on
 * the config itself. What that catches is the line going missing: drop the stall
 * bound and every behavioural test stays green while a 10 MB import goes back to
 * failing at 30 seconds.
 */
vayu::http::ClientConfig import_fetch_client_config (size_t max_bytes,
const vayu::http::TransportPolicy& transport);

namespace {

/** A validated fetch: what to get, and the bound to get it under. */
struct FetchTarget {
    std::string url;
    size_t max_bytes = 0;
};

/** The `{status, body}` answer a route sends instead of fetching anything. */
using FetchRefusal = std::pair<int, nlohmann::json>;

/**
 * Read and validate the body both fetch routes share.
 *
 * Split out because the streaming route has to make exactly the same judgement
 * about exactly the same body, and a second copy of it would be a second
 * opinion about what a valid request is. A refusal is returned rather than
 * thrown because both routes can still answer it with a status: nothing has
 * been fetched, and on the streaming path nothing has been written.
 */
std::variant<FetchTarget, FetchRefusal> read_fetch_target (const std::string& request_body) {
    nlohmann::json req;
    try {
        req = nlohmann::json::parse (request_body);
    } catch (const std::exception&) {
        return FetchRefusal{ 400, error_body (400, "Invalid JSON body") };
    }

    if (!req.contains ("url") || !req["url"].is_string ()) {
        return FetchRefusal{ 400, error_body (400, "Invalid URL") };
    }
    const std::string url = req["url"].get<std::string> ();
    if (url.rfind ("http://", 0) != 0 && url.rfind ("https://", 0) != 0) {
        return FetchRefusal{ 400, error_body (400, "Invalid URL") };
    }

    // The caller's bound, clamped to the transport ceiling. Absent or null is
    // the ceiling; anything that is not a positive integer is refused rather
    // than rounded into one, because a client that sent `0` or `-1` meant
    // something, and guessing which would be the silent bound this whole change
    // exists to remove.
    size_t max_bytes = vayu::core::constants::import_fetch::MAX_BYTES;
    if (req.contains ("maxBytes") && !req["maxBytes"].is_null ()) {
        const auto& stated = req["maxBytes"];
        if (!stated.is_number_unsigned () || stated.get<uint64_t> () == 0) {
            return FetchRefusal{ 400,
                error_body (400, "Invalid 'maxBytes': must be a positive integer") };
        }
        max_bytes = static_cast<size_t> (
        std::min (stated.get<uint64_t> (), static_cast<uint64_t> (max_bytes)));
    }

    return FetchTarget{ url, max_bytes };
}

/**
 * Turn one finished fetch into the `{status, body}` both routes carry.
 *
 * Shared for the same reason the validator is: the buffered route answers this
 * with a status and the streaming one with an event, but *what* it says - a 413
 * for a refused body, a 502 for a failed hop, the content and its type for a
 * good one - must be the one answer.
 */
std::pair<int, nlohmann::json> fetch_outcome (const vayu::http::Client& client,
const Result<Response>& result) {
    if (!result.is_ok ()) {
        return { 502, error_body (502, "Failed to fetch: " + client.last_error ()) };
    }

    const auto& resp = result.value ();
    if (resp.error_code == ErrorCode::ResponseTooLarge) {
        // Not a 502: the upstream answered fine, this engine refused what it
        // was answering with. The message carries the bound that was applied -
        // the clamped one, not the one the caller asked for - so a client whose
        // request was narrowed reads the number that actually stopped it.
        return { 413, error_body (413, "Refused to fetch: " + resp.error_message) };
    }
    if (resp.has_error ()) {
        const std::string detail =
        resp.error_message.empty () ? "connection error" : resp.error_message;
        return { 502, error_body (502, "Failed to fetch: " + detail) };
    }
    std::string content_type = "application/octet-stream";
    for (const auto& [key, value] : resp.headers) {
        std::string lower = key;
        std::transform (lower.begin (), lower.end (), lower.begin (),
        [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
        if (lower == "content-type") {
            content_type = value;
            break;
        }
    }

    return { 200, nlohmann::json{ { "content", resp.body }, { "contentType", content_type } } };
}

/**
 * The client both fetch routes run their transfer on.
 *
 * Extracted because the two must not differ: `$ref` bundling and spec re-fetch
 * ride the buffered form while the import dialog rides the streamed one, and a
 * document that arrives on one and times out on the other would be the same
 * import succeeding or failing depending on which surface asked for it.
 */
vayu::http::ClientConfig fetch_client_config (size_t max_bytes,
const vayu::http::TransportPolicy& transport) {
    vayu::http::ClientConfig config;
    config.transport          = transport;
    config.max_response_bytes = max_bytes;
    // A stall bound in place of the total (issue #882). This route inherited
    // `Request::timeout_ms` - 30 seconds for the whole transfer - which bounds a
    // download's size rather than its health: 10 MB needed better than 340 KB/s
    // just to arrive, and the failure read "Operation timed out ... with 4177920
    // out of 6296254 bytes received" for a download that had never once stopped.
    // What bounds a transfer that truly never ends is `max_response_bytes`, set
    // just above.
    config.stall_timeout_ms = vayu::core::constants::import_fetch::STALL_TIMEOUT_MS;
    return config;
}

/**
 * The refusal this body earns before anything is fetched, or none.
 *
 * Only the streaming route needs it, and only because `set_content_provider`
 * commits a 200 the moment it is installed - so a malformed request has to be
 * recognized before that, while a status is still something this route can say.
 */
std::optional<FetchRefusal> import_fetch_refusal (const std::string& request_body) {
    auto target = read_fetch_target (request_body);
    if (const auto* refusal = std::get_if<FetchRefusal> (&target)) {
        return *refusal;
    }
    return std::nullopt;
}

} // namespace

vayu::http::ClientConfig import_fetch_client_config (size_t max_bytes,
const vayu::http::TransportPolicy& transport) {
    return fetch_client_config (max_bytes, transport);
}

/**
 * Fetch the URL in `request_body` ({"url": "...", "maxBytes": 12345}) via libcurl.
 *
 * The caller states the bound (issue #784). This route is one shared proxy for
 * every URL import - a Postman or Insomnia export comes through it exactly as an
 * OpenAPI document does - so it has no format to derive a cap from, and
 * `maxSpecDocumentBytes` governs nothing about an export that is never stored as
 * a `spec_documents` row. The callers that *are* fetching a spec pass that live
 * cap themselves; a stated bound over
 * `constants::import_fetch::MAX_BYTES` is clamped to it, and an absent one is
 * that ceiling, because a bound the caller chooses is not a bound against a
 * hostile URL. An over-bound response is a `413` naming what was refused,
 * without the whole body ever being buffered - see `ClientConfig::max_response_bytes`.
 *
 * @param transport How to reach the network. Passed in rather than resolved
 *                  here because this function is deliberately `Database`-free
 *                  so it can be unit tested - and required rather than
 *                  defaulted, so a future caller cannot acquire a direct
 *                  connection by forgetting an argument. Spec re-fetch and
 *                  `$ref` bundling ride this path, so it is what makes
 *                  importing a spec by URL work behind a proxy (issue #705).
 * @return {http_status, json_body}. Separated from the route for unit testing.
 */
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body,
const vayu::http::TransportPolicy& transport) {
    auto target = read_fetch_target (request_body);
    if (const auto* refusal = std::get_if<FetchRefusal> (&target)) {
        return *refusal;
    }
    const auto& fetch = std::get<FetchTarget> (target);

    vayu::http::Client client (fetch_client_config (fetch.max_bytes, transport));
    return fetch_outcome (client, client.get (fetch.url));
}

/**
 * The same fetch, reporting the download as it arrives (issue #882).
 *
 * Why this exists: an 8 MB spec behind a URL was a frozen import dialog. The
 * buffered route above cannot say anything until libcurl has the whole body, and
 * the wait is on the *upstream* download - so no amount of streaming between
 * engine and renderer would have helped. The report has to start where the bytes
 * do, which is the client's write callback.
 *
 * Three events, and the last one is always terminal: `progress`
 * (`{received, total}`, `total` null when the upstream declared no length),
 * then either `result` (`{content, contentType}`) or `error`
 * (`{error: {code, message}}`) carrying exactly what `import_fetch` would have
 * answered with.
 *
 * @param emit one event. Returns false once its listener has gone, which
 *             abandons the transfer rather than reading the rest of a download
 *             for nobody - and stops anything further being emitted, including
 *             the outcome.
 * @return `{400, body}` for a request refused before the fetch began; nothing
 *         has been emitted in that case, so a caller that has not yet committed
 *         a status can still send one. `{200, null}` otherwise: the outcome went
 *         out as an event.
 */
std::pair<int, nlohmann::json> import_fetch_stream (const std::string& request_body,
const vayu::http::TransportPolicy& transport,
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
    fetch_client_config (fetch.max_bytes, transport);
    client_config.on_body_progress = [&] (uint64_t received,
                                     std::optional<uint64_t> declared_total) {
        const auto now = std::chrono::steady_clock::now ();
        const auto since =
        std::chrono::duration_cast<std::chrono::milliseconds> (now - reported_at)
        .count ();
        // The first report always goes out: it is what tells the dialog the
        // download has started and how large it is, and holding it back for a
        // throttle window is holding back the only thing worth saying early.
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
    const auto [status, body] = fetch_outcome (client, client.get (fetch.url));

    // Nothing is said to a listener that has already gone - which includes the
    // failure its own departure caused, since the client reports an abandoned
    // transfer as the write error it is.
    if (listening) {
        if (status == 200) {
            emit (vayu::core::constants::import_fetch::EVENT_RESULT, body);
        } else {
            // The numeric status rides *inside* the event, because the status
            // line was spent on the 200 that opened the stream. The standard
            // error body alone would not carry it: its `code` is a slug, and
            // `default_error_code` has nothing but "error" for a 413 - so a
            // client could not tell a refused-for-size document from any other
            // failure, which is the one distinction it acts on.
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

/** Absent or null section - shared so `read_items` can hand out a stable empty list. */
const nlohmann::json EMPTY_ITEMS = nlohmann::json::array ();

/** A 400 about the payload as a whole. */
std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/**
 * A 400 that names the offending item by its temp id, so a client importing
 * hundreds of items can point at the one that failed. `item` is part of the
 * endpoint's documented error shape and sits *inside* the error object, next to
 * the code and message, so a client reads one place for the whole failure.
 */
std::pair<int, nlohmann::json>
item_error (const std::string& message, const std::string& temp_id) {
    auto body             = error_body (400, message);
    body["error"]["item"] = temp_id;
    return { 400, body };
}

/**
 * Reads one of the three optional top-level arrays. Absent or null means an
 * empty list (the null-vs-absent rule's "use the default"); anything else that
 * is not an array is a 400 naming the field rather than a silently skipped
 * section.
 */
std::optional<std::pair<int, nlohmann::json>>
read_items (const nlohmann::json& body, const char* key, const nlohmann::json*& out) {
    out = &EMPTY_ITEMS;
    if (!body.contains (key) || body[key].is_null ()) {
        return std::nullopt;
    }
    if (!body[key].is_array ()) {
        return body_error (std::string ("Invalid '") + key + "': must be an array");
    }
    out = &body[key];
    return std::nullopt;
}

/**
 * Validates one item's `tempId` and reserves a freshly generated real id for it.
 *
 * Temp ids share a single namespace across the three arrays, because the
 * response's `idMap` is one flat map - a tempId reused between a collection and
 * a request would make the map ambiguous, so it is a 400 rather than a
 * last-writer-wins surprise. A supplied `id` is rejected outright: the engine
 * owns ids here (that is the point of the endpoint), and silently ignoring the
 * field would leave a client believing its id was honoured.
 */
std::optional<std::pair<int, nlohmann::json>> claim_temp_id (const nlohmann::json& item,
const char* kind,
const char* prefix,
size_t index,
std::unordered_map<std::string, std::string>& id_map,
std::string& temp_id_out) {
    const std::string at = std::string (kind) + " at index " + std::to_string (index);
    if (!item.is_object ()) {
        return body_error ("Invalid " + at + ": must be an object");
    }
    if (item.contains ("id")) {
        return body_error ("Invalid " +
        at + ": 'id' is not accepted - the engine assigns ids; reference items by 'tempId'");
    }
    if (!item.contains ("tempId") || !item["tempId"].is_string () ||
    item["tempId"].get<std::string> ().empty ()) {
        return body_error ("Invalid " + at + ": 'tempId' must be a non-empty string");
    }
    temp_id_out = item["tempId"].get<std::string> ();
    if (id_map.contains (temp_id_out)) {
        return item_error ("Duplicate tempId '" + temp_id_out + "'", temp_id_out);
    }
    id_map.emplace (temp_id_out, vayu::utils::generate_id (prefix));
    return std::nullopt;
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
    /// The engine ids the payload's own spec section claimed. A collection may
    /// bind one of these even though no row exists yet, which is exactly what
    /// `reject_unbindable_spec`'s `pending` argument is for.
    std::unordered_set<std::string> pending_spec_ids;
    std::unordered_map<std::string, std::string> parent_of; // collection -> its parent
};

/** Claims every tempId in one section, in payload order. */
std::optional<std::pair<int, nlohmann::json>> claim_section (const nlohmann::json& items,
const char* kind,
const char* prefix,
std::unordered_map<std::string, std::string>& id_map,
std::vector<std::string>& claimed) {
    claimed.reserve (items.size ());
    for (size_t i = 0; i < items.size (); ++i) {
        std::string temp;
        if (auto err = claim_temp_id (items[i], kind, prefix, i, id_map, temp)) {
            return err;
        }
        claimed.push_back (temp);
    }
    return std::nullopt;
}

/** Pass 1 - claim every tempId across the four sections, then note the owners. */
std::optional<std::pair<int, nlohmann::json>> claim_all (const nlohmann::json& collections,
const nlohmann::json& requests,
const nlohmann::json& environments,
const nlohmann::json& specs,
TempIds& temps) {
    if (auto err = claim_section (
        collections, "collection", "col_", temps.real, temps.collections)) {
        return err;
    }
    if (auto err = claim_section (requests, "request", "req_", temps.real, temps.requests)) {
        return err;
    }
    if (auto err = claim_section (
        environments, "environment", "env_", temps.real, temps.environments)) {
        return err;
    }
    if (auto err = claim_section (specs, "spec", "spec_", temps.real, temps.specs)) {
        return err;
    }
    for (const auto& temp : temps.collections) {
        temps.is_collection.insert (temp);
    }
    for (const auto& temp : temps.specs) {
        temps.is_spec.insert (temp);
        temps.pending_spec_ids.insert (temps.real.at (temp));
    }
    return std::nullopt;
}

/**
 * Pass 2a - resolve `parentTempId` against the claimed collection temp ids.
 * References may point forward, which is why this cannot happen during pass 1.
 */
std::optional<std::pair<int, nlohmann::json>>
resolve_parents (const nlohmann::json& collections, TempIds& temps) {
    for (size_t i = 0; i < collections.size (); ++i) {
        const auto& item        = collections[i];
        const std::string& temp = temps.collections[i];
        if (!item.contains ("parentTempId") || item["parentTempId"].is_null ()) {
            continue;
        }
        if (!item["parentTempId"].is_string ()) {
            return item_error (
            "Invalid 'parentTempId': must be a string or null", temp);
        }
        const std::string parent = item["parentTempId"].get<std::string> ();
        if (!temps.is_collection.contains (parent)) {
            return item_error ("Unknown parentTempId '" + parent + "'", temp);
        }
        temps.parent_of.emplace (temp, parent);
    }
    return std::nullopt;
}

/**
 * Pass 2b - reject a cycle (including a self-parent) in the payload's own parent
 * graph. `apply_collection_fields`' stored-tree walk cannot see one, because none
 * of these rows exist yet - and a cycle is what makes cascade delete loop forever
 * under the global mutex (issue #79).
 *
 * Each chain is walked once: a node already proven to reach a root cannot start a
 * cycle, so `acyclic` keeps this linear rather than quadratic on a deeply nested
 * import.
 */
std::optional<std::pair<int, nlohmann::json>> detect_parent_cycles (const TempIds& temps) {
    std::unordered_set<std::string> acyclic;
    for (const auto& temp : temps.collections) {
        std::vector<std::string> path;
        std::unordered_set<std::string> on_path;
        std::string cursor = temp;
        while (!acyclic.contains (cursor)) {
            if (!on_path.insert (cursor).second) {
                return item_error (
                "Cycle in parentTempId references at '" + cursor + "'", temp);
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
    return std::nullopt;
}

/**
 * Runs a field applier and turns either failure mode into a per-item 400: the
 * applier's own error body (with `item` added), or a json type error thrown by a
 * wrong-typed value - which must not escape as a 500, since the whole payload is
 * one transaction and the client would be told nothing about why it was lost.
 */
template <typename Apply>
std::optional<std::pair<int, nlohmann::json>>
apply_item_fields (Apply apply, const char* kind, const std::string& temp_id) {
    std::optional<std::pair<int, nlohmann::json>> err;
    try {
        err = apply ();
    } catch (const nlohmann::json::exception& e) {
        return item_error (std::string ("Invalid ") + kind + ": " + e.what (), temp_id);
    }
    if (err) {
        // Inside the error object, next to the code and message the shared
        // applier already built - the same place `item_error` puts it.
        err->second["error"]["item"] = temp_id;
        return err;
    }
    return std::nullopt;
}

/**
 * Resolves one collection item's `openapi` binding into the shape the shared
 * applier stores.
 *
 * A payload-local spec is named by `openapi.specTempId`, exactly as a request
 * names its owner with `collectionTempId`, and is rewritten here into the
 * `specId` the applier and every reader expect. `specId` is also accepted
 * directly, for a collection binding a document that is *already* stored - an
 * incremental import into an existing spec - and that id is checked against the
 * store by `reject_unbindable_spec` alongside the payload's own.
 *
 * Both at once is a 400: they are two answers to one question, and picking one
 * would leave the caller believing the other was honoured.
 */
std::optional<std::pair<int, nlohmann::json>>
resolve_spec_binding (nlohmann::json& fields, const TempIds& temps, const std::string& temp) {
    auto binding = fields.find ("openapi");
    if (binding == fields.end () || binding->is_null () || !binding->is_object ()) {
        return std::nullopt; // Unbound, or a shape the applier will reject.
    }
    auto spec_temp = binding->find ("specTempId");
    if (spec_temp == binding->end () || spec_temp->is_null ()) {
        return std::nullopt;
    }
    if (!spec_temp->is_string ()) {
        return item_error ("Invalid 'openapi.specTempId': must be a string", temp);
    }
    if (binding->contains ("specId")) {
        return item_error ("Invalid 'openapi': send either 'specTempId' (a "
                           "spec in this payload) or "
                           "'specId' (one already stored), not both",
        temp);
    }
    const std::string named = spec_temp->get<std::string> ();
    if (!temps.is_spec.contains (named)) {
        return item_error ("Unknown openapi.specTempId '" + named + "'", temp);
    }
    binding->erase ("specTempId");
    (*binding)["specId"] = temps.real.at (named);
    return std::nullopt;
}

/** Pass 3a - collection rows, through the same applier POST /collections uses. */
std::optional<std::pair<int, nlohmann::json>> build_collection_rows (vayu::db::Database& db,
const nlohmann::json& collections,
const TempIds& temps,
int64_t now,
std::vector<vayu::db::Collection>& out) {
    out.reserve (collections.size ());
    // Parent real id ("" for a root) -> the next `order` to hand out.
    std::unordered_map<std::string, int> next_order;

    for (size_t i = 0; i < collections.size (); ++i) {
        const auto& item        = collections[i];
        const std::string& temp = temps.collections[i];

        nlohmann::json fields = item;
        auto parent           = temps.parent_of.find (temp);
        fields["parentId"]    = parent == temps.parent_of.end () ?
           nlohmann::json (nullptr) :
           nlohmann::json (temps.real.at (parent->second));

        if (auto err = resolve_spec_binding (fields, temps, temp)) {
            return err;
        }

        vayu::db::Collection c;
        c.id         = temps.real.at (temp);
        c.created_at = now;
        c.updated_at = now;

        if (auto err = apply_item_fields (
            [&] {
                return apply_collection_fields (db, c, fields, /*is_create=*/true);
            },
            "collection", temp)) {
            return err;
        }

        // An absent `order` means "append after the current siblings", which
        // apply_collection_fields computes from the *stored* rows - and inside a
        // bulk import none of the payload's own siblings are stored yet, so all of
        // them would land on the same number. Hand out consecutive slots from that
        // starting point instead, in payload order.
        if (!item.contains ("order") || item["order"].is_null ()) {
            const std::string sibling_key = fields["parentId"].is_null () ?
            std::string () :
            fields["parentId"].get<std::string> ();
            auto slot = next_order.try_emplace (sibling_key, c.order).first;
            c.order   = slot->second++;
        }
        out.push_back (std::move (c));
    }
    return std::nullopt;
}

/**
 * The examples nested on one request item (issue #481).
 *
 * Examples carry no tempId and are not a top-level section: nothing references
 * them, they exist only under the request they answer, and giving them ids in
 * the shared namespace would put entries in the response's `idMap` that no
 * client asked for. So they ride on their owner, and get engine-generated ids
 * like every other row here.
 *
 * The rows go through `apply_request_example_fields` - the same applier
 * `POST /requests/:id/examples` uses - so an imported example and a created one
 * cannot disagree about a default, a required field or the body cap.
 */
std::optional<std::pair<int, nlohmann::json>> build_example_rows (const nlohmann::json& item,
const std::string& request_id,
const std::string& temp,
int64_t now,
std::vector<vayu::db::RequestExample>& out) {
    if (!item.contains ("examples") || item["examples"].is_null ()) {
        return std::nullopt;
    }
    if (!item["examples"].is_array ()) {
        return item_error ("Invalid 'examples': must be an array", temp);
    }
    const auto& examples = item["examples"];
    if (examples.size () > vayu::core::constants::request_example::MAX_PER_REQUEST) {
        return item_error ("Too many examples: " + std::to_string (examples.size ()) +
        " exceeds the limit of " +
        std::to_string (vayu::core::constants::request_example::MAX_PER_REQUEST) + " per request",
        temp);
    }

    for (size_t i = 0; i < examples.size (); ++i) {
        const auto& example = examples[i];
        if (!example.is_object ()) {
            return item_error ("Invalid example: must be an object", temp);
        }
        if (example.contains ("id")) {
            return item_error (
            "Invalid example: 'id' is not accepted - the engine assigns ids", temp);
        }

        vayu::db::RequestExample x;
        x.id         = vayu::utils::generate_id ("exa_");
        x.request_id = request_id;
        x.created_at = now;
        x.updated_at = now;

        if (auto err = apply_item_fields (
            [&] {
                return apply_request_example_fields (x, example, /*is_create=*/true);
            },
            "example", temp)) {
            return err;
        }
        // Payload order, unless the payload states its own. The create route's
        // append-scan cannot help here: none of these rows are stored yet, so
        // every one of them would compute the same slot - the same reason
        // build_collection_rows hands out consecutive `order`s itself.
        if (!example.contains ("order") || example["order"].is_null ()) {
            x.order = static_cast<int> (i);
        }
        out.push_back (std::move (x));
    }
    return std::nullopt;
}

/** Pass 3b - request rows, owner resolved from `collectionTempId`. */
std::optional<std::pair<int, nlohmann::json>> build_request_rows (vayu::db::Database& db,
const nlohmann::json& requests,
const TempIds& temps,
int64_t now,
std::vector<vayu::db::Request>& out,
std::vector<vayu::db::RequestExample>& examples_out) {
    out.reserve (requests.size ());
    for (size_t i = 0; i < requests.size (); ++i) {
        const auto& item        = requests[i];
        const std::string& temp = temps.requests[i];

        if (!item.contains ("collectionTempId") || !item["collectionTempId"].is_string ()) {
            return item_error ("Invalid 'collectionTempId': must be the tempId "
                               "of a collection in this payload",
            temp);
        }
        const std::string owner = item["collectionTempId"].get<std::string> ();
        if (!temps.is_collection.contains (owner)) {
            return item_error ("Unknown collectionTempId '" + owner + "'", temp);
        }

        nlohmann::json fields  = item;
        fields["collectionId"] = temps.real.at (owner);

        vayu::db::Request r;
        r.id         = temps.real.at (temp);
        r.created_at = now;
        r.updated_at = now;

        if (auto err = apply_item_fields (
            [&] {
                return apply_request_fields (db, r, fields, /*is_create=*/true);
            },
            "request", temp)) {
            return err;
        }
        if (auto err = build_example_rows (item, r.id, temp, now, examples_out)) {
            return err;
        }
        out.push_back (std::move (r));
    }
    return std::nullopt;
}

/**
 * Pass 3c - spec rows (issue #637). They reference nobody; collections reference
 * *them*, which is why they are claimed in pass 1 like everything else.
 *
 * Deliberately not through a shared applier, because there is no field applier
 * to share: `POST /specs` is create-only with two settable fields, and the two
 * decisions that matter - the hash is computed here, never taken from the
 * caller, and the size cap is the live `maxSpecDocumentBytes` - are made by the
 * same two helpers the route core uses, so the paths cannot drift on either.
 */
std::optional<std::pair<int, nlohmann::json>> build_spec_rows (vayu::db::Database& db,
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
            return item_error ("Invalid 'content': must be a non-empty string", temp);
        }
        for (const char* derived : { "hash", "fetchedAt" }) {
            if (item.contains (derived)) {
                return item_error (std::string ("Invalid '") + derived + "': computed by the engine; omit it",
                temp);
            }
        }

        vayu::db::SpecDocument s;
        s.id      = temps.real.at (temp);
        s.content = item["content"].get<std::string> ();
        if (s.content.size () > cap) {
            return item_error ("Spec document is " +
            std::to_string (s.content.size ()) + " bytes, over the limit of " +
            std::to_string (cap) + " (raise the 'maxSpecDocumentBytes' setting to allow more)",
            temp);
        }
        s.hash       = spec_content_hash (s.content);
        s.fetched_at = now;
        if (auto reason = read_spec_indexes (item, s, cap)) {
            return item_error (*reason, temp);
        }

        if (item.contains ("sourceUrl") && !item["sourceUrl"].is_null ()) {
            if (!item["sourceUrl"].is_string ()) {
                return item_error (
                "Invalid 'sourceUrl': must be a string or null", temp);
            }
            const auto url = item["sourceUrl"].get<std::string> ();
            if (!url.empty ()) {
                s.source_url = url;
            }
        }
        out.push_back (std::move (s));
    }
    return std::nullopt;
}

/** Pass 3d - environment rows; nothing to resolve, they reference nobody. */
std::optional<std::pair<int, nlohmann::json>> build_environment_rows (
const nlohmann::json& environments,
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

        if (auto err = apply_item_fields (
            [&] {
                return apply_environment_fields (e, environments[i], /*is_create=*/true);
            },
            "environment", temp)) {
            return err;
        }
        out.push_back (std::move (e));
    }
    return std::nullopt;
}

} // namespace

/**
 * Testable core of POST /import/apply - persist a whole parsed import in one
 * atomic call, returning {http_status, json_body} (issue #96).
 *
 * The app used to POST every collection, request and environment individually,
 * which is why `POST /<resource>` had to accept a client-supplied id at all: the
 * orchestrator pre-assigned ids so it could wire `parentId` / `collectionId`
 * across a tree before any of it was persisted. Here the client sends opaque
 * temp ids instead, the engine assigns every real id via `generate_id`, and the
 * response's `idMap` translates one to the other. Nothing partial can survive: a
 * single bad item is a 400 with zero rows written, so the client-side
 * best-effort rollback is gone too.
 *
 * The passes below are separate because references may point forward - a child
 * collection is allowed to appear before its parent - and because every row must
 * be built and validated before the first one is written. The rows themselves go
 * through the same per-resource field appliers the single-item POST handlers use,
 * so the two paths cannot drift on what a field means or which value is a field's
 * default.
 *
 * Extracted for import_apply_route_test.cpp, following the suite's route-test
 * convention (no in-process HTTP server).
 */
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }

    const nlohmann::json* collections  = nullptr;
    const nlohmann::json* requests     = nullptr;
    const nlohmann::json* environments = nullptr;
    const nlohmann::json* specs        = nullptr;
    if (auto err = read_items (body, "collections", collections)) {
        return *err;
    }
    if (auto err = read_items (body, "requests", requests)) {
        return *err;
    }
    if (auto err = read_items (body, "environments", environments)) {
        return *err;
    }
    if (auto err = read_items (body, "specs", specs)) {
        return *err;
    }

    // Examples count toward the cap even though they are nested rather than a
    // section of their own: they are rows this call allocates and writes, and
    // 10000 requests each carrying their per-request maximum is exactly the
    // unbounded payload the cap exists to refuse.
    size_t nested_examples = 0;
    for (const auto& item : *requests) {
        if (item.is_object () && item.contains ("examples") && item["examples"].is_array ()) {
            nested_examples += item["examples"].size ();
        }
    }
    const size_t total = collections->size () + requests->size () +
    environments->size () + nested_examples + specs->size ();
    if (total > MAX_IMPORT_ITEMS) {
        return body_error ("Import too large: " + std::to_string (total) +
        " items exceeds the limit of " + std::to_string (MAX_IMPORT_ITEMS) + " per call");
    }

    TempIds temps;
    if (auto err = claim_all (*collections, *requests, *environments, *specs, temps)) {
        return *err;
    }
    if (auto err = resolve_parents (*collections, temps)) {
        return *err;
    }
    if (auto err = detect_parent_cycles (temps)) {
        return *err;
    }

    const int64_t now = now_ms ();
    std::vector<vayu::db::Collection> collection_rows;
    std::vector<vayu::db::Request> request_rows;
    std::vector<vayu::db::Environment> environment_rows;
    std::vector<vayu::db::RequestExample> example_rows;
    std::vector<vayu::db::SpecDocument> spec_rows;
    // Ahead of the collections that may bind them, so a binding is validated
    // against rows that have already been built.
    if (auto err = build_spec_rows (db, *specs, temps, now, spec_rows)) {
        return *err;
    }
    if (auto err = build_collection_rows (db, *collections, temps, now, collection_rows)) {
        return *err;
    }
    if (auto err = build_request_rows (db, *requests, temps, now, request_rows, example_rows)) {
        return *err;
    }
    if (auto err = build_environment_rows (*environments, temps, now, environment_rows)) {
        return *err;
    }

    // The hash of every spec this payload is about to write, by the id it will
    // be written under - the half of a binding the engine owns (issue #709),
    // for the documents `stamp_binding_from_store` cannot look up yet because
    // this transaction has not committed them.
    std::unordered_map<std::string, std::string> pending_hashes;
    pending_hashes.reserve (spec_rows.size ());
    for (const auto& row : spec_rows) {
        pending_hashes.emplace (row.id, row.hash);
    }

    // The one existence check the shared applier cannot make - a binding may
    // name a spec this payload is about to write, or one already stored, and
    // nothing else - and the last thing before the write, under the same lock
    // as the write. A binding validated outside the lock could be committed
    // just after a concurrent `DELETE /specs/:id` removed the document it
    // named, which is the dangling state the check exists to prevent. Bounded:
    // one JSON parse per collection row, then the transaction `import_apply`
    // was going to take the lock for anyway.
    std::pair<int, nlohmann::json> result{ 200, nlohmann::json{ { "idMap", temps.real } } };
    db.with_lock ([&] {
        for (size_t i = 0; i < collection_rows.size (); ++i) {
            if (auto err = apply_item_fields (
                [&] {
                    return reject_unbindable_spec (
                    db, collection_rows[i].openapi, temps.pending_spec_ids);
                },
                "collection", temps.collections[i])) {
                result = *err;
                return;
            }
            // Stamped here rather than in `resolve_spec_binding`, so that the
            // version a binding records is read under the same lock that proves
            // the document exists - and so import shares the rule with the two
            // collection write cores instead of keeping a second copy of it.
            if (auto stamped =
                vayu::core::stamp_spec_binding (collection_rows[i].openapi,
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
        db.import_apply (collection_rows, request_rows, environment_rows,
        example_rows, spec_rows);
    });
    return result;
}


/**
 * Testable core of POST /import/parse - the parse, answered, nothing written.
 *
 * Separated from the route for the reason every core here is: it takes a
 * `Database` only for the live cap, and a test can then hand it a document
 * rather than a socket.
 */
std::pair<int, nlohmann::json>
import_parse_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }
    const auto content_field = body.find ("content");
    if (content_field == body.end () || !content_field->is_string ()) {
        return body_error ("Invalid 'content': must be the document's text");
    }
    const auto content = content_field->get<std::string> ();
    if (content.empty ()) {
        return body_error (
        "Invalid 'content': an empty document is not an import");
    }

    // The same cap a stored spec document is held to, because an OpenAPI import
    // stores exactly these bytes and the whole document is read into memory
    // before anything is answered. A Postman or Insomnia export is never
    // stored, but it is read the same way, and one bound is easier to explain
    // than two.
    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return { 413,
            error_body (413,
            "Import document is " + std::to_string (content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)") };
    }

    vayu::core::ImportOptions options;
    if (auto found = body.find ("importEnvironments");
    found != body.end () && !found->is_null ()) {
        if (!found->is_boolean ()) {
            return body_error (
            "Invalid 'importEnvironments': must be a boolean");
        }
        options.import_environments = found->get<bool> ();
    }
    if (auto found = body.find ("importScripts");
    found != body.end () && !found->is_null ()) {
        if (!found->is_boolean ()) {
            return body_error ("Invalid 'importScripts': must be a boolean");
        }
        options.import_scripts = found->get<bool> ();
    }

    vayu::core::ImportSource source;
    if (auto found = body.find ("fileName"); found != body.end () && !found->is_null ()) {
        if (!found->is_string ()) {
            return body_error ("Invalid 'fileName': must be a string");
        }
        source.file_name = found->get<std::string> ();
    }
    if (auto found = body.find ("sourceUrl"); found != body.end () && !found->is_null ()) {
        if (!found->is_string ()) {
            return body_error ("Invalid 'sourceUrl': must be a string");
        }
        source.source_url = found->get<std::string> ();
    }
    if (auto found = body.find ("unresolvedRefs");
    found != body.end () && !found->is_null ()) {
        if (!found->is_number_integer () || found->get<long long> () < 0) {
            return body_error (
            "Invalid 'unresolvedRefs': must be a non-negative integer");
        }
        source.unresolved_refs = found->get<int> ();
    }

    vayu::core::ImportParse parsed = vayu::core::parse_import (content, options, source);
    if (!parsed.ok ()) {
        // "Unrecognised format" is kept as its own sentence rather than folded
        // into a parse failure: the two are different answers to the user - one
        // says "Vayu does not read this kind of file", the other "this file is
        // broken" - and the import dialog says different things about them.
        return body_error (parsed.error);
    }
    return { 200, std::move (parsed.result) };
}

/**
 * Testable core of POST /import/document - a document's bytes as a JSON DOM.
 *
 * The narrowest possible route, and it exists for one caller: the renderer's
 * `ref-bundler.ts`, which inlines the files a multi-file OpenAPI document
 * references *before* the document is parsed or stored (issue #649). Finding
 * and rewriting those `$ref`s needs the document as a tree, and a YAML reader
 * in the renderer to get one is the last thing that kept `js-yaml` in
 * production `src/` after #877 moved every parse here.
 *
 * So the bundler reads through the engine's reader - the same
 * `core::read_document` behind `POST /specs`, `POST /specs/describe` and
 * `POST /import/parse` - which is what makes "exactly one parser has an
 * opinion" true rather than nearly true. It stores nothing and interprets
 * nothing: what a document *declares* is `POST /specs/describe`, and this is
 * only what its bytes *are*.
 */
std::pair<int, nlohmann::json>
import_document_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }
    const auto content_field = body.find ("content");
    if (content_field == body.end () || !content_field->is_string ()) {
        return body_error ("Invalid 'content': must be the document's text");
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
        return body_error ("Invalid 'content': " + read.error);
    }
    return { 200, nlohmann::json{ { "document", read.root } } };
}


/**
 * Testable core of POST /import - parse a document and persist it.
 *
 * The verb an agent wants and the one thing MCP could not do about a spec
 * (issue #877): bind, describe, diff, sync, export and unbind were all
 * reachable, and *import a document* was not, because `POST /import/apply` took
 * a tree only a renderer could build. This is `import_parse_response` and
 * `import_apply_response` with the flattening between them.
 *
 * Not a replacement for either half. The app still parses and applies
 * separately, because a person gets a preview in between - which files of a
 * batch to include, what the two option toggles do to them - and this has none.
 *
 * **Globals are written last, and deliberately so** (the rule
 * `ImportOrchestrator` states): `POST /globals` replaces the whole set, so it is
 * the one write here that can destroy data the import did not create. Running it
 * after the apply means nothing can fail behind it, so a failed import never
 * leaves the user's globals half-rewritten. On a key collision the imported
 * value wins - the caller asked for this file's variables, and skipping them
 * would be the silent no-op.
 */
std::pair<int, nlohmann::json>
import_response (vayu::db::Database& db, const nlohmann::json& body) {
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
        // Merged from a fresh read rather than written over: the engine has no
        // merge verb, and writing the import's globals alone would silently
        // delete every global the user already had.
        nlohmann::json merged = nlohmann::json::object ();
        if (const auto stored = db.get_globals ()) {
            const nlohmann::json existing =
            nlohmann::json::parse (stored->variables, nullptr, false);
            if (existing.is_object ()) {
                merged = existing;
            }
        }
        for (auto entry = globals.begin (); entry != globals.end (); ++entry) {
            merged[entry.key ()] = entry.value ();
        }
        vayu::db::Globals row;
        // The singleton's id, always - a row saved without it is a row
        // `get_globals` will never find, which is the silent write this whole
        // resource has a history of (see `save_globals_response`).
        row.id         = "globals";
        row.variables  = merged.dump ();
        row.updated_at = now_ms ();
        db.save_globals (row);
    }

    return { 200,
        nlohmann::json{ { "idMap", applied.at ("idMap") }, { "meta", parsed.at ("meta") },
        { "collections", payload.at ("collections").size () },
        { "requests", payload.at ("requests").size () },
        { "environments", payload.at ("environments").size () },
        { "globals", globals.size () } } };
}

void register_import_routes (RouteContext& ctx) {
    /**
     * POST /import/fetch
     * Fetches a remote collection or spec past the renderer's CORS, for every
     * import format alike.
     * Body params: url (required, http/https), maxBytes (optional - the largest
     * response this fetch may read, clamped to the engine's transport ceiling;
     * absent means that ceiling).
     * Returns: 200 `{"content", "contentType"}`, 400 on a bad url or maxBytes,
     * 413 when the response is over the bound, 502 when the fetch itself failed.
     *
     * With `Accept: text/event-stream` the same fetch answers as a stream
     * instead (issue #882), reporting the download as it arrives so a client
     * can draw a progress bar for an 8 MB spec rather than freeze on it:
     * `progress` (`{received, total}`, `total` null when the upstream declared
     * no length), then one terminal `result` (`{content, contentType}`) or
     * `error` (`{error: {code, message}}`) carrying what the buffered form
     * would have answered with. A malformed *request* is still the 400 above,
     * because that is decided before any of the response has gone out. Every
     * existing caller sends no `Accept` and gets the buffered JSON unchanged.
     */
    ctx.server.Post ("/import/fetch",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const bool streaming = req.get_header_value ("Accept").find (
                               "text/event-stream") != std::string::npos;
        vayu::utils::log_info (
        std::string ("POST /import/fetch") + (streaming ? " (streaming)" : ""));

        if (!streaming) {
            auto [status, body] =
            import_fetch (req.body, vayu::http::resolve_transport_policy (ctx.db));
            res.status = status;
            res.set_content (
            body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
            "application/json");
            return;
        }

        // Validated before the provider is installed, while a status is still
        // available to answer with: `set_content_provider` commits a 200, and a
        // client that sent a malformed body should read the same 400 on both
        // forms of this route. `import_fetch_stream` reads the body again for
        // itself - one parse of a two-field object - rather than the two of them
        // holding separate opinions about what a valid request is.
        if (const auto refusal = import_fetch_refusal (req.body)) {
            res.status = refusal->first;
            res.set_content (refusal->second.dump (-1, ' ', false,
                             nlohmann::json::error_handler_t::replace),
            "application/json");
            return;
        }

        // Copied, not captured by reference: the provider runs after this
        // handler has returned and the `Request` is gone.
        const std::string body = req.body;
        const auto transport   = vayu::http::resolve_transport_policy (ctx.db);
        res.set_content_provider ("text/event-stream",
        [body, transport] (size_t, httplib::DataSink& sink) {
            size_t frame    = 0;
            const auto emit = [&sink, &frame] (const std::string& event,
                              const nlohmann::json& data) {
                if (!sink.is_writable ()) {
                    return false;
                }
                // The shared framer, so this stream's frames cannot drift from
                // the run topics' shape.
                const std::string payload = vayu::core::build_sse_frame (event,
                data.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
                frame++);
                return sink.write (payload.data (), payload.size ());
            };
            import_fetch_stream (body, transport, emit);
            sink.done ();
            return false;
        });
    });

    /**
     * POST /import/apply
     * Persists an entire parsed import atomically: collections, their requests
     * and environments in one transaction, with every real id generated
     * engine-side and returned in an `idMap` keyed by the client's temp ids.
     * Body params: collections / requests / environments / specs (arrays; absent
     * or null means none). Each item carries a `tempId`; a collection may carry
     * `parentTempId` and may bind a spec with `openapi.specTempId` (a spec in
     * this payload) or `openapi.specId` (one already stored), a request must
     * carry `collectionTempId`, and a request may carry `examples` (an array of
     * saved example responses, written with engine-generated ids and absent from
     * the `idMap` - nothing references them). A spec item carries `content` and
     * an optional `sourceUrl`; its `hash` and `fetchedAt` are engine-computed
     * and rejected if sent. All other fields are the ones the matching
     * POST /<resource> accepts, minus `id`.
     * Returns: 200 `{"idMap": {...}}`, or 400 with `error.item` naming the
     * item that failed - in which case nothing at all was written.
     */
    ctx.server.Post ("/import/apply",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /import/apply - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        // A validation failure is the core's 400; only a write or serialization
        // failure reaches this catch, and that is a 500, not the client's fault.
        try {
            auto [status, response] = import_apply_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /import/apply - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /import/apply - applied " +
                std::to_string (response["idMap"].size ()) + " items");
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /import/apply - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /import/parse
     * Parses a raw import document - OpenAPI 2.0/3.x, Postman Collection
     * v2.0/v2.1, a Postman environment or globals export, or an Insomnia v4
     * export - into the tree `POST /import/apply` then persists (issue #877).
     * Reads only; nothing is stored, and detection order is the app's.
     * Body params: content (required - the document's text, verbatim),
     * importEnvironments / importScripts (optional booleans, both default true),
     * fileName / sourceUrl (optional - what the caller knows about where the
     * bytes came from), unresolvedRefs (optional non-negative integer - external
     * `$ref`s a bundling pass could not reach, counted into `meta.skipped`).
     * Returns: 200 `{collections, environments, globals, meta}`, 400 for bytes
     * no format claims or a document that claimed one and is broken, 413 over
     * `maxSpecDocumentBytes`.
     */
    ctx.server.Post ("/import/parse",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /import/parse - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = import_parse_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /import/parse - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /import/parse - " +
                response["meta"]["format"].get<std::string> () + ", " +
                std::to_string (response["meta"]["requestCount"].get<int> ()) + " request(s)");
            }
            res.status = status;
            res.set_content (
            response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
            "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /import/parse - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
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
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /import/document - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = import_document_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /import/document - " +
                std::to_string (status) + ": " + error_message_of (response));
            }
            res.status = status;
            res.set_content (
            response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
            "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /import/document - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
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
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /import - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = import_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /import - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /import - imported " +
                std::to_string (response["requests"].get<size_t> ()) +
                " request(s) from " + response["meta"]["format"].get<std::string> ());
            }
            res.status = status;
            res.set_content (
            response.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
            "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /import - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
