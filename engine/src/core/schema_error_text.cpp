/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/schema_error_text.hpp"

#include "vayu/utils/parse.hpp"

#include <nlohmann/json.hpp>

#include <array>
#include <cmath>
#include <format>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace vayu::core {

namespace {

/** The subschema `pointer` (an RFC 6901 JSON Pointer, e.g. "/range/min")
 *  names, walking only `properties` - see the header's own doc comment for
 *  why that is the whole shape this needs to cover. `nullptr` for a pointer
 *  this cannot resolve, kept as a documented "I don't know" rather than a
 *  crash on a shape a schema might reach through `$ref`. */
const nlohmann::json*
schema_node_at (const nlohmann::json& schema, const std::string& pointer) {
    const nlohmann::json* node = &schema;
    size_t pos                 = 0;
    while (pos < pointer.size ()) {
        const auto slash          = pointer.find ('/', pos + 1);
        const std::string segment = pointer.substr (pos + 1,
        slash == std::string::npos ? std::string::npos : slash - pos - 1);
        if (!node->contains ("properties") || !(*node)["properties"].contains (segment)) {
            return nullptr;
        }
        node = &(*node)["properties"][segment];
        pos  = slash;
    }
    return node;
}

/** @p node's own declared "title", or @p fallback if @p node is null or
 *  names none - an imported response schema may declare no title at all,
 *  where an element kind's own schema always does (issue #1607). */
std::string node_title (const nlohmann::json* node, const std::string& fallback) {
    if (node != nullptr && node->contains ("title") && (*node)["title"].is_string ()) {
        return (*node)["title"].get<std::string> ();
    }
    return fallback;
}

/** A JSON scalar (an `enum` array's own entries) as the text a message
 *  shows: a string bare, anything else its own `dump ()`. */
std::string scalar_text (const nlohmann::json& value) {
    return value.is_string () ? value.get<std::string> () : value.dump ();
}

/** A JSON Schema `"type"` value as an English noun phrase. */
std::string type_word (const std::string& type) {
    if (type == "integer" || type == "number") {
        return "a number";
    }
    if (type == "string") {
        return "text";
    }
    if (type == "boolean") {
        return "true or false";
    }
    if (type == "array") {
        return "a list";
    }
    return "an object";
}

/** "Missing required property 'x'." names the missing field in the text
 *  itself, not the pointer - the pointer names the *container* it belongs
 *  to (the schema root, or a nested object like `range`). */
std::optional<std::string> required_property_rejection (const nlohmann::json& schema,
const std::string& d,
const std::string& pointer) {
    if (d.rfind ("Missing required property '", 0) != 0) {
        return std::nullopt;
    }
    const auto q1 = d.find ('\'');
    const auto q2 = d.find ('\'', q1 + 1);
    const std::string missing =
    q2 == std::string::npos ? std::string () : d.substr (q1 + 1, q2 - q1 - 1);
    const auto* container = schema_node_at (schema, pointer);
    const nlohmann::json* field_node =
    (container != nullptr && container->contains ("properties") &&
    (*container)["properties"].contains (missing)) ?
    &(*container)["properties"][missing] :
    nullptr;
    return std::format ("'{}' is required", node_title (field_node, missing));
}

/** The other shape of the same rule: the unwanted key's own name is the only
 *  place valijson puts it, and there is no title to look up for a property
 *  this schema never declared. */
std::optional<std::string> additional_property_rejection (const std::string& d) {
    if (d.rfind ("Object contains a property that could not be validated using", 0) != 0) {
        return std::nullopt;
    }
    const auto last = d.rfind ('\'');
    const auto first =
    last == std::string::npos ? std::string::npos : d.rfind ('\'', last - 1);
    const std::string extra = first == std::string::npos ?
    std::string () :
    d.substr (first + 1, last - first - 1);
    return std::format ("'{}' is not a setting this element has", extra);
}

/** "Value type not permitted by 'type' constraint." - the schema's own
 *  declared `"type"` at @p node says what was actually expected. */
std::optional<std::string> type_mismatch_rejection (const nlohmann::json* node,
const std::string& title,
const std::string& d) {
    if (d != "Value type not permitted by 'type' constraint." || node == nullptr ||
    !node->contains ("type") || !(*node)["type"].is_string ()) {
        return std::nullopt;
    }
    return std::format (
    "'{}' must be {}", title, type_word ((*node)["type"].get<std::string> ()));
}

/** "Failed to match against any enum values." - the schema's own declared
 *  `"enum"` at @p node lists what was actually accepted. */
std::optional<std::string> enum_value_rejection (const nlohmann::json* node,
const std::string& title,
const std::string& d) {
    if (d != "Failed to match against any enum values." || node == nullptr ||
    !node->contains ("enum") || !(*node)["enum"].is_array ()) {
        return std::nullopt;
    }
    std::string allowed;
    for (const auto& option : (*node)["enum"]) {
        if (!allowed.empty ()) {
            allowed += ", ";
        }
        allowed += scalar_text (option);
    }
    return std::format ("'{}' must be one of [{}]", title, allowed);
}

/** "Failed to match regex specified by 'pattern' constraint." - a raw regex
 *  is not itself English, so this names the field and, where the schema
 *  gives one, its own `"description"` of the expected shape. */
std::optional<std::string> pattern_rejection (const nlohmann::json* node,
const std::string& title,
const std::string& d) {
    if (d != "Failed to match regex specified by 'pattern' constraint.") {
        return std::nullopt;
    }
    if (node != nullptr && node->contains ("description") &&
    (*node)["description"].is_string ()) {
        return std::format ("'{}' is not in the expected format - {}", title,
        (*node)["description"].get<std::string> ());
    }
    return std::format ("'{}' is not in the expected format", title);
}

/** @p text as a `double`, or nothing unless the whole of it is one - the
 *  `monitor.cpp` idiom (`std::stod` plus a consumed-length check), not
 *  `vayu::utils::parse_number<double>`: libc++'s floating-point
 *  `std::from_chars` overload is unavailable before macOS 26 (that pin is
 *  the whole reason `parse_number` exists for integers, but it cannot cover
 *  a type its own backing function does not support on every platform this
 *  engine ships on). */
std::optional<double> parse_double_whole (std::string_view text) {
    const std::string token (text);
    try {
        size_t consumed  = 0;
        const double val = std::stod (token, &consumed);
        if (consumed != token.size () || !std::isfinite (val)) {
            return std::nullopt;
        }
        return val;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

/** `minimum`/`maximum` (inclusive or exclusive): valijson's own message
 *  already ends in exactly the bound, with no trailing text, so the number
 *  is the whole of what follows the matched prefix. */
std::optional<std::string> bound_rejection (const std::string& title, const std::string& d) {
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 4> BOUND_PREFIXES{
        { { "Expected number greater than or equal to ", "must be at least " },
        { "Expected number greater than ", "must be more than " },
        { "Expected number less than or equal to ", "must be at most " },
        { "Expected number less than ", "must be less than " } }
    };
    for (const auto& [prefix, verb] : BOUND_PREFIXES) {
        if (d.rfind (prefix, 0) != 0) {
            continue;
        }
        if (auto n = parse_double_whole (std::string_view (d).substr (prefix.size ()))) {
            return std::format ("'{}' {}{}", title, verb, *n);
        }
    }
    return std::nullopt;
}

/** `minLength`/`maxLength`: valijson's own message wraps the number in a
 *  fixed trailing phrase, unlike the numeric bounds above. */
std::optional<std::string>
length_rejection (const std::string& title, const std::string& d) {
    static constexpr std::string_view LEN_SUFFIX = " characters in length.";
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 2> LEN_PREFIXES{
        { { "String should be no fewer than ", "must be at least " },
        { "String should be no more than ", "can be at most " } }
    };
    for (const auto& [prefix, verb] : LEN_PREFIXES) {
        if (d.rfind (prefix, 0) != 0 || d.size () <= prefix.size () + LEN_SUFFIX.size () ||
        d.compare (d.size () - LEN_SUFFIX.size (), LEN_SUFFIX.size (), LEN_SUFFIX) != 0) {
            continue;
        }
        const std::string number =
        d.substr (prefix.size (), d.size () - prefix.size () - LEN_SUFFIX.size ());
        if (auto n = vayu::utils::parse_number<int> (number)) {
            return std::format ("'{}' {}{} characters", title, verb, *n);
        }
    }
    return std::nullopt;
}

/** The constraints above all name one property directly, read off the node
 *  `error_json_pointer` itself points at (unlike `required`/
 *  `additionalProperties`, which point at the *container* instead). Tried in
 *  the order a schema most often fails them; the first match wins. */
std::optional<std::string> scalar_constraint_rejection (const nlohmann::json& schema,
const std::string& d,
const std::string& pointer) {
    const nlohmann::json* node = schema_node_at (schema, pointer);
    const std::string field_name =
    pointer.empty () ? "value" : pointer.substr (pointer.rfind ('/') + 1);
    const std::string title = node_title (node, field_name);

    if (auto r = type_mismatch_rejection (node, title, d)) {
        return r;
    }
    if (auto r = enum_value_rejection (node, title, d)) {
        return r;
    }
    if (auto r = pattern_rejection (node, title, d)) {
        return r;
    }
    if (auto r = bound_rejection (title, d)) {
        return r;
    }
    return length_rejection (title, d);
}

} // namespace

std::string humanize_schema_error (const nlohmann::json& schema,
const std::string& error_description,
const std::string& error_json_pointer) {
    if (auto r = required_property_rejection (schema, error_description, error_json_pointer)) {
        return *r;
    }
    if (auto r = additional_property_rejection (error_description)) {
        return *r;
    }
    if (auto r = scalar_constraint_rejection (schema, error_description, error_json_pointer)) {
        return *r;
    }
    return error_description; // A constraint outside the set above: valijson's own wording.
}

} // namespace vayu::core
