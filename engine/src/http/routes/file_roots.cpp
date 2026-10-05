/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/file_roots.cpp
 * @brief The folders a request-body file may be read from without a person
 * choosing it in the editor (`file_roots`, `FileAccessPolicy`).
 *
 * Three rules are held here because only a route can answer with a status
 * code: a row names an existing directory by absolute path, stored canonical
 * (so the policy compares like with like and a symlinked spelling is one
 * folder), that directory is neither a filesystem root nor the home folder
 * itself (`refused_root_reason`), and one folder is one row - a second
 * spelling of an allowed folder is a 409.
 */

#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"

#include <expected>
#include <filesystem>
#include <string>
#include <system_error>
#include <utility>

namespace vayu::http::routes {

namespace {

nlohmann::json serialize_file_root (const vayu::FileRoot& root) {
    return { { "id", root.id }, { "path", root.path }, { "createdAt", root.created_at } };
}

/// The canonical directory @p json names, or the 400 that says why not.
/// @p home is the user's home folder, as `home_directory` answers it.
std::expected<std::string, RouteError>
read_root_path (const nlohmann::json& json, const std::string& home) {
    const auto path = json.find ("path");
    if (path == json.end () || !path->is_string () || path->get<std::string> ().empty ()) {
        return std::unexpected (RouteError{ 400,
        error_body (400, "Missing 'path': the absolute path of a folder to allow") });
    }
    const std::string written = path->get<std::string> ();
    if (!std::filesystem::path (written).is_absolute ()) {
        return std::unexpected (RouteError{ 400,
        error_body (400, "Invalid 'path': '" + written + "' is not an absolute path") });
    }
    std::error_code ec;
    if (!std::filesystem::is_directory (std::filesystem::path (written), ec)) {
        return std::unexpected (RouteError{ 400,
        error_body (400, "Invalid 'path': '" + written + "' is not an existing folder") });
    }
    std::string canonical = vayu::http::canonical_root_path (written);
    if (canonical.empty ()) {
        return std::unexpected (RouteError{ 400,
        error_body (400, "Invalid 'path': '" + written + "' cannot be resolved") });
    }
    std::string home_folder = vayu::http::canonical_root_path (home);
    if (home_folder.empty ()) {
        home_folder = home;
    }
    if (auto refusal = vayu::http::refused_root_reason (canonical, home_folder)) {
        return std::unexpected (RouteError{ 400, error_body (400, *refusal) });
    }
    return canonical;
}

} // namespace

/**
 * Testable core of POST /file-roots: create only, the engine owns the id.
 * Read and write under one lock, so two allows of one folder cannot both pass
 * the uniqueness check. @p home is passed in so the home-folder rule is
 * testable without the test's own home.
 */
std::pair<int, nlohmann::json> create_file_root_response (vayu::db::Database& db,
const nlohmann::json& json,
const std::string& home) {
    if (!json.is_object ()) {
        return { 400, error_body (400, "Invalid JSON body: expected an object") };
    }
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }
    auto path = read_root_path (json, home);
    if (!path) {
        return as_response (path.error ());
    }

    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        for (const auto& row : db.get_file_roots ()) {
            if (row.path == *path) {
                result = { 409,
                    error_body (409,
                    "The folder '" + *path + "' is already allowed (id " + row.id + ")") };
                return;
            }
        }
        vayu::FileRoot root;
        root.id         = vayu::utils::generate_id ("froot_");
        root.path       = *path;
        root.created_at = now_ms ();
        db.save_file_root (root);
        result = { 201, serialize_file_root (root) };
    });
    return result;
}

/// Testable core of GET /file-roots: every allowed folder, ordered by path.
nlohmann::json list_file_roots_response (vayu::db::Database& db) {
    nlohmann::json out = nlohmann::json::array ();
    for (const auto& row : db.get_file_roots ()) {
        out.push_back (serialize_file_root (row));
    }
    return out;
}

/// Testable core of DELETE /file-roots/:id.
std::pair<int, nlohmann::json>
delete_file_root_response (vayu::db::Database& db, const std::string& id) {
    if (!db.get_file_root (id)) {
        return { 404, error_body (404, "Allowed folder not found") };
    }
    db.delete_file_root (id);
    return { 200, nlohmann::json{ { "success", true } } };
}

void register_file_root_routes (RouteContext& ctx) {
    /**
     * GET /file-roots
     * The allowed folders as a bare array of `{id, path, createdAt}`, by path.
     */
    ctx.server.Get ("/file-roots", [&ctx] (const httplib::Request&, httplib::Response& res) {
        res.set_content (list_file_roots_response (ctx.db).dump (), "application/json");
    });

    /**
     * POST /file-roots
     * Allows a folder. Body: `{path}` - absolute, an existing directory, not a
     * filesystem root and not the home folder itself; stored canonical. 201
     * with the row; 400 for a bad path or a body `id`; 409 when the folder is
     * already allowed.
     */
    ctx.server.Post (
    "/file-roots", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json           = nlohmann::json::parse (req.body);
            auto [status, body] = create_file_root_response (
            ctx.db, json, vayu::platform::home_directory ());
            if (status == 201) {
                vayu::utils::log_info ("http", "Allowed a folder for request-body files",
                { { "id", body["id"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            send_error (res, 400, std::string ("Invalid JSON body: ") + e.what ());
        }
    });

    /**
     * DELETE /file-roots/:id
     * Stops allowing a folder. The folder and its files are untouched.
     */
    ctx.server.Delete (R"(/file-roots/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        auto [status, body]  = delete_file_root_response (ctx.db, id);
        res.status           = status;
        res.set_content (body.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
