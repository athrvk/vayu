/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/trash.cpp
 * @brief `GET /trash`, `POST /trash/:id/restore`, `DELETE /trash/:id` - what
 *        soft delete left recoverable (issue #988).
 *
 * Deleting a collection used to be irreversible, with the confirm dialog as the
 * entire safety net: one misclick destroyed a subtree and nothing in the engine
 * could give it back. `Database::delete_collection` and `delete_request` now
 * stamp rows instead of removing them, and these three routes are the whole of
 * what that stamp is for - the list of what is recoverable, the undo, and the
 * one deliberate way to make a delete permanent before retention does.
 *
 * The trash lists *roots* - the rows a user asked to delete - and never what a
 * cascade took with them, because "restore this" is a question about the thing
 * that was deleted and the counts answer the rest of it.
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/// One trash entry as the wire carries it. `parentId` is a collection's parent
/// and a request's owning collection - the same edge under two names in the
/// tables, one name here, since a client restoring either asks the same
/// question of it.
nlohmann::json trash_entry_json (const vayu::db::TrashEntry& entry) {
    nlohmann::json item{ { "id", entry.id }, { "kind", entry.kind },
        { "name", entry.name }, { "deletedAt", entry.deleted_at },
        { "collections", entry.collections }, { "requests", entry.requests } };
    item["parentId"] = entry.parent_id.has_value () ? nlohmann::json (*entry.parent_id) :
                                                      nlohmann::json (nullptr);
    return item;
}

} // namespace

/**
 * Testable core of GET /trash.
 *
 * Always a 200 with an array, empty included: an empty trash is an answer, not
 * a 404.
 */
nlohmann::json trash_list_body (vayu::db::Database& db) {
    nlohmann::json items = nlohmann::json::array ();
    for (const auto& entry : db.get_trash ()) {
        items.push_back (trash_entry_json (entry));
    }
    return nlohmann::json{ { "items", items }, { "total", items.size () } };
}

/**
 * Testable core of POST /trash/:id/restore.
 *
 * Two refusals, deliberately different statuses. **404** is an id the trash
 * does not hold - a live row, or one already purged. **409** is the one shape a
 * restore cannot express: a request whose collection is itself deleted or gone,
 * which has no root to come back to the way a collection does. The message
 * names the way forward (restore the collection) rather than reporting only
 * that this failed.
 */
std::pair<int, nlohmann::json>
trash_restore_response (vayu::db::Database& db, const std::string& id) {
    auto outcome = db.restore_deleted (id);
    if (!outcome) {
        return error_response (
        outcome.error ().reason == vayu::db::RestoreRefusal::NotFound ? 404 : 409,
        outcome.error ().message);
    }
    nlohmann::json body      = trash_entry_json (outcome->entry);
    body["restored"]         = true;
    body["reparentedToRoot"] = outcome->reparented;
    return { 200, body };
}

/**
 * Testable core of DELETE /trash/:id - the hard cascade soft delete replaced,
 * asked for on purpose.
 *
 * 404 on anything the trash does not hold, which is also what makes this
 * unable to destroy a live collection by a mistyped id.
 */
std::pair<int, nlohmann::json>
trash_purge_response (vayu::db::Database& db, const std::string& id) {
    auto outcome = db.purge_deleted (id);
    if (!outcome) {
        return error_response (404, "Nothing in the trash with id '" + id + "'");
    }
    nlohmann::json body = trash_entry_json (outcome->entry);
    body["purged"]      = true;
    return { 200, body };
}

void register_trash_routes (RouteContext& ctx) {
    /**
     * GET /trash
     * What has been deleted and can still be restored - roots only, newest
     * first, each with the descendants its delete took.
     * Returns: {items: [{id, kind, name, deletedAt, parentId, collections,
     * requests}], total}.
     */
    ctx.server.Get ("/trash", [&ctx] (const httplib::Request&, httplib::Response& res) {
        try {
            res.set_content (trash_list_body (ctx.db).dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("GET /trash - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /trash/:id/restore
     * Puts a deleted collection or request back, with everything the same
     * delete took. Takes no body.
     * Returns: the restored entry, 404 if the trash does not hold that id, or
     * 409 for a request whose collection is itself deleted or gone.
     */
    ctx.server.Post (R"(/trash/([^/]+)/restore)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        vayu::utils::log_info ("POST /trash/:id/restore - Restoring: " + id);
        try {
            auto [status, body] = trash_restore_response (ctx.db, id);
            if (status != 200) {
                vayu::utils::log_warning ("POST /trash/:id/restore - " +
                std::to_string (status) + ": " + error_message_of (body));
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /trash/:id/restore - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * DELETE /trash/:id
     * Destroys a deleted collection or request for good, with its whole
     * subtree. There is no undo for this one - it is the undo's counterpart.
     * Returns: the purged entry, or 404 if the trash does not hold that id.
     */
    ctx.server.Delete (R"(/trash/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        vayu::utils::log_info ("DELETE /trash/:id - Purging: " + id);
        try {
            auto [status, body] = trash_purge_response (ctx.db, id);
            if (status != 200) {
                vayu::utils::log_warning ("DELETE /trash/:id - " +
                std::to_string (status) + ": " + error_message_of (body));
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "DELETE /trash/:id - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
