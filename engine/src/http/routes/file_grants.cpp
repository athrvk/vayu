/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/file_grants.cpp
 * @brief The files a person picked, which a request body may send from
 * wherever they lie (`file_grants`, `FileAccessPolicy`, #2356).
 *
 * A row names one existing regular file by absolute path, stored canonical as
 * `grantable_file_path` answers it (every symlink resolved, so a link
 * re-pointed after the pick no longer matches), and one file is one row: a
 * second spelling of a granted file is a 409, as a second spelling of an
 * allowed folder is. Writes need the grant secret (`admit_file_trust_write`);
 * the list does not, because a GET changes nothing.
 */

#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <expected>
#include <filesystem>
#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

nlohmann::json serialize_file_grant (const vayu::FileGrant& grant) {
    return { { "id", grant.id }, { "path", grant.path }, { "createdAt", grant.created_at } };
}

/// Why @p written, which `grantable_file_path` refused, names no file a
/// person could have picked.
std::string ungrantable_reason (const std::string& written) {
    const std::string quoted = "'" + written + "'";
    if (written.find ("{{") != std::string::npos) {
        return "Invalid 'path': " + quoted +
        " holds a {{variable}}; a grant names one file, never a template";
    }
    if (!std::filesystem::path (written).is_absolute ()) {
        return "Invalid 'path': " + quoted + " is not an absolute path";
    }
    return "Invalid 'path': " + quoted +
    " is not an existing regular file (a folder, a device or a pipe is never "
    "granted)";
}

/// The canonical file @p json names, or the 400 that says why not.
std::expected<std::string, RouteError> read_grant_path (const nlohmann::json& json) {
    const auto path = json.find ("path");
    if (path == json.end () || !path->is_string () || path->get<std::string> ().empty ()) {
        return std::unexpected (RouteError{ 400,
        error_body (400, "Missing 'path': the absolute path of a picked file") });
    }
    const std::string written = path->get<std::string> ();
    auto canonical            = vayu::http::grantable_file_path (written);
    if (!canonical) {
        return std::unexpected (
        RouteError{ 400, error_body (400, ungrantable_reason (written)) });
    }
    return std::move (*canonical);
}

} // namespace

/**
 * Testable core of POST /file-grants: create only, the engine owns the id.
 * Read and write under one lock, so two grants of one file cannot both pass
 * the uniqueness check - `save_file_grant` replaces on the UNIQUE path, so a
 * second insert would silently swap the row's id.
 */
std::pair<int, nlohmann::json>
create_file_grant_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (!json.is_object ()) {
        return error_response (400, "Invalid JSON body: expected an object");
    }
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    auto path = read_grant_path (json);
    if (!path) {
        return as_response (path.error ());
    }

    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        for (const auto& row : db.get_file_grants ()) {
            if (row.path == *path) {
                result = error_response (409,
                "The file '" + *path + "' is already granted (id " + row.id + ")");
                return;
            }
        }
        vayu::FileGrant grant;
        grant.id         = vayu::utils::generate_id ("fgrant_");
        grant.path       = *path;
        grant.created_at = now_ms ();
        db.save_file_grant (grant);
        result = { 201, serialize_file_grant (grant) };
    });
    return result;
}

/// Testable core of GET /file-grants: every picked file, ordered by path.
nlohmann::json list_file_grants_response (vayu::db::Database& db) {
    nlohmann::json out = nlohmann::json::array ();
    for (const auto& row : db.get_file_grants ()) {
        out.push_back (serialize_file_grant (row));
    }
    return out;
}

/// Testable core of DELETE /file-grants/:id. Check and delete under one lock,
/// so a concurrent delete of the same id answers 404 rather than 200 twice.
std::pair<int, nlohmann::json>
delete_file_grant_response (vayu::db::Database& db, const std::string& id) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        if (!db.get_file_grant (id)) {
            result = error_response (404, "Picked file not found");
            return;
        }
        db.delete_file_grant (id);
        result = { 200, nlohmann::json{ { "success", true } } };
    });
    return result;
}

void register_file_grant_routes (RouteContext& ctx) {
    /**
     * GET /file-grants
     * The picked files as a bare array of `{id, path, createdAt}`, by path.
     */
    ctx.server.Get ("/file-grants", [&ctx] (const httplib::Request&, httplib::Response& res) {
        res.set_content (list_file_grants_response (ctx.db).dump (), "application/json");
    });

    /**
     * POST /file-grants
     * Records a picked file. Needs the grant secret (403 without it). Body:
     * `{path}` - absolute, an existing regular file, no `{{`; stored
     * canonical. 201 with the row; 400 for a bad path or a body `id`; 409
     * when the file is already granted.
     */
    ctx.server.Post ("/file-grants",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        if (!admit_file_trust_write (ctx.grant_secret, req, res)) {
            return;
        }
        const auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "POST /file-grants", json.error ());
            return;
        }
        try {
            auto [status, body] = create_file_grant_response (ctx.db, *json);
            if (status == 201) {
                vayu::utils::log_info ("http", "Granted a picked file for request bodies",
                { { "id", body["id"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            send_exception (res, e);
        }
    });

    /**
     * DELETE /file-grants/:id
     * Forgets a picked file. Needs the grant secret (403 without it). The
     * file is untouched; a request body naming it is refused from then on
     * unless an allowed folder holds it.
     */
    ctx.server.Delete (R"(/file-grants/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        if (!admit_file_trust_write (ctx.grant_secret, req, res)) {
            return;
        }
        const std::string id = req.matches[1];
        auto [status, body]  = delete_file_grant_response (ctx.db, id);
        res.status           = status;
        res.set_content (body.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
