#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief One valijson constraint failure, translated into plain English.
 *
 * `valijson::ValidationResults::Error::description` speaks JSON-Schema
 * keywords, which a wire caller understands and a person reading a toast or a
 * Response Viewer panel does not ("Value type not permitted by 'type'
 * constraint.", "Missing required property 'x'."). Two callers show the text to
 * a person, `elements/registry.cpp`'s element-config validation and
 * `schema_validation.cpp`'s response-body validation, so the translation lives
 * here once.
 */

#include <nlohmann/json_fwd.hpp>

#include <cstdint>
#include <optional>
#include <string>

namespace vayu::core {

/**
 * Whose schema a failure came from, which decides the vocabulary. An element
 * kind's config schema describes settings a person fills into a form; a
 * response schema describes a body, where "a setting this element has" and
 * "a number" for an integer both misname the problem (#3037).
 */
enum class SchemaErrorContext : std::uint8_t {
    ElementSettings,
    ResponseBody,
};

/**
 * valijson's wording for one schema-constraint failure, in plain English for
 * the constraints this engine's callers trigger: `type`, `required`,
 * `additionalProperties`, `minimum`/`maximum`, `minLength`/`maxLength`, `enum`,
 * `pattern`. The failing property's declared `"title"` (and `"description"` for
 * a `pattern` failure, which names no bound to restate), the declared bound and
 * the enum list are read off @p schema at the JSON Pointer the error names, not
 * parsed out of valijson's text, so the message survives a change in valijson's
 * phrasing. An element config schema has a title on every property (#1607); an
 * imported document's response schema may declare none, and then the property's
 * JSON key is shown.
 *
 * @p schema is walked only through `properties` (never `$ref`, `oneOf` or an
 * array `items`), the whole shape the element config schemas use. A response
 * schema reached through an unresolved `$ref` shows the raw key rather than a
 * title; a constraint outside the set above, or a description this cannot
 * match, falls back to valijson's text rather than showing nothing.
 *
 * @p context picks the wording for what only a settings form or only a body
 * has: a property the schema does not declare, an integer, `null`, the document
 * root. A response-body message never names a setting or an element.
 */
std::string humanize_schema_error (const nlohmann::json& schema,
const std::string& error_description,
const std::string& error_json_pointer,
SchemaErrorContext context = SchemaErrorContext::ElementSettings);

/**
 * The property name valijson's `additionalProperties` failure rejected, or
 * nothing when @p error_description is another failure. valijson's error
 * location names the *object* holding the property; this is the one place the
 * property itself is recorded, so a caller that wants its own location (a
 * response failure's path) reads it from here.
 */
std::optional<std::string> unexpected_property_name (const std::string& error_description);

} // namespace vayu::core
