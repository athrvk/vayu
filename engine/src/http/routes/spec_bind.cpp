/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_bind.cpp
 * @brief `POST /specs/bind` - store a document, bind a collection to it, and
 *        make every request's recorded identity agree with it, in one
 *        transaction (issue #862).
 *
 * A bind is three writes: the document, the binding that moves to it, and the
 * stamps. The renderer did all three itself and got away with it, barely - but
 * two of the three rules it had to hold are ones a client must not be trusted
 * with, and both had already been bugs.
 *
 * - **Stamping goes both ways** (issue #718). After a bind, a request's
 *   `specOperation` is the operation it matched in the bound document, or
 *   *nothing*. Writing only the matches leaves every non-matcher carrying
 *   identity from the document the collection was bound to before - and
 *   coverage resolves a stamp by `operationId` first, so such a stamp does not
 *   merely go unread: it claims whichever operation of the new document happens
 *   to share the id. Here the clearing is not a second list a caller could
 *   forget, it is the same walk that produced the matches.
 * - **The three writes are one transaction.** A bind that stored the document
 *   and then failed to move the binding leaves an unreferenced row; one that
 *   moved the binding and then failed to stamp leaves a collection measured
 *   against a contract its requests do not name. `POST /specs/sync` already
 *   established that a multi-row spec write commits whole, and this write is
 *   worse to land half of, because an agent retrying a partial bind re-stores a
 *   document against a binding that has already moved.
 *
 * **The match is this route's, and it is `core::match_operations`** - the same
 * rule `POST /specs/match` answers with, over the same subtree walk, never a
 * third matcher. The caller sends a document, not a pairing: an agent over MCP
 * has bytes and nothing else, and a pairing it worked out would be a second
 * opinion about what the document declares - exactly what #761's phase B moved
 * the reader engine-side to end. The operations matched against are the ones
 * *about to be stored*, read back from the index this write derives, so a
 * stamp and the index coverage resolves it through cannot disagree.
 *
 * Unbinding stays `PUT /collections/:id` with `openapi: null`: it writes one
 * row, deliberately leaves the stamps alone so that unbind-then-rebind is
 * lossless, and has no document to read.
 */

#include "vayu/core/openapi_document.hpp"
#include "vayu/core/operation_match.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

std::pair<int, nlohmann::json> body_error (const std::string& message) {
    return { 400, error_body (400, message) };
}

/** The identity a match stamps, as `requests.spec_operation` stores it. */
nlohmann::json operation_json (const vayu::core::MatchableOperation& operation) {
    nlohmann::json out{ { "method", operation.method }, { "path", operation.path } };
    if (!operation.operation_id.empty ()) {
        // Absent rather than "", the spelling `POST /specs/match` answers with
        // and the one `apply_spec_operation_field` stores: an operation that
        // declares no `operationId` is not one whose id is empty.
        out["operationId"] = operation.operation_id;
    }
    return out;
}

/**
 * The document row this bind stores.
 *
 * The document is read here and nowhere else in this route. One that cannot be
 * read is a 400 *before* anything is written, which is what leaves the
 * collection bound to whatever it was bound to.
 */
std::optional<std::pair<int, nlohmann::json>> read_bound_document (
const nlohmann::json& spec_item,
const std::string& content,
size_t cap,
int64_t now,
vayu::db::SpecDocument& spec) {
    spec.id         = vayu::utils::generate_id ("spec_");
    spec.content    = content;
    spec.hash       = spec_content_hash (content);
    spec.fetched_at = now;
    if (auto reason = read_spec_indexes (spec_item, spec, cap)) {
        return body_error (*reason);
    }
    if (spec_item.contains ("sourceUrl") && !spec_item["sourceUrl"].is_null ()) {
        if (!spec_item["sourceUrl"].is_string ()) {
            return body_error (
            "Invalid 'spec.sourceUrl': must be a string or null");
        }
        const auto url = spec_item["sourceUrl"].get<std::string> ();
        if (!url.empty ()) {
            spec.source_url = url;
        }
    }
    return std::nullopt;
}

/** What the matching pass did, which is what the route answers with. */
struct StampOutcome {
    size_t stamped                      = 0;
    size_t cleared                      = 0;
    nlohmann::json unmatched_requests   = nlohmann::json::array ();
    nlohmann::json unmatched_operations = nlohmann::json::array ();
};

/**
 * Which request carries which operation, and which carries none any more.
 *
 * The pairing is `core::match_operations` - the rule `POST /specs/match`
 * previews with. The operations it matches against are read back out of the
 * index this write is about to store rather than out of the document a second
 * time: the identity a request is stamped with has to be one
 * `OperationIndex::resolve` will find in the stored column, and reading both out
 * of one derivation is what guarantees it. `parse_declared_operations` returns
 * nothing for a document that declares none, which matches nothing and clears
 * everything - the honest outcome of binding a contract with no operations in it.
 */
std::optional<std::pair<int, nlohmann::json>> stamp_subtree (vayu::db::Database& db,
const std::vector<vayu::db::Request>& stored,
const vayu::db::SpecDocument& spec,
int64_t now,
vayu::db::SpecSyncBatch& batch,
StampOutcome& outcome) {
    std::vector<vayu::core::MatchableRequest> matchable;
    matchable.reserve (stored.size ());
    for (const auto& request : stored) {
        matchable.push_back (
        { request.id, vayu::to_string (request.method), request.url });
    }

    std::vector<vayu::core::MatchableOperation> operations;
    if (auto declared = vayu::core::parse_declared_operations (spec.operations)) {
        operations.reserve (declared->size ());
        for (const auto& row : *declared) {
            operations.push_back ({ row.operation_id, row.method, row.path });
        }
    }

    const auto match = vayu::core::match_operations (matchable, operations);

    std::unordered_set<size_t> matched_requests;
    matched_requests.reserve (match.matched.size ());
    for (const auto& pair : match.matched) {
        matched_requests.insert (pair.request);
        vayu::db::Request row = stored[pair.request];
        row.updated_at        = now;
        const nlohmann::json fields{ { "specOperation",
        operation_json (operations[pair.operation]) } };
        // Through the applier every other write of this column uses, so a
        // stamp written by a bind and one written by an import are the same
        // bytes, validated by the same rule.
        if (auto applied = apply_request_fields (db, row, fields, /*is_create=*/false);
        !applied) {
            return as_response (applied.error ());
        }
        batch.updated.push_back (std::move (row));
    }

    for (size_t i = 0; i < stored.size (); ++i) {
        // Only a request that *carries* one: clearing a column that is
        // already NULL would rewrite rows a bind never touched, and
        // `updated_at` is read.
        const auto& carried = stored[i].spec_operation;
        if (matched_requests.contains (i) || !carried || carried->empty ()) {
            continue;
        }
        vayu::db::Request row = stored[i];
        row.updated_at        = now;
        row.spec_operation    = std::nullopt;
        batch.updated.push_back (std::move (row));
        ++outcome.cleared;
    }

    outcome.stamped = match.matched.size ();
    for (const size_t index : match.unmatched_requests) {
        outcome.unmatched_requests.push_back (matchable[index].id);
    }
    for (const size_t index : match.unmatched_operations) {
        outcome.unmatched_operations.push_back (operation_json (operations[index]));
    }
    return std::nullopt;
}

/**
 * The whole bind, under the lock its caller holds: the document, the stamps and
 * the binding land together or not at all.
 */
std::pair<int, nlohmann::json> bind_locked (vayu::db::Database& db,
const std::string& collection_id,
const nlohmann::json& spec_item,
const std::string& content) {
    const auto collections = db.get_collections ();
    auto root = std::find_if (collections.begin (), collections.end (),
    [&] (const vayu::db::Collection& c) { return c.id == collection_id; });
    if (root == collections.end ()) {
        return { 404, error_body (404, "Collection not found") };
    }

    const size_t cap = spec_size_cap (db);
    if (content.size () > cap) {
        return body_error ("Spec document is " + std::to_string (content.size ()) +
        " bytes, over the limit of " + std::to_string (cap) +
        " (raise the 'maxSpecDocumentBytes' setting to allow more)");
    }

    const int64_t now = now_ms ();
    vayu::db::SpecSyncBatch batch;
    if (auto refusal = read_bound_document (spec_item, content, cap, now, batch.spec)) {
        return *refusal;
    }

    const auto subtree = collection_subtree_ids (collections, collection_id);
    const auto stored  = collection_subtree_requests (db, collections, subtree);

    StampOutcome outcome;
    if (auto refusal = stamp_subtree (db, stored, batch.spec, now, batch, outcome)) {
        return *refusal;
    }

    // The binding moves with the stamps.
    batch.binding         = *root;
    batch.binding.openapi = nlohmann::json{
        { "specId", batch.spec.id }, { "specHash", batch.spec.hash }, { "syncedAt", now }
    }.dump ();
    batch.binding.updated_at = now;

    db.spec_sync_apply (batch);

    return { 200,
        nlohmann::json{ { "specId", batch.spec.id },
        { "specHash", batch.spec.hash }, { "syncedAt", now },
        { "stamped", outcome.stamped }, { "cleared", outcome.cleared },
        { "unmatchedRequests", std::move (outcome.unmatched_requests) },
        { "unmatchedOperations", std::move (outcome.unmatched_operations) } } };
}

} // namespace


/**
 * Testable core of `POST /specs/bind`, returning {http_status, json_body}.
 *
 * Read-decide-write under one lock, on `delete_spec_document`'s rule (#386):
 * the subtree, the requests matched against and the write itself are one scope,
 * or a request created between the match and the commit is stamped as nothing
 * while the collection reports itself measured.
 */
std::pair<int, nlohmann::json>
bind_spec_response (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return body_error ("Body must be a JSON object");
    }

    std::string collection_id;
    if (auto outcome = apply_required_string_field (
        body, "collectionId", collection_id, /*is_create=*/true);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (collection_id.empty ()) {
        return body_error (
        "Invalid 'collectionId': must be a non-empty string");
    }

    if (!body.contains ("spec") || !body["spec"].is_object ()) {
        return body_error (
        "Invalid 'spec': must be an object with the document to bind");
    }
    const auto& spec_item = body["spec"];
    for (const char* engine_owned : { "id", "hash", "fetchedAt" }) {
        if (spec_item.contains (engine_owned)) {
            return body_error (std::string ("Invalid 'spec.") + engine_owned +
            "': computed by the engine; omit it");
        }
    }
    std::string content;
    if (auto outcome = apply_required_string_field (
        spec_item, "content", content, /*is_create=*/true);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (content.empty ()) {
        return body_error (
        "Invalid 'spec.content': an empty document is not a spec");
    }

    std::pair<int, nlohmann::json> result;
    db.with_lock (
    [&] { result = bind_locked (db, collection_id, spec_item, content); });
    return result;
}

void register_spec_bind_routes (RouteContext& ctx) {
    /**
     * POST /specs/bind
     * Binds a collection to an OpenAPI document: the document is stored, the
     * collection's binding moves to it, and every request in the collection's
     * subtree is stamped with the operation it matched or has its stamp
     * cleared - all in one transaction, so a bind either happened or did not.
     * The pairing is the engine's (`core::match_operations`, the rule
     * `POST /specs/match` previews with); the caller sends the document, never
     * a pairing.
     * Body params: collectionId (required), spec ({content, sourceUrl?} -
     * `id`, `hash`, `fetchedAt` and both indexes are engine-owned and
     * rejected). Returns: 200 `{specId, specHash, syncedAt, stamped, cleared,
     * unmatchedRequests, unmatchedOperations}`; 400 for a payload or a document
     * this cannot read, 404 for an unknown collection, 409 when a row moved
     * under the write. Nothing is written unless all of it is.
     */
    ctx.server.Post (
    "/specs/bind", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            vayu::utils::log_warning (
            "POST /specs/bind - invalid JSON body: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON body");
            return;
        }
        try {
            auto [status, response] = bind_spec_response (ctx.db, body);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/bind - " +
                std::to_string (status) + ": " + error_message_of (response));
            } else {
                vayu::utils::log_info ("POST /specs/bind - Bound to spec " +
                response["specId"].get<std::string> () + ": " +
                std::to_string (response["stamped"].get<size_t> ()) + " stamped, " +
                std::to_string (response["cleared"].get<size_t> ()) + " cleared");
            }
            res.status = status;
            res.set_content (response.dump (), "application/json");
        } catch (const vayu::db::MissingRowError& e) {
            // The lookups run under the same lock as the write, so this is the
            // narrow window a retry after a busy database opens - the same
            // conflict `POST /specs/sync` reports, and for the same reason:
            // nothing was written and re-reading is what the client should do.
            vayu::utils::log_warning (
            "POST /specs/bind - 409: " + std::string (e.what ()));
            send_error (res, 409, e.what ());
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/bind - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
