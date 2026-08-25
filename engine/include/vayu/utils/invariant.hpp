#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/invariant.hpp
 * @brief Reading an optional whose engagement a rule in *another* function
 *        guarantees (issue #943).
 *
 * Three shapes of `std::optional` access exist in this engine. Two need
 * nothing: an optional a local guard has already tested, and one whose
 * emptiness is a case the code handles. The third is this one - a producer that
 * sets two fields together, a validation pass that ran under the same held DB
 * mutex, a list built only from the entries that had an identity. The proof is
 * real and it is somewhere else, where neither the next reader nor
 * `bugprone-unchecked-optional-access` can see it.
 *
 * Writing `*opt` there is undefined behaviour the day the rule breaks, and
 * `.value()` is no better as documentation: it names no rule, and the check
 * reports it too, so silencing it costs a `NOLINT` per site with the invariant
 * in a comment nothing executes. This states the rule as an argument instead:
 * the access is guarded here, where the check can follow it, and a broken rule
 * throws `std::logic_error` naming the rule that broke rather than reading an
 * empty optional.
 *
 * It is for invariants only. An optional that can legitimately be empty - a
 * missing row, an absent field, anything a client can cause - is handled, never
 * asserted: those callers keep their `if`, their 404 and their default.
 */

#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace vayu::utils {

/**
 * @brief The value of an optional an invariant says is engaged.
 * @param value The optional to read.
 * @param invariant The rule that makes it engaged, in the words a reader who
 *        hits the throw would need - what holds it, and where.
 * @throws std::logic_error naming @p invariant when the rule has broken.
 */
template <typename T>
const T& invariant_value (const std::optional<T>& value, std::string_view invariant) {
    if (!value.has_value ()) {
        throw std::logic_error ("broken invariant: " + std::string (invariant));
    }
    return *value;
}

/**
 * @brief The same, for an optional that is a temporary - a lookup's return
 *        value read straight into a row.
 *
 * Returns by value rather than by reference: a reference into a temporary would
 * dangle at the end of the full expression, which is exactly the call this
 * overload exists to serve.
 */
template <typename T>
T invariant_value (std::optional<T>&& value, std::string_view invariant) {
    if (!value.has_value ()) {
        throw std::logic_error ("broken invariant: " + std::string (invariant));
    }
    return std::move (*value);
}

} // namespace vayu::utils
