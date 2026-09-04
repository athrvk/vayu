#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file user_agent.hpp
 * @brief The default User-Agent, declared away from the version it is built
 *        from (issue #659 item 5).
 *
 * `DEFAULT_USER_AGENT` used to be a `constexpr` in `core/constants.hpp`,
 * spelled `"Vayu/" VAYU_VERSION_STRING` - which forced that header to include
 * `vayu/version.hpp`. `constants.hpp` is reached transitively by essentially
 * every translation unit (`types.hpp`, `utils/logger.hpp`, `utils/json.hpp` and
 * `http/client.hpp` all include it), so **a version bump edited a header in
 * every TU's preprocessed input** and invalidated the whole compile cache. Every
 * release therefore rebuilt the engine from scratch on all three platforms, with
 * sccache at a 0% hit rate by construction.
 *
 * So the version stays behind a declaration: this header names the symbol and
 * includes nothing, `user_agent.cpp` is the single TU that pastes the version
 * into it, and a bump recompiles that file plus the handful that include
 * `vayu/version.hpp` directly (daemon, cli, client, server, the health route).
 *
 * It is deliberately not `constexpr` any more - a `constexpr` cannot hide its
 * initialiser from the header. The member that reads it
 * (`DefaultHeaderPolicy::user_agent`, which the three driver configs each hold
 * one of) copies it into a `std::string` at construction, so nothing needed a
 * compile-time value.
 * `const char* const` with a constant initialiser is constant-initialised, so
 * there is no static-initialisation-order question either.
 *
 * `constants.hpp` includes this header, so the fully qualified name and every
 * call site are unchanged; `version_isolation_test.cpp` is the guard that keeps
 * the version from drifting back in.
 */

namespace vayu::core::constants::defaults {

/// Default User-Agent header string - "Vayu/<version>". Defined in
/// `src/core/user_agent.cpp`, the only TU that sees `VAYU_VERSION_STRING` for it.
extern const char* const DEFAULT_USER_AGENT;

} // namespace vayu::core::constants::defaults
