#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The engine's single entry point into libsodium: the one-time init every
// other libsodium call must follow, and the null-pointer guard its nonnull
// parameters need.
//
// sodium_init() seeds the RNG and picks the CPU-dispatched implementations, so
// libsodium requires it to have completed before anything else runs. The
// wrappers in utils/sha256.hpp and utils/encoding.hpp call it themselves rather
// than each entry point doing so, because vayu-engine, vayu-cli and vayu_tests
// all reach those helpers and the next entry point would otherwise have to
// remember.

#include <sodium.h>

#include <stdexcept>
#include <string_view>

namespace vayu::utils {

/**
 * @brief Run sodium_init() exactly once per process; throw if it fails.
 *
 * The function-local static is the once-guard - its initialiser runs once and
 * concurrent callers block until it completes, which is what std::call_once
 * would buy with more machinery. A negative return means libsodium could not
 * initialise itself, which would make every digest computed afterwards
 * untrustworthy, so it throws instead of returning a status a caller can drop.
 */
inline void ensure_sodium_initialized () {
    static const bool ready = [] {
        if (sodium_init () < 0) {
            throw std::runtime_error ("libsodium initialisation failed");
        }
        return true;
    }();
    (void)ready;
}

namespace detail {

/**
 * @brief The bytes of `s` as a pointer libsodium may dereference.
 *
 * libsodium marks its buffer parameters nonnull, and an empty std::string_view
 * is allowed to carry a null data(). Hashing and encoding the empty string are
 * both published vectors, so empty input has to arrive as a valid pointer to
 * zero bytes rather than as nullptr.
 */
inline const unsigned char* sodium_bytes (std::string_view s) {
    static const unsigned char empty = 0;
    // [basic.lval] permits reading any object through a character type, and
    // this is the one place the engine spells that direction of the conversion.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return s.empty () ? &empty : reinterpret_cast<const unsigned char*> (s.data ());
}

} // namespace detail

} // namespace vayu::utils
