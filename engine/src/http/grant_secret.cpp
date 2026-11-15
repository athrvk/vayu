/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/grant_secret.hpp"

#include <sodium.h>

#include <cstdlib>
#include <memory>
#include <string>

#include "vayu/utils/logger.hpp"
#include "vayu/utils/sha256.hpp"

namespace vayu::http {

GrantSecret::GrantSecret (std::string_view value) {
    if (value.size () >= GRANT_SECRET_MIN_LENGTH) {
        digest_ = vayu::utils::sha256 (value);
    }
}

bool GrantSecret::admits (std::string_view presented) const {
    if (!digest_) {
        return false;
    }
    const auto candidate = vayu::utils::sha256 (presented);
    return sodium_memcmp (candidate.data (), digest_->data (), candidate.size ()) == 0;
}

namespace {

/// The value of @p name, copied out, or empty when it is unset. MSVC
/// deprecates `std::getenv` (C4996), so Windows reads through `_dupenv_s`.
///
/// On POSIX the bytes `getenv` returns are the environment block the kernel
/// handed this process (`/proc/<pid>/environ` is that memory, not the
/// `environ` pointer array), so `unsetenv` alone leaves the value readable
/// there for the process's life. The original is overwritten here, before the
/// caller unsets it. Windows has no such view: `_dupenv_s` hands back a copy
/// that is wiped below, and the block it came from is process-private.
std::string read_environment (const char* name) {
#ifdef _WIN32
    char* value        = nullptr;
    std::size_t length = 0;
    if (_dupenv_s (&value, &length, name) != 0 || value == nullptr) {
        return {};
    }
    const std::unique_ptr<char, decltype (&std::free)> owned (value, &std::free);
    std::string copy (owned.get ());
    sodium_memzero (owned.get (), copy.size ());
    return copy;
#else
    // Read before any thread exists (see the declaration), so nothing can be
    // writing the environment underneath this read.
    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    const char* value = std::getenv (name);
    if (value == nullptr) {
        return {};
    }
    std::string copy (value);
    // The one write to a `getenv` result: the block is writable process
    // memory, and `const` is only the standard's promise about the caller.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast)
    sodium_memzero (const_cast<char*> (value), copy.size ());
    return copy;
#endif
}

/// Remove @p name from this process's environment.
void remove_from_environment (const char* name) {
#ifdef _WIN32
    // An empty value removes the variable, from the CRT's copy and the
    // process environment block alike.
    static_cast<void> (_putenv_s (name, ""));
#else
    // The engine's one environment write; `take_grant_secret_from_environment`
    // runs before any thread exists, so no `getenv` can race it.
    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    static_cast<void> (unsetenv (name));
#endif
}

} // namespace

GrantSecret take_grant_secret_from_environment () {
    std::string raw    = read_environment (GRANT_SECRET_ENV);
    const bool present = !raw.empty ();
    GrantSecret secret = present ? GrantSecret (raw) : GrantSecret ();
    sodium_memzero (raw.data (), raw.size ());
    remove_from_environment (GRANT_SECRET_ENV);

    if (!present) {
        vayu::utils::log_info ("startup",
        std::string ("No ") + GRANT_SECRET_ENV +
        ": adding or removing a picked file or an allowed folder is refused "
        "(403); files under folders already allowed are still sent");
    } else if (!secret.configured ()) {
        vayu::utils::log_warning ("startup",
        std::string ("Ignoring ") + GRANT_SECRET_ENV + ": shorter than " +
        std::to_string (GRANT_SECRET_MIN_LENGTH) +
        " characters. Adding or removing a picked file or an allowed folder "
        "is refused (403)");
    }
    return secret;
}

} // namespace vayu::http
