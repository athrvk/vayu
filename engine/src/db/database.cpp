/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file database.cpp
 * @brief SQLite database layer using sqlite_orm
 *
 * Schema Overview:
 * ────────────────────────────────────────────────────────────────────────
 * PROJECT MANAGEMENT:
 *   collections  - Folder structure for organizing requests
 *   requests     - HTTP request definitions with scripts
 *   environments - Named variable sets (e.g., dev, staging, prod)
 *   globals      - App-wide variables (singleton)
 *
 * EXECUTION ENGINE:
 *   runs         - Test execution records (load tests, design mode)
 *   metric_ticks - One wide row per metrics tick (the time series)
 *   results      - Individual request results with timing
 *
 * CONFIGURATION:
 *   config_entries - Structured configuration with metadata for UI
 * ────────────────────────────────────────────────────────────────────────
 */

#include "vayu/db/database.hpp"

#include <sqlite3.h>
#include <sqlite_orm/sqlite_orm.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#include "vayu/core/constants.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/logger.hpp"

// ============================================================================
// SQLite ORM Type Adapters
// These templates tell sqlite_orm how to serialize/deserialize our enums
// ============================================================================

namespace sqlite_orm {

// HttpMethod enum adapter (GET, POST, PUT, DELETE, etc.)
template <> struct type_printer<vayu::HttpMethod> {
    const std::string& print () {
        static const std::string res = "TEXT";
        return res;
    }
};
template <> struct statement_binder<vayu::HttpMethod> {
    int bind (sqlite3_stmt* stmt, int index, const vayu::HttpMethod& value) {
        return sqlite3_bind_text (stmt, index, vayu::to_string (value), -1, SQLITE_TRANSIENT);
    }
};
template <> struct field_printer<vayu::HttpMethod> {
    std::string operator() (const vayu::HttpMethod& t) const {
        return vayu::to_string (t);
    }
};
template <> struct row_extractor<vayu::HttpMethod> {
    vayu::HttpMethod extract (const char* row_value) const {
        if (auto val = vayu::parse_method (row_value))
            return *val;
        return vayu::HttpMethod::GET;
    }
    vayu::HttpMethod extract (sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*)sqlite3_column_text (stmt, columnIndex);
        return this->extract (str ? str : "");
    }
};

// RunType enum adapter (Design, Load, Scenario)
template <> struct type_printer<vayu::RunType> {
    const std::string& print () {
        static const std::string res = "TEXT";
        return res;
    }
};
template <> struct statement_binder<vayu::RunType> {
    int bind (sqlite3_stmt* stmt, int index, const vayu::RunType& value) {
        return sqlite3_bind_text (stmt, index, vayu::to_string (value), -1, SQLITE_TRANSIENT);
    }
};
template <> struct field_printer<vayu::RunType> {
    std::string operator() (const vayu::RunType& t) const {
        return vayu::to_string (t);
    }
};
template <> struct row_extractor<vayu::RunType> {
    vayu::RunType extract (const char* row_value) const {
        if (auto val = vayu::parse_run_type (row_value))
            return *val;
        return vayu::RunType::Design;
    }
    vayu::RunType extract (sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*)sqlite3_column_text (stmt, columnIndex);
        return this->extract (str ? str : "");
    }
};

// RunStatus enum adapter (Pending, Running, Completed, Failed, Stopped)
template <> struct type_printer<vayu::RunStatus> {
    const std::string& print () {
        static const std::string res = "TEXT";
        return res;
    }
};
template <> struct statement_binder<vayu::RunStatus> {
    int bind (sqlite3_stmt* stmt, int index, const vayu::RunStatus& value) {
        return sqlite3_bind_text (stmt, index, vayu::to_string (value), -1, SQLITE_TRANSIENT);
    }
};
template <> struct field_printer<vayu::RunStatus> {
    std::string operator() (const vayu::RunStatus& t) const {
        return vayu::to_string (t);
    }
};
template <> struct row_extractor<vayu::RunStatus> {
    vayu::RunStatus extract (const char* row_value) const {
        if (auto val = vayu::parse_run_status (row_value))
            return *val;
        return vayu::RunStatus::Pending;
    }
    vayu::RunStatus extract (sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*)sqlite3_column_text (stmt, columnIndex);
        return this->extract (str ? str : "");
    }
};

} // namespace sqlite_orm

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Database Schema Definition
// All tables defined here - sqlite_orm auto-creates/migrates on sync_schema()
// ============================================================================

inline auto make_storage (const std::string& path) {
    return sqlite_orm::make_storage (path,

    // ─────────────── INDEXES ───────────────
    // sqlite_orm requires indexes to precede the tables in the argument list.
    // sync_schema() creates them on fresh and pre-existing databases alike, so
    // this is additive and needs no migration.
    //
    // metric_ticks/results are the unbounded-growth tables (a load run writes
    // one tick row/sec and samples results), so a run_id scan slows down with
    // every run ever recorded, not just the current one.
    // get_metric_ticks_since is polled every 500ms by the legacy SSE loop.
    make_index ("idx_metric_ticks_run_id", &MetricTick::run_id),
    // monitor_samples grows with the run too (one row per scrape interval), and
    // both its reader and the run cascade filter on run_id.
    make_index ("idx_monitor_samples_run_id", &MonitorSample::run_id),
    make_index ("idx_results_run_id", &Result::run_id),
    // GET /runs/:id/samples pages result_bodies by run, and the run cascade
    // deletes both new tables by run_id.
    make_index ("idx_result_bodies_run_id", &ResultBody::run_id),
    make_index ("idx_body_blobs_run_id", &BodyBlob::run_id),
    // Sidebar load (get_requests_in_collection) and cascade delete.
    make_index ("idx_requests_collection_id", &Request::collection_id),
    // Every example read is per-request (the list route, the request cascade,
    // and the collection cascade one request at a time).
    make_index ("idx_request_examples_request_id", &RequestExample::request_id),
    // The cascade-delete BFS in delete_collection walks one lookup per node.
    make_index ("idx_collections_parent_id", &Collection::parent_id),
    // Every inbox read filters by inbox_id (the capture list, the live poll,
    // the retention trim and the clear), and a long-lived listener appends to
    // this table without bound between trims.
    make_index ("idx_inbox_requests_inbox_id", &InboxRequest::inbox_id),
    // get_all_runs / get_runs_paginated sort the whole table on every GET /runs.
    make_index ("idx_runs_start_time", &Run::start_time),
    // GET /runs?requestId= (and useLastDesignRunQuery's single-run lookup)
    // filter on request_id; the design-run seed hits this per opened request.
    make_index ("idx_runs_request_id", &Run::request_id),

    // ─────────────── PROJECT MANAGEMENT TABLES ───────────────

    // Collections: Folder hierarchy for organizing requests
    make_table ("collections", make_column ("id", &Collection::id, primary_key ()),
    make_column ("parent_id", &Collection::parent_id), make_column ("name", &Collection::name),
    make_column ("description", &Collection::description), // NEW: collection description
    make_column ("variables", &Collection::variables),     // JSON: collection-scoped vars
    make_column ("auth", &Collection::auth),               // NEW: JSON auth config
    make_column ("pre_request_script", &Collection::pre_request_script),   // NEW: JS
    make_column ("post_request_script", &Collection::post_request_script), // NEW: JS
    // The declared data contract (issue #599). NOT NULL with a default_value on
    // the `keywords` precedent, so sync_schema can ALTER TABLE ADD COLUMN it
    // onto an existing, non-empty collections table - every pre-existing row
    // backfills to `{}`, which is what "declares no contract" is spelled as.
    make_column ("data_schema", &Collection::data_schema,
    default_value (std::string ("{}"))),
    // The OpenAPI binding (issue #637). Same NOT NULL + default_value shape as
    // `data_schema` directly above, and for the same reason: sync_schema ALTERs
    // it onto an existing, non-empty collections table and every pre-existing
    // row backfills to `{}`, which is how "bound to no spec" is spelled.
    make_column ("openapi", &Collection::openapi, default_value (std::string ("{}"))),
    make_column ("order", &Collection::order),
    make_column ("created_at", &Collection::created_at),
    make_column ("updated_at", &Collection::updated_at)),

    // Requests: HTTP request definitions with pre/post scripts
    make_table ("requests", make_column ("id", &Request::id, primary_key ()),
    make_column ("collection_id", &Request::collection_id),
    make_column ("name", &Request::name),
    make_column ("description", &Request::description), // NEW: request description
    make_column ("method", &Request::method),
    make_column ("url", &Request::url),
    make_column ("params", &Request::params),   // JSON array of KeyValueEntry
    make_column ("headers", &Request::headers), // JSON array of KeyValueEntry
    make_column ("body", &Request::body),       // JSON discriminated union
    make_column ("body_type", &Request::body_type),
    make_column ("auth", &Request::auth),                               // JSON
    make_column ("pre_request_script", &Request::pre_request_script),   // JS
    make_column ("post_request_script", &Request::post_request_script), // JS
    make_column ("order", &Request::order),     // NEW: position within collection
    // Redirect policy. NOT NULL, so the default_value is what lets sync_schema
    // ALTER TABLE ADD COLUMN these onto an existing, non-empty requests table -
    // pre-existing rows backfill to the engine defaults (follow, cap at 10).
    make_column ("follow_redirects", &Request::follow_redirects, default_value (true)),
    make_column ("max_redirects", &Request::max_redirects, default_value (10)),
    // Per-request TLS verification (issue #706). Same NOT NULL + default_value
    // shape, and the default is the safe one: a row written before this column
    // existed backfills to verifying, never to trusting whatever answers.
    make_column ("verify_ssl", &Request::verify_ssl, default_value (true)),
    // Protocol selection. TEXT (not an ordinal) so a stored value survives a
    // reorder of the HttpVersion enum. NOT NULL with a default_value so
    // sync_schema can ALTER TABLE ADD COLUMN onto an existing requests table.
    make_column ("http_version", &Request::http_version, default_value ("auto")),
    // The SSE execution flag (issue #574). Same NOT NULL + default_value shape
    // as the two above, and for the same reason: sync_schema ALTERs it onto an
    // existing requests table and every pre-existing row backfills to "not a
    // stream", which is what they all were.
    make_column ("stream", &Request::stream, default_value (false)),
    // Which operation of the bound spec this request is (issue #637). Nullable
    // rather than NOT NULL with a default, on the `config_entries.unit`
    // precedent below: a nullable column is ALTER-friendly without one, and
    // NULL is the only spelling of "declares no operation".
    make_column ("spec_operation", &Request::spec_operation),
    make_column ("created_at", &Request::created_at),
    make_column ("updated_at", &Request::updated_at)),

    // Request examples: saved example responses for a request (issue #481).
    // Created by import today, and the response source a mock server serves
    // from. sync_schema() creates the table outright, so no migration.
    make_table ("request_examples",
    make_column ("id", &RequestExample::id, primary_key ()),
    make_column ("request_id", &RequestExample::request_id),
    make_column ("name", &RequestExample::name),
    make_column ("status", &RequestExample::status),
    make_column ("headers", &RequestExample::headers), // JSON array of KeyValueEntry
    make_column ("body", &RequestExample::body),
    make_column ("content_type", &RequestExample::content_type),
    make_column ("order", &RequestExample::order),
    // Who wrote the row (issue #588). NOT NULL + default_value so sync_schema
    // ALTERs it onto an existing table, and every pre-existing row backfills to
    // "import" - which is what all of them are, since import was the only
    // writer before the app could save a response as an example.
    make_column ("origin", &RequestExample::origin,
    default_value (std::string (vayu::core::constants::request_example::ORIGIN_IMPORT))),
    // Whether `body` is a prefix of the response it was saved from (issue
    // #659). NOT NULL + default_value on the `origin` precedent above, so
    // sync_schema() ALTERs it on and every existing row backfills to false -
    // which is what they all are: import copies whole bodies, and the app's
    // save-as-example is the only writer that ever had a partial one.
    make_column ("body_truncated", &RequestExample::body_truncated, default_value (false)),
    // A deleted imported example, kept as a tombstone so a later spec sync does
    // not re-create it (issue #722). NOT NULL + default_value on the same
    // precedent as the two columns above, and `false` is right for every
    // pre-existing row: before this column a delete removed the row outright.
    make_column ("suppressed", &RequestExample::suppressed, default_value (false)),
    make_column ("created_at", &RequestExample::created_at),
    make_column ("updated_at", &RequestExample::updated_at)),

    // Spec documents: OpenAPI documents, stored once and bound to collections
    // (issue #637). A new table, so sync_schema() creates it outright and there
    // is no migration - the `request_examples` precedent above.
    make_table ("spec_documents", make_column ("id", &SpecDocument::id, primary_key ()),
    make_column ("content", &SpecDocument::content),
    make_column ("source_url", &SpecDocument::source_url), // NULL = not fetched from a URL
    make_column ("fetched_at", &SpecDocument::fetched_at),
    make_column ("hash", &SpecDocument::hash), // hex sha256 of `content`
    // The app-extracted operation index (issue #629). NOT NULL + default_value
    // so sync_schema ALTERs it onto an existing table, and every pre-existing
    // row backfills to `""` - which is the truth about them: they were stored
    // before anything extracted an index, and a run of one reports no coverage
    // rather than an empty contract.
    make_column ("operations", &SpecDocument::operations, default_value (std::string ())),
    // The app-extracted response schema index (issue #628), ALTERed on by the
    // same NOT NULL + default rule as `operations` beside it. A pre-existing
    // row backfills to `""`, which is the truth about it: nothing extracted
    // schemas when it was stored, so a response of its operations reports
    // `checked: false` / `no_index` rather than a contract it never had.
    make_column ("response_schemas", &SpecDocument::response_schemas,
    default_value (std::string ()))),

    // Environments: Named variable sets (dev, staging, prod)
    make_table ("environments", make_column ("id", &Environment::id, primary_key ()),
    make_column ("name", &Environment::name),
    make_column ("description", &Environment::description), // NEW: environment description
    make_column ("variables", &Environment::variables),     // JSON: {key: {value, enabled}}
    make_column ("is_active", &Environment::is_active),
    make_column ("created_at", &Environment::created_at),
    make_column ("updated_at", &Environment::updated_at)),

    // ─────────────── EXECUTION ENGINE TABLES ───────────────

    // Runs: Test execution sessions (load tests or design mode requests)
    make_table ("runs", make_column ("id", &Run::id, primary_key ()),
    make_column ("request_id", &Run::request_id),
    make_column ("environment_id", &Run::environment_id),
    make_column ("type", &Run::type), // "design", "load" or "scenario"
    make_column ("status", &Run::status), // pending/running/completed/failed
    make_column ("config_snapshot", &Run::config_snapshot), // JSON: full request copy
    make_column ("start_time", &Run::start_time), make_column ("end_time", &Run::end_time),
    // Whole-run results written once at terminal status. NOT NULL, so the
    // default_value is what lets sync_schema ALTER TABLE ADD COLUMN it onto an
    // existing, non-empty runs table - pre-existing rows backfill to `""`,
    // which the report route reads as "the engine died before this run
    // finished; report from the sampled results alone".
    make_column ("summary", &Run::summary, default_value ("")),
    // Pinned-as-baseline flag; see Run::baseline for why retention reads it.
    make_column ("baseline", &Run::baseline, default_value (false))),

    // Metric ticks: one wide row per persisted tick (the time series)
    make_table ("metric_ticks",
    make_column ("id", &MetricTick::id, primary_key ().autoincrement ()),
    make_column ("run_id", &MetricTick::run_id),
    make_column ("timestamp", &MetricTick::timestamp),
    make_column ("payload", &MetricTick::payload)), // JSON: the whole tick object

    // Monitor samples: one row per scrape of the run's configured server-vitals
    // endpoint. Its own table rather than a wider metric_ticks row - the tick
    // payload's key set is the GET /runs/:id/metrics contract, and these arrive
    // on the user's scrape cadence, not the tick cadence.
    make_table ("monitor_samples",
    make_column ("id", &MonitorSample::id, primary_key ().autoincrement ()),
    make_column ("run_id", &MonitorSample::run_id),
    make_column ("timestamp", &MonitorSample::timestamp),
    make_column ("payload", &MonitorSample::payload)), // JSON: {timestamp, series}

    // Results: Individual request outcomes with timing breakdown
    make_table ("results", make_column ("id", &Result::id, primary_key ().autoincrement ()),
    make_column ("run_id", &Result::run_id), make_column ("timestamp", &Result::timestamp),
    make_column ("status_code", &Result::status_code),
    make_column ("status_text", &Result::status_text), // Wire reason phrase
    make_column ("latency_ms", &Result::latency_ms), make_column ("error", &Result::error),
    make_column ("trace_data", &Result::trace_data)), // JSON: timing, or a design-mode exchange

    // Body blobs: one row per *distinct* captured response body in a run.
    // Content-addressed within the run so N identical load-test responses cost
    // one copy. sync_schema() creates new tables outright, so this and the
    // table below need no migration.
    make_table ("body_blobs", make_column ("id", &BodyBlob::id, primary_key ().autoincrement ()),
    make_column ("run_id", &BodyBlob::run_id), make_column ("hash", &BodyBlob::hash),
    make_column ("content", &BodyBlob::content)),

    // Result bodies: the captured exchange for one sampled result, one-to-one
    // with a `results` row. Separate from `results` on purpose - the report
    // path loads every result row for a run and JSON-parses each trace_data, so
    // a body stored there would be read (and parsed) on every dashboard poll.
    make_table ("result_bodies",
    make_column ("result_id", &ResultBody::result_id, primary_key ()),
    make_column ("run_id", &ResultBody::run_id),
    make_column ("headers", &ResultBody::headers), // JSON object
    make_column ("blob_id", &ResultBody::blob_id), // 0 = no stored body
    make_column ("body_bytes", &ResultBody::body_bytes),
    make_column ("truncated", &ResultBody::truncated),
    make_column ("is_binary", &ResultBody::is_binary),
    make_column ("content_type", &ResultBody::content_type),
    // Nullable, so sync_schema can ALTER TABLE ADD COLUMN it onto an existing
    // result_bodies table without a backfill value - and so a row written
    // before issue #657 reads as "this was not a stream" rather than as a
    // stream that delivered nothing.
    make_column ("stream_events", &ResultBody::stream_events)),

    // Inbox requests: what a webhook inbox listener captured (issue #480).
    // Not owned by a run, so nothing in the run cascade touches it - the rows
    // are bounded per inbox as they are written and cleared wholesale at
    // startup, since no inbox survives the process that opened it.
    make_table ("inbox_requests",
    make_column ("id", &InboxRequest::id, primary_key ().autoincrement ()),
    make_column ("inbox_id", &InboxRequest::inbox_id),
    make_column ("received_at", &InboxRequest::received_at),
    make_column ("method", &InboxRequest::method),
    make_column ("path", &InboxRequest::path), make_column ("query", &InboxRequest::query),
    make_column ("headers", &InboxRequest::headers), // JSON object
    make_column ("body", &InboxRequest::body),
    make_column ("body_bytes", &InboxRequest::body_bytes),
    make_column ("body_truncated", &InboxRequest::body_truncated),
    make_column ("remote_addr", &InboxRequest::remote_addr)),

    // ─────────────── CONFIGURATION TABLES ───────────────

    // Config Entries: Structured configuration with metadata for UI
    make_table ("config_entries", make_column ("key", &ConfigEntry::key, primary_key ()),
    make_column ("value", &ConfigEntry::value),
    make_column ("type", &ConfigEntry::type), make_column ("label", &ConfigEntry::label),
    make_column ("description", &ConfigEntry::description),
    make_column ("category", &ConfigEntry::category),
    make_column ("default_value", &ConfigEntry::default_value),
    make_column ("min_value", &ConfigEntry::min_value),
    make_column ("max_value", &ConfigEntry::max_value),
    make_column ("options", &ConfigEntry::options),
    make_column ("updated_at", &ConfigEntry::updated_at),
    // NOT NULL with a default_value, so sync_schema can ALTER TABLE ADD COLUMN
    // these onto an existing config_entries table - the rows are re-seeded with
    // their metadata on every startup anyway, so the backfill value is only
    // what the row holds between the ALTER and that upsert.
    make_column ("requires_restart", &ConfigEntry::requires_restart,
    default_value (false)),
    make_column ("advanced", &ConfigEntry::advanced, default_value (false)),
    // JSON array of search terms, "[]" when the entry declares none - the
    // same ALTER-friendly shape, and a column that is never null so the
    // serializer has no absent case to invent an array for.
    make_column ("keywords", &ConfigEntry::keywords,
    default_value (std::string ("[]"))),
    // Nullable, like min_value/max_value: an entry that measures nothing
    // declares no unit, and NULL is that. A nullable column is ALTER-friendly
    // without a default_value.
    make_column ("unit", &ConfigEntry::unit)),

    // Globals: App-wide variables (singleton row with id="globals")
    make_table ("globals", make_column ("id", &Globals::id, primary_key ()),
    make_column ("variables", &Globals::variables), // JSON: {key: {value, enabled}}
    make_column ("updated_at", &Globals::updated_at)),

    // OAuth tokens: cached access/refresh tokens keyed by config identity
    make_table ("oauth_tokens",
    make_column ("cache_key", &OAuthToken::cache_key, primary_key ()),
    make_column ("access_token", &OAuthToken::access_token),
    make_column ("token_type", &OAuthToken::token_type),
    make_column ("refresh_token", &OAuthToken::refresh_token),
    make_column ("scope", &OAuthToken::scope),
    make_column ("expires_in", &OAuthToken::expires_in),
    make_column ("created_at", &OAuthToken::created_at),
    make_column ("raw_response", &OAuthToken::raw_response)),

    // Client certificates: which certificate is presented to which host
    // (issue #707). A new table, so sync_schema() creates it outright and there
    // is no migration - the `spec_documents` precedent above.
    //
    // `cert_path` / `key_path` are paths: the private key never enters this
    // file. `passphrase` does, in plaintext, which is the repo's existing
    // credential precedent and is disclosed in docs/engine/db-schema.md rather
    // than left for a reader of the schema to discover.
    make_table ("client_certificates",
    make_column ("id", &ClientCertificate::id, primary_key ()),
    make_column ("host", &ClientCertificate::host),
    make_column ("port", &ClientCertificate::port), // NULL = every port
    make_column ("cert_path", &ClientCertificate::cert_path),
    make_column ("key_path", &ClientCertificate::key_path),
    make_column ("passphrase", &ClientCertificate::passphrase),
    make_column ("created_at", &ClientCertificate::created_at),
    make_column ("updated_at", &ClientCertificate::updated_at)));
}

using Storage = decltype (make_storage (""));

// ============================================================================
// Database Implementation (PImpl pattern)
// ============================================================================

struct Database::Impl {
    Storage storage;
    std::recursive_mutex mutex;

    /// Page cache the open callback gives every connection, in bytes. Seeded
    /// with the compile-time default and overwritten once, from `dbCacheSize`,
    /// while `init` runs - which is exactly why that entry is restart-required:
    /// a later write to the config row never reaches this member.
    /// Atomic because sqlite_orm opens connections from whichever thread needs
    /// one, so the callback reads this concurrently with that one write.
    std::atomic<int> cache_size_bytes{ vayu::core::constants::database::CACHE_SIZE_BYTES };

    /// What SQLite reported back after the most recent open, in bytes (0 until
    /// the first connection). Read back rather than echoed, so it states the
    /// size in force instead of the size requested.
    std::atomic<int> applied_cache_size_bytes{ 0 };

    /// The file `storage` was opened on, for `Database::path`. Named for the
    /// file rather than `db_path`, which the constructor below already uses for
    /// the parsed `std::filesystem::path` - MSVC builds this /W4 /WX and a
    /// shadowed member is C4458, an error here.
    std::string opened_file;

    Impl (const std::string& path) : storage (make_storage (path)), opened_file (path) {
        std::filesystem::path db_path (path);
        if (db_path.has_parent_path ()) {
            std::filesystem::create_directories (db_path.parent_path ());
        }

        // Applied on every connection sqlite_orm opens, since a PRAGMA is
        // per-connection state. Only `cache_size` is configurable; the other
        // three are engine defaults with no user story (their config entries
        // were retired in #519) and stay compile-time constants.
        storage.on_open = [this] (sqlite3* db) {
            char* err_msg = nullptr;
            std::stringstream sql;

            int temp_store   = vayu::core::constants::database::TEMP_STORE;
            size_t mmap_size = vayu::core::constants::database::MMAP_SIZE_BYTES;
            int wal_checkpoint = vayu::core::constants::database::WAL_AUTOCHECKPOINT;

            // Apply optimizations
            // SQLite cache_size PRAGMA uses negative KB values (e.g., -64000 = 64MB)
            int cache_size_kb = -(cache_size_bytes.load () / 1024);
            sql << "PRAGMA cache_size = " << cache_size_kb << ";";
            int rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning (
                "Failed to set cache_size: " + std::string (err_msg));
                sqlite3_free (err_msg);
                err_msg = nullptr;
            }
            sql.str ("");

            // Read the size back instead of trusting the write: a rejected
            // PRAGMA is silent, and only the connection can say what it holds.
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2 (db, "PRAGMA cache_size;", -1, &stmt, nullptr) == SQLITE_OK) {
                if (sqlite3_step (stmt) == SQLITE_ROW) {
                    // Negative means KB, positive means pages - we always set
                    // the negative form, so a positive answer means the write
                    // did not take and the size in bytes is not knowable here.
                    const int reported = sqlite3_column_int (stmt, 0);
                    applied_cache_size_bytes.store (reported < 0 ? -reported * 1024 : 0);
                }
                sqlite3_finalize (stmt);
            }

            sql << "PRAGMA temp_store = " << temp_store << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning (
                "Failed to set temp_store: " + std::string (err_msg));
                sqlite3_free (err_msg);
                err_msg = nullptr;
            }
            sql.str ("");

            sql << "PRAGMA mmap_size = " << mmap_size << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning (
                "Failed to set mmap_size: " + std::string (err_msg));
                sqlite3_free (err_msg);
                err_msg = nullptr;
            }
            sql.str ("");

            sql << "PRAGMA wal_autocheckpoint = " << wal_checkpoint << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning (
                "Failed to set wal_autocheckpoint: " + std::string (err_msg));
                sqlite3_free (err_msg);
            }
        };
    }
};

Database::Database (const std::string& db_path) {
    namespace fs = std::filesystem;
    fs::path db_file (db_path);
    fs::path backup_file = db_file;
    backup_file += ".bak";

    // Helper to perform safe file copy
    auto copy_db_files = [] (const fs::path& src, const fs::path& dst) {
        std::error_code ec;
        if (!fs::exists (src, ec))
            return false;

        // Copy main file
        fs::copy_file (src, dst, fs::copy_options::overwrite_existing, ec);
        if (ec) {
            vayu::utils::log_warning ("Backup copy failed: " + ec.message ());
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
    };

    // Helper to restore from backup
    auto restore_from_backup = [&] (const fs::path& backup, const fs::path& original) {
        std::error_code ec;
        if (!fs::exists (backup, ec))
            return false;

        vayu::utils::log_warning ("Restoring database from backup...");

        // Clean up corrupted files
        fs::remove (original, ec);
        fs::remove (original.string () + "-wal", ec);
        fs::remove (original.string () + "-shm", ec);

        // Restore
        return copy_db_files (backup, original);
    };

    // 1. Validate current database
    bool current_db_valid = false;
    try {
        // Try to open and verify schema
        auto temp_impl = std::make_unique<Impl> (db_path);
        temp_impl->storage.sync_schema ();
        // If we get here, the DB is valid and schema is ok
        current_db_valid = true;
        temp_impl.reset (); // Close explicitly before backup
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Startup DB validation failed: " + std::string (e.what ()));
        // impl_ is not set or local temp_impl is destroyed
    }

    // 2. Recovery Logic
    if (!current_db_valid) {
        // Current DB is bad. Try to restore.
        if (fs::exists (backup_file) && restore_from_backup (backup_file, db_file)) {
            vayu::utils::log_info (
            "Database restored from backup. Retrying...");
            // We assume the backup itself is valid, but let's verify in the final step or let it crash if backup is also bad
        } else {
            // No backup or restore failed.
            // If the file exists but checks failed, we might be in trouble.
            // If it doesn't exist (fresh install), that's fine, we'll create it.
            if (fs::exists (db_file)) {
                vayu::utils::log_error (
                "Critical: Database corrupted and no backup available.");
                // We proceed to try to open it anyway (which will likely re-throw),
                // or we could delete it to start fresh?
                // Starting fresh is better than crashing loop for Vayu.
                // TODO: Consider alerting user/admin about data loss.
                vayu::utils::log_warning (
                "Deleting corrupted database to start fresh...");
                fs::remove (db_file);
                fs::remove (db_file.string () + "-wal");
                fs::remove (db_file.string () + "-shm");
            }
        }
    } else {
        // 3. Current DB is VALID. Update the backup for *next* time.
        // We only backup if validation succeeded. This prevents overwriting good backup with bad DB.
        vayu::utils::log_debug (
        "Database validation successful. Updating backup...");
        copy_db_files (db_file, backup_file);
    }

    // 4. Final Initialization
    // At this point, we either have a valid original, a restored backup, or a fresh/corrupted file we must attempt to use.
    impl_ = std::make_unique<Impl> (db_path);
    // sync_schema might throw if restore failed or backup was also bad
    impl_->storage.sync_schema ();
}

Database::~Database () = default;

const std::string& Database::path () const {
    return impl_->opened_file;
}

// Initialize database with optimized SQLite settings
void Database::init () {
    // Note: Schema sync is now handled in constructor for safety/recovery
    // We just verify it here or perform post-init operations

    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Initializing database...");

    // Ensure schema is synced (idempotent)
    impl_->storage.sync_schema ();

    // Shed the legacy EAV `metrics` table (issue #177). sync_schema only syncs
    // the tables the storage still declares - it does not drop the ones that
    // were removed from it - so a database written by an engine before this
    // version keeps the table and its rows (~20/sec of load run) forever
    // otherwise. The pages return to SQLite's freelist for reuse rather than
    // shrinking the file; a VACUUM to actually shrink it is deliberately not
    // run here, since it rewrites the whole database while holding a write
    // lock and startup is the worst possible moment to pay that.
    // Idempotent, so this stays rather than needing a one-shot migration flag.
    impl_->storage.drop_table_if_exists ("metrics");

    // WAL mode for better concurrent read/write performance
    impl_->storage.pragma.journal_mode (journal_mode::WAL);

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
    impl_->cache_size_bytes.store (
    get_config_int ("dbCacheSize", vayu::core::constants::database::CACHE_SIZE_BYTES));

    // Get synchronous mode (0=OFF, 1=NORMAL, 2=FULL)
    int synchronous =
    get_config_int ("dbSynchronous", vayu::core::constants::database::SYNCHRONOUS);
    impl_->storage.pragma.synchronous (synchronous);

    // Get busy timeout in milliseconds
    int busy_timeout =
    get_config_int ("dbBusyTimeout", vayu::core::constants::database::BUSY_TIMEOUT_MS);
    impl_->storage.pragma.busy_timeout (busy_timeout);

    vayu::utils::log_debug ("Database initialized with WAL mode (cache=" +
    std::to_string (applied_cache_size_bytes () / 1024) + "KB, " +
    "busy_timeout=" + std::to_string (busy_timeout) + "ms, " +
    "synchronous=" + std::to_string (synchronous) + ")");

    // Close out runs abandoned by a previous process before pruning, so an
    // orphan becomes a terminal (and therefore prunable) row in the same
    // startup. Best-effort: neither pass may block a successful startup.
    try {
        reconcile_orphaned_runs ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "Startup run reconciliation failed: " + std::string (e.what ()));
    }

    // Bindings written before the engine stamped them (issue #709) name a
    // document and no version of it, which reads to every contract check as a
    // document that has moved - so an imported collection was measured against
    // nothing. Best-effort, like the passes around it: a repair that fails must
    // not cost the user their engine.
    try {
        if (const int64_t stamped = stamp_hashless_spec_bindings (); stamped > 0) {
            vayu::utils::log_info ("Stamped " + std::to_string (stamped) +
            " OpenAPI binding(s) with the version of the document they name");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "Startup spec-binding repair failed: " + std::string (e.what ()));
    }

    // No webhook inbox survives the process that opened it, so any capture row
    // still here belongs to an inbox nothing can list. Best-effort, like the
    // two passes around it.
    try {
        if (const int64_t dropped = clear_inbox_requests_all (); dropped > 0) {
            vayu::utils::log_info ("Cleared " + std::to_string (dropped) +
            " inbox capture(s) left by a previous process");
        }
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "Startup inbox capture cleanup failed: " + std::string (e.what ()));
    }

    // Trim accumulated run history on startup (design-mode clicks and load runs
    // are otherwise append-only). Best-effort: a prune failure must not block a
    // successful startup.
    try {
        prune_runs_configured ();
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "Startup run pruning failed: " + std::string (e.what ()));
    }
}

// ============================================================================
// Collections - Folder structure for organizing requests
// ============================================================================

void Database::create_collection (const Collection& c) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Creating collection: id=" + c.id + ", name=" + c.name);
    impl_->storage.replace (c);
}

std::vector<Collection> Database::get_collections () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The tie rule is pinned to three keys, not left to the implicit rowid.
    // `INSERT OR REPLACE` on a TEXT primary key reassigns the rowid on every
    // edit, so a single-key ORDER BY let an unrelated rename silently reshuffle
    // a collection among its equal-`order` siblings - and the sidebar, the MCP
    // smoke tool and a scenario plan each saw a different shuffle. `created_at`
    // second matches what the renderer displays; `id` last makes the result a
    // total order even for rows written in the same millisecond. That last leg
    // compares random UUIDs, so it is stable across reads but arbitrary with
    // respect to the order the caller meant - which is why the contract puts
    // the duty on the writer (issue #565): anything producing several siblings
    // at once owes them distinct `order`s, as build_collection_rows and the
    // examples import already do. A finer timestamp was rejected: it still ties
    // under a fast enough writer, and it would make row identity depend on
    // clock resolution across three platforms. See the Ordering section of
    // docs/engine/api-reference.md. The renderer's comparator applies the
    // identical rule, pinned by tests/fixtures/tree-order-conformance.json.
    return impl_->storage.get_all<Collection> (multi_order_by (order_by (&Collection::order),
    order_by (&Collection::created_at), order_by (&Collection::id)));
}

std::optional<Collection> Database::get_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto cols = impl_->storage.get_all<Collection> (where (c (&Collection::id) == id));
    if (cols.empty ())
        return std::nullopt;
    return cols.front ();
}

// Cascade delete: recursively removes all descendant collections and their requests.
// BFS discovers all descendant IDs, then deletes deepest-first inside a single
// transaction.
void Database::delete_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting collection (cascade): id=" + id);

    // 1. Collect all descendant IDs via BFS (root first). The visited set makes
    //    the walk terminate even on cyclic parent_id data - a self-parent or an
    //    A -> B -> A loop that may have been written before write-time
    //    validation existed. Without it, `to_delete` grows forever while this
    //    method holds the global DB mutex, hanging every endpoint including
    //    /health until the daemon is restarted (issue #79).
    std::vector<std::string> to_delete;
    std::unordered_set<std::string> visited;
    to_delete.push_back (id);
    visited.insert (id);
    size_t idx = 0;
    while (idx < to_delete.size ()) {
        auto children = impl_->storage.get_all<Collection> (
        where (c (&Collection::parent_id) == to_delete[idx]));
        for (const auto& child : children) {
            if (visited.insert (child.id).second) {
                to_delete.push_back (child.id);
            }
        }
        ++idx;
    }

    // 2. Delete deepest-first so foreign-key integrity holds at each step,
    //    wrapped in a single transaction so a crash mid-cascade cannot leave a
    //    half-deleted subtree. Safe under the recursive mutex already held -
    //    the lambda only calls sqlite_orm on the same storage handle (same
    //    pattern as add_results_batch).
    impl_->storage.transaction ([&] {
        for (auto it = to_delete.rbegin (); it != to_delete.rend (); ++it) {
            // Examples first, and by request id rather than by collection: they
            // hang off the request, so deleting the requests before them would
            // leave rows no read can reach and no later delete can find.
            for (const auto& r :
            impl_->storage.get_all<Request> (where (c (&Request::collection_id) == *it))) {
                impl_->storage.remove_all<RequestExample> (
                where (c (&RequestExample::request_id) == r.id));
            }
            impl_->storage.remove_all<Request> (where (c (&Request::collection_id) == *it));
            impl_->storage.remove_all<Collection> (where (c (&Collection::id) == *it));
        }
        return true; // Commit
    });

    // 3. The cascade above is still deliberately not a cascade *to* the document
    //    a deleted collection was bound to - several collections may bind one,
    //    so the binding going away is not the document going away. It is the
    //    moment to ask whether anything still holds it, though, and that is what
    //    the sweep answers (issue #718). Outside the transaction: the subtree is
    //    gone either way, and this must not be able to roll it back. Never
    //    throws; see the declaration.
    sweep_orphaned_spec_documents ();
}

// ============================================================================
// Requests - HTTP request definitions with pre/post scripts
// ============================================================================

void Database::save_request (const Request& r) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving request: id=" + r.id + ", name=" + r.name);
    impl_->storage.replace (r);
}

std::optional<Request> Database::get_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto requests = impl_->storage.get_all<Request> (where (c (&Request::id) == id));
    if (requests.empty ())
        return std::nullopt;
    return requests.front ();
}

std::vector<Request> Database::get_requests_in_collection (const std::string& collection_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Same three-key tie rule as get_collections - see the comment there for why
    // the implicit rowid cannot be the tiebreak.
    return impl_->storage.get_all<Request> (where (c (&Request::collection_id) == collection_id),
    multi_order_by (order_by (&Request::order), order_by (&Request::created_at),
    order_by (&Request::id)));
}

// Cascade: a request owns its examples, so both go in one transaction. Deleting
// only the request would leave rows that no route can list (every read is by
// request id) and that the collection cascade can no longer find either.
void Database::delete_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting request (cascade): id=" + id);
    impl_->storage.transaction ([&] {
        impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::request_id) == id));
        impl_->storage.remove_all<Request> (where (c (&Request::id) == id));
        return true; // Commit
    });
}

// ============================================================================
// Request examples - saved example responses owned by a request (issue #481)
// ============================================================================

void Database::save_request_example (const RequestExample& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving request example: id=" + e.id + ", request_id=" + e.request_id);
    impl_->storage.replace (e);
}

/**
 * One example by id - a tombstoned row reads as gone (issue #722).
 *
 * The filter is here rather than in each caller because this is what the
 * owner check of every `/requests/:id/examples/:exampleId` route reads: a
 * suppressed row answering 200 would let a `PUT` bring a deleted example back
 * by writing over its tombstone.
 */
std::optional<RequestExample> Database::get_request_example (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::id) == id and c (&RequestExample::suppressed) == false));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

std::vector<RequestExample> Database::get_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The same three-key tie rule the other list reads use (see
    // get_collections), and here it is a contract rather than a display
    // preference: a mock server serves the *first* matching example. `order`
    // has to lead, because a bulk import writes every example of one request in
    // the same millisecond - on `created_at` alone they all tie and the id
    // tiebreak returns the author's list shuffled.
    // Tombstoned rows are excluded here and not by the callers, so a deleted
    // imported example is invisible to the list route, the mock server and the
    // export alike (issue #722).
    return impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and c (&RequestExample::suppressed) == false),
    multi_order_by (order_by (&RequestExample::order),
    order_by (&RequestExample::created_at), order_by (&RequestExample::id)));
}

/**
 * The request's tombstones - deleted imported examples (issue #722).
 *
 * The one read that sees suppressed rows, and it exists for one caller: the
 * spec sync's `refresh_examples`, which has to know which statuses the user
 * removed before writing the document's examples back.
 */
std::vector<RequestExample>
Database::get_suppressed_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and c (&RequestExample::suppressed) == true));
}

int64_t Database::count_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Tombstones do not count against `MAX_PER_REQUEST`: a user who deletes an
    // imported example has fewer examples, not the same number with one hidden.
    return impl_->storage.count<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and c (&RequestExample::suppressed) == false));
}

void Database::delete_request_example (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting request example: id=" + id);
    impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::id) == id));
}

/**
 * Turns an imported example into a tombstone (issue #722).
 *
 * The row stays so a later sync knows the status was removed on purpose; what
 * it held does not, because nothing reads a suppressed row's body.
 */
void Database::suppress_request_example (const std::string& id, int64_t now) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Suppressing imported request example: id=" + id);
    auto rows = impl_->storage.get_all<RequestExample> (where (c (&RequestExample::id) == id));
    if (rows.empty ()) {
        return;
    }
    RequestExample row  = rows.front ();
    row.suppressed      = true;
    row.body            = "";
    row.headers         = "";
    row.content_type    = "";
    row.body_truncated  = false;
    row.updated_at      = now;
    impl_->storage.replace (row);
}

// ============================================================================
// Spec documents (issue #637)
// ============================================================================

void Database::save_spec_document (const SpecDocument& s) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving spec document: id=" + s.id + ", hash=" + s.hash);
    impl_->storage.replace (s);
}

std::optional<SpecDocument> Database::get_spec_document (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<SpecDocument> (where (c (&SpecDocument::id) == id));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

std::vector<Collection> Database::get_collections_bound_to_spec (const std::string& spec_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    std::vector<Collection> bound;
    if (spec_id.empty ()) {
        return bound;
    }
    // The binding is a JSON blob, so the match is made here rather than in SQL.
    // An unparseable blob binds nothing - the same reading every serializer
    // gives it - and must not make the spec undeletable.
    for (auto& col : impl_->storage.get_all<Collection> ()) {
        try {
            const auto parsed = nlohmann::json::parse (col.openapi);
            if (parsed.is_object () && parsed.value ("specId", std::string ()) == spec_id) {
                bound.push_back (std::move (col));
            }
        } catch (const std::exception&) {
            continue;
        }
    }
    return bound;
}

void Database::delete_spec_document (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting spec document: id=" + id);
    impl_->storage.remove_all<SpecDocument> (where (c (&SpecDocument::id) == id));
}

namespace {

/**
 * The `specId` a JSON blob names at @p path, or "" when it names none.
 *
 * One reader for both halves of the sweep's reference set, because the two
 * blobs disagree about where the id sits and about nothing else: a collection
 * writes `{specId, specHash, syncedAt}` at the root, a run's snapshot writes
 * the same identity under `scenario.openapi`. Unparseable text references
 * nothing - the reading every other reader of these two columns gives it, and
 * the one that cannot make a corrupt row pin a document forever.
 */
std::string spec_id_at (const std::string& blob, std::initializer_list<const char*> path) {
    try {
        auto node = nlohmann::json::parse (blob);
        for (const char* key : path) {
            if (!node.is_object ()) {
                return {};
            }
            const auto it = node.find (key);
            if (it == node.end ()) {
                return {};
            }
            node = *it;
        }
        if (!node.is_object ()) {
            return {};
        }
        return node.value ("specId", std::string ());
    } catch (const std::exception&) {
        return {};
    }
}

} // namespace

size_t Database::sweep_orphaned_spec_documents () {
    try {
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

        // Cheapest question first, and each of the three below is asked only
        // when the one before it left something at stake. This pass rides on
        // every run completion, so what it costs when there is nothing to
        // reclaim - the ordinary case - is what it costs.
        //
        // 1. Which documents are even old enough to consider? Two columns and
        //    never `content`: that is the one column here that reaches
        //    `maxSpecDocumentBytes` (10 MiB by default), and this pass reads no
        //    byte of a document whose fate it is only deciding.
        const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                            .count ();
        const int64_t cutoff = now - vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS;

        std::vector<std::string> candidates;
        for (const auto& [id, fetched_at] : impl_->storage.select (
             columns (&SpecDocument::id, &SpecDocument::fetched_at))) {
            // A bind stores the document before the binding that names it, so a
            // document inside the window is a bind in flight - see the grace
            // constant.
            if (fetched_at <= cutoff) {
                candidates.push_back (id);
            }
        }
        if (candidates.empty ()) {
            return 0;
        }

        // 2. Which of those does a collection still bind? The same parse
        //    `get_collections_bound_to_spec` makes, once over the sidebar-sized
        //    table rather than once per candidate.
        std::unordered_set<std::string> referenced;
        for (const auto& binding : impl_->storage.select (&Collection::openapi)) {
            auto spec_id = spec_id_at (binding, {});
            if (!spec_id.empty ()) {
                referenced.insert (std::move (spec_id));
            }
        }
        std::erase_if (candidates,
        [&] (const std::string& id) { return referenced.count (id) > 0; });
        if (candidates.empty ()) {
            return 0;
        }

        // 3. And which does a retained run still name? Last, because it is the
        //    expensive read: `config_snapshot` is wide and there are up to
        //    `maxRunsRetained` of them.
        std::unordered_set<std::string> pinned;
        for (const auto& snapshot : impl_->storage.select (&Run::config_snapshot)) {
            auto spec_id = spec_id_at (snapshot, { "scenario", "openapi" });
            if (!spec_id.empty ()) {
                pinned.insert (std::move (spec_id));
            }
        }
        std::erase_if (candidates,
        [&] (const std::string& id) { return pinned.count (id) > 0; });
        if (candidates.empty ()) {
            return 0;
        }

        // What survived all three questions is unreachable by definition.
        impl_->storage.transaction ([&] {
            for (const auto& id : candidates) {
                impl_->storage.remove_all<SpecDocument> (
                where (c (&SpecDocument::id) == id));
            }
            return true; // Commit
        });

        vayu::utils::log_info ("Swept " + std::to_string (candidates.size ()) +
        " OpenAPI document(s) no collection binds and no retained run names");
        return candidates.size ();
    } catch (const std::exception& e) {
        // Best-effort by contract - see the header for why a caller must not
        // fail over this.
        vayu::utils::log_warning (
        "OpenAPI document sweep failed: " + std::string (e.what ()));
        return 0;
    }
}

int64_t Database::stamp_hashless_spec_bindings () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    int64_t stamped = 0;
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

// ============================================================================
// Bulk import - collections + requests + environments in one transaction
// ============================================================================

// A payload that fails to write leaves nothing behind (issue #96). Same shape as
// add_results_batch: retry_on_busy holds the recursive mutex while the lambda
// runs, and the lambda only touches the same storage handle.
void Database::import_apply (const std::vector<Collection>& collections,
const std::vector<Request>& requests,
const std::vector<Environment>& environments,
const std::vector<RequestExample>& examples,
const std::vector<SpecDocument>& specs) {
    if (collections.empty () && requests.empty () && environments.empty () &&
    examples.empty () && specs.empty ()) {
        return;
    }

    vayu::utils::log_debug ("Applying import: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests, " +
    std::to_string (environments.size ()) + " environments, " +
    std::to_string (examples.size ()) + " examples, " +
    std::to_string (specs.size ()) + " specs");

    retry_on_busy ("apply import", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            // Ahead of the collections, which may bind them - the same
            // owner-before-referrer order the rest of this transaction keeps.
            for (const auto& s : specs) {
                impl_->storage.replace (s);
            }
            for (const auto& c : collections) {
                impl_->storage.replace (c);
            }
            for (const auto& r : requests) {
                impl_->storage.replace (r);
            }
            // After the requests they belong to, so the rows land in owner
            // order like everything else here.
            for (const auto& x : examples) {
                impl_->storage.replace (x);
            }
            for (const auto& e : environments) {
                // Same at-most-one-active rule as save_environment, applied per
                // row: an import that carries an active environment deactivates
                // the one already stored, and if the payload somehow carries
                // two the last one wins rather than both surviving.
                if (e.is_active) {
                    deactivate_other_environments_locked (e.id);
                }
                impl_->storage.replace (e);
            }
            return true; // Commit
        });
    });
}

// ============================================================================
// Batch reorder - repositioned collections + requests in one transaction
// ============================================================================

// Same shape as import_apply: retry_on_busy holds the recursive mutex while the
// lambda runs, and the lambda only touches the same storage handle. Collections
// first so a request that moved into a collection this batch also reparented
// still lands after its owner's row.
//
// `update` behind an existence check rather than `replace` (issue #386): a
// reorder only repositions rows that already exist, so the upsert half of
// `replace` could only ever re-create a row something else deleted - silently,
// and inside a transaction the endpoint advertises as all-or-nothing. Throwing
// out of the transaction lambda leaves the guard uncommitted, so the rows
// updated before the missing one roll back with it.
void Database::apply_reorder (const std::vector<Collection>& collections,
const std::vector<Request>& requests) {
    if (collections.empty () && requests.empty ()) {
        return;
    }

    vayu::utils::log_debug ("Applying reorder: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests");

    retry_on_busy ("apply reorder", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            for (const auto& row : collections) {
                if (impl_->storage.count<Collection> (
                    where (c (&Collection::id) == row.id)) == 0) {
                    throw MissingRowError ("Collection", row.id);
                }
                impl_->storage.update (row);
            }
            for (const auto& row : requests) {
                if (impl_->storage.count<Request> (
                    where (c (&Request::id) == row.id)) == 0) {
                    throw MissingRowError ("Request", row.id);
                }
                impl_->storage.update (row);
            }
            return true; // Commit
        });
    });
}

// ============================================================================
// Spec sync - the write half of an OpenAPI sync, in one transaction (#655)
// ============================================================================

// Write order is owner-before-referrer, exactly like import_apply, with one
// addition the other two batches do not need: the document lands before the
// binding that names it, so no reader can observe a collection pointing at a
// `spec_documents` row that is not there yet.
//
// The deletes run *before* the inserts. A sync that removes one operation's
// request and adds another cannot be allowed to depend on which order the
// caller listed them in, and an example refresh is expressed as "drop these
// imported rows, write these" - two halves of one replacement, where writing
// first would briefly double the list and, on a re-used id, lose the new row.
void Database::spec_sync_apply (const SpecSyncBatch& batch) {
    vayu::utils::log_debug ("Applying spec sync: collection=" + batch.binding.id + ", spec=" +
    batch.spec.id + ", +" + std::to_string (batch.created.size ()) + " requests, ~" +
    std::to_string (batch.updated.size ()) + ", -" + std::to_string (batch.deleted.size ()) +
    ", " + std::to_string (batch.new_collections.size ()) + " new collections");

    retry_on_busy ("apply spec sync", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            if (impl_->storage.count<Collection> (
                where (c (&Collection::id) == batch.binding.id)) == 0) {
                throw MissingRowError ("Collection", batch.binding.id);
            }
            for (const auto& row : batch.updated) {
                if (impl_->storage.count<Request> (where (c (&Request::id) == row.id)) == 0) {
                    throw MissingRowError ("Request", row.id);
                }
            }

            for (const auto& id : batch.deleted) {
                impl_->storage.remove_all<RequestExample> (
                where (c (&RequestExample::request_id) == id));
                impl_->storage.remove_all<Request> (where (c (&Request::id) == id));
            }
            for (const auto& id : batch.deleted_examples) {
                impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::id) == id));
            }

            impl_->storage.replace (batch.spec);
            for (const auto& row : batch.new_collections) {
                impl_->storage.replace (row);
            }
            impl_->storage.update (batch.binding);
            for (const auto& row : batch.created) {
                impl_->storage.replace (row);
            }
            for (const auto& row : batch.updated) {
                impl_->storage.update (row);
            }
            for (const auto& row : batch.examples) {
                impl_->storage.replace (row);
            }
            return true; // Commit
        });
    });

    // The binding moved off whatever it named before, and a sync is the one
    // operation that does that on a schedule - weekly, for a document that may
    // be 12 MB (issue #718). Reclaimed here rather than left to the next
    // startup, and outside the retried transaction because the sync has already
    // succeeded and must not be undone by housekeeping. Never throws; see the
    // declaration.
    sweep_orphaned_spec_documents ();
}

// The one place a caller can scope the DB mutex around more than a single call.
// Deliberately `std::function` rather than a template: the mutex lives behind
// the pImpl, and a header-inlined template would have to expose it.
void Database::with_lock (const std::function<void ()>& fn) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    fn ();
}

// ============================================================================
// Environments - Named variable sets (dev, staging, prod)
// ============================================================================

// At most one environment is active, and the switch is atomic. Enforced here
// rather than in the routes because three write paths reach this table (POST,
// PUT, and bulk import), and a rule living in the handlers would have to be
// repeated in each - the shape of bug this table already had, when `is_active`
// was honoured on create but not update. A caller that stores an active
// environment gets the previous one deactivated in the same transaction, so no
// reader can observe two actives, and none can observe zero either.
void Database::deactivate_other_environments_locked (const std::string& keep_id) {
    impl_->storage.update_all (set (c (&Environment::is_active) = false),
    where (c (&Environment::is_active) == true and c (&Environment::id) != keep_id));
}

void Database::save_environment (const Environment& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving environment: id=" + e.id +
    ", name=" + e.name + ", is_active=" + (e.is_active ? "true" : "false"));
    impl_->storage.transaction ([&] {
        if (e.is_active) {
            deactivate_other_environments_locked (e.id);
        }
        impl_->storage.replace (e);
        return true; // Commit
    });
}

std::vector<Environment> Database::get_environments () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Environment> ();
}

std::optional<Environment> Database::get_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto envs = impl_->storage.get_all<Environment> (where (c (&Environment::id) == id));
    if (envs.empty ())
        return std::nullopt;
    return envs.front ();
}

void Database::delete_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting environment: id=" + id);
    impl_->storage.remove_all<Environment> (where (c (&Environment::id) == id));
}

// ---------------------------------------------------------------------------
// Client certificates (issue #707)
// ---------------------------------------------------------------------------
//
// Nothing here logs a path, let alone a passphrase: the registry is credential
// material and the log file is not, which is why the debug lines below name the
// row and its host and stop there.

void Database::save_client_certificate (const ClientCertificate& c) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving client certificate: id=" + c.id + ", host=" + c.host);
    impl_->storage.replace (c);
}

std::vector<ClientCertificate> Database::get_client_certificates () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ClientCertificate> ();
}

std::optional<ClientCertificate> Database::get_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows =
    impl_->storage.get_all<ClientCertificate> (where (c (&ClientCertificate::id) == id));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

void Database::delete_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Deleting client certificate: id=" + id);
    impl_->storage.remove_all<ClientCertificate> (where (c (&ClientCertificate::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals (const Globals& g) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Saving globals");
    impl_->storage.replace (g);
}

std::optional<Globals> Database::get_globals () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto globals =
    impl_->storage.get_all<Globals> (where (c (&Globals::id) == "globals"));
    if (globals.empty ())
        return std::nullopt;
    return globals.front ();
}

// ============================================================================
// OAuth token cache
// ============================================================================

void Database::save_oauth_token (const OAuthToken& t) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.replace (t);
}

std::optional<OAuthToken> Database::get_oauth_token (const std::string& cache_key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<OAuthToken> (
    where (c (&OAuthToken::cache_key) == cache_key));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

void Database::delete_oauth_token (const std::string& cache_key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.remove_all<OAuthToken> (
    where (c (&OAuthToken::cache_key) == cache_key));
}

// ============================================================================
// Runs - Test execution sessions (load tests or design mode requests)
// ============================================================================

void Database::create_run (const Run& run) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Creating run: id=" + run.id +
    ", type=" + std::string (vayu::to_string (run.type)));
    impl_->storage.replace (run);
}

std::optional<Run> Database::get_run (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto runs = impl_->storage.get_all<Run> (where (c (&Run::id) == id));
    if (runs.empty ())
        return std::nullopt;
    return runs.front ();
}

void Database::update_run_status (const std::string& id, RunStatus status) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Updating run status: id=" + id +
    ", status=" + std::string (vayu::to_string (status)));
    auto run = get_run (id);
    if (run) {
        run->status   = status;
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
        impl_->storage.update (*run);
    }
}

void Database::update_run_end_time (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("Updating run end_time: id=" + id);
    auto run = get_run (id);
    if (run) {
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
        impl_->storage.update (*run);
    }
}

void Database::update_run_status_with_retry (const std::string& id, RunStatus status, int max_retries) {
    // Public signature is unchanged (real callers in runs.cpp, execution.cpp,
    // load_strategy.cpp); delegate to the shared busy-retry helper.
    retry_on_busy ("update run status", max_retries,
    std::chrono::milliseconds (100), [&] { update_run_status (id, status); });
}

std::vector<Run> Database::get_all_runs () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Run> (order_by (&Run::start_time).desc ());
}

namespace {
// Compose the sqlite_orm WHERE for a RunFilter. Each optional filter becomes
// `(column == value) OR <inactive>`, where <inactive> is a bound `true` when
// the filter is unset - so an unset field is a wildcard and the same compiled
// expression serves every filter combination (no per-combination branching).
// `q` is a substring LIKE over config_snapshot (see RunFilter's contract).
//
// `collection_id` reads the snapshot as JSON instead. `json_extract` raises a
// SQL error - not NULL - on text that is not JSON, and `sanitize_config_snapshot`
// stores an unparseable body verbatim, so handing it the column directly would
// turn one malformed row into a 500 for the whole page. The CASE is the guard:
// SQLite evaluates only the branch it selects, so `json_extract` is never
// applied to anything but valid JSON. A boolean `json_valid(...) AND ...` guard
// would rely on the planner's evaluation order for the same protection, which
// is not ours to depend on.
//
// A missing `$.scenario.collectionId` extracts as SQL NULL, and NULL equals no
// id, so design and load runs (and a scenario run stored before the snapshot
// carried the key) fall out of the result rather than erroring.
auto run_filter_where (const RunFilter& filter) {
    const bool no_type       = !filter.type.has_value ();
    const bool no_status     = !filter.status.has_value ();
    const bool no_req        = !filter.request_id.has_value ();
    const bool no_q          = !filter.q.has_value () || filter.q->empty ();
    const bool no_collection = !filter.collection_id.has_value ();
    const bool no_baseline   = !filter.baseline.has_value ();

    const RunType type_val           = filter.type.value_or (RunType::Design);
    const RunStatus status_val       = filter.status.value_or (RunStatus::Pending);
    const std::string req_val        = filter.request_id.value_or ("");
    const std::string q_pat          = "%" + (filter.q ? *filter.q : std::string{}) + "%";
    const std::string collection_val = filter.collection_id.value_or ("");
    const bool baseline_val          = filter.baseline.value_or (false);

    // The snapshot when it is JSON, an empty object when it is not - the guard
    // described above, so json_extract below is always handed valid JSON.
    const auto snapshot_json = case_<std::string> ()
                               .when (json_valid (&Run::config_snapshot),
                               then (&Run::config_snapshot))
                               .else_ (std::string{ "{}" })
                               .end ();

    return where ((c (&Run::type) == type_val || no_type) &&
    (c (&Run::status) == status_val || no_status) &&
    (c (&Run::request_id) == req_val || no_req) &&
    (like (&Run::config_snapshot, q_pat) || no_q) &&
    (c (&Run::baseline) == baseline_val || no_baseline) &&
    (json_extract<std::string> (snapshot_json, std::string{ "$.scenario.collectionId" }) ==
     collection_val ||
    no_collection));
}
} // namespace

std::vector<Run> Database::get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Run> (run_filter_where (filter),
    order_by (&Run::start_time).desc (), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_runs (const RunFilter& filter) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<Run> (run_filter_where (filter));
}

// The run cascade in one place: every child table a run owns, deleted before
// the run row itself. delete_run and prune_runs both go through this, so a new
// child table cannot be added to one and forgotten in the other (metric_ticks
// was added to both by editing only this function). Caller holds the mutex.
void Database::remove_run_cascade_locked (const std::string& id) {
    impl_->storage.remove_all<MetricTick> (where (c (&MetricTick::run_id) == id));
    impl_->storage.remove_all<MonitorSample> (where (c (&MonitorSample::run_id) == id));
    // Captured bodies before the results they hang off, so a delete interrupted
    // between the two leaves results without bodies rather than body rows
    // pointing at nothing. `maxRunsRetained` doubles as the expiry for anything
    // credential-shaped a capture picked up, which is what makes this cascade
    // load-bearing rather than housekeeping.
    impl_->storage.remove_all<ResultBody> (where (c (&ResultBody::run_id) == id));
    impl_->storage.remove_all<BodyBlob> (where (c (&BodyBlob::run_id) == id));
    impl_->storage.remove_all<Result> (where (c (&Result::run_id) == id));
    impl_->storage.remove<Run> (id);
}

// Cascade delete: removes ticks and results first
void Database::delete_run (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    remove_run_cascade_locked (id);
}

// Retried like every other write here, and for a sharper reason: this row is
// the *only* record of a run's whole-run aggregates, and a lock lost here is
// not a lost tick - it is a report that falls back to the sampled results and
// renders the run's whole-run figures wrong, permanently. The read-modify-write
// runs inside the retried callback so a retry re-reads the row rather than
// replaying a stale copy over a status the worker updated in between.
void Database::update_run_summary (const std::string& id, const std::string& summary) {
    retry_on_busy ("store run summary", 5, std::chrono::milliseconds (100), [&] {
        auto run = get_run (id);
        if (!run) {
            vayu::utils::log_warning (
            "Run summary write skipped, run not found: " + id);
            return;
        }
        run->summary = summary;
        impl_->storage.update (*run);
    });
}

// Pin or unpin a run as a baseline. Retried like every other write here, and
// the read-modify-write sits inside the retried callback so a retry re-reads
// the row rather than replaying a stale copy over a summary or a status a
// worker wrote in between. Returns the stored row, or nullopt when there is no
// such run - which is what lets the route answer 404 instead of inventing one.
std::optional<Run> Database::set_run_baseline (const std::string& id, bool baseline) {
    std::optional<Run> updated;
    retry_on_busy ("set run baseline", 5, std::chrono::milliseconds (100), [&] {
        auto run = get_run (id);
        if (!run) {
            updated.reset ();
            return;
        }
        run->baseline = baseline;
        impl_->storage.update (*run);
        updated = *run;
    });
    return updated;
}

// Retention: drop runs beyond the count cap and/or older than the age cap.
void Database::prune_runs (int max_runs, int max_age_days) {
    // Both limits off - nothing to do (0 = unlimited for each).
    if (max_runs <= 0 && max_age_days <= 0) {
        return;
    }

    // 1. Select victim ids under the lock, then release it before deleting so
    //    the (potentially large) delete loop batches its own locking below.
    std::vector<std::string> victims;
    {
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

        // Newest first, matching get_all_runs / the count cap's "most-recent N".
        auto runs = impl_->storage.get_all<Run> (order_by (&Run::start_time).desc ());

        const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                            .count ();
        // 0 disables the age cap; guard the multiply against overflow.
        const int64_t age_cutoff =
        max_age_days > 0 ? now - static_cast<int64_t> (max_age_days) * 86'400'000LL : 0;

        int kept = 0;
        for (const auto& run : runs) {
            // In-flight runs are never pruned and do not count toward the cap.
            if (run.status == RunStatus::Running || run.status == RunStatus::Pending) {
                continue;
            }
            // Neither is a pinned baseline: a run kept as the thing later runs
            // are measured against is exactly the run retention must not
            // expire. Skipped rather than merely spared, for the same reason
            // an in-flight run is - counting it toward the cap would let a
            // handful of pins evict the recent history the cap exists to keep.
            if (run.baseline) {
                continue;
            }
            const bool over_count = (max_runs > 0) && (kept >= max_runs);
            const bool too_old = (max_age_days > 0) && (run.start_time < age_cutoff);
            if (over_count || too_old) {
                victims.push_back (run.id);
            } else {
                ++kept;
            }
        }
    }

    if (victims.empty ()) {
        return;
    }

    // 2. Delete via the delete_run cascade, batched so a huge backlog does not
    //    hold the DB mutex for seconds. The lock is re-taken per batch and
    //    released between them, letting /health, SSE and the runs poll interleave.
    constexpr size_t BATCH_SIZE = 100;
    for (size_t start = 0; start < victims.size (); start += BATCH_SIZE) {
        const size_t end = std::min (start + BATCH_SIZE, victims.size ());
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
        impl_->storage.transaction ([&] {
            for (size_t i = start; i < end; ++i) {
                remove_run_cascade_locked (victims[i]);
            }
            return true; // Commit
        });
    }

    vayu::utils::log_info ("Pruned " + std::to_string (victims.size ()) +
    " old run(s) (max_runs=" + std::to_string (max_runs) +
    ", max_age_days=" + std::to_string (max_age_days) + ")");
}

size_t Database::reconcile_orphaned_runs () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    auto orphans = impl_->storage.get_all<Run> (where (
    c (&Run::status) == RunStatus::Running || c (&Run::status) == RunStatus::Pending));
    if (orphans.empty ()) {
        return 0;
    }

    // end_time is deliberately left as recorded. When the process died is
    // unknowable now, and stamping the restart time would invent a duration
    // spanning however long the daemon was down. What is recorded is never
    // indeterminate: `Run::end_time` defaults to 0 and both route inserts seed
    // it to start_time (seed_run_times in execution.cpp), while
    // update_run_end_time may since have refined it.
    impl_->storage.transaction ([&] {
        for (auto& run : orphans) {
            run.status = RunStatus::Failed;
            impl_->storage.update (run);
        }
        return true; // Commit
    });

    vayu::utils::log_info ("Reconciled " + std::to_string (orphans.size ()) +
    " run(s) left in-flight by a previous process (marked failed)");
    return orphans.size ();
}

void Database::prune_runs_configured () {
    const int max_runs =
    get_config_int ("maxRunsRetained", vayu::core::constants::database::MAX_RUNS_RETAINED);
    const int max_age_days =
    get_config_int ("runRetentionDays", vayu::core::constants::database::RUN_RETENTION_DAYS);
    prune_runs (max_runs, max_age_days);
    // A run that has just been pruned may have been the last thing naming an
    // OpenAPI document (issue #718). Retention is where that reference is
    // released, so it is where the release is noticed - and this is what puts
    // the sweep on both a startup and the end of every run without a schedule
    // of its own. Never throws; see the declaration.
    sweep_orphaned_spec_documents ();
}

// ============================================================================
// Metric ticks - one wide row per tick (the current time-series storage)
// ============================================================================

void Database::add_metric_tick (const MetricTick& tick) {
    retry_on_busy ("add metric tick", 5, std::chrono::milliseconds (100),
    [&] { impl_->storage.insert (tick); });
}

// Ordered by (timestamp, id): the timestamp is the tick's sort key and `id`
// breaks a tie deterministically, so a page boundary always falls between two
// whole ticks - never mid-tick, the way row-paginating the EAV table did.
std::vector<MetricTick>
Database::get_metric_ticks_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MetricTick> (
    where (c (&MetricTick::run_id) == run_id),
    multi_order_by (order_by (&MetricTick::timestamp), order_by (&MetricTick::id)),
    sqlite_orm::limit (offset, limit));
}

// Ticks added after a specific id (incremental polling by the legacy SSE loop).
std::vector<MetricTick>
Database::get_metric_ticks_since (const std::string& run_id, int64_t last_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MetricTick> (
    where (c (&MetricTick::run_id) == run_id && c (&MetricTick::id) > last_id),
    order_by (&MetricTick::id));
}

int64_t Database::count_metric_ticks (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<MetricTick> (where (c (&MetricTick::run_id) == run_id));
}

// ============================================================================
// Monitor samples - external server vitals scraped alongside a run
// ============================================================================

void Database::add_monitor_sample (const MonitorSample& sample) {
    retry_on_busy ("add monitor sample", 5, std::chrono::milliseconds (100),
    [&] { impl_->storage.insert (sample); });
}

// Ordered (timestamp, id) for the same reason the tick reader is: a page
// boundary falls between two whole samples, never inside one.
std::vector<MonitorSample>
Database::get_monitor_samples_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MonitorSample> (
    where (c (&MonitorSample::run_id) == run_id),
    multi_order_by (order_by (&MonitorSample::timestamp), order_by (&MonitorSample::id)),
    sqlite_orm::limit (offset, limit));
}

int64_t Database::count_monitor_samples (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<MonitorSample> (where (c (&MonitorSample::run_id) == run_id));
}

// ============================================================================
// Inbox captures - what a webhook inbox listener recorded (issue #480)
// ============================================================================

int Database::add_inbox_request (const InboxRequest& capture, int64_t max_captures) {
    int assigned_id = 0;
    retry_on_busy ("append inbox capture", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            assigned_id = static_cast<int> (impl_->storage.insert (capture));

            if (max_captures > 0) {
                const int64_t stored = impl_->storage.count<InboxRequest> (
                where (c (&InboxRequest::inbox_id) == capture.inbox_id));
                if (stored > max_captures) {
                    // Delete by id rather than "everything older than the Nth
                    // received_at": two captures can share a millisecond, and a
                    // timestamp cutoff would then evict both or neither.
                    auto victims = impl_->storage.select (&InboxRequest::id,
                    where (c (&InboxRequest::inbox_id) == capture.inbox_id),
                    order_by (&InboxRequest::id),
                    sqlite_orm::limit (stored - max_captures));
                    for (const int victim : victims) {
                        impl_->storage.remove<InboxRequest> (victim);
                    }
                }
            }
            return true; // Commit
        });
    });
    return assigned_id;
}

std::vector<InboxRequest> Database::get_inbox_requests_paginated (const std::string& inbox_id,
int64_t limit,
int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id),
    order_by (&InboxRequest::id).desc (), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_inbox_requests (const std::string& inbox_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<InboxRequest> (where (c (&InboxRequest::inbox_id) == inbox_id));
}

std::vector<InboxRequest>
Database::get_inbox_requests_since (const std::string& inbox_id, int64_t last_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id && c (&InboxRequest::id) > last_id),
    order_by (&InboxRequest::id));
}

int64_t Database::clear_inbox_requests (const std::string& inbox_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    const int64_t removed =
    impl_->storage.count<InboxRequest> (where (c (&InboxRequest::inbox_id) == inbox_id));
    impl_->storage.remove_all<InboxRequest> (where (c (&InboxRequest::inbox_id) == inbox_id));
    return removed;
}

int64_t Database::clear_inbox_requests_all () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    const int64_t removed = impl_->storage.count<InboxRequest> ();
    if (removed > 0) {
        impl_->storage.remove_all<InboxRequest> ();
    }
    return removed;}

// ============================================================================
// Results - Individual request outcomes with timing breakdown
// ============================================================================

void Database::add_result (const Result& result) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.insert (result);
}

// Batch insert with transaction for better performance
// Includes retry logic to handle database lock contention
void Database::add_results_batch (const std::vector<Result>& results,
const std::vector<PendingResultBody>& bodies) {
    if (results.empty ())
        return;

    retry_on_busy ("flush results batch", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            // Row ids only exist after the insert, so keep them alongside the
            // batch positions the pending bodies refer to.
            std::vector<int> result_ids;
            result_ids.reserve (results.size ());
            for (const auto& result : results) {
                result_ids.push_back (
                static_cast<int> (impl_->storage.insert (result)));
            }

            // Dedup within the run: identical bodies (the norm for a load test)
            // share one blob row. The map is rebuilt per attempt on purpose -
            // a retried transaction re-inserts the blobs it rolled back.
            std::map<std::string, int> blob_ids;
            for (const auto& pending : bodies) {
                if (pending.result_index >= result_ids.size ()) {
                    continue; // Defensive: an index with no result cannot be attached.
                }

                int blob_id = 0;
                if (!pending.body_hash.empty ()) {
                    auto it = blob_ids.find (pending.body_hash);
                    if (it != blob_ids.end ()) {
                        blob_id = it->second;
                    } else {
                        BodyBlob blob;
                        blob.run_id  = results[pending.result_index].run_id;
                        blob.hash    = pending.body_hash;
                        blob.content = pending.body;
                        blob_id = static_cast<int> (impl_->storage.insert (blob));
                        blob_ids.emplace (pending.body_hash, blob_id);
                    }
                }

                ResultBody row;
                row.result_id    = result_ids[pending.result_index];
                row.run_id       = results[pending.result_index].run_id;
                row.headers      = pending.headers;
                row.blob_id      = blob_id;
                row.body_bytes   = pending.body_bytes;
                row.truncated    = pending.truncated;
                row.is_binary     = pending.binary;
                row.content_type  = pending.content_type;
                row.stream_events = pending.stream_events;
                impl_->storage.replace (row);
            }
            return true; // Commit
        });
    });
}

std::vector<Result> Database::get_results (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Result> (where (c (&Result::run_id) == run_id));
}

std::unordered_map<std::string, DesignResultOutcome>
Database::get_design_result_outcomes (const std::vector<std::string>& run_ids) {
    std::unordered_map<std::string, DesignResultOutcome> outcomes;
    if (run_ids.empty ()) {
        return outcomes; // No statement at all rather than `IN ()`.
    }

    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The design-run subquery is inside the statement on purpose: it is what
    // makes "a load run's results are never read" a property of the query
    // rather than of every caller passing the right ids. Three columns, so a
    // page of rows costs no trace_data.
    auto rows = impl_->storage.select (
    columns (&Result::run_id, &Result::status_code, &Result::latency_ms),
    where (in (&Result::run_id, run_ids) &&
    in (&Result::run_id, select (&Run::id, where (c (&Run::type) == RunType::Design)))));

    for (const auto& row : rows) {
        // A design run has exactly one result; keep the first if a row ever
        // duplicates rather than letting the last write win silently.
        outcomes.emplace (std::get<0> (row),
        DesignResultOutcome{ std::get<1> (row), std::get<2> (row) });
    }
    return outcomes;
}

// ============================================================================
// Captured response bodies - read only by GET /runs/:id/samples
// ============================================================================

std::vector<ResultBody>
Database::get_result_bodies_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ResultBody> (where (c (&ResultBody::run_id) == run_id),
    order_by (&ResultBody::result_id), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_result_bodies (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<ResultBody> (where (c (&ResultBody::run_id) == run_id));
}

std::string Database::get_body_blob_content (int blob_id) {
    if (blob_id == 0) {
        return {}; // No stored body: binary, absent, or dropped for budget.
    }
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // get_all + where rather than a by-primary-key lookup, matching every other
    // single-row read in this file (get_run, get_request, ...) - one idiom, and
    // a missing row is an empty vector rather than a throw or a null to handle.
    auto blobs = impl_->storage.get_all<BodyBlob> (where (c (&BodyBlob::id) == blob_id));
    return blobs.empty () ? std::string{} : blobs.front ().content;
}

// ============================================================================
// Busy-retry helper - shared by the four write paths above
// ============================================================================

void Database::retry_on_busy (const char* what,
int attempts,
std::chrono::milliseconds base,
const std::function<void ()>& fn) {
    for (int attempt = 0; attempt < attempts; attempt++) {
        try {
            std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
            fn ();
            return; // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what ();
            // Only SQLite busy/locked errors are retried; sqlite_orm surfaces
            // them as std::system_error with these substrings in what().
            const bool busy = error_msg.find ("database is locked") != std::string::npos ||
            error_msg.find ("SQLITE_BUSY") != std::string::npos;
            if (!busy) {
                throw; // Different error, rethrow immediately
            }
            if (attempt == attempts - 1) {
                // Busy persisted through every attempt - log and rethrow.
                vayu::utils::log_error (std::string ("Failed to ") + what +
                " after " + std::to_string (attempts) + " attempts: " + error_msg);
                throw;
            }
            vayu::utils::log_debug (std::string ("Database locked during ") + what +
            ", retrying in " + std::to_string (base.count () * (attempt + 1)) + "ms (attempt " +
            std::to_string (attempt + 1) + "/" + std::to_string (attempts) + ")");
        }
        // The lock_guard scope above has ended: we sleep *without* holding the
        // mutex so a busy retry never stalls other endpoints (/health, SSE,
        // the runs poll) that serialize on the same lock.
        std::this_thread::sleep_for (base * (attempt + 1));
    }
}

// ============================================================================
// Config Entries - Structured configuration with metadata
// ============================================================================

void Database::save_config_entry (const ConfigEntry& entry) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.replace (entry);
}

std::optional<ConfigEntry> Database::get_config_entry (const std::string& key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entries =
    impl_->storage.get_all<ConfigEntry> (where (c (&ConfigEntry::key) == key));
    if (entries.empty ())
        return std::nullopt;
    return entries.front ();
}

std::vector<ConfigEntry> Database::get_all_config_entries () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ConfigEntry> ();
}

int Database::applied_cache_size_bytes () const {
    // No DB mutex: the value is an atomic the open callback writes, and taking
    // the mutex here would order this read behind whatever query is running.
    return impl_->applied_cache_size_bytes.load ();
}

// Type-safe config getters (replaces ConfigManager)
int Database::get_config_int (const std::string& key, int default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stoi (entry->value);
    } catch (...) {
        vayu::utils::log_warning (
        "Database: Failed to parse int for key " + key + ", using default");
        return default_value;
    }
}

std::string Database::get_config_string (const std::string& key,
const std::string& default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    return entry->value;
}

bool Database::get_config_bool (const std::string& key, bool default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    return entry->value == "true";
}

double Database::get_config_double (const std::string& key, double default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stod (entry->value);
    } catch (...) {
        vayu::utils::log_warning (
        "Database: Failed to parse double for key " + key + ", using default");
        return default_value;
    }
}

namespace {
// Serialize all_http_versions() to the `{value,label}` JSON array the
// "defaultHttpVersion" config entry stores in its `options` column. Derived
// from the domain enumeration rather than a literal list, so a change to
// HttpVersion cannot silently drift out of sync with the seeded options.
std::string http_version_options_json () {
    nlohmann::json options = nlohmann::json::array ();
    for (const auto version : vayu::all_http_versions ()) {
        options.push_back ({ { "value", vayu::to_string (version) },
        { "label", vayu::http_version_label (version) } });
    }
    return options.dump ();
}

// The `{value,label}` array for "dbSynchronous". SQLite's synchronous levels
// are its own enumeration, not ours, so the list is literal - but it belongs in
// the `options` column rather than spelled out as "0 = Off, 1 = ..." prose over
// an integer input, which is what the entry used to do.
// The `{value,label}` array for "proxyMode". Derived from the enumeration the
// resolver parses, so a mode added to `ProxyMode` cannot be missing from the
// options the config route validates against - which would make it a value
// the engine understands and `POST /config` refuses.
std::string proxy_mode_options_json () {
    nlohmann::json options = nlohmann::json::array ();
    for (const auto mode : vayu::http::all_proxy_modes ()) {
        options.push_back ({ { "value", vayu::http::to_string (mode) },
        { "label", vayu::http::proxy_mode_label (mode) } });
    }
    return options.dump ();
}

std::string db_synchronous_options_json () {
    const nlohmann::json options = { { { "value", "0" }, { "label", "Off" } },
        { { "value", "1" }, { "label", "Normal" } },
        { { "value", "2" }, { "label", "Full" } } };
    return options.dump ();
}
} // namespace

void Database::seed_default_config () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // Retired settings: keys nothing reads any more. Delete any row left behind
    // by an older version so the Settings UI (which renders engine entries
    // dynamically from GET /config) stops offering a dead knob.
    //
    //   requestBatchSize - drove the removed batched request iteration.
    //   contextPoolSize  - promised "pre-initialized JS contexts", but the
    //                      script context pool is grown lazily and never read a
    //                      bound (issue #112). A user could set it 1..256 and
    //                      change nothing.
    //
    // The 2026-08 sweep (#519) retired eleven more. Each was verified by
    // searching the engine for a reader; where the constant behind the key kept
    // its own callers, the constant stayed and only the knob went.
    //
    //   maxConnections       - no reader anywhere; the server enforces no such
    //                          global limit.
    //   tcpKeepAliveIdle     - curl_utils sets both CURL keep-alive options from
    //   tcpKeepAliveInterval   constants and never consults the config.
    //   statsInterval        - superseded by liveTickIntervalMs, which shares its
    //                          default and its purpose and is the one that is
    //                          read. Two rows, one mechanism.
    //   maxJsonFieldSize     - json.cpp caps stored fields at the constant, so
    //                          the "increase only if..." escape hatch the
    //                          description offered did not exist.
    //   sseConnectTimeout    - the dashboard's reconnect logic is renderer-side
    //   sseMaxRetry            and never asked the engine for these; the sse::*
    //   sseSendLastEventId     constants existed only to seed them.
    //   dbTempStore          - all three are PRAGMAs the open callback applies
    //   dbMmapSize             from constants. Wiring them buys nothing: the
    //   dbWalAutocheckpoint    defaults are already the measured optimum (see
    //                          docs/engine/benchmarks.md) and none has a user
    //                          story. dbCacheSize, the one that does, is wired
    //                          instead of retired.
    for (const char* retired : { "requestBatchSize", "contextPoolSize",
             "maxConnections", "tcpKeepAliveIdle", "tcpKeepAliveInterval",
             "statsInterval", "maxJsonFieldSize", "sseConnectTimeout",
             "sseMaxRetry", "sseSendLastEventId", "dbTempStore", "dbMmapSize",
             "dbWalAutocheckpoint" }) {
        impl_->storage.remove_all<ConfigEntry> (
        where (c (&ConfigEntry::key) == std::string (retired)));
    }

    // Get existing config entries (if any) to preserve user-modified values
    auto existing = impl_->storage.get_all<ConfigEntry> ();
    std::unordered_map<std::string, ConfigEntry> existing_map;
    for (const auto& entry : existing) {
        existing_map[entry.key] = entry;
    }

    auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
               .count ();

    // Metadata markers, wrapped around the entry they apply to so the flag is
    // read at the top of the seed rather than counted out as a trailing
    // positional `true` after `now`.
    //
    // restart_required: the running engine keeps the old value until restarted.
    // The app shows one chip from this and the Dock a pending signal; nothing
    // states it in the label or the description any more.
    //
    // advanced: an internal with no everyday user story. Rendered collapsed
    // under "Advanced" at the bottom of its category, not removed - a knob that
    // is still live is still reachable.
    auto restart_required = [] (ConfigEntry entry) {
        entry.requires_restart = true;
        return entry;
    };
    auto advanced = [] (ConfigEntry entry) {
        entry.advanced = true;
        return entry;
    };
    // keywords: the words a user arrives with that this entry's key, label and
    // description never say - "ram" for a cache size, "deadline" for a timeout.
    // Not a place to repeat what the entry already carries: search already
    // matches all three fields, and a keyword that duplicates one only lifts
    // the entry above better matches. A guard test enforces that.
    auto keywords = [] (std::initializer_list<const char*> terms) {
        // Serialized here rather than inside the returned wrapper: an
        // initializer_list's backing array dies with the full-expression that
        // built it, so a wrapper that held on to it would be reading freed
        // storage the moment one is stored instead of called immediately.
        std::string json =
        nlohmann::json (std::vector<std::string> (terms.begin (), terms.end ()))
        .dump ();
        return [json = std::move (json)] (ConfigEntry entry) {
            entry.keywords = json;
            return entry;
        };
    };
    // unit: what the value measures, for the entries that measure something.
    // The app renders it as the input's suffix, which is the one place a unit
    // belongs - so a description that also spells it out states it twice, and a
    // guard test rejects the "in milliseconds" / "in bytes" clause for any
    // entry that declares one. A count (workers, retained runs, stored steps)
    // declares none: it measures nothing, and a suffix reading "items" is
    // noise.
    auto unit = [] (const char* symbol) {
        return [symbol = std::string (symbol)] (ConfigEntry entry) {
            entry.unit = symbol;
            return entry;
        };
    };

    // Helper lambda: Creates or updates a config entry
    // - New entries get default values
    // - Existing entries preserve user-modified values but get updated metadata
    auto upsert_config = [&] (const ConfigEntry& new_entry) {
        auto it = existing_map.find (new_entry.key);
        if (it != existing_map.end ()) {
            // Preserve user's value but update metadata (description, label, etc.)
            ConfigEntry updated = new_entry;
            updated.value       = it->second.value;     // Keep user's value
            updated.updated_at = it->second.updated_at; // Keep original timestamp
            impl_->storage.replace (updated);
        } else {
            // New entry - use defaults
            impl_->storage.replace (new_entry);
        }
    };

    // =========================================================================
    // CORE (general_engine)
    // The engine's own machinery: how much work it runs in parallel, and how
    // SQLite is tuned underneath it. Everything a *request* or a *run* is
    // measured or bounded by lives in one of the categories below - #703 moved
    // the request defaults to Network & connectivity and the ceilings to
    // Limits, leaving the four settings that describe the engine itself.
    // =========================================================================

    upsert_config (restart_required (keywords ({ "cores", "parallelism" }) (
    ConfigEntry{ "workers",
    std::to_string (std::thread::hardware_concurrency ()), "integer", "Worker Threads",
    "Number of background worker threads. Higher values improve throughput on "
    "multi-core systems but increase RAM usage. "
    "Default equals CPU core count.",
    "general_engine", std::to_string (std::thread::hardware_concurrency ()),
    "1", "128", std::nullopt, now })));

    upsert_config (restart_required (unit ("bytes") (
    keywords ({ "ram" }) (ConfigEntry{ "dbCacheSize",
    std::to_string (vayu::core::constants::database::CACHE_SIZE_BYTES),
    "integer", "Database Cache Size",
    "Memory SQLite keeps per connection for recently used database pages. A "
    "larger cache spares repeated reads while a high-RPS run writes results and "
    "the dashboard queries them. 64 to 128 megabytes suits runs storing 10,000 "
    "or more results a second.",
    "general_engine", std::to_string (vayu::core::constants::database::CACHE_SIZE_BYTES),
    "1048576",    // min: 1MB in bytes
    "1073741824", // max: 1GB in bytes
    std::nullopt, now }))));

    upsert_config (restart_required (advanced (unit ("ms") (
    keywords ({ "contention" }) (ConfigEntry{ "dbBusyTimeout",
    std::to_string (vayu::core::constants::database::BUSY_TIMEOUT_MS),
    "integer", "Database Lock Wait Time",
    "How long a thread waits for the database when another one is writing to "
    "it. Result-storage threads compete for it during a high-concurrency run, "
    "and a longer wait turns a 'database is locked' failure into a pause "
    "instead. 10 to 30 seconds suits runs at 100 or more concurrent requests.",
    "general_engine", std::to_string (vayu::core::constants::database::BUSY_TIMEOUT_MS),
    "1000",  // min: 1 second
    "60000", // max: 60 seconds
    std::nullopt, now })))));

    upsert_config (restart_required (keywords ({ "fsync", "pragma" }) (
    ConfigEntry{ "dbSynchronous",
    std::to_string (vayu::core::constants::database::SYNCHRONOUS), "enum",
    "Data Safety Mode",
    "How hard SQLite works to get results onto disk before reporting them "
    "written. Off is the fastest and the default: the database stays "
    "uncorrupted through a crash, but the last few results may be lost to a "
    "power cut, which is an acceptable trade for test telemetry. Normal and "
    "Full buy durability back at the cost of write throughput during a "
    "high-RPS run.",
    "general_engine", std::to_string (vayu::core::constants::database::SYNCHRONOUS),
    std::nullopt, std::nullopt, db_synchronous_options_json (), now })));

    // =========================================================================
    // NETWORK & CONNECTIVITY (network_performance)
    // The wire itself: what a new request starts with, how many transfers a
    // worker keeps open, and how long a name resolution is reused. The OAuth
    // renewal knobs that used to sit here were five of its eight entries and
    // moved to Services (#703) - a user tuning token renewal does not arrive
    // at "network tuning".
    // =========================================================================

    upsert_config (unit ("ms") (keywords ({ "deadline", "give up", "hang" }) (
    ConfigEntry{ "defaultTimeout",
    std::to_string (vayu::core::constants::server::DEFAULT_TIMEOUT_MS), "integer", "Default Request Timeout",
    "How long an HTTP request may run before it is abandoned, "
    "when the request does not set a timeout of its own. Raise it for slow "
    "endpoints; lower it to fail faster.",
    "network_performance", std::to_string (vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
    "1000",   // min: 1 second
    "300000", // max: 5 minutes
    std::nullopt, now })));

    upsert_config (keywords ({ "h2", "alpn" }) (ConfigEntry{ "defaultHttpVersion",
    vayu::to_string (vayu::DEFAULT_HTTP_VERSION), "enum", "Default HTTP Version",
    "Protocol a newly created request starts with. Auto lets the server and "
    "client negotiate (HTTP/2 where available, falling back to HTTP/1.1). "
    "Changing this does not alter requests that already exist.",
    "network_performance", vayu::to_string (vayu::DEFAULT_HTTP_VERSION),
    std::nullopt, std::nullopt, http_version_options_json (), now }));

    upsert_config (keywords ({ "concurrency", "parallel" }) (
    ConfigEntry{ "eventLoopMaxConcurrent",
    std::to_string (vayu::core::constants::event_loop::MAX_CONCURRENT),
    "integer", "Max Concurrent Requests (Per Worker)",
    "How many requests one worker keeps in flight at once. Higher values use "
    "more file descriptors and push the target harder. Read when a load test "
    "starts, so a change applies to the next run.",
    "network_performance", std::to_string (vayu::core::constants::event_loop::MAX_CONCURRENT),
    "1", "10000", std::nullopt, now }));

    upsert_config (keywords ({ "socket", "pool" }) (ConfigEntry{ "eventLoopMaxPerHost",
    std::to_string (vayu::core::constants::event_loop::MAX_PER_HOST), "integer",
    "Max Connections Per Host (Per Worker)",
    "Concurrency limit for a specific target API host. Critical for respecting "
    "target rate limits. "
    "Lower values are gentler on the target; higher values maximize "
    "throughput.",
    "network_performance", std::to_string (vayu::core::constants::event_loop::MAX_PER_HOST),
    "1", "1000", std::nullopt, now }));

    upsert_config (unit ("sec") (keywords ({ "ttl" }) (ConfigEntry{ "dnsCacheTimeout",
    std::to_string (vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
    "integer", "DNS Cache Timeout",
    "How long a resolved hostname is reused before it is looked up "
    "again. 0 forces a fresh lookup on every request; 60 to 300 seconds suits a "
    "stable endpoint.",
    "network_performance",
    std::to_string (vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
    "0",    // Disable cache
    "3600", // 1 hour
    std::nullopt, now })));

    // Proxy (issue #705). Three entries, read together by
    // `resolve_transport_policy` at the point of use, so a change applies to
    // the next transfer rather than the next restart. The keywords are the
    // words someone arrives with when nothing works and they suspect the
    // network - none of which the labels say.
    upsert_config (keywords ({ "corporate", "firewall", "mitm", "zscaler", "vpn" }) (
    ConfigEntry{ "proxyMode",
    vayu::http::to_string (vayu::http::TransportPolicy{}.proxy_mode), "enum",
    "Proxy",
    "How outbound requests reach the network. From environment uses the "
    "http_proxy and https_proxy variables the engine was started with, which "
    "is what a terminal-launched engine already picks up and a desktop launch "
    "usually has none of. From system uses the proxy this computer is "
    "configured with, which the app resolves and shows below. Manual routes "
    "everything through the proxy URL below. None sends direct, ignoring those "
    "variables too.",
    "network_performance",
    vayu::http::to_string (vayu::http::TransportPolicy{}.proxy_mode), std::nullopt,
    std::nullopt, proxy_mode_options_json (), now }));

    upsert_config (keywords ({ "corporate", "firewall", "mitm" }) (ConfigEntry{ "proxyUrl", "",
    "string", "Proxy URL",
    "The proxy to route through when Proxy is set to Manual, written the way "
    "curl takes it: scheme://user:password@host:port. The scheme selects the "
    "kind - http, https, socks4, socks4a, socks5, socks5h - and credentials in "
    "the URL are sent as basic proxy authentication.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    // The resolved system proxy (issue #708). Written by the app's main
    // process, which is the only part of Vayu that can ask the operating system
    // - Chromium resolves it, libcurl sees none of it - and read by the engine
    // only under `proxyMode: system`.
    //
    // A visible row rather than a hidden side channel: a proxy the user cannot
    // see is the failure this epic exists to end, and "system" that silently
    // resolved to nothing has to be readable as such. It is stored where the
    // user can edit it, and an edit lasts until the next resolution overwrites
    // it - said in the description rather than enforced, because a read-only
    // entry type would be a new concept in the config table for one row.
    upsert_config (keywords ({ "wpad", "autoconfig", "automatic" }) (
    ConfigEntry{ "proxySystemUrl", "", "string", "System Proxy (resolved)",
    "The proxy this computer is configured with, as the app resolved it when "
    "it started and whenever the network changed. Read only when Proxy is set "
    "to From system; empty means nothing resolved - a direct configuration, or "
    "an engine running with no app to ask - and requests then fall back to the "
    "http_proxy and https_proxy variables. A PAC script is resolved once, "
    "against a sample URL, and the one answer applies to every request: a "
    "configuration that returns different proxies for different URLs needs "
    "Manual instead. Typing a value here works until the next resolution "
    "replaces it.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    upsert_config (keywords ({ "exclude", "whitelist", "intranet" }) (
    ConfigEntry{ "proxyBypass", "", "string", "Proxy Bypass List",
    "Hosts that skip the proxy, comma-separated. A leading dot matches a "
    "domain and everything under it (.internal.example.com), and a single * "
    "bypasses the proxy for every host. Under Manual this list is the whole "
    "rule, so an empty one means nothing is exempt and any no_proxy the engine "
    "was started with is ignored. Under From environment it overrides that "
    "variable when set, and defers to it when empty. Under From system it "
    "follows whichever of those two that mode resolved to.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    // Custom trust anchors (issue #706). `text` rather than `string` because
    // what goes in it is a pasted PEM block: the single-line input every other
    // string entry renders cannot show one, let alone several.
    //
    // Content, not a path - a path breaks the moment the file moves and cannot
    // be shown back in Settings. The engine materializes the bundle beside the
    // database, extending the platform's own anchors rather than replacing
    // them; see `resolve_transport_policy`.
    upsert_config (keywords ({ "firewall", "mitm", "zscaler", "ssl" }) (
    ConfigEntry{ "customCaCertificates", "", "text", "Custom CA Certificates",
    "Certificate authorities to trust in addition to the ones this platform "
    "already trusts, pasted as PEM text (one or more -----BEGIN "
    "CERTIFICATE----- blocks). This is what makes a corporate TLS-inspecting "
    "proxy or an internal self-signed authority verifiable everywhere the "
    "engine sends: requests, load runs, streams, OAuth token fetches and spec "
    "imports alike. Paste certificates only - never a private key.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    // =========================================================================
    // SERVICES (services)
    // The long-lived surfaces: streaming requests, the webhook inboxes and mock
    // servers the Dock calls Services, and the OAuth issuers behind them.
    // Before #586 these were filed under Observability, which is the drawer's
    // word for none of them - a user managing a service found no matching word
    // in the tree.
    // =========================================================================

    // SSE requests (issue #573). All six - these five and `sseMaxStoredEvents`,
    // which #703 moved to Data & retention as the per-run storage budget it is -
    // are read once when a stream starts, so a change applies to the next
    // stream - no restart - and one run's events are all bounded by a single
    // rule rather than by whatever the setting happened to be at each arrival.
    upsert_config (keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxRetainedEvents",
    std::to_string (vayu::core::constants::sse::MAX_RETAINED_EVENTS), "integer",
    "Stream Events Retained",
    "How many of a streaming request's events are held in memory for the Events "
    "timeline. Older ones are dropped as new ones arrive, so this is how far "
    "back a long stream can be scrolled while it is running; the completed run "
    "stores its own, separate list. Each event costs roughly its own size in "
    "memory.",
    "services", std::to_string (vayu::core::constants::sse::MAX_RETAINED_EVENTS),
    std::to_string (vayu::core::constants::sse::MIN_RETAINED_EVENTS),
    std::to_string (vayu::core::constants::sse::RETAINED_EVENTS_CEILING),
    std::nullopt, now }));

    upsert_config (unit ("bytes") (
    keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxEventBytes",
    std::to_string (vayu::core::constants::sse::MAX_EVENT_BYTES), "integer",
    "Stream Event Size Limit",
    "How much of a single streamed event is kept. A larger event is held as a "
    "prefix and flagged as truncated, never silently cut - the event reports "
    "the size as received either way. This is also what bounds the parser "
    "itself, so a server that sends without a line break cannot exhaust memory.",
    "services", std::to_string (vayu::core::constants::sse::MAX_EVENT_BYTES),
    std::to_string (vayu::core::constants::sse::MIN_EVENT_BYTES),
    std::to_string (vayu::core::constants::sse::EVENT_BYTES_CEILING),
    std::nullopt, now })));

    upsert_config (unit ("ms") (
    keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxStreamDurationMs",
    std::to_string (vayu::core::constants::sse::MAX_STREAM_DURATION_MS), "integer",
    "Stream Duration Limit",
    "How long a streaming request may run before the engine ends it and says "
    "so. A stream has no content length and no promise to end, so this is the "
    "backstop that keeps one from holding a worker forever. A request may ask "
    "for a shorter limit of its own.",
    "services", std::to_string (vayu::core::constants::sse::MAX_STREAM_DURATION_MS),
    std::to_string (vayu::core::constants::sse::MIN_STREAM_DURATION_MS),
    std::to_string (vayu::core::constants::sse::STREAM_DURATION_MS_CEILING),
    std::nullopt, now })));

    upsert_config (keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxStreamEvents",
    std::to_string (vayu::core::constants::sse::MAX_STREAM_EVENTS), "integer",
    "Stream Event Limit",
    "How many events a streaming request may receive before the engine ends it "
    "and says so. The count backstop beside the time one, for a stream that "
    "talks fast rather than long. A request may ask for a lower limit of its "
    "own.",
    "services", std::to_string (vayu::core::constants::sse::MAX_STREAM_EVENTS),
    std::to_string (vayu::core::constants::sse::MIN_STREAM_EVENTS),
    std::to_string (vayu::core::constants::sse::STREAM_EVENTS_CEILING),
    std::nullopt, now }));

    upsert_config (advanced (unit ("ms") (
    keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseIdleTimeoutMs",
    std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS), "integer",
    "Stream Idle Timeout",
    "How long a stream may deliver nothing before the engine ends it. This is "
    "the one deadline a stream gets - a whole-transfer timeout would kill a "
    "healthy stream mid-flight - so it must be longer than the quietest gap "
    "the endpoint you are watching leaves between events. Enforced at whole-"
    "second resolution.",
    "services", std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS),
    std::to_string (vayu::core::constants::sse::MIN_IDLE_TIMEOUT_MS),
    std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS_CEILING),
    std::nullopt, now }))));

    // Webhook inbox. All three are read once when an inbox starts, so a change
    // applies to the next inbox started - no restart. The running listener keeps
    // what it was started with, which is what makes one inbox's captures a set
    // truncated and retained by a single rule rather than by whatever the
    // setting happened to be at each arrival.
    upsert_config (unit ("bytes") (ConfigEntry{ "inboxMaxBodyBytes",
    std::to_string (vayu::core::constants::inbox::MAX_BODY_BYTES), "integer",
    "Inbox Capture Body Limit",
    "How much of an inbound webhook body an inbox stores. A larger "
    "payload is kept as a prefix and flagged as truncated, never silently cut - "
    "the capture reports the size as received either way. Raise it for a "
    "provider that posts large documents; the transport still refuses anything "
    "over 8 MB outright, which is not a webhook.",
    "services", std::to_string (vayu::core::constants::inbox::MAX_BODY_BYTES),
    std::to_string (vayu::core::constants::inbox::MIN_BODY_BYTES),
    std::to_string (vayu::core::constants::inbox::MAX_PAYLOAD_BYTES), std::nullopt, now }));

    upsert_config (ConfigEntry{ "inboxMaxCaptures",
    std::to_string (vayu::core::constants::inbox::MAX_CAPTURES), "integer",
    "Inbox Captures Retained",
    "How many requests one inbox keeps before the oldest are dropped. Also the "
    "most a single page of the capture list may ask for. Raise it to keep a "
    "long webhook session whole; every capture is a stored row, so this and "
    "the body limit above together bound what an inbox costs on disk.",
    "services", std::to_string (vayu::core::constants::inbox::MAX_CAPTURES),
    std::to_string (vayu::core::constants::inbox::MIN_CAPTURES),
    std::to_string (vayu::core::constants::inbox::CAPTURES_CEILING), std::nullopt, now });

    upsert_config (advanced (unit ("ms") (ConfigEntry{ "inboxLivePollIntervalMs",
    std::to_string (vayu::core::constants::inbox::LIVE_POLL_INTERVAL_MS), "integer",
    "Inbox Live Poll Interval",
    "How often a watched inbox checks for newly arrived "
    "captures. This is the delay between a webhook landing and its row "
    "appearing. Lower costs a few more wakeups per second on the one thread "
    "holding that stream and nothing on the capture path itself.",
    "services", std::to_string (vayu::core::constants::inbox::LIVE_POLL_INTERVAL_MS),
    std::to_string (vayu::core::constants::inbox::MIN_LIVE_POLL_INTERVAL_MS),
    std::to_string (vayu::core::constants::inbox::MAX_LIVE_POLL_INTERVAL_MS), std::nullopt, now })));

    // Mid-run OAuth 2.0 refresh. A load run renews a header-placed access token
    // before it expires, so a run longer than its token does not turn into a
    // 401 storm. All five are read once when the run arms its watchdog, so a
    // change applies to the next run started - no restart. They sat in Network
    // & connectivity until #703, where they were five of its eight entries; a
    // user tuning token renewal arrives at Services, which is where the Dock
    // files the OAuth issuer itself.
    upsert_config (unit ("ms") (ConfigEntry{ "oauth2RefreshLeadMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS), "integer",
    "OAuth 2.0 Refresh Lead Time",
    "How far ahead of an access token's expiry a running load "
    "test renews it. Wider than the 45-second skew the token cache already "
    "applies, so the new credential is published while the old one is still "
    "accepted and no request falls in the gap. Raise it for a provider that is "
    "slow to issue tokens.",
    "services",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS),
    "1000",    // 1 second
    "3600000", // 1 hour
    std::nullopt, now }));

    upsert_config (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshMinIntervalMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS), "integer",
    "Min OAuth 2.0 Refresh Interval",
    "Floor on the wait between two mid-run renewals. A token "
    "whose whole lifetime is shorter than the lead time above is always inside "
    "its refresh window, so without this floor a run would re-acquire in a tight "
    "loop and hammer the token endpoint. Lower it only for a provider that "
    "issues very short-lived tokens.",
    "services",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS),
    "100",     // 0.1 second - a floor, never 0: that is the tight loop
    "3600000", // 1 hour
    std::nullopt, now })));

    upsert_config (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshRetryMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS), "integer",
    "OAuth 2.0 Refresh Retry Delay",
    "First wait after a mid-run renewal is refused, doubled "
    "per consecutive failure up to the ceiling below. The run keeps sending the "
    "credential it already has - a failed renewal is reported in the run's "
    "report, never fatal - so this is about recovering from a token endpoint "
    "that blipped.",
    "services",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS),
    "250", "600000", std::nullopt, now })));

    upsert_config (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshRetryMaxMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS), "integer",
    "Max OAuth 2.0 Refresh Retry Delay",
    "Ceiling on that backoff, so a token endpoint that is "
    "down for an hour costs the run a bounded number of attempts rather than "
    "one every few seconds.",
    "services",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS),
    "1000", "3600000", std::nullopt, now })));

    upsert_config (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshPollIntervalMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS),
    "integer", "OAuth 2.0 Refresh Poll Interval",
    "How often the renewal watchdog wakes while it waits, to "
    "notice that the run has ended. A finished run joins that thread before it "
    "writes its report, so this bounds how long the run's last moments take. "
    "Lower costs a few more wakeups per second on one sleeping thread and "
    "nothing on the request path.",
    "services",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS),
    "10",   // 10ms - below this the wakeups outweigh what they save
    "5000", // 5s - past this a finished run visibly waits on the join
    std::nullopt, now })));

    // =========================================================================
    // OBSERVABILITY (observability)
    // What a run measures and what the dashboard's live charts are fed: the
    // server-vitals monitor, the live-metrics topic, and the per-phase timing
    // histograms. What a run *stores* is Data & retention below - the two were
    // one category holding 24 of 48 entries until #586.
    // =========================================================================

    // Server-vitals monitor. All three are read per run - a change applies to
    // the next run started, no restart. The interval *bounds* (250-60000ms) are
    // deliberately not settings: they exist to stop a cadence that measures the
    // scraper rather than the target.
    upsert_config (unit ("ms") (keywords ({ "prometheus" }) (
    ConfigEntry{ "monitorIntervalMs",
    std::to_string (vayu::core::constants::monitor::DEFAULT_INTERVAL_MS), "integer",
    "Server Monitoring Scrape Interval",
    "How often a load test scrapes the metrics endpoint it "
    "was pointed at, when the run does not set its own interval. Each scrape is "
    "one request on the run's monitor thread, so it never delays the run's own "
    "metrics - but a cadence faster than the target's own collection interval "
    "only re-reads the same numbers. Raise it for an endpoint that is expensive "
    "to render.",
    "observability",
    std::to_string (vayu::core::constants::monitor::DEFAULT_INTERVAL_MS),
    std::to_string (vayu::core::constants::monitor::MIN_INTERVAL_MS),
    std::to_string (vayu::core::constants::monitor::MAX_INTERVAL_MS), std::nullopt, now })));

    upsert_config (keywords ({ "prometheus" }) (ConfigEntry{ "monitorMaxSeries",
    std::to_string (vayu::core::constants::monitor::MAX_SERIES), "integer",
    "Server Monitoring Metric Limit",
    "How many metric names one run may chart from its monitored endpoint. Each "
    "is a line on a single overlay and a name matched against every line of the "
    "exposition body, so the ceiling is about a readable chart rather than a "
    "hard cost. The chart has four distinct colours and repeats them past that.",
    "observability", std::to_string (vayu::core::constants::monitor::MAX_SERIES),
    "1", "64", std::nullopt, now }));

    upsert_config (advanced (unit ("ms") (keywords ({ "prometheus" }) (
    ConfigEntry{ "monitorScrapeTimeoutMs",
    std::to_string (vayu::core::constants::monitor::DEFAULT_SCRAPE_TIMEOUT_MS),
    "integer", "Server Monitoring Scrape Timeout",
    "How long one scrape of the metrics endpoint may take "
    "before it counts as a gap in the series. 0 derives the budget from the "
    "scrape interval - three quarters of it - which is what most endpoints "
    "want; set it explicitly for an exposition slow enough to fail every scrape "
    "at that budget, where the only other way out is a slower cadence that also "
    "thins the data. A value longer than the interval a run scrapes at is "
    "shortened to it, because a scrape that outlives its own cadence puts the "
    "loop behind itself.",
    "observability", std::to_string (vayu::core::constants::monitor::DEFAULT_SCRAPE_TIMEOUT_MS),
    "0", std::to_string (vayu::core::constants::monitor::MAX_INTERVAL_MS),
    std::nullopt, now }))));

    upsert_config (unit ("ms") (keywords ({ "refresh rate", "sse" }) (
    ConfigEntry{ "liveTickIntervalMs",
    std::to_string (vayu::core::constants::server::STATS_INTERVAL_MS),
    "integer", "Live Metrics Tick Interval",
    "How often the engine emits a live-metrics tick into the "
    "in-memory replay topic during a run. A lower value gives smoother live "
    "charts for slightly more CPU; the 1-second ceiling exists because slower "
    "ticks defeat live smoothness. The historical 1 Hz database sampling is "
    "unaffected.",
    "observability", std::to_string (vayu::core::constants::server::STATS_INTERVAL_MS),
    "10", "1000", std::nullopt, now })));

    upsert_config (unit ("ms") (keywords ({ "time range" }) (
    ConfigEntry{ "liveReplayWindowMs",
    std::to_string (vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
    "integer", "Live Chart Window",
    "How much recent live-metrics history to keep: the span the dashboard's live "
    "charts show, and the span the engine holds in memory per run so the "
    "dashboard can rebuild those charts when it attaches - or re-attaches - "
    "mid-run. One setting drives both, so they cannot disagree. Its editor is "
    "Settings > Dashboard > Chart window, which is where the effect is "
    "visible; this list deliberately does not offer a second one. Expressed "
    "as elapsed time "
    "rather than a tick count, so it survives a change to the tick interval. 0 "
    "means the full run (no time limit). Live Metrics Tick Ceiling is the "
    "memory backstop "
    "either way, so a fast tick interval reaches that ceiling before a long "
    "window does.",
    "observability",
    std::to_string (vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS),
    "0", "3600000", std::nullopt, now })));

    upsert_config (advanced (ConfigEntry{ "liveMaxRetainedTicks",
    std::to_string (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS),
    "integer", "Live Metrics Tick Ceiling",
    "Hard ceiling on live-metrics data points held in memory per run, on both "
    "sides - the engine's replay ring and the dashboard's chart history. It is "
    "a memory bound rather than a rendering one, since the charts bucket points "
    "before plotting, and it binds only when the chart window divided by the "
    "tick interval exceeds it - a long window at a fast tick interval, which "
    "stock settings never reach. Raise it if a long window is being cut short; "
    "each point costs roughly 1 KB.",
    "observability",
    std::to_string (vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS),
    "1000", "500000", std::nullopt, now }));

    upsert_config (unit ("ms") (ConfigEntry{ "liveRetentionMs",
    "60000",
    "integer", "Live Metrics Retention",
    "How long a finished run's in-memory live-metrics topic "
    "is kept so the dashboard can still attach and replay it. After this window "
    "the run is evicted and the dashboard falls back to the stored report. 0 "
    "disables retention, so that fallback is immediate.",
    "observability", "60000",
    "0", "600000", std::nullopt, now }));

    upsert_config (keywords ({ "ttfb", "timings" }) (ConfigEntry{ "phaseHistograms",
    vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS ? "true" : "false",
    "boolean", "Per-Phase Latency Histograms",
    "Records DNS, connect, TLS, first-byte and download times for every "
    "load-test completion, so the report gives each phase real percentiles "
    "instead of an average over the few exchanges it stores traces for. This is "
    "what answers whether a slow p99 came from the server or from connection "
    "setup. It costs five histogram writes per completion; turn it off only if "
    "a run at your throughput ceiling measurably suffers.",
    "observability",
    vayu::core::constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS ? "true" : "false",
    std::nullopt, std::nullopt, std::nullopt, now }));

    // =========================================================================
    // DATA & RETENTION (data_retention)
    // Every per-run storage budget, in one place: how much of a body is kept,
    // how many records are kept, and how long a finished run survives. The
    // words a user arrives with here are "why is my response body cut off" and
    // "keep fewer runs". #703 completed the shelf - the per-step and the
    // per-stream retention budgets were filed under Core and Services.
    // =========================================================================

    upsert_config (ConfigEntry{ "maxStoredErrors",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS),
    "integer", "Stored Error Records Per Run",
    "How many individual error records a run keeps for its report. The error "
    "total, the failed-request count, the error rate and the status-code "
    "breakdown are always exact - this bounds only the per-error detail behind "
    "the report's 'By Error Type' breakdown, which on a run with more errors "
    "than this covers the first N and will not sum to the total beside it. 0 "
    "means unlimited, which against a fully refusing target grows for the life "
    "of the run.",
    "data_retention",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS),
    "0", "10000000", std::nullopt, now });

    upsert_config (unit ("bytes") (ConfigEntry{ "maxTraceBodyBytes",
    std::to_string (vayu::core::constants::json::MAX_TRACE_BODY_BYTES), "integer",
    "Max Stored Trace Body Size",
    "Largest request or response body kept in a design run's stored "
    "trace. A larger body is truncated in the database - the response viewer "
    "says so, and re-sending fetches the full body - so one huge response does "
    "not bloat storage forever.",
    "data_retention", std::to_string (vayu::core::constants::json::MAX_TRACE_BODY_BYTES),
    "1024",       // 1KB
    "104857600",  // 100MB
    std::nullopt, now }));

    upsert_config (unit ("bytes") (ConfigEntry{ "maxSampleBodyBytes",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES),
    "integer", "Max Captured Sample Body",
    "Largest response body kept for a single captured load-run "
    "sample. Deliberately far smaller than the design-run trace limit, because "
    "a load run captures tens of exchanges nobody asked for individually. A "
    "larger body is stored truncated and marked as such.",
    "data_retention",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES),
    "0",         // 0 disables body capture while keeping headers and metadata
    "104857600", // 100MB
    std::nullopt, now }));

    upsert_config (unit ("bytes") (ConfigEntry{ "maxSampleBytes",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES),
    "integer", "Load-Run Capture Budget",
    "How much captured response-body data one load run may store. Once spent, "
    "samples keep their headers and metadata and only their bodies are "
    "dropped, and the report says how many. Captured data is stored verbatim, "
    "can contain credentials, and is deleted with the run.",
    "data_retention",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES),
    "0",          // 0 disables body capture while keeping headers and metadata
    "1073741824", // 1GB
    std::nullopt, now }));

    upsert_config (ConfigEntry{ "maxScenarioStoredSteps",
    std::to_string (vayu::core::constants::scenario::MAX_STORED_STEPS), "integer",
    "Max Stored Scenario Steps",
    "How many per-step results one collection run keeps, which bounds what a "
    "long run costs the dashboard to load. Steps that failed, errored or were "
    "skipped are kept first and successes fill the rest, so raising this buys "
    "more successful steps to look at and never a failure that was hidden - "
    "what was thinned is reported in the run summary. 0 stores every step.",
    "data_retention", std::to_string (vayu::core::constants::scenario::MAX_STORED_STEPS),
    "0", "1000000", std::nullopt, now });

    upsert_config (keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxStoredEvents",
    std::to_string (vayu::core::constants::sse::MAX_STORED_EVENTS), "integer",
    "Stream Events Stored Per Run",
    "How many events a finished streaming run keeps on disk, so reopening it "
    "from History shows the timeline again. A run that received more says so - "
    "the stored list is marked truncated and carries the true total. 0 keeps "
    "the count and no events.",
    "data_retention", std::to_string (vayu::core::constants::sse::MAX_STORED_EVENTS),
    "0", std::to_string (vayu::core::constants::sse::STORED_EVENTS_CEILING),
    std::nullopt, now }));

    upsert_config (keywords ({ "cleanup" }) (ConfigEntry{ "maxRunsRetained",
    std::to_string (vayu::core::constants::database::MAX_RUNS_RETAINED), "integer",
    "Max Runs Retained",
    "Keep at most this many most-recent runs; older runs, with their metrics "
    "and results, are pruned at startup and after each run finishes. A higher "
    "value - or 0 for unlimited - keeps more history but grows the database "
    "file on disk and slows down loading the run history. In-progress runs are "
    "never pruned.",
    "data_retention", std::to_string (vayu::core::constants::database::MAX_RUNS_RETAINED),
    "0", "100000", std::nullopt, now }));

    upsert_config (unit ("days") (keywords ({ "cleanup" }) (
    ConfigEntry{ "runRetentionDays",
    std::to_string (vayu::core::constants::database::RUN_RETENTION_DAYS), "integer",
    "Run Retention",
    "Delete runs older than this age, with their metrics and results, at "
    "startup and after each run finishes. A higher value - or 0 to keep runs "
    "forever - retains more history at the cost of a larger database file on "
    "disk. In-progress runs are never pruned.",
    "data_retention", std::to_string (vayu::core::constants::database::RUN_RETENTION_DAYS),
    "0", "3650", std::nullopt, now })));

    // =========================================================================
    // LIMITS (limits) - added by #703
    // The sizes and counts a run or a collection may not exceed. Every entry
    // here is arrived at from a rejection message that names the setting, which
    // is why they deserve one shelf instead of hiding among infrastructure -
    // and why none of them truncates: each refuses the oversized input and says
    // which knob refused it.
    // =========================================================================

    upsert_config (ConfigEntry{ "maxScenarioSteps",
    std::to_string (vayu::core::constants::scenario::MAX_STEPS), "integer",
    "Max Scenario Steps",
    "Largest number of requests one collection run may resolve to. The whole "
    "sequence is composed before the first send and held in memory for the "
    "run, and a load-mode scenario allocates a latency histogram per step, so "
    "this bounds memory rather than expressing a preference. A collection that "
    "resolves to more steps is rejected outright, never silently truncated.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_STEPS),
    "1", "10000", std::nullopt, now });

    upsert_config (ConfigEntry{ "maxScenarioDataRows",
    std::to_string (vayu::core::constants::scenario::MAX_DATA_ROWS), "integer",
    "Max Scenario Data Rows",
    "Largest data set one collection run may carry. The app parses the CSV or "
    "JSON file and sends the rows on the run payload - the engine never reads "
    "a file from disk - so this bounds how big that payload may get. A larger "
    "data set is rejected rather than truncated.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_DATA_ROWS),
    "1", "1000000", std::nullopt, now });

    upsert_config (unit ("bytes") (ConfigEntry{ "maxScenarioDataBytes",
    std::to_string (vayu::core::constants::scenario::MAX_DATA_BYTES), "integer",
    "Max Scenario Data Size",
    "Largest data set one collection run may carry, measured over its JSON. "
    "The row limit alone does not bound the payload - one row is free to hold a "
    "megabyte in a single cell - and the HTTP body cap above this would drop "
    "the connection instead of explaining itself. A larger data set is rejected "
    "with a message naming this setting.",
    "limits", std::to_string (vayu::core::constants::scenario::MAX_DATA_BYTES),
    "1024", "104857600", std::nullopt, now }));

    upsert_config (unit ("bytes") (keywords ({ "swagger" }) (
    ConfigEntry{ "maxSpecDocumentBytes",
    std::to_string (vayu::core::constants::spec_document::MAX_BYTES), "integer",
    "Max OpenAPI Document Size",
    "Largest OpenAPI document one collection may bind. The document is stored "
    "verbatim and parsed back by every feature that reads it, so this bounds "
    "both the row and that parse. A larger document is rejected with a message "
    "naming this setting, never stored truncated.",
    "limits", std::to_string (vayu::core::constants::spec_document::MAX_BYTES),
    "1024", "104857600", std::nullopt, now })));

    upsert_config (unit ("bytes") (ConfigEntry{ "maxResponseBodyBytes",
    std::to_string (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES),
    "integer", "Max Load-Test Response Body",
    "Largest response body a single load-test request will read into "
    "memory. A larger response fails that request with an error instead of "
    "being buffered, so load testing a big download or a streaming endpoint "
    "cannot exhaust memory - every in-flight request holds its own body. "
    "Design-mode sends are not affected.",
    "limits", std::to_string (vayu::core::constants::event_loop::MAX_RESPONSE_BODY_BYTES),
    "1024",       // 1KB
    "1073741824", // 1GB
    std::nullopt, now }));

    upsert_config (advanced (keywords ({ "infinite loop" }) (
    ConfigEntry{ "maxStepsPerIteration", "0", "integer", "Max Steps Per Iteration",
    "How many requests one iteration of a collection run may send before it is "
    "stopped. It exists because a script can redirect the sequence with "
    "pm.execution.setNextRequest, and two steps pointing at each other would "
    "otherwise run forever. 0 derives the limit from the collection - ten "
    "times its request count, never fewer than 100.",
    "limits", "0", "0", "1000000", std::nullopt, now })));

    // =========================================================================
    // SCRIPTING ENVIRONMENT (scripting_sandbox)
    // The QuickJS sandbox a pre- or post-request script runs in: its deadline,
    // its memory and stack, and whether console output is collected.
    // =========================================================================

    upsert_config (unit ("ms") (keywords ({ "runaway" }) (ConfigEntry{ "scriptTimeout",
    std::to_string (vayu::core::constants::script_engine::TIMEOUT_MS), "integer", "Script Execution Timeout",
    "How long a pre- or post-request script may run. A script "
    "that exceeds this is aborted and reported as an error, so an infinite loop "
    "cannot hang the engine. 0 disables the limit, which is not recommended.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::TIMEOUT_MS),
    "0", "60000", std::nullopt, now })));

    upsert_config (keywords ({ "debug", "print" }) (ConfigEntry{ "scriptEnableConsole",
    vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
    "boolean", "Enable Script Console",
    "Makes console.log() available inside scripts, with its output shown in the "
    "response viewer. Turn it off during a load test, where the writes cost "
    "throughput for output nobody reads.",
    "scripting_sandbox", vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
    std::nullopt, std::nullopt, std::nullopt, now }));

    upsert_config (unit ("bytes") (keywords ({ "ram", "oom" }) (
    ConfigEntry{ "scriptMemoryLimit",
    std::to_string (vayu::core::constants::script_engine::MEMORY_LIMIT), "integer", "Script Memory Limit",
    "Largest heap one script execution may allocate before it is aborted. Raise "
    "it only for a script that processes very large data structures.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::MEMORY_LIMIT),
    "1048576",   // 1MB
    "268435456", // 256MB
    std::nullopt, now })));

    upsert_config (advanced (unit ("bytes") (keywords ({ "recursion" }) (
    ConfigEntry{ "scriptStackSize",
    std::to_string (vayu::core::constants::script_engine::STACK_SIZE), "integer", "Script Stack Size",
    "Depth of the call stack one script execution may use. Raise it only for a "
    "script that recurses deeply enough to overflow.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::STACK_SIZE),
    "65536",   // 64KB
    "1048576", // 1MB
    std::nullopt, now }))));
    if (existing.empty ()) {
        vayu::utils::log_info ("Seeded default configuration values");
    } else {
        vayu::utils::log_info ("Updated configuration metadata for " +
        std::to_string (existing.size ()) + " existing entries");
    }
}

} // namespace vayu::db
