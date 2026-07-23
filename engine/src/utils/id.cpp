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

std::string generate_id (const char* prefix) {
    // Two 64-bit draws supply the 128 bits of the UUID.
    std::mt19937_64& rng = thread_rng ();
    uint64_t hi          = rng ();
    uint64_t lo          = rng ();

    std::array<uint8_t, 16> bytes{};
    for (size_t i = 8; i-- > 0;) {
        bytes[i]     = static_cast<uint8_t> (hi & 0xFF);
        bytes[i + 8] = static_cast<uint8_t> (lo & 0xFF);
        hi >>= 8;
        lo >>= 8;
    }

    // RFC 4122: version 4 in the high nibble of byte 6, variant 10xx in byte 8.
    bytes[6] = static_cast<uint8_t> ((bytes[6] & 0x0F) | 0x40);
    bytes[8] = static_cast<uint8_t> ((bytes[8] & 0x3F) | 0x80);

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
