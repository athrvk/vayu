#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/schema_format.hpp
 * @brief The JSON Schema `format` checkers valijson does not have (issue #2581).
 *
 * valijson asserts `format` for `date`, `time`, `date-time` and `ipv4` and
 * treats every other name as an annotation, so `{"format": "email"}` passed
 * `"not-an-email"` and a contract or a `jsonSchema` assertion that relied on it
 * reported a clean body. valijson has no checker table to extend; its one
 * extension point is a custom constraint, which `schema_validation.cpp` adds
 * beside the built-in one for the names listed here. A name absent from the
 * table stays an annotation, as the specification allows (`int64`, `binary`,
 * `uri-reference`, ...), and the four valijson already checks are deliberately
 * not repeated, so a failure is reported once.
 *
 * Each checker is a plain predicate over the string, written against the RFC
 * its name cites rather than as a regular expression: `std::regex` recurses per
 * input character and the strings checked are a response body's.
 */

#include <string_view>

namespace vayu::core {

/// One checked `format`: its name, the noun a failure message uses ("a valid
/// email address") and the predicate deciding a string.
struct FormatChecker {
    std::string_view name;
    std::string_view noun;
    bool (*accepts) (std::string_view value);
};

/// The checker for @p format, or `nullptr` when the name is an annotation
/// (unknown, or one valijson checks itself). Names are case-sensitive, as in
/// the specification.
const FormatChecker* find_format_checker (std::string_view format);

} // namespace vayu::core
