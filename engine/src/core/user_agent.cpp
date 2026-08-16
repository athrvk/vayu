/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The one translation unit that pastes the engine version into a string.
 *
 * Keep it that way: including `vayu/version.hpp` from a widely-included header
 * is what made every release rebuild the whole engine (see `user_agent.hpp`).
 */

#include "vayu/core/user_agent.hpp"

#include "vayu/version.hpp"

namespace vayu::core::constants::defaults {

const char* const DEFAULT_USER_AGENT = "Vayu/" VAYU_VERSION_STRING;

} // namespace vayu::core::constants::defaults
