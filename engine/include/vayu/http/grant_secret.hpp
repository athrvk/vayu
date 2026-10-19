#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file grant_secret.hpp
 * @brief The per-start secret that gates every write to file trust (#2356):
 * `POST`/`DELETE /file-grants` and `POST`/`DELETE /file-roots`.
 *
 * The app's main process generates it, passes it in the engine's environment
 * (`VAYU_GRANT_SECRET`) and keeps it from the renderer, so a caller that can
 * reach the API (a script, a compromised renderer, the MCP server, another
 * local process) cannot widen what a request body may send. An engine started
 * without one refuses those writes outright; allowed folders written before
 * then still apply.
 *
 * Only a SHA-256 digest of the secret is held. A presented value is hashed and
 * the digests compared with `sodium_memcmp`, so the comparison takes the same
 * time whatever the value and whatever its length.
 */

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

namespace vayu::http {

/// The request header a gated write carries the secret in.
inline constexpr std::string_view GRANT_SECRET_HEADER = "X-Vayu-Grant-Secret";

/// The environment variable the engine reads the secret from at start.
inline constexpr const char* GRANT_SECRET_ENV = "VAYU_GRANT_SECRET";

/// The shortest value taken as a secret. The app sends 32 random bytes as
/// hex (64 characters); anything shorter than 32 characters is too guessable
/// to gate on and is treated as no secret at all.
inline constexpr std::size_t GRANT_SECRET_MIN_LENGTH = 32;

class GrantSecret {
    public:
    /// No secret: every gated write is refused.
    GrantSecret () = default;

    /// @p value as the secret, or no secret when it is shorter than
    /// `GRANT_SECRET_MIN_LENGTH`. The value itself is not kept.
    explicit GrantSecret (std::string_view value);

    [[nodiscard]] bool configured () const {
        return digest_.has_value ();
    }

    /// True only when a secret is configured and @p presented is it, decided
    /// in constant time.
    [[nodiscard]] bool admits (std::string_view presented) const;

    private:
    std::optional<std::array<std::uint8_t, 32>> digest_;
};

/// The shared "no secret" a holder that was given none refers to.
[[nodiscard]] inline const GrantSecret& no_grant_secret () {
    static const GrantSecret none;
    return none;
}

/**
 * @brief Read `VAYU_GRANT_SECRET`, remove it from this process's environment,
 * and answer the secret it held.
 *
 * The variable is removed whether or not it was usable, so nothing this
 * process later reads or spawns sees it. A value too short to use is reported
 * as a warning that does not include it. Call once, before the daemon starts
 * any thread: the environment is process-shared storage, and this is the one
 * place the engine writes it.
 */
[[nodiscard]] GrantSecret take_grant_secret_from_environment ();

} // namespace vayu::http
