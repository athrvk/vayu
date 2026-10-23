/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <thread>

namespace vayu::db::config_seeds {

namespace {
// The `{value,label}` array for "dbSynchronous". SQLite's synchronous levels
// are its own enumeration, not ours, so the list is literal - but it belongs
// in the `options` column rather than spelled out as "0 = Off, 1 = ..." prose
// over an integer input, which is what the entry used to do.
std::string db_synchronous_options_json () {
    const nlohmann::json options = { { { "value", "0" },
                                     { "label", "Off (can corrupt on power loss)" } },
        { { "value", "1" }, { "label", "Normal" } },
        { { "value", "2" }, { "label", "Full" } } };
    return options.dump ();
}
} // namespace

// =============================================================================
// CORE (general_engine)
// The engine's own machinery: how much work it runs in parallel, and how
// SQLite is tuned underneath it. Everything a *request* or a *run* is
// measured or bounded by lives in one of the other categories - #703 moved
// the request defaults to Network & connectivity and the ceilings to Limits,
// leaving the four settings that describe the engine itself.
// =============================================================================
void seed_general (ConfigSeeder& seed, int64_t now) {
    // Not restart_required: `run_manager` reads this at the start of every run
    // and builds that run's EventLoop from it, so a change is in force for the
    // next run started. It carried the flag until #873, which told the user to
    // restart for a setting the engine had already picked up.
    seed (keywords ({ "cores", "parallelism" }) (ConfigEntry{ "workers",
    std::to_string (std::thread::hardware_concurrency ()), "integer", "Worker threads",
    "Number of background worker threads. Higher values improve throughput on "
    "multi-core systems but increase RAM usage. "
    "Default equals CPU core count.",
    "general_engine", std::to_string (std::thread::hardware_concurrency ()),
    "1", "128", std::nullopt, now }));

    seed (restart_required (unit ("bytes") (keywords ({ "ram" }) (ConfigEntry{ "dbCacheSize",
    std::to_string (vayu::core::constants::database::CACHE_SIZE_BYTES), "integer", "Database cache size",
    "Memory SQLite keeps per connection for recently used database pages. A "
    "larger cache spares repeated reads while a high-RPS run writes results "
    "and "
    "the dashboard queries them. 64 to 128 megabytes suits runs storing 10,000 "
    "or more results a second.",
    "general_engine", std::to_string (vayu::core::constants::database::CACHE_SIZE_BYTES),
    "1048576",    // min: 1MB in bytes
    "1073741824", // max: 1GB in bytes
    std::nullopt, now }))));

    seed (restart_required (advanced (unit ("ms") (keywords ({ "contention" }) (ConfigEntry{ "dbBusyTimeout",
    std::to_string (vayu::core::constants::database::BUSY_TIMEOUT_MS), "integer", "Database lock wait time",
    "How long a thread waits for the database when another one is writing to "
    "it. Result-storage threads compete for it during a high-concurrency run, "
    "and a longer wait turns a 'database is locked' failure into a pause "
    "instead. 10 to 30 seconds suits runs at 100 or more concurrent requests.",
    "general_engine", std::to_string (vayu::core::constants::database::BUSY_TIMEOUT_MS),
    "1000",  // min: 1 second
    "60000", // max: 60 seconds
    std::nullopt, now })))));

    // adopt_new_default: the default moved from Off to Normal in #2419, and a
    // workspace still holding the old default's value follows it once.
    seed (
    restart_required (keywords ({ "fsync", "pragma" }) (ConfigEntry{
    "dbSynchronous", std::to_string (vayu::core::constants::database::SYNCHRONOUS), "enum", "Data safety mode",
    "How hard SQLite works to get data onto disk before reporting it "
    "written. Off: a power cut or an operating-system crash can corrupt the "
    "whole workspace file. Normal, the default: the file cannot be corrupted, "
    "but the last few seconds of writes may be lost. Full: every committed "
    "write survives a power cut, at the cost of a disk sync per commit "
    "during a high-RPS run.",
    "general_engine", std::to_string (vayu::core::constants::database::SYNCHRONOUS),
    std::nullopt, std::nullopt, db_synchronous_options_json (), now })),
    adopt_new_default);
}

} // namespace vayu::db::config_seeds
