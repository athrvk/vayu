#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/postman_export.hpp
 * @brief A collection out as a Postman Collection v2.1.0 document, written the
 *        way Postman's own "Export > Collection v2.1" writes one.
 *
 * The exporter is the inverse of the Postman half of `import_document.cpp`:
 * every Vayu field that importer fills from a Postman member is written back
 * into that member, and a collection imported from a Postman export and
 * exported again is the same document (ids aside). Where the importer maps two
 * Postman spellings onto one Vayu value, the one Postman itself writes today is
 * the one exported. The name tables both directions read are
 * `core/postman_format.hpp`.
 *
 * What the format cannot carry is never dropped silently: each kind is a
 * `PostmanNotCarried` entry the route answers with, so the export dialog can
 * say what stayed behind.
 */

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace vayu::core {

/// One saved example response (`request_examples`), as the exporter reads it.
struct PostmanExportExample {
    std::string name;
    int status = 200;
    /// The stored headers column: `[{key, value, enabled, description?}]`.
    nlohmann::ordered_json headers = nlohmann::ordered_json::array ();
    std::string body;
    std::string content_type;
    bool body_truncated = false;
};

/// One stored request, its JSON columns parsed in stored key order.
struct PostmanExportRequest {
    std::string name;
    std::string description;
    std::string method = "GET";
    std::string url;
    nlohmann::ordered_json params   = nlohmann::ordered_json::array ();
    nlohmann::ordered_json headers  = nlohmann::ordered_json::array ();
    nlohmann::ordered_json body     = nlohmann::ordered_json::object ();
    nlohmann::ordered_json auth     = nlohmann::ordered_json::object ();
    nlohmann::ordered_json elements = nlohmann::ordered_json::array ();
    bool follow_redirects           = true;
    int max_redirects               = 10;
    std::string http_version        = "auto";
    bool verify_ssl                 = true;
    bool stream                     = false;
    /// Whether the request is stamped as an operation of a bound OpenAPI
    /// document (`spec_operation`).
    bool has_spec_operation        = false;
    std::string mock_response_mode = "first";
    std::vector<PostmanExportExample> examples;
};

/// A collection or folder with everything beneath it, in sidebar order.
struct PostmanExportFolder {
    std::string name;
    std::string description;
    nlohmann::ordered_json variables   = nlohmann::ordered_json::object ();
    nlohmann::ordered_json auth        = nlohmann::ordered_json::object ();
    nlohmann::ordered_json elements    = nlohmann::ordered_json::array ();
    nlohmann::ordered_json data_schema = nlohmann::ordered_json::object ();
    /// Whether the collection is bound to an OpenAPI document (`openapi`).
    bool spec_bound = false;
    std::vector<PostmanExportFolder> folders;
    std::vector<PostmanExportRequest> requests;
};

/// One kind of stored thing the document does not carry.
struct PostmanNotCarried {
    /// A stable snake_case id a client can key on.
    std::string code;
    int count = 0;
    /// One sentence a user understands, about all @ref count of them.
    std::string message;
};

/// What the export wrote and what it left behind; every count is always sent.
struct PostmanExportNotes {
    int requests_exported = 0;
    /// Folders beneath the exported collection, which is itself not counted.
    int folders_exported = 0;
    /// Credential values written as `""` because secrets were not asked for.
    int secrets_omitted = 0;
    /// In a fixed code order, one entry per code that occurred.
    std::vector<PostmanNotCarried> not_carried;
};

struct PostmanExportOutcome {
    /// The document, byte for byte what Postman writes: tab-indented, no
    /// trailing newline.
    std::string text;
    /// `<collection name>.postman_collection.json`.
    std::string file_name;
    PostmanExportNotes notes;
};

struct PostmanExportOptions {
    /// The exported collection's id; `info._postman_id` is derived from it.
    std::string collection_id;
    /**
     * Write credentials as stored. Off blanks every token, password, API-key
     * value, client secret and secret variable - a whole-value `{{variable}}`
     * reference names a secret without being one and is kept - and counts
     * each blanked value in `secrets_omitted`.
     */
    bool include_secrets = false;
};

/// @brief @p root and everything beneath it as a Postman v2.1.0 document.
[[nodiscard]] PostmanExportOutcome export_postman (const PostmanExportFolder& root,
const PostmanExportOptions& options);

/// `PostmanExportNotes` as the route answers with it.
[[nodiscard]] nlohmann::json postman_export_notes_json (const PostmanExportNotes& notes);

/// The Postman object form of @p raw (`raw`, `protocol`, `host[]`, `port`,
/// `path[]`, `hash`), split the way Postman's own URL parser splits it.
[[nodiscard]] nlohmann::ordered_json postman_url_parts (const std::string& raw);

/// `info._postman_id` for a collection id: the id itself when it is a UUID,
/// the UUID an engine id ends in (`col_<uuid>`), else one derived from it.
[[nodiscard]] std::string postman_collection_uuid (const std::string& collection_id);

} // namespace vayu::core
