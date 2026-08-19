/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_match.cpp
 * @brief `POST /specs/match` - which request of a collection is which operation
 *        of a document (issue #638's matcher, moved engine-side by #761).
 *
 * Binding a collection that already exists has to work out which of its
 * requests is which of the document's operations, and until #761 that lived in
 * the renderer - which put it out of reach of everything that is not the Spec
 * tab, MCP first among them. The rule itself is `core/operation_match.hpp`;
 * this is the one way to ask it, and it owns the two things a caller must not
 * be trusted with:
 *
 * - **Which requests are matched.** The whole subtree of the named collection,
 *   never a list the caller supplies. An OpenAPI import files its requests
 *   under one sub-collection per tag, so a bound root usually owns none
 *   directly - a caller passing "the collection's requests" would match against
 *   a set that silently excludes almost all of them, and the counts it then
 *   showed the user would be wrong rather than empty.
 * - **What an operation index may be.** The `operations` it is handed go
 *   through `validate_operations_index`, the same validator `POST /specs`
 *   applies to the index it stores, so a payload the store would refuse cannot
 *   first be matched against and reported on.
 *
 * It writes nothing and stores nothing: the caller sees the counts, and the
 * writes a bind performs are still `POST /specs` plus the collection and
 * request updates. That split is deliberate - the Spec tab shows this result
 * *before* the user commits to it, so a route that stored the document to
 * answer would store one for every document merely looked at.
 */

#include "vayu/core/operation_match.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/** The identity a match stamps, as `requests.spec_operation` writes it. */
nlohmann::json operation_json (const vayu::core::MatchableOperation& operation) {
    nlohmann::json out{ { "method", operation.method }, { "path", operation.path } };
    if (!operation.operation_id.empty ()) {
        // Absent rather than "", the same way the stored stamp omits it: an
        // operation that declares no `operationId` is not one whose id is empty.
        out["operationId"] = operation.operation_id;
    }
    return out;
}

} // namespace

/**
 * Testable core of POST /specs/match - the match, computed and returned,
 * nothing written.
 *
 * A collection that does not exist is a 404 rather than an empty match: "this
 * document matches none of your requests" and "you named a collection that is
 * not there" are different answers, and the first is one a caller would act on.
 */
std::pair<int, nlohmann::json>
match_spec_operations_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return { 400, error_body (400, "Invalid body: must be an object") };
    }

    const auto collection_id_field = json.find ("collectionId");
    if (collection_id_field == json.end () || !collection_id_field->is_string () ||
    collection_id_field->get<std::string> ().empty ()) {
        return { 400, error_body (400, "Invalid 'collectionId': must be a non-empty string") };
    }
    const auto collection_id = collection_id_field->get<std::string> ();

    const auto operations_field = json.find ("operations");
    if (operations_field == json.end ()) {
        return { 400, error_body (400, "Missing required field: operations") };
    }
    // The store's own validator, so a payload `POST /specs` would refuse cannot
    // be matched against here first.
    if (auto reason = vayu::core::validate_operations_index (*operations_field)) {
        return { 400, error_body (400, *reason) };
    }

    if (!db.get_collection (collection_id).has_value ()) {
        return { 404, error_body (404, "Collection not found") };
    }

    const auto collections = db.get_collections ();
    const auto subtree = collection_subtree_ids (collections, collection_id);
    std::vector<vayu::core::MatchableRequest> requests;
    for (const auto& collection : collections) {
        if (!subtree.contains (collection.id)) {
            continue;
        }
        for (const auto& request : db.get_requests_in_collection (collection.id)) {
            requests.push_back (
            { request.id, vayu::to_string (request.method), request.url });
        }
    }

    std::vector<vayu::core::MatchableOperation> operations;
    operations.reserve (operations_field->size ());
    for (const auto& row : *operations_field) {
        const auto id = row.find ("operationId");
        operations.push_back (
        { id != row.end () && id->is_string () ? id->get<std::string> () : std::string (),
        row["method"].get<std::string> (), row["path"].get<std::string> () });
    }

    const auto match = vayu::core::match_operations (requests, operations);

    nlohmann::json matched = nlohmann::json::array ();
    for (const auto& pair : match.matched) {
        matched.push_back ({ { "requestId", requests[pair.request].id },
        { "operation", operation_json (operations[pair.operation]) } });
    }
    nlohmann::json unmatched_requests = nlohmann::json::array ();
    for (const size_t index : match.unmatched_requests) {
        unmatched_requests.push_back (requests[index].id);
    }
    nlohmann::json unmatched_operations = nlohmann::json::array ();
    for (const size_t index : match.unmatched_operations) {
        unmatched_operations.push_back (operation_json (operations[index]));
    }

    return { 200,
        nlohmann::json{ { "matched", std::move (matched) },
        { "unmatchedRequests", std::move (unmatched_requests) },
        { "unmatchedOperations", std::move (unmatched_operations) } } };
}

void register_spec_match_routes (RouteContext& ctx) {
    /**
     * POST /specs/match
     * Pairs the requests in a collection's subtree with the operations a
     * document declares, by method and path shape. Reads only - nothing is
     * stored, stamped or created, so a caller may ask about a document it has
     * not decided to bind.
     * Body params: collectionId (required), operations (required - the same
     * identity rows `POST /specs` accepts as its `operations` index).
     * Returns: {matched, unmatchedRequests, unmatchedOperations}, 400, or 404
     * when the collection does not exist.
     */
    ctx.server.Post ("/specs/match",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = match_spec_operations_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/match - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("POST /specs/match - Matched " +
                std::to_string (body["matched"].size ()) + " request(s), " +
                std::to_string (body["unmatchedRequests"].size ()) + " unmatched, " +
                std::to_string (body["unmatchedOperations"].size ()) + " operation(s) unclaimed");
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/match - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
