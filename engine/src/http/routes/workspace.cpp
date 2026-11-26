/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `POST /workspace/backup`: a snapshot of the workspace the user owns (#987).
 * Everything a user typed lives in one SQLite file (collections, environments,
 * stored credentials, run history). The engine's `.bak` is no such copy: it is
 * overwritten once the engine listens and at a clean shutdown, so a corrupt
 * file has something to restore from, not so a person can go back to last week.
 * Copying the file by hand while the engine runs is unsafe under WAL: the
 * `-wal` holds committed transactions the main file lacks, so the copy misses
 * the most recent writes.
 *
 * A verb path, not a stored resource, as `/inbox/start` and `/mock/start`: a
 * backup is something the engine does, and its file is no row anything here
 * reads back.
 *
 * There is deliberately **no restore endpoint**: a live engine overwriting the
 * file it holds open is the footgun this feature spares the user. The procedure
 * (stop the engine, copy a snapshot over `db/vayu.db`, delete the `-wal` and
 * `-shm`, start) is in `docs/engine/architecture.md`.
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <chrono>
#include <string>
#include <utility>

namespace vayu::http::routes {

/**
 * Testable core of POST /workspace/backup.
 *
 * @param now the caller's clock in Unix ms, the instant the snapshot is named
 *        for; a parameter so a test can say which snapshot it asks for.
 *
 * A backup already running is a **409**: nothing is wrong, and the caller's
 * earlier request is still producing the file. Anything else is a **500**
 * naming what SQLite or the filesystem refused, never a 200 with an empty path:
 * a backup reporting success having written nothing is the one outcome this
 * feature must not have.
 */
std::pair<int, nlohmann::json> workspace_backup_response (vayu::db::Database& db, int64_t now) {
    const auto outcome = db.backup_workspace (now);
    if (!outcome) {
        return outcome.error ().already_running ?
        std::pair{ 409, error_body (409, outcome.error ().message) } :
        std::pair{ 500, error_body (500, outcome.error ().message) };
    }
    return { 200,
        nlohmann::json{ { "path", outcome->path }, { "sizeBytes", outcome->size_bytes },
        { "createdAt", outcome->created_at }, { "pruned", outcome->pruned } } };
}

void register_workspace_routes (RouteContext& ctx) {
    /**
     * POST /workspace/backup
     * Writes one consistent, compacted snapshot of the workspace into
     * `backups/` beside the database and prunes older ones to
     * `maxBackupsRetained`. Takes no body.
     * Returns: {path, sizeBytes, createdAt, pruned}, 409 while another backup
     * is running, or 500 naming what refused.
     */
    ctx.server.Post ("/workspace/backup",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        try {
            const auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
            std::chrono::system_clock::now ().time_since_epoch ())
                             .count ();
            auto [status, body] = workspace_backup_response (ctx.db, now);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /workspace/backup - " + std::to_string (status) + ": " +
                error_message_of (body));
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "POST /workspace/backup - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
