#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The sqlite_orm storage mapping and `Database::Impl`, shared by every
 * translation unit under `engine/src/db/` (#1614). Never installed, and
 * included by nothing outside `db/` (`db_layout_test.cpp` source-scans the tree
 * and pins that). Every unit running a `sqlite_orm` query against a
 * `Database::` column includes it, so all nine agree on the storage's C++ type;
 * only `database.cpp` and `db_maintenance.cpp` construct an `Impl`.
 *
 * Also declares the four maintenance helpers `Database::Database` calls
 * (`migrate_before_sync`, `has_sqlite_header`, `copy_db_files`,
 * `recover_database`), so the constructor in `database.cpp` reaches their
 * definitions in `db_maintenance.cpp`. What those four are built from (the
 * corruption quarantine, the startup reclamation pass, the pre-#1514 script
 * fold) stays in that file's anonymous namespace, by #1614's rule: a helper two
 * families need is declared here, one only one family needs stays file-local.
 */

#include <sqlite3.h>
#include <sqlite_orm/sqlite_orm.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>

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

// BodyBytes: a body read back whole past a zero byte (#3112). sqlite_orm's
// std::string extractor builds the value with strlen, cutting at the first 0x00
// a client sent; the length comes from sqlite3_column_bytes here. Both
// specialisations are full ones, so they win over the library's partial ones,
// which match any class derived from std::string. The column stays TEXT and the
// write already bound the full length, so no stored row changes.
template <> struct type_printer<vayu::db::BodyBytes> {
    const std::string& print () {
        static const std::string res = "TEXT";
        return res;
    }
};
template <> struct statement_binder<vayu::db::BodyBytes> {
    int bind (sqlite3_stmt* stmt, int index, const vayu::db::BodyBytes& value) {
        return sqlite3_bind_text64 (stmt, index, value.data (), value.size (),
        SQLITE_TRANSIENT, SQLITE_UTF8);
    }
};
template <> struct field_printer<vayu::db::BodyBytes> {
    std::string operator() (const vayu::db::BodyBytes& t) const {
        return t;
    }
};
template <> struct row_extractor<vayu::db::BodyBytes> {
    // Only sqlite_orm's scalar/pragma reads use this overload; a mapped column
    // goes through the sqlite3_stmt* one below.
    vayu::db::BodyBytes extract (const char* row_value) const {
        return row_value ? vayu::db::BodyBytes (row_value) : vayu::db::BodyBytes ();
    }
    vayu::db::BodyBytes extract (sqlite3_stmt* stmt, int columnIndex) const {
        // Text first, then its length: sqlite3_column_bytes is only defined
        // after the conversion sqlite3_column_text performs.
        const char* text = vayu::db::column_text (stmt, columnIndex);
        if (text == nullptr) {
            return {};
        }
        const auto size =
        static_cast<std::size_t> (sqlite3_column_bytes (stmt, columnIndex));
        return vayu::db::BodyBytes (std::string (text, size));
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

    // ─────────────── INDEXES ─────────────── sqlite_orm requires indexes
    // before the tables in the argument list. sync_schema() creates them on
    // fresh and existing databases alike, so they need no migration.
    //
    // metric_ticks/results grow without bound (a load run writes one tick
    // row/sec and samples results), so a run_id scan slows with every run ever
    // recorded. get_metric_ticks_since is polled every 500ms by the legacy SSE
    // loop.
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
    // get_trash lists the stamped requests; without this SQLite walks every
    // request row's overflow pages (a large body) to reach deleted_at. Partial,
    // so it holds only trashed rows and costs a live write nothing (#3006).
    make_index ("idx_requests_deleted_at", &Request::deleted_at,
    where (is_not_null (&Request::deleted_at))),
    // Every example read is per-request (the list route, the request cascade,
    // and the collection cascade one request at a time).
    make_index ("idx_request_examples_request_id", &RequestExample::request_id),
    // The cascade-delete BFS in delete_collection walks one lookup per node.
    make_index ("idx_collections_parent_id", &Collection::parent_id),
    // Every inbox read filters by inbox_id (the capture list, the live poll,
    // the retention trim, the clear), and a long-lived listener appends without
    // bound between trims.
    make_index ("idx_inbox_requests_inbox_id", &InboxRequest::inbox_id),
    // get_all_runs / get_runs_paginated sort the whole table on every GET /runs;
    // get_runs_before seeks it to a keyset cursor (#2978).
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
    // The element list (#1513, run by #1514's pipeline); the two script columns
    // it replaced are gone from this mapping. `migrate_before_sync` folds an
    // older row's scripts in here ahead of the `sync_schema` call that would
    // `DROP COLUMN` them (the note there).
    make_column ("elements", &Collection::elements, default_value (std::string ("[]"))),
    // The declared data contract (#599). NOT NULL with a default_value, on the
    // `keywords` precedent, so sync_schema can ADD COLUMN it to a non-empty
    // table; existing rows backfill to `{}`, "declares no contract".
    make_column ("data_schema", &Collection::data_schema, default_value (std::string ("{}"))),
    // The OpenAPI binding (#637), `data_schema`'s shape for its reason;
    // existing rows backfill to `{}`, "bound to no spec".
    make_column ("openapi", &Collection::openapi, default_value (std::string ("{}"))),
    // The spec-file and data-file bindings (#2765, schema version 8), the same
    // shape, backfilled to `{}`. A stored path is not a grant: whether a body
    // may send the file is still `FileAccessPolicy`'s answer from `file_roots`
    // and `file_grants`.
    make_column ("spec_file", &Collection::spec_file, default_value (std::string ("{}"))),
    make_column ("data_file", &Collection::data_file, default_value (std::string ("{}"))),
    make_column ("order", &Collection::order),
    make_column ("created_at", &Collection::created_at),
    make_column ("updated_at", &Collection::updated_at),
    // Soft delete (#988): NULL is live, a stamp the instant the delete ran.
    // Additive and nullable, the class `sync_schema` adds without touching a
    // stored row.
    make_column ("deleted_at", &Collection::deleted_at)),

    // Requests: HTTP request definitions with pre/post scripts
    make_table ("requests", make_column ("id", &Request::id, primary_key ()),
    make_column ("collection_id", &Request::collection_id),
    make_column ("name", &Request::name),
    make_column ("description", &Request::description), // NEW: request description
    make_column ("method", &Request::method),
    // Which app setting set `method`, still unclaimed by the user (#1505).
    // Nullable on the `spec_operation` precedent: ALTER-friendly without a
    // default, and NULL the only spelling of "no marker".
    make_column ("method_source", &Request::method_source),
    make_column ("url", &Request::url), make_column ("params", &Request::params), // JSON array of KeyValueEntry
    make_column ("headers", &Request::headers), // JSON array of KeyValueEntry
    make_column ("body", &Request::body),       // JSON discriminated union
    make_column ("body_type", &Request::body_type), make_column ("auth", &Request::auth), // JSON
    // The element list (#1513, #1514); the `collections` table says why the
    // script columns are gone.
    make_column ("elements", &Request::elements, default_value (std::string ("[]"))),
    make_column ("order", &Request::order), // NEW: position within collection
    // Redirect policy. NOT NULL, so the default_value lets sync_schema ADD
    // COLUMN these to a non-empty table; existing rows backfill to the engine
    // defaults (follow, cap at 10).
    make_column ("follow_redirects", &Request::follow_redirects, default_value (true)),
    make_column ("max_redirects", &Request::max_redirects, default_value (10)),
    // The request's own timeout (#2937, schema version 9). Nullable with no
    // default, like `method_source`: NULL is "use the setting", and every
    // existing row backfills to it.
    make_column ("timeout_ms", &Request::timeout_ms),
    // Per-request TLS verification (#706), the same NOT NULL + default_value
    // shape; the default is the safe one, so an older row backfills to
    // verifying, never to trusting whatever answers.
    make_column ("verify_ssl", &Request::verify_ssl, default_value (true)),
    // Protocol selection. TEXT, not an ordinal, so a stored value survives a
    // reorder of HttpVersion; NOT NULL with a default_value so sync_schema can
    // ADD COLUMN it.
    make_column ("http_version", &Request::http_version, default_value ("auto")),
    // The SSE execution flag (#574), the same shape for the same reason;
    // existing rows backfill to "not a stream", which they all were.
    make_column ("stream", &Request::stream, default_value (false)),
    // The stream's text path (#3773, schema version 11). Nullable with no
    // default, on the `spec_operation` precedent: NULL is "declares none",
    // every existing row's value.
    make_column ("stream_text_path", &Request::stream_text_path),
    // The stream's first content marker (issue #3774, schema version 11),
    // nullable for the same reason.
    make_column ("stream_first_content_marker", &Request::stream_first_content_marker),
    // Postman's per-request protocol settings (#1765, schema version 2). The
    // three typed ones are NOT NULL + default_value as `stream` is, and
    // existing rows backfill to what they already did.
    make_column ("disable_cookies", &Request::disable_cookies, default_value (false)),
    make_column ("disabled_system_headers", &Request::disabled_system_headers,
    default_value (std::string ("[]"))),
    make_column ("disable_url_encoding", &Request::disable_url_encoding, default_value (false)),
    // The imported `protocolProfileBehavior` object, read only by the Postman
    // export. Nullable on the `spec_operation` precedent below.
    make_column ("postman_protocol_behavior", &Request::postman_protocol_behavior),
    // Which operation of the bound spec this request is (#637). Nullable, not
    // NOT NULL with a default, on the `config_entries.unit` precedent:
    // ALTER-friendly without one, and NULL the only spelling of "declares no
    // operation".
    make_column ("spec_operation", &Request::spec_operation),
    // Which saved example a mock server answers with (#481). NOT NULL +
    // default_value so sync_schema() can ADD COLUMN it; existing rows backfill
    // to "first", how every row behaved when no other mode existed.
    make_column ("mock_response_mode", &Request::mock_response_mode,
    default_value (std::string ("first"))),
    // The example `mock_response_mode == "fixed"` names. Nullable on the
    // `spec_operation` precedent: nothing to backfill from, and NULL the only
    // spelling of "no target".
    make_column ("mock_example_id", &Request::mock_example_id),
    make_column ("created_at", &Request::created_at),
    make_column ("updated_at", &Request::updated_at),
    // Soft delete (issue #988) - see the collections column above.
    make_column ("deleted_at", &Request::deleted_at)),

    // Request examples: saved example responses for a request (#481), written
    // by import and the app, and what a mock server serves from. sync_schema()
    // creates the table outright, so no migration.
    make_table ("request_examples", make_column ("id", &RequestExample::id, primary_key ()),
    make_column ("request_id", &RequestExample::request_id),
    make_column ("name", &RequestExample::name),
    make_column ("status", &RequestExample::status),
    make_column ("headers", &RequestExample::headers), // JSON array of KeyValueEntry
    make_column ("body", &RequestExample::body),
    make_column ("content_type", &RequestExample::content_type),
    make_column ("order", &RequestExample::order),
    // Who wrote the row (#588). NOT NULL + default_value so sync_schema can ADD
    // COLUMN it; existing rows backfill to "import", the only writer before the
    // app could save a response as an example.
    make_column ("origin", &RequestExample::origin,
    default_value (std::string (vayu::core::constants::request_example::ORIGIN_IMPORT))),
    // Whether `body` is a prefix of the response it was saved from (#659), on
    // `origin`'s shape; existing rows backfill to false, which they all are:
    // import copies whole bodies, and the app's save-as-example is the one
    // writer that can store a partial one.
    make_column ("body_truncated", &RequestExample::body_truncated, default_value (false)),
    // A deleted imported example, kept as a tombstone so a later spec sync does
    // not re-create it (#722), on the same shape; `false` is right for every
    // older row, since a delete then removed the row.
    make_column ("suppressed", &RequestExample::suppressed, default_value (false)),
    // The key of the 3.x response `examples` map entry this example was
    // imported from (#1457). Nullable on the `requests.spec_operation`
    // precedent: nothing to backfill from, and NULL the only spelling of "no
    // key".
    make_column ("spec_example_key", &RequestExample::spec_example_key),
    // The Postman saved response an import took this example from (schema
    // version 2). Nullable on the `spec_example_key` precedent: NULL is every
    // example not from Postman, every older row included. A mapping change, so
    // `SCHEMA_VERSION` (`database.hpp`) moved with it.
    make_column ("postman_response", &RequestExample::postman_response),
    make_column ("created_at", &RequestExample::created_at),
    make_column ("updated_at", &RequestExample::updated_at),
    // Soft delete of a user's example (#2971), the `environments.deleted_at`
    // shape: NULL is live.
    make_column ("deleted_at", &RequestExample::deleted_at)),

    // Spec documents: OpenAPI documents, stored once and bound to collections
    // (#637). A new table, created outright by sync_schema(), as
    // `request_examples` is.
    make_table ("spec_documents", make_column ("id", &SpecDocument::id, primary_key ()),
    make_column ("content", &SpecDocument::content),
    make_column ("source_url", &SpecDocument::source_url), // NULL = not fetched from a URL
    make_column ("fetched_at", &SpecDocument::fetched_at),
    make_column ("hash", &SpecDocument::hash), // hex sha256 of `content`
    // The engine-derived operation index (#629, #853). NOT NULL + default_value
    // so sync_schema can ADD COLUMN it; existing rows backfill to `""`, the
    // truth: nothing extracted an index when they were stored, and a run of one
    // reports no coverage rather than an empty contract.
    make_column ("operations", &SpecDocument::operations, default_value (std::string ())),
    // The app-extracted response schema index (#628), on `operations`' rule. An
    // existing row backfills to `""`, the truth: nothing extracted schemas
    // then, so its operations' responses report `checked: false` / `no_index`
    // rather than a contract they never had.
    make_column ("response_schemas", &SpecDocument::response_schemas,
    default_value (std::string ()))),

    // Operations a person declined by deleting their request (schema version
    // 10, #3031), a new table created outright like `file_roots`. The UNIQUE
    // key is the identity under one binding, so a second delete for one
    // operation is one row; it also serves every read, all by `collection_id`.
    make_table ("spec_declined_operations",
    make_column ("id", &DeclinedOperation::id, primary_key ().autoincrement ()),
    make_column ("collection_id", &DeclinedOperation::collection_id),
    make_column ("operation_id", &DeclinedOperation::operation_id),
    make_column ("method", &DeclinedOperation::method),
    make_column ("path", &DeclinedOperation::path),
    make_column ("request_id", &DeclinedOperation::request_id),
    unique (&DeclinedOperation::collection_id, &DeclinedOperation::method,
    &DeclinedOperation::path, &DeclinedOperation::operation_id)),

    // Environments: Named variable sets (dev, staging, prod)
    make_table ("environments", make_column ("id", &Environment::id, primary_key ()),
    make_column ("name", &Environment::name),
    make_column ("description", &Environment::description), // NEW: environment description
    make_column ("variables", &Environment::variables), // JSON: {key: {value, enabled}}
    make_column ("is_active", &Environment::is_active),
    make_column ("created_at", &Environment::created_at),
    make_column ("updated_at", &Environment::updated_at),
    // Soft delete (#2970), the `collections.deleted_at` shape: NULL is live.
    make_column ("deleted_at", &Environment::deleted_at)),

    // ─────────────── EXECUTION ENGINE TABLES ───────────────

    // Runs: Test execution sessions (load tests or design mode requests)
    make_table ("runs", make_column ("id", &Run::id, primary_key ()),
    make_column ("request_id", &Run::request_id),
    make_column ("environment_id", &Run::environment_id),
    make_column ("type", &Run::type),     // "design", "load" or "scenario"
    make_column ("status", &Run::status), // pending/running/completed/failed
    make_column ("config_snapshot", &Run::config_snapshot), // JSON: composed request, credentials withheld
    make_column ("start_time", &Run::start_time), make_column ("end_time", &Run::end_time),
    // Whole-run results written once at terminal status. NOT NULL, so the
    // default_value lets sync_schema ADD COLUMN it; existing rows backfill to
    // `""`, which the report route reads as "no terminal summary (#2436): still
    // running, or the engine died; report from the sampled results alone".
    make_column ("summary", &Run::summary, default_value ("")),
    // Pinned-as-baseline flag; see Run::baseline for why retention reads it.
    make_column ("baseline", &Run::baseline, default_value (false)),
    // Whether `summary` carries warnings; see Run::has_warnings. Same
    // ADD-COLUMN-onto-an-existing-table shape as `baseline` above.
    make_column ("has_warnings", &Run::has_warnings, default_value (false)),
    // Who started the run (#1817); see Run::origin. The default is what lets
    // sync_schema ADD COLUMN it onto an existing table, and it is the honest
    // answer for every row stored before the column: nobody recorded one.
    make_column ("origin", &Run::origin, default_value ("other")),
    make_column ("origin_client", &Run::origin_client),
    // The verdict the run's list row draws (#3547); see Run::outcome. Nullable
    // with no default: a row stored before the column has no verdict, and a
    // default would claim one nothing judged.
    make_column ("outcome", &Run::outcome)),

    // Metric ticks: one wide row per persisted tick (the time series)
    make_table ("metric_ticks",
    make_column ("id", &MetricTick::id, primary_key ().autoincrement ()),
    make_column ("run_id", &MetricTick::run_id),
    make_column ("timestamp", &MetricTick::timestamp),
    make_column ("payload", &MetricTick::payload)), // JSON: the whole tick object

    // Monitor samples: one row per scrape of the run's server-vitals endpoint.
    // Its own table, not a wider metric_ticks row: the tick payload's key set
    // is the GET /runs/:id/metrics contract, and these arrive on the scrape
    // cadence, not the tick cadence.
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

    // Body blobs: one row per *distinct* captured response body in a run,
    // content-addressed within the run so N identical load-test responses cost
    // one copy. sync_schema() creates new tables outright, so this and the next
    // need no migration.
    make_table ("body_blobs",
    make_column ("id", &BodyBlob::id, primary_key ().autoincrement ()),
    make_column ("run_id", &BodyBlob::run_id), make_column ("hash", &BodyBlob::hash),
    make_column ("content", &BodyBlob::content)),

    // Result bodies: the captured exchange for one sampled result, one-to-one
    // with a `results` row. Separate on purpose: the report path loads and
    // JSON-parses every result row's trace_data, so a body stored there would
    // be read and parsed on every dashboard poll.
    make_table ("result_bodies",
    make_column ("result_id", &ResultBody::result_id, primary_key ()),
    make_column ("run_id", &ResultBody::run_id),
    make_column ("headers", &ResultBody::headers), // JSON object
    make_column ("blob_id", &ResultBody::blob_id), // 0 = no stored body
    make_column ("body_bytes", &ResultBody::body_bytes),
    make_column ("truncated", &ResultBody::truncated),
    make_column ("is_binary", &ResultBody::is_binary),
    make_column ("content_type", &ResultBody::content_type),
    // Nullable, so sync_schema can ADD COLUMN it without a backfill value, and
    // so a row from before #657 reads as "not a stream", not a stream that
    // delivered nothing.
    make_column ("stream_events", &ResultBody::stream_events),
    // The sample's `streamTextPath` (issue #3773, schema version 11). Nullable
    // like `stream_events`: NULL is "declared none", which every earlier row
    // reads as.
    make_column ("stream_text_path", &ResultBody::stream_text_path)),

    // Inbox requests: what a webhook inbox listener captured (#480). No run
    // owns it, so the run cascade never touches it; rows are bounded per inbox
    // as written and cleared wholesale at startup, since no inbox outlives the
    // process that opened it.
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
    // NOT NULL with a default_value, so sync_schema can ADD COLUMN these; the
    // rows are re-seeded with their metadata every startup, so the backfill
    // value lasts only between the ALTER and that upsert.
    make_column ("requires_restart", &ConfigEntry::requires_restart, default_value (false)),
    make_column ("advanced", &ConfigEntry::advanced, default_value (false)),
    // JSON array of search terms, "[]" when the entry declares none: the same
    // ALTER-friendly shape, never null, so the serializer has no absent case to
    // invent an array for.
    make_column ("keywords", &ConfigEntry::keywords, default_value (std::string ("[]"))),
    // Nullable, like min_value/max_value: an entry measuring nothing declares
    // no unit, and NULL is that. Nullable is ALTER-friendly without a
    // default_value.
    make_column ("unit", &ConfigEntry::unit),
    // The key of a boolean sibling this entry is nested under in the app.
    // Nullable as `unit` is: an entry with no dependency declares none, and
    // POST /config never writes one.
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
    make_column ("created_at", &OAuthToken::created_at)),

    // Client certificates: which certificate is presented to which host (#707).
    // A new table, created outright by sync_schema(), as `spec_documents` is.
    //
    // `cert_path` / `key_path` are paths: the private key never enters this
    // file. `passphrase` does, in plaintext, the repo's credential precedent,
    // disclosed in docs/engine/db-schema/credentials-and-files.md rather than
    // left for a reader of the schema to discover.
    make_table ("client_certificates",
    make_column ("id", &ClientCertificate::id, primary_key ()),
    make_column ("host", &ClientCertificate::host),
    make_column ("port", &ClientCertificate::port), // NULL = every port
    make_column ("cert_path", &ClientCertificate::cert_path),
    make_column ("key_path", &ClientCertificate::key_path), // "" for PKCS#12
    // What the certificate file holds (#833). NOT NULL with a default_value on
    // the `http_version` precedent, so sync_schema can ADD COLUMN it to an
    // older registry; every such row backfills to `pem`, the format libcurl
    // read by default when nothing named one.
    make_column ("cert_format", &ClientCertificate::cert_format, default_value ("pem")),
    make_column ("passphrase", &ClientCertificate::passphrase),
    make_column ("created_at", &ClientCertificate::created_at),
    make_column ("updated_at", &ClientCertificate::updated_at),
    // Soft delete (#2973), the `environments.deleted_at` shape: NULL is live.
    make_column ("deleted_at", &ClientCertificate::deleted_at)),

    // Folders the user allowed request-body files to be read from (schema
    // version 3), created outright like `client_certificates`; the version bump
    // fences off an older engine that would send this workspace's binary bodies
    // empty. `path` is canonical and UNIQUE, so two spellings of one folder are
    // one row and the route's 409 is backed by the schema.
    make_table ("file_roots", make_column ("id", &FileRoot::id, primary_key ()),
    make_column ("path", &FileRoot::path, unique ()),
    make_column ("created_at", &FileRoot::created_at)),

    // Files a person picked (schema version 6, #2356), the per-file half of the
    // trust rule beside `file_roots`; `path` canonical and UNIQUE as a root's.
    // The version-6 migration creates this table before `sync_schema ()`, to
    // hold the grants it reads out of stored bodies, so `FILE_GRANTS_DDL` in
    // `db_maintenance.cpp` must match this mapping exactly: a mismatch makes
    // `sync_schema ()` rebuild the table and lose every grant.
    make_table ("file_grants", make_column ("id", &FileGrant::id, primary_key ()),
    make_column ("path", &FileGrant::path, unique ()),
    make_column ("created_at", &FileGrant::created_at)));
}

using Storage = decltype (make_vayu_storage (std::string{}));

// ============================================================================
// Change-feed events (issue #3420) - what each write publishes once it commits
// ============================================================================

/// What a `replace` of @p id is about to do: `Create` when no row carries the
/// id yet, stamped rows included. The caller holds the DB mutex.
template <typename Row>
ChangeOp upsert_op (Storage& storage, const std::string& id) {
    using namespace sqlite_orm;
    return storage.count<Row> (where (c (&Row::id) == id)) == 0 ? ChangeOp::Create :
                                                                  ChangeOp::Update;
}

inline Change collection_change (const Collection& row, ChangeOp op) {
    return Change{ ChangeKind::Collection, op, row.id, row.parent_id, std::nullopt };
}

inline Change request_change (const Request& row, ChangeOp op) {
    return Change{ ChangeKind::Request, op, row.id, row.collection_id, std::nullopt };
}

inline Change example_change (const RequestExample& row, ChangeOp op) {
    return Change{ ChangeKind::Example, op, row.id, std::nullopt, row.request_id };
}

inline Change environment_change (const std::string& id, ChangeOp op) {
    return Change{ ChangeKind::Environment, op, id, std::nullopt, std::nullopt };
}

/// The change a restore or purge of @p entry publishes: the entry's own kind,
/// and the row it hung under where that kind names one.
inline Change trash_change (const TrashEntry& entry, ChangeOp op) {
    Change change{ change_kind_of_trash_entry (entry.kind), op, entry.id,
        std::nullopt, std::nullopt };
    if (change.kind == ChangeKind::Example) {
        change.request_id = entry.parent_id;
    } else if (change.kind == ChangeKind::Collection || change.kind == ChangeKind::Request) {
        change.collection_id = entry.parent_id;
    }
    return change;
}

// ============================================================================
// Database Implementation (PImpl pattern)
// ============================================================================

struct Database::Impl {
    Storage storage;
    std::recursive_mutex mutex;

    /// A second, read-only connection to the same file, for the one read that
    /// must not wait on `mutex` (`Database::get_run_snapshot`, #2679); WAL lets
    /// it read the last commit while a write holds `mutex`. Declared after
    /// `storage` so it closes first: the last connection to close a WAL
    /// database checkpoints it and deletes the `-wal`, and that stays the main
    /// one. Opened on first use, never by the constructor or `init`, whose
    /// migration, reclamation and checkpoint must meet no second connection.
    /// Guarded by `snapshot_reader_mutex`, never `mutex`.
    std::optional<Storage> snapshot_reader;
    std::mutex snapshot_reader_mutex;

    /// The busy timeout `storage` is on, in ms, for `snapshot_reader` to copy
    /// without taking `mutex`: the constructor's `busy_timeout` until `init`
    /// applies `dbBusyTimeout`.
    std::atomic<int> busy_timeout_ms;

    /// Page cache the open callback gives every connection, in bytes: the
    /// compile-time default, overwritten once from `dbCacheSize` while `init`
    /// runs, which is why that entry is restart-required. Atomic because
    /// sqlite_orm opens connections from whichever thread needs one, so the
    /// callback reads it concurrently with that write.
    std::atomic<int> cache_size_bytes{ vayu::core::constants::database::CACHE_SIZE_BYTES };

    /// What SQLite reported after the latest open, in bytes (0 before the first
    /// connection); read back, not echoed, so it is the size in force, not the
    /// one requested.
    std::atomic<int> applied_cache_size_bytes{ 0 };

    /// Whether a workspace backup is being written (#987). Only
    /// `Database::BackupSlot` touches it (its note says why a second backup is
    /// refused, not queued). Atomic because the slot is taken *outside* the DB
    /// mutex: a large workspace's `VACUUM INTO` must not stall every endpoint.
    std::atomic<bool> backup_running{ false };

    /// Whether this start validated the database it opened, the one condition
    /// for refreshing `<db>.bak` from it: a start that took the recovery branch
    /// leaves the backup it judged alone. Written once by the constructor,
    /// before any thread reads it.
    bool recovery_backup_due = false;

    /// Whether `migrate_before_sync` found the file at `SCHEMA_VERSION` before
    /// this process wrote to it: the start on which earlier engines' safety
    /// copies may go (#2426). Written once by the constructor, before any
    /// thread reads it.
    bool opened_at_current_schema = false;

    /// When the constructor began, so a copy written since is never mistaken
    /// for one an earlier process left.
    std::filesystem::file_time_type opened_at;

    /// The background refresh of `<db>.bak`
    /// (`Database::start_recovery_backup_refresh`). Its connection is published
    /// while its `VACUUM INTO` runs so a shutdown can `sqlite3_interrupt` it;
    /// the mutex orders that interrupt against the close, and
    /// `recovery_backup_cancelled` refuses a refresh not yet at its copy.
    std::mutex recovery_backup_mutex;
    sqlite3* recovery_backup_connection = nullptr;
    bool recovery_backup_cancelled      = false;
    std::thread recovery_backup_thread;

    /// `sqlite3_total_changes64` on `connection` once `Database::init`'s own
    /// seed and repair writes are done: the shutdown refresh of `<db>.bak`
    /// skips a session that has not moved past it. Written under `mutex`.
    int64_t session_changes_baseline = 0;

    /// The file `storage` was opened on, for `Database::path`. Not `db_path`,
    /// which the constructor uses for the parsed `std::filesystem::path`: MSVC
    /// builds /W4 /WX, and a shadowed member is C4458, an error.
    std::string opened_file;

    /// The connection `storage` holds open (see `open_forever` in the
    /// constructor), or null before it is opened. Touched only under `mutex`
    /// once the constructor has returned.
    sqlite3* connection = nullptr;

    /// Applies `cache_size_bytes` to @p db and records what SQLite reports
    /// back in `applied_cache_size_bytes`.
    void apply_cache_size (sqlite3* db) {
        // SQLite cache_size PRAGMA uses negative KB values (e.g., -64000 = 64MB)
        const std::string sql =
        "PRAGMA cache_size = " + std::to_string (-(cache_size_bytes.load () / 1024)) + ";";
        char* err_msg = nullptr;
        if (sqlite3_exec (db, sql.c_str (), nullptr, nullptr, &err_msg) != SQLITE_OK && err_msg) {
            vayu::utils::log_warning (
            "db", "Failed to set cache_size: " + std::string (err_msg));
        }
        sqlite3_free (err_msg);

        // Read the size back instead of trusting the write: a rejected
        // PRAGMA is silent, and only the connection can say what it holds.
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2 (db, "PRAGMA cache_size;", -1, &stmt, nullptr) == SQLITE_OK) {
            if (sqlite3_step (stmt) == SQLITE_ROW) {
                // Negative means KB, positive pages; we set the negative form,
                // so a positive answer means the write did not take and the
                // byte size is unknown here.
                const int reported = sqlite3_column_int (stmt, 0);
                applied_cache_size_bytes.store (reported < 0 ? -reported * 1024 : 0);
            }
            sqlite3_finalize (stmt);
        }
    }

    /// `snapshot_reader`, opened on the first call. The caller holds
    /// `snapshot_reader_mutex`. An open that fails leaves it unopened and
    /// throws, so the next call tries again.
    Storage& snapshot_storage () {
        if (snapshot_reader) {
            return *snapshot_reader;
        }
        try {
            Storage& reader = snapshot_reader.emplace (make_vayu_storage (opened_file));
            // No journal_mode, synchronous or wal_autocheckpoint: the file is
            // already WAL, and this connection never writes, so never
            // checkpoints.
            reader.on_open = [timeout = busy_timeout_ms.load ()] (sqlite3* db) {
                sqlite3_busy_timeout (db, timeout);
                // Unmapped: Windows refuses to truncate a file any connection
                // has mapped, and a checkpoint on `storage` may need to
                // (`reclaim_freed_pages`).
                for (const char* sql : { "PRAGMA mmap_size = 0;", "PRAGMA query_only = ON;" }) {
                    if (sqlite3_exec (db, sql, nullptr, nullptr, nullptr) != SQLITE_OK) {
                        sqlite_orm::throw_translated_sqlite_error (db);
                    }
                }
            };
            // Held open for `storage`'s reason (`open_forever` in the
            // constructor); `snapshot_reader_mutex` makes sharing it across
            // threads safe.
            reader.open_forever ();
            return reader;
        } catch (...) {
            snapshot_reader.reset ();
            throw;
        }
    }

    /// @param busy_timeout how long a statement on this connection waits for
    ///        another connection's lock before failing with `SQLITE_BUSY`,
    ///        until `Database::init` applies `dbBusyTimeout` (#2420).
    Impl (const std::string& path, std::chrono::milliseconds busy_timeout)
    : storage (make_vayu_storage (path)),
      busy_timeout_ms (static_cast<int> (busy_timeout.count ())), opened_file (path) {
        std::filesystem::path db_path (path);
        if (db_path.has_parent_path ()) {
            std::filesystem::create_directories (db_path.parent_path ());
        }

        // On every connection sqlite_orm opens, since a PRAGMA is
        // per-connection state. Only `cache_size` is configurable; the other
        // three are engine defaults with no user story (#519 retired their
        // entries) and stay compile-time constants.
        storage.on_open = [this, busy_timeout] (sqlite3* db) {
            // First, before any statement that can meet another connection's
            // lock: without it a contended `journal_mode` or `sync_schema`
            // fails at once instead of waiting (#2420).
            sqlite3_busy_timeout (db, static_cast<int> (busy_timeout.count ()));

            // The storage's one connection (`open_forever` below), recorded so
            // `Database::init` can re-apply `cache_size` to it once the sizing
            // row can be read.
            connection = db;

            char* err_msg = nullptr;
            std::stringstream sql;

            int temp_store   = vayu::core::constants::database::TEMP_STORE;
            size_t mmap_size = vayu::core::constants::database::MMAP_SIZE_BYTES;
            int wal_checkpoint = vayu::core::constants::database::WAL_AUTOCHECKPOINT;

            apply_cache_size (db);

            sql << "PRAGMA temp_store = " << temp_store << ";";
            int rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
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
                err_msg = nullptr;
            }
            sql.str ("");

            sql << "PRAGMA journal_size_limit = "
                << vayu::core::constants::database::JOURNAL_SIZE_LIMIT_BYTES << ";";
            rc = sqlite3_exec (db, sql.str ().c_str (), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning ("db",
                "Failed to set journal_size_limit: " + std::string (err_msg));
                sqlite3_free (err_msg);
            }
        };

        // One connection for the storage's lifetime. Otherwise sqlite_orm opens
        // a connection per call outside a transaction and closes it after, and
        // closing a WAL database's last connection checkpoints and deletes the
        // `-wal`: every endpoint re-ran `on_open`, re-parsed the schema and
        // re-created the WAL (measured: 42 opens of the file between exec and
        // six requests). Sharing one connection across threads is safe because
        // every `Database::` member holds `impl_->mutex` around its storage
        // access, which already made the connection sqlite_orm shares for a
        // transaction safe.
        storage.open_forever ();

        // Durability, applied here rather than in `Database::init` (#838).
        // Before `init`, SQLite's defaults apply: a rollback journal at
        // `synchronous=FULL`, covering the constructor's two `sync_schema`
        // passes and `seed_default_config`'s ~66 commits, a full fsync barrier
        // per statement at settings `dbSynchronous` did not ask for.
        //
        // The compile-time constant, because the configured value lives in a
        // table this connection has not created yet. `init` re-applies
        // `dbSynchronous` once it can read it, so a raised setting holds for
        // the process's working life; only the schema sync and the seed run at
        // the default.
        //
        // Through `storage.pragma` rather than the callback above, because
        // sqlite_orm remembers these two and re-applies them to every
        // connection it opens; `cache_size`, which it does not remember, is in
        // the callback instead.
        //
        // After `open_forever`, never before: a pragma with no open connection
        // opens its own, and sqlite_orm re-applies a remembered `journal_mode`
        // to a new connection *ahead of* `on_open`, before the busy timeout is
        // set.
        storage.pragma.journal_mode (journal_mode::WAL);
        storage.pragma.synchronous (vayu::core::constants::database::SYNCHRONOUS);
    }
};

/// Migration and recovery helpers `Database::Database` calls; defined in
/// `db_maintenance.cpp`, which owns the private helpers they are built from
/// (`quarantine_db_files`, `open_workspace_connection`, the pre-#1514 script
/// fold, the startup reclamation pass).
bool has_sqlite_header (const std::filesystem::path& file);
bool copy_db_files (const std::filesystem::path& src, const std::filesystem::path& dst);
void recover_database (const std::filesystem::path& db_file,
const std::filesystem::path& backup_file,
const std::string& db_path,
const std::function<ProbeResult (const std::string&)>& probe);
/// Whether `migrate_before_sync` copies the workspace into `backups/` before
/// it raises `user_version` (issue #2426).
enum class PreMigrationSnapshot : std::uint8_t { Take, Skip };
bool migrate_before_sync (const std::string& path,
std::chrono::milliseconds busy_timeout,
PreMigrationSnapshot snapshot,
const std::function<void (sqlite3*)>& on_connection = {});

} // namespace vayu::db
