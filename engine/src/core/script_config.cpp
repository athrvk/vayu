/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/script_config.hpp"

#include <algorithm>

#include "vayu/core/constants.hpp"

namespace vayu::core {

namespace script_limits = vayu::core::constants::script_engine;

uint64_t resolve_script_timeout_ms (int64_t stored) {
    if (stored < static_cast<int64_t> (script_limits::SCRIPT_TIMEOUT_MIN_MS)) {
        return script_limits::TIMEOUT_MS;
    }
    return std::min (static_cast<uint64_t> (stored), script_limits::SCRIPT_TIMEOUT_MAX_MS);
}

size_t resolve_script_stack_size (int64_t stored) {
    if (stored < static_cast<int64_t> (script_limits::STACK_SIZE_MIN)) {
        return script_limits::STACK_SIZE_MIN;
    }
    return std::min (static_cast<size_t> (stored), script_limits::STACK_SIZE_MAX);
}

vayu::runtime::ScriptConfig read_script_config (vayu::db::Database& db) {
    vayu::runtime::ScriptConfig config;
    config.timeout_ms   = resolve_script_timeout_ms (db.get_config_int (
    "scriptTimeout", static_cast<int> (script_limits::TIMEOUT_MS)));
    config.memory_limit = static_cast<size_t> (db.get_config_int (
    "scriptMemoryLimit", static_cast<int> (script_limits::MEMORY_LIMIT)));
    config.stack_size   = resolve_script_stack_size (db.get_config_int (
    "scriptStackSize", static_cast<int> (script_limits::STACK_SIZE)));
    config.enable_console =
    db.get_config_bool ("scriptEnableConsole", script_limits::ENABLE_CONSOLE);
    return config;
}

} // namespace vayu::core
