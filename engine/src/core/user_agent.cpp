/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The one translation unit that pastes the engine version into a string. Keep
 * it so: `vayu/version.hpp` in a widely included header made every release
 * rebuild the whole engine (`user_agent.hpp`).
 */

#include "vayu/core/user_agent.hpp"

#include "vayu/version.hpp"

namespace vayu::core::constants::defaults {

const char* const DEFAULT_USER_AGENT = "Vayu/" VAYU_VERSION_STRING;

} // namespace vayu::core::constants::defaults
