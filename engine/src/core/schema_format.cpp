/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/schema_format.cpp
 * @brief The `format` predicates behind `find_format_checker` (issue #2581).
 *        See the header for why they exist and why they are not regexes.
 */

#include "vayu/core/schema_format.hpp"

#include "vayu/utils/parse.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <string_view>

namespace vayu::core {

namespace {

// RFC 1035 / RFC 5321 limits.
constexpr size_t MAX_HOSTNAME_BYTES = 253;
constexpr size_t MAX_LABEL_BYTES    = 63;
constexpr size_t MAX_LOCAL_BYTES    = 64;
constexpr size_t MAX_ADDRESS_BYTES  = 254;

constexpr size_t IPV6_GROUPS        = 8;
constexpr size_t IPV6_GROUP_MAX_HEX = 4;
constexpr size_t IPV6_GROUPS_BESIDE_GAP = 7; // "::" stands for at least one group
constexpr size_t IPV4_OCTET_MAX_DIGITS = 3;
constexpr int IPV4_OCTET_MAX           = 255;
constexpr size_t IPV4_OCTETS           = 4;

// RFC 5322 atext beyond letters and digits.
constexpr std::string_view ATEXT_SYMBOLS = "!#$%&'*+/=?^_`{|}~-";

// The bytes are tested by range rather than through <cctype>, whose answer for
// a byte above 127 depends on the process locale.
constexpr bool is_alpha (char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

constexpr bool is_digit (char c) {
    return c >= '0' && c <= '9';
}

constexpr bool is_hex (char c) {
    return is_digit (c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

bool is_one_of (char c, std::string_view set) {
    return set.find (c) != std::string_view::npos;
}

/// Whether every @p separator-delimited part of @p text satisfies @p accepts.
/// An empty text is one empty part, and a trailing separator ends in one.
template <typename Predicate>
bool every_part (std::string_view text, char separator, Predicate accepts) {
    for (;;) {
        const auto cut = text.find (separator);
        if (!accepts (text.substr (0, cut))) {
            return false;
        }
        if (cut == std::string_view::npos) {
            return true;
        }
        text.remove_prefix (cut + 1);
    }
}

// --- hostname (RFC 1123) and email (RFC 5321 addr-spec) ----------------------

bool is_hostname_label (std::string_view label) {
    return !label.empty () && label.size () <= MAX_LABEL_BYTES &&
    label.front () != '-' && label.back () != '-' &&
    std::ranges::all_of (
    label, [] (char c) { return is_alpha (c) || is_digit (c) || c == '-'; });
}

bool is_hostname (std::string_view text) {
    return text.size () <= MAX_HOSTNAME_BYTES && every_part (text, '.', is_hostname_label);
}

bool is_dot_atom_part (std::string_view part) {
    return !part.empty () && std::ranges::all_of (part, [] (char c) {
        return is_alpha (c) || is_digit (c) || is_one_of (c, ATEXT_SYMBOLS);
    });
}

/// `local@domain` with a dot-atom local part and a hostname domain. A quoted
/// local part and a bracketed address literal are legal and not accepted.
bool is_email (std::string_view text) {
    const auto at = text.rfind ('@');
    if (at == std::string_view::npos || text.size () > MAX_ADDRESS_BYTES) {
        return false;
    }
    const auto local = text.substr (0, at);
    return local.size () <= MAX_LOCAL_BYTES &&
    every_part (local, '.', is_dot_atom_part) && is_hostname (text.substr (at + 1));
}

// --- uuid (RFC 4122 section 3) ----------------------------------------------

bool is_uuid (std::string_view text) {
    constexpr std::string_view SHAPE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    return std::ranges::equal (text, SHAPE,
    [] (char c, char shape) { return shape == '-' ? c == '-' : is_hex (c); });
}

// --- uri (RFC 3986 section 3) -------------------------------------------------

bool is_uri_scheme (std::string_view scheme) {
    return !scheme.empty () && is_alpha (scheme.front ()) &&
    std::ranges::all_of (scheme,
    [] (char c) { return is_alpha (c) || is_digit (c) || is_one_of (c, "+-."); });
}

bool is_uri_character (char c) {
    return is_alpha (c) || is_digit (c) || is_one_of (c, "-._~:/?#[]@!$&'()*+,;=%");
}

/// Every `%` is followed by two hex digits.
bool has_whole_escapes (std::string_view text) {
    for (auto at = text.find ('%'); at != std::string_view::npos;
    at           = text.find ('%', at + 1)) {
        const auto digits = text.substr (at + 1, 2);
        if (digits.size () != 2 || !std::ranges::all_of (digits, is_hex)) {
            return false;
        }
    }
    return true;
}

/// An absolute URI: a scheme, then a run of URI characters with whole escapes
/// and at most one fragment. The authority and path are not parsed further.
bool is_uri (std::string_view text) {
    const auto colon = text.find (':');
    if (colon == std::string_view::npos || !is_uri_scheme (text.substr (0, colon))) {
        return false;
    }
    const auto rest = text.substr (colon + 1);
    return std::ranges::all_of (rest, is_uri_character) &&
    has_whole_escapes (rest) && std::ranges::count (rest, '#') <= 1;
}

// --- ipv6 (RFC 4291 section 2.2) ------------------------------------------------

bool is_ipv4_octet (std::string_view part) {
    if (part.empty () || part.size () > IPV4_OCTET_MAX_DIGITS ||
    !std::ranges::all_of (part, is_digit) || (part.size () > 1 && part.front () == '0')) {
        return false;
    }
    const auto value = vayu::utils::parse_number<int> (part);
    return value && *value <= IPV4_OCTET_MAX;
}

bool is_dotted_ipv4 (std::string_view text) {
    return std::ranges::count (text, '.') == IPV4_OCTETS - 1 &&
    every_part (text, '.', is_ipv4_octet);
}

bool is_ipv6_group (std::string_view group) {
    return !group.empty () && group.size () <= IPV6_GROUP_MAX_HEX &&
    std::ranges::all_of (group, is_hex);
}

/// The 16-bit groups in @p part, a run of `:`-separated groups holding no
/// `::`; a dotted IPv4 tail counts as two. Nothing when @p part is malformed.
std::optional<size_t> ipv6_group_count (std::string_view part, bool may_end_in_ipv4) {
    size_t groups = 0;
    if (may_end_in_ipv4) {
        const auto last_colon = part.rfind (':');
        const auto tail =
        last_colon == std::string_view::npos ? part : part.substr (last_colon + 1);
        if (tail.find ('.') != std::string_view::npos) {
            if (last_colon == 0 || !is_dotted_ipv4 (tail)) {
                return std::nullopt;
            }
            groups = 2;
            part = last_colon == std::string_view::npos ? std::string_view () :
                                                          part.substr (0, last_colon);
        }
    }
    if (part.empty ()) {
        return groups;
    }
    const bool well_formed = every_part (part, ':', [&groups] (std::string_view group) {
        ++groups;
        return is_ipv6_group (group);
    });
    return well_formed ? std::optional<size_t> (groups) : std::nullopt;
}

bool is_ipv6 (std::string_view text) {
    const auto gap = text.find ("::");
    if (gap == std::string_view::npos) {
        return ipv6_group_count (text, true) == IPV6_GROUPS;
    }
    // A second "::" or a ":::" leaves an empty group in one of the halves.
    const auto before = ipv6_group_count (text.substr (0, gap), false);
    const auto after  = ipv6_group_count (text.substr (gap + 2), true);
    return before && after && *before + *after <= IPV6_GROUPS_BESIDE_GAP;
}

constexpr std::array<FormatChecker, 5> CHECKERS{ {
{ "email", "email address", is_email },
{ "uri", "URI", is_uri },
{ "uuid", "UUID", is_uuid },
{ "hostname", "hostname", is_hostname },
{ "ipv6", "IPv6 address", is_ipv6 },
} };

} // namespace

const FormatChecker* find_format_checker (std::string_view format) {
    const auto found = std::ranges::find (CHECKERS, format, &FormatChecker::name);
    return found == CHECKERS.end () ? nullptr : &*found;
}

} // namespace vayu::core
