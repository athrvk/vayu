#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file database_impl.hpp
 * @brief The sqlite_orm storage mapping and `Database::Impl`, shared by
 *        every translation unit under `engine/src/db/` (issue #1614).
 *
 * Never installed, and included by nothing outside `db/` -
 * `db_layout_test.cpp` source-scans the tree and pins that. Every unit that
 * runs a `sqlite_orm` query against a `Database::` column includes this, so
 * that all nine agree about the storage's C++ type; only `database.cpp` and
 * `db_maintenance.cpp` construct an `Impl` outright.
 *
 * Also carries the four maintenance helpers `Database::Database`'s
 * constructor calls directly - `migrate_before_sync`, `has_sqlite_header`,
 * `copy_db_files`, `recover_database` - declared here so the constructor
 * (which stays in `database.cpp`) can reach across the translation-unit
 * boundary to their definitions in `db_maintenance.cpp`. Everything *those*
 * four are built from (the corruption quarantine, the startup reclamation
 * pass, the pre-#1514 script fold) is a single family's own business and
 * stays behind an anonymous namespace in `db_maintenance.cpp`, per the rule
 * in issue #1614: a helper two families need is declared here; one only one
 * family needs stays file-local.
 */

#include <sqlite3.h>
#include <sqlite_orm/sqlite_orm.h>

#include <atomic>
#include <filesystem>
#include <functional>
#include <mutex>
#include <sstream>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

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

namespace vayu::db {

using namespace sqlite_orm;

// ============================================================================
// Database Schema Definition
// All tables defined here - sqlite_orm auto-creates/migrates on sync_schema()
// ============================================================================

inline auto make_vayu_storage (const std::string& path) {
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
    // Which saved example a mock server answers with (issue #481 phase 3).
    // NOT NULL + default_value so sync_schema() ALTERs it onto an existing
    // requests table and every pre-existing row backfills to "first" - which
    // is what every row already behaved as, there being no other mode before
    // this column existed.
    make_column ("mock_response_mode", &Request::mock_response_mode,
    default_value (std::string ("first"))),
    // The example `mock_response_mode == "fixed"` names. Nullable on the
    // `spec_operation` precedent above - nothing to backfill a pre-existing
    // row from, and NULL is the only spelling of "no target".
    make_column ("mock_example_id", &Request::mock_example_id),
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
    make_column ("unit", &ConfigEntry::unit),
    // The key of a boolean sibling this entry is nested under, in the app.
    // Nullable for the same reason as unit: an entry with no dependency
    // declares none, and NULL is that - not a value POST /config ever writes.
    make_column ("depends_on", &ConfigEntry::depends_on)),

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

using Storage = decltype (make_vayu_storage (std::string{}));

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
    : storage (make_vayu_storage (path)), opened_file (path) {
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

/// Migration and recovery helpers `Database::Database`'s constructor calls
/// directly; defined in `db_maintenance.cpp`, which also owns the private
/// helpers these are built from (`quarantine_db_files`,
/// `open_workspace_connection`, the pre-#1514 script fold, the startup
/// reclamation pass).
bool has_sqlite_header (const std::filesystem::path& file);
bool copy_db_files (const std::filesystem::path& src, const std::filesystem::path& dst);
void recover_database (const std::filesystem::path& db_file,
const std::filesystem::path& backup_file,
const std::string& db_path,
const std::function<bool (const std::string&)>& probe);
void migrate_before_sync (const std::string& path);

} // namespace vayu::db
