/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/id.hpp"

#include <array>
#include <chrono>
#include <cstdint>
#include <random>
#include <string_view>

namespace vayu::utils {

namespace {

// One PRNG per thread: concurrent generators never contend on a lock or share
// mutable state, which is what makes the thread-safety test pass. Seeded from
// std::random_device and XOR-folded with a steady_clock reading as belt and
// braces - some libstdc++/libc++ targets ship a random_device that is thin or
// even deterministic, and the time term keeps two threads that seed in the same
// instant from marching in lockstep.
std::mt19937_64& thread_rng () {
    static thread_local std::mt19937_64 rng = [] {
        std::random_device rd;
        uint64_t seed =
        (static_cast<uint64_t> (rd ()) << 32) ^ static_cast<uint64_t> (rd ());
        const auto now = static_cast<uint64_t> (
        std::chrono::steady_clock::now ().time_since_epoch ().count ());
        seed ^= now + 0x9e3779b97f4a7c15ULL;
        return std::mt19937_64{ seed };
    }();
    return rng;
}

} // namespace

// Build `prefix` + a canonical version-4 UUID (RFC 4122 section 4.4).
//
// A UUID is 128 bits = 16 bytes, rendered as lowercase hex in 8-4-4-4-12
// groups. Every bit starts random (two 64-bit PRNG draws laid out big-endian),
// then two fields are overwritten so the value advertises itself as "version 4,
// variant 1":
//
//   byte index: 0 1 2 3 | 4 5 | 6 7 | 8 9 | 10 11 12 13 14 15
//   groups:     \__8__/   \4_/  \4_/  \4_/  \_____12______/
//   fixed bits:                 ^byte6 hi nibble = 4   ^byte8 top 2 bits = 10
//
// So the 3rd group always begins with '4' (version) and the 4th with one of
// 8/9/a/b (variant). Those 6 fixed bits are the only non-random ones, leaving
// 128 - 4 - 2 = 122 bits of entropy - the number behind the vanishing collision
// probability that replaces the old millisecond-timestamp scheme.
//
// mt19937_64 is a statistical PRNG, not a CSPRNG: these IDs are database keys
// (they must be unique, not secret), so an adversary predicting them is out of
// scope. If a prefix ever becomes a security token, switch to a CSPRNG.
std::string generate_id (const char* prefix) {
    std::mt19937_64& rng = thread_rng ();
    uint64_t hi          = rng ();
    uint64_t lo          = rng ();

    // Peel one byte at a time off each draw (low byte first, then shift) so the
    // 128 bits land big-endian: hi fills bytes 0-7, lo fills bytes 8-15.
    std::array<uint8_t, 16> bytes{};
    for (size_t i = 8; i-- > 0;) {
        bytes[i]     = static_cast<uint8_t> (hi & 0xFF);
        bytes[i + 8] = static_cast<uint8_t> (lo & 0xFF);
        hi >>= 8;
        lo >>= 8;
    }

    // Stamp the version/variant fields: keep the low nibble of byte 6 and force
    // its high nibble to 4; clear the top two bits of byte 8 and set them to 10.
    bytes[6] = static_cast<uint8_t> ((bytes[6] & 0x0F) | 0x40);
    bytes[8] = static_cast<uint8_t> ((bytes[8] & 0x3F) | 0x80);

    // Emit two hex digits per byte (high nibble then low), inserting the group
    // separators before byte indices 4, 6, 8 and 10 to give 8-4-4-4-12.
    static constexpr std::string_view hex = "0123456789abcdef";
    std::string out = (prefix != nullptr) ? std::string (prefix) : std::string ();
    out.reserve (out.size () + 36);
    for (size_t i = 0; i < bytes.size (); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            out.push_back ('-');
        }
        out.push_back (hex[static_cast<size_t> (bytes[i] >> 4)]);
        out.push_back (hex[static_cast<size_t> (bytes[i] & 0x0F)]);
    }
    return out;
}

} // namespace vayu::utils
