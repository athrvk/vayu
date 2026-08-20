/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/spec_export.cpp
 * @brief `POST /specs/export` - a collection back out as an OpenAPI document
 *        (issue #630's exporter, moved engine-side by #855).
 *
 * The assembly is `core/openapi_export.hpp`; this is the one way to ask for it,
 * and it owns the three reads the renderer used to make itself - the subtree's
 * requests, every request's stored examples, and the bound document - because
 * each of them is a place a caller could get the answer subtly wrong:
 *
 * - **Which requests are exported.** The whole subtree of the named collection,
 *   never a list the caller supplies. An OpenAPI import files its requests under
 *   one sub-collection per tag, so a bound root usually owns none directly.
 * - **Where the subtree stops** (issue #721). Collections re-parent freely, so a
 *   collection bound to spec B can sit under one bound to spec A. B's requests
 *   carry B's operation stamps, and the bound direction matches a stamp by
 *   `operationId` and then by method+path - names generators hand out in every
 *   document (`listUsers`, `GET /users`) - so without a boundary B's rows would
 *   claim A's operations and rewrite them with B's values. The walk therefore
 *   refuses to descend into a collection bound to a *different* document.
 *   *Another* document, not *a* document: a descendant bound to the same spec
 *   describes the very operations being patched, and excluding it would have the
 *   export remove them as operations "nothing here claims" - trading a
 *   cross-document rewrite for a silent deletion.
 * - **Which examples.** `get_request_examples` filters the tombstones a deleted
 *   imported example leaves (#722), so an example the user removed does not come
 *   back as part of the contract.
 *
 * It writes nothing: an export is a read of everything the collection already
 * is. The document it returns is the caller's to save, copy or hand to an agent.
 */

#include "vayu/core/openapi_export.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/**
 * The Params / Headers rows of a stored request.
 *
 * Deliberately not the readers `request_composer.cpp` and the mock server use:
 * those drop a disabled row because a disabled row is not *sent*, and this one
 * keeps it because the endpoint accepts the parameter either way. A toggle says
 * what this request does, not what the API takes.
 */
std::vector<vayu::core::ExportKeyValue> read_rows (const std::string& blob) {
    std::vector<vayu::core::ExportKeyValue> out;
    if (blob.empty ()) {
        return out;
    }
    const auto rows = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!rows.is_array ()) {
        return out;
    }
    const auto text = [] (const nlohmann::json& row, const char* key) {
        const auto found = row.find (key);
        return found != row.end () && found->is_string () ?
        found->get<std::string> () :
        std::string ();
    };
    for (const auto& row : rows) {
        if (!row.is_object ()) {
            continue;
        }
        out.push_back (
        { text (row, "key"), text (row, "value"), text (row, "description") });
    }
    return out;
}

vayu::core::ExportBody read_body (const std::string& blob) {
    vayu::core::ExportBody body;
    if (blob.empty ()) {
        return body;
    }
    const auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return body;
    }
    if (const auto mode = parsed.find ("mode"); mode != parsed.end () && mode->is_string ()) {
        body.mode = mode->get<std::string> ();
    }
    if (const auto content = parsed.find ("content");
        content != parsed.end () && content->is_string ()) {
        body.content = content->get<std::string> ();
    }
    if (const auto fields = parsed.find ("fields");
        fields != parsed.end () && fields->is_array ()) {
        for (const auto& field : *fields) {
            if (!field.is_object ()) {
                continue;
            }
            if (const auto key = field.find ("key");
                key != field.end () && key->is_string ()) {
                body.field_keys.push_back (key->get<std::string> ());
            }
        }
    }
    return body;
}

/** `requests.spec_operation`, or absent for a request that answers to none. */
std::optional<vayu::core::ExportOperationIdentity> read_identity (
const std::optional<std::string>& blob) {
    if (!blob || blob->empty ()) {
        return std::nullopt;
    }
    const auto parsed = nlohmann::json::parse (*blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return std::nullopt;
    }
    const auto text = [&] (const char* key) {
        const auto found = parsed.find (key);
        return found != parsed.end () && found->is_string () ?
        found->get<std::string> () :
        std::string ();
    };
    vayu::core::ExportOperationIdentity identity{ text ("operationId"),
        text ("method"), text ("path") };
    if (identity.method.empty () || identity.path.empty ()) {
        // Half an identity identifies nothing: the bound direction keys on
        // method and path when there is no id, so a row missing either is a row
        // with no operation rather than one with a partial match.
        return std::nullopt;
    }
    return identity;
}

/** The spec a collection's `openapi` binding names, `""` when it binds none. */
std::string bound_spec_id (const std::string& openapi) {
    const auto parsed =
    nlohmann::json::parse (openapi, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return {};
    }
    const auto spec = parsed.find ("specId");
    return spec != parsed.end () && spec->is_string () ? spec->get<std::string> () :
                                                         std::string ();
}

} // namespace

/**
 * Testable core of POST /specs/export - the document, assembled and returned,
 * nothing written.
 *
 * A collection that does not exist is a 404. A binding the store cannot answer
 * - a spec row that is gone, or bytes that will not read as a document - is a
 * 409 naming what is wrong, never a silent fall back to a skeleton: a skeleton
 * in place of the document the user believes they are updating would drop every
 * member of their spec Vayu does not model.
 */
std::pair<int, nlohmann::json>
export_spec_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return { 400, error_body (400, "Invalid body: must be an object") };
    }

    const auto collection_id_field = json.find ("collectionId");
    if (collection_id_field == json.end () || !collection_id_field->is_string () ||
    collection_id_field->get<std::string> ().empty ()) {
        return { 400, error_body (400, "Invalid 'collectionId': must be a non-empty string") };
    }
    const auto collection_id = collection_id_field->get<std::string> ();

    auto format = vayu::core::ExportFormat::Json;
    if (const auto field = json.find ("format");
        field != json.end () && !field->is_null ()) {
        if (!field->is_string ()) {
            return { 400, error_body (400, R"(Invalid 'format': must be "json" or "yaml")") };
        }
        const auto requested = field->get<std::string> ();
        if (requested == "yaml") {
            format = vayu::core::ExportFormat::Yaml;
        } else if (requested != "json") {
            return { 400,
                error_body (400,
                R"(Invalid 'format': must be "json" or "yaml", not ")" + requested + "\"") };
        }
    }

    const auto root = db.get_collection (collection_id);
    if (!root) {
        return { 404, error_body (404, "Collection not found") };
    }

    const std::string exported_spec_id = bound_spec_id (root->openapi);
    std::optional<std::string> spec_content;
    if (!exported_spec_id.empty ()) {
        const auto document = db.get_spec_document (exported_spec_id);
        if (!document) {
            return {
                409, error_body (409, "Collection is bound to spec '" + exported_spec_id + "', which is not stored - unbind it to export a skeleton instead")
            };
        }
        spec_content = document->content;
    }

    const auto collections = db.get_collections ();
    const auto subtree     = collection_subtree_ids (
    collections, collection_id, [&] (const vayu::db::Collection& child) {
        const std::string binding = bound_spec_id (child.openapi);
        return binding.empty () || binding == exported_spec_id;
    });

    std::vector<vayu::core::ExportRequest> requests;
    for (const auto& collection : collections) {
        if (!subtree.contains (collection.id)) {
            continue;
        }
        for (const auto& row : db.get_requests_in_collection (collection.id)) {
            vayu::core::ExportRequest entry;
            entry.name           = row.name;
            entry.description    = row.description;
            entry.method         = vayu::to_string (row.method);
            entry.url            = row.url;
            entry.params         = read_rows (row.params);
            entry.headers        = read_rows (row.headers);
            entry.body           = read_body (row.body);
            entry.spec_operation = read_identity (row.spec_operation);
            for (const auto& example : db.get_request_examples (row.id)) {
                entry.examples.push_back ({ example.name, example.status,
                example.body, example.content_type, example.body_truncated });
            }
            requests.push_back (std::move (entry));
        }
    }

    const auto outcome = vayu::core::export_openapi (
    { root->name, root->description }, requests, spec_content, format);
    if (!outcome.ok ()) {
        return { 409, error_body (409, outcome.error) };
    }

    return { 200,
        nlohmann::json{ { "text", outcome.text }, { "fileName", outcome.file_name },
        { "notes", vayu::core::export_notes_json (outcome.notes) } } };
}

void register_spec_export_routes (RouteContext& ctx) {
    /**
     * POST /specs/export
     * Assembles the collection's subtree into an OpenAPI document - its own
     * bound document updated, or a skeleton when it binds none - and returns
     * the text, a file name and the notes describing what the export could not
     * carry. Reads only; nothing is stored.
     * Body params: collectionId (required), format ("json" default, or "yaml").
     * Returns: {text, fileName, notes}, 400, 404 when the collection does not
     * exist, or 409 when its bound document cannot be read.
     */
    ctx.server.Post ("/specs/export",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = export_spec_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /specs/export - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("POST /specs/export - " +
                body["notes"]["direction"].get<std::string> () + ", " +
                std::to_string (body["notes"]["requestsExported"].get<int> ()) + " request(s) exported, " +
                std::to_string (body["text"].get<std::string> ().size ()) + " bytes");
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /specs/export - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });
}

} // namespace vayu::http::routes
