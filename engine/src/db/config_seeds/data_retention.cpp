/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"

#include <string>

namespace vayu::db::config_seeds {

// =============================================================================
// DATA & RETENTION (data_retention)
// Every per-run storage budget, in one place: how much of a body is kept, how
// many records are kept, and how long a finished run survives. The words a
// user arrives with here are "why is my response body cut off" and "keep
// fewer runs". #703 completed the shelf - the per-step and the per-stream
// retention budgets were filed under Core and Services.
// =============================================================================
void seed_data_retention (ConfigSeeder& seed, int64_t now) {
    seed (ConfigEntry{ "maxStoredErrors",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS),
    "integer", "Stored error records per run",
    "How many individual error records a run keeps for its report. The error "
    "total, the failed-request count, the error rate, the status-code "
    "breakdown and the 'By Error Type' breakdown are always exact - this "
    "bounds only the per-error detail kept beside them. Runs recorded by "
    "older versions counted their error types from these records, so past "
    "the cap their breakdown covers the first N. 0 means unlimited, which "
    "against a fully refusing target grows for the life of the run.",
    "data_retention", std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS),
    "0", "10000000", std::nullopt, now });

    seed (unit ("bytes") (ConfigEntry{ "maxTraceBodyBytes",
    std::to_string (vayu::core::constants::json::MAX_TRACE_BODY_BYTES), "integer", "Max stored trace body size",
    "Largest request or response body kept in a Send's stored "
    "trace. A larger body is truncated in the database - the response viewer "
    "says so, and re-sending fetches the full body - so one huge response does "
    "not bloat storage forever.",
    "data_retention", std::to_string (vayu::core::constants::json::MAX_TRACE_BODY_BYTES),
    "1024",      // 1KB
    "104857600", // 100MB
    std::nullopt, now }));

    seed (unit ("bytes") (ConfigEntry{ "maxSampleBodyBytes",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES),
    "integer", "Max captured sample body",
    "Largest response body kept for a single captured load-run "
    "sample. Deliberately far smaller than the Send trace limit, because "
    "a load run captures tens of exchanges nobody asked for individually. A "
    "larger body is stored truncated and marked as such.",
    "data_retention", std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES),
    "0",         // 0 disables body capture while keeping headers and metadata
    "104857600", // 100MB
    std::nullopt, now }));

    seed (unit ("bytes") (ConfigEntry{ "maxSampleBytes",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES),
    "integer", "Load-run capture budget",
    "How much captured response-body data one load run may store. Once spent, "
    "samples keep their headers and metadata and only their bodies are "
    "dropped, and the report says how many. Captured data is stored verbatim, "
    "can contain credentials, and is deleted with the run.",
    "data_retention", std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES),
    "0",          // 0 disables body capture while keeping headers and metadata
    "1073741824", // 1GB
    std::nullopt, now }));

    seed (unit ("bytes") (ConfigEntry{ "maxResponseSampleBytes",
    std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_RESPONSE_SAMPLE_BYTES),
    "integer", "Load-run validation sample budget",
    "How much response-body data one load run may hold for its post-run test "
    "scripts and schema checks. These bodies are kept whole - a truncated one "
    "would fail a check the target passed - so past the budget whole samples "
    "are dropped instead, and the report counts them. Lower it for a target "
    "with large responses; raise it to validate more of them.",
    "data_retention", std::to_string (vayu::core::constants::metrics_collector::DEFAULT_MAX_RESPONSE_SAMPLE_BYTES),
    "0",          // 0 retains no sample that has a body
    "1073741824", // 1GB
    std::nullopt, now }));

    seed (ConfigEntry{ "maxScenarioStoredSteps",
    std::to_string (vayu::core::constants::scenario::MAX_STORED_STEPS),
    "integer", "Max stored scenario steps",
    "How many per-step results one collection run keeps, which bounds what a "
    "long run costs the dashboard to load. Steps that failed, errored or were "
    "skipped are kept first and successes fill the rest, so raising this buys "
    "more successful steps to look at and never a failure that was hidden - "
    "what was thinned is reported in the run summary. 0 stores every step.",
    "data_retention", std::to_string (vayu::core::constants::scenario::MAX_STORED_STEPS),
    "0", "1000000", std::nullopt, now });

    seed (keywords ({ "eventsource", "server-sent", "event stream" }) (ConfigEntry{ "sseMaxStoredEvents",
    std::to_string (vayu::core::constants::sse::MAX_STORED_EVENTS), "integer", "Stream events stored per run",
    "How many events a finished streaming run keeps on disk, so reopening it "
    "from History shows the timeline again. A run that received more says so - "
    "the stored list is marked truncated and carries the true total. 0 keeps "
    "the count and no events.",
    "data_retention", std::to_string (vayu::core::constants::sse::MAX_STORED_EVENTS),
    "0", std::to_string (vayu::core::constants::sse::STORED_EVENTS_CEILING),
    std::nullopt, now }));

    seed (keywords ({ "cleanup" }) (ConfigEntry{ "maxRunsRetained",
    std::to_string (vayu::core::constants::database::MAX_RUNS_RETAINED), "integer", "Max runs retained",
    "Keep at most this many most-recent load tests and collection runs; older "
    "ones, with their metrics and results, are pruned at startup and after "
    "each run finishes. Single-request Sends are counted separately and never "
    "push these out. A higher value - or 0 for unlimited - keeps more history "
    "but grows the database file on disk and slows down loading the run "
    "history. In-progress runs and pinned baselines are never pruned.",
    "data_retention", std::to_string (vayu::core::constants::database::MAX_RUNS_RETAINED),
    "0", "100000", std::nullopt, now }));

    seed (keywords ({ "cleanup", "request history" }) (
    ConfigEntry{ "maxDesignRunsRetained",
    std::to_string (vayu::core::constants::database::MAX_DESIGN_RUNS_RETAINED),
    "integer", "Max Sends retained",
    "Keep at most this many most-recent single-request Sends in History; "
    "older ones, with their responses, are pruned at startup and after each "
    "Send. Load tests and collection runs are counted separately. A higher "
    "value - or 0 for unlimited - keeps more history but grows the database "
    "file on disk. In-progress Sends and pinned baselines are never pruned.",
    "data_retention", std::to_string (vayu::core::constants::database::MAX_DESIGN_RUNS_RETAINED),
    "0", "100000", std::nullopt, now }));

    seed (
    unit ("days") (keywords ({ "cleanup" }) (ConfigEntry{ "runRetentionDays",
    std::to_string (vayu::core::constants::database::RUN_RETENTION_DAYS), "integer", "Run retention",
    "Delete runs older than this age, with their metrics and results, at "
    "startup and after each run finishes. A higher value - or 0 to keep runs "
    "forever - retains more history at the cost of a larger database file on "
    "disk. In-progress runs are never pruned.",
    "data_retention", std::to_string (vayu::core::constants::database::RUN_RETENTION_DAYS),
    "0", "3650", std::nullopt, now })));

    seed (unit ("days") (keywords ({ "recycle bin", "recover", "cleanup" }) (ConfigEntry{ "trashRetentionDays",
    std::to_string (vayu::core::constants::database::TRASH_RETENTION_DAYS), "integer", "Trash retention",
    "Deleted collections and requests are kept in the Trash this long before "
    "they are destroyed for good; the sweep runs when Vayu starts. Until then "
    "they can be restored exactly as they were. A higher value - or 0 to keep "
    "them forever - leaves more to undo at the cost of a larger database file "
    "on disk.",
    "data_retention", std::to_string (vayu::core::constants::database::TRASH_RETENTION_DAYS),
    "0", "3650", std::nullopt, now })));

    seed (
    keywords ({ "restore", "cleanup" }) (ConfigEntry{ "maxBackupsRetained",
    std::to_string (vayu::core::constants::database::MAX_BACKUPS_RETAINED), "integer", "Max backups retained",
    "Keep at most this many workspace snapshots in the backups folder beside "
    "the database; older ones are removed after each new backup. The copy Vayu "
    "saves before an update changes the workspace counts too. Each snapshot "
    "is a compacted copy of the database - collections and the paths of the "
    "spec and data files they are bound to, requests, environments, "
    "credentials and run history - so a higher value, or 0 for unlimited, "
    "costs disk. Tabs, saved load-test values and MCP settings live in the "
    "app and are not in it. "
    "Only files Vayu wrote are ever removed; a copy you put there yourself is "
    "left alone.",
    "data_retention", std::to_string (vayu::core::constants::database::MAX_BACKUPS_RETAINED),
    "0", "100", std::nullopt, now }));
}

} // namespace vayu::db::config_seeds
