#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/library_call_config.hpp
 * @brief The script stack budget for a test that loads a bundled library.
 */

#include <cstddef>

#include "vayu/runtime/script_engine.hpp"

namespace vayu::tests {

/// Stack budget for a test that loads or calls into a bundled library and
/// asserts what it answers. MSVC at /Od under ASan overflowed the default
/// 256 KB inside lodash and moment (`_.get`, `_.isEqual`, `.format`, and the
/// first `require`), so those answers would depend on a frame size, not on the
/// library. The stack-budget behaviour itself is pinned by
/// RequireShelfLibrariesLoadUnderAShallowInterpreterStack and the restore test
/// after it. Half of the 1 MB stack a Windows thread has.
inline constexpr std::size_t LIBRARY_CALL_STACK_BYTES = std::size_t{ 512 } * 1024;

[[nodiscard]] inline vayu::runtime::ScriptConfig library_call_config () {
    vayu::runtime::ScriptConfig config;
    config.stack_size = LIBRARY_CALL_STACK_BYTES;
    return config;
}

} // namespace vayu::tests
