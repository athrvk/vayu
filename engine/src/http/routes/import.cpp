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
#include "vayu/http/routes.hpp"
#include "vayu/http/client.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

/**
 * Fetch the URL in `request_body` ({"url": "..."}) via libcurl.
 * @return {http_status, json_body}. Separated from the route for unit testing.
 */
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body) {
    nlohmann::json req;
    try {
        req = nlohmann::json::parse (request_body);
    } catch (const std::exception&) {
        return { 400, error_body (400, "Invalid JSON body") };
    }

    if (!req.contains ("url") || !req["url"].is_string ()) {
        return { 400, error_body (400, "Invalid URL") };
    }
    const std::string url = req["url"].get<std::string> ();
    if (url.rfind ("http://", 0) != 0 && url.rfind ("https://", 0) != 0) {
        return { 400, error_body (400, "Invalid URL") };
    }

    vayu::http::Client client;
    auto result = client.get (url);
    if (!result.is_ok ()) {
        return { 502, error_body (502, "Failed to fetch: " + client.last_error ()) };
    }

    const auto& resp = result.value ();
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
std::pair<int, nlohmann::json> item_error (const std::string& message, const std::string& temp_id) {
    auto body                 = error_body (400, message);
    body["error"]["item"]     = temp_id;
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
        return body_error ("Invalid " + at +
        ": 'id' is not accepted - the engine assigns ids; reference items by 'tempId'");
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
    if (auto err = claim_section (collections, "collection", "col_", temps.real, temps.collections)) {
        return err;
    }
    if (auto err = claim_section (requests, "request", "req_", temps.real, temps.requests)) {
        return err;
    }
    if (auto err = claim_section (environments, "environment", "env_", temps.real, temps.environments)) {
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
            return item_error ("Invalid 'parentTempId': must be a string or null", temp);
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
                return item_error ("Cycle in parentTempId references at '" + cursor + "'", temp);
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
        return item_error (
        "Invalid 'openapi': send either 'specTempId' (a spec in this payload) or "
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
            [&] { return apply_collection_fields (db, c, fields, /*is_create=*/true); },
            "collection", temp)) {
            return err;
        }

        // An absent `order` means "append after the current siblings", which
        // apply_collection_fields computes from the *stored* rows - and inside a
        // bulk import none of the payload's own siblings are stored yet, so all of
        // them would land on the same number. Hand out consecutive slots from that
        // starting point instead, in payload order.
        if (!item.contains ("order") || item["order"].is_null ()) {
            const std::string sibling_key =
            fields["parentId"].is_null () ? std::string () : fields["parentId"].get<std::string> ();
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
std::optional<std::pair<int, nlohmann::json>>
build_example_rows (const nlohmann::json& item,
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
        std::to_string (vayu::core::constants::request_example::MAX_PER_REQUEST) +
        " per request",
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
            [&] { return apply_request_example_fields (x, example, /*is_create=*/true); },
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
            return item_error (
            "Invalid 'collectionTempId': must be the tempId of a collection in this payload", temp);
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
            [&] { return apply_request_fields (db, r, fields, /*is_create=*/true); }, "request", temp)) {
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
                return item_error (std::string ("Invalid '") + derived +
                "': computed by the engine; omit it",
                temp);
            }
        }

        vayu::db::SpecDocument s;
        s.id      = temps.real.at (temp);
        s.content = item["content"].get<std::string> ();
        if (s.content.size () > cap) {
            return item_error ("Spec document is " + std::to_string (s.content.size ()) +
            " bytes, over the limit of " + std::to_string (cap) +
            " (raise the 'maxSpecDocumentBytes' setting to allow more)",
            temp);
        }
        s.hash       = spec_content_hash (s.content);
        s.fetched_at = now;
        if (auto reason = read_spec_indexes (item, s, cap)) {
            return item_error (*reason, temp);
        }

        if (item.contains ("sourceUrl") && !item["sourceUrl"].is_null ()) {
            if (!item["sourceUrl"].is_string ()) {
                return item_error ("Invalid 'sourceUrl': must be a string or null", temp);
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
std::optional<std::pair<int, nlohmann::json>>
build_environment_rows (const nlohmann::json& environments,
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
            [&] { return apply_environment_fields (e, environments[i], /*is_create=*/true); },
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

    const nlohmann::json* collections   = nullptr;
    const nlohmann::json* requests      = nullptr;
    const nlohmann::json* environments  = nullptr;
    const nlohmann::json* specs         = nullptr;
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
                    return reject_unbindable_spec (db, collection_rows[i].openapi,
                    temps.pending_spec_ids);
                },
                "collection", temps.collections[i])) {
                result = *err;
                return;
            }
        }
        db.import_apply (collection_rows, request_rows, environment_rows, example_rows, spec_rows);
    });
    return result;
}

void register_import_routes (RouteContext& ctx) {
    ctx.server.Post ("/import/fetch",
    [] (const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info ("POST /import/fetch");
        auto [status, body] = import_fetch (req.body);
        res.status = status;
        res.set_content (
        body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
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
            vayu::utils::log_warning ("POST /import/apply - invalid JSON body: " +
            std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        // A validation failure is the core's 400; only a write or serialization
        // failure reaches this catch, and that is a 500, not the client's fault.
        try {
            auto [status, response] = import_apply_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /import/apply - " + std::to_string (status) +
                ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /import/apply - applied " +
                std::to_string (response["idMap"].size ()) + " items");
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("POST /import/apply - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
