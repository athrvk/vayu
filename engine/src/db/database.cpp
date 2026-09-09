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
#include <array>
#include <atomic>
#include <chrono>
#include <ctime>
#include <expected>
#include <filesystem>
#include <format>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

#include "config_seeds/seed.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/reentrant.hpp"

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
        const char* str = vayu::db::column_text (stmt, columnIndex);
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
        const char* str = vayu::db::column_text (stmt, columnIndex);
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
        const char* str = vayu::db::column_text (stmt, columnIndex);
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
    make_column ("variables", &Collection::variables), // JSON: collection-scoped vars
    make_column ("auth", &Collection::auth),           // NEW: JSON auth config
    // The element list (issue #1513, run by issue #1514's pipeline): the two
    // script columns this replaced are gone from this mapping.
    // `migrate_before_sync` folds a pre-cutover row's scripts in here, ahead
    // of the `sync_schema` call that would otherwise `DROP COLUMN` them
    // first - see the note there.
    make_column ("elements", &Collection::elements, default_value (std::string ("[]"))),
    // The declared data contract (issue #599). NOT NULL with a default_value on
    // the `keywords` precedent, so sync_schema can ALTER TABLE ADD COLUMN it
    // onto an existing, non-empty collections table - every pre-existing row
    // backfills to `{}`, which is what "declares no contract" is spelled as.
    make_column ("data_schema", &Collection::data_schema, default_value (std::string ("{}"))),
    // The OpenAPI binding (issue #637). Same NOT NULL + default_value shape as
    // `data_schema` directly above, and for the same reason: sync_schema ALTERs
    // it onto an existing, non-empty collections table and every pre-existing
    // row backfills to `{}`, which is how "bound to no spec" is spelled.
    make_column ("openapi", &Collection::openapi, default_value (std::string ("{}"))),
    make_column ("order", &Collection::order),
    make_column ("created_at", &Collection::created_at),
    make_column ("updated_at", &Collection::updated_at),
    // Soft delete (issue #988): NULL is live, a stamp is the instant the
    // delete that took this row ran. Additive and nullable, which is the
    // class `sync_schema` adds without touching a stored row.
    make_column ("deleted_at", &Collection::deleted_at)),

    // Requests: HTTP request definitions with pre/post scripts
    make_table ("requests", make_column ("id", &Request::id, primary_key ()),
    make_column ("collection_id", &Request::collection_id),
    make_column ("name", &Request::name),
    make_column ("description", &Request::description), // NEW: request description
    make_column ("method", &Request::method),
    // Which app setting set `method`, still unclaimed by the user (issue
    // #1505). Nullable on the `spec_operation` precedent below - ALTER-friendly
    // without a default, and NULL is the only spelling of "no marker".
    make_column ("method_source", &Request::method_source),
    make_column ("url", &Request::url), make_column ("params", &Request::params), // JSON array of KeyValueEntry
    make_column ("headers", &Request::headers), // JSON array of KeyValueEntry
    make_column ("body", &Request::body),       // JSON discriminated union
    make_column ("body_type", &Request::body_type), make_column ("auth", &Request::auth), // JSON
    // The element list (issue #1513, run by issue #1514's pipeline) - see the
    // `collections` table above for why the two script columns this replaced
    // are gone from this mapping.
    make_column ("elements", &Request::elements, default_value (std::string ("[]"))),
    make_column ("order", &Request::order), // NEW: position within collection
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
    make_column ("updated_at", &Request::updated_at),
    // Soft delete (issue #988) - see the collections column above.
    make_column ("deleted_at", &Request::deleted_at)),

    // Request examples: saved example responses for a request (issue #481).
    // Created by import today, and the response source a mock server serves
    // from. sync_schema() creates the table outright, so no migration.
    make_table ("request_examples", make_column ("id", &RequestExample::id, primary_key ()),
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
    // The key of the 3.x response `examples` map entry this example was
    // imported from (issue #1457). Nullable rather than NOT NULL with a
    // default, on the `requests.spec_operation` precedent above: nothing to
    // backfill a pre-existing row from, and NULL is the only spelling of "no
    // key".
    make_column ("spec_example_key", &RequestExample::spec_example_key),
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
    // The engine-derived operation index (issue #629, #853). NOT NULL + default_value
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
    make_column ("variables", &Environment::variables), // JSON: {key: {value, enabled}}
    make_column ("is_active", &Environment::is_active),
    make_column ("created_at", &Environment::created_at),
    make_column ("updated_at", &Environment::updated_at)),

    // ─────────────── EXECUTION ENGINE TABLES ───────────────

    // Runs: Test execution sessions (load tests or design mode requests)
    make_table ("runs", make_column ("id", &Run::id, primary_key ()),
    make_column ("request_id", &Run::request_id),
    make_column ("environment_id", &Run::environment_id),
    make_column ("type", &Run::type),     // "design", "load" or "scenario"
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
    make_column ("baseline", &Run::baseline, default_value (false)),
    // Whether `summary` carries warnings; see Run::has_warnings. Same
    // ADD-COLUMN-onto-an-existing-table shape as `baseline` above.
    make_column ("has_warnings", &Run::has_warnings, default_value (false))),

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
    make_table ("body_blobs",
    make_column ("id", &BodyBlob::id, primary_key ().autoincrement ()),
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
    make_column ("requires_restart", &ConfigEntry::requires_restart, default_value (false)),
    make_column ("advanced", &ConfigEntry::advanced, default_value (false)),
    // JSON array of search terms, "[]" when the entry declares none - the
    // same ALTER-friendly shape, and a column that is never null so the
    // serializer has no absent case to invent an array for.
    make_column ("keywords", &ConfigEntry::keywords, default_value (std::string ("[]"))),
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
    make_column ("key_path", &ClientCertificate::key_path), // "" for PKCS#12
    // What the certificate file holds (issue #833). NOT NULL with a
    // default_value on the `http_version` precedent, so sync_schema can ALTER
    // TABLE ADD COLUMN it onto a registry written before the field existed -
    // and every such row backfills to `pem`, which is exactly what it is: the
    // format libcurl read by default when nothing named one.
    make_column ("cert_format", &ClientCertificate::cert_format, default_value ("pem")),
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

    /// Whether a workspace backup is being written right now (issue #987).
    /// `Database::BackupSlot` is the only thing that touches it; see the note
    /// there for why a second backup is refused rather than queued. Atomic
    /// because the slot is deliberately taken *outside* the DB mutex - a
    /// `VACUUM INTO` of a large workspace must not stall every other endpoint.
    std::atomic<bool> backup_running{ false };

    /// The file `storage` was opened on, for `Database::path`. Named for the
    /// file rather than `db_path`, which the constructor below already uses for
    /// the parsed `std::filesystem::path` - MSVC builds this /W4 /WX and a
    /// shadowed member is C4458, an error here.
    std::string opened_file;

    Impl (const std::string& path)
    : storage (make_storage (path)), opened_file (path) {
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
                "db", "Failed to set cache_size: " + std::string (err_msg));
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
                "db", "Failed to set temp_store: " + std::string (err_msg));
                sqlite3_free (err_msg);
                err_msg = nullptr;
            }
            sql.str ("");

            sql << "PRAGMA mmap_size = " << mmap_size << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning (
                "db", "Failed to set mmap_size: " + std::string (err_msg));
                sqlite3_free (err_msg);
                err_msg = nullptr;
            }
            sql.str ("");

            sql << "PRAGMA wal_autocheckpoint = " << wal_checkpoint << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning ("db",
                "Failed to set wal_autocheckpoint: " + std::string (err_msg));
                sqlite3_free (err_msg);
            }
        };

        // Durability, applied here rather than in `Database::init` - which is
        // where it used to be applied *only* (issue #838).
        //
        // Everything before `init` runs on whatever SQLite defaults to, and
        // SQLite defaults to a rollback journal at `synchronous=FULL`. That
        // covered the two `sync_schema` passes the constructor makes and the
        // ~66 separate commits `seed_default_config` used to write, so every
        // database this engine has ever opened paid a full fsync barrier per
        // statement for the whole of its startup, at settings its own
        // `dbSynchronous` entry says should be `OFF`. Nothing chose that; it
        // was the gap between opening the file and reading the row that says
        // how to open it.
        //
        // The compile-time constant is used because the configured value lives
        // in a table this connection has not created yet. `init` re-applies
        // whatever `dbSynchronous` holds once it can read it, so a user who
        // raised the setting still gets it for the process's whole working
        // life - only the schema sync and the seed run at the default, and
        // the constructor takes a `.bak` copy of the previous file before
        // either of them touches it.
        //
        // Set through `storage.pragma` rather than the callback above because
        // sqlite_orm remembers these two and re-applies them to every
        // connection it opens - which is exactly why `cache_size`, which it
        // does not remember, is in the callback instead.
        storage.pragma.journal_mode (journal_mode::WAL);
        storage.pragma.synchronous (vayu::core::constants::database::SYNCHRONOUS);
    }
};

namespace {

namespace fs = std::filesystem;

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

bool is_blank_script_text (const std::string& text) {
    return text.find_first_not_of (" \t\r\n") == std::string::npos;
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
    if (!is_blank_script_text (pre) && !has_kind ("script.pre")) {
        elements.push_back (
        { { "id", vayu::utils::generate_id ("el_") }, { "kind", "script.pre" },
        { "enabled", true }, { "config", { { "script", pre } } } });
        changed = true;
    }
    if (!is_blank_script_text (post) && !has_kind ("script.post")) {
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

} // namespace

Database::Database (const std::string& db_path) {
    // Refused outright, before anything else - a database written by a newer
    // engine is not corrupt, and letting it fall into the recovery branch
    // below would quarantine a perfectly good (newer) file and silently start
    // a fresh, empty one in its place: exactly the data loss issue #1514's
    // version gate exists to prevent. This call is deliberately not inside
    // `probe_database`'s try/catch: the exception must reach the daemon's own
    // startup failure path, naming both versions, rather than being read here
    // as "will not open" and handed to recovery.
    migrate_before_sync (db_path);

    fs::path db_file (db_path);
    fs::path backup_file = db_file;
    backup_file += ".bak";

    // Whether the database at `path` opens and carries this build's schema.
    //
    // The same probe answers for the main file and for the `.bak` beside it
    // (issue #984): the backup used to be restored on the strength of its
    // existence alone - "we assume the backup itself is valid" - so a torn copy
    // was written over the only other copy of the user's data. An
    // `integrity_check` pragma would answer a narrower question (pages, not
    // schema) and would not answer the one that matters here, which is whether
    // *this engine* can open the file it is about to commit to.
    auto probe_database = [] (const std::string& path) {
        try {
            // Ahead of `Impl`'s own construction, never after: `Impl`'s
            // constructor already opens a connection and sets
            // `journal_mode`, and `sync_schema ()` below is what would
            // `DROP COLUMN` the pre-cutover script columns before this
            // migration ever got to read them (issue #1514).
            migrate_before_sync (path);
            Impl probe (path);
            probe.storage.sync_schema ();
            return true;
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "db", "Database validation failed for " + path + ": " + e.what ());
            return false;
        }
    };

    // 1. Validate current database
    if (has_sqlite_header (db_file) && probe_database (db_path)) {
        // 2. The database is valid. Update the backup for *next* time - only
        // ever from a database that validated, so a bad one cannot overwrite a
        // good backup.
        vayu::utils::log_debug ("db", "Database validation successful. Updating backup...");
        copy_db_files (db_file, backup_file);
    } else {
        recover_database (db_file, backup_file, db_path, probe_database);
    }

    // 3. Final Initialization
    // At this point, we either have a valid original, a restored backup, or a fresh/corrupted file we must attempt to use.
    // Idempotent by this point in every reachable case (the branch above
    // already migrated whichever file `db_path` now holds), kept here too as
    // the same defence in depth every `sync_schema ()` call gets.
    migrate_before_sync (db_path);
    impl_ = std::make_unique<Impl> (db_path);
    // sync_schema might throw if restore failed or backup was also bad
    impl_->storage.sync_schema ();

    // 4. The recovery record this process reports. Read from the file rather
    // than kept from the branch above, so a marker written by an *earlier*
    // engine run that nothing polled still reaches a client - that survival is
    // the whole reason the fact is on disk instead of in a member.
    recovery_ = read_recovery_marker (db_path);
}

Database::~Database () = default;

const std::string& Database::path () const {
    return impl_->opened_file;
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

// ============================================================================
// Collections - Folder structure for organizing requests
// ============================================================================

void Database::create_collection (const Collection& c) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Creating collection", { { "id", c.id }, { "name", c.name } });
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
    //
    // Deleted rows are excluded here rather than at each caller (issue #988):
    // this is what the sidebar, the MCP tools, every export and every plan
    // resolution read, and a filter one of them forgot is a ghost row
    // resurfacing in exactly one place.
    return impl_->storage.get_all<Collection> (where (is_null (&Collection::deleted_at)),
    multi_order_by (order_by (&Collection::order),
    order_by (&Collection::created_at), order_by (&Collection::id)));
}

std::optional<Collection> Database::get_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto cols = impl_->storage.get_all<Collection> (
    where (c (&Collection::id) == id && is_null (&Collection::deleted_at)));
    if (cols.empty ())
        return std::nullopt;
    return cols.front ();
}

std::vector<std::string> Database::collection_subtree_locked (const std::string& root_id) {
    std::vector<std::string> subtree;
    std::unordered_set<std::string> visited;
    subtree.push_back (root_id);
    visited.insert (root_id);
    size_t idx = 0;
    while (idx < subtree.size ()) {
        auto children = impl_->storage.get_all<Collection> (
        where (c (&Collection::parent_id) == subtree[idx]));
        for (const auto& child : children) {
            if (visited.insert (child.id).second) {
                subtree.push_back (child.id);
            }
        }
        ++idx;
    }
    return subtree;
}

void Database::purge_collection_locked (const std::string& id) {
    const auto subtree = collection_subtree_locked (id);

    // Deepest-first so foreign-key integrity holds at each step, wrapped in a
    // single transaction so a crash mid-cascade cannot leave a half-deleted
    // subtree. Safe under the recursive mutex already held - the lambda only
    // calls sqlite_orm on the same storage handle (same pattern as
    // add_results_batch).
    impl_->storage.transaction ([&] {
        for (auto it = subtree.rbegin (); it != subtree.rend (); ++it) {
            // Examples first, and by request id rather than by collection: they
            // hang off the request, so deleting the requests before them would
            // leave rows no read can reach and no later delete can find.
            for (const auto& r : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == *it))) {
                impl_->storage.remove_all<RequestExample> (
                where (c (&RequestExample::request_id) == r.id));
            }
            impl_->storage.remove_all<Request> (
            where (c (&Request::collection_id) == *it));
            impl_->storage.remove_all<Collection> (where (c (&Collection::id) == *it));
        }
        return true; // Commit
    });

    // The cascade above is deliberately not a cascade *to* the document a
    // purged collection was bound to - several collections may bind one, so the
    // binding going away is not the document going away. It is the moment to
    // ask whether anything still holds it, though, and that is what the sweep
    // answers (issue #718). Outside the transaction: the subtree is gone either
    // way, and this must not be able to roll it back. Never throws; see the
    // declaration.
    sweep_orphaned_spec_documents ();
}

void Database::purge_request_locked (const std::string& id) {
    impl_->storage.transaction ([&] {
        impl_->storage.remove_all<RequestExample> (
        where (c (&RequestExample::request_id) == id));
        impl_->storage.remove_all<Request> (where (c (&Request::id) == id));
        return true; // Commit
    });
}

// Soft delete (issue #988): the subtree is stamped, not removed. Every read
// filters the stamp out, so the tree the user sees is the same tree a hard
// cascade left - but `GET /trash` can still find it, `POST /trash/:id/restore`
// can put it back, and only a purge (explicit, or retention at startup) is
// what finally destroys it.
void Database::delete_collection (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting collection (soft, cascade)", { { "id", id } });

    const auto subtree = collection_subtree_locked (id);

    // The stamp is this delete's cohort key, and a cohort has to be
    // distinguishable from an *earlier* delete inside the same subtree - that
    // is what stops restoring a collection from also resurrecting a request the
    // user deleted separately beforehand. Sharing a millisecond with such a row
    // would erase the distinction, so the one case where it can happen is
    // stepped over rather than left to chance.
    int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                    .count ();
    const auto collides_with_an_earlier_delete = [&] (int64_t candidate) {
        for (const auto& collection_id : subtree) {
            if (impl_->storage.count<Collection> (where (c (&Collection::id) == collection_id &&
                c (&Collection::deleted_at) == candidate)) > 0) {
                return true;
            }
            if (impl_->storage.count<Request> (where (c (&Request::collection_id) == collection_id &&
                c (&Request::deleted_at) == candidate)) > 0) {
                return true;
            }
        }
        return false;
    };
    while (collides_with_an_earlier_delete (stamp)) {
        ++stamp;
    }

    // Only rows that are still live are stamped. A row an earlier delete
    // already took keeps that delete's stamp, so restoring this collection
    // leaves it in the trash - as its own root, since its owner is live again.
    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& request : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == collection_id &&
                 is_null (&Request::deleted_at)))) {
                request.deleted_at = stamp;
                impl_->storage.update (request);
            }
            for (auto& collection : impl_->storage.get_all<Collection> (where (
                 c (&Collection::id) == collection_id && is_null (&Collection::deleted_at)))) {
                collection.deleted_at = stamp;
                impl_->storage.update (collection);
            }
        }
        return true; // Commit
    });

    // No spec-document sweep here, deliberately: a stamped collection still
    // binds its document, and reclaiming it now would leave a restore pointing
    // at a document that is gone. The sweep runs on the purge instead.
}

// ============================================================================
// Requests - HTTP request definitions with pre/post scripts
// ============================================================================

void Database::save_request (const Request& r) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Saving request", { { "id", r.id }, { "name", r.name } });
    impl_->storage.replace (r);
}

std::optional<Request> Database::get_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto requests = impl_->storage.get_all<Request> (
    where (c (&Request::id) == id && is_null (&Request::deleted_at)));
    if (requests.empty ())
        return std::nullopt;
    return requests.front ();
}

std::vector<Request> Database::get_requests_in_collection (const std::string& collection_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Same three-key tie rule as get_collections - see the comment there for why
    // the implicit rowid cannot be the tiebreak. Deleted rows are excluded on
    // the same reasoning too (issue #988); a deleted *collection* answers with
    // nothing at all, because every caller reaches this through a
    // `get_collection` that already refused.
    return impl_->storage.get_all<Request> (
    where (c (&Request::collection_id) == collection_id && is_null (&Request::deleted_at)),
    multi_order_by (order_by (&Request::order), order_by (&Request::created_at),
    order_by (&Request::id)));
}

// Soft delete (issue #988): the row is stamped, not removed. Its examples stay
// where they are - every read of them is by request id and goes through a
// request this stamp has made unreadable, so they are as gone as the request
// is, and a restore that had to re-create them could not.
void Database::delete_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting request (soft)", { { "id", id } });
    const int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                          .count ();
    impl_->storage.transaction ([&] {
        for (auto& request : impl_->storage.get_all<Request> (
             where (c (&Request::id) == id && is_null (&Request::deleted_at)))) {
            request.deleted_at = stamp;
            impl_->storage.update (request);
        }
        return true; // Commit
    });
}

// ============================================================================
// Trash - the rows soft delete stamped, and the three things one can do with
// them: look at them, put them back, destroy them (issue #988)
// ============================================================================

std::optional<TrashEntry> Database::trash_entry_locked (const std::string& id) {
    constexpr const char* STAMPED =
    "a row read under is_not_null(deleted_at) carries a stamp";

    auto collections = impl_->storage.get_all<Collection> (
    where (c (&Collection::id) == id && is_not_null (&Collection::deleted_at)));
    if (!collections.empty ()) {
        const auto& collection = collections.front ();
        const int64_t stamp = vayu::utils::invariant_value (collection.deleted_at, STAMPED);
        TrashEntry entry{ collection.id, "collection", collection.name, stamp,
            collection.parent_id, 0, 0 };
        // The counts are the *cohort's*, not the subtree's: what this delete
        // took is what restoring it puts back, and a row an earlier delete
        // already held is neither.
        for (const auto& descendant_id : collection_subtree_locked (collection.id)) {
            if (descendant_id != collection.id) {
                entry.collections += impl_->storage.count<Collection> (
                where (c (&Collection::id) == descendant_id &&
                c (&Collection::deleted_at) == stamp));
            }
            entry.requests += impl_->storage.count<Request> (
            where (c (&Request::collection_id) == descendant_id &&
            c (&Request::deleted_at) == stamp));
        }
        return entry;
    }

    auto requests = impl_->storage.get_all<Request> (
    where (c (&Request::id) == id && is_not_null (&Request::deleted_at)));
    if (!requests.empty ()) {
        const auto& request = requests.front ();
        return TrashEntry{ request.id, "request", request.name,
            vayu::utils::invariant_value (request.deleted_at, STAMPED),
            request.collection_id, 0, 0 };
    }
    return std::nullopt;
}

std::vector<TrashEntry> Database::get_trash () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // "Is this row's owner deleted too?" is asked once per candidate, so the
    // owning table is read once here rather than once per question.
    std::unordered_map<std::string, bool> collection_is_deleted;
    for (const auto& [id, deleted_at] :
    impl_->storage.select (columns (&Collection::id, &Collection::deleted_at))) {
        collection_is_deleted[id] = deleted_at.has_value ();
    }
    // A row whose owner is missing entirely is a root as much as one whose owner
    // is live: there is nothing above it that a restore could come back under.
    const auto owner_is_deleted = [&] (const std::string& owner_id) {
        const auto it = collection_is_deleted.find (owner_id);
        return it != collection_is_deleted.end () && it->second;
    };
    const auto push_root = [&] (std::vector<TrashEntry>& into, const std::string& id) {
        if (auto entry = trash_entry_locked (id)) {
            into.push_back (std::move (*entry));
        }
    };

    std::vector<TrashEntry> entries;
    for (const auto& collection : impl_->storage.get_all<Collection> (
         where (is_not_null (&Collection::deleted_at)))) {
        if (collection.parent_id.has_value () && owner_is_deleted (*collection.parent_id)) {
            continue; // A cascade took it; its root is further up.
        }
        push_root (entries, collection.id);
    }
    for (const auto& request :
    impl_->storage.get_all<Request> (where (is_not_null (&Request::deleted_at)))) {
        if (owner_is_deleted (request.collection_id)) {
            continue;
        }
        push_root (entries, request.id);
    }

    // Newest first - what a trash view shows at the top - with `id` as the
    // tiebreak so a page of same-millisecond deletes is a total order rather
    // than whatever the two table scans happened to produce.
    std::sort (entries.begin (), entries.end (),
    [] (const TrashEntry& a, const TrashEntry& b) {
        return a.deleted_at != b.deleted_at ? a.deleted_at > b.deleted_at :
                                              a.id < b.id;
    });
    return entries;
}

bool Database::owner_is_absent_locked (const std::optional<std::string>& owner_id) {
    if (!owner_id.has_value ()) {
        return false; // The tree root is not a missing owner.
    }
    auto owners =
    impl_->storage.get_all<Collection> (where (c (&Collection::id) == *owner_id));
    return owners.empty () || owners.front ().deleted_at.has_value ();
}

std::expected<TrashOutcome, RestoreFailure> Database::restore_request_locked (
const TrashEntry& entry) {
    // A request has no root to come back to: `collection_id` is NOT NULL, so
    // "re-parent to the tree root" - what a collection does - is not a shape
    // this row has. Its owner going away is only reachable by deleting the
    // collection after the request, and the answer is the restore that *does*
    // work, named rather than guessed at.
    if (owner_is_absent_locked (entry.parent_id)) {
        const bool gone = !entry.parent_id.has_value () ||
        impl_->storage.count<Collection> (
        where (c (&Collection::id) == *entry.parent_id)) == 0;
        return std::unexpected (RestoreFailure{ RestoreRefusal::OwnerGone,
        "Request '" + entry.id + "' cannot be restored on its own - the collection it belongs to is " +
        (gone ? "gone" : "in the trash, so restore that first") });
    }

    impl_->storage.transaction ([&] {
        for (auto& request : impl_->storage.get_all<Request> (where (
             c (&Request::id) == entry.id && c (&Request::deleted_at) == entry.deleted_at))) {
            request.deleted_at.reset ();
            // A row trashed before the startup pass ever reached it (issue
            // #1491: trash is skipped there) gets the same disable-and-mark
            // treatment on the way back, rather than coming back exactly as
            // it went in.
            if (auto rewritten =
                vayu::http::strip_legacy_managed_headers (request.headers)) {
                request.headers = std::move (*rewritten);
            }
            impl_->storage.update (request);
        }
        return true; // Commit
    });
    vayu::utils::log_info ("db", "Restored request from trash", { { "id", entry.id } });
    return TrashOutcome{ entry, false };
}

TrashOutcome Database::restore_collection_locked (const TrashEntry& entry) {
    const auto subtree = collection_subtree_locked (entry.id);
    // Only the root can be orphaned: every other row in this walk has a parent
    // inside the same subtree, restored with it. Decided before the write so
    // the transaction below stays one pass over the cohort.
    const bool reparented = owner_is_absent_locked (entry.parent_id);

    impl_->storage.transaction ([&] {
        for (const auto& collection_id : subtree) {
            for (auto& request : impl_->storage.get_all<Request> (
                 where (c (&Request::collection_id) == collection_id &&
                 c (&Request::deleted_at) == entry.deleted_at))) {
                request.deleted_at.reset ();
                // See the same call in `restore_request_locked`: a row
                // trashed before the startup pass ever reached it comes back
                // through the same disable-and-mark treatment.
                if (auto rewritten =
                    vayu::http::strip_legacy_managed_headers (request.headers)) {
                    request.headers = std::move (*rewritten);
                }
                impl_->storage.update (request);
            }
            for (auto& collection : impl_->storage.get_all<Collection> (
                 where (c (&Collection::id) == collection_id &&
                 c (&Collection::deleted_at) == entry.deleted_at))) {
                collection.deleted_at.reset ();
                if (reparented && collection.id == entry.id) {
                    collection.parent_id.reset ();
                }
                impl_->storage.update (collection);
            }
        }
        return true; // Commit
    });

    vayu::utils::log_info ("db", "Restored collection from trash",
    { { "id", entry.id }, { "subCollections", entry.collections },
    { "requests", entry.requests }, { "reparented", reparented } });
    return TrashOutcome{ entry, reparented };
}

std::expected<TrashOutcome, RestoreFailure> Database::restore_deleted (
const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // By id, not by root: a row a cascade took is restorable on its own - that
    // is what the re-parent rule is for - and only a row that is not deleted at
    // all is a 404.
    auto entry = trash_entry_locked (id);
    if (!entry) {
        return std::unexpected (RestoreFailure{
        RestoreRefusal::NotFound, "Nothing in the trash with id '" + id + "'" });
    }
    return entry->kind == "request" ?
    restore_request_locked (*entry) :
    std::expected<TrashOutcome, RestoreFailure>{ restore_collection_locked (*entry) };
}

std::optional<TrashOutcome> Database::purge_deleted (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    auto entry = trash_entry_locked (id);
    if (!entry) {
        return std::nullopt;
    }
    // The purge takes the whole subtree, stamp or no stamp - a row left under a
    // removed collection is reachable by no read and restorable by nothing, so
    // "the cohort" is the wrong unit here even though it is the right one for a
    // restore.
    if (entry->kind == "collection") {
        purge_collection_locked (id);
    } else {
        purge_request_locked (id);
    }
    vayu::utils::log_info (
    "db", "Purged item from trash", { { "kind", entry->kind }, { "id", id } });
    return TrashOutcome{ std::move (*entry), false };
}

int64_t Database::purge_expired_trash (int retention_days, int64_t now) {
    if (retention_days <= 0) {
        return 0; // Keep forever - the reading `runRetentionDays` gives 0.
    }
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    const int64_t cutoff =
    now - (static_cast<int64_t> (retention_days) * 24 * 60 * 60 * 1000);
    std::vector<std::pair<std::string, std::string>> expired; // (kind, id)
    for (const auto& entry : get_trash ()) {
        if (entry.deleted_at <= cutoff) {
            expired.emplace_back (entry.kind, entry.id);
        }
    }

    int64_t purged = 0;
    for (const auto& [kind, id] : expired) {
        // A root purged as part of an ancestor's subtree is already gone. It
        // cannot happen to a *root* by construction, but the walk below is what
        // says so rather than assuming it.
        if (kind == "collection") {
            if (impl_->storage.count<Collection> (where (c (&Collection::id) == id)) == 0) {
                continue;
            }
            purge_collection_locked (id);
        } else {
            if (impl_->storage.count<Request> (where (c (&Request::id) == id)) == 0) {
                continue;
            }
            purge_request_locked (id);
        }
        ++purged;
    }
    if (purged > 0) {
        vayu::utils::log_info ("db",
        "Purged " + std::to_string (purged) + " item(s) deleted more than " +
        std::to_string (retention_days) + " day(s) ago");
    }
    return purged;
}

int64_t Database::purge_expired_trash_configured () {
    const int retention_days = get_config_int (
    "trashRetentionDays", vayu::core::constants::database::TRASH_RETENTION_DAYS);
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    return purge_expired_trash (retention_days, now);
}

// ============================================================================
// Request examples - saved example responses owned by a request (issue #481)
// ============================================================================

void Database::save_request_example (const RequestExample& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving request example",
    { { "id", e.id }, { "requestId", e.request_id } });
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
    auto rows = impl_->storage.get_all<RequestExample> (where (
    c (&RequestExample::id) == id and c (&RequestExample::suppressed) == false));
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
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == false),
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
std::vector<RequestExample> Database::get_suppressed_request_examples (
const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == true));
}

int64_t Database::count_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Tombstones do not count against `MAX_PER_REQUEST`: a user who deletes an
    // imported example has fewer examples, not the same number with one hidden.
    return impl_->storage.count<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == false));
}

void Database::delete_request_example (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting request example", { { "id", id } });
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
    vayu::utils::log_debug ("db", "Suppressing imported request example", { { "id", id } });
    auto rows =
    impl_->storage.get_all<RequestExample> (where (c (&RequestExample::id) == id));
    if (rows.empty ()) {
        return;
    }
    RequestExample row = rows.front ();
    row.suppressed     = true;
    row.body           = "";
    row.headers        = "";
    row.content_type   = "";
    row.body_truncated = false;
    row.updated_at     = now;
    impl_->storage.replace (row);
}

// ============================================================================
// Spec documents (issue #637)
// ============================================================================

void Database::save_spec_document (const SpecDocument& s) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Saving spec document", { { "id", s.id }, { "hash", s.hash } });
    impl_->storage.replace (s);
}

std::optional<SpecDocument> Database::get_spec_document (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows =
    impl_->storage.get_all<SpecDocument> (where (c (&SpecDocument::id) == id));
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
    //
    // Deleted collections are excluded (issue #988): this backs the "N
    // collections still bind this document" refusal and the list beside it,
    // and a collection in the trash is not something a user can act on. The
    // *sweep* deliberately reads the unfiltered table instead - see there.
    for (auto& col :
    impl_->storage.get_all<Collection> (where (is_null (&Collection::deleted_at)))) {
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
    vayu::utils::log_debug ("db", "Deleting spec document", { { "id", id } });
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
        //
        //    Unfiltered by `deleted_at`, unlike that reader (issue #988): a
        //    collection in the trash still binds its document, and reclaiming
        //    the document now would leave the restore pointing at nothing.
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

        vayu::utils::log_info ("db",
        "Swept " + std::to_string (candidates.size ()) +
        " OpenAPI document(s) no collection binds and no retained run names");
        return candidates.size ();
    } catch (const std::exception& e) {
        // Best-effort by contract - see the header for why a caller must not
        // fail over this.
        vayu::utils::log_warning (
        "db", "OpenAPI document sweep failed: " + std::string (e.what ()));
        return 0;
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

    vayu::utils::log_debug ("db",
    "Applying import: " + std::to_string (collections.size ()) +
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

    vayu::utils::log_debug ("db",
    "Applying reorder: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests");

    retry_on_busy ("apply reorder", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            // A deleted row does not exist to this batch (issue #988): the
            // caller is repositioning the tree it can see, and writing the row
            // it named would both resurrect it - `update` carries the caller's
            // whole struct, `deleted_at` included - and move something nobody
            // is looking at.
            for (const auto& row : collections) {
                if (impl_->storage.count<Collection> (where (
                    c (&Collection::id) == row.id && is_null (&Collection::deleted_at))) == 0) {
                    throw MissingRowError ("Collection", row.id);
                }
                impl_->storage.update (row);
            }
            for (const auto& row : requests) {
                if (impl_->storage.count<Request> (where (
                    c (&Request::id) == row.id && is_null (&Request::deleted_at))) == 0) {
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
void Database::verify_spec_sync_rows_locked (const SpecSyncBatch& batch) {
    // Deleted rows are absent here too - same rule as `apply_reorder`, and the
    // same reason: an `update` carrying the caller's struct would clear the
    // stamp along with everything else (issue #988).
    if (impl_->storage.count<Collection> (where (
        c (&Collection::id) == batch.binding.id && is_null (&Collection::deleted_at))) == 0) {
        throw MissingRowError ("Collection", batch.binding.id);
    }
    for (const auto& row : batch.updated) {
        if (impl_->storage.count<Request> (where (
            c (&Request::id) == row.id && is_null (&Request::deleted_at))) == 0) {
            throw MissingRowError ("Request", row.id);
        }
    }
}

void Database::write_spec_sync_batch_locked (const SpecSyncBatch& batch) {
    // These deletes are **hard**, and stay hard now that every delete a person
    // makes is soft (issues #988, #1046 - owner decision). A sync is a
    // reconciliation to a document, not somebody removing a request, and it is
    // the one delete path whose removals are shown before they land: `POST
    // /specs/diff` reports each one, the app renders them as ticks to untick,
    // and `policy: "safe"` refuses deletions outright. Stamping them would fill
    // the trash with operations a document dropped, where restoring one puts
    // back a request the current document cannot explain. A caller that wants
    // them recoverable omits them here and calls `DELETE /requests/:id`.
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
}

void Database::spec_sync_apply (const SpecSyncBatch& batch) {
    // "spec write" rather than "sync": `POST /specs/bind` commits through this
    // same batch (issue #862), with its create and delete halves empty.
    vayu::utils::log_debug ("db", "Applying spec write",
    { { "collection", batch.binding.id }, { "spec", batch.spec.id },
    { "created", batch.created.size () }, { "updated", batch.updated.size () },
    { "deleted", batch.deleted.size () },
    { "newCollections", batch.new_collections.size () } });

    retry_on_busy ("apply spec sync", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            verify_spec_sync_rows_locked (batch);
            write_spec_sync_batch_locked (batch);
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
    vayu::utils::log_debug ("db", "Saving environment",
    { { "id", e.id }, { "name", e.name }, { "isActive", e.is_active } });
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
    vayu::utils::log_debug ("db", "Deleting environment", { { "id", id } });
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
    vayu::utils::log_debug (
    "db", "Saving client certificate", { { "id", c.id }, { "host", c.host } });
    impl_->storage.replace (c);
}

std::vector<ClientCertificate> Database::get_client_certificates () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ClientCertificate> ();
}

std::optional<ClientCertificate> Database::get_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<ClientCertificate> (
    where (c (&ClientCertificate::id) == id));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

void Database::delete_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting client certificate", { { "id", id } });
    impl_->storage.remove_all<ClientCertificate> (where (c (&ClientCertificate::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals (const Globals& g) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving globals");
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
    impl_->storage.remove_all<OAuthToken> (where (c (&OAuthToken::cache_key) == cache_key));
}

// ============================================================================
// Runs - Test execution sessions (load tests or design mode requests)
// ============================================================================

void Database::create_run (const Run& run) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Creating run",
    { { "id", run.id }, { "type", std::string (vayu::to_string (run.type)) } });
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
    vayu::utils::log_debug ("db", "Updating run status",
    { { "id", id }, { "status", std::string (vayu::to_string (status)) } });
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
    vayu::utils::log_debug ("db", "Updating run end_time", { { "id", id } });
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

    const RunType type_val     = filter.type.value_or (RunType::Design);
    const RunStatus status_val = filter.status.value_or (RunStatus::Pending);
    const std::string req_val  = filter.request_id.value_or ("");
    const std::string q_pat = "%" + (filter.q ? *filter.q : std::string{}) + "%";
    const std::string collection_val = filter.collection_id.value_or ("");
    const bool baseline_val          = filter.baseline.value_or (false);

    // The snapshot when it is JSON, an empty object when it is not - the guard
    // described above, so json_extract below is always handed valid JSON.
    const auto snapshot_json =
    case_<std::string> ()
    .when (json_valid (&Run::config_snapshot), then (&Run::config_snapshot))
    .else_ (std::string{ "{}" })
    .end ();

    return where ((c (&Run::type) == type_val || no_type) &&
    (c (&Run::status) == status_val || no_status) &&
    (c (&Run::request_id) == req_val || no_req) &&
    (like (&Run::config_snapshot, q_pat) || no_q) &&
    (c (&Run::baseline) == baseline_val || no_baseline) &&
    (json_extract<std::string> (snapshot_json, std::string{ "$.scenario.collectionId" }) == collection_val ||
    no_collection));
}
} // namespace

std::vector<Run>
Database::get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset) {
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
            "db", "Run summary write skipped, run not found: " + id);
            return;
        }
        run->summary = summary;
        // Derived here, from the same bytes about to be stored, rather than
        // taken as a second parameter every caller would have to keep in sync
        // by hand (issue #1527). A summary that fails to parse or carries no
        // `warnings` array leaves the flag false.
        const auto parsed =
        nlohmann::json::parse (summary, nullptr, /*allow_exceptions=*/false);
        run->has_warnings = parsed.is_object () && parsed.contains ("warnings") &&
        parsed["warnings"].is_array () && !parsed["warnings"].empty ();
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
        const int64_t age_cutoff = max_age_days > 0 ?
        now - (static_cast<int64_t> (max_age_days) * 86'400'000LL) :
        0;

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

    vayu::utils::log_info ("db", "Pruned old runs",
    { { "count", victims.size () }, { "maxRuns", max_runs }, { "maxAgeDays", max_age_days } });
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

    vayu::utils::log_info ("db",
    "Reconciled " + std::to_string (orphans.size ()) +
    " run(s) left in-flight by a previous process (marked failed)");
    return orphans.size ();
}

void Database::prune_runs_configured () {
    const int max_runs = get_config_int (
    "maxRunsRetained", vayu::core::constants::database::MAX_RUNS_RETAINED);
    const int max_age_days = get_config_int (
    "runRetentionDays", vayu::core::constants::database::RUN_RETENTION_DAYS);
    prune_runs (max_runs, max_age_days);
    // A run that has just been pruned may have been the last thing naming an
    // OpenAPI document (issue #718). Retention is where that reference is
    // released, so it is where the release is noticed - and this is what puts
    // the sweep on both a startup and the end of every run without a schedule
    // of its own. Never throws; see the declaration.
    sweep_orphaned_spec_documents ();
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

Database::BackupSlot::BackupSlot (Database& db) : db_ (db) {
    bool expected = false;
    held_ = db_.impl_->backup_running.compare_exchange_strong (expected, true);
}

Database::BackupSlot::~BackupSlot () {
    if (held_) {
        db_.impl_->backup_running.store (false);
    }
}

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
    return impl_->storage.get_all<MetricTick> (where (c (&MetricTick::run_id) == run_id),
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
    return impl_->storage.get_all<MonitorSample> (where (c (&MonitorSample::run_id) == run_id),
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
            assigned_id = impl_->storage.insert (capture);

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

std::vector<InboxRequest>
Database::get_inbox_requests_paginated (const std::string& inbox_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id),
    order_by (&InboxRequest::id).desc (), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_inbox_requests (const std::string& inbox_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id));
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
    const int64_t removed = impl_->storage.count<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id));
    impl_->storage.remove_all<InboxRequest> (where (c (&InboxRequest::inbox_id) == inbox_id));
    return removed;
}

int64_t Database::clear_inbox_requests_all () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    const int64_t removed = impl_->storage.count<InboxRequest> ();
    if (removed > 0) {
        impl_->storage.remove_all<InboxRequest> ();
    }
    return removed;
}

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
                result_ids.push_back (impl_->storage.insert (result));
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
                        blob_id      = impl_->storage.insert (blob);
                        blob_ids.emplace (pending.body_hash, blob_id);
                    }
                }

                ResultBody row;
                row.result_id     = result_ids[pending.result_index];
                row.run_id        = results[pending.result_index].run_id;
                row.headers       = pending.headers;
                row.blob_id       = blob_id;
                row.body_bytes    = pending.body_bytes;
                row.truncated     = pending.truncated;
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
                vayu::utils::log_error ("db",
                std::string ("Failed to ") + what + " after " +
                std::to_string (attempts) + " attempts: " + error_msg);
                throw;
            }
            vayu::utils::log_debug ("db",
            std::string ("Database locked during ") + what + ", retrying in " +
            std::to_string (base.count () * (attempt + 1)) + "ms (attempt " +
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

// Same shape as apply_reorder and spec_sync_apply: retry_on_busy holds the
// recursive mutex while the transaction runs, so a row an earlier call in the
// batch just wrote is visible to the check or write after it. Unlike those two
// there is no existence check - config entries are seeded once at startup and
// never deleted through any route - so a mid-batch failure here is a genuine
// SQLITE_BUSY-past-retry or disk error, which `impl_->storage.transaction`
// rolls back in full rather than leaving the rows written before it landed.
void Database::save_config_entries (const std::vector<ConfigEntry>& entries) {
    if (entries.empty ()) {
        return;
    }
    retry_on_busy ("apply config batch", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            for (const auto& entry : entries) {
                impl_->storage.replace (entry);
            }
            return true; // Commit
        });
    });
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

bool Database::is_known_config_key (const std::string& key) const {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return known_config_keys_.contains (key);
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
        vayu::utils::log_warning ("db",
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
        vayu::utils::log_warning ("db",
        "Database: Failed to parse double for key " + key + ", using default");
        return default_value;
    }
}

void Database::seed_default_config () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // One transaction for the whole seed (issue #838): a throw partway used to
    // leave the table half-seeded, and batching what were ~66 separate commits
    // into one is what keeps a scratch database's test-suite wall time down.
    auto seed_transaction = impl_->storage.transaction_guard ();

    auto existing               = impl_->storage.get_all<ConfigEntry> ();
    const size_t existing_count = existing.size ();
    const auto now              = config_seeds::now_ms ();

    config_seeds::ConfigSeeder seed (
    std::move (existing), known_config_keys_,
    [this] (const ConfigEntry& entry) { impl_->storage.replace (entry); },
    [this] (const std::string& key) {
        impl_->storage.remove_all<ConfigEntry> (where (c (&ConfigEntry::key) == key));
    });

    config_seeds::seed_general (seed, now);
    config_seeds::seed_network (seed, now);
    config_seeds::seed_services (seed, now);
    config_seeds::seed_observability (seed, now);
    config_seeds::seed_data_retention (seed, now);
    config_seeds::seed_limits (seed, now);
    config_seeds::seed_scripting (seed, now);

    seed_transaction.commit ();

    if (existing_count == 0) {
        vayu::utils::log_info ("db", "Seeded default configuration values");
    } else {
        vayu::utils::log_info ("db",
        "Updated configuration metadata for " + std::to_string (existing_count) + " existing entries");
    }
}


} // namespace vayu::db
