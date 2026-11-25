#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The default User-Agent, declared away from the version it is built
 *        from (issue #659 item 5).
 *
 * `constants.hpp` is reached transitively by essentially every translation unit
 * (`types.hpp`, `utils/logger.hpp`, `utils/json.hpp` and `http/client.hpp` all
 * include it), so a `"Vayu/" VAYU_VERSION_STRING` spelled there would make that
 * header include `vayu/version.hpp`, and **a version bump would edit a header
 * in every TU's preprocessed input**, invalidating the whole compile cache:
 * every release would rebuild the engine from scratch on all three platforms,
 * sccache at a 0% hit rate by construction.
 *
 * So the version stays behind a declaration: this header names the symbol and
 * includes nothing, `user_agent.cpp` is the single TU that pastes the version
 * into it, and a bump recompiles that file plus the handful that include
 * `vayu/version.hpp` directly (daemon, cli, client, server, the health route).
 *
 * It is not `constexpr`, because a `constexpr` cannot hide its initialiser from
 * the header; nothing needs a compile-time value, since the member that reads
 * it (`DefaultHeaderPolicy::user_agent`, which the three driver configs each
 * hold one of) copies it into a `std::string` at construction.
 * `const char* const` with a constant initialiser is constant-initialised, so
 * there is no static-initialisation-order question either.
 *
 * `constants.hpp` includes this header, so the fully qualified name and every
 * call site stay as they are; `version_isolation_test.cpp` is the guard that
 * keeps the version from drifting back in.
 */

namespace vayu::core::constants::defaults {

/// Default User-Agent header string - "Vayu/<version>". Defined in
/// `src/core/user_agent.cpp`, the only TU that sees `VAYU_VERSION_STRING` for it.
extern const char* const DEFAULT_USER_AGENT;

} // namespace vayu::core::constants::defaults
