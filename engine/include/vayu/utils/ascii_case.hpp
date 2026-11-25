#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The engine's one ASCII lower-case fold (#1060).
 *
 * One primitive rather than a fold written at each site, because a hand-rolled
 * copy of a primitive does not receive the primitive's fixes: a fold that
 * passes a plain `char` to `::tolower` is undefined behaviour on a byte above
 * 127 wherever `char` is signed, which a cast at every other site does not
 * repair.
 *
 * ASCII is in the name because it is the contract, not an omission. Every
 * caller folds a header name, a URL scheme, a MIME type, a hostname or a
 * log-level word - all ASCII by their own specifications - and a locale-aware
 * fold would be the wrong answer for each: `std::tolower` reads the global C
 * locale, so what it does to a byte above 127 is whatever the last caller of
 * `std::setlocale` in the process decided. Folding the twenty-six letters and
 * leaving every other byte exactly as it was needs no `unsigned char` cast to
 * state, because it never reaches a function that has one as a precondition.
 *
 * Three entry points, because callers ask three questions: a character (a
 * comparator, a loop that builds a string a byte at a time), a whole string
 * (most callers), and whether two strings match with neither lowered copy built
 * (`vayu::CaseInsensitiveLess`, a header-name comparison). They agree by
 * construction - the string and the comparison are both written in terms of the
 * character fold. `ascii_upper` is the same fold the other way, for an HTTP
 * method name.
 */

#include <algorithm>
#include <string>
#include <string_view>

namespace vayu::utils {

/**
 * @brief @p c lowered if it is an ASCII upper-case letter, unchanged otherwise.
 *
 * The range test is written on the `char` itself rather than on an
 * `unsigned char` cast of it, and that is what makes the byte above 127 safe
 * on both signings: where `char` is signed such a byte is negative and fails
 * `c >= 'A'`; where it is unsigned it exceeds `'Z'` and fails `c <= 'Z'`.
 * Either way it comes back as it went in.
 */
constexpr char ascii_lower (char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char> (c - 'A' + 'a') : c;
}

/**
 * @brief @p text with every ASCII upper-case letter lowered.
 *
 * One allocation, the string a caller would build to fold anyway. A caller that
 * only wants to know whether two strings match wants `ascii_lower_equal`
 * instead, which builds nothing.
 */
inline std::string ascii_lower (std::string_view text) {
    std::string lowered (text);
    std::transform (lowered.begin (), lowered.end (), lowered.begin (),
    [] (char c) { return ascii_lower (c); });
    return lowered;
}

/// @brief @p c raised if it is an ASCII lower-case letter, unchanged
/// otherwise; the mirror of `ascii_lower`, safe on a byte above 127 the same
/// way.
constexpr char ascii_upper (char c) {
    return (c >= 'a' && c <= 'z') ? static_cast<char> (c - 'a' + 'A') : c;
}

/// @brief @p text with every ASCII lower-case letter raised - locale-free,
/// unlike `std::toupper`.
inline std::string ascii_upper (std::string_view text) {
    std::string raised (text);
    std::transform (raised.begin (), raised.end (), raised.begin (),
    [] (char c) { return ascii_upper (c); });
    return raised;
}

/**
 * @brief Whether @p a and @p b are the same string under the ASCII fold.
 *
 * The comparison neither lowers nor allocates: it is the answer a per-character
 * header-name comparison needs, and the one `vayu::CaseInsensitiveLess::equal`
 * gives the callers that compare a name outside the `Headers` map.
 */
inline bool ascii_lower_equal (std::string_view a, std::string_view b) {
    return a.size () == b.size () &&
    std::equal (a.begin (), a.end (), b.begin (),
    [] (char l, char r) { return ascii_lower (l) == ascii_lower (r); });
}

} // namespace vayu::utils
