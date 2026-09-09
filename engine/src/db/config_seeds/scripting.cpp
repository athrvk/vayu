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
// SCRIPTING ENVIRONMENT (scripting_sandbox)
// The QuickJS sandbox a pre- or post-request script runs in: its deadline,
// its memory and stack, and whether console output is collected.
// =============================================================================
void seed_scripting (ConfigSeeder& seed, int64_t now) {
    seed (unit ("ms") (keywords ({ "runaway" }) (ConfigEntry{ "scriptTimeout",
    std::to_string (vayu::core::constants::script_engine::TIMEOUT_MS), "integer", "Script Execution Timeout",
    "How long a pre- or post-request script may run. A script "
    "that exceeds this is aborted and reported as an error, so an infinite "
    "loop "
    "cannot hang the engine. 0 disables the limit, which is not recommended.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::TIMEOUT_MS),
    "0", "60000", std::nullopt, now })));

    seed (keywords ({ "debug", "print" }) (ConfigEntry{ "scriptEnableConsole",
    vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false", "boolean", "Enable Script Console",
    "Makes console.log() available inside scripts, with its output shown in "
    "the "
    "response viewer. Turn it off during a load test, where the writes cost "
    "throughput for output nobody reads.",
    "scripting_sandbox", vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
    std::nullopt, std::nullopt, std::nullopt, now }));

    seed (unit ("bytes") (
    keywords ({ "ram", "oom" }) (ConfigEntry{ "scriptMemoryLimit",
    std::to_string (vayu::core::constants::script_engine::MEMORY_LIMIT), "integer", "Script Memory Limit",
    "Largest heap one script execution may allocate before it is aborted. "
    "Raise "
    "it only for a script that processes very large data structures.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::MEMORY_LIMIT),
    "1048576",   // 1MB
    "268435456", // 256MB
    std::nullopt, now })));

    seed (advanced (
    unit ("bytes") (keywords ({ "recursion" }) (ConfigEntry{ "scriptStackSize",
    std::to_string (vayu::core::constants::script_engine::STACK_SIZE), "integer", "Script Stack Size",
    "Depth of the call stack one script execution may use. Raise it only for a "
    "script that recurses deeply enough to overflow.",
    "scripting_sandbox", std::to_string (vayu::core::constants::script_engine::STACK_SIZE),
    "65536",   // 64KB
    "1048576", // 1MB
    std::nullopt, now }))));
}

} // namespace vayu::db::config_seeds
