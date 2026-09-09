/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_maintenance.cpp
 * @brief Startup: schema migration, corruption recovery, `init ()`'s repair
 * passes, workspace backup and the startup page-reclamation pass (issue
 * #1614). `migrate_before_sync`, `has_sqlite_header`, `copy_db_files` and
 * `recover_database` are declared in `database_impl.hpp` because
 * `Database::Database`'s constructor (`database.cpp`) calls them directly;
 * everything else here is this file's own.
 */

#include "database_impl.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <format>
#include <fstream>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "config_seeds/seed.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/db/recovery.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/reentrant.hpp"

namespace fs = std::filesystem;

using namespace sqlite_orm;

namespace vayu::db {

namespace {

/**
 * Move a corrupt file set aside instead of deleting it, returning where it
 * went, or `nullopt` when it could not be moved (issue #984).
 *
 * SQLite's own `.recover` can usually pull most rows out of a damaged
 * file - but only while the file exists, and the previous behaviour deleted
 * it at the exact moment it was the last copy of anything. The sidecars go
 * with it because a `-wal` holds committed transactions the main file does
 * not.
 */
std::optional<fs::path> quarantine_db_files (const fs::path& original) {
    std::error_code ec;
    if (!fs::exists (original, ec)) {
        return std::nullopt;
    }

    // A stamped name rather than a fixed one, so a second corruption does
    // not overwrite the evidence from the first. The loop is for the
    // pathological case of two runs landing in the same millisecond: a
    // taken name is stepped over, never written through.
    int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                    .count ();
    fs::path quarantined;
    for (int attempt = 0; attempt < 1000; ++attempt, ++stamp) {
        fs::path candidate = original;
        candidate += std::string (QUARANTINE_INFIX) + std::to_string (stamp);
        if (!fs::exists (candidate, ec)) {
            quarantined = std::move (candidate);
            break;
        }
    }
    if (quarantined.empty ()) {
        return std::nullopt;
    }

    fs::rename (original, quarantined, ec);
    if (ec) {
        vayu::utils::log_error ("db",
        "Could not move the corrupt database aside (" + ec.message () +
        "); it will be deleted so the engine can start.");
        return std::nullopt;
    }
    for (const char* suffix : { "-wal", "-shm" }) {
        std::error_code sidecar_ec;
        const fs::path from = original.string () + suffix;
        if (fs::exists (from, sidecar_ec)) {
            fs::rename (from, quarantined.string () + suffix, sidecar_ec);
        }
    }
    vayu::utils::log_warning ("db",
    "Corrupt database moved to " + quarantined.string () +
    " - recover rows from it with: sqlite3 " + quarantined.string () + " .recover");
    return quarantined;
}

/**
 * Open a second connection on the workspace database at @p path.
 *
 * Two statements the engine runs on the workspace - the backup's `VACUUM INTO`
 * and the startup reclamation's `VACUUM` - cannot go through the connection
 * every write is serialized on: sqlite_orm exposes no way to run a statement on
 * the connection it holds. Both take one of these instead, so the flags and the
 * busy timeout are decided once rather than per caller.
 *
 * @return the connection, or `nullptr` with @p error set to what SQLite
 *         refused. The caller owns what it gets and closes it.
 */
sqlite3* open_workspace_connection (const std::string& path, std::string& error) {
    sqlite3* connection = nullptr;
    // Read-write rather than read-only: under WAL a reader still writes the
    // `-shm` index, and a read-only open of a database whose WAL has not been
    // checkpointed fails outright on a directory it cannot write.
    if (sqlite3_open_v2 (path.c_str (), &connection, SQLITE_OPEN_READWRITE, nullptr) != SQLITE_OK) {
        error = connection != nullptr ?
        std::string (sqlite3_errmsg (connection)) :
        std::string ("could not open the workspace database");
        sqlite3_close (connection);
        return nullptr;
    }
    sqlite3_busy_timeout (connection, vayu::core::constants::database::BUSY_TIMEOUT_MS);
    return connection;
}

/** @brief What one startup reclamation pass decided and did (issue #990). */
struct ReclaimOutcome {
    /// Whether the rewrite ran. False with an empty `error` means the database
    /// did not hold enough freed pages to be worth one.
    bool ran = false;
    /// The size of the database file before the pass, in bytes.
    int64_t before_bytes = 0;
    /// Its size after - equal to `before_bytes` when nothing ran, and negative
    /// when the rewrite ran and the file could not be measured afterwards. The
    /// three are different facts and the log says which one it is reporting.
    int64_t after_bytes = 0;
    /// What SQLite or the filesystem refused, or empty on success.
    std::string error;
};

/**
 * Read a PRAGMA that answers with one integer.
 *
 * @return the value, or nothing if SQLite would not answer - which is what
 *         separates "this database has no free pages" from "we never found out",
 *         and the two must not both read as zero.
 *
 * A refusal is written to @p error *here*, and only if it is still empty, so
 * the message belongs to the read that failed and to the first one. Read back
 * at the call site instead, `sqlite3_errmsg` would describe whichever statement
 * ran last - which, after a later read succeeded, is "not an error".
 */
std::optional<int64_t>
read_pragma_int (sqlite3* connection, const char* pragma, std::string& error) {
    const auto record_failure = [&] {
        if (error.empty ()) {
            error = std::string (pragma) + ": " + sqlite3_errmsg (connection);
        }
    };
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, pragma, -1, &statement, nullptr) != SQLITE_OK) {
        record_failure ();
        return std::nullopt;
    }
    std::optional<int64_t> value;
    if (sqlite3_step (statement) == SQLITE_ROW) {
        value = sqlite3_column_int64 (statement, 0);
    } else {
        record_failure ();
    }
    sqlite3_finalize (statement);
    return value;
}

/**
 * Whether a database of @p pages pages of @p page_size bytes, @p freelist of
 * them free, holds enough dead weight to be worth rewriting.
 *
 * Both thresholds must be crossed - see the two constants for why either alone
 * is the wrong rule.
 */
bool worth_reclaiming (int64_t freelist, int64_t pages, int64_t page_size) {
    if (freelist <= 0 || pages <= 0 || page_size <= 0) {
        return false;
    }
    if (freelist * 100 < pages * vayu::core::constants::database::VACUUM_MIN_FREELIST_PERCENT) {
        return false;
    }
    return freelist * page_size >= vayu::core::constants::database::VACUUM_MIN_RECLAIMABLE_BYTES;
}

/**
 * The decision and the rewrite, on an already-open @p connection.
 *
 * Split from the function below so the connection is closed on exactly one
 * path rather than on each of this one's four.
 */
ReclaimOutcome
reclaim_on_connection (sqlite3* connection, const std::string& path, int64_t before_bytes) {
    ReclaimOutcome outcome;
    outcome.before_bytes = before_bytes;
    outcome.after_bytes  = before_bytes;

    std::string failure;
    const std::optional<int64_t> freelist =
    read_pragma_int (connection, "PRAGMA freelist_count", failure);
    const std::optional<int64_t> pages =
    read_pragma_int (connection, "PRAGMA page_count", failure);
    const std::optional<int64_t> page_size =
    read_pragma_int (connection, "PRAGMA page_size", failure);
    if (!freelist.has_value () || !pages.has_value () || !page_size.has_value ()) {
        outcome.error = failure;
        return outcome;
    }
    if (!worth_reclaiming (*freelist, *pages, *page_size)) {
        return outcome;
    }

    char* err_msg = nullptr;
    if (sqlite3_exec (connection, "VACUUM", nullptr, nullptr, &err_msg) != SQLITE_OK) {
        outcome.error = err_msg != nullptr ? std::string (err_msg) :
                                             std::string (sqlite3_errmsg (connection));
        sqlite3_free (err_msg);
        return outcome;
    }

    // Under WAL the rewritten image lands in the `-wal` file and the database
    // itself is not resized until a checkpoint copies it back, so without this
    // the pass would free every page it set out to and leave the file exactly
    // as large as it found it. Best-effort: a checkpoint that cannot truncate
    // has still committed the rewrite, and the next one returns the space.
    sqlite3_exec (connection, "PRAGMA wal_checkpoint(TRUNCATE)", nullptr, nullptr, nullptr);

    outcome.ran = true;
    std::error_code ec;
    const auto after    = fs::file_size (path, ec);
    outcome.after_bytes = ec ? -1 : static_cast<int64_t> (after);
    return outcome;
}

/**
 * Return the database's freed pages to the filesystem, if it holds enough of
 * them to be worth the rewrite (issue #990).
 *
 * On a connection of its own, for the reason `open_workspace_connection` gives:
 * sqlite_orm exposes no way to run a statement on the connection it holds, and
 * neither `VACUUM` nor the three PRAGMAs this decides on are among the ones it
 * wraps. That costs nothing here - the caller runs before the HTTP listener
 * exists and the lock file has already refused a second engine, so this
 * connection is the only one doing anything.
 */
ReclaimOutcome reclaim_freed_pages (const std::string& path) {
    ReclaimOutcome outcome;
    std::error_code ec;
    const auto size = fs::file_size (path, ec);
    if (ec) {
        outcome.error = ec.message ();
        return outcome;
    }
    outcome.before_bytes = static_cast<int64_t> (size);
    outcome.after_bytes  = outcome.before_bytes;

    sqlite3* connection = open_workspace_connection (path, outcome.error);
    if (connection == nullptr) {
        return outcome;
    }

    outcome = reclaim_on_connection (connection, path, outcome.before_bytes);
    sqlite3_close (connection);
    return outcome;
}

/** Report what the pass above did, at the level its outcome deserves. */
void log_reclaim_outcome (const ReclaimOutcome& outcome) {
    if (!outcome.error.empty ()) {
        vayu::utils::log_warning (
        "db", "Startup database reclamation failed: " + outcome.error);
        return;
    }
    if (!outcome.ran) {
        vayu::utils::log_debug ("db",
        "Database reclamation skipped: too few freed "
        "pages to be worth the rewrite");
        return;
    }
    if (outcome.after_bytes < 0) {
        vayu::utils::log_info ("db",
        "Reclaimed the freed pages of a " + std::to_string (outcome.before_bytes / 1024) +
        " KB database; its size afterwards could not be read");
        return;
    }
    const int64_t freed = outcome.after_bytes < outcome.before_bytes ?
    outcome.before_bytes - outcome.after_bytes :
    0;
    vayu::utils::log_info ("db",
    "Reclaimed " + std::to_string (freed / 1024) + " KB of freed database pages (" +
    std::to_string (outcome.before_bytes / 1024) + " KB -> " +
    std::to_string (outcome.after_bytes / 1024) + " KB)");
}

/// The schema version this engine understands (issue #1514). `PRAGMA
/// user_version` starts at 0 on every pre-cutover database; this build's
/// first successful start on one bumps it to 1, after folding any script
/// this file predates the fold ever adding.
constexpr int SCHEMA_VERSION = 1;

/// @p table's current column names, read fresh so a caller never assumes a
/// shape a genuinely pre-cutover database (older than #1513, no `elements`
/// column at all) does not have.
std::vector<std::string> table_columns (sqlite3* connection, const char* table) {
    const std::string sql   = std::string ("PRAGMA table_info(") + table + ");";
    sqlite3_stmt* statement = nullptr;
    std::vector<std::string> columns;
    if (sqlite3_prepare_v2 (connection, sql.c_str (), -1, &statement, nullptr) != SQLITE_OK) {
        return columns;
    }
    while (sqlite3_step (statement) == SQLITE_ROW) {
        const auto* name = column_text (statement, 1);
        if (name != nullptr) {
            columns.emplace_back (name);
        }
    }
    sqlite3_finalize (statement);
    return columns;
}

bool has_column (const std::vector<std::string>& columns, std::string_view name) {
    return std::find (columns.begin (), columns.end (), name) != columns.end ();
}

/// Whether @p table's schema still carries `pre_request_script` or
/// `post_request_script` (issue #1514's cut-over target) - either alone is
/// enough to need the fold below, since a row can carry just one. False for a
/// fresh install (the table does not exist yet) and for a database this or an
/// earlier engine build already migrated by some other means.
bool table_has_script_columns (sqlite3* connection, const char* table) {
    const auto columns = table_columns (connection, table);
    return has_column (columns, "pre_request_script") ||
    has_column (columns, "post_request_script");
}

/**
 * A row's `elements` with a `script.pre` / `script.post` entry appended for
 * each of @p pre / @p post that is non-blank and not already represented -
 * the "already folded" case a database that ran #1513's additive repair pass
 * before upgrading to this engine can carry. `std::nullopt` when nothing
 * needs adding, so the caller can skip the row's `UPDATE` entirely.
 */
std::optional<std::string> fold_row_scripts_if_missing (const std::string& existing_elements,
const std::string& pre,
const std::string& post) {
    nlohmann::json elements =
    nlohmann::json::parse (existing_elements, nullptr, /*allow_exceptions=*/false);
    if (!elements.is_array ()) {
        elements = nlohmann::json::array ();
    }
    const auto has_kind = [&] (const char* kind) {
        for (const auto& entry : elements) {
            if (entry.is_object () && entry.value ("kind", "") == kind) {
                return true;
            }
        }
        return false;
    };

    bool changed = false;
    if (!vayu::core::is_blank_script_text (pre) && !has_kind ("script.pre")) {
        elements.push_back (
        { { "id", vayu::utils::generate_id ("el_") }, { "kind", "script.pre" },
        { "enabled", true }, { "config", { { "script", pre } } } });
        changed = true;
    }
    if (!vayu::core::is_blank_script_text (post) && !has_kind ("script.post")) {
        elements.push_back (
        { { "id", vayu::utils::generate_id ("el_") }, { "kind", "script.post" },
        { "enabled", true }, { "config", { { "script", post } } } });
        changed = true;
    }
    return changed ? std::optional<std::string> (elements.dump ()) : std::nullopt;
}

/**
 * Fold @p table's `pre_request_script` / `post_request_script` into
 * `elements`, row by row, on the still-open @p connection. Returns false on
 * the first SQLite error (message left in @p error), which aborts the whole
 * migration (the caller rolls the transaction back) rather than leaving some
 * rows folded and others not.
 *
 * A genuinely pre-cutover database (older than #1513) has neither the
 * `elements` column nor, on some rows, both script columns - only the
 * migration this function runs ever adds `elements` for such a file, and it
 * runs ahead of `sync_schema ()`. So the column set is read fresh here rather
 * than assumed: a missing `elements` column is added first (the same shape
 * `sync_schema` would create), and a missing script column reads as `''`
 * instead of failing to prepare.
 */
bool fold_table_scripts_into_elements (sqlite3* connection, const char* table, std::string& error) {
    const auto columns  = table_columns (connection, table);
    const bool has_pre  = has_column (columns, "pre_request_script");
    const bool has_post = has_column (columns, "post_request_script");

    if (!has_column (columns, "elements")) {
        const std::string alter_sql = std::string ("ALTER TABLE ") + table +
        " ADD COLUMN elements TEXT NOT NULL DEFAULT '[]';";
        if (sqlite3_exec (connection, alter_sql.c_str (), nullptr, nullptr, nullptr) != SQLITE_OK) {
            error = sqlite3_errmsg (connection);
            return false;
        }
    }

    const std::string pre_expr  = has_pre ? "pre_request_script" : "''";
    const std::string post_expr = has_post ? "post_request_script" : "''";
    const std::string select_sql =
    "SELECT id, " + pre_expr + ", " + post_expr + ", elements FROM " + table + ";";
    sqlite3_stmt* select_statement = nullptr;
    if (sqlite3_prepare_v2 (connection, select_sql.c_str (), -1,
        &select_statement, nullptr) != SQLITE_OK) {
        error = sqlite3_errmsg (connection);
        return false;
    }
    const std::string update_sql =
    std::string ("UPDATE ") + table + " SET elements = ?1 WHERE id = ?2;";
    sqlite3_stmt* update_statement = nullptr;
    if (sqlite3_prepare_v2 (connection, update_sql.c_str (), -1,
        &update_statement, nullptr) != SQLITE_OK) {
        error = sqlite3_errmsg (connection);
        sqlite3_finalize (select_statement);
        return false;
    }

    const auto select_column_text = [&] (int index) {
        const auto* text = column_text (select_statement, index);
        return text != nullptr ? std::string (text) : std::string ();
    };

    bool ok = true;
    while (ok) {
        const int step = sqlite3_step (select_statement);
        if (step == SQLITE_DONE) {
            break;
        }
        if (step != SQLITE_ROW) {
            error = sqlite3_errmsg (connection);
            ok    = false;
            break;
        }
        const std::string id       = select_column_text (0);
        const std::string pre      = select_column_text (1);
        const std::string post     = select_column_text (2);
        const std::string existing = select_column_text (3);

        auto updated = fold_row_scripts_if_missing (existing, pre, post);
        if (!updated) {
            continue;
        }

        sqlite3_reset (update_statement);
        sqlite3_bind_text (update_statement, 1, updated->c_str (), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text (update_statement, 2, id.c_str (), -1, SQLITE_TRANSIENT);
        if (sqlite3_step (update_statement) != SQLITE_DONE) {
            error = sqlite3_errmsg (connection);
            ok    = false;
        }
    }

    sqlite3_finalize (select_statement);
    sqlite3_finalize (update_statement);
    return ok;
}

} // namespace

/**
 * Whether `file` could be a SQLite database at all, answered without
 * opening it.
 *
 * Asking SQLite instead *destroys evidence*: an open that fails with "file
 * is not a database" deletes the `-wal` and `-shm` beside the file first
 * (measured, not assumed), and a `-wal` holds committed transactions the
 * main file does not - so by the time the recovery branch below moved the
 * set aside there was nothing left to move but the main file. Sixteen bytes
 * answer the question, so a file SQLite would refuse outright never reaches
 * it. A file it *recognises* and then fails on is still its to recover, WAL
 * included; this covers the case where it would not even try.
 */
bool has_sqlite_header (const fs::path& file) {
    std::error_code ec;
    const auto size = fs::file_size (file, ec);
    // A zero-length file is a valid empty database to SQLite, and an
    // unreadable one is the probe's question rather than this one's.
    if (ec || size == 0) {
        return true;
    }
    constexpr std::string_view SQLITE_HEADER =
    std::string_view ("SQLite format 3\0", 16);
    std::array<char, 16> header{};
    std::ifstream in (file, std::ios::binary);
    in.read (header.data (), static_cast<std::streamsize> (header.size ()));
    return in.gcount () == static_cast<std::streamsize> (header.size ()) &&
    std::string_view (header.data (), header.size ()) == SQLITE_HEADER;
}

/** Copies a database file and its `-wal`/`-shm` sidecars over the destination. */
bool copy_db_files (const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    if (!fs::exists (src, ec))
        return false;

    // Copy main file
    fs::copy_file (src, dst, fs::copy_options::overwrite_existing, ec);
    if (ec) {
        vayu::utils::log_warning ("db", "Backup copy failed: " + ec.message ());
        return false;
    }

    // Copy WAL/SHM if they exist
    fs::path src_wal = src.string () + "-wal";
    fs::path dst_wal = dst.string () + "-wal";
    if (fs::exists (src_wal, ec)) {
        fs::copy_file (src_wal, dst_wal, fs::copy_options::overwrite_existing, ec);
    }

    fs::path src_shm = src.string () + "-shm";
    fs::path dst_shm = dst.string () + "-shm";
    if (fs::exists (src_shm, ec)) {
        fs::copy_file (src_shm, dst_shm, fs::copy_options::overwrite_existing, ec);
    }
    return true;
}

/**
 * What a start does when the database it found will not open.
 *
 * The backup is validated *before* the corrupt original is touched, so a start
 * that finds both files broken still has both of them afterwards.
 *
 * @param probe whether a database at a path opens and carries this build's
 *        schema - the constructor's own, because only it can name `Impl`.
 */
void recover_database (const fs::path& db_file,
const fs::path& backup_file,
const std::string& db_path,
const std::function<bool (const std::string&)>& probe) {
    // The backup is validated *before* the corrupt original is touched, so
    // a start that finds both files broken still has both of them
    // afterwards.
    const bool backup_exists = fs::exists (backup_file);
    const bool backup_valid  = backup_exists &&
    has_sqlite_header (backup_file) && probe (backup_file.string ());
    if (backup_exists && !backup_valid) {
        vayu::utils::log_error ("db",
        "The backup at " + backup_file.string () +
        " does not open either; it is left in place and will not be restored.");
    }

    // Nothing to recover from when the file is simply absent - that is a
    // first run, and the fresh database below is the right answer to it.
    if (fs::exists (db_file)) {
        const std::optional<fs::path> quarantined = quarantine_db_files (db_file);
        std::optional<std::string> quarantined_path;
        if (quarantined) {
            quarantined_path = quarantined->string ();
            prune_quarantined_databases (db_path, QUARANTINE_SETS_KEPT);
        } else {
            // Quarantining is what this branch exists to do, but a rename
            // that fails must not become a daemon that will not start: the
            // corrupt files are removed as before, and the marker says so
            // rather than claiming a copy the user could go and look for.
            std::error_code ec;
            fs::remove (db_file, ec);
            fs::remove (db_file.string () + "-wal", ec);
            fs::remove (db_file.string () + "-shm", ec);
        }

        RecoveryOutcome outcome = quarantined ? RecoveryOutcome::StartedFreshQuarantined :
                                                RecoveryOutcome::DeletedCorrupt;
        if (backup_valid && copy_db_files (backup_file, db_file)) {
            vayu::utils::log_info ("db", "Database restored from backup. Retrying...");
            outcome = RecoveryOutcome::RestoredFromBackup;
        } else if (backup_valid) {
            vayu::utils::log_error ("db",
            "The backup validated but could not be "
            "copied back; starting fresh.");
        } else if (backup_exists && quarantined) {
            outcome = RecoveryOutcome::BackupAlsoCorrupt;
        }

        // The marker is what tells the user what happened to their data
        // (issue #922). It has to be written by this branch rather than
        // inferred later from an empty database, which is exactly what a
        // genuine first run also looks like. It is written *after* the
        // files have been moved so a marker never claims an outcome that
        // did not happen.
        write_recovery_marker (db_path, outcome, quarantined_path);
    }
}

/**
 * The one-shot migration issue #1514's cut-over describes, run on the raw
 * file with its own `sqlite3` connection, strictly ahead of the constructor's
 * `sync_schema ()` calls (`Impl`'s constructor already opens a connection and
 * sets `journal_mode`, so this must run *before* any `Impl` exists on
 * @p path, never after - see `engine/CLAUDE.md`'s "Removing a column" rule).
 *
 * `PRAGMA user_version` is the marker: 0 means pre-cutover (folds any
 * unrepresented script into `elements`, then sets it to 1); already at
 * `SCHEMA_VERSION` is a fast no-op; newer than `SCHEMA_VERSION` refuses to
 * start rather than silently serving - and possibly writing - settings this
 * build does not understand.
 *
 * Once this returns having bumped the version, `sync_schema ()` sees a
 * mapping with no `pre_request_script` / `post_request_script` columns and
 * `DROP COLUMN`s them; that is what makes the fold's timing load-bearing
 * rather than cosmetic.
 *
 * @throws std::runtime_error naming both versions if @p path was written by
 *         a newer engine, or if the fold itself failed partway (the
 *         transaction is rolled back first, so a throw here never leaves a
 *         half-migrated file).
 */
void migrate_before_sync (const std::string& path) {
    if (!fs::exists (path)) {
        return; // A fresh install: sync_schema creates the new mapping outright.
    }
    // `has_sqlite_header`'s own comment measured this: opening a file SQLite
    // does not even recognise deletes the `-wal` / `-shm` beside it before
    // the open call reports failure - destroying exactly the evidence
    // `quarantine_db_files` (below, in `recover_database`) exists to
    // preserve. This function runs *ahead* of that recovery path (it is the
    // constructor's very first statement), so it must not be the thing that
    // opens a corrupt file first; a file with no valid header is corruption's
    // question, not a migration's, so it is left untouched here.
    if (!has_sqlite_header (path)) {
        return;
    }

    std::string error;
    sqlite3* raw_connection = open_workspace_connection (path, error);
    if (raw_connection == nullptr) {
        // Not this pass's question to answer - the probe this runs ahead of
        // is what decides whether the file is usable at all.
        return;
    }
    std::unique_ptr<sqlite3, decltype (&sqlite3_close)> connection (
    raw_connection, &sqlite3_close);

    const auto version =
    read_pragma_int (connection.get (), "PRAGMA user_version;", error);
    if (!version || *version == SCHEMA_VERSION) {
        return;
    }
    if (*version > SCHEMA_VERSION) {
        throw std::runtime_error ("The database at " + path + " was written by schema version " +
        std::to_string (*version) + ", newer than this engine's (version " +
        std::to_string (SCHEMA_VERSION) + "). Upgrade Vayu to open it.");
    }

    const bool requests_need_fold = table_has_script_columns (connection.get (), "requests");
    const bool collections_need_fold =
    table_has_script_columns (connection.get (), "collections");
    if (!requests_need_fold && !collections_need_fold) {
        // Nothing to fold - either a fresh schema with no rows yet, or a
        // database some other path already brought to this shape.
        sqlite3_exec (connection.get (), "PRAGMA user_version = 1;", nullptr, nullptr, nullptr);
        return;
    }

    // Kept until the next successful start (issue #1487's rule) - the one
    // copy of a pre-cutover row's exact script text if the fold below were
    // ever found to have gone wrong.
    const fs::path db_file (path);
    fs::path pre_migration_backup = db_file;
    pre_migration_backup += ".pre-migration.bak";
    copy_db_files (db_file, pre_migration_backup);

    sqlite3_exec (connection.get (), "BEGIN IMMEDIATE;", nullptr, nullptr, nullptr);
    bool ok = true;
    std::string fold_error;
    if (requests_need_fold) {
        ok = ok && fold_table_scripts_into_elements (connection.get (), "requests", fold_error);
    }
    if (collections_need_fold) {
        ok = ok &&
        fold_table_scripts_into_elements (connection.get (), "collections", fold_error);
    }
    if (ok) {
        sqlite3_exec (connection.get (), "PRAGMA user_version = 1;", nullptr, nullptr, nullptr);
        sqlite3_exec (connection.get (), "COMMIT;", nullptr, nullptr, nullptr);
    } else {
        sqlite3_exec (connection.get (), "ROLLBACK;", nullptr, nullptr, nullptr);
        throw std::runtime_error (
        "Vayu could not migrate stored scripts into elements for " + path +
        ": " + (fold_error.empty () ? "unknown error" : fold_error));
    }
}

const std::optional<RecoveryRecord>& Database::recovery () const {
    return recovery_;
}

// Initialize database with optimized SQLite settings
void Database::init () {
    // Note: Schema sync is now handled in constructor for safety/recovery
    // We just verify it here or perform post-init operations

    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Initializing database...");

    // Ensure schema is synced (idempotent)
    impl_->storage.sync_schema ();

    // Shed the legacy EAV `metrics` table (issue #177). sync_schema only syncs
    // the tables the storage still declares - it does not drop the ones that
    // were removed from it - so a database written by an engine before this
    // version keeps the table and its rows (~20/sec of load run) forever
    // otherwise. The pages return to SQLite's freelist for reuse rather than
    // shrinking the file; what returns them to the filesystem is the guarded
    // reclamation at the end of this function (issue #990), which is where the
    // cost of a rewrite is decided rather than paid on every start.
    // Idempotent, so this stays rather than needing a one-shot migration flag.
    impl_->storage.drop_table_if_exists ("metrics");

    // WAL mode and the default `synchronous` are set by `Impl`'s constructor,
    // before the first `sync_schema` - see the note there. They are deliberately
    // not repeated here: two statements of one fact drift, and this one used to
    // read as though the connection had been on a rollback journal until now.

    // Seed default configuration values if empty (must be before reading config)
    seed_default_config ();

    // Apply the three configurable database PRAGMAs. All are read once, here,
    // so a later write to any of them reaches the engine on the next start -
    // which is what their restart-required flag promises.
    //
    // `cache_size` is per-connection state, so it cannot be applied once like
    // the other two: it is handed to the open callback, which re-applies it to
    // every connection sqlite_orm opens. Setting it before the first read below
    // means that read already carries it.
    impl_->cache_size_bytes.store (get_config_int (
    "dbCacheSize", vayu::core::constants::database::CACHE_SIZE_BYTES));

    // Get synchronous mode (0=OFF, 1=NORMAL, 2=FULL)
    int synchronous =
    get_config_int ("dbSynchronous", vayu::core::constants::database::SYNCHRONOUS);
    impl_->storage.pragma.synchronous (synchronous);

    // Get busy timeout in milliseconds
    int busy_timeout =
    get_config_int ("dbBusyTimeout", vayu::core::constants::database::BUSY_TIMEOUT_MS);
    impl_->storage.pragma.busy_timeout (busy_timeout);

    // Both values are read back from the connection rather than echoed from the
    // config row: what the engine asked for and what SQLite holds are two
    // different statements, and only the second one is worth logging.
    vayu::utils::log_debug ("db", "Database initialized with WAL mode",
    { { "cacheKb", applied_cache_size_bytes () / 1024 },
    { "busyTimeoutMs", busy_timeout }, { "synchronous", applied_synchronous () } });

    // Close out runs abandoned by a previous process before pruning, so an
    // orphan becomes a terminal (and therefore prunable) row in the same
    // startup. Best-effort: neither pass may block a successful startup.
    try {
        reconcile_orphaned_runs ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup run reconciliation failed: " + std::string (e.what ()));
    }

    // Bindings written before the engine stamped them (issue #709) name a
    // document and no version of it, which reads to every contract check as a
    // document that has moved - so an imported collection was measured against
    // nothing. Best-effort, like the passes around it: a repair that fails must
    // not cost the user their engine.
    try {
        if (const int64_t stamped = stamp_hashless_spec_bindings (); stamped > 0) {
            vayu::utils::log_info ("db",
            "Stamped " + std::to_string (stamped) +
            " OpenAPI binding(s) with the version of the document they name");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup spec-binding repair failed: " + std::string (e.what ()));
    }

    // The headers a pre-#1229 client saved into the request document itself
    // (issue #1229). Best-effort, like the passes around it: a repair that
    // fails must not cost the user their engine.
    try {
        if (const int64_t stripped = strip_stored_managed_headers (); stripped > 0) {
            vayu::utils::log_info ("db",
            "Disabled Vayu's own headers on " + std::to_string (stripped) +
            " stored request(s); they are added at send time");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("db",
        "Startup managed-header cleanup failed: " + std::string (e.what ()));
    }

    // No webhook inbox survives the process that opened it, so any capture row
    // still here belongs to an inbox nothing can list. Best-effort, like the
    // two passes around it.
    try {
        if (const int64_t dropped = clear_inbox_requests_all (); dropped > 0) {
            vayu::utils::log_info ("db",
            "Cleared " + std::to_string (dropped) + " inbox capture(s) left by a previous process");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning ("db",
        "Startup inbox capture cleanup failed: " + std::string (e.what ()));
    }

    // Trim accumulated run history on startup (design-mode clicks and load runs
    // are otherwise append-only). Best-effort: a prune failure must not block a
    // successful startup.
    try {
        prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup run pruning failed: " + std::string (e.what ()));
    }

    // Destroy what has sat in the trash past its retention (issue #988). Here
    // rather than on every delete, on the same reasoning as run pruning: this
    // is a sweep over rows nobody is looking at, and a startup is when the
    // engine can afford one. Best-effort for the same reason too - a failed
    // sweep must not be a daemon that will not start.
    try {
        purge_expired_trash_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup trash purge failed: " + std::string (e.what ()));
    }

    // Give the pages the sweeps above freed back to the filesystem (issue
    // #990). Last of the startup passes, so it sees what every one of them
    // freed rather than only the run prune's share, and guarded, because a
    // rewrite of the whole database is not something to do on every start: a
    // quarter of the file has to be free pages holding at least 10 MiB before
    // this runs at all.
    //
    // The write lock it takes is the one the `metrics` drop above declines to
    // pay, and what makes it payable here is that there is nothing waiting on
    // it: `daemon.cpp` runs `init` before it starts the HTTP listener, and the
    // lock file has already refused a second engine. The DB mutex this function
    // holds throughout is held over the rewrite too, and for the same reason
    // that costs nothing - there is no second caller yet to block. What it does
    // cost is startup latency, which is why the outcome is logged: the app
    // gives the engine 45 seconds to answer `/health`. Best-effort like the
    // passes above - reclaiming disk must not be a daemon that will not start.
    try {
        log_reclaim_outcome (reclaim_freed_pages (impl_->opened_file));
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup database reclamation failed: " + std::string (e.what ()));
    }
}

int64_t Database::stamp_hashless_spec_bindings () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    int64_t stamped = 0;
    // Deleted rows are backfilled too (issue #988). This repairs what a row
    // always meant rather than answering a question a user asked, and a
    // collection restored after this pass ran would otherwise carry an
    // unstamped binding forever - the pass is a startup one, not a schedule.
    // `replace` writes the whole struct, so `deleted_at` survives it.
    for (auto& col : impl_->storage.get_all<Collection> ()) {
        // `fetched_at`, not now: every row this pass can reach was written by an
        // import that stored the document in the same transaction, so that is
        // when the collection was bound to it. Stamping them all with the
        // current time would tell the user they synced today.
        auto rewritten = vayu::core::stamp_spec_binding (col.openapi,
        [&] (const std::string& spec_id) -> std::optional<vayu::core::SpecStamp> {
            auto document = get_spec_document (spec_id);
            if (!document) {
                return std::nullopt;
            }
            return vayu::core::SpecStamp{ document->hash, document->fetched_at };
        });
        if (!rewritten) {
            continue;
        }
        col.openapi = std::move (*rewritten);
        // `updated_at` is deliberately left alone: this records what the row
        // always meant rather than an edit anybody made to it.
        impl_->storage.replace (col);
        ++stamped;
    }
    return stamped;
}

namespace {
// A repair that runs once is a migration and gets a migration's bookkeeping
// (issue #1487). #1492 will give this kind of marker a proper home; until
// then a `config_entries` row - `advanced`, no everyday user story - is where
// this file's other internal-only flags already live.
constexpr std::string_view MANAGED_HEADERS_STRIPPED_KEY =
"managedHeadersStripped";
} // namespace

int64_t Database::strip_stored_managed_headers () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    if (get_config_bool (std::string (MANAGED_HEADERS_STRIPPED_KEY), false)) {
        return 0;
    }

    // Only rows whose `headers` text could contain one of the three legacy
    // names are worth loading and JSON-parsing. `LIKE` is ASCII
    // case-insensitive by default, the same fold `legacy_managed_row` applies
    // to a matched key, so a workspace with nothing left to strip costs one
    // scan of this column rather than a materialisation of every request's
    // body and script (issue #1487).
    // Trash is left alone (issue #1491): a restored row runs through the same
    // disable pass on the way back, in `restore_request_locked` /
    // `restore_collection_locked`, so a request in the trash stays
    // byte-identical until then rather than being rewritten while nobody can
    // see or undo it.
    auto candidates =
    impl_->storage.get_all<Request> (where (is_null (&Request::deleted_at) &&
    (like (&Request::headers, "%x-vayu-version%") or like (&Request::headers, "%x-request-id%") or
    like (&Request::headers, "%user-agent%"))));

    auto mark_done = [&] {
        save_config_entry (ConfigEntry{
        .key   = std::string (MANAGED_HEADERS_STRIPPED_KEY),
        .value = "true",
        .type  = "boolean",
        .label = "Legacy managed headers stripped",
        .description =
        "Whether requests saved before 0.26.0 have had the "
        "engine's own X-Vayu-Version, X-Request-ID and User-Agent headers "
        "removed from storage. Internal bookkeeping for a one-time cleanup; "
        "turning it off re-runs the cleanup on the next start.",
        .category      = "general_engine",
        .default_value = "false",
        .min_value     = std::nullopt,
        .max_value     = std::nullopt,
        .options       = std::nullopt,
        .updated_at    = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
        .count (),
        .requires_restart = false,
        .advanced         = true,
        .keywords         = "[]",
        .unit             = std::nullopt,
        });
    };

    if (candidates.empty ()) {
        mark_done ();
        return 0;
    }

    // `<db>.pre-upgrade.bak` is written once, right before the first row this
    // pass ever rewrites, and nothing after this call touches it again -
    // unlike `<db>.bak`, which the *next* clean start refreshes from whatever
    // the live file holds by then (issue #1487). It is the one place the
    // pre-strip rows survive more than a single restart.
    const fs::path db_file (impl_->opened_file);
    fs::path pre_upgrade_backup = db_file;
    pre_upgrade_backup += ".pre-upgrade.bak";
    copy_db_files (db_file, pre_upgrade_backup);

    // One transaction for the whole rewrite, not one implicit commit per row -
    // the same shape `seed_default_config` uses and for the same reason:
    // `/health` cannot answer until `init ()` returns, and a workspace with
    // thousands of candidate rows made every one of them its own commit.
    auto strip_transaction = impl_->storage.transaction_guard ();

    int64_t stripped = 0;
    for (auto& request : candidates) {
        auto rewritten = vayu::http::strip_legacy_managed_headers (request.headers);
        if (!rewritten) {
            continue;
        }
        request.headers = std::move (*rewritten);
        // `updated_at` is left alone, as the spec-binding repair leaves it:
        // this disables what the app wrote on its own behalf, not an edit
        // anybody made, and touching the timestamp would sort every request a
        // user owns to the top of "recently changed" on one upgrade.
        impl_->storage.replace (request);
        ++stripped;
    }

    mark_done ();
    strip_transaction.commit ();
    return stripped;
}

Database::BackupSlot::BackupSlot (Database& db) : db_ (db) {
    bool expected = false;
    held_ = db_.impl_->backup_running.compare_exchange_strong (expected, true);
}

Database::BackupSlot::~BackupSlot () {
    if (held_) {
        db_.impl_->backup_running.store (false);
    }
}

// ============================================================================
// Workspace backup (issue #987) - a snapshot the user owns
// ============================================================================

namespace {

/// The two halves of a snapshot's file name. Retention only ever removes a file
/// carrying both, so anything else that has found its way into `backups/` -
/// including a copy the user made themselves - is left where it is.
constexpr std::string_view BACKUP_PREFIX    = "vayu-";
constexpr std::string_view BACKUP_EXTENSION = ".db";

/// Bound on the collision walk below. A thousand snapshots inside one
/// millisecond is not a case that happens; the loop is finite so that a
/// filesystem answering `exists` wrongly cannot hang a request.
constexpr int BACKUP_NAME_ATTEMPTS = 1000;

/**
 * A snapshot's file name for the instant @p stamp_ms, or an empty string for an
 * instant that cannot be converted.
 *
 * `vayu-YYYYMMDD-HHMMSS-mmm.db`. UTC rather than local time, so a machine that
 * changes timezone does not reorder its own backups, and fixed-width so the
 * names sort chronologically as *text* - which is what lets retention pick the
 * oldest without asking the filesystem for an mtime it may round, or may not
 * have preserved across a copy.
 */
std::string backup_file_name (int64_t stamp_ms) {
    const auto seconds = static_cast<std::time_t> (stamp_ms / 1000);
    const auto millis  = static_cast<int> (stamp_ms % 1000);
    const std::string stamp = vayu::utils::format_utc_time (seconds, "%Y%m%d-%H%M%S");
    if (stamp.empty ()) {
        return {};
    }
    return std::format ("{}{}-{:03d}{}", BACKUP_PREFIX, stamp, millis, BACKUP_EXTENSION);
}

/// Whether @p name is a file this feature wrote - the only kind retention removes.
bool is_backup_file_name (const std::string& name) {
    return name.starts_with (BACKUP_PREFIX) && name.ends_with (BACKUP_EXTENSION) &&
    name.size () > BACKUP_PREFIX.size () + BACKUP_EXTENSION.size ();
}

/**
 * Copy the database at @p source into @p destination with `VACUUM INTO`.
 *
 * @return an empty string on success, or what SQLite refused.
 *
 * On a connection of its own rather than the one every write is serialized
 * through - `open_workspace_connection` says why, and the startup reclamation
 * takes one for the same reason. The second half of it is this function's
 * alone: a `VACUUM INTO` of a large workspace occupies its connection for as
 * long as the copy takes, and on the shared one that is every other endpoint
 * waiting behind a button someone pressed. Under WAL a second reader sees every
 * committed transaction and blocks no writer, so the snapshot is consistent and
 * costs the running engine nothing but disk bandwidth.
 *
 * The destination is *bound*, not concatenated: a path is user data on every
 * platform and a quote in a directory name would otherwise be a SQL fragment.
 */
std::string vacuum_into (const std::string& source, const std::string& destination) {
    std::string message;
    sqlite3* connection = open_workspace_connection (source, message);
    if (connection == nullptr) {
        return message;
    }

    sqlite3_stmt* statement = nullptr;
    int rc = sqlite3_prepare_v2 (connection, "VACUUM INTO ?", -1, &statement, nullptr);
    if (rc != SQLITE_OK) {
        message = sqlite3_errmsg (connection);
        sqlite3_close (connection);
        return message;
    }
    // SQLITE_TRANSIENT: sqlite copies the text, so `destination` need not
    // outlive the bind - which it does anyway, said here so a later refactor
    // cannot quietly make the lifetime load-bearing.
    sqlite3_bind_text (statement, 1, destination.c_str (), -1, SQLITE_TRANSIENT);

    if (sqlite3_step (statement) != SQLITE_DONE) {
        message = sqlite3_errmsg (connection);
    }
    sqlite3_finalize (statement);
    sqlite3_close (connection);
    return message;
}

/**
 * Remove all but the newest @p keep snapshots from @p directory.
 *
 * @return how many files were removed. @p keep of 0 or less is unlimited, which
 *         is what the `maxBackupsRetained` entry documents.
 */
int64_t prune_backup_files (const fs::path& directory, int keep) {
    if (keep <= 0) {
        return 0;
    }
    std::error_code ec;
    std::vector<fs::path> snapshots;
    for (const auto& entry : fs::directory_iterator (directory, ec)) {
        if (entry.is_regular_file (ec) &&
        is_backup_file_name (entry.path ().filename ().string ())) {
            snapshots.push_back (entry.path ());
        }
    }
    if (snapshots.size () <= static_cast<size_t> (keep)) {
        return 0;
    }
    // Chronological, because the names are fixed-width UTC stamps - see
    // `backup_file_name`.
    std::sort (snapshots.begin (), snapshots.end ());

    int64_t removed        = 0;
    const size_t to_remove = snapshots.size () - static_cast<size_t> (keep);
    for (size_t i = 0; i < to_remove; ++i) {
        // `.at` rather than a subscript: the index is computed above, and one
        // predictable compare turns a wrong bound into a throw the route
        // reports instead of a read past the end that deletes something else.
        const fs::path& oldest = snapshots.at (i);
        std::error_code remove_ec;
        if (fs::remove (oldest, remove_ec)) {
            ++removed;
        } else {
            // Best-effort: a snapshot that will not delete is a file the user
            // still has, which is the safe direction for this feature to fail
            // in. It is said out loud rather than swallowed, because a
            // retention setting that silently stops applying grows a disk.
            vayu::utils::log_warning ("db",
            "Could not prune the backup " + oldest.string () + ": " + remove_ec.message ());
        }
    }
    return removed;
}

} // namespace

std::string Database::backups_directory () const {
    return (fs::path (impl_->opened_file).parent_path () / "backups").string ();
}

std::expected<BackupRecord, BackupFailure> Database::backup_workspace (int64_t now) {
    BackupSlot slot (*this);
    if (!slot.held ()) {
        return std::unexpected (
        BackupFailure{ true, "A workspace backup is already running" });
    }

    if (now <= 0) {
        // A snapshot is named for the instant it was taken, so an instant that
        // is not one has no name. Refused rather than defaulted to "now": a
        // caller with a broken clock would otherwise get a file whose name says
        // something untrue about when its contents are from.
        return std::unexpected (BackupFailure{ false,
        "Invalid backup timestamp " + std::to_string (now) +
        ": a snapshot is named for the instant it was taken" });
    }

    const fs::path directory = backups_directory ();
    std::error_code ec;
    fs::create_directories (directory, ec);
    if (ec && !fs::is_directory (directory)) {
        return std::unexpected (BackupFailure{ false,
        "Could not create the backup directory " + directory.string () + ": " +
        ec.message () });
    }

    // A taken name is stepped over rather than written through, exactly as the
    // corruption quarantine does - and here it is also what keeps SQLite happy,
    // since `VACUUM INTO` refuses a destination that already exists.
    int64_t stamp = now;
    fs::path destination;
    for (int attempt = 0; attempt < BACKUP_NAME_ATTEMPTS; ++attempt, ++stamp) {
        const std::string name = backup_file_name (stamp);
        if (name.empty ()) {
            return std::unexpected (BackupFailure{ false,
            "Could not name a backup for the instant " + std::to_string (stamp) });
        }
        std::error_code exists_ec;
        if (fs::path candidate = directory / name; !fs::exists (candidate, exists_ec)) {
            destination = std::move (candidate);
            break;
        }
    }
    if (destination.empty ()) {
        return std::unexpected (BackupFailure{ false,
        "Could not find an unused backup name in " + directory.string () });
    }

    if (const std::string refusal = vacuum_into (impl_->opened_file, destination.string ());
    !refusal.empty ()) {
        // A failed VACUUM INTO can leave a partial file behind, and a partial
        // file with a snapshot's name is worse than no snapshot: retention
        // would count it, and a restore would reach for it.
        std::error_code remove_ec;
        fs::remove (destination, remove_ec);
        return std::unexpected (BackupFailure{ false,
        "Could not write the backup to " + destination.string () + ": " + refusal });
    }

    std::error_code size_ec;
    const auto size = fs::file_size (destination, size_ec);

    BackupRecord record;
    record.path       = destination.string ();
    record.size_bytes = size_ec ? 0 : static_cast<int64_t> (size);
    record.created_at = stamp;
    // Retention runs *after* the snapshot exists, and a failure here must not
    // turn a backup that succeeded into a reported failure - the user has the
    // file they asked for, and the worst this leaves behind is one snapshot too
    // many. This is also what makes the declared "never throws" true: it is the
    // one step that reads the database.
    try {
        record.pruned = prune_backup_files (directory,
        get_config_int ("maxBackupsRetained",
        vayu::core::constants::database::MAX_BACKUPS_RETAINED));
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Backup retention did not run: " + std::string (e.what ()));
    }

    vayu::utils::log_info ("db",
    "Workspace backed up to " + record.path + " (" +
    std::to_string (record.size_bytes) + " bytes" +
    (record.pruned > 0 ? ", pruned " + std::to_string (record.pruned) + " older snapshot(s)" : "") +
    ")");
    return record;
}

int Database::applied_cache_size_bytes () const {
    // No DB mutex: the value is an atomic the open callback writes, and taking
    // the mutex here would order this read behind whatever query is running.
    return impl_->applied_cache_size_bytes.load ();
}

int Database::applied_synchronous () const {
    // Unlike the cache size above this is a query, not a cached atomic, so it
    // takes the mutex the rest of the storage access does.
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.pragma.synchronous ();
}

} // namespace vayu::db
