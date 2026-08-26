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
 * describes an import to a user rather than a document to the diff, and is the
 * renderer's to keep until the import itself moves.
 *
 * The documented responses **are** ported (issue #854), although the diff does
 * not compare them: applying a change writes them, so a draft without them is
 * an answer no apply can be built from - which is what kept a second parse of
 * the same document in the renderer after the comparison had moved.
 */

#include "vayu/core/openapi_document.hpp"

#include "js_json.hpp"
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

// The JavaScript semantics these rules are written in - `prop`, truthiness,
// `JSON.stringify`'s number and string forms, `encodeURIComponent`,
// `appendParamsToUrl`. Shared with the import (issue #877) rather than kept
// here, so the two readers of a foreign document cannot drift apart.
using namespace js;

/// `tally.add(kind)` for a caller that may not be keeping one - the sync diff
/// asks for drafts and has no preview to report a loss to.
void tally_add (ImportTally* tally, std::string_view kind) {
    if (tally != nullptr) {
        tally->add (kind);
    }
}

/// The same, for a count the walk accumulated rather than one loss.
void tally_add_count (ImportTally* tally, std::string_view kind, int count) {
    if (tally != nullptr) {
        tally->add (kind, count);
    }
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
        return walk (schema, 0, SeenRefs{});
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
        const json* properties =
        as_record (prop (resolve_to_schema (schema, 0, SeenRefs{}), "properties"));
        for (auto entry = sampled.begin (); entry != sampled.end (); ++entry) {
            DraftField field;
            field.key     = entry.key ();
            field.value   = "";
            field.enabled = true;
            field.file = is_binary (prop (properties, entry.key ()), 0, SeenRefs{});
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

    /**
     * The value a schema *states*, whatever its type says - a `const`, an
     * `example`, or the first of 3.1's `examples` array.
     *
     * `const` outranks `example`: JSON Schema says the value MUST be exactly
     * this, where `example` is only an annotation.
     */
    [[nodiscard]] static const json* stated_value (const json* node) {
        if (const json* constant = prop (node, "const")) {
            return constant;
        }
        if (const json* example = prop (node, "example")) {
            return example;
        }
        // 3.1 replaced the singular `example` with an `examples` array.
        if (const json* examples = prop (node, "examples");
        examples != nullptr && examples->is_array () && !examples->empty ()) {
            return &(*examples)[0];
        }
        return nullptr;
    }

    /**
     * The type this sampler stubs for.
     *
     * 3.1 writes a nullable field as a type array (`["string", "null"]`) where
     * 3.0 wrote `nullable: true`. The first non-null member is the one sampled:
     * a typed stub is what the user edits, and only an all-`"null"` type has
     * nothing else to offer. A member that is not a string is still the one
     * found, and then matches no arm below, exactly as it matches no `case`
     * in the renderer's switch.
     */
    [[nodiscard]] static std::string declared_type (const json* node) {
        const json* declared = prop (node, "type");
        if (declared == nullptr) {
            return {};
        }
        if (declared->is_string ()) {
            return declared->get<std::string> ();
        }
        if (!declared->is_array ()) {
            return {};
        }
        for (const json& member : *declared) {
            if (!(member.is_string () && member.get_ref<const std::string&> () == "null")) {
                return member.is_string () ? member.get<std::string> () : std::string ();
            }
        }
        return "null";
    }

    /** The stub a scalar type is sampled as, or nothing for a structured one. */
    [[nodiscard]] static std::optional<json> scalar_stub (const json* node, const std::string& type) {
        if (type == "string") {
            const json* values = prop (node, "enum");
            if (values != nullptr && values->is_array () && !values->empty ()) {
                return std::make_optional ((*values)[0]);
            }
            return json ("");
        }
        if (type == "integer" || type == "number") {
            return json (0);
        }
        if (type == "boolean") {
            return json (false);
        }
        if (type == "null") {
            return json (nullptr);
        }
        return std::nullopt;
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

        if (const json* stated = stated_value (node)) {
            return *stated;
        }

        if (const json* branch = first_branch (node)) {
            return walk (branch, depth + 1, std::move (seen));
        }

        const std::string type = declared_type (node);
        if (auto stub = scalar_stub (node, type)) {
            return *stub;
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
DraftField declared_param_row (std::string name,
const json* declared,
const json* required,
const std::string* description) {
    DraftField row;
    row.key   = std::move (name);
    row.value = param_value_text (declared).value_or ("");
    // `required === true`, strictly: a document writing `required: "true"` has
    // said something the importer does not act on.
    row.enabled =
    (required != nullptr && required->is_boolean () && required->get<bool> ()) ||
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
std::vector<const json*> merged_parameters (const json& document,
const json* path_item,
const json* operation,
ImportTally* tally) {
    std::vector<const json*> ordered;
    std::unordered_map<std::string, size_t> position;

    // The path item's own `parameters` are counted by the walk, once per path;
    // this is the operation's half of the same rule.
    if (const json* declared = prop (operation, "parameters");
    declared != nullptr && !declared->is_null () && !declared->is_array ()) {
        tally_add (tally, "malformed_spec");
    }
    for (const json* list : { parameter_list (prop (path_item, "parameters")),
         parameter_list (prop (operation, "parameters")) }) {
        if (list == nullptr) {
            continue;
        }
        for (const json& parameter : *list) {
            const std::string* ref = as_str (prop (&parameter, "$ref"));
            const json* resolved   = as_record (
            ref != nullptr ? walk::resolve_ref (document, *ref) : &parameter);
            if (resolved == nullptr) {
                continue;
            }
            const json* in   = prop (resolved, "in");
            const json* name = prop (resolved, "name");
            if (!truthy (in) || !truthy (name)) {
                continue;
            }
            const std::string key = js_string_of (*in) + ":" + js_string_of (*name);
            const auto found = position.find (key);
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
        const size_t slash        = path.find ('/', start);
        const std::string segment = path.substr (
        start, slash == std::string::npos ? std::string::npos : slash - start);
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
std::pair<std::string, bool> folder_of (const json* tags, const std::string& path) {
    if (const std::string* tag = as_str (array_at (tags, 0))) {
        return { *tag, true };
    }
    return { path_folder_name (path), false };
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
    if (const json* example = prop (schema, "example");
    example != nullptr && !example->is_null ()) {
        return example;
    }
    return prop (schema, "default");
}

/// An operation's `requestBody` → the request's body (3.x).
DraftBody body_v3 (const Sampler& sampler, const json* request_body, ImportTally* tally) {
    DraftBody body;
    const std::string* ref = as_str (prop (request_body, "$ref"));
    const json* resolved = ref != nullptr ? sampler.deref (request_body) : request_body;
    const json* content = as_record (prop (resolved, "content"));
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
        body.mode   = multipart ? "form-data" : "x-www-form-urlencoded";
        body.fields = sampler.form_fields (prop (declared, "schema"));
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
    // `image/*` - is `none`, the same as no body, and the draft is identical.
    // The two are told apart only for the tally: an operation with no
    // `requestBody` at all lost nothing, and one that declared a media type
    // imported without the body it declared (issue #719).
    if (!content->empty ()) {
        tally_add (tally, "unmapped_body");
    }
    return body;
}

// ---------------------------------------------------------------------------
// Documented responses
// ---------------------------------------------------------------------------

/// Defined below with the 2.0 body rules it was written for; the documented
/// responses need it to read a `produces` entry the same way.
std::string media_type (const json& value);

/// `findJsonMediaType(content)`: the *key* of a 3.x `content` map's JSON media
/// type. `find_json_media` answers with the node; an example needs the name of
/// the type it is in, because that is the row's `Content-Type`.
std::optional<std::string> find_json_media_type (const json& content) {
    if (truthy (prop (&content, "application/json"))) {
        return std::string ("application/json");
    }
    for (auto entry = content.begin (); entry != content.end (); ++entry) {
        const std::string& key = entry.key ();
        if (key.rfind ("application/json", 0) == 0 ||
        (key.size () >= 5 && key.compare (key.size () - 5, 5, "+json") == 0)) {
            return key;
        }
    }
    return std::nullopt;
}

/// `exampleBodyText(value)`: a documented string is the body verbatim - a spec
/// that writes `"<xml/>"` documents those bytes, not a quoted JSON string.
std::string example_body_text (const json& value) {
    return value.is_string () ? value.get<std::string> () : js_json_text (value);
}

/// The payload one response documents, or absent when it documents none.
struct ExamplePayload {
    std::string body;
    std::string content_type;
};

/**
 * `responseExample(code, response, payload)`: one entry of an operation's
 * `responses` as a saved example, or absent when it cannot be stored as one.
 *
 * Shared by the two dialects, which disagree only about where the payload lives
 * - @p payload is that half. A key that is not a numeric status (`default`,
 * `2XX`) has no status line to be served under and is skipped rather than
 * guessed at; the renderer counts those for its import preview, and a draft has
 * no preview to report to.
 */
template <typename Payload>
std::optional<DraftExample>
response_example (const std::string& code, const json* response, ImportTally* tally, Payload payload) {
    const json* node = as_record (response);
    if (node == nullptr) {
        tally_add (tally, "malformed_spec");
        return std::nullopt;
    }
    if (code == "default") {
        // Spec-conformant and near-universal - Stripe declares one on all 568
        // of its operations - so it is counted apart from a malformed key
        // rather than painting a valid document as one defect per operation.
        tally_add (tally, "default_response");
        return std::nullopt;
    }
    if (code.size () != 3 ||
    !std::all_of (code.begin (), code.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0; })) {
        tally_add (tally, "example_no_status");
        return std::nullopt;
    }
    const int status = std::stoi (code);
    if (status < 100 || status > 599) {
        tally_add (tally, "example_no_status");
        return std::nullopt;
    }

    const std::optional<ExamplePayload> found = payload (*node);
    DraftExample example;
    // "200 - A user" when the document describes the response, "200" when it
    // does not. The status leads because that is what a reader scans a list of
    // examples for.
    const std::string* description = as_str (prop (node, "description"));
    example.name = description == nullptr ? code : code + " - " + *description;
    example.status       = status;
    example.documented   = found.has_value ();
    example.content_type = found ? found->content_type : std::string ();
    example.body         = found ? found->body : std::string ();
    return example;
}

/// A 3.x operation's documented responses.
std::vector<DraftExample>
examples_v3 (const Sampler& sampler, const json* responses, ImportTally* tally) {
    std::vector<DraftExample> out;
    const json* map = as_record (responses);
    if (map == nullptr) {
        return out;
    }
    for (auto entry = map->begin (); entry != map->end (); ++entry) {
        // A response that is itself a `$ref` is read through, one hop - the shape
        // a document that declares its errors once and names them everywhere
        // leaves (issue #714).
        const json* response = sampler.deref (&entry.value ());
        auto example         = response_example (entry.key (), response, tally,
                [&] (const json& node) -> std::optional<ExamplePayload> {
            const json* content = as_record (prop (&node, "content"));
            if (content == nullptr) {
                return std::nullopt;
            }
            const std::optional<std::string> type = find_json_media_type (*content);
            if (!type) {
                return std::nullopt;
            }
            const json* media = as_record (prop (content, *type));
            if (media == nullptr) {
                return std::nullopt;
            }
            // `media.example ?? firstNamedExample(...) ?? sample`: `??` falls
            // through `null` as well as absence, so a documented `example: null`
            // is not the answer - the named example, then the schema, still is.
            const json* value = prop (media, "example");
            if (value == nullptr || value->is_null ()) {
                value = first_named_example (prop (media, "examples"));
            }
            if (value != nullptr && !value->is_null ()) {
                return ExamplePayload{ example_body_text (*value), *type };
            }
            if (const json* schema = prop (media, "schema"); truthy (schema)) {
                return ExamplePayload{ example_body_text (sampler.sample (schema)), *type };
            }
            return std::nullopt;
        });
        if (example) {
            out.push_back (std::move (*example));
        }
    }
    return out;
}

/**
 * A 2.0 operation's documented responses.
 *
 * The 2.0 shape puts the payload on the response itself rather than under a
 * media-type map: `examples` is keyed by MIME type and holds the value
 * directly, and `schema` describes it. The media type comes from the
 * operation's `produces`, falling back to the document's, because a 2.0
 * response does not name its own.
 */
/**
 * The JSON media type a 2.0 operation says it produces, if it says one.
 *
 * An operation with no `produces` at all - and no document-level default -
 * documents JSON by convention, which is what the fallback says.
 */
std::optional<std::string> json_produced_type (const std::vector<std::string>& produces) {
    for (const std::string& type : produces) {
        const std::string bare = media_type (json (type));
        if (bare == "application/json" ||
        (bare.size () >= 5 && bare.compare (bare.size () - 5, 5, "+json") == 0)) {
            return type;
        }
    }
    if (produces.empty ()) {
        return std::string ("application/json");
    }
    return std::nullopt;
}

/** What a 2.0 operation declares it produces - its own list, or the document's. */
std::vector<std::string> produced_types (const json& document, const json* operation) {
    const json* declared = prop (operation, "produces");
    if (declared == nullptr || !declared->is_array ()) {
        declared = prop (&document, "produces");
    }
    std::vector<std::string> produces;
    if (declared != nullptr && declared->is_array ()) {
        for (const json& entry : *declared) {
            produces.push_back (entry.is_string () ? entry.get<std::string> () : std::string ());
        }
    }
    return produces;
}

/**
 * One 2.0 response's body: the example it documents, or a sample of its schema.
 *
 * `declared[contentType] ?? declared["application/json"]`, then `!== undefined` -
 * so an explicitly documented `null` is a body ("null"), while a `null` under
 * the produced type falls through to the plain one first.
 */
std::optional<ExamplePayload> response_payload_v2 (const json& node,
const Sampler& sampler,
const std::string& content_type) {
    if (const json* documented = as_record (prop (&node, "examples"))) {
        const json* value = prop (documented, content_type);
        if (value == nullptr || value->is_null ()) {
            const json* plain = prop (documented, "application/json");
            value             = plain != nullptr ? plain : value;
        }
        if (value != nullptr) {
            return ExamplePayload{ example_body_text (*value), content_type };
        }
    }
    const json* schema = prop (&node, "schema");
    if (!truthy (schema)) {
        return std::nullopt;
    }
    return ExamplePayload{ example_body_text (sampler.sample (schema)), content_type };
}

std::vector<DraftExample> examples_v2 (const json& document,
const Sampler& sampler,
const json* operation,
ImportTally* tally) {
    std::vector<DraftExample> out;
    const json* map = as_record (prop (operation, "responses"));
    if (map == nullptr) {
        return out;
    }

    const std::vector<std::string> produces = produced_types (document, operation);
    const std::optional<std::string> json_produced = json_produced_type (produces);
    const std::string content_type = json_produced.value_or (
    produces.empty () ? std::string ("application/json") : produces.front ());

    for (auto entry = map->begin (); entry != map->end (); ++entry) {
        const json* response = sampler.deref (&entry.value ());
        auto example         = response_example (entry.key (), response, tally,
                [&] (const json& node) { return response_payload_v2 (node, sampler, content_type); });
        if (example) {
            out.push_back (std::move (*example));
        }
    }
    return out;
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

namespace {

/** What the request an operation becomes is called, and what it says it does. */
void name_draft (const json* operation, const walk::WalkedOperation& walked, DraftRequest& draft) {
    const std::string& path = walked.identity.path;

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
}

/**
 * Every parameter the operation and its path item declare, as the rows a draft
 * carries - query, header, 2.0's `body` and `formData`, and the 3.x `cookie`
 * that is dropped and counted.
 */
/**
 * One parameter, as the row it becomes.
 *
 * `in: "path"` is deliberately neither a row nor counted: a path parameter is
 * already carried, as the `{{var}}` the URL was rewritten with.
 */
void read_draft_parameter (const json* parameter,
walk::Dialect dialect,
const Sampler& sampler,
ImportTally* tally,
DraftRequest& draft,
std::vector<DraftField>& form_fields) {
    const json* name_node = prop (parameter, "name");
    const std::string name =
    name_node == nullptr ? std::string () : js_string_of (*name_node);
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
        draft.params.push_back (
        declared_param_row (name, value, required, description));
    } else if (kind == "header") {
        if (is_self_produced_header (name)) {
            return;
        }
        const json* value = dialect == walk::Dialect::V3 ?
        declared_param_value_v3 (sampler, parameter) :
        prop (parameter, "default");
        // No description: the Headers table has no column for one, so
        // carrying it would be a field nothing reads.
        draft.headers.push_back (declared_param_row (name, value, required, nullptr));
    } else if (dialect == walk::Dialect::V2 && kind == "body") {
        const json* schema = prop (parameter, "schema");
        const json sample =
        truthy (schema) ? sampler.sample (schema) : json::object ();
        draft.body.content = js_json_text (sample);
        draft.body.mode = "json"; // Corrected below against `consumes`.
    } else if (dialect == walk::Dialect::V2 && kind == "formData") {
        DraftField field;
        field.key                   = name;
        const std::string* declared = as_str (prop (parameter, "type"));
        field.file = declared != nullptr && *declared == "file";
        form_fields.push_back (std::move (field));
    } else if (dialect == walk::Dialect::V3 && kind == "cookie") {
        // Dropped - a request's cookies come from the jar - and counted
        // rather than folded into one `Cookie` header, which would
        // invent a merge the document never wrote (#719). 2.0 has no
        // cookie parameter, so its parser counts none either.
        tally_add (tally, "cookie_param");
    }
}

/**
 * Every parameter the operation and its path item declare, as the rows a draft
 * carries.
 */
void read_draft_parameters (const json& document,
const walk::WalkedOperation& walked,
walk::Dialect dialect,
const Sampler& sampler,
ImportTally* tally,
DraftRequest& draft,
std::vector<DraftField>& form_fields) {
    for (const json* parameter :
    merged_parameters (document, walked.path_item, walked.node, tally)) {
        read_draft_parameter (parameter, dialect, sampler, tally, draft, form_fields);
    }
}

/**
 * The 2.0 body, corrected against what the operation `consumes`.
 *
 * 2.0 ties `formData` encoding to `consumes` - urlencoded and multipart are
 * distinct wire encodings and distinct body modes here. Multipart wins when both
 * are listed (only it can carry a `type: file` field), and a `consumes` naming
 * neither keeps the historical multipart default. A file part has no urlencoded
 * wire form, so a document declaring one under a urlencoded-only `consumes`
 * contradicts itself; multipart is the half of that contradiction which can
 * carry the field.
 */
void apply_v2_body_encoding (const json& document,
const json* operation,
std::vector<DraftField>& form_fields,
DraftRequest& draft) {
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
        const bool urlencoded = std::any_of (consumes.begin (),
        consumes.end (), [] (const std::string& type) {
            return media_type (type) == "application/x-www-form-urlencoded";
        });
        const bool multipart  = std::any_of (consumes.begin (),
         consumes.end (), [] (const std::string& type) {
            return media_type (type) == "multipart/form-data";
        });
        const bool has_file =
        std::any_of (form_fields.begin (), form_fields.end (),
        [] (const DraftField& field) { return field.file; });
        draft.body.mode    = (urlencoded && !multipart && !has_file) ?
           "x-www-form-urlencoded" :
           "form-data";
        draft.body.content = "";
        draft.body.fields  = std::move (form_fields);
    }
}

/**
 * The drafts, for either caller: the sync diff, which wants the operations a
 * document *declares*, and the import, which wants a request for every
 * operation it *writes* plus a tally of what it had to drop.
 *
 * One function rather than two, because a draft the two built differently is
 * exactly the divergence #865 exists to prevent - the import would then apply
 * a request the diff never compared.
 */
std::vector<SpecRequestDraft>
build_drafts (const json& document, ImportTally* tally, bool include_unidentified) {
    std::vector<SpecRequestDraft> drafts;
    const walk::Dialect dialect = walk::spec_dialect (document);
    if (dialect == walk::Dialect::None) {
        return drafts;
    }
    const Sampler sampler (document);

    walk::WalkNotes notes;
    for (walk::WalkedOperation& walked :
    walk::walk_operations (document, tally == nullptr ? nullptr : &notes)) {
        if (!walked.identified && !include_unidentified) {
            continue;
        }
        const json* operation   = walked.node;
        const std::string& path = walked.identity.path;

        SpecRequestDraft entry;
        std::tie (entry.folder, entry.folder_from_tag) =
        folder_of (prop (operation, "tags"), path);

        DraftRequest& draft = entry.draft;
        name_draft (operation, walked, draft);

        std::vector<DraftField> form_fields;
        read_draft_parameters (
        document, walked, dialect, sampler, tally, draft, form_fields);

        if (dialect == walk::Dialect::V2) {
            apply_v2_body_encoding (document, operation, form_fields, draft);
        } else {
            draft.body = body_v3 (sampler, prop (operation, "requestBody"), tally);
        }


        draft.examples = dialect == walk::Dialect::V3 ?
        examples_v3 (sampler, prop (operation, "responses"), tally) :
        examples_v2 (document, sampler, operation, tally);

        draft.url =
        append_params ("{{baseUrl}}" + normalize_path_templates (path), draft.params);

        entry.identified = walked.identified;
        entry.operation  = std::move (walked.identity);
        drafts.push_back (std::move (entry));
    }
    tally_add_count (tally, "malformed_spec", notes.malformed_spec);
    tally_add_count (tally, "unsupported_method", notes.unsupported_method);
    tally_add_count (tally, "duplicate_operation_id", notes.duplicate_operation_id);
    return drafts;
}

} // namespace

std::vector<SpecRequestDraft> spec_request_drafts_of (const json& document) {
    return build_drafts (document, nullptr, /*include_unidentified=*/false);
}

std::vector<SpecRequestDraft> import_drafts_of (const json& document, ImportTally& tally) {
    return build_drafts (document, &tally, /*include_unidentified=*/true);
}

void ImportTally::add (std::string_view kind, int count) {
    if (count <= 0) {
        return;
    }
    for (auto& entry : counts_) {
        if (entry.first == kind) {
            entry.second += count;
            return;
        }
    }
    counts_.emplace_back (kind, count);
}

nlohmann::ordered_json ImportTally::items () const {
    // The order `SkippedItem["kind"]` declares, so that two walks of one
    // document produce one list whatever order they met the losses in.
    static constexpr std::array<const char*, 15> ORDER = { "websocket", "grpc",
        "api_spec", "unit_test", "file_body", "malformed_item", "unsupported_method",
        "malformed_spec", "example_no_status", "default_response", "external_ref",
        "duplicate_operation_id", "cookie_param", "unmapped_body", "unresolved_base_url" };

    nlohmann::ordered_json items = nlohmann::ordered_json::array ();
    for (const char* kind : ORDER) {
        for (const auto& entry : counts_) {
            if (entry.first == kind) {
                items.push_back ({ { "kind", entry.first }, { "count", entry.second } });
            }
        }
    }
    return items;
}

} // namespace vayu::core
