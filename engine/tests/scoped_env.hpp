#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/scoped_env.hpp
 * @brief `ScopedEnv`: one environment variable pinned for a test's length.
 *
 * Shared by `transport_policy_test.cpp` (the proxy variables libcurl reads per
 * transfer) and `file_grants_route_test.cpp` (the grant secret the daemon
 * takes at start).
 */

#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <utility>

namespace vayu::tests {

/// Sets an environment variable for the length of a test and puts it back,
/// which matters because the whole suite shares one process.
class ScopedEnv {
    public:
    ScopedEnv (const char* name, const std::string& value) : name_ (name) {
        if (auto previous = read (name)) {
            had_previous_ = true;
            previous_     = std::move (*previous);
        }
        set (name_.c_str (), value.c_str ());
    }
    ~ScopedEnv () {
        if (had_previous_) {
            set (name_.c_str (), previous_.c_str ());
        } else {
            set (name_.c_str (), "");
        }
    }
    ScopedEnv (const ScopedEnv&)            = delete;
    ScopedEnv& operator= (const ScopedEnv&) = delete;
    ScopedEnv (ScopedEnv&&)                 = delete;
    ScopedEnv& operator= (ScopedEnv&&)      = delete;

    /**
     * The variable's current value, or nullopt when it is unset.
     *
     * MSVC deprecates `std::getenv` in favour of `_dupenv_s` (C4996) and this
     * suite is built `/W4 /WX`, so the deprecation is followed rather than
     * suppressed - the same shape `script_types_test.cpp`'s `env_is_set` uses,
     * and for the same reason: a `#pragma warning(disable)` would be a
     * permanent suppression bought for a one-line read.
     *
     * This class is where `concurrency-mt-unsafe` (#945) has a real point:
     * its `setenv` and `unsetenv` are the suite's environment *writes* (the
     * engine's one is `take_grant_secret_from_environment`, which a test here
     * calls too), and a write is what makes every `getenv` anywhere unsafe.
     * It is silenced rather than fixed because there is no reentrant spelling
     * to move to, and because gtest runs one test body at a time - the scoped
     * write and every read of it are ordered by the suite's own structure. A
     * future test that sets an environment variable from a worker thread would
     * break that, which is what this note is here to stop.
     */
    static std::optional<std::string> read (const char* name) {
#ifdef _WIN32
        char* value   = nullptr;
        size_t length = 0;
        if (_dupenv_s (&value, &length, name) != 0 || value == nullptr) {
            return std::nullopt;
        }
        // Owned rather than freed by hand, for two reasons that point the same
        // way. The `std::string` built from it allocates, so a throw there
        // leaked the buffer in the spelling this replaces; and a bare
        // `std::free` here is `cppcoreguidelines-owning-memory`, reported only
        // by the Windows leg because this branch is the only code in it and no
        // Linux lint ever compiles it (#1023).
        const std::unique_ptr<char, decltype (&std::free)> owned (value, &std::free);
        return std::string (owned.get ());
#else
        // NOLINTNEXTLINE(concurrency-mt-unsafe)
        if (const char* value = std::getenv (name)) {
            return std::string (value);
        }
        return std::nullopt;
#endif
    }

    private:
    static void set (const char* name, const char* value) {
#ifdef _WIN32
        // An empty value removes the variable on Windows, which is what the
        // restore path wants when there was nothing to restore.
        _putenv_s (name, value);
#else
        if (*value == '\0') {
            // NOLINTNEXTLINE(concurrency-mt-unsafe)
            unsetenv (name);
        } else {
            // NOLINTNEXTLINE(concurrency-mt-unsafe)
            setenv (name, value, 1);
        }
#endif
    }
    std::string name_;
    std::string previous_;
    bool had_previous_ = false;
};

} // namespace vayu::tests
