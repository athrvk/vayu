#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstddef>
#include <cstdint>

#include "vayu/db/database.hpp"
#include "vayu/runtime/script_engine.hpp"

namespace vayu::core {

/**
 * The deadline a stored `scriptTimeout` resolves to (#2359). A value below
 * the minimum - an old workspace's 0, which used to mean "no limit" - falls
 * back to the default rather than to 1 ms, which would fail every script; a
 * value above the maximum clamps to it.
 */
[[nodiscard]] uint64_t resolve_script_timeout_ms (int64_t stored);

/**
 * The stack size a stored `scriptStackSize` resolves to: clamped into the
 * entry's bounds, a negative value included (it must not wrap through the
 * unsigned conversion into a huge stack).
 */
[[nodiscard]] size_t resolve_script_stack_size (int64_t stored);

/**
 * The `ScriptConfig` every script the engine runs is built from, read from the
 * `scripting_sandbox` config entries through the two resolvers above, so no
 * call site can run a script under a bound the settings route would refuse.
 * `allow_send_request` stays false: it is a property of who asked for the
 * execution, not of the installation (see `ScriptConfig::allow_send_request`).
 * `ScriptEngine` itself does not clamp - an embedder or a test may hand it any
 * value, `timeout_ms` 0 (no deadline) included.
 */
[[nodiscard]] vayu::runtime::ScriptConfig read_script_config (vayu::db::Database& db);

} // namespace vayu::core
