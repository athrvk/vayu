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
#include <expected>
#include <filesystem>
#include <format>
#include <fstream>
#include <functional>
#include <initializer_list>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <vector>

#include "config_seeds/seed.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/db/recovery.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/parse.hpp"
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
 * The backup's `VACUUM INTO` runs on one of these rather than on the
 * connection every write is serialized on, so a large copy does not hold that
 * connection (and the DB mutex) for its length; the flags are decided here
 * once rather than per caller. The busy timeout is the caller's: the
 * constructor's migration waits as long as its probe does (issue #2420).
 *
 * @return the connection, or `nullptr` with @p error set to what SQLite
 *         refused. The caller owns what it gets and closes it.
 */
sqlite3* open_workspace_connection (const std::string& path,
std::chrono::milliseconds busy_timeout,
std::string& error) {
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
    sqlite3_busy_timeout (connection, static_cast<int> (busy_timeout.count ()));
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
 * Split from the function below, which measures the file first.
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
 * On @p connection, the one the storage holds open (`open_forever`). The
 * checkpoint that shrinks the file has to truncate it, and Windows refuses to
 * truncate a file any connection has mapped, so no connection maps it:
 * `mmap_size` is 0 on this one and on the run-row reader (#2433). A mapping
 * reintroduced on either leaves the rewrite committed and the file at its old
 * size. The caller holds the DB mutex, so nothing else is using that
 * connection meanwhile.
 */
ReclaimOutcome reclaim_freed_pages (sqlite3* connection, const std::string& path) {
    ReclaimOutcome outcome;
    std::error_code ec;
    const auto size = fs::file_size (path, ec);
    if (ec) {
        outcome.error = ec.message ();
        return outcome;
    }
    outcome.before_bytes = static_cast<int64_t> (size);
    outcome.after_bytes  = outcome.before_bytes;

    if (connection == nullptr) {
        outcome.error = "the storage has no open connection";
        return outcome;
    }
    return reclaim_on_connection (connection, path, outcome.before_bytes);
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

/// The refusal every failed step of `migrate_before_sync` ends in, so a row
/// failure, a refused `BEGIN`, a failed stamp and a failed `COMMIT` read alike.
[[noreturn]] void throw_migration_failure (const std::string& path, const std::string& detail) {
    throw std::runtime_error ("Vayu could not migrate the database at " + path +
    " to schema version " + std::to_string (SCHEMA_VERSION) + ": " + detail);
}

/// Runs one statement of the migration and throws when SQLite refuses it. A
/// step whose result is dropped leaves the file half migrated with the version
/// unmoved, and `sync_schema ()` then drops the columns the rows were to be
/// folded out of.
void exec_or_throw (sqlite3* connection, const std::string& sql, const std::string& path) {
    if (sqlite3_exec (connection, sql.c_str (), nullptr, nullptr, nullptr) == SQLITE_OK) {
        return;
    }
    throw_migration_failure (path, sqlite3_errmsg (connection));
}

/// Stamps @p connection with this build's `SCHEMA_VERSION` (`database.hpp`).
/// The one spelling of the write, so a bump of the constant is a bump of
/// every path that marks a database migrated.
/// @throws std::runtime_error when SQLite refuses the write.
void stamp_schema_version (sqlite3* connection, const std::string& path) {
    exec_or_throw (connection,
    "PRAGMA user_version = " + std::to_string (SCHEMA_VERSION) + ";", path);
}

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

// ---------------------------------------------------------------------------
// Schema versions 4 and 6: file trust leaves the stored bodies
// ---------------------------------------------------------------------------

/// One stored value the file-trust step replaces.
struct RowRewrite {
    const char* table  = "";
    const char* column = "";
    std::string id;
    std::string text;
};

/// One allowed folder the file-trust step removes, and the rule that refused it.
struct RefusedRoot {
    std::string id;
    std::string path;
    std::string reason;
};

/// A file reference stored as chosen whose `src` no longer names a regular
/// file (deleted, or on a drive or share not mounted at upgrade time). It gets
/// no grant, so from here on it reads as not chosen on this machine.
struct UngrantedChoice {
    const char* table = "";
    std::string id;
    std::string path;
};

/// Everything the file-trust step changes, read before anything is written so
/// a database with nothing to change is stamped without a backup or a
/// transaction.
struct FileTrustPlan {
    std::vector<RowRewrite> rewrites;
    std::vector<RefusedRoot> refused_roots;
    /// Canonical, deduplicated: the `file_grants` rows to insert.
    std::set<std::string> grants;
    /// Reported, never written: one per stored body that names it.
    std::vector<UngrantedChoice> ungranted;

    [[nodiscard]] bool empty () const {
        return rewrites.empty () && refused_roots.empty () && grants.empty ();
    }
};

/// `file_grants` exactly as `make_vayu_storage` maps it. Created here because
/// the grants are read out of the bodies before `sync_schema ()` runs; any
/// difference from the mapping makes `sync_schema ()` rebuild the table empty.
constexpr const char* FILE_GRANTS_DDL =
"CREATE TABLE IF NOT EXISTS \"file_grants\" (\"id\" TEXT PRIMARY KEY NOT NULL, "
"\"path\" TEXT UNIQUE NOT NULL, \"created_at\" INTEGER NOT NULL);";

/// Whether @p ref was chosen in the editor, as the database stored it: an
/// explicit `false`, or no key at all on a database older than version 4,
/// whose writes left the key out exactly when the editor wrote the path.
bool stored_as_chosen (const nlohmann::json& ref, bool absent_means_chosen) {
    const auto found = ref.find ("unresolved");
    if (found == ref.end ()) {
        return absent_means_chosen;
    }
    return found->is_boolean () && !found->get<bool> ();
}

/// Grants the chosen @p src when it still names a regular file
/// (`grantable_file_path`), and otherwise adds it to @p ungranted. An empty or
/// templated `src` is neither: it named no file to carry over, and a send
/// refuses a `{{` whatever the trust.
void settle_choice (const std::string& src,
std::set<std::string>& grants,
std::vector<std::string>& ungranted) {
    if (auto path = vayu::http::grantable_file_path (src)) {
        grants.insert (std::move (*path));
        return;
    }
    if (!src.empty () && src.find ("{{") == std::string::npos) {
        ungranted.push_back (src);
    }
}

/// Removes the trust key from every file reference of @p body, settling each
/// one stored as chosen (`settle_choice`). True when the body changed.
bool settle_body_trust (nlohmann::json& body,
bool absent_means_chosen,
std::set<std::string>& grants,
std::vector<std::string>& ungranted) {
    bool changed = false;
    vayu::json::for_each_file_ref (body, [&] (nlohmann::json& ref) {
        const auto src = ref.find ("src");
        if (src != ref.end () && src->is_string () &&
        stored_as_chosen (ref, absent_means_chosen)) {
            settle_choice (src->get<std::string> (), grants, ungranted);
        }
        changed = ref.erase ("unresolved") > 0 || changed;
    });
    return changed;
}

/**
 * Plans the file-trust step over @p table's @p column (#2356): every stored
 * file reference loses `unresolved`, and one a person chose becomes a grant
 * (`settle_body_trust`). The engine derives trust from roots and grants from
 * here on, so nothing stored may still claim it.
 *
 * @p in_snapshot reads the body at the value's `body` member (a run's
 * `config_snapshot`, the payload a history entry is re-opened from) rather
 * than the value itself (`requests.body`). A value that is not JSON is left
 * byte-identical and logged, never dropped. Only values with `"file"` in their
 * text are parsed at all.
 */
void plan_trust_removal (sqlite3* connection,
const char* table,
const char* column,
bool in_snapshot,
bool absent_means_chosen,
FileTrustPlan& plan) {
    if (!has_column (table_columns (connection, table), column)) {
        return;
    }
    const std::string sql = std::string ("SELECT id, ") + column + " FROM " +
    table + " WHERE " + column + " LIKE '%\"file\"%';";
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, sql.c_str (), -1, &statement, nullptr) != SQLITE_OK) {
        return;
    }
    while (sqlite3_step (statement) == SQLITE_ROW) {
        const auto* id   = column_text (statement, 0);
        const auto* text = column_text (statement, 1);
        if (id == nullptr || text == nullptr) {
            continue;
        }
        nlohmann::json value =
        nlohmann::json::parse (text, nullptr, /*allow_exceptions=*/false);
        if (value.is_discarded ()) {
            vayu::utils::log_warning ("db", "A stored request body is not JSON; its file references were left as they are",
            { { "table", table }, { "id", id } });
            continue;
        }
        nlohmann::json* body = &value;
        if (in_snapshot) {
            const auto member = value.find ("body");
            if (!value.is_object () || member == value.end ()) {
                continue;
            }
            body = &*member;
        }
        std::vector<std::string> ungranted;
        if (settle_body_trust (*body, absent_means_chosen, plan.grants, ungranted)) {
            plan.rewrites.push_back ({ table, column, id, value.dump () });
        }
        for (auto& path : ungranted) {
            plan.ungranted.push_back ({ table, id, std::move (path) });
        }
    }
    sqlite3_finalize (statement);
}

/**
 * The allowed folders `refused_root_reason` now refuses: a filesystem or drive
 * root, the home folder, or a folder containing it. `POST /file-roots`
 * refuses them from schema version 4 on; this removes the ones stored before,
 * so `FileAccessPolicy::from_database` reads only rows the route would accept
 * and carries no second check of its own.
 */
void plan_refused_roots (sqlite3* connection, std::vector<RefusedRoot>& out) {
    if (!has_column (table_columns (connection, "file_roots"), "path")) {
        return;
    }
    const std::string home  = vayu::platform::home_directory ();
    std::string home_folder = vayu::http::canonical_root_path (home);
    if (home_folder.empty ()) {
        home_folder = home;
    }
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, "SELECT id, path FROM file_roots;", -1,
        &statement, nullptr) != SQLITE_OK) {
        return;
    }
    while (sqlite3_step (statement) == SQLITE_ROW) {
        const auto* id   = column_text (statement, 0);
        const auto* path = column_text (statement, 1);
        if (id == nullptr || path == nullptr) {
            continue;
        }
        if (auto reason = vayu::http::refused_root_reason (path, home_folder)) {
            out.push_back ({ id, path, std::move (*reason) });
        }
    }
    sqlite3_finalize (statement);
}

/// The first version whose stored bodies carry no trust key and whose allowed
/// folders all pass `refused_root_reason`.
constexpr int64_t DERIVED_FILE_TRUST_VERSION = 6;

/**
 * The file-trust step for a database stamped @p version, empty from version 6
 * on: a version-6 database already holds only what the step leaves, and
 * re-running `plan_refused_roots` against a rule that has since moved would
 * delete folders the user allowed under it. Requests (the trash included,
 * which is the same table) and run snapshots are the two places a body
 * `FilePlan` sends is stored. `request_examples.body` is a response's text and
 * `inbox_requests.body` the bytes a listener received: neither is ever parsed
 * as a request body, so neither is visited.
 */
FileTrustPlan plan_file_trust_migration (sqlite3* connection, int64_t version) {
    FileTrustPlan plan;
    if (version >= DERIVED_FILE_TRUST_VERSION) {
        return plan;
    }
    const bool absent_means_chosen = version < 4;
    plan_trust_removal (connection, "requests", "body", /*in_snapshot=*/false,
    absent_means_chosen, plan);
    plan_trust_removal (connection, "runs", "config_snapshot",
    /*in_snapshot=*/true, absent_means_chosen, plan);
    plan_refused_roots (connection, plan.refused_roots);
    return plan;
}

/// Runs @p sql once with @p texts bound in order, inside the caller's
/// transaction. False on a SQLite error, message in @p error.
bool run_bound (sqlite3* connection,
const std::string& sql,
std::initializer_list<const std::string*> texts,
std::string& error) {
    sqlite3_stmt* statement = nullptr;
    bool ok = sqlite3_prepare_v2 (connection, sql.c_str (), -1, &statement, nullptr) == SQLITE_OK;
    int index = 1;
    for (const std::string* text : texts) {
        if (!ok) {
            break;
        }
        sqlite3_bind_text (statement, index++, text->c_str (), -1, SQLITE_TRANSIENT);
    }
    ok = ok && sqlite3_step (statement) == SQLITE_DONE;
    if (!ok) {
        error = sqlite3_errmsg (connection);
    }
    sqlite3_finalize (statement);
    return ok;
}

/// Creates `file_grants` if it is not there yet and adds one row per path of
/// @p grants, skipping a path already granted. False on the first SQLite error.
bool insert_grants (sqlite3* connection, const std::set<std::string>& grants, std::string& error) {
    if (grants.empty ()) {
        return true;
    }
    if (sqlite3_exec (connection, FILE_GRANTS_DDL, nullptr, nullptr, nullptr) != SQLITE_OK) {
        error = sqlite3_errmsg (connection);
        return false;
    }
    const std::string insert_sql = "INSERT OR IGNORE INTO file_grants (id, "
                                   "path, created_at) VALUES (?1, ?2, " +
    std::to_string (std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ()) +
    ");";
    for (const std::string& path : grants) {
        const std::string id = vayu::utils::generate_id ("fgrant_");
        if (!run_bound (connection, insert_sql, { &id, &path }, error)) {
            return false;
        }
    }
    return true;
}

/// Applies @p plan inside the caller's transaction. False on the first SQLite
/// error, message in @p error.
bool apply_file_trust_plan (sqlite3* connection, const FileTrustPlan& plan, std::string& error) {
    for (const auto& row : plan.rewrites) {
        const std::string sql = std::string ("UPDATE ") + row.table + " SET " +
        row.column + " = ?1 WHERE id = ?2;";
        if (!run_bound (connection, sql, { &row.text, &row.id }, error)) {
            return false;
        }
    }
    for (const auto& root : plan.refused_roots) {
        if (!run_bound (connection, "DELETE FROM file_roots WHERE id = ?1;",
            { &root.id }, error)) {
            return false;
        }
    }
    return insert_grants (connection, plan.grants, error);
}

/// Says, once the step has committed or stamped, which allowed folders are
/// gone and why, so a user who finds one missing from Settings > Files can see
/// it; how many picked files the stored bodies were turned into grants for;
/// and which chosen files were not found and must be picked again.
void log_file_trust_plan (const FileTrustPlan& plan) {
    for (const auto& root : plan.refused_roots) {
        vayu::utils::log_warning ("db",
        "Removed an allowed folder for request-body files that is a "
        "filesystem root, the home folder or a folder containing it; "
        "allow a folder inside the home folder instead",
        { { "path", root.path }, { "reason", root.reason } });
    }
    if (!plan.grants.empty ()) {
        vayu::utils::log_info ("db",
        "Recorded the request-body files chosen in the editor as picked files",
        { { "count", plan.grants.size () } });
    }
    // `path`, not `src`: a field named `src` would overwrite the record's own.
    for (const auto& choice : plan.ungranted) {
        vayu::utils::log_warning ("db",
        "A request-body file chosen before the upgrade was not found, so it "
        "was not recorded as a picked file; pick it again",
        { { "table", choice.table }, { "id", choice.id }, { "path", choice.path } });
    }
    if (!plan.ungranted.empty ()) {
        vayu::utils::log_warning ("db",
        "Some request-body files chosen before the upgrade were not found and "
        "must be picked again",
        { { "count", plan.ungranted.size () } });
    }
}

// ---------------------------------------------------------------------------
// Schema version 7: sub-folders and requests share one sibling order (#2535)
// ---------------------------------------------------------------------------

/// The first version whose requests and sub-folders share one `order` space.
constexpr int64_t SHARED_SIBLING_ORDER_VERSION = 7;

/// One collection whose requests move past its sub-folders, and by how much.
struct SiblingOrderShift {
    std::string collection_id;
    int64_t amount = 0;
};

/**
 * Plans the shared-sibling-order step for a database stamped @p version.
 * Before it, a collection's sub-folders and its requests were each numbered
 * from 0 and displayed as two blocks, folders first. Each collection's
 * requests (trashed ones included) move up by one more than its highest
 * sub-folder `order`, trashed folders included so a restore cannot land on a
 * request, and further by its lowest request `order` when that is negative,
 * so every request sorts strictly after every folder and the display stays
 * as it was. A collection with no sub-folder plans nothing.
 *
 * @throws std::runtime_error when both tables are there and the read fails:
 *         an empty plan is stamped as done, and the step never runs again.
 */
std::vector<SiblingOrderShift>
plan_sibling_order_shift (sqlite3* connection, int64_t version, const std::string& path) {
    std::vector<SiblingOrderShift> shifts;
    if (version >= SHARED_SIBLING_ORDER_VERSION) {
        return shifts;
    }
    const auto requests    = table_columns (connection, "requests");
    const auto collections = table_columns (connection, "collections");
    if (!has_column (requests, "order") || !has_column (requests, "collection_id") ||
    !has_column (collections, "order") || !has_column (collections, "parent_id")) {
        return shifts;
    }
    constexpr const char* SQL =
    "SELECT r.collection_id, f.top + 1 - MIN (0, MIN (r.\"order\")) FROM "
    "requests r "
    "JOIN (SELECT parent_id, MAX (\"order\") AS top FROM collections "
    "WHERE parent_id IS NOT NULL GROUP BY parent_id) f "
    "ON f.parent_id = r.collection_id GROUP BY r.collection_id, f.top;";
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, SQL, -1, &statement, nullptr) != SQLITE_OK) {
        throw_migration_failure (path, sqlite3_errmsg (connection));
    }
    int step = sqlite3_step (statement);
    for (; step == SQLITE_ROW; step = sqlite3_step (statement)) {
        const auto* id = column_text (statement, 0);
        if (id == nullptr || sqlite3_column_type (statement, 1) == SQLITE_NULL) {
            continue;
        }
        const int64_t amount = sqlite3_column_int64 (statement, 1);
        if (amount != 0) {
            shifts.push_back ({ id, amount });
        }
    }
    const std::string error = step == SQLITE_DONE ? "" : sqlite3_errmsg (connection);
    sqlite3_finalize (statement);
    if (!error.empty ()) {
        throw_migration_failure (path, error);
    }
    return shifts;
}

/// Applies @p shifts inside the caller's transaction. False on the first
/// SQLite error, message in @p error.
bool apply_sibling_order_shift (sqlite3* connection,
const std::vector<SiblingOrderShift>& shifts,
std::string& error) {
    for (const auto& shift : shifts) {
        const std::string sql = "UPDATE requests SET \"order\" = \"order\" + " +
        std::to_string (shift.amount) + " WHERE collection_id = ?1;";
        if (!run_bound (connection, sql, { &shift.collection_id }, error)) {
            return false;
        }
    }
    return true;
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
 * What a start does when the database it found is corrupt.
 *
 * The backup is validated *before* the corrupt original is touched, so a start
 * that finds both files broken still has both of them afterwards.
 *
 * @param probe what a database at a path is - the constructor's own, because
 *        only it can name `Impl`.
 * @throws std::runtime_error when the backup cannot be examined (issue
 *         #2420): whether it would restore is unknown, so nothing is moved.
 */
void recover_database (const fs::path& db_file,
const fs::path& backup_file,
const std::string& db_path,
const std::function<ProbeResult (const std::string&)>& probe) {
    const bool backup_exists = fs::exists (backup_file);
    bool backup_valid        = false;
    if (backup_exists && has_sqlite_header (backup_file)) {
        const ProbeResult backup = probe (backup_file.string ());
        if (backup.verdict == ProbeResult::Verdict::Unavailable) {
            throw std::runtime_error (
            unavailable_database_message (backup_file.string (), backup));
        }
        backup_valid = backup.verdict == ProbeResult::Verdict::Valid;
    }
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

// ============================================================================
// Snapshots into `backups/`: the workspace backup a user asks for (issue #987)
// and the copy a start takes before it rewrites stored rows (issue #2426)
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

/// The config row retention reads, here and in `backup_workspace`.
constexpr std::string_view MAX_BACKUPS_RETAINED_KEY = "maxBackupsRetained";

/// `backups/` beside the database at @p db_path.
fs::path backups_directory_for (const std::string& db_path) {
    return fs::path (db_path).parent_path () / "backups";
}

/**
 * A snapshot's file name for the instant @p stamp_ms, or an empty string for an
 * instant that cannot be converted.
 *
 * `vayu-YYYYMMDD-HHMMSS-mmm.db`, or `vayu-YYYYMMDD-HHMMSS-mmm-<label>.db` for
 * one a start took on its own (`pre-v4`). UTC rather than local time, so a
 * machine that changes timezone does not reorder its own backups, and the stamp
 * is fixed-width and first so the names sort chronologically as *text* - which
 * is what lets retention pick the oldest without asking the filesystem for an
 * mtime it may round, or may not have preserved across a copy.
 */
std::string backup_file_name (int64_t stamp_ms, std::string_view label) {
    const auto seconds = static_cast<std::time_t> (stamp_ms / 1000);
    const auto millis  = static_cast<int> (stamp_ms % 1000);
    const std::string stamp = vayu::utils::format_utc_time (seconds, "%Y%m%d-%H%M%S");
    if (stamp.empty ()) {
        return {};
    }
    const std::string suffix = label.empty () ? std::string{} : "-" + std::string (label);
    return std::format ("{}{}-{:03d}{}{}", BACKUP_PREFIX, stamp, millis, suffix, BACKUP_EXTENSION);
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
 * through - `open_workspace_connection` says why: a `VACUUM INTO` of a large
 * workspace occupies its connection for as
 * long as the copy takes, and on the shared one that is every other endpoint
 * waiting behind a button someone pressed. Under WAL a second reader sees every
 * committed transaction and blocks no writer, so the snapshot is consistent and
 * costs the running engine nothing but disk bandwidth.
 *
 * The destination is *bound*, not concatenated: a path is user data on every
 * platform and a quote in a directory name would otherwise be a SQL fragment.
 */
/**
 * @param on_connection told the connection once it is open, and `nullptr`
 *        just before it closes, so a caller on another thread can
 *        `sqlite3_interrupt` the copy; answering false refuses the copy
 *        before it starts. Empty for a caller with nothing to interrupt.
 */
std::string vacuum_into (const std::string& source,
const std::string& destination,
const std::function<bool (sqlite3*)>& on_connection = {}) {
    std::string message;
    sqlite3* connection = open_workspace_connection (source,
    std::chrono::milliseconds (vayu::core::constants::database::BUSY_TIMEOUT_MS), message);
    if (connection == nullptr) {
        return message;
    }
    if (on_connection && !on_connection (connection)) {
        sqlite3_close (connection);
        return "cancelled before the copy started";
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
    if (on_connection) {
        on_connection (nullptr);
    }
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

/// Says so when a snapshot could not be flushed to disk. Never an error: the
/// file is whole and validated, and failing here would delete a good backup to
/// report a durability gap the next refresh closes.
void warn_unless_flushed (bool flushed, std::string_view what, const fs::path& path) {
    if (flushed) {
        return;
    }
    vayu::utils::log_warning ("db",
    "Could not flush " + std::string (what) + " to disk; it may not survive a power loss",
    { { "path", path.string () } });
}

/// Removes a database file and the `-wal` / `-shm` beside it, reporting nothing:
/// every caller is clearing a path it is about to write, or one it has just
/// decided is not a snapshot, and a leftover is the next attempt's to clear.
void remove_db_file_set (const fs::path& file) {
    std::error_code ec;
    fs::remove (file, ec);
    fs::remove (fs::path (file.string () + "-wal"), ec);
    fs::remove (fs::path (file.string () + "-shm"), ec);
}

/// A snapshot `write_snapshot` wrote, and the instant its name carries.
struct WrittenSnapshot {
    fs::path path;
    int64_t stamp_ms = 0;
};

/**
 * `VACUUM INTO` the database at @p db_path into a new file in `backups/`
 * beside it, named for @p stamp_ms and @p label, then flush it.
 *
 * A taken name is stepped over rather than written through, exactly as the
 * corruption quarantine does - and that is also what keeps SQLite happy, since
 * `VACUUM INTO` refuses a destination that already exists.
 *
 * @return the snapshot, or why there is none. A copy that failed leaves no
 *         file under a snapshot's name: retention would count it and a
 *         restore would reach for it.
 */
std::expected<WrittenSnapshot, std::string>
write_snapshot (const std::string& db_path, int64_t stamp_ms, std::string_view label) {
    const fs::path directory = backups_directory_for (db_path);
    std::error_code ec;
    fs::create_directories (directory, ec);
    if (ec && !fs::is_directory (directory)) {
        return std::unexpected ("Could not create the backup directory " +
        directory.string () + ": " + ec.message ());
    }

    int64_t stamp = stamp_ms;
    fs::path destination;
    for (int attempt = 0; attempt < BACKUP_NAME_ATTEMPTS; ++attempt, ++stamp) {
        const std::string name = backup_file_name (stamp, label);
        if (name.empty ()) {
            return std::unexpected (
            "Could not name a backup for the instant " + std::to_string (stamp));
        }
        std::error_code exists_ec;
        if (fs::path candidate = directory / name; !fs::exists (candidate, exists_ec)) {
            destination = std::move (candidate);
            break;
        }
    }
    if (destination.empty ()) {
        return std::unexpected (
        "Could not find an unused backup name in " + directory.string ());
    }

    if (const std::string refusal = vacuum_into (db_path, destination.string ());
    !refusal.empty ()) {
        remove_db_file_set (destination);
        return std::unexpected (
        "Could not write the backup to " + destination.string () + ": " + refusal);
    }

    // The file, then the entry that names it: a snapshot someone is told
    // exists must not vanish with the next power loss.
    warn_unless_flushed (vayu::platform::fsync_file (destination.string ()),
    "the workspace backup", destination);
    warn_unless_flushed (vayu::platform::fsync_directory (directory.string ()),
    "the backup directory entry", directory);
    return WrittenSnapshot{ destination, stamp };
}

/// `maxBackupsRetained` as the workspace at @p connection stores it, read
/// before any `Database` exists to ask; the default when there is no row yet
/// or it does not parse, as `get_config_int` answers.
int configured_backup_retention (sqlite3* connection) {
    constexpr int fallback = vayu::core::constants::database::MAX_BACKUPS_RETAINED;
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, "SELECT value FROM config_entries WHERE key = ?1;",
        -1, &statement, nullptr) != SQLITE_OK) {
        return fallback;
    }
    sqlite3_bind_text (statement, 1, MAX_BACKUPS_RETAINED_KEY.data (),
    static_cast<int> (MAX_BACKUPS_RETAINED_KEY.size ()), SQLITE_STATIC);
    std::optional<int> configured;
    if (sqlite3_step (statement) == SQLITE_ROW) {
        if (const char* text = column_text (statement, 0); text != nullptr) {
            configured = vayu::utils::parse_number<int> (text);
        }
    }
    sqlite3_finalize (statement);
    return configured.value_or (fallback);
}

/// Whether the database at @p connection holds any table. A file that holds
/// none has nothing to copy. A schema SQLite will not read counts as holding
/// tables, so the copy is attempted and its failure is the one reported.
bool holds_tables (sqlite3* connection) {
    sqlite3_stmt* statement = nullptr;
    if (sqlite3_prepare_v2 (connection, "SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1;",
        -1, &statement, nullptr) != SQLITE_OK) {
        return true;
    }
    const int rc = sqlite3_step (statement);
    sqlite3_finalize (statement);
    return rc != SQLITE_DONE;
}

/**
 * The copy a start takes before it rewrites stored rows (issue #2426): one
 * `backups/` snapshot labelled @p label, then retention to @p keep, the same
 * cap a workspace backup is held to.
 *
 * @return the snapshot's path, or why there is none; the caller decides what
 *         a rewrite without a copy means for it.
 */
std::expected<fs::path, std::string>
snapshot_before_rewrite (const std::string& db_path, std::string_view label, int keep) {
    const auto written = write_snapshot (db_path, config_seeds::now_ms (), label);
    if (!written) {
        return std::unexpected (written.error ());
    }
    vayu::utils::log_info ("db", "Saved a copy of the workspace before rewriting it",
    { { "path", written->path.string () } });
    prune_backup_files (backups_directory_for (db_path), keep);
    return written->path;
}

/**
 * Removes the safety copies engines before issue #2426 wrote beside the
 * database at @p db_file and never removed - `.pre-migration.bak` and
 * `.pre-upgrade.bak`, with their `-wal` and `-shm` - when written before
 * @p written_before, so a copy this process made is never the one removed.
 */
void remove_legacy_safety_copies (const fs::path& db_file, fs::file_time_type written_before) {
    for (const char* suffix : { ".pre-migration.bak", ".pre-upgrade.bak" }) {
        const fs::path copy = db_file.string () + suffix;
        std::error_code ec;
        const auto written = fs::last_write_time (copy, ec);
        if (ec || written >= written_before) {
            continue;
        }
        remove_db_file_set (copy);
        vayu::utils::log_info ("db",
        "Removed a safety copy an earlier version left beside the database",
        { { "path", copy.string () } });
    }
}

} // namespace

namespace {

/**
 * `migrate_before_sync`'s copy of a workspace it is about to raise from
 * @p from_version: `backups/vayu-<stamp>-pre-v<from_version>.db`, held to the
 * workspace's own `maxBackupsRetained`. A file with no table is not copied.
 *
 * @throws std::runtime_error, the migration's own refusal, when the copy
 *         cannot be written: a migration is not run without one.
 */
void snapshot_before_migration (sqlite3* connection, const std::string& path, int64_t from_version) {
    if (!holds_tables (connection)) {
        return;
    }
    const auto copy = snapshot_before_rewrite (path,
    "pre-v" + std::to_string (from_version), configured_backup_retention (connection));
    if (!copy) {
        throw_migration_failure (path,
        "no copy of it could be saved first (" +
        copy.error () + "). Free disk space or make the backups folder writable, then start Vayu again");
    }
}

/// The writes of `migrate_before_sync`'s transaction: the script fold, the
/// file-trust rewrite, the sibling-order shift, the stamp and the `COMMIT`.
/// The caller has opened the transaction and rolls it back on a throw.
void apply_migration_rows (sqlite3* connection,
const std::string& path,
bool requests_need_fold,
bool collections_need_fold,
const FileTrustPlan& trust_plan,
const std::vector<SiblingOrderShift>& order_shifts) {
    bool ok = true;
    std::string fold_error;
    if (requests_need_fold) {
        ok = ok && fold_table_scripts_into_elements (connection, "requests", fold_error);
    }
    if (collections_need_fold) {
        ok = ok && fold_table_scripts_into_elements (connection, "collections", fold_error);
    }
    ok = ok && apply_file_trust_plan (connection, trust_plan, fold_error);
    ok = ok && apply_sibling_order_shift (connection, order_shifts, fold_error);
    if (!ok) {
        throw_migration_failure (path, fold_error.empty () ? "unknown error" : fold_error);
    }
    stamp_schema_version (connection, path);
    exec_or_throw (connection, "COMMIT;", path);
}

} // namespace

/**
 * The one-shot migration issue #1514's cut-over describes, run on the raw
 * file with its own `sqlite3` connection, strictly ahead of the constructor's
 * `sync_schema ()` calls (`Impl`'s constructor already opens a connection and
 * sets `journal_mode`, so this must run *before* any `Impl` exists on
 * @p path, never after - see `engine/CLAUDE.md`'s "Removing a column" rule).
 *
 * `PRAGMA user_version` is the marker: 0 means pre-cutover (folds any
 * unrepresented script into `elements`, then stamps it with `SCHEMA_VERSION`);
 * 1 and 2 are stamped without a fold; below 6 the file-trust step
 * (`plan_file_trust_migration`, the rules of versions 4 and 6) and below 7 the
 * sibling-order shift (`plan_sibling_order_shift`) run in the same
 * transaction; already at `SCHEMA_VERSION` is a fast no-op; newer
 * than `SCHEMA_VERSION` refuses to start rather than silently serving - and
 * possibly writing - settings this build does not understand.
 *
 * Once this returns having bumped the version, `sync_schema ()` sees a
 * mapping with no `pre_request_script` / `post_request_script` columns and
 * `DROP COLUMN`s them; that is what makes the fold's timing load-bearing
 * rather than cosmetic.
 *
 * Before anything raises the version, @p snapshot `Take` writes
 * `backups/vayu-<stamp>-pre-v<N>.db` (`snapshot_before_rewrite`): the copy an
 * engine at version N can still open, which nothing else keeps once
 * `<db>.bak` is refreshed from the migrated file (issue #2426). A file with no
 * table is not copied.
 *
 * @param snapshot `Skip` only for the probe, whose candidates (a `.bak`, the
 *        refresh's own snapshot) are not the workspace a person will go back to.
 * @param on_connection told the connection once it is open, before anything
 *        is read from it; a test installs a `sqlite3_commit_hook` here. Empty
 *        in production.
 *
 * @return whether @p path was already at `SCHEMA_VERSION`, so nothing was
 *         written; false also for a file this pass did not open.
 *
 * @throws std::runtime_error naming both versions if @p path was written by
 *         a newer engine, or if a step of the migration failed - the snapshot,
 *         a row of the fold, the `BEGIN`, the stamp or the `COMMIT` (the
 *         transaction is rolled back first, so a throw here never leaves a
 *         half-migrated file and the next start runs the migration again).
 */
bool migrate_before_sync (const std::string& path,
std::chrono::milliseconds busy_timeout,
PreMigrationSnapshot snapshot,
const std::function<void (sqlite3*)>& on_connection) {
    if (!fs::exists (path)) {
        return false; // A fresh install: sync_schema creates the new mapping outright.
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
        return false;
    }

    std::string error;
    sqlite3* raw_connection = open_workspace_connection (path, busy_timeout, error);
    if (raw_connection == nullptr) {
        // Not this pass's question to answer - the probe this runs ahead of
        // is what decides whether the file is usable at all.
        return false;
    }
    std::unique_ptr<sqlite3, decltype (&sqlite3_close)> connection (
    raw_connection, &sqlite3_close);
    if (on_connection) {
        on_connection (connection.get ());
    }

    const auto version =
    read_pragma_int (connection.get (), "PRAGMA user_version;", error);
    if (!version) {
        return false;
    }
    if (*version == SCHEMA_VERSION) {
        return true;
    }
    if (*version > SCHEMA_VERSION) {
        throw std::runtime_error ("The database at " + path + " was written by schema version " +
        std::to_string (*version) + ", newer than this engine's (version " +
        std::to_string (SCHEMA_VERSION) + "). Upgrade Vayu to open it.");
    }
    if (snapshot == PreMigrationSnapshot::Take) {
        snapshot_before_migration (connection.get (), path, *version);
    }

    const bool requests_need_fold = table_has_script_columns (connection.get (), "requests");
    const bool collections_need_fold =
    table_has_script_columns (connection.get (), "collections");
    // 5 -> 6 (every earlier version passes through it too, 6 itself does
    // not): grant the files a person chose, take the trust key out of every
    // stored body, and drop the allowed folders the root rule refuses (4) -
    // see `plan_trust_removal` and `plan_refused_roots`.
    const FileTrustPlan trust_plan =
    plan_file_trust_migration (connection.get (), *version);
    // 6 -> 7: requests move past their sub-folders into one sibling order.
    const auto order_shifts = plan_sibling_order_shift (connection.get (), *version, path);
    if (!requests_need_fold && !collections_need_fold && trust_plan.empty () &&
    order_shifts.empty ()) {
        // Nothing to fold or rewrite - a fresh schema with no rows yet, a
        // database some other path already brought to this shape, or one
        // with no file reference to settle and no request beside a
        // sub-folder. The other steps only stamp:
        // 1 -> 2 is
        // `request_examples.postman_response` and the four `requests`
        // protocol-setting columns of #1765, nullable or NOT NULL with a
        // default, which `sync_schema ()` adds by itself; 2 -> 3 is the new
        // `file_roots` table and 5 -> 6 the new `file_grants`, which
        // `sync_schema ()` creates outright; 7 -> 8 is `collections.spec_file`
        // and `data_file`, NOT NULL with a default, which it adds and
        // backfills to `{}`; 9 -> 10 is the new `spec_declined_operations`,
        // which it creates outright. A chosen file that is gone
        // changes nothing stored, but is still reported.
        stamp_schema_version (connection.get (), path);
        log_file_trust_plan (trust_plan);
        return false;
    }

    exec_or_throw (connection.get (), "BEGIN IMMEDIATE;", path);
    try {
        apply_migration_rows (connection.get (), path, requests_need_fold,
        collections_need_fold, trust_plan, order_shifts);
    } catch (...) {
        sqlite3_exec (connection.get (), "ROLLBACK;", nullptr, nullptr, nullptr);
        throw;
    }
    log_file_trust_plan (trust_plan);
    if (!order_shifts.empty ()) {
        vayu::utils::log_info ("db", "Moved each collection's requests after its sub-folders in one sibling order",
        { { "collections", order_shifts.size () } });
    }
    return false;
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
    // the other two: it is handed to the open callback, which applies it to
    // every connection sqlite_orm opens - and applied here too, to the one the
    // storage holds open, which was opened before this row could be read.
    impl_->cache_size_bytes.store (get_config_int (
    "dbCacheSize", vayu::core::constants::database::CACHE_SIZE_BYTES));
    if (impl_->connection != nullptr) {
        impl_->apply_cache_size (impl_->connection);
    }

    // Get synchronous mode (0=OFF, 1=NORMAL, 2=FULL)
    int synchronous =
    get_config_int ("dbSynchronous", vayu::core::constants::database::SYNCHRONOUS);
    impl_->storage.pragma.synchronous (synchronous);

    // Get busy timeout in milliseconds
    const int busy_timeout_ms =
    get_config_int ("dbBusyTimeout", vayu::core::constants::database::BUSY_TIMEOUT_MS);
    impl_->storage.pragma.busy_timeout (busy_timeout_ms);
    impl_->busy_timeout_ms.store (busy_timeout_ms);

    // All three are read back from the connection rather than echoed from the
    // config rows: what the engine asked for and what SQLite holds are two
    // different statements, and only the second one is worth logging.
    vayu::utils::log_debug ("db", "Database initialized with WAL mode",
    { { "cacheKb", applied_cache_size_bytes () / 1024 },
    { "busyTimeoutMs", applied_busy_timeout_ms () },
    { "synchronous", applied_synchronous () } });

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
        log_reclaim_outcome (reclaim_freed_pages (impl_->connection, impl_->opened_file));
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "db", "Startup database reclamation failed: " + std::string (e.what ()));
    }

    if (impl_->connection != nullptr) {
        impl_->session_changes_baseline = sqlite3_total_changes64 (impl_->connection);
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

    // The pre-strip rows survive in a `backups/` snapshot, not in `<db>.bak`,
    // which this same start refreshes from the rewritten file (issue #1487).
    // Without that copy the pass does not run and stays unmarked, so the next
    // start tries again (issue #2426).
    const auto copy = snapshot_before_rewrite (impl_->opened_file, "pre-repair",
    get_config_int (std::string (MAX_BACKUPS_RETAINED_KEY),
    vayu::core::constants::database::MAX_BACKUPS_RETAINED));
    if (!copy) {
        throw std::runtime_error (
        "no copy of the workspace could be saved before rewriting it: " + copy.error ());
    }

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

// Whether the database at `path` opens and carries this build's schema.
//
// The same probe answers for the main file and for the `.bak` beside it
// (issue #984): the backup used to be restored on the strength of its
// existence alone - "we assume the backup itself is valid" - so a torn copy
// was written over the only other copy of the user's data. An
// `integrity_check` pragma would answer a narrower question (pages, not
// schema) and would not answer the one that matters here, which is whether
// *this engine* can open the file it is about to commit to. The refresh of
// that `.bak` asks it of its own snapshot too, before the snapshot replaces
// the backup it would otherwise have to be trusted over.
//
// Only `SQLITE_CORRUPT` and `SQLITE_NOTADB` say the file is bad
// (`classify_probe_failure`); a lock, a full disk or a read-only directory
// says nothing about it and must never send it to the quarantine (#2420).
ProbeResult Database::probe_database (const std::string& path,
std::chrono::milliseconds busy_timeout) {
    try {
        // Ahead of `Impl`'s own construction, never after: `Impl`'s
        // constructor already opens a connection and sets
        // `journal_mode`, and `sync_schema ()` below is what would
        // `DROP COLUMN` the pre-cutover script columns before this
        // migration ever got to read them (issue #1514).
        migrate_before_sync (path, busy_timeout, PreMigrationSnapshot::Skip);
        Impl probe (path, busy_timeout);
        probe.storage.sync_schema ();
        return {};
    } catch (const std::exception& e) {
        const ProbeResult found = classify_probe_failure (e);
        const char* what = found.verdict == ProbeResult::Verdict::Corrupt ?
        "Database validation failed (corrupt) for " :
        "Database could not be examined for ";
        vayu::utils::log_error ("db", what + path + ": " + found.reason,
        { { "sqliteCode", found.sqlite_code } });
        return found;
    }
}

namespace {
constexpr std::string_view NOT_VALIDATED_REFUSAL =
"this start did not validate the database, so the backup is left as it is";

/// VM instructions between two deadline checks in the shutdown copy: a check is
/// one clock read, and a thousand instructions run in microseconds.
constexpr int DEADLINE_CHECK_INSTRUCTIONS = 1000;

/// A `sqlite3_progress_handler`: non-zero stops the running statement with
/// `SQLITE_INTERRUPT`. A handler rather than `sqlite3_interrupt` from a
/// watchdog thread, because an interrupt that lands before `sqlite3_step`
/// starts is cleared by SQLite and the copy would then run unbounded.
int past_deadline (void* deadline) {
    const auto& until = *static_cast<std::chrono::steady_clock::time_point*> (deadline);
    return std::chrono::steady_clock::now () >= until ? 1 : 0;
}

/// Whole milliseconds from now to @p deadline, never negative.
int ms_until (std::chrono::steady_clock::time_point deadline) {
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds> (
    deadline - std::chrono::steady_clock::now ());
    return static_cast<int> (std::max<int64_t> (0, left.count ()));
}

/// Folds the WAL into the main file before the shutdown copy, waiting for
/// another process's reader no longer than @p deadline allows. BUSY is
/// tolerated: the snapshot reads the WAL either way.
void checkpoint_wal (sqlite3* connection,
std::chrono::steady_clock::time_point deadline,
int configured_busy_timeout_ms) {
    sqlite3_busy_timeout (connection, ms_until (deadline));
    const int rc = sqlite3_wal_checkpoint_v2 (
    connection, nullptr, SQLITE_CHECKPOINT_TRUNCATE, nullptr, nullptr);
    sqlite3_busy_timeout (connection, configured_busy_timeout_ms);
    if (rc != SQLITE_OK) {
        vayu::utils::log_debug ("db", "The shutdown checkpoint did not complete; the snapshot reads the WAL instead",
        { { "sqliteCode", rc } });
    }
}
} // namespace

std::expected<void, std::string> Database::refresh_recovery_backup () {
    if (!impl_->recovery_backup_due) {
        return std::unexpected (std::string (NOT_VALIDATED_REFUSAL));
    }
    auto refreshed = replace_recovery_backup (
    [this] (sqlite3* connection) {
        std::lock_guard<std::mutex> lock (impl_->recovery_backup_mutex);
        if (connection != nullptr && impl_->recovery_backup_cancelled) {
            return false;
        }
        impl_->recovery_backup_connection = connection;
        return true;
    },
    std::chrono::steady_clock::time_point::max ());
    // Only once a backup of the validated file exists, and only on a start
    // that found the file already current: the start that migrated it is not
    // "a later start" than the one that wrote a copy.
    if (refreshed && impl_->opened_at_current_schema) {
        remove_legacy_safety_copies (impl_->opened_file, impl_->opened_at);
    }
    return refreshed;
}

std::expected<void, std::string> Database::refresh_recovery_backup_on_shutdown (
std::chrono::milliseconds budget) {
    if (!impl_->recovery_backup_due) {
        return std::unexpected (std::string (NOT_VALIDATED_REFUSAL));
    }
    if (budget <= std::chrono::milliseconds::zero ()) {
        return std::unexpected (
        std::string ("no time was left in the shutdown window"));
    }
    // Not const: the progress handler is handed its address.
    auto deadline = std::chrono::steady_clock::now () +
    std::min (budget,
    std::chrono::milliseconds (vayu::core::constants::database::SHUTDOWN_BACKUP_DEADLINE_MS));

    try {
        {
            std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
            if (impl_->connection == nullptr ||
            sqlite3_total_changes64 (impl_->connection) <= impl_->session_changes_baseline) {
                vayu::utils::log_debug (
                "db", "The recovery backup was left as it is at shutdown: this session wrote nothing");
                return {};
            }
            checkpoint_wal (
            impl_->connection, deadline, impl_->storage.pragma.busy_timeout ());
        }

        const auto replaced = replace_recovery_backup (
        [&deadline] (sqlite3* connection) {
            if (connection != nullptr) {
                sqlite3_busy_timeout (connection, ms_until (deadline));
                sqlite3_progress_handler (connection,
                DEADLINE_CHECK_INSTRUCTIONS, &past_deadline, &deadline);
            }
            return true;
        },
        deadline);
        return replaced;
    } catch (const std::exception& e) {
        return std::unexpected (std::string (e.what ()));
    }
}

std::expected<void, std::string> Database::replace_recovery_backup (
const std::function<bool (sqlite3*)>& on_connection,
std::chrono::steady_clock::time_point validate_by) {
    const auto started      = std::chrono::steady_clock::now ();
    const fs::path db_file  = impl_->opened_file;
    const fs::path backup   = fs::path (db_file.string () + ".bak");
    const fs::path snapshot = fs::path (db_file.string () + ".bak.tmp");

    try {
        // `VACUUM INTO` refuses a destination that exists, and one left by a
        // process that died mid-snapshot is exactly that.
        remove_db_file_set (snapshot);

        const std::string refusal =
        vacuum_into (db_file.string (), snapshot.string (), on_connection);
        if (!refusal.empty ()) {
            remove_db_file_set (snapshot);
            return std::unexpected ("the snapshot did not complete: " + refusal);
        }
        // The probe cannot be interrupted; it costs O(schema), not O(data).
        if (std::chrono::steady_clock::now () >= validate_by) {
            remove_db_file_set (snapshot);
            return std::unexpected (
            std::string ("the snapshot finished past the deadline, so it was "
                         "not validated"));
        }
        // Either way the previous backup stands. The snapshot is this call's
        // own scratch file, not a copy anyone else has, so it goes whatever
        // stopped the probe; the reason says which, because "did not
        // validate" for a full disk would read as a damaged workspace.
        const ProbeResult checked = probe_database (snapshot.string (),
        std::chrono::milliseconds (vayu::core::constants::database::BUSY_TIMEOUT_MS));
        if (checked.verdict != ProbeResult::Verdict::Valid) {
            remove_db_file_set (snapshot);
            const char* why = checked.verdict == ProbeResult::Verdict::Corrupt ?
            "the snapshot did not validate: " :
            "the snapshot could not be examined: ";
            return std::unexpected (why + checked.reason);
        }

        // A `-wal` beside the backup belongs to the copy being replaced: the
        // file-copy backup this supersedes carried its sidecars along, and
        // `recover_database` copies a `.bak-wal` back with the `.bak`. Left in
        // place it would be replayed over a snapshot it was never written for.
        std::error_code ec;
        fs::remove (fs::path (backup.string () + "-wal"), ec);
        fs::remove (fs::path (backup.string () + "-shm"), ec);
        // Flushed ahead of the rename: a power loss between the two would
        // otherwise leave the backup path naming a file of zeros.
        warn_unless_flushed (vayu::platform::fsync_file (snapshot.string ()),
        "the recovery backup snapshot", snapshot);
        // One rename, so the backup path always names a whole database: the
        // previous one until this returns, this one after.
        const auto replaced =
        vayu::platform::replace_file_durably (snapshot.string (), backup.string ());
        if (replaced.error) {
            remove_db_file_set (snapshot);
            return std::unexpected (
            "the snapshot could not replace the backup: " + replaced.error.message ());
        }
        warn_unless_flushed (replaced.durable, "the recovery backup rename", backup);
    } catch (const std::exception& e) {
        remove_db_file_set (snapshot);
        return std::unexpected (std::string (e.what ()));
    }

    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    std::error_code size_ec;
    const auto size = fs::file_size (backup, size_ec);
    vayu::utils::log_debug ("db", "Recovery backup refreshed",
    { { "path", backup.string () }, { "ms", elapsed_ms },
    { "bytes", size_ec ? 0 : static_cast<int64_t> (size) } });
    return {};
}

void Database::start_recovery_backup_refresh () {
    std::lock_guard<std::mutex> lock (impl_->recovery_backup_mutex);
    if (impl_->recovery_backup_thread.joinable () || impl_->recovery_backup_cancelled) {
        return;
    }
    impl_->recovery_backup_thread = std::thread ([this] () {
        // `refresh_recovery_backup` reports rather than throws; nothing here
        // may escape a thread, which would terminate the engine.
        const auto outcome = refresh_recovery_backup ();
        if (!outcome) {
            bool cancelled = false;
            {
                std::lock_guard<std::mutex> guard (impl_->recovery_backup_mutex);
                cancelled = impl_->recovery_backup_cancelled;
            }
            // A shutdown that interrupted the snapshot is not news: the
            // previous backup stands, which is what it was asked to do.
            const std::string line =
            "The recovery backup was not refreshed: " + outcome.error ();
            if (cancelled) {
                vayu::utils::log_debug ("db", line);
            } else {
                vayu::utils::log_warning ("db", line);
            }
        }
    });
}

void Database::finish_recovery_backup_refresh () {
    if (!impl_) {
        return;
    }
    {
        std::lock_guard<std::mutex> lock (impl_->recovery_backup_mutex);
        impl_->recovery_backup_cancelled = true;
        if (impl_->recovery_backup_connection != nullptr) {
            sqlite3_interrupt (impl_->recovery_backup_connection);
        }
    }
    if (impl_->recovery_backup_thread.joinable ()) {
        impl_->recovery_backup_thread.join ();
    }
}

std::string Database::backups_directory () const {
    return backups_directory_for (impl_->opened_file).string ();
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

    const auto written = write_snapshot (impl_->opened_file, now, {});
    if (!written) {
        return std::unexpected (BackupFailure{ false, written.error () });
    }
    const fs::path& destination = written->path;

    std::error_code size_ec;
    const auto size = fs::file_size (destination, size_ec);

    BackupRecord record;
    record.path       = destination.string ();
    record.size_bytes = size_ec ? 0 : static_cast<int64_t> (size);
    record.created_at = written->stamp_ms;
    // Retention runs *after* the snapshot exists, and a failure here must not
    // turn a backup that succeeded into a reported failure - the user has the
    // file they asked for, and the worst this leaves behind is one snapshot too
    // many. This is also what makes the declared "never throws" true: it is the
    // one step that reads the database.
    try {
        record.pruned = prune_backup_files (destination.parent_path (),
        get_config_int (std::string (MAX_BACKUPS_RETAINED_KEY),
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

std::optional<int64_t> Database::applied_journal_size_limit () const {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    std::string error;
    return read_pragma_int (impl_->connection, "PRAGMA journal_size_limit;", error);
}

std::optional<int64_t> Database::applied_mmap_size () const {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    std::string error;
    return read_pragma_int (impl_->connection, "PRAGMA mmap_size;", error);
}

int Database::applied_busy_timeout_ms () const {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.pragma.busy_timeout ();
}

} // namespace vayu::db
