#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/stream_content_marker.hpp
 * @brief A request's first content marker (#3774): a literal byte string a
 *        bounded stream's `StreamTally` watches the wire for, so a run can
 *        time the first content an API sends rather than its first event.
 *
 * Compiled once per request and shared, immutable, by every transfer that
 * sends it; a transfer keeps only how many of the marker's bytes it has
 * matched so far. The scan is Knuth-Morris-Pratt: a mismatch falls back
 * through `fallback_` instead of restarting at the next byte, so a partial
 * match survives any chunk boundary and a near miss ("aa" before "aab")
 * cannot step over the real match. `advance` runs inside libcurl's write
 * callback, so it allocates nothing and throws nothing.
 */

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::http {

class StreamContentMarker {
    public:
    /// @throws std::invalid_argument for an empty @p marker, which would
    ///         match before any byte arrived.
    explicit StreamContentMarker (std::string marker)
    : marker_ (std::move (marker)), fallback_ (marker_.size (), 0) {
        if (marker_.empty ()) {
            throw std::invalid_argument (
            "A stream's first content marker cannot be empty");
        }
        std::size_t border = 0;
        for (std::size_t i = 1; i < marker_.size (); ++i) {
            while (border > 0 && marker_[i] != marker_[border]) {
                border = fallback_[border - 1];
            }
            if (marker_[i] == marker_[border]) {
                ++border;
            }
            fallback_[i] = border;
        }
    }

    /**
     * Scan @p chunk on from @p matched, the marker bytes the transfer's
     * earlier chunks ended on (0 before the first); true at the byte that
     * completes the marker, and the scan stops there. The caller feeds it no
     * more once it has answered true, which leaves @p matched below the
     * marker's length on every call.
     */
    [[nodiscard]] bool advance (std::size_t& matched, std::string_view chunk) const noexcept {
        for (const char byte : chunk) {
            while (matched > 0 && marker_[matched] != byte) {
                matched = fallback_[matched - 1];
            }
            if (marker_[matched] == byte) {
                ++matched;
            }
            if (matched == marker_.size ()) {
                return true;
            }
        }
        return false;
    }

    private:
    std::string marker_;
    /// `fallback_[i]`: the length of the longest proper prefix of
    /// `marker_[0..i]` that is also a suffix of it, where a mismatch after
    /// `i + 1` matched bytes resumes.
    std::vector<std::size_t> fallback_;
};

} // namespace vayu::http
