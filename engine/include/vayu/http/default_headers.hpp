#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/user_agent.hpp"
#include "vayu/types.hpp"

namespace vayu::db {
class Database;
} // namespace vayu::db

/**
 * @file default_headers.hpp
 * @brief What Vayu adds to a request nobody wrote it into - one set, one place.
 *
 * Before issue #1229 two of these were the renderer's: it wrote
 * `X-Vayu-Version` and a fresh `X-Request-ID` into the payload at send time and
 * into the request document at save time, so a stored request carried a frozen
 * correlation id that a load run then replayed on every iteration, and the same
 * request went out with a different header set depending on which client sent
 * it. The engine is the one layer every send passes through, so the defaults
 * live here and the clients only *display* them.
 *
 * The rules, which are what makes this set safe to add to a request the user
 * did not write:
 *
 * - **A user header of the same name wins.** Nothing here overwrites a name the
 *   request already carries, so a browser's `User-Agent` or a hand-typed
 *   correlation id is sent as typed.
 * - **Every one of them is refusable per send** (`Request::suppressed_default_headers`),
 *   so a testing tool can send exactly the request that was written, including
 *   one with no `User-Agent` at all.
 * - **Nothing here is stored.** These are applied at send time from config, so
 *   they cannot go stale in a saved request the way the renderer's copies did.
 * - **The correlation id is namespaced and off by default.** `X-Request-ID` is
 *   a public name gateways give their own meaning to; the default here is
 *   `X-Vayu-Request-Id`, and the name is configurable for a server that reads
 *   another one.
 */
namespace vayu::http {

/// Config key: send a correlation id header at all. Boolean, default false.
inline constexpr std::string_view CORRELATION_ID_ENABLED_KEY =
"correlationIdEnabled";
/// Config key: which header name the correlation id goes out under.
inline constexpr std::string_view CORRELATION_ID_HEADER_KEY =
"correlationIdHeader";
/// Config key: negotiate a compressed response on a design/collection send.
inline constexpr std::string_view NEGOTIATE_COMPRESSION_KEY =
"negotiateCompression";
/// Config key: the same decision for a load run, which measures with it.
inline constexpr std::string_view LOAD_NEGOTIATE_COMPRESSION_KEY =
"loadNegotiateCompression";

/// The vendor-namespaced default, so nothing collides with a gateway's own.
inline constexpr std::string_view DEFAULT_CORRELATION_HEADER =
"X-Vayu-Request-Id";

/**
 * @brief The resolved decision about what this send adds, read from config
 *        once per request or per run rather than per transfer.
 *
 * An empty string is "do not add this one" for every member, so a driver holds
 * one struct instead of a flag beside each value.
 */
struct DefaultHeaderPolicy {
    /// `Vayu/<version>` unless config or a caller emptied it.
    std::string user_agent{ vayu::core::constants::defaults::DEFAULT_USER_AGENT };
    /// The correlation header's name; empty when the id is switched off.
    std::string correlation_header;
    /// The `Accept-Encoding` value to negotiate with; empty for none.
    std::string accept_encoding;
};

/// Which kind of send a policy is being resolved for. The two read different
/// compression keys, because compression changes what a load test measures.
enum class DefaultHeaderScope : std::uint8_t { Design, Load };

/**
 * @brief Read the policy out of the config table.
 *
 * Takes the database rather than a snapshot because config is written while the
 * daemon runs; every caller resolves at the top of a request or a run, never
 * per transfer (`Database`'s own recursive mutex guards each read).
 */
[[nodiscard]] DefaultHeaderPolicy
resolve_default_header_policy (vayu::db::Database& db, DefaultHeaderScope scope);

/**
 * @brief The encodings *this* libcurl can decode, as an `Accept-Encoding` value.
 *
 * Read off `curl_version_info` rather than spelled out, because advertising an
 * encoding the build cannot decode would hand the caller compressed bytes it
 * asked to have decoded. Empty when the build supports none, which switches
 * negotiation off rather than sending an empty header.
 */
[[nodiscard]] const std::string& supported_accept_encodings ();

/// One row of "what the engine will add", for `GET /request-defaults`.
struct DeclaredDefaultHeader {
    /// The header name as it goes on the wire.
    std::string name;
    /// The value, or empty when a fresh one is generated per request.
    std::string value;
    /// The config key that governs it; empty for one that is always on.
    std::string config_key;
    /// True when the value is generated per request rather than fixed.
    bool generated = false;
};

/// What @p policy would add to a request that declares none of these names.
[[nodiscard]] std::vector<DeclaredDefaultHeader> declared_default_headers (
const DefaultHeaderPolicy& policy);

/**
 * @brief Why @p name cannot be a header name the engine adds, or nothing.
 *
 * RFC 9110's token rule, applied at the config write path so a name that would
 * break a header line is refused where it is typed rather than on every send
 * afterwards.
 */
[[nodiscard]] std::optional<std::string> unusable_header_name (std::string_view name);

/**
 * @brief Drop the rows a pre-#1229 client wrote into a stored request, or
 *        nothing when @p headers_json carries none.
 *
 * @param headers_json A request's stored `headers`: a JSON array of
 *        `{key, value, enabled, description?}` rows.
 * @return The rewritten array, or `std::nullopt` when nothing changed - which
 *         is also the answer for text that does not parse as that array, since
 *         a repair pass must not rewrite what it cannot read.
 *
 * Until #1229 the renderer injected `X-Vayu-Version` and a fresh `X-Request-ID`
 * at send time *and* saved them into the request, so a stored request carried a
 * frozen correlation id and the version of the day it was saved - which a load
 * run, a collection run, an export and a generated snippet all then reproduced.
 * Not writing them any more leaves every request saved before that untouched,
 * so they are stripped once, at startup.
 *
 * Three rules, each as narrow as it can be, because this deletes user data:
 *
 * - `X-Vayu-Version` goes unconditionally. The renderer never let it be edited,
 *   so no value of it was ever anyone's.
 * - `X-Request-ID` goes only when its value is a bare UUID, the shape the
 *   renderer generated. A correlation id someone typed stays.
 * - `User-Agent` goes only when its value is a `Vayu/...`. A browser's or a
 *   crawler's `User-Agent` is exactly the header a testing tool exists to send.
 */
[[nodiscard]] std::optional<std::string> strip_legacy_managed_headers (
const std::string& headers_json);

/// Did this send opt @p name out? Case-insensitive, like every header name.
[[nodiscard]] bool suppresses_default_header (const Request& request, std::string_view name);

/**
 * @brief Does this transfer ask for a compressed response?
 *
 * Read by the drivers, which set `CURLOPT_ACCEPT_ENCODING`, and by
 * `build_request_header_list`, which records the header libcurl will write from
 * it. One predicate, so the sent record cannot claim an encoding the transfer
 * did not ask for. A request carrying its own `Accept-Encoding` is left alone:
 * libcurl then sends that line verbatim and hands back what arrives, undecoded,
 * which is what someone typing the header themselves is asking for.
 */
[[nodiscard]] bool negotiates_compression (const Request& request,
const DefaultHeaderPolicy& policy);

} // namespace vayu::http
