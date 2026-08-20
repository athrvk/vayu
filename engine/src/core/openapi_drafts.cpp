/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_drafts.cpp
 * @brief The requests an import of a document would build (issue #865).
 *        See the header for what a draft is and why it is not an identity.
 *
 * This is a port of `app/src/services/importers/openapi-v3.ts`,
 * `openapi-v2.ts`, their shared half and the schema sampler, kept to the *same*
 * answers rather than to the same code - the sync diff compares a stored
 * request against a draft, so anywhere the two readers differ the diff reports
 * a field as changed for a document that did not change. Everything below that
 * looks like a JavaScript idiom in C++ clothing is that faithfulness: `??`
 * falling through `null` but not `false`, `String(x)` on a value that is not a
 * string, `JSON.stringify`'s number formatting. Where a rule has a reason, the
 * reason is in the header or in the renderer file this mirrors; where it has
 * only a shape, the shape is pinned by
 * `tests/fixtures/spec-request-drafts-conformance.json`.
 *
 * What is deliberately *not* ported: the skip tally (`meta.skipped`), which
 * describes an import to a user rather than a document to the diff, and the
 * saved response examples, which the diff does not compare. Both are the
 * renderer's to keep until the import itself moves.
 */

#include "vayu/core/openapi_document.hpp"

#include "openapi_walk.hpp"

#include "vayu/core/path_template.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

// ---------------------------------------------------------------------------
// The JavaScript the renderer's parsers are written in
// ---------------------------------------------------------------------------

/// `prop(node, key)`: the property, or `nullptr` for "undefined" - a missing
/// key, or a node that is not an object at all.
const json* prop (const json* node, std::string_view key) {
    if (node == nullptr || !node->is_object ()) {
        return nullptr;
    }
    const auto found = node->find (key);
    return found == node->end () ? nullptr : &(*found);
}

/// `asRecord(v)`: the node when it is a JSON object, else `nullptr`.
const json* as_record (const json* node) {
    return node != nullptr && node->is_object () ? node : nullptr;
}

/// `asStr(v)`: the node's text when it is a string, else "undefined". Never
/// coerces - an unquoted `name: 5` is not a name here, exactly as it is not one
/// on the renderer side.
const std::string* as_str (const json* node) {
    return node != nullptr && node->is_string () ? node->get_ptr<const std::string*> () : nullptr;
}

/// `asArray(v)[index]`: the entry, or `nullptr` for a non-array or a short one.
const json* array_at (const json* node, size_t index) {
    if (node == nullptr || !node->is_array () || index >= node->size ()) {
        return nullptr;
    }
    return &(*node)[index];
}

/// JavaScript truthiness: everything except `undefined`, `null`, `false`, `0`
/// and `""`. An empty object and an empty array are both truthy, which is what
/// `if (content[ct])` and `if (schema.items)` rest on.
bool truthy (const json* node) {
    if (node == nullptr || node->is_null ()) {
        return false;
    }
    if (node->is_boolean ()) {
        return node->get<bool> ();
    }
    if (node->is_number ()) {
        return node->get<double> () != 0.0;
    }
    if (node->is_string ()) {
        return !node->get_ref<const std::string&> ().empty ();
    }
    return true;
}

/**
 * `String(number)` / a number as `JSON.stringify` writes it.
 *
 * The renderer's drafts carry numbers as text - a parameter's declared value in
 * a row, a sampled body's fields in a JSON string - and both sides have to
 * spell them identically or the diff sees a change. JavaScript prints the
 * *shortest* representation that round-trips and never a trailing `.0`, where
 * `nlohmann::dump` writes `1.0` for a whole float.
 *
 * Exact for every finite value below 1e21 in magnitude, which is every number a
 * document realistically declares; past that both sides switch to exponential
 * notation and JavaScript's exact threshold (an exponent of 21, or -7) is not
 * worth carrying for a value no OpenAPI example holds.
 */
std::string js_number_text (const json& value) {
    if (value.is_number_integer () || value.is_number_unsigned ()) {
        return value.dump ();
    }
    const double real = value.get<double> ();
    if (!std::isfinite (real)) {
        return "null"; // What `JSON.stringify` writes for NaN and Infinity.
    }
    if (std::trunc (real) == real && std::abs (real) < 1e21) {
        std::array<char, 64> buffer {};
        const int written = std::snprintf (buffer.data (), buffer.size (), "%.0f", real);
        if (written > 0) {
            std::string text (buffer.data (), static_cast<size_t> (written));
            // `%.0f` writes "-0" for negative zero; JavaScript writes "0".
            return text == "-0" ? "0" : text;
        }
    }
    std::array<char, 64> buffer {};
    const auto result = std::to_chars (buffer.data (), buffer.data () + buffer.size (), real);
    std::string text (buffer.data (), result.ptr);
    // `to_chars` writes `1e+21` / `1e-07`; JavaScript writes `1e+21` / `1e-7`.
    const size_t exponent = text.find ('e');
    if (exponent != std::string::npos) {
        size_t digits = exponent + 1;
        if (digits < text.size () && (text[digits] == '+' || text[digits] == '-')) {
            ++digits;
        }
        while (digits + 1 < text.size () && text[digits] == '0') {
            text.erase (digits, 1);
        }
    }
    return text;
}

/// `String(value)` for the scalars a `name` or an `in` can hold. A document
/// writing `name: 5` names the parameter "5" on both sides.
std::string js_string_of (const json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_number ()) {
        return js_number_text (value);
    }
    if (value.is_boolean ()) {
        return value.get<bool> () ? "true" : "false";
    }
    if (value.is_null ()) {
        return "null";
    }
    return value.is_array () ? value.dump () : "[object Object]";
}

/// One string as `JSON.stringify` quotes it: the six short escapes, `\uXXXX`
/// for the rest of the control range, and every other byte verbatim (both
/// sides emit UTF-8 rather than escaping it).
void append_json_string (const std::string& value, std::string& out) {
    out += '"';
    for (const char ch : value) {
        switch (ch) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char> (ch) < 0x20) {
                std::array<char, 8> escape {};
                std::snprintf (escape.data (), escape.size (), "\\u%04x",
                static_cast<unsigned int> (static_cast<unsigned char> (ch)));
                out += escape.data ();
            } else {
                out += ch;
            }
            break;
        }
    }
    out += '"';
}

void append_json_text (const json& value, size_t indent, std::string& out);

void append_json_container (const json& value, size_t indent, std::string& out) {
    const bool array = value.is_array ();
    if (value.empty ()) {
        out += array ? "[]" : "{}";
        return;
    }
    out += array ? "[\n" : "{\n";
    const std::string inner (indent + 2, ' ');
    bool first = true;
    for (auto entry = value.begin (); entry != value.end (); ++entry) {
        if (!first) {
            out += ",\n";
        }
        first = false;
        out += inner;
        if (!array) {
            append_json_string (entry.key (), out);
            out += ": ";
        }
        append_json_text (entry.value (), indent + 2, out);
    }
    out += '\n';
    out.append (indent, ' ');
    out += array ? ']' : '}';
}

void append_json_text (const json& value, size_t indent, std::string& out) {
    if (value.is_null ()) {
        out += "null";
    } else if (value.is_boolean ()) {
        out += value.get<bool> () ? "true" : "false";
    } else if (value.is_number ()) {
        out += js_number_text (value);
    } else if (value.is_string ()) {
        append_json_string (value.get_ref<const std::string&> (), out);
    } else {
        append_json_container (value, indent, out);
    }
}

/// `JSON.stringify(value, null, 2)`, which is the text a draft's JSON body is.
std::string js_json_text (const json& value) {
    std::string out;
    append_json_text (value, 0, out);
    return out;
}

/**
 * `encodeURIComponent(value)`.
 *
 * Deliberately not `utils::url_encode`, which is a different function rather
 * than an older copy of this one: it percent-encodes `!*'()`, which
 * `encodeURIComponent` leaves alone. The renderer writes an imported URL with
 * the latter, and a URL spelled two ways is a field the diff reports as changed
 * every time it is asked.
 */
std::string encode_uri_component (const std::string& value) {
    static constexpr std::string_view HEX = "0123456789ABCDEF";
    static constexpr std::string_view UNRESERVED = "-_.!~*'()";
    std::string out;
    out.reserve (value.size ());
    for (const char ch : value) {
        const auto c = static_cast<unsigned char> (ch);
        if (std::isalnum (c) != 0 || UNRESERVED.find (ch) != std::string_view::npos) {
            out += ch;
        } else {
            out += '%';
            out += HEX[c >> 4U];
            out += HEX[c & 0x0FU];
        }
    }
    return out;
}

/// `containsVariableToken(text)`: a `{{name}}` anywhere in the string. Such a
/// value is left unencoded, so the variable syntax survives into the URL.
bool contains_variable_token (const std::string& text) {
    for (size_t at = text.find ("{{"); at != std::string::npos; at = text.find ("{{", at + 1)) {
        const size_t close = text.find ("}}", at + 2);
        if (close == std::string::npos) {
            return false;
        }
        // `[^{}]+` between the braces: a `{` inside is not this token's close.
        const std::string_view inner (text.data () + at + 2, close - at - 2);
        if (!inner.empty () && inner.find_first_of ("{}") == std::string_view::npos) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// The schema sampler (`app/src/services/importers/schema-sampler.ts`)
// ---------------------------------------------------------------------------

/// The sampler's own depth cap. A schema deeper than this samples to `{}`,
/// which is the renderer's answer too - a stub the user edits beats a walk that
/// does not end.
constexpr int MAX_SAMPLE_DEPTH = 6;

/// A `$ref` chain already followed on this branch, copied per branch exactly as
/// the renderer's `new Set([...seenRefs, ref])` is: two sibling properties may
/// each name the same shared schema without either being a cycle.
using SeenRefs = std::set<std::string>;

class Sampler {
    public:
    explicit Sampler (const json& document) : document_ (document) {
    }

    /// `sampleSchema(schema, resolveRef)`.
    [[nodiscard]] json sample (const json* schema) const {
        return walk (schema, 0, SeenRefs {});
    }

    /**
     * `schemaFormFields(schema, resolveRef)`: a form body's fields, read off the
     * *sampled* stub rather than off `properties`.
     *
     * Going through the sampler is the point: a form schema written as `$ref` or
     * `allOf` - what generators emit - has no literal `properties`, and reading
     * that key directly produced an empty field list. `file` is resolved
     * separately against the property schemas, because the sampler flattens a
     * `format: binary` string to `""` and that is indistinguishable from a text
     * field (issue #425).
     */
    [[nodiscard]] std::vector<DraftField> form_fields (const json* schema) const {
        std::vector<DraftField> fields;
        if (schema == nullptr || schema->is_null ()) {
            return fields;
        }
        const json sampled = sample (schema);
        if (!sampled.is_object ()) {
            return fields;
        }
        const json* properties = as_record (prop (resolve_to_schema (schema, 0, SeenRefs {}), "properties"));
        for (auto entry = sampled.begin (); entry != sampled.end (); ++entry) {
            DraftField field;
            field.key     = entry.key ();
            field.value   = "";
            field.enabled = true;
            field.file    = is_binary (prop (properties, entry.key ()), 0, SeenRefs {});
            fields.push_back (std::move (field));
        }
        return fields;
    }

    /// `deref(value, resolveRef)`: a `$ref`-following read, single-hop.
    [[nodiscard]] const json* deref (const json* value) const {
        const std::string* ref = as_str (prop (value, "$ref"));
        if (ref == nullptr) {
            return value;
        }
        return walk::resolve_ref (document_, *ref);
    }

    private:
    const json& document_;

    /// The schema a node ultimately denotes: `$ref` and the first
    /// `allOf`/`oneOf`/`anyOf` branch followed, under the same cap and guard the
    /// sampler walks with. Split out because the walk returns a *value* and the
    /// form-field lookup needs the declaration.
    [[nodiscard]] const json*
    resolve_to_schema (const json* node, int depth, SeenRefs seen) const {
        if (depth > MAX_SAMPLE_DEPTH || node == nullptr || !node->is_structured ()) {
            return nullptr;
        }
        if (const std::string* ref = as_str (prop (node, "$ref"))) {
            if (seen.count (*ref) != 0) {
                return nullptr;
            }
            const json* resolved = walk::resolve_ref (document_, *ref);
            seen.insert (*ref);
            return resolve_to_schema (resolved, depth + 1, std::move (seen));
        }
        const json* branch = first_branch (node);
        if (branch != nullptr) {
            return resolve_to_schema (branch, depth + 1, std::move (seen));
        }
        return node;
    }

    /// `schema.allOf ?? schema.oneOf ?? schema.anyOf`, and only when it is a
    /// non-empty array - the first entry of it, which is the whole of what the
    /// renderer's sampler reads from a composed schema.
    [[nodiscard]] static const json* first_branch (const json* schema) {
        for (const char* key : { "allOf", "oneOf", "anyOf" }) {
            const json* branch = prop (schema, key);
            if (branch == nullptr || branch->is_null ()) {
                continue; // `??` falls through `null` and `undefined` alone.
            }
            return branch->is_array () && !branch->empty () ? &(*branch)[0] : nullptr;
        }
        return nullptr;
    }

    /// Whether a property schema declares a file upload. A `type: array` of
    /// binary items is the multi-file field, imported as one file row - one file
    /// the user can attach beats a text row that sends nothing.
    [[nodiscard]] bool is_binary (const json* node, int depth, SeenRefs seen) const {
        const json* schema = resolve_to_schema (node, depth, seen);
        if (schema == nullptr) {
            return false;
        }
        const std::string* format = as_str (prop (schema, "format"));
        if (format != nullptr && *format == "binary") {
            return true;
        }
        const std::string* type = as_str (prop (schema, "type"));
        return type != nullptr && *type == "array" &&
        is_binary (prop (schema, "items"), depth + 1, std::move (seen));
    }

    [[nodiscard]] json walk (const json* node, int depth, SeenRefs seen) const {
        // `typeof node === "object"` in the renderer, which an array satisfies -
        // and an array falls through every branch below to an empty object.
        if (depth > MAX_SAMPLE_DEPTH || node == nullptr || !node->is_structured ()) {
            return json::object ();
        }
        if (const std::string* ref = as_str (prop (node, "$ref"))) {
            if (seen.count (*ref) != 0) {
                return json::object (); // cycle guard
            }
            const json* resolved = walk::resolve_ref (document_, *ref);
            if (resolved == nullptr || resolved->is_null ()) {
                return json::object ();
            }
            seen.insert (*ref);
            return walk (resolved, depth + 1, std::move (seen));
        }

        // `const` outranks `example`: JSON Schema says the value MUST be exactly
        // this, where `example` is only an annotation.
        if (const json* constant = prop (node, "const")) {
            return *constant;
        }
        if (const json* example = prop (node, "example")) {
            return *example;
        }
        // 3.1 replaced the singular `example` with an `examples` array.
        if (const json* examples = prop (node, "examples");
            examples != nullptr && examples->is_array () && !examples->empty ()) {
            return (*examples)[0];
        }

        if (const json* branch = first_branch (node)) {
            return walk (branch, depth + 1, std::move (seen));
        }

        // 3.1 writes a nullable field as a type array (`["string", "null"]`)
        // where 3.0 wrote `nullable: true`. Sample the first non-null member: a
        // typed stub is what the user edits, and only an all-`"null"` type has
        // nothing else to offer.
        std::string type;
        if (const json* declared = prop (node, "type")) {
            if (declared->is_array ()) {
                // `type.find(t => t !== "null") ?? "null"` - and a member that is
                // not a string is still the one found, which then matches no arm
                // below, exactly as it matches no `case` there.
                type = "null";
                for (const json& member : *declared) {
                    if (!(member.is_string () && member.get_ref<const std::string&> () == "null")) {
                        type = member.is_string () ? member.get<std::string> () : std::string ();
                        break;
                    }
                }
            } else if (declared->is_string ()) {
                type = declared->get<std::string> ();
            }
        }

        if (type == "string") {
            const json* values = prop (node, "enum");
            if (values != nullptr && values->is_array () && !values->empty ()) {
                return (*values)[0];
            }
            return "";
        }
        if (type == "integer" || type == "number") {
            return 0;
        }
        if (type == "boolean") {
            return false;
        }
        if (type == "null") {
            return nullptr;
        }
        if (type == "array") {
            const json* items = prop (node, "items");
            if (!truthy (items)) {
                return json::array ();
            }
            json sampled = json::array ();
            sampled.push_back (walk (items, depth + 1, std::move (seen)));
            return sampled;
        }
        // No type, or one this sampler has no stub for: fall back to walking the
        // properties, which is what a schema with only `properties` declares.
        const json* properties = as_record (prop (node, "properties"));
        if (properties == nullptr) {
            return json::object ();
        }
        json sampled = json::object ();
        for (auto entry = properties->begin (); entry != properties->end (); ++entry) {
            sampled[entry.key ()] = walk (&entry.value (), depth + 1, seen);
        }
        return sampled;
    }
};

// ---------------------------------------------------------------------------
// Parameters (`openapi-shared.ts`)
// ---------------------------------------------------------------------------

/// `paramValueText(declared)`: the text a row holds, or "undefined".
///
/// Only scalars convert. An array or object value is serialized by the
/// parameter's `style`/`explode` (3.x) or `collectionFormat` (2.0), neither of
/// which the importer reads; a row holds one string, so picking a separator
/// here would send a value the document did not declare.
std::optional<std::string> param_value_text (const json* declared) {
    if (declared == nullptr) {
        return std::nullopt;
    }
    if (declared->is_string ()) {
        const std::string& text = declared->get_ref<const std::string&> ();
        // A declared `""` is indistinguishable from no value at all, and the
        // Params table writes a bare key for an empty value.
        return text.empty () ? std::nullopt : std::optional<std::string> (text);
    }
    if (declared->is_number () || declared->is_boolean ()) {
        return js_string_of (*declared);
    }
    return std::nullopt;
}

/// `declaredParamRow(name, declared, required, description)`.
DraftField declared_param_row (std::string name, const json* declared, const json* required,
const std::string* description) {
    DraftField row;
    row.key   = std::move (name);
    row.value = param_value_text (declared).value_or ("");
    // `required === true`, strictly: a document writing `required: "true"` has
    // said something the importer does not act on.
    row.enabled = (required != nullptr && required->is_boolean () && required->get<bool> ()) ||
    !row.value.empty ();
    if (description != nullptr) {
        row.description = *description;
    }
    return row;
}

/// The `parameters` of a path item or an operation. The specification says
/// array; a missing `-` in hand-written YAML makes it a mapping, and the
/// renderer steps over that rather than spreading a non-iterable.
const json* parameter_list (const json* parameters) {
    return parameters != nullptr && parameters->is_array () ? parameters : nullptr;
}

/**
 * A path item's `parameters` merged with the operation's, keyed by `in` and
 * `name` with the operation's winning **in the path item's position**.
 *
 * The position matters as much as the value: a JavaScript `Map.set` on a key it
 * already holds replaces the value and keeps the insertion order, and the rows
 * reach the draft - and the URL's query - in that order.
 */
std::vector<const json*>
merged_parameters (const json& document, const json* path_item, const json* operation) {
    std::vector<const json*> ordered;
    std::unordered_map<std::string, size_t> position;

    for (const json* list : { parameter_list (prop (path_item, "parameters")),
             parameter_list (prop (operation, "parameters")) }) {
        if (list == nullptr) {
            continue;
        }
        for (const json& parameter : *list) {
            const std::string* ref = as_str (prop (&parameter, "$ref"));
            const json* resolved =
            as_record (ref != nullptr ? walk::resolve_ref (document, *ref) : &parameter);
            if (resolved == nullptr) {
                continue;
            }
            const json* in   = prop (resolved, "in");
            const json* name = prop (resolved, "name");
            if (!truthy (in) || !truthy (name)) {
                continue;
            }
            const std::string key = js_string_of (*in) + ":" + js_string_of (*name);
            const auto found      = position.find (key);
            if (found == position.end ()) {
                position.emplace (key, ordered.size ());
                ordered.push_back (resolved);
            } else {
                ordered[found->second] = resolved;
            }
        }
    }
    return ordered;
}

/// Headers a request produces for itself rather than holding as a row: the
/// `Authorization` its auth writes and the `Content-Type` its body names.
bool is_self_produced_header (const std::string& name) {
    const std::string lower = walk::lower (name);
    return lower == "authorization" || lower == "content-type";
}

// ---------------------------------------------------------------------------
// Folders (`OperationFolders` in `openapi-shared.ts`)
// ---------------------------------------------------------------------------

/// A path segment that names the API's version rather than a resource.
bool is_version_segment (const std::string& segment) {
    if (segment.size () < 2 || (segment[0] != 'v' && segment[0] != 'V')) {
        return false;
    }
    // `v\d+(\.\d+)*`: digits, then any number of dot-separated digit groups.
    size_t in_group = 0;
    for (size_t at = 1; at < segment.size (); ++at) {
        if (std::isdigit (static_cast<unsigned char> (segment[at])) != 0) {
            ++in_group;
            continue;
        }
        // A dot only separates groups, so it may neither open the token nor
        // close it: `v1.` and `v.1` name no version.
        if (segment[at] != '.' || in_group == 0) {
            return false;
        }
        in_group = 0;
    }
    return in_group > 0;
}

/**
 * `pathFolderName(path)`: the folder an untagged operation belongs in, read off
 * its path (issue #710), or "" when the path names no resource to group by.
 *
 * Leading segments that name no resource are stepped over: a version (`v1`,
 * `v2.1`), the ubiquitous `api` mount point, and a `{template}` segment, which
 * holds a value rather than naming anything. The segment is taken exactly as
 * written - a prettified name is one the document never contained.
 */
std::string path_folder_name (const std::string& path) {
    size_t start = 0;
    while (start <= path.size ()) {
        const size_t slash = path.find ('/', start);
        const std::string segment =
        path.substr (start, slash == std::string::npos ? std::string::npos : slash - start);
        if (slash == std::string::npos) {
            start = path.size () + 1;
        } else {
            start = slash + 1;
        }
        if (segment.empty ()) {
            continue;
        }
        const bool templated =
        segment.size () >= 2 && segment.front () == '{' && segment.back () == '}';
        if (templated) {
            continue;
        }
        if (is_version_segment (segment) || walk::lower (segment) == "api") {
            continue;
        }
        return segment;
    }
    return {};
}

/// Where an import files this operation: its first tag, else the folder its
/// path names, else the root. Only the first tag groups an operation - a
/// request duplicated into two folders is two requests to edit.
std::string folder_of (const json* tags, const std::string& path) {
    if (const std::string* tag = as_str (array_at (tags, 0))) {
        return *tag;
    }
    return path_folder_name (path);
}

// ---------------------------------------------------------------------------
// The URL (`normalizeVars` + `appendParamsToUrl`)
// ---------------------------------------------------------------------------

/// `toQueryString(params)`: the enabled rows, percent-encoded unless they carry
/// a `{{var}}`, and a bare key for a row with no value.
std::string query_string (const std::vector<DraftField>& params) {
    std::string out;
    for (const DraftField& row : params) {
        if (!row.enabled || row.key.find_first_not_of (" \t\n\r\f\v") == std::string::npos) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += contains_variable_token (row.key) ? row.key : encode_uri_component (row.key);
        if (!row.value.empty ()) {
            out += '=';
            out += contains_variable_token (row.value) ? row.value : encode_uri_component (row.value);
        }
    }
    return out;
}

/**
 * `appendParamsToUrl(url, params)`, which the import factory applies to every
 * draft it produced.
 *
 * The rows are appended rather than replacing the query, because `url` and
 * `params[]` are two independent statements by the source - and a request built
 * in the app carries its enabled query *inside* `url` (issue #590), which is
 * why a draft that skipped this step would differ from every stored request it
 * is compared against.
 */
std::string append_params (const std::string& url, const std::vector<DraftField>& params) {
    const std::string query = query_string (params);
    if (query.empty ()) {
        return url;
    }
    if (url.find ('?') == std::string::npos) {
        return url + "?" + query;
    }
    // A URL ending in `?` or `&` is already sitting on its separator.
    const char last = url.back ();
    return last == '?' || last == '&' ? url + query : url + "&" + query;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/// `findJsonMedia(content)`: the JSON media type of a 3.x `content` map -
/// `application/json` itself, else the first key that is a parameterised or a
/// `+json` spelling of it.
const json* find_json_media (const json& content) {
    if (const json* exact = prop (&content, "application/json"); truthy (exact)) {
        return as_record (exact);
    }
    for (auto entry = content.begin (); entry != content.end (); ++entry) {
        const std::string& key = entry.key ();
        const bool json_like   = key.rfind ("application/json", 0) == 0 ||
        (key.size () >= 5 && key.compare (key.size () - 5, 5, "+json") == 0);
        if (json_like) {
            return as_record (&entry.value ());
        }
    }
    return nullptr;
}

/// `firstNamedExample(examples)`: the first entry of a 3.x `examples` map,
/// unwrapped from its Example Object. `{"user": {"value": {...}}}` documents
/// `{...}`, not the wrapper. `externalValue` names a URL rather than carrying a
/// payload, and an import must not fetch one.
const json* first_named_example (const json* examples) {
    const json* map = as_record (examples);
    if (map == nullptr || map->empty ()) {
        return nullptr;
    }
    const json* entry = as_record (&map->begin ().value ());
    return entry == nullptr ? nullptr : prop (entry, "value");
}

/**
 * `declaredParamValue(param)`: the value a 3.x parameter declares.
 *
 * The concrete `example` first, then the first entry of `examples`, then what
 * the schema says. An `example` is authored as "a realistic value for this
 * parameter" - written for exactly this - while a `default` only describes what
 * the server assumes when the parameter is absent, so it comes last.
 */
const json* declared_param_value_v3 (const Sampler& sampler, const json* param) {
    if (const json* example = prop (param, "example")) {
        return example; // `!== undefined`, so an explicit `null` is the answer.
    }
    if (const json* named = first_named_example (prop (param, "examples"))) {
        return named;
    }
    const json* schema = as_record (sampler.deref (prop (param, "schema")));
    if (const json* example = prop (schema, "example"); example != nullptr && !example->is_null ()) {
        return example;
    }
    return prop (schema, "default");
}

/// An operation's `requestBody` → the request's body (3.x).
DraftBody body_v3 (const Sampler& sampler, const json* request_body) {
    DraftBody body;
    const std::string* ref = as_str (prop (request_body, "$ref"));
    const json* resolved   = ref != nullptr ? sampler.deref (request_body) : request_body;
    const json* content    = as_record (prop (resolved, "content"));
    if (content == nullptr) {
        return body; // No `requestBody` at all: nothing was lost.
    }

    if (const json* media = find_json_media (*content)) {
        const json* example = prop (media, "example");
        json sample;
        if (example != nullptr && !example->is_null ()) {
            sample = *example;
        } else if (const json* schema = prop (media, "schema"); truthy (schema)) {
            sample = sampler.sample (schema);
        } else {
            sample = json::object ();
        }
        body.mode    = "json";
        body.content = js_json_text (sample);
        return body;
    }
    if (truthy (prop (content, "text/plain"))) {
        body.mode = "text";
        return body;
    }
    for (const char* type : { "application/x-www-form-urlencoded", "multipart/form-data" }) {
        const json* declared = prop (content, type);
        if (!truthy (declared)) {
            continue;
        }
        const bool multipart = std::string_view (type) == "multipart/form-data";
        body.mode            = multipart ? "form-data" : "x-www-form-urlencoded";
        body.fields          = sampler.form_fields (prop (declared, "schema"));
        // A document names the upload, never the file - the part imports with no
        // path and the user attaches one. Only under multipart: urlencoded has no
        // file form on the wire, so a `format: binary` there is a document that
        // cannot mean what it says.
        if (!multipart) {
            for (DraftField& field : body.fields) {
                field.file = false;
            }
        }
        return body;
    }
    // A body in a media type the importer has no mode for - `application/xml`,
    // `image/*` - is `none`, the same as no body. The renderer tells the two
    // apart for its skip tally; the draft they produce is identical.
    return body;
}

/// A 2.0 `consumes` entry stripped of its parameters, lower-cased.
std::string media_type (const json& value) {
    std::string text = value.is_string () ? value.get<std::string> () : std::string ();
    const size_t semicolon = text.find (';');
    if (semicolon != std::string::npos) {
        text = text.substr (0, semicolon);
    }
    const size_t begin = text.find_first_not_of (" \t\n\r\f\v");
    if (begin == std::string::npos) {
        return {};
    }
    const size_t end = text.find_last_not_of (" \t\n\r\f\v");
    return walk::lower (text.substr (begin, end - begin + 1));
}

/// The operation's `consumes`, falling back to the document's. Entries that are
/// not strings read as "" on both sides rather than being dropped.
std::vector<std::string> consumes_of (const json& document, const json* operation) {
    const json* declared = prop (operation, "consumes");
    if (declared == nullptr || !declared->is_array ()) {
        declared = prop (&document, "consumes");
    }
    std::vector<std::string> types;
    if (declared == nullptr || !declared->is_array ()) {
        return types;
    }
    for (const json& entry : *declared) {
        types.push_back (entry.is_string () ? entry.get<std::string> () : std::string ());
    }
    return types;
}

} // namespace

std::vector<SpecRequestDraft> spec_request_drafts_of (const json& document) {
    std::vector<SpecRequestDraft> drafts;
    const walk::Dialect dialect = walk::spec_dialect (document);
    if (dialect == walk::Dialect::None) {
        return drafts;
    }
    const Sampler sampler (document);

    for (walk::WalkedOperation& walked : walk::walk_operations (document)) {
        const json* operation = walked.node;
        const std::string& path = walked.identity.path;

        SpecRequestDraft entry;
        entry.folder = folder_of (prop (operation, "tags"), path);

        DraftRequest& draft = entry.draft;
        if (const std::string* summary = as_str (prop (operation, "summary"))) {
            draft.name = *summary;
        } else if (const std::string* id = as_str (prop (operation, "operationId"))) {
            // The operation's own id, not the identity's: a repeated one is
            // dropped from the *identity* (issue #715), and the request an
            // import builds is still named after it.
            draft.name = *id;
        } else {
            draft.name = walked.identity.method + " " + path;
        }
        if (const std::string* description = as_str (prop (operation, "description"))) {
            draft.description = *description;
        }
        draft.method = walked.identity.method;

        std::vector<DraftField> form_fields;
        for (const json* parameter : merged_parameters (document, walked.path_item, operation)) {
            const json* name_node  = prop (parameter, "name");
            const std::string name = name_node == nullptr ? std::string () : js_string_of (*name_node);
            const std::string* in  = as_str (prop (parameter, "in"));
            const std::string kind = in == nullptr ? std::string () : *in;
            const json* required   = prop (parameter, "required");
            const std::string* description = as_str (prop (parameter, "description"));

            if (kind == "query") {
                const json* value = dialect == walk::Dialect::V3 ?
                declared_param_value_v3 (sampler, parameter) :
                // 2.0 states a non-body parameter's value inline as `default`;
                // it has no `example` keyword (that arrived with 3.x).
                prop (parameter, "default");
                draft.params.push_back (declared_param_row (name, value, required, description));
            } else if (kind == "header") {
                if (is_self_produced_header (name)) {
                    continue;
                }
                const json* value = dialect == walk::Dialect::V3 ?
                declared_param_value_v3 (sampler, parameter) :
                prop (parameter, "default");
                // No description: the Headers table has no column for one, so
                // carrying it would be a field nothing reads.
                draft.headers.push_back (declared_param_row (name, value, required, nullptr));
            } else if (dialect == walk::Dialect::V2 && kind == "body") {
                const json* schema = prop (parameter, "schema");
                const json sample = truthy (schema) ? sampler.sample (schema) : json::object ();
                draft.body.content = js_json_text (sample);
                draft.body.mode    = "json"; // Corrected below against `consumes`.
            } else if (dialect == walk::Dialect::V2 && kind == "formData") {
                DraftField field;
                field.key  = name;
                const std::string* declared = as_str (prop (parameter, "type"));
                field.file                  = declared != nullptr && *declared == "file";
                form_fields.push_back (std::move (field));
            }
            // `in: "path"` is deliberately neither a row nor counted: a path
            // parameter is already carried, as the `{{var}}` the URL was
            // rewritten with. `in: "cookie"` is dropped - a request's cookies
            // come from the jar, and folding declarations into one `Cookie`
            // header would invent a merge the document never wrote (#719).
        }

        if (dialect == walk::Dialect::V2) {
            const std::vector<std::string> consumes = consumes_of (document, operation);
            if (draft.body.mode == "json") {
                const bool json_consumed = consumes.empty () ||
                std::any_of (consumes.begin (), consumes.end (), [] (const std::string& type) {
                    return type == "application/json" ||
                    type.rfind ("application/json;", 0) == 0 ||
                    (type.size () >= 5 && type.compare (type.size () - 5, 5, "+json") == 0);
                });
                if (!json_consumed) {
                    draft.body.mode = "text";
                }
            }
            if (!form_fields.empty ()) {
                // 2.0 ties `formData` encoding to `consumes` - urlencoded and
                // multipart are distinct wire encodings and distinct body modes
                // here. Multipart wins when both are listed (only it can carry a
                // `type: file` field), and a `consumes` naming neither keeps the
                // historical multipart default. A file part has no urlencoded
                // wire form, so a document declaring one under a urlencoded-only
                // `consumes` contradicts itself; multipart is the half of that
                // contradiction which can carry the field.
                const bool urlencoded =
                std::any_of (consumes.begin (), consumes.end (), [] (const std::string& type) {
                    return media_type (type) == "application/x-www-form-urlencoded";
                });
                const bool multipart =
                std::any_of (consumes.begin (), consumes.end (), [] (const std::string& type) {
                    return media_type (type) == "multipart/form-data";
                });
                const bool has_file = std::any_of (form_fields.begin (), form_fields.end (),
                [] (const DraftField& field) { return field.file; });
                draft.body.mode = (urlencoded && !multipart && !has_file) ?
                "x-www-form-urlencoded" :
                "form-data";
                draft.body.content = "";
                draft.body.fields  = std::move (form_fields);
            }
        } else {
            draft.body = body_v3 (sampler, prop (operation, "requestBody"));
        }

        draft.url = append_params ("{{baseUrl}}" + normalize_path_templates (path), draft.params);

        entry.operation = std::move (walked.identity);
        drafts.push_back (std::move (entry));
    }
    return drafts;
}

} // namespace vayu::core
