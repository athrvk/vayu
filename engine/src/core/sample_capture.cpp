/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/sample_capture.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

namespace vayu::core {

namespace {

/// Media types (or suffixes of them) whose payload is text by definition.
/// Anything else with a declared type is treated as binary without reading a
/// byte, which is what makes `image/png` cheap to classify.
bool text_shaped (std::string_view type) {
    if (type.rfind ("text/", 0) == 0) {
        return true;
    }
    static constexpr std::array<std::string_view, 6> kTextish = { "json", "xml",
        "javascript", "ecmascript", "x-www-form-urlencoded", "csv" };
    return std::any_of (kTextish.begin (), kTextish.end (), [type] (std::string_view needle) {
        return type.find (needle) != std::string_view::npos;
    });
}

/**
 * @brief Validate a bounded prefix as UTF-8, rejecting NUL.
 *
 * A truncated capture can cut a multi-byte sequence in half, so a sequence
 * that runs off the end of the inspected window is *not* a failure - the
 * bytes we did see were well-formed, and the split is an artefact of our own
 * cap rather than anything about the body.
 */
bool prefix_is_utf8_text (std::string_view bytes) {
    const auto* p         = reinterpret_cast<const unsigned char*> (bytes.data ());
    const size_t inspect  = std::min (bytes.size (), SNIFF_BYTES);

    size_t i = 0;
    while (i < inspect) {
        const unsigned char c = p[i];
        if (c == 0x00) {
            return false; // NUL never appears in text; it is the strongest signal.
        }
        size_t extra = 0;
        if (c < 0x80) {
            extra = 0;
        } else if ((c & 0xE0) == 0xC0 && c >= 0xC2) {
            extra = 1;
        } else if ((c & 0xF0) == 0xE0) {
            extra = 2;
        } else if ((c & 0xF8) == 0xF0 && c <= 0xF4) {
            extra = 3;
        } else {
            return false; // continuation byte in leading position, or 0xC0/0xC1/0xF5+
        }

        if (i + extra >= inspect) {
            // The sequence runs past the window. Whatever we have seen so far
            // was valid, so stop here rather than blaming our own cap.
            return true;
        }
        for (size_t k = 1; k <= extra; k++) {
            if ((p[i + k] & 0xC0) != 0x80) {
                return false;
            }
        }
        i += extra + 1;
    }
    return true;
}

} // namespace

std::string media_type (std::string_view content_type) {
    const size_t semi = content_type.find (';');
    std::string_view head =
    semi == std::string_view::npos ? content_type : content_type.substr (0, semi);

    // Trim ASCII whitespace both ends.
    while (!head.empty () && (std::isspace (static_cast<unsigned char> (head.front ())) != 0)) {
        head.remove_prefix (1);
    }
    while (!head.empty () && (std::isspace (static_cast<unsigned char> (head.back ())) != 0)) {
        head.remove_suffix (1);
    }

    std::string out (head);
    std::transform (out.begin (), out.end (), out.begin (), [] (unsigned char ch) {
        return static_cast<char> (std::tolower (ch));
    });
    return out;
}

bool looks_binary (std::string_view body, std::string_view content_type) {
    if (body.empty ()) {
        return false; // Nothing to misread; an empty body is stored as text.
    }

    const std::string type = media_type (content_type);
    if (!type.empty () && !text_shaped (type)) {
        return true;
    }

    // Either no usable header, or one that claims text. The bytes get the last
    // word, because a mislabelled `text/html` gzip stream is exactly the case
    // that corrupts silently.
    return !prefix_is_utf8_text (body);
}

std::string body_digest (std::string_view stored_body) {
    const auto digest = vayu::utils::sha256 (stored_body);
    return vayu::utils::hex_encode (
    std::string_view (reinterpret_cast<const char*> (digest.data ()), digest.size ()));
}

} // namespace vayu::core
