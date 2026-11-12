/**
 * @file tests/string_field_refusal.hpp
 * @brief What a plain string field handed another JSON type must answer (#3482).
 *
 * `apply_string_field` and `apply_required_string_field` (`http/routes.hpp`)
 * back every route that stores a string column, so each route test file drives
 * the same four values through its own core and checks the same answer.
 */

#pragma once

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace vayu::tests {

/** One value of each JSON type a string field is not: number, bool, object, array. */
inline const std::vector<nlohmann::json>& non_string_values () {
    static const std::vector<nlohmann::json> values{ nlohmann::json (42),
        nlohmann::json (true), nlohmann::json::object (), nlohmann::json::array () };
    return values;
}

/**
 * Asserts a core's `{status, body}` is the 400 naming @p field as a string
 * field, with none of nlohmann's exception text in it.
 */
inline void expect_string_field_refused (int status,
const nlohmann::json& body,
const std::string& field,
const nlohmann::json& sent) {
    const std::string text = body.dump ();
    EXPECT_EQ (status, 400) << field << " = " << sent.dump () << " -> " << text;
    EXPECT_NE (text.find ("Invalid '" + field + "': must be a string (got "), std::string::npos)
    << field << " = " << sent.dump () << " -> " << text;
    EXPECT_EQ (text.find ("json.exception"), std::string::npos) << text;
}

} // namespace vayu::tests
