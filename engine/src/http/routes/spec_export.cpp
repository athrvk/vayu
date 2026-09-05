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

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_export.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <string>
#include <tuple>
#include <unordered_map>
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
        // Absent or non-boolean `enabled` means enabled (D17, the same rule
        // `variable-resolution.ts` and `parse_variables` apply).
        const auto enabled_field = row.find ("enabled");
        const bool enabled       = enabled_field == row.end () ||
        !enabled_field->is_boolean () || enabled_field->get<bool> ();
        out.push_back ({ text (row, "key"), text (row, "value"),
        text (row, "description"), enabled });
    }
    return out;
}

/** `requests.auth` / `collections.auth`, secrets left out - only what a
 * `securityScheme` can state. */
vayu::core::ExportAuth read_auth (const std::string& blob) {
    vayu::core::ExportAuth auth;
    if (blob.empty ()) {
        return auth;
    }
    const auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return auth;
    }
    const auto text = [&] (const nlohmann::json& node, const char* key) {
        const auto found = node.find (key);
        return found != node.end () && found->is_string () ?
        found->get<std::string> () :
        std::string ();
    };
    auth.mode = text (parsed, "mode");
    if (auth.mode == "apikey") {
        auth.api_key_name = text (parsed, "key");
        auth.api_key_in   = text (parsed, "in") == "query" ? "query" : "header";
    } else if (auth.mode == "oauth2") {
        const auto config_field = parsed.find ("config");
        const auto& config = config_field != parsed.end () && config_field->is_object () ?
        *config_field :
        nlohmann::json::object ();
        auth.oauth2_grant_type        = text (config, "grantType");
        auth.oauth2_authorization_url = text (config, "authorizationUrl");
        auth.oauth2_token_url         = text (config, "accessTokenUrl");
        auth.oauth2_refresh_url       = text (config, "refreshTokenUrl");
        auth.oauth2_scope             = text (config, "scope");
    }
    return auth;
}

/**
 * The collection's own `baseUrl` variable value, and how many others it
 * declares - a skeleton export needs the first to give `{{baseUrl}}` a real
 * default and counts the rest, since a document has nowhere else to put them.
 */
std::pair<std::string, int> read_collection_variables (const std::string& blob) {
    if (blob.empty ()) {
        return { {}, 0 };
    }
    const auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_object ()) {
        return { {}, 0 };
    }
    std::string base_url;
    int others = 0;
    for (const auto& [name, entry] : parsed.items ()) {
        const auto value_field =
        entry.is_object () ? entry.find ("value") : entry.end ();
        const std::string value =
        value_field != entry.end () && value_field->is_string () ?
        value_field->get<std::string> () :
        std::string ();
        if (name == "baseUrl") {
            base_url = value;
        } else {
            others += 1;
        }
    }
    return { base_url, others };
}

/**
 * The chain of folder names between the exported root and @p target, root
 * excluded - `["Pets", "Actions"]` for a request three levels under the root.
 * Empty when @p target *is* the root: its own direct requests have no folder.
 */
std::vector<std::string> folder_path_of (const std::vector<vayu::db::Collection>& collections,
const std::string& root_id,
const std::string& target_id) {
    if (target_id == root_id) {
        return {};
    }
    std::unordered_map<std::string, const vayu::db::Collection*> by_id;
    for (const auto& collection : collections) {
        by_id[collection.id] = &collection;
    }
    std::vector<std::string> reversed;
    std::string current = target_id;
    // The subtree walk that built `collections` already refuses a cycle back
    // to the root's own document; this still bounds the climb rather than
    // trusting that, since a malformed `parent_id` chain must stop, not loop.
    for (std::size_t hops = 0; hops < collections.size () + 1 && current != root_id; ++hops) {
        const auto found = by_id.find (current);
        if (found == by_id.end ()) {
            break;
        }
        reversed.push_back (found->second->name);
        const auto& parent_id = found->second->parent_id;
        if (!parent_id || parent_id->empty ()) {
            break;
        }
        current = *parent_id;
    }
    std::reverse (reversed.begin (), reversed.end ());
    return reversed;
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

/// Whether a stored example's headers blob names one besides `Content-Type`
/// (already denormalized into `content_type`, so this asks only about the
/// rest) - counted on export, never written, see `ExportExample::has_extra_headers`.
bool example_has_extra_headers (const std::string& blob) {
    const auto headers = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!headers.is_array ()) {
        return false;
    }
    return std::any_of (headers.begin (), headers.end (), [] (const nlohmann::json& h) {
        const auto key = h.is_object () ? h.find ("key") : h.end ();
        return key != h.end () && key->is_string () &&
        !vayu::utils::ascii_lower_equal (key->get<std::string> (), "content-type");
    });
}

/// One request, and the examples stored against it, as the exporter reads
/// them - @p folder_collection_id is the collection it is directly filed
/// under, which may differ from @p row's own `collection_id` on nothing here
/// (kept as a parameter because the caller already has it from its own walk).
vayu::core::ExportRequest build_export_request (vayu::db::Database& db,
const vayu::db::Request& row,
const std::vector<vayu::db::Collection>& collections,
const std::string& root_id,
const std::string& folder_collection_id) {
    vayu::core::ExportRequest entry;
    entry.name                = row.name;
    entry.description         = row.description;
    entry.method              = vayu::to_string (row.method);
    entry.url                 = row.url;
    entry.params              = read_rows (row.params);
    entry.headers             = read_rows (row.headers);
    entry.body                = read_body (row.body);
    entry.spec_operation      = read_identity (row.spec_operation);
    entry.auth                = read_auth (row.auth);
    entry.pre_request_script  = row.pre_request_script;
    entry.post_request_script = row.post_request_script;
    entry.follow_redirects    = row.follow_redirects;
    entry.max_redirects       = row.max_redirects;
    entry.http_version        = row.http_version;
    entry.verify_ssl          = row.verify_ssl;
    entry.stream              = row.stream;
    entry.folder_path = folder_path_of (collections, root_id, folder_collection_id);
    for (const auto& example : db.get_request_examples (row.id)) {
        entry.examples.push_back ({ example.name, example.status, example.body,
        example.content_type, example.body_truncated,
        example.origin == vayu::core::constants::request_example::ORIGIN_IMPORT,
        example_has_extra_headers (example.headers) });
    }
    return entry;
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
            requests.push_back (build_export_request (
            db, row, collections, collection_id, collection.id));
        }
    }

    vayu::core::ExportCollection export_collection;
    export_collection.name                = root->name;
    export_collection.description         = root->description;
    export_collection.auth                = read_auth (root->auth);
    export_collection.pre_request_script  = root->pre_request_script;
    export_collection.post_request_script = root->post_request_script;
    std::tie (export_collection.base_url_value, export_collection.other_variables) =
    read_collection_variables (root->variables);

    const auto outcome =
    vayu::core::export_openapi (export_collection, requests, spec_content, format);
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
