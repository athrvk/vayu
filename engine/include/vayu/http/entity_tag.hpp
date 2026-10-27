#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/entity_tag.hpp
 * @brief The `ETag` a whole-record resource carries and the `If-Match` a PUT
 *        may send back (#2433).
 */

#include <algorithm>
#include <cstdint>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::http {

/**
 * `W/"<updatedAt>"`. Weak because a row's answer also carries members its
 * `updatedAt` does not version (a request's derived file trust).
 */
inline std::string entity_tag (int64_t updated_at) {
    return "W/\"" + std::to_string (updated_at) + "\"";
}

namespace detail {

constexpr bool is_optional_whitespace (char c) {
    return c == ' ' || c == '\t';
}

inline void skip_list_separators (std::string_view& rest) {
    while (!rest.empty () &&
    (is_optional_whitespace (rest.front ()) || rest.front () == ',')) {
        rest.remove_prefix (1);
    }
}

/// RFC 9110 `etagc`: `%x21 / %x23-7E / obs-text`.
constexpr bool is_entity_tag_char (char c) {
    const auto byte = static_cast<unsigned char> (c);
    return byte == 0x21 || (byte >= 0x23 && byte != 0x7F);
}

/**
 * Takes one `entity-tag` off the front of @p rest and answers its
 * `opaque-tag`, quotes included and `W/` dropped, or nothing when the front
 * is not one.
 */
inline std::optional<std::string_view> take_opaque_tag (std::string_view& rest) {
    if (rest.starts_with ("W/")) {
        rest.remove_prefix (2);
    }
    if (rest.empty () || rest.front () != '"') {
        return std::nullopt;
    }
    const auto closing = rest.find ('"', 1);
    if (closing == std::string_view::npos) {
        return std::nullopt;
    }
    const auto opaque = rest.substr (0, closing + 1);
    if (!std::ranges::all_of (opaque.substr (1, closing - 1), is_entity_tag_char)) {
        return std::nullopt;
    }
    rest.remove_prefix (closing + 1);
    return opaque;
}

} // namespace detail

/**
 * A parsed `If-Match`: `*`, or the entity tags it lists. Compared weakly,
 * where RFC 9110 13.1.1 asks for the strong function, which no `W/` tag
 * passes and every tag this engine issues is weak.
 */
class IfMatch {
    public:
    /**
     * @p field is every `If-Match` line of a request joined with commas.
     * Empty list elements are skipped (RFC 9110 5.6.1.2); anything else that
     * is not `*` or an entity tag is refused with the reason.
     */
    static std::expected<IfMatch, std::string> parse (std::string_view field) {
        IfMatch parsed;
        std::string_view rest = field;
        detail::skip_list_separators (rest);
        if (rest.starts_with ('*') && is_list_end (rest.substr (1))) {
            parsed.any_ = true;
            return parsed;
        }
        while (!rest.empty ()) {
            const auto opaque = detail::take_opaque_tag (rest);
            if (!opaque || !is_element_end (rest)) {
                return std::unexpected (std::string (MALFORMED));
            }
            parsed.opaque_tags_.emplace_back (*opaque);
            detail::skip_list_separators (rest);
        }
        if (parsed.opaque_tags_.empty ()) {
            return std::unexpected (std::string (MALFORMED));
        }
        return parsed;
    }

    /// Whether a row last written at @p updated_at satisfies the condition.
    [[nodiscard]] bool holds_for (int64_t updated_at) const {
        if (any_) {
            return true;
        }
        const std::string current = "\"" + std::to_string (updated_at) + "\"";
        return std::ranges::find (opaque_tags_, current) != opaque_tags_.end ();
    }

    private:
    static constexpr std::string_view MALFORMED =
    "If-Match must be * or a comma-separated list of entity tags, such as "
    "W/\"1700000000000\" (the ETag the record was read with)";

    /// After a tag: the end, or optional whitespace up to a comma or the end.
    static bool is_element_end (std::string_view rest) {
        const auto next = rest.find_first_not_of (" \t");
        return next == std::string_view::npos || rest.substr (next).starts_with (',');
    }

    /// Nothing but separators: `*` must stand alone.
    static bool is_list_end (std::string_view rest) {
        detail::skip_list_separators (rest);
        return rest.empty ();
    }

    bool any_ = false;
    std::vector<std::string> opaque_tags_;
};

} // namespace vayu::http
