#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/ascii_case.hpp
 * @brief The engine's one ASCII lower-case fold (issue #1060).
 *
 * Twenty-nine sites across nineteen files each wrote the fold themselves, in
 * four spellings: a `std::transform` with a `std::tolower` lambda, the same
 * with an uncast `::tolower`, a hand-written loop over the string, and a
 * per-character equality predicate that never builds a lowered string at all.
 * Nothing about any of them was wrong on the ASCII input every caller has,
 * which is why they accumulated rather than being noticed - but one of them
 * was wrong on any other input, and that is the shape this repo names: a
 * hand-rolled copy of a primitive does not receive the primitive's fixes. The
 * uncast pair passed a plain `char` to `::tolower`, and a `char` holding a
 * byte above 127 is negative where `char` is signed, which is undefined
 * behaviour the other twenty-seven sites cast for.
 *
 * ASCII is in the name because it is the contract, not an omission. Every
 * caller folds a header name, a URL scheme, a MIME type, a hostname or a
 * log-level word - all ASCII by their own specifications - and a locale-aware
 * fold would be the wrong answer for each: `std::tolower` reads the global C
 * locale, so what it does to a byte above 127 is whatever the last caller of
 * `std::setlocale` in the process decided. Folding the twenty-six letters and
 * leaving every other byte exactly as it was is the rule all twenty-nine sites
 * were written to have, and it is a rule that needs no `unsigned char` cast to
 * state, because it never reaches a function that has one as a precondition.
 *
 * Three entry points, because the call sites ask three questions: a character
 * (a comparator, and the two loops that build a string a byte at a time), a
 * whole string (the majority), and whether two strings match with neither
 * lowered copy built (`vayu::CaseInsensitiveLess`, and the four sites that
 * compared header names by hand). They agree by construction - the string and
 * the comparison are both written in terms of the character fold.
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
 * One allocation, which is the one the callers already made: each of them
 * built the string it was about to fold. A caller that only wants to know
 * whether two strings match wants `ascii_lower_equal` instead, which builds
 * nothing.
 */
inline std::string ascii_lower (std::string_view text) {
    std::string lowered (text);
    std::transform (lowered.begin (), lowered.end (), lowered.begin (),
    [] (char c) { return ascii_lower (c); });
    return lowered;
}

/**
 * @brief Whether @p a and @p b are the same string under the ASCII fold.
 *
 * The comparison neither lowers nor allocates: it is the answer the four
 * header-name comparisons here were reaching for when they wrote a
 * per-character predicate, and the answer `vayu::CaseInsensitiveLess::equal`
 * gives the callers that compare a name outside the `Headers` map.
 */
inline bool ascii_lower_equal (std::string_view a, std::string_view b) {
    return a.size () == b.size () &&
    std::equal (a.begin (), a.end (), b.begin (),
    [] (char l, char r) { return ascii_lower (l) == ascii_lower (r); });
}

} // namespace vayu::utils
