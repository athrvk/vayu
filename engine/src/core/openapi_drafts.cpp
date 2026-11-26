/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The requests an import of a document would build (#865); the header says what
 * a draft is and why it is not an identity.
 *
 * A port of `app/src/services/importers/openapi-v3.ts`, `openapi-v2.ts` and
 * their shared half, with the schema sampler in `schema_sampler.hpp`, held to
 * the same answers, not the same code: the sync diff compares a stored request against a draft, so wherever
 * the readers differ it reports a field changed for a document that did not.
 * What looks like a JavaScript idiom in C++ clothing is that faithfulness: `??`
 * falling through `null` but not `false`, `String(x)` on a non-string,
 * `JSON.stringify`'s number formatting. A rule's reason is in the header or the
 * renderer file it mirrors; a rule with only a shape is pinned by
 * `tests/fixtures/spec-request-drafts-conformance.json`.
 *
 * Not ported: the skip tally (`meta.skipped`), which describes an import to a
 * user, not a document to the diff, and stays the renderer's until the import
 * moves.
 *
 * The documented responses are ported (#854) though the diff does not compare
 * them: applying a change writes them, so a draft without them is an answer no
 * apply can be built from.
 */

#include "vayu/core/openapi_document.hpp"

#include "js_json.hpp"
#include "openapi_walk.hpp"
#include "schema_sampler.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/path_template.hpp"
#include "vayu/utils/ascii_case.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

// The JavaScript semantics these rules are written in (`prop`, truthiness,
// `JSON.stringify`'s number and string forms, `encodeURIComponent`) and the
// query join `append_params`, shared with the import (#877) so the two readers
// of a foreign document cannot drift.
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
// The document's view of the schema sampler (`schema_sampler.hpp`)
// ---------------------------------------------------------------------------

/// The sampler over one OpenAPI document, which a `$ref` resolves against, with
/// the importer's rules (`SampleOptions` at its defaults), plus the readers of a
/// form schema that need the document too.
class Sampler {
    public:
    explicit Sampler (const json& document)
    : document_ (document), schemas_ (document) {
    }

    /// The stub @p schema samples to.
    [[nodiscard]] json sample (const json* schema) const {
        return schemas_.sample (schema);
    }

    /**
     * `schemaFormFields(schema, resolveRef)`: a form body's fields, read off
     * the sampled stub rather than `properties`. A form schema written as
     * `$ref` or `allOf` (what generators emit) has no literal `properties`, so
     * reading the key directly gives no fields. `file` is resolved separately
     * against the property schemas, because the sampler flattens a
     * `format: binary` string to `""`, indistinguishable from a text field
     * (#425).
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
        const json* properties = as_record (
        prop (schemas_.resolve_to_schema (schema, 0, SeenRefs{}), "properties"));
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

    /// Whether @p schema is one file's bytes - a `format: binary` string, behind
    /// any `$ref` or first composed branch. An array of them is not: one body
    /// sends one file.
    [[nodiscard]] bool declares_file (const json* schema) const {
        const json* resolved = schemas_.resolve_to_schema (schema, 0, SeenRefs{});
        const std::string* format = as_str (prop (resolved, "format"));
        return format != nullptr && *format == "binary";
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
    SchemaSampler schemas_;

    /// Whether a property schema declares a file upload. A `type: array` of
    /// binary items is the multi-file field, imported as one file row - one file
    /// the user can attach beats a text row that sends nothing.
    [[nodiscard]] bool is_binary (const json* node, int depth, SeenRefs seen) const {
        const json* schema = schemas_.resolve_to_schema (node, depth, seen);
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
};

// ---------------------------------------------------------------------------
// Parameters (`openapi-shared.ts`)
// ---------------------------------------------------------------------------

/// `paramValueText(declared)`: the text a row holds, or "undefined". Only
/// scalars convert: an array or object is serialized by `style` / `explode`
/// (3.x) or `collectionFormat` (2.0), which the importer does not read, and a
/// row holds one string, so picking a separator would send a value the document
/// did not declare.
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

/// `declaredParamRow(name, declared, required, description, enabledOverride)`.
DraftField declared_param_row (std::string name,
const json* declared,
const json* required,
const std::string* description,
const json* enabled_override) {
    DraftField row;
    row.key   = std::move (name);
    row.value = param_value_text (declared).value_or ("");
    if (enabled_override != nullptr && enabled_override->is_boolean ()) {
        // A Vayu-authored skeleton export states the toggle (`x-vayu-enabled`,
        // #1441) because an empty-valued enabled row and a non-empty disabled
        // one both defeat the heuristic below, so it is trusted over `required`
        // / `value`.
        row.enabled = enabled_override->get<bool> ();
    } else {
        // `required === true`, strictly: a document writing `required: "true"`
        // has said something the importer does not act on.
        row.enabled =
        (required != nullptr && required->is_boolean () && required->get<bool> ()) ||
        !row.value.empty ();
    }
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
 * `name`, the operation's winning in the path item's position. Position matters
 * as much as value: `Map.set` on a held key replaces the value and keeps the
 * insertion order, and the rows reach the draft and the URL's query in that
 * order.
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
    const std::string lower = vayu::utils::ascii_lower (name);
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
 * its path (#710), or "" when the path names no resource. Leading segments
 * naming no resource are stepped over: a version (`v1`, `v2.1`), the `api`
 * mount point, and a `{template}`, which holds a value. The segment is taken as
 * written: a prettified name is one the document never contained.
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
        if (is_version_segment (segment) || vayu::utils::ascii_lower (segment) == "api") {
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

/// One 3.x `examples` entry, unwrapped from its Example Object, with its key
/// (#1457), so the bound export writes an edited example back into that entry,
/// not beside it.
struct NamedExample {
    std::string key;
    const json* value = nullptr;
};

/// `firstNamedExampleEntry(examples)`: the first entry of a 3.x `examples`
/// map, unwrapped from its Example Object. `{"user": {"value": {...}}}`
/// documents `{...}`, not the wrapper. `externalValue` names a URL rather than
/// carrying a payload, and an import must not fetch one.
std::optional<NamedExample> first_named_example_entry (const json* examples) {
    const json* map = as_record (examples);
    if (map == nullptr || map->empty ()) {
        return std::nullopt;
    }
    auto begin        = map->begin ();
    const json* entry = as_record (&begin.value ());
    const json* value = entry == nullptr ? nullptr : prop (entry, "value");
    if (value == nullptr) {
        return std::nullopt;
    }
    return NamedExample{ begin.key (), value };
}

/// `firstNamedExample(examples)`: the value half of `first_named_example_entry`,
/// for the callers that have no use for which entry it came from.
const json* first_named_example (const json* examples) {
    const std::optional<NamedExample> found = first_named_example_entry (examples);
    return found ? found->value : nullptr;
}

/// A value found under a media object's `example` or `examples`, and, when it
/// came from the map, the key it came from (issue #1457).
struct DeclaredExampleValue {
    const json* value = nullptr;
    std::optional<std::string> key;
};

/// `media.example ?? firstNamedExample(media.examples)`: `??` falls through
/// `null` as well as absence, so a documented `example: null` is not the
/// answer; the named example, then nothing, still is. Separate from
/// `examples_v3`'s payload lambda to keep its branching within the
/// cognitive-complexity budget.
DeclaredExampleValue declared_example_value (const json* media) {
    if (const json* example = prop (media, "example");
    example != nullptr && !example->is_null ()) {
        return { example, std::nullopt };
    }
    if (const std::optional<NamedExample> named =
        first_named_example_entry (prop (media, "examples"))) {
        return { named->value, named->key };
    }
    return { nullptr, std::nullopt };
}

/**
 * `declaredParamValue(param)`: the value a 3.x parameter declares. The
 * `example` first, then the first `examples` entry, then the schema: an
 * `example` is authored as "a realistic value for this parameter", while a
 * `default` only describes what the server assumes when it is absent, so it
 * comes last.
 *
 * A Parameter Object declares one of `schema` or `content` (the latter for a
 * value needing a media type to parse, such as a JSON object serialized into a
 * query string). Without `schema`, `content`'s one entry is read as the same
 * {example, examples, schema} shape.
 */
const json* declared_param_value_v3 (const Sampler& sampler, const json* param) {
    if (const json* example = prop (param, "example")) {
        return example; // `!== undefined`, so an explicit `null` is the answer.
    }
    if (const json* named = first_named_example (prop (param, "examples"))) {
        return named;
    }
    const json* schema = as_record (sampler.deref (prop (param, "schema")));
    const json* media  = nullptr;
    if (schema == nullptr) {
        if (const json* content = as_record (prop (param, "content"));
        content != nullptr && !content->empty ()) {
            media  = as_record (&content->begin ().value ());
            schema = as_record (sampler.deref (prop (media, "schema")));
        }
    }
    if (media != nullptr) {
        if (const json* example = prop (media, "example");
        example != nullptr && !example->is_null ()) {
            return example;
        }
        if (const json* named = first_named_example (prop (media, "examples"))) {
            return named;
        }
    }
    if (const json* example = prop (schema, "example");
    example != nullptr && !example->is_null ()) {
        return example;
    }
    return prop (schema, "default");
}

/// `exampleBodyText(value)`: a documented string is the body verbatim (a spec
/// writing `"<xml/>"` documents those bytes, not a quoted JSON string). Defined
/// with the documented-response reader below, which needs the same rule.
std::string example_body_text (const json& value);

/// The media object of an XML type in a 3.x `content` map (`application/xml`,
/// `text/xml`, or any `+xml` suffix), or `nullptr`.
const json* find_xml_media (const json& content) {
    for (auto entry = content.begin (); entry != content.end (); ++entry) {
        const std::string key = vayu::utils::ascii_lower (entry.key ());
        if (key == "application/xml" || key == "text/xml" ||
        (key.size () >= 4 && key.compare (key.size () - 4, 4, "+xml") == 0)) {
            return as_record (&entry.value ());
        }
    }
    return nullptr;
}

/**
 * A `text/plain` or XML request body (3.x), its `example` as the text it is,
 * never parsed or sampled, or nothing when @p content declares neither. The
 * `example` is why a skeleton export writes these media types (#1441): reading
 * back only `mode` would lose the content on every round trip. Vayu's `xml`
 * mode exports as `application/xml`.
 */
std::optional<DraftBody> text_body_v3 (const json& content) {
    DraftBody body;
    const json* media = nullptr;
    if (const json* text_media = prop (&content, "text/plain"); truthy (text_media)) {
        body.mode = "text";
        media     = text_media;
    } else if (const json* xml_media = find_xml_media (content); xml_media != nullptr) {
        body.mode = "xml";
        media     = xml_media;
    } else {
        return std::nullopt;
    }
    if (const json* example = prop (media, "example");
    example != nullptr && !example->is_null ()) {
        body.content = example_body_text (*example);
    }
    return body;
}

/// Defined below with the 2.0 body rules it was written for; a binary body and
/// the documented responses need it to read a media type the same way.
std::string media_type (const json& value);

/// The media type a `binary` body is sent under: @p declared lowered and without
/// parameters, or `""` for a wildcard (`image/*`), which no request can send and
/// which leaves the send to derive one from the file.
std::string sendable_media_type (const std::string& declared) {
    std::string type = media_type (json (declared));
    return type.find ('*') == std::string::npos ? type : std::string ();
}

/**
 * A whole-file request body (3.x): `application/octet-stream` whatever its
 * schema, else the first media type whose schema is one file's bytes
 * (`format: binary`). It imports as a `binary` body with no file chosen (the
 * document names the upload, never the file) under that media type.
 */
std::optional<DraftBody> binary_body_v3 (const Sampler& sampler, const json& content) {
    std::optional<std::string> declared;
    for (auto entry = content.begin (); entry != content.end (); ++entry) {
        if (media_type (json (entry.key ())) == "application/octet-stream") {
            declared = entry.key ();
            break;
        }
    }
    if (!declared) {
        for (auto entry = content.begin (); entry != content.end (); ++entry) {
            if (sampler.declares_file (prop (&entry.value (), "schema"))) {
                declared = entry.key ();
                break;
            }
        }
    }
    if (!declared) {
        return std::nullopt;
    }
    DraftBody body;
    body.mode         = "binary";
    body.content_type = sendable_media_type (*declared);
    return body;
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
        body.mode = "json";
        // A string `example` is the body's bytes as written, `{{variable}}`
        // tokens included: `js_json_text` would re-quote it into a JSON string
        // literal, which the export avoids by writing such a body as a string
        // (#1441).
        body.content = example_body_text (sample);
        return body;
    }
    if (std::optional<DraftBody> text = text_body_v3 (*content)) {
        return std::move (*text);
    }
    for (const char* type : { "application/x-www-form-urlencoded", "multipart/form-data" }) {
        const json* declared = prop (content, type);
        if (!truthy (declared)) {
            continue;
        }
        const bool multipart = std::string_view (type) == "multipart/form-data";
        body.mode   = multipart ? "form-data" : "x-www-form-urlencoded";
        body.fields = sampler.form_fields (prop (declared, "schema"));
        // A document names the upload, never the file, so the part imports with
        // no path for the user to attach. Only under multipart: urlencoded has
        // no file form on the wire, so a `format: binary` there cannot mean
        // what it says.
        if (!multipart) {
            for (DraftField& field : body.fields) {
                field.file = false;
            }
        }
        return body;
    }
    if (std::optional<DraftBody> file = binary_body_v3 (sampler, *content)) {
        // Not a loss: counted so the preview can say a file is still to choose.
        tally_add (tally, "file_body");
        return std::move (*file);
    }
    // A media type the importer has no mode for (an `image/png` with no binary
    // schema) is `none`, as no body is, and the draft is identical. Only the
    // tally tells them apart: an operation without `requestBody` lost nothing,
    // one that declared a media type lost its body (#719).
    if (!content->empty ()) {
        tally_add (tally, "unmapped_body");
    }
    return body;
}

// ---------------------------------------------------------------------------
// Documented responses
// ---------------------------------------------------------------------------

/// `findJsonMediaType(content)`: the key of a 3.x `content` map's JSON media
/// type. `find_json_media` returns the node; an example needs the type's name,
/// its row's `Content-Type`.
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
    /// The `examples` map key this payload was read from (issue #1457),
    /// absent when it came from a single `example` or a sampled schema.
    std::optional<std::string> example_key;
};

/**
 * `responseExample(code, response, payload)`: one `responses` entry as a saved
 * example, or absent when it cannot be stored as one. Shared by both dialects,
 * which differ only in where the payload lives (@p payload). A key that is not
 * a final numeric status (`default`, `2XX`, a 1xx) has no status line to be
 * served under and is skipped; the renderer counts those for its preview, which
 * a draft lacks.
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
        // Spec-conformant and near-universal (Stripe declares one on all 568
        // operations), so it is counted apart from a malformed key rather than
        // painting a valid document as one defect per operation.
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
    if (status < constants::request_example::MIN_STATUS ||
    status > constants::request_example::MAX_STATUS) {
        tally_add (tally, "example_no_status");
        return std::nullopt;
    }

    const std::optional<ExamplePayload> found = payload (*node);
    DraftExample example;
    // "200 - A user" when the document describes the response, "200" when not:
    // the status leads, being what a reader scans a list of examples for.
    const std::string* description = as_str (prop (node, "description"));
    example.name = description == nullptr ? code : code + " - " + *description;
    example.status           = status;
    example.documented       = found.has_value ();
    example.content_type     = found ? found->content_type : std::string ();
    example.body             = found ? found->body : std::string ();
    example.spec_example_key = found ? found->example_key : std::nullopt;
    return example;
}

/// The JSON media type of a 3.x response's `content` as a payload: its declared
/// example, else a sample of its schema, else nothing.
std::optional<ExamplePayload> json_example_payload (const Sampler& sampler,
const json& content,
const std::string& type) {
    const json* media = as_record (prop (&content, type));
    if (media == nullptr) {
        return std::nullopt;
    }
    // `declared ?? sample`: see `declared_example_value` for the `??`
    // this stands in for.
    const DeclaredExampleValue declared = declared_example_value (media);
    if (declared.value != nullptr && !declared.value->is_null ()) {
        return ExamplePayload{ example_body_text (*declared.value), type,
            declared.key };
    }
    if (const json* schema = prop (media, "schema"); truthy (schema)) {
        return ExamplePayload{ example_body_text (sampler.sample (schema)), type, {} };
    }
    return std::nullopt;
}

/// A text-family media type: `text/*`, or an `xml` / `html` subtype under any
/// top-level type (`application/xml`, `application/html`).
bool is_text_media_type (const std::string& key) {
    const std::string bare = media_type (json (key));
    const auto has_subtype = [&bare] (std::string_view subtype) {
        return bare.size () > subtype.size () &&
        bare.compare (bare.size () - subtype.size (), subtype.size (), subtype) == 0;
    };
    return bare.rfind ("text/", 0) == 0 || has_subtype ("/xml") || has_subtype ("/html");
}

/**
 * Whether a declared example under media type @p key is served as the bytes it
 * is: the example is a string, or the key is a text-family type. A media range
 * (any key with a wildcard) names no type, so it never becomes a literal
 * `Content-Type`; a `null` example is no example.
 */
bool is_text_example (const std::string& key, const json& value) {
    if (value.is_null () || key.find ('*') != std::string::npos) {
        return false;
    }
    return value.is_string () || is_text_media_type (key);
}

/**
 * The first non-JSON media type of @p content, in document order, whose
 * declared example is served as the bytes it is (`is_text_example`). Only a
 * declared example: a schema samples into JSON, and JSON under `text/csv` or
 * `text/html` documents nothing the spec said, so a schema-only media type
 * stays unchosen.
 */
std::optional<ExamplePayload> text_example_payload (const json& content) {
    for (auto entry = content.begin (); entry != content.end (); ++entry) {
        const DeclaredExampleValue declared =
        declared_example_value (as_record (&entry.value ()));
        if (declared.value != nullptr &&
        is_text_example (entry.key (), *declared.value)) {
            return ExamplePayload{ example_body_text (*declared.value),
                entry.key (), declared.key };
        }
    }
    return std::nullopt;
}

/// What a 3.x response documents: its JSON media type when that yields a body,
/// else the first text example. A `content` map with entries and neither is
/// counted, so the preview says a documented response imported without its body.
std::optional<ExamplePayload>
response_payload_v3 (const Sampler& sampler, const json& node, ImportTally* tally) {
    const json* content = as_record (prop (&node, "content"));
    if (content == nullptr) {
        return std::nullopt;
    }
    if (const std::optional<std::string> type = find_json_media_type (*content)) {
        if (std::optional<ExamplePayload> json_payload =
            json_example_payload (sampler, *content, *type)) {
            return json_payload;
        }
    }
    if (std::optional<ExamplePayload> text = text_example_payload (*content)) {
        return text;
    }
    if (!content->empty ()) {
        tally_add (tally, "example_no_media_type");
    }
    return std::nullopt;
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
        // A response that is itself a `$ref` is read through, one hop: the
        // shape a document declaring its errors once and naming them everywhere
        // leaves (#714).
        const json* response = sampler.deref (&entry.value ());
        auto example =
        response_example (entry.key (), response, tally, [&] (const json& node) {
            return response_payload_v3 (sampler, node, tally);
        });
        if (example) {
            out.push_back (std::move (*example));
        }
    }
    return out;
}

/**
 * The JSON media type a 2.0 operation says it produces, if any. With no
 * `produces` (and no document default) an operation documents JSON by
 * convention, which the fallback says.
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
            produces.push_back (
            entry.is_string () ? entry.get<std::string> () : std::string ());
        }
    }
    return produces;
}

/**
 * A 2.0 response's JSON body: the example it documents, or a sample of its
 * schema. `declared[contentType] ?? declared["application/json"]`, then
 * `!== undefined`: an explicitly documented `null` is a body ("null"), while a
 * `null` under the produced type falls through to the plain one first.
 */
std::optional<ExamplePayload>
json_payload_v2 (const json& node, const Sampler& sampler, const std::string& content_type) {
    if (const json* documented = as_record (prop (&node, "examples"))) {
        const json* value = prop (documented, content_type);
        if (value == nullptr || value->is_null ()) {
            const json* plain = prop (documented, "application/json");
            value             = plain != nullptr ? plain : value;
        }
        if (value != nullptr) {
            return ExamplePayload{ example_body_text (*value), content_type, {} };
        }
    }
    const json* schema = prop (&node, "schema");
    if (!truthy (schema)) {
        return std::nullopt;
    }
    return ExamplePayload{ example_body_text (sampler.sample (schema)), content_type, {} };
}

/// The first entry of a 2.0 response's `examples`, in document order, served as
/// the bytes it is (`is_text_example`), under its own key: `examples` is keyed
/// by MIME type, so the key is the media type whatever `produces` lists.
std::optional<ExamplePayload> text_payload_v2 (const json& node) {
    const json* documented = as_record (prop (&node, "examples"));
    if (documented == nullptr) {
        return std::nullopt;
    }
    for (auto entry = documented->begin (); entry != documented->end (); ++entry) {
        if (is_text_example (entry.key (), entry.value ())) {
            return ExamplePayload{ example_body_text (entry.value ()), entry.key (), {} };
        }
    }
    return std::nullopt;
}

/// Whether a 2.0 response documents a body at all: an `examples` map with
/// entries, or a schema - the same "something was declared" test as a 3.x
/// response's non-empty `content`.
bool documents_a_body_v2 (const json& node) {
    const json* examples = as_record (prop (&node, "examples"));
    return (examples != nullptr && !examples->empty ()) || truthy (prop (&node, "schema"));
}

/**
 * What a 2.0 response documents, by the 3.x rule: a JSON body when there is a
 * JSON type to give it (the operation's, else a JSON key of `examples`), else
 * the first text example. A schema samples only into JSON, so a response that
 * documents something yet yields no body is counted, and the preview says so.
 */
std::optional<ExamplePayload> response_payload_v2 (const json& node,
const Sampler& sampler,
const std::optional<std::string>& json_produced,
ImportTally* tally) {
    std::optional<std::string> json_type = json_produced;
    if (const json* documented = as_record (prop (&node, "examples"));
    !json_type && documented != nullptr) {
        json_type = find_json_media_type (*documented);
    }
    if (json_type) {
        if (std::optional<ExamplePayload> json_payload =
            json_payload_v2 (node, sampler, *json_type)) {
            return json_payload;
        }
    }
    if (std::optional<ExamplePayload> text = text_payload_v2 (node)) {
        return text;
    }
    if (documents_a_body_v2 (node)) {
        tally_add (tally, "example_no_media_type");
    }
    return std::nullopt;
}

/**
 * A 2.0 operation's documented responses. 2.0 puts the payload on the response,
 * not under a media-type map: `examples` is keyed by MIME type and holds the
 * value, and `schema` describes it. The JSON type comes from the operation's
 * `produces`, else the document's, since a 2.0 response names none.
 */
std::vector<DraftExample> examples_v2 (const json& document,
const Sampler& sampler,
const json* operation,
ImportTally* tally) {
    std::vector<DraftExample> out;
    const json* map = as_record (prop (operation, "responses"));
    if (map == nullptr) {
        return out;
    }

    const std::optional<std::string> json_produced =
    json_produced_type (produced_types (document, operation));

    for (auto entry = map->begin (); entry != map->end (); ++entry) {
        const json* response = sampler.deref (&entry.value ());
        auto example =
        response_example (entry.key (), response, tally, [&] (const json& node) {
            return response_payload_v2 (node, sampler, json_produced, tally);
        });
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
    return vayu::utils::ascii_lower (text.substr (begin, end - begin + 1));
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
        // The operation's own id, not the identity's: a repeated one is dropped
        // from the identity (#715), but the request is still named after it.
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
 * One parameter, as the row it becomes. `in: "path"` is neither a row nor
 * counted: a path parameter is already carried as the `{{var}}` the URL was
 * rewritten with.
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
    const std::string* in          = as_str (prop (parameter, "in"));
    const std::string kind         = in == nullptr ? std::string () : *in;
    const json* required           = prop (parameter, "required");
    const std::string* description = as_str (prop (parameter, "description"));

    const json* enabled_override = prop (parameter, "x-vayu-enabled");
    if (kind == "query") {
        const json* value = dialect == walk::Dialect::V3 ?
        declared_param_value_v3 (sampler, parameter) :
        // 2.0 states a non-body parameter's value inline as `default`;
        // it has no `example` keyword (that arrived with 3.x).
        prop (parameter, "default");
        draft.params.push_back (
        declared_param_row (name, value, required, description, enabled_override));
    } else if (kind == "header") {
        if (is_self_produced_header (name)) {
            return;
        }
        const json* value = dialect == walk::Dialect::V3 ?
        declared_param_value_v3 (sampler, parameter) :
        prop (parameter, "default");
        // No description: the Headers table has no column for one.
        draft.headers.push_back (
        declared_param_row (name, value, required, nullptr, enabled_override));
    } else if (dialect == walk::Dialect::V2 && kind == "body" &&
    sampler.declares_file (prop (parameter, "schema"))) {
        // One file's bytes; its media type comes from `consumes`, below.
        draft.body.mode    = "binary";
        draft.body.content = "";
        tally_add (tally, "file_body");
    } else if (dialect == walk::Dialect::V2 && kind == "body") {
        const json* schema = prop (parameter, "schema");
        const json sample = truthy (schema) ? sampler.sample (schema) : json::object ();
        draft.body.content = js_json_text (sample);
        draft.body.mode    = "json"; // Corrected below against `consumes`.
    } else if (dialect == walk::Dialect::V2 && kind == "formData") {
        DraftField field;
        field.key                   = name;
        const std::string* declared = as_str (prop (parameter, "type"));
        field.file = declared != nullptr && *declared == "file";
        form_fields.push_back (std::move (field));
    } else if (dialect == walk::Dialect::V3 && kind == "cookie") {
        // Dropped (a request's cookies come from the jar) and counted, not
        // folded into one `Cookie` header, which would invent a merge the
        // document never wrote (#719). 2.0 has no cookie parameter.
        tally_add (tally, "cookie_param");
    }
}

/**
 * Every parameter the operation and its path item declare, as the rows a draft
 * carries: query, header, 2.0's `body` and `formData`, and the 3.x `cookie`
 * that is dropped and counted.
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
 * The 2.0 body, corrected against what the operation `consumes`. 2.0 ties
 * `formData` encoding to `consumes`, urlencoded and multipart being distinct
 * wire encodings and body modes. Multipart wins when both are listed (only it
 * carries a `type: file` field), and a `consumes` naming neither keeps the
 * multipart default. A file part has no urlencoded form, so a document
 * declaring one under a urlencoded-only `consumes` contradicts itself, and
 * multipart is the half that can carry the field.
 */
void apply_v2_body_encoding (const json& document,
const json* operation,
std::vector<DraftField>& form_fields,
DraftRequest& draft) {
    const std::vector<std::string> consumes = consumes_of (document, operation);
    if (draft.body.mode == "binary") {
        // `application/octet-stream` when listed, else the first type a
        // request can be sent under, else none (derived from the file).
        const auto octet = std::find_if (
        consumes.begin (), consumes.end (), [] (const std::string& type) {
            return media_type (type) == "application/octet-stream";
        });
        if (octet != consumes.end ()) {
            draft.body.content_type = media_type (*octet);
        } else {
            for (const std::string& type : consumes) {
                if (std::string sendable = sendable_media_type (type); !sendable.empty ()) {
                    draft.body.content_type = std::move (sendable);
                    break;
                }
            }
        }
    }
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
        const bool urlencoded =
        std::any_of (consumes.begin (), consumes.end (), [] (const std::string& type) {
            return media_type (type) == "application/x-www-form-urlencoded";
        });
        const bool multipart =
        std::any_of (consumes.begin (), consumes.end (), [] (const std::string& type) {
            return media_type (type) == "multipart/form-data";
        });
        const bool has_file = std::any_of (form_fields.begin (),
        form_fields.end (), [] (const DraftField& field) { return field.file; });
        draft.body.mode =
        (urlencoded && !multipart && !has_file) ? "x-www-form-urlencoded" : "form-data";
        draft.body.content = "";
        draft.body.fields  = std::move (form_fields);
    }
}

/**
 * The operation members only an import reads (its `security` and the `x-vayu-*`
 * extensions a Vayu export writes), copied verbatim onto @p entry. None reaches
 * `DraftRequest`, which the sync diff compares: a re-fetched document must
 * never overwrite a user's local edit.
 */
void read_import_only_members (const json* operation, SpecRequestDraft& entry) {
    if (const json* security = prop (operation, "security"); security != nullptr) {
        entry.security = *security;
    }
    if (const json* elements = prop (operation, "x-vayu-elements");
    elements != nullptr && elements->is_array ()) {
        entry.elements = *elements;
    }
    if (const json* mock = prop (operation, "x-vayu-mock");
    mock != nullptr && mock->is_object ()) {
        entry.mock = *mock;
    }
    if (const json* request = prop (operation, "x-vayu-request");
    request != nullptr && request->is_object ()) {
        entry.vayu_request = *request;
    }
}

/**
 * The drafts, for either caller: the sync diff, wanting the operations a
 * document declares, and the import, wanting a request for every operation it
 * writes plus a tally of what it dropped. One function, because a draft the two
 * built differently is the divergence #865 exists to prevent: the import would
 * apply a request the diff never compared.
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
        read_import_only_members (operation, entry);

        DraftRequest& draft = entry.draft;
        name_draft (operation, walked, draft);
        if (tally != nullptr) {
            tally->set_subject (draft.name);
        }
        if (const json* deprecated = prop (operation, "deprecated"); deprecated != nullptr &&
        deprecated->is_boolean () && deprecated->get<bool> ()) {
            // Vayu's request model has no deprecated flag, so the operation
            // imports like a current one, counted so the loss is named (#1444).
            tally_add_count (tally, "deprecated_operation", 1);
        }

        std::vector<DraftField> form_fields;
        read_draft_parameters (document, walked, dialect, sampler, tally, draft, form_fields);

        if (dialect == walk::Dialect::V2) {
            apply_v2_body_encoding (document, operation, form_fields, draft);
        } else {
            draft.body = body_v3 (sampler, prop (operation, "requestBody"), tally);
        }


        draft.examples = dialect == walk::Dialect::V3 ?
        examples_v3 (sampler, prop (operation, "responses"), tally) :
        examples_v2 (document, sampler, operation, tally);

        // Not Postman's set (#1771): the sync diff compares stored URLs with
        // this one, so another encoding would mark every bound request changed.
        draft.url = append_params ("{{baseUrl}}" + normalize_path_templates (path),
        draft.params, QueryEncoding::UriComponent);

        entry.identified = walked.identified;
        entry.operation  = std::move (walked.identity);
        drafts.push_back (std::move (entry));
    }
    if (tally != nullptr) {
        tally->set_subject ({});
    }
    tally_add_count (tally, "malformed_spec", notes.malformed_spec);
    tally_add_count (tally, "unsupported_method", notes.unsupported_method);
    tally_add_count (tally, "duplicate_operation_id", notes.duplicate_operation_id);
    tally_add_count (tally, "webhook_operations", notes.webhook_operations);
    return drafts;
}

/// Appends each of @p added that @p list does not already hold, in order.
void append_distinct (std::vector<std::string>& list, const std::vector<std::string>& added) {
    for (const std::string& name : added) {
        if (std::find (list.begin (), list.end (), name) == list.end ()) {
            list.push_back (name);
        }
    }
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
    auto entry = std::find_if (counts_.begin (), counts_.end (),
    [kind] (const Entry& existing) { return existing.kind == kind; });
    if (entry == counts_.end ()) {
        entry = counts_.insert (counts_.end (), Entry{ std::string (kind), 0, {}, {} });
    }
    entry->count += count;
    if (!subject_.empty () &&
    std::find (entry->requests.begin (), entry->requests.end (), subject_) ==
    entry->requests.end ()) {
        entry->requests.push_back (subject_);
    }
}

void ImportTally::set_subject (std::string subject) {
    subject_ = std::move (subject);
}

void ImportTally::name_requests (std::string_view kind,
const std::vector<std::string>& requests) {
    auto entry = std::find_if (counts_.begin (), counts_.end (),
    [kind] (const Entry& existing) { return existing.kind == kind; });
    if (entry != counts_.end ()) {
        append_distinct (entry->requests, requests);
    }
}

void ImportTally::name_dropped (std::string_view kind, const std::vector<std::string>& names) {
    auto entry = std::find_if (counts_.begin (), counts_.end (),
    [kind] (const Entry& existing) { return existing.kind == kind; });
    if (entry != counts_.end ()) {
        append_distinct (entry->names, names);
    }
}

nlohmann::ordered_json ImportTally::items () const {
    // The order `SkippedItem["kind"]` declares, so two walks of one document
    // produce one list whatever order they met the losses in. A kind outside
    // that closed set (#1518: JMeter's class names, open-ended) is appended
    // after, in `counts_`' insertion order, rather than silently lost.
    static constexpr auto ORDER = std::to_array<const char*> ({ "websocket", "grpc",
    "api_spec", "unit_test", "file_body", "malformed_item", "unsupported_method",
    "malformed_spec", "example_no_status", "example_no_media_type",
    "default_response", "external_ref", "duplicate_operation_id",
    "webhook_operations", "deprecated_operation", "cookie_param", "unmapped_body",
    "unresolved_base_url", "no_server_url", "servers_dropped", "unsupported_auth",
    "security_unmapped_or", "security_unmapped_and", "security_unmapped_scheme",
    "security_unmapped_mutualtls", "security_unmapped_openidconnect",
    "security_unmapped_type", "security_unmapped_apikey_cookie",
    "apikey_cookie_header", "oauth2_dropped_field", "oauth2_state_regenerated",
    "oauth2_unmapped_param", "url_without_raw", "variable_metadata", "disabled_body",
    "certificate", "proxy_config", "protocol_behavior", "protocol_behavior_folder",
    "body_on_get", "script_unsupported", "script_unsupported_insomnia" });

    const auto item_of = [] (const Entry& entry) {
        nlohmann::ordered_json item = { { "kind", entry.kind }, { "count", entry.count } };
        if (!entry.requests.empty ()) {
            item["requests"] = entry.requests;
        }
        if (!entry.names.empty ()) {
            item["names"] = entry.names;
        }
        return item;
    };
    nlohmann::ordered_json items = nlohmann::ordered_json::array ();
    std::unordered_set<std::string> emitted;
    for (const char* kind : ORDER) {
        for (const auto& entry : counts_) {
            if (entry.kind == kind) {
                items.push_back (item_of (entry));
                emitted.insert (entry.kind);
            }
        }
    }
    for (const auto& entry : counts_) {
        if (emitted.insert (entry.kind).second) {
            items.push_back (item_of (entry));
        }
    }
    return items;
}

} // namespace vayu::core
