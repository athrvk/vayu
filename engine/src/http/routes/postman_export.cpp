/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/postman_export.cpp
 * @brief `POST /export/postman` - a collection out as a Postman Collection
 *        v2.1.0 document.
 *
 * The assembly is `core/postman_export.hpp`; this route owns the reads. The
 * whole subtree is exported, with no stop at a collection bound to another
 * OpenAPI document: a Postman collection has no contract to keep apart, and a
 * folder left out would be a folder silently missing. Folders and requests
 * are read in their stored `order`, the order the sidebar draws, and examples
 * through `get_request_examples`, which leaves out the tombstones a deleted
 * imported example keeps (#722). Nothing is written.
 */

#include "vayu/core/postman_export.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

using ordered = nlohmann::ordered_json;

/// A stored JSON column in its stored key order, or @p fallback when it is
/// empty, unparsable or not the shape the column holds.
ordered column (const std::string& blob, const ordered& fallback) {
    ordered parsed = ordered::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded () || parsed.type () != fallback.type ()) {
        return fallback;
    }
    return parsed;
}

vayu::core::PostmanExportRequest
read_request (vayu::db::Database& db, const vayu::db::Request& row) {
    vayu::core::PostmanExportRequest request;
    request.name               = row.name;
    request.description        = row.description;
    request.method             = vayu::to_string (row.method);
    request.url                = row.url;
    request.params             = column (row.params, ordered::array ());
    request.headers            = column (row.headers, ordered::array ());
    request.body               = column (row.body, ordered::object ());
    request.auth               = column (row.auth, ordered::object ());
    request.elements           = column (row.elements, ordered::array ());
    request.follow_redirects   = row.follow_redirects;
    request.max_redirects      = row.max_redirects;
    request.http_version       = row.http_version;
    request.verify_ssl         = row.verify_ssl;
    request.stream             = row.stream;
    request.has_spec_operation = row.spec_operation.has_value ();
    request.mock_response_mode = row.mock_response_mode;
    for (const auto& example : db.get_request_examples (row.id)) {
        request.examples.push_back ({ example.name, example.status,
        column (example.headers, ordered::array ()), example.body,
        example.content_type, example.body_truncated });
    }
    return request;
}

/// The collection-table rows under one parent, in stored order.
using Children =
std::unordered_map<std::string, std::vector<const vayu::db::Collection*>>;

/**
 * @p collection and everything beneath it. Recursion depth is the folder
 * depth a person built; @p visiting refuses a `parent_id` cycle rather than
 * trusting the table never to hold one.
 */
vayu::core::PostmanExportFolder read_folder (vayu::db::Database& db,
const vayu::db::Collection& collection,
const Children& children,
std::unordered_set<std::string>& visiting) {
    visiting.insert (collection.id);
    vayu::core::PostmanExportFolder folder;
    folder.name        = collection.name;
    folder.description = collection.description;
    folder.variables   = column (collection.variables, ordered::object ());
    folder.auth        = column (collection.auth, ordered::object ());
    folder.elements    = column (collection.elements, ordered::array ());
    folder.data_schema = column (collection.data_schema, ordered::object ());
    folder.spec_bound  = !bound_spec_id (collection.openapi).empty ();
    if (const auto found = children.find (collection.id); found != children.end ()) {
        for (const vayu::db::Collection* child : found->second) {
            if (!visiting.contains (child->id)) {
                folder.folders.push_back (read_folder (db, *child, children, visiting));
            }
        }
    }
    auto rows = db.get_requests_in_collection (collection.id);
    std::stable_sort (rows.begin (), rows.end (),
    [] (const auto& a, const auto& b) { return a.order < b.order; });
    for (const auto& row : rows) {
        folder.requests.push_back (read_request (db, row));
    }
    return folder;
}

/// `includeSecrets`, or the sentence refusing it.
std::optional<std::string> read_include_secrets (const nlohmann::json& json, bool& include) {
    const auto field = json.find ("includeSecrets");
    if (field == json.end () || field->is_null ()) {
        return std::nullopt;
    }
    if (!field->is_boolean ()) {
        return "Invalid 'includeSecrets': must be true or false";
    }
    include = field->get<bool> ();
    return std::nullopt;
}

} // namespace

/**
 * Testable core of POST /export/postman - the document assembled and
 * returned, nothing written. 400 for a body that is not an object, a missing
 * or empty `collectionId`, or a non-boolean `includeSecrets`; 404 for a
 * collection that does not exist.
 */
std::pair<int, nlohmann::json>
export_postman_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return { 400, error_body (400, "Invalid body: must be an object") };
    }
    const auto id_field = json.find ("collectionId");
    if (id_field == json.end () || !id_field->is_string () ||
    id_field->get<std::string> ().empty ()) {
        return { 400, error_body (400, "Invalid 'collectionId': must be a non-empty string") };
    }
    vayu::core::PostmanExportOptions options;
    options.collection_id = id_field->get<std::string> ();
    if (auto refusal = read_include_secrets (json, options.include_secrets)) {
        return { 400, error_body (400, *refusal) };
    }

    const auto root = db.get_collection (options.collection_id);
    if (!root) {
        return { 404, error_body (404, "Collection not found") };
    }

    // `get_collections` answers in stored `order`, so each parent's list is
    // already its sidebar order.
    const auto collections = db.get_collections ();
    Children children;
    for (const auto& collection : collections) {
        if (collection.parent_id && !collection.parent_id->empty ()) {
            children[*collection.parent_id].push_back (&collection);
        }
    }
    std::unordered_set<std::string> visiting;
    const vayu::core::PostmanExportFolder tree =
    read_folder (db, *root, children, visiting);

    const auto outcome = vayu::core::export_postman (tree, options);
    return { 200,
        nlohmann::json{ { "text", outcome.text }, { "fileName", outcome.file_name },
        { "notes", vayu::core::postman_export_notes_json (outcome.notes) } } };
}

void register_postman_export_routes (RouteContext& ctx) {
    /**
     * POST /export/postman
     * The collection's subtree as a Postman Collection v2.1.0 document.
     * Body params: collectionId (required), includeSecrets (default false).
     * Returns: {text, fileName, notes}, 400 for a bad body, 404 when the
     * collection does not exist. Reads only.
     */
    ctx.server.Post ("/export/postman",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = export_postman_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /export/postman - " + std::to_string (status) + ": " +
                error_message_of (body));
            }
            res.status = status;
            res.set_content (
            body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
            "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "http", "POST /export/postman - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
