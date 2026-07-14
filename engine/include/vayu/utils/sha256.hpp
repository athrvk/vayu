#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Compact, dependency-free SHA-256 (FIPS 180-4). Used for PKCE code challenges
// (RFC 7636 S256) so the engine does not need to link OpenSSL. Public-domain
// style implementation; not constant-time (not required for PKCE challenges).

#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace vayu::utils {

class Sha256 {
    public:
    Sha256 () {
        reset ();
    }

    void update (const uint8_t* data, size_t len) {
        for (size_t i = 0; i < len; ++i) {
            buffer_[buffer_len_++] = data[i];
            if (buffer_len_ == 64) {
                transform (buffer_.data ());
                bit_len_ += 512;
                buffer_len_ = 0;
            }
        }
    }

    void update (std::string_view s) {
        update (reinterpret_cast<const uint8_t*> (s.data ()), s.size ());
    }

    std::array<uint8_t, 32> digest () {
        std::array<uint8_t, 32> out{};
        finalize (out.data ());
        return out;
    }

    private:
    std::array<uint32_t, 8> state_{};
    std::array<uint8_t, 64> buffer_{};
    size_t buffer_len_ = 0;
    uint64_t bit_len_  = 0;

    void reset () {
        state_      = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
            0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
        buffer_len_ = 0;
        bit_len_    = 0;
    }

    static uint32_t rotr (uint32_t x, uint32_t n) {
        return (x >> n) | (x << (32 - n));
    }

    void transform (const uint8_t* p) {
        static constexpr uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        };

        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t> (p[i * 4]) << 24) |
            (static_cast<uint32_t> (p[i * 4 + 1]) << 16) |
            (static_cast<uint32_t> (p[i * 4 + 2]) << 8) |
            static_cast<uint32_t> (p[i * 4 + 3]);
        }
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 =
            rotr (w[i - 15], 7) ^ rotr (w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 =
            rotr (w[i - 2], 17) ^ rotr (w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
        uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];

        for (int i = 0; i < 64; ++i) {
            const uint32_t S1 = rotr (e, 6) ^ rotr (e, 11) ^ rotr (e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = h + S1 + ch + k[i] + w[i];
            const uint32_t S0 = rotr (a, 2) ^ rotr (a, 13) ^ rotr (a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2  = S0 + maj;
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }

        state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
        state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
    }

    void finalize (uint8_t* out) {
        const uint64_t total_bits = bit_len_ + static_cast<uint64_t> (buffer_len_) * 8;

        // Append 0x80 then pad with zeros to a 56-byte boundary.
        buffer_[buffer_len_++] = 0x80;
        if (buffer_len_ > 56) {
            while (buffer_len_ < 64)
                buffer_[buffer_len_++] = 0;
            transform (buffer_.data ());
            buffer_len_ = 0;
        }
        while (buffer_len_ < 56)
            buffer_[buffer_len_++] = 0;

        for (int i = 7; i >= 0; --i) {
            buffer_[buffer_len_++] =
            static_cast<uint8_t> ((total_bits >> (i * 8)) & 0xff);
        }
        transform (buffer_.data ());

        for (int i = 0; i < 8; ++i) {
            out[i * 4]     = static_cast<uint8_t> ((state_[i] >> 24) & 0xff);
            out[i * 4 + 1] = static_cast<uint8_t> ((state_[i] >> 16) & 0xff);
            out[i * 4 + 2] = static_cast<uint8_t> ((state_[i] >> 8) & 0xff);
            out[i * 4 + 3] = static_cast<uint8_t> (state_[i] & 0xff);
        }
    }
};

inline std::array<uint8_t, 32> sha256 (std::string_view data) {
    Sha256 h;
    h.update (data);
    return h.digest ();
}

} // namespace vayu::utils
