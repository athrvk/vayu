/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Assembling a collection back into an OpenAPI document (#855); the header
 * gives the two directions and why neither invents.
 *
 * The rules are the renderer's, ported rather than re-derived: each was learned
 * from a document somebody exported and could not re-import, and
 * `openapi_export_test.cpp` carries the cases that found them.
 */

#include "vayu/core/openapi_export.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/operation_match.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/ordered_json.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <format>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using Json = nlohmann::ordered_json;

/// 3.1, the current dialect: a skeleton has no stored dialect to preserve, the
/// only reason the bound direction pins one.
constexpr std::string_view SKELETON_VERSION = "3.1.0";

/// `info.version` is required and a collection records none. Not `1.0.0`: a
/// version nobody chose should not read like a release.
constexpr std::string_view PLACEHOLDER_VERSION = "0.0.0";

/// Load-bearing: it tells "the API declares this" from "Vayu saw one body like
/// this" to readers who were not there when the document was made.
constexpr std::string_view DERIVED_SCHEMA_NOTE =
"Shape derived from an example body, not a declared schema.";

/// Whether a Params or Headers row is on; neither `required` nor an empty
/// `value` says so (#1441, `parameter_object`).
constexpr std::string_view ROW_ENABLED_KEY = "x-vayu-enabled";

/// Every method key a Path Item Object may carry. `trace` is absent from
/// `declared_operations_of`'s list on purpose: no request carries a `trace`
/// identity, but a declared one is still removed when nothing claims it.
constexpr std::array<std::string_view, 8> PATH_ITEM_METHODS = { "get", "put",
    "post", "delete", "options", "head", "patch", "trace" };

/// Never declared as parameters: `security` states `Authorization`, the body's
/// media type states `Content-Type`. The import drops the same two, so a round
/// trip does not grow a parameter each time.
constexpr std::array<std::string_view, 2> NON_PARAMETER_HEADERS = {
    "authorization", "content-type"
};

std::string_view trim (std::string_view text) {
    const auto is_space = [] (char c) {
        return std::isspace (static_cast<unsigned char> (c)) != 0;
    };
    while (!text.empty () && is_space (text.front ())) {
        text.remove_prefix (1);
    }
    while (!text.empty () && is_space (text.back ())) {
        text.remove_suffix (1);
    }
    return text;
}

/// A non-empty string value, else `""`: the renderer's `asStr` plus the
/// falsiness its call sites apply.
std::string string_member (const Json& node, const std::string& key) {
    if (!node.is_object ()) {
        return {};
    }
    const auto found = node.find (key);
    if (found == node.end () || !found->is_string ()) {
        return {};
    }
    return found->get<std::string> ();
}

/// The object at `node[key]`, created empty when it is missing or not an object.
Json& child_record (Json& node, std::string_view key) {
    const std::string name (key);
    const auto found = node.find (name);
    if (found == node.end () || !found->is_object ()) {
        node[name] = Json::object ();
    }
    return node[name];
}

/**
 * A body as an `example` value: JSON when it parses, else the text itself. A
 * stored body is whatever the server sent or the spec declared, so XML or a
 * plain-text error is written as a string rather than dropped; `example` is
 * "any value".
 */
Json example_value (const std::string& body) {
    const std::string_view text = trim (body);
    if (text.empty ()) {
        return std::string ();
    }
    auto parsed =
    vayu::utils::parse_ordered_json (text, vayu::utils::ORDERED_JSON_UNBOUNDED);
    if (!parsed) {
        return body;
    }
    return std::move (*parsed);
}

/// Built member by member: the initializer-list spelling builds a temporary
/// array per object first, twice the allocations, and a derived schema holds
/// one per member.
Json type_only (const char* type) {
    Json shape = Json::object ();
    shape.emplace ("type", type);
    return shape;
}

/**
 * The shape of one example value, deliberately shallow: types, an object's
 * `properties`, an array's first element as `items`, nothing else. No
 * `required`, formats or enums: those are claims about the endpoint one sample
 * cannot support.
 *
 * @p depth stops at the reader's nesting bound for the same reason it has one:
 * the walk is recursive and the value is a stored body, not anything Vayu
 * wrote.
 */
Json shape_of (const Json& value, size_t depth) {
    if (value.is_null ()) {
        return type_only ("null");
    }
    if (value.is_array ()) {
        // An empty array states its type only: `items` from no member would be
        // an invention.
        Json out = type_only ("array");
        if (!value.empty () && depth < constants::spec_document::MAX_READ_DEPTH) {
            out["items"] = shape_of (value.front (), depth + 1);
        }
        return out;
    }
    if (value.is_string ()) {
        return type_only ("string");
    }
    if (value.is_boolean ()) {
        return type_only ("boolean");
    }
    if (value.is_number ()) {
        return type_only (value.is_number_integer () ? "integer" : "number");
    }
    Json properties = Json::object ();
    if (depth < constants::spec_document::MAX_READ_DEPTH) {
        vayu::utils::reserve_members (properties, value.size ());
        for (auto member = value.begin (); member != value.end (); ++member) {
            // `value` is a parsed object, so its keys are distinct.
            vayu::utils::append_unique_member (
            properties, member.key (), shape_of (member.value (), depth + 1));
        }
    }
    return Json{ { "type", "object" }, { "properties", std::move (properties) } };
}

Json schema_from_example (const Json& value) {
    Json schema = shape_of (value, 0);
    // Room first: growing the object would copy `properties`, as wide as the
    // body (`reserve_members` says why).
    vayu::utils::reserve_members (schema, 1);
    schema["description"] = std::string (DERIVED_SCHEMA_NOTE);
    return schema;
}

/**
 * Items grouped by key, in first-seen order: the order examples were stored is
 * the order their statuses are written, and a hash order would make two
 * collections' documents differ for no reason a reader could name.
 */
template <typename KeyOf>
std::vector<std::pair<std::string, std::vector<const ExportExample*>>>
group_by (const std::vector<const ExportExample*>& items, KeyOf key_of) {
    std::vector<std::pair<std::string, std::vector<const ExportExample*>>> groups;
    for (const ExportExample* item : items) {
        const std::string key = key_of (*item);
        const auto found      = std::find_if (groups.begin (), groups.end (),
        [&] (const auto& group) { return group.first == key; });
        if (found == groups.end ()) {
            groups.push_back ({ key, { item } });
        } else {
            found->second.push_back (item);
        }
    }
    return groups;
}

/**
 * @p wanted, or its first free suffix in @p map. A shared name is suffixed,
 * never overwritten: losing an example to a collision is the silent drop this
 * export may not make, and a bound map holds entries Vayu never read.
 */
std::string free_key (const Json& map, const std::string& wanted) {
    std::string key = wanted;
    int suffix      = 2;
    while (map.contains (key)) {
        key = wanted + "-" + std::to_string (suffix++);
    }
    return key;
}

/**
 * Several examples of one status and media type, added to an `examples` map
 * under their names. Added, never assigned over: in a bound export the map is
 * the document's, and an entry this export did not read it may not drop.
 */
void add_named_examples (Json& map,
const std::vector<const ExportExample*>& examples,
const std::vector<Json>& values) {
    for (size_t index = 0; index < examples.size (); ++index) {
        const std::string wanted    = examples[index]->name.empty () ?
        "example-" + std::to_string (index + 1) :
        examples[index]->name;
        map[free_key (map, wanted)] = Json{ { "value", values[index] } };
    }
}

/**
 * Several examples of one status and media type, each written into the
 * `examples` entry it was imported from (#1457); the rest go through
 * `add_named_examples`.
 *
 * A value comparison cannot tell an edited example from a new one, so an edited
 * example that named a key at import lands in that entry, keeping its `summary`
 * and `description`. One naming no key, or a key the document no longer
 * declares (a re-fetched spec renamed it), is added under a free key.
 */
void write_named_examples (Json& map,
const std::vector<const ExportExample*>& examples,
const std::vector<Json>& values) {
    std::vector<const ExportExample*> unmatched_examples;
    std::vector<Json> unmatched_values;
    for (size_t index = 0; index < examples.size (); ++index) {
        const ExportExample& example = *examples[index];
        const auto entry =
        example.spec_example_key ? map.find (*example.spec_example_key) : map.end ();
        if (entry != map.end () && entry->is_object ()) {
            (*entry)["value"] = values[index];
            continue;
        }
        unmatched_examples.push_back (examples[index]);
        unmatched_values.push_back (values[index]);
    }
    add_named_examples (map, unmatched_examples, unmatched_values);
}

/**
 * One implementation for both directions, because which status, which media
 * type and what to do with a second example of one pair are the same questions.
 * The difference is who owns the document: a skeleton writes one that does not
 * exist yet, a bound export edits the user's contract. Everything reading
 * `ExportDirection` follows from that.
 */
enum class ExportDirection : std::uint8_t { Bound, Skeleton };

/**
 * A media object's `example` and every `examples` entry's payload. A stored
 * example equal to one is in the contract already; an imported one equal to
 * none came from a schema the import sampled.
 */
std::vector<const Json*> declared_example_values (const Json* media) {
    std::vector<const Json*> values;
    if (media == nullptr) {
        return values;
    }
    if (const auto single = media->find ("example"); single != media->end ()) {
        values.push_back (&*single);
    }
    const auto map = media->find ("examples");
    if (map == media->end () || !map->is_object ()) {
        return values;
    }
    for (const auto& entry : *map) {
        // `externalValue` names a URL, nothing to compare a stored body to.
        if (const auto value = entry.find ("value");
        entry.is_object () && value != entry.end ()) {
            values.push_back (&*value);
        }
    }
    return values;
}

/**
 * Compared through `nlohmann::json`, not `ordered_json`: an ordered object
 * compares members positionally, so `{"id":1,"name":"a"}` and
 * `{"name":"a","id":1}` would differ. A document reformatted between import and
 * export still declares the same example, and answering otherwise would add a
 * second copy of it.
 */
bool same_value (const Json& left, const Json& right) {
    return nlohmann::json (left) == nlohmann::json (right);
}

/**
 * Whether @p declared, a value the document wrote, is the example stored as
 * @p body that reads back as @p value.
 *
 * A declared string is imported as its bytes (`example_body_text`) and read
 * back as JSON: text `"42"` is stored as `42`, so a string also matches by its
 * text (#3424). The one predicate `disposition_of` and `written_key_for` share,
 * so the export neither rewrites such an example nor loses its mock key.
 */
bool declares_example (const Json& declared, const Json& value, const std::string& body) {
    return same_value (declared, value) ||
    (declared.is_string () && declared.get<std::string> () == body);
}

/** What one stored example is to the media object it would be written into. */
enum class ExampleDisposition : std::uint8_t {
    Write,
    AlreadyDeclared,
    SampledAtImport
};

/**
 * A skeleton always writes; it has no document to be second to. A bound export
 * answers three ways, and the two that are not `Write` are why an unedited
 * spec-origin collection exports the document it came from.
 */
ExampleDisposition disposition_of (const ExportExample& example,
const Json& value,
const Json* media,
ExportDirection direction) {
    if (direction == ExportDirection::Skeleton) {
        return ExampleDisposition::Write;
    }
    const std::vector<const Json*> declared = declared_example_values (media);
    const bool documented =
    std::any_of (declared.begin (), declared.end (), [&] (const Json* candidate) {
        return declares_example (*candidate, value, example.body);
    });
    if (documented) {
        return ExampleDisposition::AlreadyDeclared;
    }
    // An imported example exists because the import read this media object
    // (`openapi_drafts.cpp`, `examples_v3`). With no declared example to match,
    // the import sampled it off the schema, and writing it back would document
    // a value the API never stated.
    if (declared.empty () && example.from_import) {
        return ExampleDisposition::SampledAtImport;
    }
    return ExampleDisposition::Write;
}

/**
 * The examples of one status that can honestly be written, and counts for the
 * rest.
 *
 * A capped body is the first slice of a response (#659): as an `example` it
 * would pass for a complete one, and a failed parse falls back to the raw
 * string, so half a document would enter the contract as a quoted fragment.
 * Checked before the media type, so a truncated body with no recorded type
 * counts once, as the loss that stopped it. A body with no stated media type
 * has no honest `content` key either. In both cases the response still lands (a
 * 204 documents itself) and the count says the body did not.
 */
std::vector<const ExportExample*>
writable_examples (const std::vector<const ExportExample*>& group, ExportNotes& notes) {
    std::vector<const ExportExample*> writable;
    for (const ExportExample* example : group) {
        if (example->body_truncated) {
            notes.examples_truncated += 1;
            continue;
        }
        if (example->content_type.empty ()) {
            notes.examples_without_media_type += 1;
            continue;
        }
        writable.push_back (example);
    }
    return writable;
}

/**
 * The media object a response documents for @p content_type, or `nullptr`. A
 * read, where the write path uses `child_record`: asking must not add a
 * `content` key to a response that has none.
 */
const Json* declared_media_of (const Json* response, const std::string& content_type) {
    if (response == nullptr) {
        return nullptr;
    }
    const auto content = response->find ("content");
    if (content == response->end () || !content->is_object ()) {
        return nullptr;
    }
    const auto media = content->find (content_type);
    return media == content->end () || !media->is_object () ? nullptr : &*media;
}

/** One media type's examples that are going to be written, and their values. */
struct MediaWrite {
    std::vector<const ExportExample*> examples;
    std::vector<Json> values;
};

/**
 * Which of one media type's examples are news to the document, and counts for
 * the rest. Decided before anything is created, from the existing media object
 * (`nullptr` for none): a response nobody documented must not gain an empty
 * `content` by being asked about.
 */
MediaWrite select_examples (const std::vector<const ExportExample*>& media_group,
const Json* declared_media,
ExportNotes& notes,
ExportDirection direction) {
    MediaWrite write;
    for (const ExportExample* example : media_group) {
        Json value = example_value (example->body);
        const ExampleDisposition disposition =
        disposition_of (*example, value, declared_media, direction);
        if (disposition == ExampleDisposition::AlreadyDeclared) {
            notes.examples_already_declared += 1;
            continue;
        }
        if (disposition == ExampleDisposition::SampledAtImport) {
            notes.examples_sampled_at_import += 1;
            continue;
        }
        write.examples.push_back (example);
        write.values.push_back (std::move (value));
    }
    return write;
}

/**
 * The `examples` map a write goes into, holding everything the media object
 * already documents, in its order. A declared `example` moves in, under the key
 * `example`: the two members are mutually exclusive, so answering with a map
 * may not drop the one value it had.
 */
Json examples_map_of (Json& media) {
    Json map = Json::object ();
    if (const auto single = media.find ("example"); single != media.end ()) {
        map["example"] = Json{ { "value", *single } };
        media.erase ("example");
    }
    if (const auto existing = media.find ("examples");
    existing != media.end () && existing->is_object ()) {
        for (auto entry = existing->begin (); entry != existing->end (); ++entry) {
            map[free_key (map, entry.key ())] = entry.value ();
        }
    }
    return map;
}

/**
 * One media type's examples under a response, as `example` or `examples`, never
 * both (OpenAPI makes them exclusive). The document's choice wins where it made
 * one: a map gains an entry and keeps every entry, and a single `example`
 * becomes a map only when a second example needs a place, carrying the declared
 * value in.
 */
void write_media_examples (Json& media, const MediaWrite& write, ExportNotes& notes, ExportDirection direction) {
    const std::vector<const ExportExample*>& writing = write.examples;
    const std::vector<Json>& values                  = write.values;
    if (direction == ExportDirection::Skeleton && media.find ("schema") == media.end ()) {
        // A bound document states its responses' shape already, and one stored
        // body's shape is no improvement on the contract's schema.
        media["schema"] = schema_from_example (values.front ());
    }
    if (writing.size () == 1 && !media.contains ("examples")) {
        media["example"] = values.front ();
    } else {
        Json map = examples_map_of (media);
        write_named_examples (map, writing, values);
        media["examples"] = std::move (map);
    }
    notes.examples_written += static_cast<int> (writing.size ());
}

/**
 * The description of an undeclared response: the example's own name, which
 * beats a generated line.
 *
 * `response_example` names a described response "<status> - <description>", so
 * one leading prefix is normal and stays. A doubled prefix (a reimported
 * export's own generated description, prefixed again) loses one copy, or each
 * export/reimport cycle would accrete another.
 */
std::string undeclared_response_description (const std::string& status,
const std::string& example_name) {
    const std::string self_prefix    = status + " - ";
    const std::string doubled_prefix = self_prefix + self_prefix;
    const std::string description =
    example_name.compare (0, doubled_prefix.size (), doubled_prefix) == 0 ?
    example_name.substr (self_prefix.size ()) :
    example_name;
    return description.empty () ? status + " response" : description;
}

void write_response_examples (Json& responses,
const std::vector<ExportExample>& examples,
ExportNotes& notes,
ExportDirection direction) {
    std::vector<const ExportExample*> all;
    all.reserve (examples.size ());
    for (const ExportExample& example : examples) {
        all.push_back (&example);
    }

    for (const auto& [status, group] : group_by (all,
         [] (const ExportExample& e) { return std::to_string (e.status); })) {
        const auto existing = responses.find (status);
        if (existing != responses.end () && !string_member (*existing, "$ref").empty ()) {
            // A Reference Object admits no siblings: a `content` beside a
            // `$ref` is ignored by conformant readers and fails a validator.
            // The component is also shared with every operation referencing it,
            // as with a `$ref` parameter.
            notes.referenced_responses_left += 1;
            continue;
        }
        const bool declared_here = existing != responses.end () && existing->is_object ();
        const Json* declared_response = declared_here ? &*existing : nullptr;

        const std::vector<const ExportExample*> writable =
        writable_examples (group, notes);
        // Decided before anything is created: an undeclared response must not
        // appear just because it was asked about.
        std::vector<std::pair<std::string, MediaWrite>> planned;
        for (const auto& [content_type, media_group] : group_by (
             writable, [] (const ExportExample& e) { return e.content_type; })) {
            MediaWrite write = select_examples (media_group,
            declared_media_of (declared_response, content_type), notes, direction);
            if (!write.examples.empty ()) {
                planned.emplace_back (content_type, std::move (write));
            }
        }
        if (!declared_here && !writable.empty () && planned.empty ()) {
            // Every example of this undeclared status was sampled off a schema
            // at import, for a response the document has since dropped;
            // documenting it would put back what the contract removed. A status
            // whose examples this export left out (a truncated body, no
            // recorded media type) still lands below: the response is known,
            // only its body is missing.
            continue;
        }
        if (!declared_here) {
            // `description` is required, so an undeclared status gets one; an
            // existing description is never replaced.
            responses[status] = Json{ { "description",
            undeclared_response_description (status, group.front ()->name) } };
        }
        Json& response = responses[status];
        for (const auto& [content_type, write] : planned) {
            write_media_examples (
            child_record (child_record (response, "content"), content_type),
            write, notes, direction);
        }
    }
}

/**
 * The `examples` key @p target's value sits under in @p media, or `nullopt`
 * when it went in bare as `example` (nothing for a key-addressed extension to
 * name) or is absent.
 *
 * Read back by value (`declares_example`, as `disposition_of` does) rather than
 * threaded through `write_named_examples` / `add_named_examples`: the write
 * pipeline keys values by equality anyway, so one pass here beats an
 * out-parameter on every layer, and it also answers the already-declared case
 * the pipeline never touched.
 */
std::optional<std::string> written_key_for (const Json& media, const ExportExample& target) {
    const Json value = example_value (target.body);
    const auto map   = media.find ("examples");
    if (map == media.end () || !map->is_object ()) {
        return std::nullopt;
    }
    for (auto entry = map->begin (); entry != map->end (); ++entry) {
        const auto value_member = entry->find ("value");
        if (entry->is_object () && value_member != entry->end () &&
        declares_example (*value_member, value, target.body)) {
            return entry.key ();
        }
    }
    return std::nullopt;
}

/**
 * The `x-vayu-mock.example` key for @p entry's `"fixed"` target, or `nullopt`
 * when it cannot be named: the target was deleted (`mock_example_index`
 * absent), filtered out (truncated body, no recorded media type), sits under an
 * undeclared response or media type, or went in bare as `example`. Read off
 * @p responses after `write_response_examples` ran, or off a bound document's
 * own responses when the target was already declared
 * (`ExampleDisposition::AlreadyDeclared`).
 */
std::optional<std::string>
resolve_mock_key (const Json& responses, const ExportRequest& entry) {
    if (!entry.mock_example_index || *entry.mock_example_index >= entry.examples.size ()) {
        return std::nullopt;
    }
    const ExportExample& target = entry.examples[*entry.mock_example_index];
    const auto response = responses.find (std::to_string (target.status));
    if (response == responses.end ()) {
        return std::nullopt;
    }
    const Json* media = declared_media_of (&*response, target.content_type);
    return media == nullptr ? std::nullopt : written_key_for (*media, target);
}

/**
 * `x-vayu-mock` (#1649): which saved example a mock server answers with.
 * Additive like `x-vayu-elements` (`patch_operation`), and written only when
 * the mode is not `"first"`, so an operation with no mock choice gains no key.
 *
 * A `"fixed"` target this export cannot name writes nothing: the same "serve
 * first" answer `pick_example` gives a stale target at runtime (#481 phase 3),
 * the only honest one.
 */
void write_mock_extension (Json& operation, const ExportRequest& entry, const Json* responses) {
    if (entry.mock_response_mode == "random") {
        operation["x-vayu-mock"] = Json{ { "mode", "random" } };
        return;
    }
    if (entry.mock_response_mode != "fixed" || responses == nullptr) {
        return;
    }
    if (const auto key = resolve_mock_key (*responses, entry)) {
        operation["x-vayu-mock"] = Json{ { "mode", "fixed" }, { "example", *key } };
    }
}

/** A document assembled, or the sentence saying why it could not be. */
struct Assembly {
    Json document;
    ExportNotes notes;
    std::string error;
};

ExportNotes empty_notes (std::string direction, std::string dialect) {
    ExportNotes notes;
    notes.direction = std::move (direction);
    notes.dialect   = std::move (dialect);
    return notes;
}

// --- The bound direction: the collection's own document, updated -------------

/** Whether Vayu writes this dialect's vocabulary, or only removes from it. */
struct Dialect {
    std::string label;
    bool writable = false;
};

std::string method_path_key (std::string_view method, std::string_view path) {
    return vayu::utils::ascii_upper (method) + " " + std::string (path);
}

/**
 * The request this operation is, by the identity a bind or import stamped:
 * `operationId` first, method+path second, as the sync diff does. An id
 * survives a path change; a path survives an id rename.
 */
const size_t* find_request (const Json& operation,
std::string_view method,
const std::string& path_key,
const std::unordered_map<std::string, size_t>& by_operation_id,
const std::unordered_map<std::string, size_t>& by_method_path) {
    const std::string operation_id = string_member (operation, "operationId");
    if (!operation_id.empty ()) {
        const auto found = by_operation_id.find (operation_id);
        if (found != by_operation_id.end ()) {
            return &found->second;
        }
    }
    const auto found = by_method_path.find (method_path_key (method, path_key));
    return found == by_method_path.end () ? nullptr : &found->second;
}

/// The lowered names of the operation's declared parameters, by location.
/// Collected while patching: that pass knows which rows the document has a home
/// for.
struct DeclaredParameters {
    std::unordered_set<std::string> query;
    std::unordered_set<std::string> header;
};

/**
 * The node a local JSON pointer names, or `nullptr`: one hop, no cycles,
 * nothing outside this document. Followed to read, never to write, and only to
 * answer which parameter the document declares here; anything unfollowable (an
 * external file, a missing node) answers nothing, the same as not knowing.
 */
const Json* resolve_local_ref (const Json& document, std::string_view pointer) {
    if (!pointer.starts_with ("#/")) {
        return nullptr;
    }
    const Json* node = &document;
    size_t start     = 2;
    while (start <= pointer.size ()) {
        const size_t slash = pointer.find ('/', start);
        std::string segment (pointer.substr (start,
        slash == std::string_view::npos ? pointer.size () - start : slash - start));
        // `~1` before `~0`, as the standard orders them, or an encoded `~1`
        // decodes twice.
        for (const auto& [from, to] :
        std::array<std::pair<std::string_view, std::string_view>, 2>{
        { { "~1", "/" }, { "~0", "~" } } }) {
            for (size_t at = segment.find (from); at != std::string::npos;
            at             = segment.find (from, at + to.size ())) {
                segment.replace (at, from.size (), to);
            }
        }
        if (!node->is_object ()) {
            return nullptr;
        }
        const auto found = node->find (segment);
        if (found == node->end ()) {
            return nullptr;
        }
        node = &*found;
        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }
    return node;
}

void declare_parameter (const Json* parameter, DeclaredParameters& declared) {
    if (parameter == nullptr || !parameter->is_object ()) {
        return;
    }
    const std::string name = string_member (*parameter, "name");
    if (name.empty ()) {
        return;
    }
    const std::string location = string_member (*parameter, "in");
    if (location == "query") {
        declared.query.insert (vayu::utils::ascii_lower (name));
    } else if (location == "header") {
        declared.header.insert (vayu::utils::ascii_lower (name));
    }
}

/**
 * Path-level `parameters` belong to every operation under the item, so a row
 * matching one has a home though the operation does not list it. Read, never
 * written: an example there would be one request's value on every method of the
 * path.
 */
DeclaredParameters inherited_parameters (const Json& document, const Json& path_item) {
    DeclaredParameters declared;
    const auto parameters = path_item.find ("parameters");
    if (parameters == path_item.end () || !parameters->is_array ()) {
        return declared;
    }
    for (const Json& parameter : *parameters) {
        const std::string reference = string_member (parameter, "$ref");
        declare_parameter (
        reference.empty () ? &parameter : resolve_local_ref (document, reference), declared);
    }
    return declared;
}

/**
 * Writes a declared parameter's `example` from the row carrying a value for it,
 * and returns the names the operation declared.
 *
 * A blank row writes nothing: the import creates blank header rows, and one
 * deleting the document's example would lose the contract's documentation to a
 * row nobody typed. A row withheld as a credential writes nothing either (no
 * empty example over the document's own); @p counts_withheld says whether that
 * is counted here, true where no `x-vayu-request` is written, which counts it
 * otherwise.
 *
 * @p declared arrives with the path item's parameters and leaves with this
 * operation's too. @p example_key is `example` in 3.x, or 2.0 tools'
 * `x-example`, since 2.0 has no `example` on a non-body parameter.
 */
DeclaredParameters patch_parameters (Json& operation,
const Json& document,
const ExportRequest& entry,
DeclaredParameters declared,
ExportNotes& notes,
bool counts_withheld,
std::string_view example_key) {
    const auto parameters = operation.find ("parameters");
    if (parameters == operation.end () || !parameters->is_array ()) {
        return declared;
    }
    for (Json& parameter : *parameters) {
        if (!parameter.is_object ()) {
            continue;
        }
        if (const std::string reference = string_member (parameter, "$ref");
        !reference.empty ()) {
            notes.shared_parameters_left += 1;
            // A shared parameter belongs to every operation naming it, so it is
            // not written into, but its name is read through the reference so a
            // row it declares is not reported as declared nowhere.
            declare_parameter (resolve_local_ref (document, reference), declared);
            continue;
        }
        declare_parameter (&parameter, declared);
        const std::string name = string_member (parameter, "name");
        if (name.empty ()) {
            continue;
        }
        const std::string location = string_member (parameter, "in");
        const std::string wanted   = vayu::utils::ascii_lower (name);
        const std::vector<ExportKeyValue>* rows = nullptr;
        if (location == "query") {
            rows = &entry.params;
        } else if (location == "path") {
            rows = &entry.path_params;
        } else if (location == "header") {
            rows = &entry.headers;
        } else {
            continue;
        }
        const auto row = std::find_if (
        rows->begin (), rows->end (), [&] (const ExportKeyValue& candidate) {
            return vayu::utils::ascii_lower (candidate.key) == wanted;
        });
        if (row == rows->end ()) {
            continue;
        }
        if (row->withheld) {
            if (counts_withheld) {
                notes.secrets_omitted += 1;
            }
            continue;
        }
        if (row->value.empty ()) {
            continue;
        }
        parameter[std::string (example_key)] = row->value;
    }
    return declared;
}

/**
 * Counts rows with a value the operation declares no parameter for: declaring
 * one would add a parameter the contract lacks, which neither direction does.
 * `Authorization` and `Content-Type` are not counted; OpenAPI states them as
 * `security` and the body's media type, the same two the import drops.
 */
void count_undeclared_rows (const ExportRequest& entry,
const DeclaredParameters& declared,
ExportNotes& notes) {
    const auto count = [&] (const std::vector<ExportKeyValue>& rows,
                       const std::unordered_set<std::string>& names, bool headers) {
        for (const ExportKeyValue& row : rows) {
            if (row.key.empty () || (row.value.empty () && !row.withheld)) {
                continue;
            }
            const std::string name = vayu::utils::ascii_lower (row.key);
            if (headers &&
            std::find (NON_PARAMETER_HEADERS.begin (),
            NON_PARAMETER_HEADERS.end (), name) != NON_PARAMETER_HEADERS.end ()) {
                continue;
            }
            if (!names.contains (name)) {
                notes.rows_not_declared += 1;
            }
        }
    };
    count (entry.params, declared.query, /*headers=*/false);
    count (entry.headers, declared.header, /*headers=*/true);
}

/**
 * Counts a request body the bound direction cannot write: `requestBody` states
 * the schema the endpoint accepts, and a body typed into Vayu is one machine's
 * payload, not a new contract. The count shows the omission on the export it
 * happened on.
 */
void count_unwritten_body (const ExportRequest& entry, ExportNotes& notes) {
    if (entry.body.mode.empty () || entry.body.mode == "none") {
        return;
    }
    if (!entry.body.content.empty () || !entry.body.field_keys.empty ()) {
        notes.bodies_not_written += 1;
    }
}

/**
 * Counts a request whose method or path no longer matches its stamped
 * operation. The path is judged as the matcher stamped it: `/users/1` still is
 * `/users/{id}`, under any server base path the matcher stripped. A URL stating
 * no path is not compared.
 *
 * The stamp still finds the operation, so the values land under the method and
 * path the document declares. Moving or renaming an operation edits the
 * contract, which this export never does; the count says so instead of leaving
 * the user to diff the file.
 */
void count_edited_identity (const ExportRequest& entry,
ExportNotes& notes,
const std::vector<std::string>& base_paths) {
    const auto& identity = entry.spec_operation;
    if (!identity) {
        return;
    }
    if (!vayu::utils::ascii_lower_equal (entry.method, identity->method)) {
        notes.operations_edited += 1;
        return;
    }
    const std::optional<std::string> shape = request_path_shape (entry.url);
    if (shape &&
    !fills_template_under_base_paths (*shape, spec_path_shape (identity->path), base_paths)) {
        notes.operations_edited += 1;
    }
}

/**
 * The dialect is never changed: a 3.0 document exports as 3.0, a 2.0 one as
 * 2.0. For 2.0 the presence pass still runs but nothing is written into an
 * operation: its parameters and examples are another vocabulary, and half a
 * translation is neither.
 *
 * @return why there is nothing to patch, or nothing.
 */
std::optional<std::string> read_dialect (const Json& document, Dialect& dialect) {
    if (const std::string version = string_member (document, "openapi");
    !version.empty ()) {
        dialect = { "OpenAPI " + version, true };
    } else if (const std::string legacy = string_member (document, "swagger");
    !legacy.empty ()) {
        dialect = { "Swagger " + legacy, false };
    } else {
        return "The stored document declares neither `openapi` nor `swagger`, "
               "so it is not one Vayu can update.";
    }
    return std::nullopt;
}

/** Where each request's identity sits in @p requests, by both of its keys. */
void index_requests (const std::vector<ExportRequest>& requests,
std::unordered_map<std::string, size_t>& by_operation_id,
std::unordered_map<std::string, size_t>& by_method_path) {
    for (size_t index = 0; index < requests.size (); ++index) {
        const auto& identity = requests[index].spec_operation;
        if (!identity) {
            continue;
        }
        if (!identity->operation_id.empty ()) {
            by_operation_id.emplace (identity->operation_id, index);
        }
        by_method_path.emplace (method_path_key (identity->method, identity->path), index);
    }
}

// --- Building operations: shared by the skeleton and a full bound export ----

namespace ext = vayu::core::vayu_ext;

/// The dialect an operation is written in: a skeleton is always 3.x; a full
/// bound export writes the document's own, and 2.0 has its own vocabulary for
/// parameter types, examples, bodies and response examples.
enum class Vocabulary : std::uint8_t { V3, V2 };

/**
 * The name of a whole-segment Postman path variable (`:petId`, #1764), or
 * nothing: `:id.json` has a suffix OpenAPI cannot template, as `{{name}}.json`
 * does.
 */
std::optional<std::string_view> colon_variable_name (std::string_view segment) {
    if (segment.size () < 2 || segment.front () != ':' ||
    segment.find_first_of (".{}") != std::string_view::npos) {
        return std::nullopt;
    }
    return segment.substr (1);
}

/**
 * A request path with Vayu's tokens in OpenAPI form: `/pets/{{petId}}` and
 * `/pets/:petId` both become `/pets/{petId}`. Only a whole-segment token
 * converts: OpenAPI cannot template part of a segment (`/files/{{name}}.json`),
 * so that stays as written.
 */
std::string path_template (std::string_view path) {
    std::string out;
    size_t start = 0;
    while (start <= path.size ()) {
        const size_t slash             = path.find ('/', start);
        const std::string_view segment = path.substr (start,
        slash == std::string_view::npos ? path.size () - start : slash - start);
        const auto name                = variable_token_name (segment);
        if (name) {
            out += "{" + std::string (trim (*name)) + "}";
        } else if (const auto colon = colon_variable_name (segment)) {
            out += "{" + std::string (*colon) + "}";
        } else {
            out += segment;
        }
        if (slash == std::string_view::npos) {
            break;
        }
        out += '/';
        start = slash + 1;
    }
    return out;
}

/// A `string` parameter's type in @p vocabulary - a 3.x `schema`, or 2.0's
/// `type` on the parameter itself.
void write_string_type (Json& parameter, Vocabulary vocabulary) {
    if (vocabulary == Vocabulary::V3) {
        parameter["schema"] = Json{ { "type", "string" } };
    } else {
        parameter["type"] = "string";
    }
}

/**
 * The templated path's `{name}` placeholders as path parameters.
 * `required: true` is OpenAPI's own rule for path parameters, not a claim about
 * this endpoint; `string` is the same kind of minimum, since a parameter object
 * must carry a type.
 */
void append_path_parameters (const std::string& templated,
const std::vector<ExportKeyValue>& path_rows,
Json& parameters,
Vocabulary vocabulary) {
    // The renderer's `/\{([^{}]+)\}/g`, left to right: a `{` restarts the name,
    // so `{a{b}` declares `b`.
    size_t open = std::string::npos;
    for (size_t index = 0; index < templated.size (); ++index) {
        if (templated[index] == '{') {
            open = index;
            continue;
        }
        if (templated[index] != '}') {
            continue;
        }
        if (open != std::string::npos && index > open + 1) {
            const std::string name = templated.substr (open + 1, index - open - 1);
            Json parameter{ { "name", name }, { "in", "path" }, { "required", true } };
            write_string_type (parameter, vocabulary);
            // A `:name` path row's value (#1764) is this request's example of
            // the parameter, as a query row's is.
            const auto row = std::find_if (path_rows.rbegin (),
            path_rows.rend (), [&] (const ExportKeyValue& candidate) {
                return candidate.enabled && candidate.key == name;
            });
            if (row != path_rows.rend () && !row->value.empty ()) {
                parameter[vocabulary == Vocabulary::V3 ? "example" : "x-example"] =
                row->value;
            }
            parameters.push_back (std::move (parameter));
        }
        open = std::string::npos;
    }
}

/**
 * One Params or Headers row as a parameter. A disabled row is still declared:
 * the endpoint takes the parameter either way, and the toggle says what this
 * request sends, so `x-vayu-enabled` carries it, not `required`.
 */
Json parameter_object (const ExportKeyValue& row, std::string_view location, Vocabulary vocabulary) {
    Json parameter{ { "name", row.key }, { "in", std::string (location) } };
    if (!row.description.empty ()) {
        parameter["description"] = row.description;
    }
    write_string_type (parameter, vocabulary);
    if (!row.value.empty ()) {
        parameter[vocabulary == Vocabulary::V3 ? "example" : "x-example"] = row.value;
    }
    // Written either way: an empty enabled row and a non-empty disabled one are
    // both states a reimport cannot read off `value` (#1441).
    parameter[std::string (ROW_ENABLED_KEY)] = row.enabled;
    return parameter;
}

/// Whether @p key names a header OpenAPI states elsewhere (`security`, the
/// body's media type) rather than as a parameter.
bool is_non_parameter_header (const std::string& key) {
    const std::string lowered = vayu::utils::ascii_lower (key);
    return std::find (NON_PARAMETER_HEADERS.begin (),
           NON_PARAMETER_HEADERS.end (), lowered) != NON_PARAMETER_HEADERS.end ();
}

/**
 * Every Params and Headers row @p declared does not hold yet, as parameters. A
 * second row with the same name and location is not written (OpenAPI keys
 * parameters by both); `x-vayu-request` carries it, and every `Authorization` /
 * `Content-Type` row, verbatim.
 */
void append_row_parameters (const ExportRequest& entry,
DeclaredParameters& declared,
Json& parameters,
Vocabulary vocabulary) {
    for (const ExportKeyValue& row : entry.params) {
        if (!row.key.empty () &&
        declared.query.insert (vayu::utils::ascii_lower (row.key)).second) {
            parameters.push_back (parameter_object (row, "query", vocabulary));
        }
    }
    for (const ExportKeyValue& row : entry.headers) {
        if (!row.key.empty () && !is_non_parameter_header (row.key) &&
        declared.header.insert (vayu::utils::ascii_lower (row.key)).second) {
            parameters.push_back (parameter_object (row, "header", vocabulary));
        }
    }
}

/**
 * The media type an enabled `Content-Type` row names, lowered and without
 * parameters (`application/vnd.api+json`, not the mode's generic
 * `application/json`), or `""` for none or a `{{variable}}`.
 */
std::string declared_content_type (const ExportRequest& entry) {
    for (const ExportKeyValue& row : entry.headers) {
        if (!row.enabled || !vayu::utils::ascii_lower_equal (row.key, "content-type")) {
            continue;
        }
        const std::string_view value = trim (std::string_view (row.value).substr (
        0, std::min (row.value.find (';'), row.value.size ())));
        if (value.empty () || value.find ("{{") != std::string_view::npos) {
            return {};
        }
        return vayu::utils::ascii_lower (value);
    }
    return {};
}

/// The body's own media type for @p mode, overridden by a `Content-Type` row.
std::string body_media_type (const ExportRequest& entry, std::string_view fallback) {
    const std::string declared = declared_content_type (entry);
    return declared.empty () ? std::string (fallback) : declared;
}

/**
 * A request body as an `example` value and the media type it is filed under.
 * GraphQL is the `{query, variables}` envelope a GraphQL-over-HTTP server
 * receives (what Vayu stores); a form is the object of its enabled text fields;
 * a binary body is a `format: binary` string with no example, since the file is
 * one machine's. Every mode round-trips through `x-vayu-request.body`; this is
 * what other tools read.
 */
struct BodyExample {
    std::string media_type;
    Json value;
    /// Set for a form: its fields as schema properties, file parts as
    /// `format: binary`, described where the row is.
    std::optional<Json> form_schema;
    /// A binary body: one file's bytes, which no example states.
    bool file = false;
};

/// The schema of one file's bytes, in either vocabulary.
Json file_schema () {
    return Json{ { "type", "string" }, { "format", "binary" } };
}

/// A GraphQL body as the envelope a GraphQL-over-HTTP server receives: Vayu's
/// stored one, or a bare query wrapped as one.
std::optional<BodyExample> graphql_example_of (const ExportRequest& entry) {
    if (trim (entry.body.content).empty ()) {
        return std::nullopt;
    }
    Json envelope = example_value (entry.body.content);
    if (!envelope.is_object ()) {
        envelope = Json{ { "query", entry.body.content } };
    }
    return BodyExample{ body_media_type (entry, "application/json"),
        std::move (envelope), std::nullopt };
}

/// A form's rows: the stored ones when there are any (value, toggle,
/// description, file part), only the field names otherwise.
nlohmann::json form_fields_of (const ExportRequest& entry) {
    if (const auto stored = entry.stored_body.find ("fields");
    stored != entry.stored_body.end () && stored->is_array ()) {
        return *stored;
    }
    nlohmann::json fields = nlohmann::json::array ();
    for (const std::string& key : entry.body.field_keys) {
        fields.push_back (nlohmann::json{ { "key", key }, { "value", "" } });
    }
    return fields;
}

/// One form field as a schema property: a string, `format: binary` for a
/// file part, described where the row is.
Json form_property_of (const nlohmann::json& field) {
    Json property{ { "type", "string" } };
    if (field.value ("type", "") == "file") {
        property["format"] = "binary";
    }
    if (const std::string description = field.value ("description", "");
    !description.empty ()) {
        property["description"] = description;
    }
    return property;
}

/// A form body: fields as schema properties, enabled text values as the example
/// (a disabled row is not sent; a file part is one machine's file).
std::optional<BodyExample> form_example_of (const ExportRequest& entry) {
    const nlohmann::json fields = form_fields_of (entry);
    Json properties             = Json::object ();
    Json values                 = Json::object ();
    for (const auto& field : fields) {
        const std::string key = field.is_object () ? field.value ("key", "") : "";
        if (key.empty () || properties.contains (key)) {
            continue;
        }
        properties[key] = form_property_of (field);
        if (field.value ("type", "") != "file" && field.value ("enabled", true)) {
            values[key] = field.value ("value", "");
        }
    }
    if (properties.empty ()) {
        return std::nullopt;
    }
    return BodyExample{ entry.body.mode == "form-data" ? "multipart/form-data" : "application/x-www-form-urlencoded",
        std::move (values),
        std::make_optional (
        Json{ { "type", "object" }, { "properties", std::move (properties) } }) };
}

/// A binary body's own `contentType`, lowered and without parameters, or `""`
/// for none or a `{{variable}}`.
std::string file_media_type (const ExportRequest& entry) {
    const auto file = entry.stored_body.find ("file");
    if (file == entry.stored_body.end () || !file->is_object ()) {
        return {};
    }
    const auto stated = file->find ("contentType");
    if (stated == file->end () || !stated->is_string ()) {
        return {};
    }
    const std::string& text     = stated->get_ref<const std::string&> ();
    const std::string_view type = trim (
    std::string_view (text).substr (0, std::min (text.find (';'), text.size ())));
    if (type.find ("{{") != std::string_view::npos) {
        return {};
    }
    return vayu::utils::ascii_lower (type);
}

/// The media type the file name's extension implies, by the send's table, or
/// `""` for an unknown extension or no file.
std::string file_extension_media_type (const ExportRequest& entry) {
    const auto file = entry.stored_body.find ("file");
    if (file == entry.stored_body.end () || !file->is_object ()) {
        return {};
    }
    const auto src = file->find ("src");
    if (src == file->end () || !src->is_string ()) {
        return {};
    }
    return std::string{ vayu::http::media_type_for_extension (
    src->get_ref<const std::string&> ()) };
}

/// A binary body under the media type it is sent with, in the send's order: an
/// enabled `Content-Type` row, the file's `contentType`, its extension, then
/// `application/octet-stream`.
BodyExample binary_example_of (const ExportRequest& entry) {
    std::string stated = file_media_type (entry);
    if (stated.empty ()) {
        stated = file_extension_media_type (entry);
    }
    BodyExample body{ body_media_type (entry,
                      stated.empty () ? "application/octet-stream" : stated),
        Json (), std::nullopt };
    body.file = true;
    return body;
}

std::optional<BodyExample> body_example_of (const ExportRequest& entry) {
    const ExportBody& body = entry.body;
    if (body.mode == "graphql") {
        return graphql_example_of (entry);
    }
    if (body.mode == "binary") {
        return binary_example_of (entry);
    }
    if (body.mode == "form-data" || body.mode == "x-www-form-urlencoded") {
        return form_example_of (entry);
    }
    if (trim (body.content).empty ()) {
        return std::nullopt;
    }
    if (body.mode == "json" || body.mode == "jsonrpc" || body.mode == "mcp") {
        return BodyExample{ body_media_type (entry, "application/json"),
            example_value (body.content), std::nullopt };
    }
    if (body.mode == "xml" || body.mode == "text") {
        // The text as it stands, never parsed.
        return BodyExample{ body_media_type (entry,
                            body.mode == "xml" ? "application/xml" : "text/plain"),
            Json (body.content), std::nullopt };
    }
    return std::nullopt;
}

/// One body example as a 3.x media object: the schema read off it (or the
/// form's fields), and the example when it says anything. @p body is taken by
/// value and its example moved in: the parsed body is as wide as what was
/// stored, and a copy costs one allocation per member.
Json media_object_of (BodyExample body) {
    if (body.file) {
        return Json{ { "schema", file_schema () } };
    }
    Json media = Json::object ();
    // Room for both members, so writing the example does not copy the schema
    // before it (`reserve_members` says why).
    vayu::utils::reserve_members (media, 2);
    media["schema"] = body.form_schema ? std::move (*body.form_schema) :
                                         schema_from_example (body.value);
    if (!(body.value.is_object () && body.value.empty ())) {
        media["example"] = std::move (body.value);
    }
    return media;
}

/// A request body as a 3.x `requestBody`, or nothing when the request states none.
std::optional<Json> request_body_object (const ExportRequest& entry) {
    std::optional<BodyExample> body = body_example_of (entry);
    if (!body) {
        return std::nullopt;
    }
    const std::string media_type = body->media_type;
    return std::make_optional (Json{
    { "content", Json{ { media_type, media_object_of (std::move (*body)) } } } });
}

/**
 * A request body as 2.0 parameters: one `in: body` carrying the derived schema
 * and example, or one `in: formData` per form field (`type: file` for a file
 * part). Empty for no body.
 */
Json body_parameters_v2 (const ExportRequest& entry) {
    Json parameters                       = Json::array ();
    const std::optional<BodyExample> body = body_example_of (entry);
    if (!body) {
        return parameters;
    }
    if (body->form_schema) {
        for (const auto& [name, property] : body->form_schema->at ("properties").items ()) {
            Json parameter{ { "name", name }, { "in", "formData" },
                { "type", property.value ("format", "") == "binary" ? "file" : "string" } };
            if (property.contains ("description")) {
                parameter["description"] = property.at ("description");
            }
            parameters.push_back (std::move (parameter));
        }
        return parameters;
    }
    if (body->file) {
        parameters.push_back (
        Json{ { "name", "body" }, { "in", "body" }, { "schema", file_schema () } });
        return parameters;
    }
    Json schema       = schema_from_example (body->value);
    schema["example"] = body->value;
    parameters.push_back (
    Json{ { "name", "body" }, { "in", "body" }, { "schema", std::move (schema) } });
    return parameters;
}

/// Explicit no-auth: `security: []` states it exactly, no scheme needed.
bool auth_is_none (const std::string& mode) {
    return mode.empty () || mode == "none" || mode == "noauth";
}

/// A mode OpenAPI has a `securityScheme` type for.
bool auth_is_expressible (const std::string& mode) {
    return mode == "basic" || mode == "bearer" || mode == "apikey" || mode == "oauth2";
}

/// A space-separated scope string as a `scopes` map, every entry undescribed:
/// Vayu stores no per-scope description.
Json oauth2_scopes_of (const std::string& scope) {
    Json scopes    = Json::object ();
    std::size_t at = 0;
    while (at < scope.size ()) {
        while (at < scope.size () &&
        std::isspace (static_cast<unsigned char> (scope[at])) != 0) {
            ++at;
        }
        const std::size_t start = at;
        while (at < scope.size () &&
        std::isspace (static_cast<unsigned char> (scope[at])) == 0) {
            ++at;
        }
        if (at > start) {
            scopes[scope.substr (start, at - start)] = "";
        }
    }
    return scopes;
}

/// `auth` as a 3.x `securityScheme`, for the modes `auth_is_expressible` names.
Json security_scheme_of (const ExportAuth& auth) {
    if (auth.mode == "basic") {
        return Json{ { "type", "http" }, { "scheme", "basic" } };
    }
    if (auth.mode == "bearer") {
        return Json{ { "type", "http" }, { "scheme", "bearer" } };
    }
    if (auth.mode == "apikey") {
        return Json{ { "type", "apiKey" }, { "name", auth.api_key_name },
            { "in", auth.api_key_in.empty () ? "header" : auth.api_key_in } };
    }
    // `clientCredentials` is the fallback for an unrecognized grant type, the
    // default `default_oauth2_config` gives, so it reads as never set.
    // `jwt_bearer` (#3632) lands here: OpenAPI has no RFC 7523 flow, and the
    // real config travels in `x-vayu-collection` / `x-vayu-request`, so this
    // flow only names the token endpoint.
    std::string flow = "clientCredentials";
    if (auth.oauth2_grant_type == "authorization_code") {
        flow = "authorizationCode";
    } else if (auth.oauth2_grant_type == "password") {
        flow = "password";
    }
    Json flow_object = Json::object ();
    if (flow == "authorizationCode") {
        flow_object["authorizationUrl"] = auth.oauth2_authorization_url;
    }
    flow_object["tokenUrl"] = auth.oauth2_token_url;
    if (!auth.oauth2_refresh_url.empty ()) {
        flow_object["refreshUrl"] = auth.oauth2_refresh_url;
    }
    flow_object["scopes"] = oauth2_scopes_of (auth.oauth2_scope);
    return Json{ { "type", "oauth2" },
        { "flows", Json{ { flow, std::move (flow_object) } } } };
}

/**
 * `auth` as a 2.0 `securityDefinitions` entry, or nothing for bearer: 2.0's
 * only HTTP scheme is `basic`, and an `apiKey` named `Authorization` would
 * re-import as an API key.
 */
std::optional<Json> security_definition_of (const ExportAuth& auth) {
    if (auth.mode == "basic") {
        return std::make_optional (Json{ { "type", "basic" } });
    }
    if (auth.mode == "apikey") {
        return std::make_optional (Json{ { "type", "apiKey" }, { "name", auth.api_key_name },
        { "in", auth.api_key_in.empty () ? "header" : auth.api_key_in } });
    }
    if (auth.mode != "oauth2") {
        return std::nullopt;
    }
    // `application` is the same fallback (`jwt_bearer` included, see
    // `security_scheme_of`).
    std::string flow = "application";
    if (auth.oauth2_grant_type == "authorization_code") {
        flow = "accessCode";
    } else if (auth.oauth2_grant_type == "password") {
        flow = "password";
    }
    Json definition{ { "type", "oauth2" }, { "flow", flow } };
    if (flow == "accessCode") {
        definition["authorizationUrl"] = auth.oauth2_authorization_url;
    }
    definition["tokenUrl"] = auth.oauth2_token_url;
    definition["scopes"]   = oauth2_scopes_of (auth.oauth2_scope);
    return std::make_optional (std::move (definition));
}

/// An auth mode for export: `inherit` (nothing resolved), an explicit absence
/// (`auth_is_none`), a scheme this file can build, or one OpenAPI cannot name.
struct AuthDisposition {
    enum class Kind : std::uint8_t { Inherit, None, Scheme, Unsupported };
    Kind kind = Kind::Inherit;
    ExportAuth auth;
};

AuthDisposition disposition_of (const ExportAuth& auth) {
    if (auth.mode == "inherit") {
        return { AuthDisposition::Kind::Inherit, auth };
    }
    if (auth_is_none (auth.mode)) {
        return { AuthDisposition::Kind::None, auth };
    }
    if (auth_is_expressible (auth.mode)) {
        return { AuthDisposition::Kind::Scheme, auth };
    }
    return { AuthDisposition::Kind::Unsupported, auth };
}

/// Whether two dispositions send the same: same kind and, for a scheme, the
/// same scheme.
bool same_disposition (const AuthDisposition& a, const AuthDisposition& b) {
    return a.kind == b.kind &&
    (a.kind != AuthDisposition::Kind::Scheme ||
    security_scheme_of (a.auth) == security_scheme_of (b.auth));
}

/// The base a scheme's name is derived from, by the scheme's own type.
std::string scheme_base_name (const ExportAuth& auth) {
    if (auth.mode == "basic") {
        return "basicAuth";
    }
    if (auth.mode == "bearer") {
        return "bearerAuth";
    }
    if (auth.mode == "apikey") {
        return "apiKeyAuth";
    }
    return "oauth2Auth";
}

/**
 * Names the `securitySchemes` an operation references: a skeleton's own
 * registry, or a bound document's schemes plus any it must add. Nothing when
 * the dialect cannot state the scheme.
 */
class SchemeNamer {
    public:
    SchemeNamer ()                              = default;
    SchemeNamer (const SchemeNamer&)            = delete;
    SchemeNamer& operator= (const SchemeNamer&) = delete;
    SchemeNamer (SchemeNamer&&)                 = delete;
    SchemeNamer& operator= (SchemeNamer&&)      = delete;
    virtual ~SchemeNamer ()                     = default;
    virtual std::optional<std::string> name_for (const ExportAuth& auth) = 0;
};

/**
 * A skeleton's `components.securitySchemes`, built as requests ask. Requests
 * whose auth reduces to one scheme share it; a name comes from the scheme's
 * type and is de-duplicated only when two different schemes collide (two
 * differently named API keys).
 */
class SkeletonSchemes final : public SchemeNamer {
    public:
    std::optional<std::string> name_for (const ExportAuth& auth) override {
        const Json scheme           = security_scheme_of (auth);
        const std::string canonical = scheme.dump ();
        if (const auto found = by_shape_.find (canonical); found != by_shape_.end ()) {
            return found->second;
        }
        const std::string base = scheme_base_name (auth);
        std::string name       = base;
        for (int suffix = 2; schemes_.contains (name); ++suffix) {
            name = base + std::to_string (suffix);
        }
        by_shape_[canonical] = name;
        schemes_[name]       = scheme;
        return name;
    }

    [[nodiscard]] const Json& schemes () const {
        return schemes_;
    }

    private:
    std::unordered_map<std::string, std::string> by_shape_;
    Json schemes_ = Json::object ();
};

/**
 * Whether a declared scheme states the same credential as @p wanted: compared
 * on what a client sends (type, HTTP scheme, API key name and location), never
 * on the description, `bearerFormat` or scopes an author wrote around it.
 */
bool scheme_matches (const Json& declared, const Json& wanted) {
    if (!declared.is_object () ||
    string_member (declared, "type") != string_member (wanted, "type")) {
        return false;
    }
    const std::string type = string_member (wanted, "type");
    if (type == "http") {
        return vayu::utils::ascii_lower (string_member (declared, "scheme")) ==
        string_member (wanted, "scheme");
    }
    if (type == "apiKey") {
        return vayu::utils::ascii_lower_equal (string_member (declared, "name"),
               string_member (wanted, "name")) &&
        string_member (declared, "in") == string_member (wanted, "in");
    }
    return true; // oauth2, basic (2.0): the type is the credential's shape
}

/**
 * A bound document's schemes, read without being written: a request's auth
 * names an existing scheme for the same credential if there is one. A scheme to
 * add is held and written by `write_into` after the `paths` walk, since adding
 * a root member mid-walk would move the path item being written.
 */
class BoundSchemes final : public SchemeNamer {
    public:
    BoundSchemes (const Json& document, Vocabulary vocabulary)
    : vocabulary_ (vocabulary) {
        const Json* container = nullptr;
        if (vocabulary == Vocabulary::V3) {
            const auto components = document.find ("components");
            if (components != document.end () && components->is_object ()) {
                const auto found = components->find ("securitySchemes");
                container = found != components->end () ? &*found : nullptr;
            }
        } else {
            const auto found = document.find ("securityDefinitions");
            container        = found != document.end () ? &*found : nullptr;
        }
        if (container != nullptr && container->is_object ()) {
            declared_ = *container;
        }
    }

    std::optional<std::string> name_for (const ExportAuth& auth) override {
        std::optional<Json> wanted;
        if (vocabulary_ == Vocabulary::V3) {
            wanted = security_scheme_of (auth);
        } else {
            wanted = security_definition_of (auth);
        }
        if (!wanted) {
            return std::nullopt;
        }
        for (const Json* schemes : { &declared_, &added_ }) {
            for (auto entry = schemes->begin (); entry != schemes->end (); ++entry) {
                if (scheme_matches (entry.value (), *wanted)) {
                    return entry.key ();
                }
            }
        }
        const std::string base = scheme_base_name (auth);
        std::string name       = base;
        for (int suffix = 2; declared_.contains (name) || added_.contains (name); ++suffix) {
            name = base + std::to_string (suffix);
        }
        added_[name] = std::move (*wanted);
        return name;
    }

    /// Whether @p requirement's first scheme states the same credential as @p auth.
    [[nodiscard]] bool names (const Json& requirement, const ExportAuth& auth) const {
        if (!requirement.is_array () || requirement.empty () ||
        !requirement.front ().is_object () || requirement.front ().empty ()) {
            return false;
        }
        const std::string name = requirement.front ().begin ().key ();
        const Json* declared   = nullptr;
        if (declared_.contains (name)) {
            declared = &declared_.at (name);
        } else if (added_.contains (name)) {
            declared = &added_.at (name);
        } else {
            return false;
        }
        const std::optional<Json> wanted = vocabulary_ == Vocabulary::V3 ?
        std::make_optional (security_scheme_of (auth)) :
        security_definition_of (auth);
        return wanted && scheme_matches (*declared, *wanted);
    }

    /// Writes the schemes this export added into @p document.
    void write_into (Json& document) const {
        if (added_.empty ()) {
            return;
        }
        Json& container = vocabulary_ == Vocabulary::V3 ?
        child_record (child_record (document, "components"), "securitySchemes") :
        child_record (document, "securityDefinitions");
        for (auto entry = added_.begin (); entry != added_.end (); ++entry) {
            container[entry.key ()] = entry.value ();
        }
    }

    private:
    Vocabulary vocabulary_;
    Json declared_ = Json::object ();
    Json added_    = Json::object ();
};

/// A `security` requirement naming @p name with no scopes: Vayu resolves a
/// token or key whole, never a subset of an oauth2 scope list.
Json security_requirement (const std::string& name) {
    return Json::array ({ Json{ { name, Json::array () } } });
}

/**
 * The operation-level `security` override of @p request_disp against
 * @p collection_disp, or `nullopt` when the operation inherits the document's:
 * an unresolved `inherit`, the same scheme, a mode OpenAPI cannot state, or a
 * scheme this dialect cannot name (the last two travel in
 * `x-vayu-request.auth`).
 */
std::optional<Json> operation_security_of (const AuthDisposition& request_disp,
const AuthDisposition& collection_disp,
SchemeNamer& schemes) {
    if (request_disp.kind == AuthDisposition::Kind::Inherit ||
    request_disp.kind == AuthDisposition::Kind::Unsupported ||
    same_disposition (request_disp, collection_disp)) {
        return std::nullopt;
    }
    if (request_disp.kind == AuthDisposition::Kind::None) {
        return std::make_optional (Json::array ());
    }
    const std::optional<std::string> name = schemes.name_for (request_disp.auth);
    if (!name) {
        return std::nullopt;
    }
    return std::make_optional (security_requirement (*name));
}

// --- What only the `x-vayu-*` extensions carry (vayu_extensions.hpp) --------

/// The execution settings that differ from a fresh request's, or `{}`.
Json settings_object_of (const ExportRequest& entry) {
    Json settings = Json::object ();
    if (!entry.follow_redirects) {
        settings["followRedirects"] = false;
    }
    if (entry.max_redirects != 10) {
        settings["maxRedirects"] = entry.max_redirects;
    }
    if (entry.timeout_ms) {
        settings["timeout"] = *entry.timeout_ms;
    }
    if (entry.http_version != "auto") {
        settings["httpVersion"] = entry.http_version;
    }
    if (!entry.verify_ssl) {
        settings["verifySSL"] = false;
    }
    if (entry.stream) {
        settings["stream"] = true;
        // Only beside the stream it reads, the one shape the importer accepts.
        if (entry.stream_text_path) {
            settings["streamTextPath"] = *entry.stream_text_path;
        }
        if (entry.stream_first_content_marker) {
            settings["streamFirstContentMarker"] = *entry.stream_first_content_marker;
        }
    }
    return settings;
}

/// Whether @p value is a non-empty object or array: the stored columns this
/// export copies only when they say something.
bool says_something (const nlohmann::json& value) {
    return (value.is_object () || value.is_array ()) && !value.empty ();
}

// --- Credentials outside an auth block (#1804) ------------------------------
//
// Header rows, Params rows, a URL and saved response headers carry what the
// user typed or a server sent, and a name says whether it is a credential
// (`Authorization`, `api_key`, `Set-Cookie`). Each is written twice: as the
// standard member other tools read (a parameter's `example`, a `servers` entry)
// and verbatim in `x-vayu-request`. `export_openapi` blanks the copy the
// standard writers read once, up front, so a later writer cannot forget;
// `vayu_request_object` blanks what it writes and is where a credential is
// counted, so the two copies count once.

/// The header and query names the API-key auth in force claims
/// (`ext::apikey_*_names`): a row typed under one is the credential too.
struct ApiKeyNames {
    std::vector<std::string> headers;
    std::vector<std::string> params;
};

ApiKeyNames apikey_names_of (const ExportAuth& auth) {
    if (auth.mode != "apikey") {
        return {};
    }
    const Json claimed{ { "mode", "apikey" }, { "key", auth.api_key_name },
        { "in", auth.api_key_in } };
    return { ext::apikey_header_names (claimed), ext::apikey_param_names (claimed) };
}

/// `ext::blank_credential_rows` or `ext::blank_credential_param_rows`.
using BlankRows = void (*) (Json&, const std::vector<std::string>&, int&);

/// Empties each credential row's value and marks it `withheld`; the key stays,
/// so the parameter is still declared.
void withhold_row_values (std::vector<ExportKeyValue>& rows,
BlankRows blank,
const std::vector<std::string>& names) {
    Json table = Json::array ();
    for (const ExportKeyValue& row : rows) {
        table.push_back (Json{ { "key", row.key }, { "value", row.value } });
    }
    int blanked = 0;
    blank (table, names, blanked);
    for (std::size_t at = 0; blanked > 0 && at < rows.size (); ++at) {
        if (table[at].at ("value").get_ref<const std::string&> () != rows[at].value) {
            rows[at].value.clear ();
            rows[at].withheld = true;
        }
    }
}

/// @p entry with its credential rows' values withheld: what every standard
/// member (`parameter_object`, `patch_parameters`) reads.
ExportRequest withhold_credentials (const ExportRequest& entry) {
    ExportRequest safe        = entry;
    const ApiKeyNames claimed = apikey_names_of (entry.auth);
    withhold_row_values (safe.headers, ext::blank_credential_rows, claimed.headers);
    withhold_row_values (safe.params, ext::blank_credential_param_rows, claimed.params);
    withhold_row_values (
    safe.path_params, ext::blank_credential_param_rows, claimed.params);
    return safe;
}

/// @p collection with a credential-carrying `baseUrl` blanked (`servers` reads
/// it); counted with the `baseUrl` variable holding the same URL.
ExportCollection withhold_credentials (const ExportCollection& collection) {
    ExportCollection safe         = collection;
    int counted_with_the_variable = 0;
    safe.base_url_value           = ext::redact_url_credentials (
    collection.base_url_value, {}, counted_with_the_variable);
    return safe;
}

/// A request URL's server origin, its userinfo password dropped; counted with
/// the URL, which `x-vayu-request` carries.
std::string server_origin_of (const std::string& origin) {
    int counted_with_the_url = 0;
    return ext::redact_url_credentials (origin, {}, counted_with_the_url);
}

/// How many of @p rows `withhold_credentials` emptied.
int withheld_in (const std::vector<ExportKeyValue>& rows) {
    return static_cast<int> (std::count_if (rows.begin (), rows.end (),
    [] (const ExportKeyValue& row) { return row.withheld; }));
}

/// Blanks @p table (a stored Params or Headers column) in place and returns how
/// many credentials the request holds in it. It and the parsed rows
/// (@p parsed_withheld withheld) are one table read twice, so the larger count
/// stands: equal for a route-built request, right for one built with only one
/// of them.
int blank_stored_table (Json& table,
BlankRows blank,
const std::vector<std::string>& names,
int parsed_withheld) {
    int stored = 0;
    blank (table, names, stored);
    return std::max (stored, parsed_withheld);
}

/// Stored variables with every secret blanked, and `baseUrl` (the one variable
/// read as a URL) with its credentials blanked; `servers` carries the same URL
/// uncounted.
Json redacted_variables (const nlohmann::json& stored, ExportNotes& notes) {
    Json variables = ext::redact_variables (Json (stored), notes.secrets_omitted);
    const auto base = variables.find ("baseUrl");
    if (base == variables.end () || !base->is_object ()) {
        return variables;
    }
    if (const auto value = base->find ("value");
    value != base->end () && value->is_string ()) {
        *value = ext::redact_url_credentials (
        value->get_ref<const std::string&> (), {}, notes.secrets_omitted);
    }
    return variables;
}

/// The saved examples as `x-vayu-request.examples`: response headers a server
/// sent (`Set-Cookie`, ...) blanked and counted per example, each its own
/// source; the body untouched, since a body cannot be judged. `origin` rides on
/// every row: without it a re-import would read a user-saved example as one the
/// next spec sync may replace (#2430).
Json examples_object_of (const ExportRequest& entry, ExportNotes& notes) {
    Json examples = Json::array ();
    for (const ExportExample& example : entry.examples) {
        Json headers = Json (example.headers);
        ext::blank_credential_rows (headers, {}, notes.secrets_omitted);
        Json row{ { "name", example.name }, { "status", example.status },
            { "contentType", example.content_type },
            { "headers", std::move (headers) }, { "body", example.body },
            { "origin",
            example.from_import ? constants::request_example::ORIGIN_IMPORT :
                                  constants::request_example::ORIGIN_USER } };
        if (example.body_truncated) {
            row["bodyTruncated"] = true;
        }
        examples.push_back (std::move (row));
    }
    return examples;
}

/**
 * `x-vayu-request`: everything about @p entry the standard members cannot state
 * exactly. @p standalone adds what an operation would otherwise say (method,
 * description, elements, mock mode), for a request in
 * `x-vayu-collection.requests` with no operation.
 */
Json vayu_request_object (const ExportRequest& entry, ExportNotes& notes, bool standalone) {
    const ApiKeyNames claimed = apikey_names_of (entry.auth);
    ext::UrlOmitted in_url;
    Json out{ { "name", entry.name },
        { "method", vayu::utils::ascii_upper (entry.method) },
        { "url", ext::redact_url_credentials (entry.url, claimed.params, in_url) },
        { "order", entry.order } };
    if (standalone && !entry.description.empty ()) {
        out["description"] = entry.description;
    }
    if (!entry.folder_path.empty ()) {
        out["folder"] = Json (entry.folder_path);
    }
    // The URL's query and the Params rows are one query written twice.
    Json params = Json (entry.stored_params);
    const int in_params = blank_stored_table (params, ext::blank_credential_param_rows,
    claimed.params, withheld_in (entry.params) + withheld_in (entry.path_params));
    notes.secrets_omitted += in_url.distinct_with (in_params);
    if (says_something (params)) {
        out["params"] = std::move (params);
    }
    Json headers = Json (entry.stored_headers);
    notes.secrets_omitted += blank_stored_table (headers,
    ext::blank_credential_rows, claimed.headers, withheld_in (entry.headers));
    if (says_something (headers)) {
        out["headers"] = std::move (headers);
    }
    if (entry.stored_body.is_object () && entry.stored_body.value ("mode", "none") != "none") {
        out["body"] = ext::portable_body (Json (entry.stored_body));
    }
    if (says_something (entry.stored_auth)) {
        out["auth"] = ext::redact_auth (Json (entry.stored_auth), notes.secrets_omitted);
    }
    if (Json settings = settings_object_of (entry); !settings.empty ()) {
        out["settings"] = std::move (settings);
    }
    if (!entry.examples.empty ()) {
        out["examples"] = examples_object_of (entry, notes);
    }
    if (entry.mock_response_mode != "first") {
        out["mockResponseMode"] = entry.mock_response_mode;
        if (entry.mock_example_index) {
            out["mockExample"] = *entry.mock_example_index;
        }
    }
    if (standalone && says_something (entry.elements)) {
        out["elements"] = Json (entry.elements);
    }
    return out;
}

/**
 * `x-vayu-collection`: variables, auth, data contract, the whole folder tree,
 * and @p extra_requests (those no operation holds). `folders` is written even
 * when empty: its presence tells an import the document states its own tree, so
 * an untagged operation belongs at the root, not in a folder named after its
 * path.
 */
Json vayu_collection_object (const ExportCollection& collection,
Json extra_requests,
ExportNotes& notes) {
    Json out = Json::object ();
    if (says_something (collection.stored_variables)) {
        out["variables"] = redacted_variables (collection.stored_variables, notes);
    }
    if (says_something (collection.stored_auth)) {
        out["auth"] =
        ext::redact_auth (Json (collection.stored_auth), notes.secrets_omitted);
    }
    if (says_something (collection.data_schema)) {
        out["dataSchema"] = Json (collection.data_schema);
    }
    Json folders = Json::array ();
    for (const ExportFolder& folder : collection.folders) {
        Json entry{ { "path", Json (folder.path) }, { "order", folder.order } };
        if (!folder.description.empty ()) {
            entry["description"] = folder.description;
        }
        if (says_something (folder.variables)) {
            entry["variables"] = redacted_variables (folder.variables, notes);
        }
        if (says_something (folder.auth)) {
            entry["auth"] = ext::redact_auth (Json (folder.auth), notes.secrets_omitted);
        }
        if (says_something (folder.elements)) {
            entry["elements"] = Json (folder.elements);
        }
        folders.push_back (std::move (entry));
    }
    out["folders"] = std::move (folders);
    if (!extra_requests.empty ()) {
        out["requests"] = std::move (extra_requests);
    }
    return out;
}

/// A request no operation can hold, carried whole in `x-vayu-collection`.
void carry_in_extension (const ExportRequest& entry, Json& extra_requests, ExportNotes& notes) {
    extra_requests.push_back (vayu_request_object (entry, notes, /*standalone=*/true));
    notes.requests_only_in_extension += 1;
}

/// A 2.0 operation's `responses` from stored examples: one per status, the
/// first writable example per media type in its `examples` map.
Json responses_v2_of (const ExportRequest& entry, ExportNotes& notes) {
    Json responses = Json::object ();
    for (const ExportExample& example : entry.examples) {
        const std::string status = std::to_string (example.status);
        if (!responses.contains (status)) {
            responses[status] = Json{ { "description",
            undeclared_response_description (status, example.name) } };
        }
        if (example.body_truncated) {
            notes.examples_truncated += 1;
            continue;
        }
        if (example.content_type.empty ()) {
            notes.examples_without_media_type += 1;
            continue;
        }
        Json& examples = child_record (responses[status], "examples");
        if (!examples.contains (example.content_type)) {
            examples[example.content_type] = example_value (example.body);
            notes.examples_written += 1;
        }
    }
    return responses;
}

/// What a new operation is written with, beyond the request itself.
struct OperationContext {
    Vocabulary vocabulary = Vocabulary::V3;
    /// 3.0 and 2.0 require `responses`; 3.1 does not.
    bool responses_required = false;
    AuthDisposition collection;
};

/// One request as a new operation: every operation of a skeleton, and a full
/// bound export's operation for a request the document never declared.
Json operation_object (const ExportRequest& entry,
const std::string& templated,
ExportNotes& notes,
const OperationContext& context,
SchemeNamer& schemes) {
    // One per member written below. `requestBody` is as wide as the body, and
    // every later member would copy it when the object grew
    // (`reserve_members`). A member added and not counted costs that copy,
    // never a wrong document.
    constexpr size_t OPERATION_MEMBERS = 8;
    Json operation                     = Json::object ();
    vayu::utils::reserve_members (operation, OPERATION_MEMBERS);
    if (!entry.name.empty ()) {
        operation["summary"] = entry.name;
    }
    if (!entry.description.empty ()) {
        operation["description"] = entry.description;
    }

    Json parameters = Json::array ();
    append_path_parameters (templated, entry.path_params, parameters, context.vocabulary);
    DeclaredParameters declared;
    append_row_parameters (entry, declared, parameters, context.vocabulary);
    if (context.vocabulary == Vocabulary::V2) {
        for (Json& parameter : body_parameters_v2 (entry)) {
            parameters.push_back (std::move (parameter));
        }
    }
    if (!parameters.empty ()) {
        operation["parameters"] = std::move (parameters);
    }
    if (context.vocabulary == Vocabulary::V3) {
        if (auto body = request_body_object (entry)) {
            operation["requestBody"] = std::move (*body);
        }
    }

    if (auto security = operation_security_of (
        disposition_of (entry.auth), context.collection, schemes)) {
        operation["security"] = std::move (*security);
    }
    // `x-vayu-elements` (#1518) is a vendor extension, never a standard field,
    // so writing it never rewrites the contract (as with `x-vayu-enabled`).
    if (says_something (entry.elements)) {
        operation["x-vayu-elements"] = Json (entry.elements);
    }

    // No stored example documents no response where the dialect allows (3.1):
    // an invented `200 OK` is the claim this export is likeliest to be believed
    // about.
    Json responses = Json::object ();
    if (context.vocabulary == Vocabulary::V2) {
        responses = responses_v2_of (entry, notes);
    } else if (!entry.examples.empty ()) {
        write_response_examples (responses, entry.examples, notes, ExportDirection::Skeleton);
    }
    write_mock_extension (operation, entry,
    context.vocabulary == Vocabulary::V3 ? &responses : nullptr);
    if (responses.empty () && context.responses_required) {
        responses["default"] = Json{ { "description", "No response documented." } };
    }
    if (!responses.empty ()) {
        operation["responses"] = std::move (responses);
    }
    operation[std::string (ext::REQUEST_KEY)] = vayu_request_object (entry, notes, false);
    return operation;
}

/// The literal server-URL token every `{{baseUrl}}`-prefixed request writes.
constexpr std::string_view VAYU_BASE_URL_TOKEN = "{{baseUrl}}";

/**
 * @p origin as a Server Object. A bare `{{baseUrl}}` becomes OpenAPI's
 * single-brace `{baseUrl}` with the collection's value as `default`, which
 * `resolve_server_url` substitutes exactly, so a re-import gets the value back
 * rather than a variable whose value is its own token (#1441). With no value
 * the double-brace token stays: an undeclared single-brace variable is invalid
 * OpenAPI, and a visibly unfinished base beats a false default.
 */
Json server_object (const std::string& origin, const ExportCollection& collection) {
    if (origin != VAYU_BASE_URL_TOKEN || collection.base_url_value.empty ()) {
        return Json{ { "url", origin } };
    }
    return Json{ { "url", "{baseUrl}" },
        { "variables",
        Json{ { "baseUrl", Json{ { "default", collection.base_url_value } } } } } };
}

/// A request's folder as a tag, its whole path joined (`Pets/Actions`), which
/// other tools group by; the nesting travels in `x-vayu-collection.folders`.
std::optional<std::string> tag_of (const ExportRequest& entry) {
    if (entry.folder_path.empty ()) {
        return std::nullopt;
    }
    std::string joined;
    for (const std::string& segment : entry.folder_path) {
        if (!joined.empty ()) {
            joined += '/';
        }
        joined += segment;
    }
    return joined;
}

/// The description of the folder a joined tag name stands for, or `""`.
std::string folder_description_of (const ExportCollection& collection,
const std::string& tag) {
    for (const ExportFolder& folder : collection.folders) {
        std::string joined;
        for (const std::string& segment : folder.path) {
            joined += (joined.empty () ? "" : "/") + segment;
        }
        if (joined == tag) {
            return folder.description;
        }
    }
    return {};
}

/// `servers` and `tags`, each written only when there is one to write.
void write_servers_and_tags (Json& document,
const std::vector<std::string>& servers,
const std::vector<std::string>& tag_order,
const ExportCollection& collection) {
    if (!servers.empty ()) {
        Json entries = Json::array ();
        for (const std::string& url : servers) {
            entries.push_back (server_object (url, collection));
        }
        document["servers"] = std::move (entries);
    }
    if (!tag_order.empty ()) {
        Json entries = Json::array ();
        for (const std::string& name : tag_order) {
            Json tag{ { "name", name } };
            if (const std::string description = folder_description_of (collection, name);
            !description.empty ()) {
                tag["description"] = description;
            }
            entries.push_back (std::move (tag));
        }
        document["tags"] = std::move (entries);
    }
}

/// The document's `security` (from the collection's auth) and the
/// `securitySchemes` the operations and root asked for.
void write_root_security (Json& document,
const AuthDisposition& collection_disp,
SkeletonSchemes& schemes) {
    if (collection_disp.kind == AuthDisposition::Kind::None) {
        document["security"] = Json::array ();
    } else if (collection_disp.kind == AuthDisposition::Kind::Scheme) {
        if (const auto name = schemes.name_for (collection_disp.auth)) {
            document["security"] = security_requirement (*name);
        }
    }
    if (!schemes.schemes ().empty ()) {
        document["components"] = Json{ { "securitySchemes", schemes.schemes () } };
    }
}

Assembly skeleton_document (const ExportCollection& collection,
const std::vector<ExportRequest>& requests) {
    Assembly assembly;
    assembly.notes =
    empty_notes ("skeleton", "OpenAPI " + std::string (SKELETON_VERSION));

    const OperationContext context{ Vocabulary::V3,
        /*responses_required=*/false, disposition_of (collection.auth) };
    SkeletonSchemes schemes;
    Json paths          = Json::object ();
    Json extra_requests = Json::array ();
    std::vector<std::string> servers;
    std::unordered_set<std::string> claimed;
    std::vector<std::string> tag_order;
    std::unordered_set<std::string> tags_seen;

    for (const ExportRequest& entry : requests) {
        const RequestUrlParts parts = split_request_url (entry.url);
        if (!parts.path) {
            assembly.notes.requests_without_path += 1;
            carry_in_extension (entry, extra_requests, assembly.notes);
            continue;
        }
        const std::string templated = path_template (*parts.path);
        const std::string method    = vayu::utils::ascii_lower (entry.method);
        if (!claimed.insert (std::format ("{} {}", method, templated)).second) {
            // One method and path is one operation; the second would silently
            // replace the first.
            assembly.notes.duplicate_operations += 1;
            carry_in_extension (entry, extra_requests, assembly.notes);
            continue;
        }
        if (parts.origin) {
            const std::string origin = server_origin_of (*parts.origin);
            if (std::find (servers.begin (), servers.end (), origin) == servers.end ()) {
                servers.push_back (origin);
            }
        }

        Json& item = child_record (paths, templated);
        Json operation =
        operation_object (entry, templated, assembly.notes, context, schemes);
        if (const auto tag = tag_of (entry)) {
            operation["tags"] = Json::array ({ *tag });
            if (tags_seen.insert (*tag).second) {
                tag_order.push_back (*tag);
            }
        }
        item[method] = std::move (operation);
        assembly.notes.requests_exported += 1;
    }

    Json info{ { "title", collection.name.empty () ? "Untitled API" : collection.name },
        { "version", std::string (PLACEHOLDER_VERSION) } };
    if (!collection.description.empty ()) {
        info["description"] = collection.description;
    }

    assembly.document = Json{ { "openapi", std::string (SKELETON_VERSION) },
        { "info", std::move (info) } };
    write_servers_and_tags (assembly.document, servers, tag_order, collection);
    write_root_security (assembly.document, context.collection, schemes);
    if (says_something (collection.elements)) {
        assembly.document["x-vayu-elements"] = Json (collection.elements);
    }
    assembly.document[std::string (ext::COLLECTION_KEY)] =
    vayu_collection_object (collection, std::move (extra_requests), assembly.notes);
    assembly.document["paths"] = std::move (paths);
    return assembly;
}

// --- The bound direction, assembled ----------------------------------------

/// How a bound export writes: the user's mode, the dialect's vocabulary and, in
/// full mode, the schemes it names.
struct BoundWrite {
    BoundMode mode = BoundMode::Contract;
    OperationContext context;
    BoundSchemes* schemes = nullptr;
    /// The document's `base_paths_of`: what the matcher stripped when it
    /// stamped.
    std::vector<std::string> base_paths;
};

/**
 * The root requirement an import reads (`primary_scheme`,
 * `import_document.cpp`): the document's `security`, else its first scheme. A
 * document declaring schemes but requiring none already says "the first one"
 * and is not rewritten to.
 */
std::optional<Json> root_requirement_as_imported (const Json& document, Vocabulary vocabulary) {
    if (const auto own = document.find ("security"); own != document.end ()) {
        return std::make_optional (*own);
    }
    const Json* schemes = nullptr;
    if (vocabulary == Vocabulary::V3) {
        const auto components = document.find ("components");
        if (components != document.end () && components->is_object ()) {
            const auto found = components->find ("securitySchemes");
            schemes          = found == components->end () ? nullptr : &*found;
        }
    } else {
        const auto found = document.find ("securityDefinitions");
        schemes          = found == document.end () ? nullptr : &*found;
    }
    if (schemes == nullptr || !schemes->is_object () || schemes->empty ()) {
        return std::nullopt;
    }
    return std::make_optional (
    Json::array ({ Json{ { schemes->begin ().key (), Json::array () } } }));
}

/// Whether @p requirement already says what @p disposition sends.
bool security_says (const Json* requirement,
const AuthDisposition& disposition,
const BoundSchemes& schemes) {
    if (disposition.kind == AuthDisposition::Kind::None) {
        return requirement == nullptr ||
        (requirement->is_array () &&
        (requirement->empty () ||
        (requirement->size () == 1 && requirement->front ().is_object () &&
        requirement->front ().empty ())));
    }
    if (disposition.kind == AuthDisposition::Kind::Scheme) {
        return requirement != nullptr &&
        schemes.names (*requirement, disposition.auth);
    }
    return true; // inherit / a mode OpenAPI cannot state: nothing to write
}

/// @p body written into a media object the operation declares: its example
/// where the document states none, its schema only where it has none; a file
/// states no example. By value for `media_object_of`'s reason.
void write_into_media (Json& media, BodyExample body) {
    // Read off the value before it moves, still written second so members keep
    // their order.
    std::optional<Json> schema;
    if (media.contains ("schema")) {
        // The document's own schema stays.
    } else if (body.file) {
        schema = file_schema ();
    } else if (body.form_schema) {
        schema = std::move (*body.form_schema);
    } else {
        schema = schema_from_example (body.value);
    }
    if (!body.file && !media.contains ("examples") &&
    !(body.value.is_object () && body.value.empty ())) {
        media["example"] = std::move (body.value);
    }
    if (schema) {
        media["schema"] = std::move (*schema);
    }
}

/**
 * A request body written into an operation the document declares (full mode).
 * The document's schema stays; the body lands as the media type's `example`,
 * except beside an `examples` map, which admits none (`x-vayu-request.body`
 * carries it either way). An undeclared media type is added whole; a `$ref`
 * body is shared and never written through.
 */
void write_body_full (Json& operation, const ExportRequest& entry, Vocabulary vocabulary) {
    if (vocabulary == Vocabulary::V2) {
        const auto parameters    = operation.find ("parameters");
        const bool declares_body = parameters != operation.end () &&
        parameters->is_array () &&
        std::any_of (parameters->begin (), parameters->end (), [] (const Json& p) {
            const std::string location = string_member (p, "in");
            return location == "body" || location == "formData";
        });
        if (declares_body) {
            return;
        }
        Json body = body_parameters_v2 (entry);
        if (body.empty ()) {
            return;
        }
        if (parameters == operation.end () || !parameters->is_array ()) {
            operation["parameters"] = Json::array ();
        }
        for (Json& parameter : body) {
            operation["parameters"].push_back (std::move (parameter));
        }
        return;
    }
    std::optional<BodyExample> body = body_example_of (entry);
    if (!body) {
        return;
    }
    const auto declared = operation.find ("requestBody");
    if (declared != operation.end () &&
    (!declared->is_object () || !string_member (*declared, "$ref").empty ())) {
        return;
    }
    Json& content = child_record (child_record (operation, "requestBody"), "content");
    const auto media = content.find (body->media_type);
    if (media == content.end () || !media->is_object ()) {
        const std::string media_type = body->media_type;
        content[media_type]          = media_object_of (std::move (*body));
        return;
    }
    write_into_media (*media, std::move (*body));
}

/// A 2.0 operation's saved examples merged into the responses it declares.
void write_examples_v2 (Json& operation, const ExportRequest& entry, ExportNotes& notes) {
    // An imported example came from this document or was sampled off its schema
    // (`disposition_of` makes the same call for 3.x). Examples cannot be edited
    // in place, so only a saved response is news.
    ExportRequest saved = entry;
    std::erase_if (
    saved.examples, [] (const ExportExample& e) { return e.from_import; });
    Json& responses       = child_record (operation, "responses");
    const Json documented = responses_v2_of (saved, notes);
    for (const auto& [status, response] : documented.items ()) {
        if (!responses.contains (status)) {
            responses[status] = response;
            continue;
        }
        const auto examples = response.find ("examples");
        if (!responses[status].is_object () || examples == response.end ()) {
            continue;
        }
        Json& declared = child_record (responses[status], "examples");
        for (const auto& [media, value] : examples->items ()) {
            if (!declared.contains (media)) {
                declared[media] = value;
            }
        }
    }
}

/**
 * Full mode, into an operation the document declares: what contract mode leaves
 * out. The request's name and description, a parameter per undeclared row, the
 * body, the auth where the operation does not already state it, and `x-vayu-*`
 * for the rest.
 */
void write_everything (Json& operation,
const ExportRequest& entry,
DeclaredParameters declared,
ExportNotes& notes,
const BoundWrite& write) {
    const Vocabulary vocabulary = write.context.vocabulary;
    // The name an import reads (`name_draft`): summary, else operationId, else
    // method and path. A request still named that needs no summary.
    std::string imported_name = string_member (operation, "summary");
    if (imported_name.empty () && !operation.contains ("summary")) {
        imported_name = string_member (operation, "operationId");
        if (imported_name.empty () && !operation.contains ("operationId") &&
        entry.spec_operation) {
            imported_name = vayu::utils::ascii_upper (entry.spec_operation->method) +
            " " + entry.spec_operation->path;
        }
    }
    if (!entry.name.empty () && entry.name != imported_name) {
        operation["summary"] = entry.name;
    }
    if (entry.description.empty ()) {
        operation.erase ("description");
    } else {
        operation["description"] = entry.description;
    }

    Json added = Json::array ();
    append_row_parameters (entry, declared, added, vocabulary);
    if (!added.empty ()) {
        Json& parameters = operation["parameters"];
        if (!parameters.is_array ()) {
            parameters = Json::array ();
        }
        for (Json& parameter : added) {
            parameters.push_back (std::move (parameter));
        }
    }
    write_body_full (operation, entry, vocabulary);

    // An operation with no `security` imports as `inherit` (the collection's
    // auth), so it already says the request's when the two agree.
    const AuthDisposition request_disp = disposition_of (entry.auth);
    const auto own_security            = operation.find ("security");
    const bool already_said            = own_security == operation.end () ?
    same_disposition (request_disp, write.context.collection) ||
    request_disp.kind == AuthDisposition::Kind::Inherit ||
    request_disp.kind == AuthDisposition::Kind::Unsupported :
    security_says (&*own_security, request_disp, *write.schemes);
    if (!already_said) {
        if (request_disp.kind == AuthDisposition::Kind::None) {
            operation["security"] = Json::array ();
        } else if (const auto name = write.schemes->name_for (request_disp.auth)) {
            operation["security"] = security_requirement (*name);
        }
    }

    if (says_something (entry.elements)) {
        operation["x-vayu-elements"] = Json (entry.elements);
    }
    if (vocabulary == Vocabulary::V2) {
        write_examples_v2 (operation, entry, notes);
        write_mock_extension (operation, entry, nullptr);
    }
    operation[std::string (ext::REQUEST_KEY)] = vayu_request_object (entry, notes, false);
}

void patch_operation (Json& operation,
const Json& document,
const ExportRequest& entry,
DeclaredParameters inherited,
ExportNotes& notes,
const BoundWrite& write) {
    const bool full                   = write.mode == BoundMode::Full;
    const Vocabulary vocabulary       = write.context.vocabulary;
    const DeclaredParameters declared = patch_parameters (operation, document,
    entry, std::move (inherited), notes, /*counts_withheld=*/!full,
    vocabulary == Vocabulary::V3 ? "example" : "x-example");
    count_edited_identity (entry, notes, write.base_paths);
    if (full) {
        write_everything (operation, entry, declared, notes, write);
    } else {
        count_undeclared_rows (entry, declared, notes);
        count_unwritten_body (entry, notes);
        // `x-vayu-elements` (#1518) on a declared operation is an additive
        // vendor key, never a rewrite of what it means.
        if (says_something (entry.elements)) {
            operation["x-vayu-elements"] = Json (entry.elements);
        }
    }
    if (vocabulary == Vocabulary::V3) {
        if (!entry.examples.empty ()) {
            write_response_examples (child_record (operation, "responses"),
            entry.examples, notes, ExportDirection::Bound);
        }
        const auto responses = operation.find ("responses");
        write_mock_extension (
        operation, entry, responses == operation.end () ? nullptr : &*responses);
    }
}

/**
 * Every operation on one path item, patched or removed. @p document is the
 * whole stored document, read for the components a `$ref` names; only members
 * under @p path_item are written, so nothing read moves.
 */
void patch_path_item (Assembly& assembly,
const std::vector<ExportRequest>& requests,
const Json& document,
const Dialect& dialect,
const BoundWrite& write,
const std::string& path,
const std::unordered_map<std::string, size_t>& by_operation_id,
const std::unordered_map<std::string, size_t>& by_method_path,
std::unordered_set<size_t>& claimed,
Json& path_item) {
    const DeclaredParameters inherited = inherited_parameters (document, path_item);
    for (const std::string_view method : PATH_ITEM_METHODS) {
        const std::string key (method);
        const auto operation = path_item.find (key);
        if (operation == path_item.end () || !operation->is_object ()) {
            continue;
        }
        const size_t* found =
        find_request (*operation, method, path, by_operation_id, by_method_path);
        if (found == nullptr) {
            path_item.erase (key);
            assembly.notes.operations_removed += 1;
            continue;
        }
        claimed.insert (*found);
        assembly.notes.requests_exported += 1;
        // Contract mode writes into 3.x operations only (2.0 has its own
        // vocabulary); full mode was asked to write everything, 2.0 included.
        if (dialect.writable || write.mode == BoundMode::Full) {
            patch_operation (*operation, document, requests[*found], inherited,
            assembly.notes, write);
        }
    }
}

/**
 * Every declared operation, patched or removed; a path left with no operations
 * goes too. That is what makes re-importing the export produce the collection
 * it came from.
 */
void patch_document_paths (Assembly& assembly,
const std::vector<ExportRequest>& requests,
const Dialect& dialect,
const BoundWrite& write,
const std::unordered_map<std::string, size_t>& by_operation_id,
const std::unordered_map<std::string, size_t>& by_method_path,
std::unordered_set<size_t>& claimed,
std::unordered_set<std::string>& referenced_paths) {
    const auto paths = assembly.document.find ("paths");
    if (paths != assembly.document.end () && paths->is_object ()) {
        std::vector<std::string> emptied;
        for (auto entry = paths->begin (); entry != paths->end (); ++entry) {
            Json& path_item = entry.value ();
            if (!path_item.is_object ()) {
                continue;
            }
            if (!string_member (path_item, "$ref").empty ()) {
                referenced_paths.insert (entry.key ());
                continue;
            }
            // The document is read (for `$ref` components) while a path item in
            // it is written; the two never touch one node, and no root member
            // changes here.
            patch_path_item (assembly, requests, assembly.document, dialect, write,
            entry.key (), by_operation_id, by_method_path, claimed, path_item);
            const bool has_operation = std::any_of (PATH_ITEM_METHODS.begin (),
            PATH_ITEM_METHODS.end (), [&] (std::string_view method) {
                return path_item.contains (std::string (method));
            });
            if (!has_operation) {
                emptied.push_back (entry.key ());
            }
        }
        for (const std::string& key : emptied) {
            paths->erase (key);
        }
    }
}

/** What became of the requests no operation in the document claimed. */
void count_unclaimed_requests (const std::vector<ExportRequest>& requests,
const std::unordered_set<size_t>& claimed,
const std::unordered_set<std::string>& referenced_paths,
ExportNotes& notes) {
    for (size_t index = 0; index < requests.size (); ++index) {
        if (claimed.contains (index)) {
            continue;
        }
        const auto& identity = requests[index].spec_operation;
        if (!identity) {
            notes.requests_without_operation += 1;
        } else if (referenced_paths.contains (identity->path)) {
            notes.requests_exported += 1;
        } else {
            notes.operations_not_in_document += 1;
        }
    }
}

/**
 * Full mode: the requests no operation claimed, added as operations under the
 * method and path their URL states and their folder's tag. One whose URL states
 * no path, or whose method and path an operation holds, goes whole into
 * `x-vayu-collection.requests`.
 */
void add_unclaimed_operations (Assembly& assembly,
const std::vector<ExportRequest>& requests,
const std::unordered_set<size_t>& claimed,
const std::unordered_set<std::string>& referenced_paths,
const BoundWrite& write,
Json& extra_requests,
std::vector<std::string>& new_tags) {
    Json& paths = child_record (assembly.document, "paths");
    for (size_t index = 0; index < requests.size (); ++index) {
        const ExportRequest& entry = requests[index];
        if (claimed.contains (index) ||
        (entry.spec_operation &&
        referenced_paths.contains (entry.spec_operation->path))) {
            continue;
        }
        const RequestUrlParts parts = split_request_url (entry.url);
        if (!parts.path) {
            assembly.notes.requests_without_path += 1;
            carry_in_extension (entry, extra_requests, assembly.notes);
            continue;
        }
        const std::string templated = path_template (*parts.path);
        const std::string method    = vayu::utils::ascii_lower (entry.method);
        Json& item                  = child_record (paths, templated);
        if (item.contains (method) || !string_member (item, "$ref").empty ()) {
            assembly.notes.duplicate_operations += 1;
            carry_in_extension (entry, extra_requests, assembly.notes);
            continue;
        }
        Json operation = operation_object (
        entry, templated, assembly.notes, write.context, *write.schemes);
        if (const auto tag = tag_of (entry)) {
            operation["tags"] = Json::array ({ *tag });
            if (std::find (new_tags.begin (), new_tags.end (), *tag) == new_tags.end ()) {
                new_tags.push_back (*tag);
            }
        }
        item[method] = std::move (operation);
        assembly.notes.operations_added += 1;
        assembly.notes.requests_exported += 1;
    }
}

/// A Server Object's URL with each `{variable}` replaced by its `default`: the
/// URL an import reads.
std::string resolved_server_url (const Json& server) {
    std::string url      = string_member (server, "url");
    const auto variables = server.find ("variables");
    if (variables == server.end () || !variables->is_object ()) {
        return url;
    }
    for (const auto& [name, variable] : variables->items ()) {
        const std::string token = "{" + name + "}";
        for (size_t at = url.find (token); at != std::string::npos; at = url.find (token)) {
            url.replace (at, token.size (), string_member (variable, "default"));
        }
    }
    return url;
}

/// Points `servers[0]` at @p base when it no longer resolves there, keeping its
/// description; the 3.x half of `write_base_url`.
void write_server_v3 (Json& document, const std::string& base) {
    Json& servers = document["servers"];
    if (!servers.is_array ()) {
        servers = Json::array ();
    }
    if (servers.empty ()) {
        servers.push_back (Json{ { "url", base } });
        return;
    }
    Json& first = servers.front ();
    if (first.is_object () && resolved_server_url (first) == base) {
        return;
    }
    Json server{ { "url", base } };
    if (first.is_object () && first.contains ("description")) {
        server["description"] = first.at ("description");
    }
    first = std::move (server);
}

/// Points `schemes`, `host` and `basePath` at @p base where they no longer say
/// it; the 2.0 half of `write_base_url`.
void write_host_v2 (Json& document, const std::string& base) {
    const size_t scheme_end = base.find ("://");
    if (scheme_end == std::string::npos) {
        return;
    }
    const std::string scheme = base.substr (0, scheme_end);
    const std::string rest   = base.substr (scheme_end + 3);
    const size_t slash       = rest.find ('/');
    const std::string host   = rest.substr (0, slash);
    const std::string path = slash == std::string::npos ? "" : rest.substr (slash);
    if (string_member (document, "host") != host) {
        document["host"] = host;
    }
    const std::string declared_path = string_member (document, "basePath");
    if ((declared_path == "/" ? "" : declared_path) != path) {
        document["basePath"] = path.empty () ? "/" : path;
    }
    const auto schemes = document.find ("schemes");
    const bool same    = schemes != document.end () && schemes->is_array () &&
    !schemes->empty () && schemes->front ().is_string () &&
    schemes->front ().get<std::string> () == scheme;
    if (!same) {
        document["schemes"] = Json::array ({ scheme });
    }
}

/**
 * Points the document's base URL at the collection's `baseUrl` when they
 * differ: the value a re-import turns back into `{{baseUrl}}`. A value still a
 * `{{variable}}` names no server and is skipped.
 */
void write_base_url (Json& document, const ExportCollection& collection, Vocabulary vocabulary) {
    const std::string& base = collection.base_url_value;
    if (base.empty () || base.find ("{{") != std::string::npos) {
        return;
    }
    if (vocabulary == Vocabulary::V3) {
        write_server_v3 (document, base);
    } else {
        write_host_v2 (document, base);
    }
}

/// Full mode's collection-level half: the document's name, description, base
/// URL and `security`, tags for the folders new operations went into, and the
/// `x-vayu-*` root members.
void write_document_root (Assembly& assembly,
const ExportCollection& collection,
const BoundWrite& write,
Json extra_requests,
const std::vector<std::string>& new_tags) {
    Json& document = assembly.document;
    Json& info     = child_record (document, "info");
    if (!collection.name.empty ()) {
        info["title"] = collection.name;
    }
    if (collection.description.empty ()) {
        info.erase ("description");
    } else {
        info["description"] = collection.description;
    }
    write_base_url (document, collection, write.context.vocabulary);

    const AuthDisposition& collection_disp = write.context.collection;
    const std::optional<Json> root_security =
    root_requirement_as_imported (document, write.context.vocabulary);
    if (!security_says (root_security ? &*root_security : nullptr,
        collection_disp, *write.schemes)) {
        if (collection_disp.kind == AuthDisposition::Kind::None) {
            document["security"] = Json::array ();
        } else if (const auto name = write.schemes->name_for (collection_disp.auth)) {
            document["security"] = security_requirement (*name);
        }
    }
    write.schemes->write_into (document);

    if (!new_tags.empty ()) {
        Json& tags = document["tags"];
        if (!tags.is_array ()) {
            tags = Json::array ();
        }
        for (const std::string& name : new_tags) {
            const bool declared = std::any_of (tags.begin (), tags.end (),
            [&] (const Json& tag) { return string_member (tag, "name") == name; });
            if (declared) {
                continue;
            }
            Json tag{ { "name", name } };
            if (const std::string description = folder_description_of (collection, name);
            !description.empty ()) {
                tag["description"] = description;
            }
            tags.push_back (std::move (tag));
        }
    }
    if (says_something (collection.elements)) {
        document["x-vayu-elements"] = Json (collection.elements);
    } else {
        document.erase ("x-vayu-elements");
    }
    document[std::string (ext::COLLECTION_KEY)] =
    vayu_collection_object (collection, std::move (extra_requests), assembly.notes);
}

/**
 * The stored bytes, patched. Everything Vayu does not model (`info`, `tags`,
 * vendor extensions, `security`, components no operation here references) is
 * carried through by not being visited. That is why this direction exists: a
 * rebuilt document would be Vayu's opinion of the user's contract, and what it
 * has no opinion about would vanish. Full mode (`BoundMode::Full`) visits more
 * (`write_everything`, `write_document_root`) and still never rebuilds.
 */
Assembly patch_bound_document (const std::string& content,
const ExportCollection& collection,
const std::vector<ExportRequest>& requests,
BoundMode mode) {
    Assembly assembly;
    DocumentRead read = read_document (content);
    if (!read.ok ()) {
        assembly.error = "The stored document could not be read: " + read.error;
        return assembly;
    }
    if (!read.root.is_object ()) {
        assembly.error = "The stored document is not an OpenAPI object.";
        return assembly;
    }
    assembly.document = std::move (read.root);

    Dialect dialect;
    if (auto refusal = read_dialect (assembly.document, dialect)) {
        assembly.error = *refusal;
        return assembly;
    }
    assembly.notes            = empty_notes ("document", dialect.label);
    assembly.notes.bound_mode = mode == BoundMode::Full ? "full" : "contract";
    assembly.notes.vocabulary_not_written = !dialect.writable && mode == BoundMode::Contract;

    const Vocabulary vocabulary = dialect.writable ? Vocabulary::V3 : Vocabulary::V2;
    BoundSchemes schemes (assembly.document, vocabulary);
    const std::string version = string_member (assembly.document, "openapi");
    const BoundWrite write{ mode,
        OperationContext{ vocabulary,
        /*responses_required=*/vocabulary == Vocabulary::V2 || version.starts_with ("3.0"),
        disposition_of (collection.auth) },
        &schemes, base_paths_of (assembly.document) };

    std::unordered_map<std::string, size_t> by_operation_id;
    std::unordered_map<std::string, size_t> by_method_path;
    index_requests (requests, by_operation_id, by_method_path);

    std::unordered_set<size_t> claimed;
    /*
     * Paths whose Path Item is itself a `$ref` (legal in 3.0/3.1; bundlers emit
     * it when hoisting a shared item into `components.pathItems`). Its methods
     * are not readable without following the ref and mutating a node other
     * paths may share, so it is left as is, and a request naming it is reported
     * as carried, not missing.
     */
    std::unordered_set<std::string> referenced_paths;

    patch_document_paths (assembly, requests, dialect, write, by_operation_id,
    by_method_path, claimed, referenced_paths);
    if (mode == BoundMode::Full) {
        Json extra_requests = Json::array ();
        std::vector<std::string> new_tags;
        add_unclaimed_operations (assembly, requests, claimed, referenced_paths,
        write, extra_requests, new_tags);
        write_document_root (
        assembly, collection, write, std::move (extra_requests), new_tags);
    } else {
        count_unclaimed_requests (requests, claimed, referenced_paths, assembly.notes);
    }

    return assembly;
}


// --- Serialization ----------------------------------------------------------

std::string serialize (const Json& document, ExportFormat format) {
    if (format == ExportFormat::Yaml) {
        return emit_yaml (document);
    }
    // `error_handler_t::replace`, as the YAML writer: a stored example body is
    // bytes off somebody's server, and one invalid sequence must not cost the
    // whole export.
    return document.dump (2, ' ', false, Json::error_handler_t::replace) + "\n";
}

/** A collection name as a file name: lower case, one dash per run of anything else. */
std::string file_slug (const std::string& name) {
    std::string slug;
    bool pending_dash = false;
    for (const char raw : name) {
        const auto c = static_cast<unsigned char> (raw);
        if (std::isalnum (c) != 0 && c < 0x80) {
            if (pending_dash && !slug.empty ()) {
                slug += '-';
            }
            pending_dash = false;
            slug += vayu::utils::ascii_lower (raw);
        } else {
            pending_dash = true;
        }
    }
    return slug.empty () ? "collection" : slug;
}

} // namespace

ExportOutcome export_openapi (const ExportCollection& collection,
const std::vector<ExportRequest>& requests,
const std::optional<std::string>& spec_content,
ExportFormat format,
BoundMode bound_mode) {
    // Every writer below reads these copies, so none can write a credential
    // row's value ("Credentials outside an auth block").
    const ExportCollection safe_collection = withhold_credentials (collection);
    std::vector<ExportRequest> safe_requests;
    safe_requests.reserve (requests.size ());
    for (const ExportRequest& entry : requests) {
        safe_requests.push_back (withhold_credentials (entry));
    }
    Assembly assembly = spec_content ?
    patch_bound_document (*spec_content, safe_collection, safe_requests, bound_mode) :
    skeleton_document (safe_collection, safe_requests);

    ExportOutcome outcome;
    if (!assembly.error.empty ()) {
        outcome.error = std::move (assembly.error);
        return outcome;
    }
    outcome.notes     = std::move (assembly.notes);
    outcome.text      = serialize (assembly.document, format);
    outcome.file_name = file_slug (collection.name) + ".openapi." +
    (format == ExportFormat::Yaml ? "yaml" : "json");
    return outcome;
}

nlohmann::json export_notes_json (const ExportNotes& notes) {
    return nlohmann::json{ { "direction", notes.direction },
        { "dialect", notes.dialect }, { "requestsExported", notes.requests_exported },
        { "requestsWithoutOperation", notes.requests_without_operation },
        { "operationsNotInDocument", notes.operations_not_in_document },
        { "operationsRemoved", notes.operations_removed },
        { "requestsWithoutPath", notes.requests_without_path },
        { "duplicateOperations", notes.duplicate_operations },
        { "examplesWritten", notes.examples_written },
        { "examplesWithoutMediaType", notes.examples_without_media_type },
        { "examplesTruncated", notes.examples_truncated },
        { "examplesAlreadyDeclared", notes.examples_already_declared },
        { "examplesSampledAtImport", notes.examples_sampled_at_import },
        { "sharedParametersLeft", notes.shared_parameters_left },
        { "referencedResponsesLeft", notes.referenced_responses_left },
        { "bodiesNotWritten", notes.bodies_not_written },
        { "rowsNotDeclared", notes.rows_not_declared },
        { "operationsEdited", notes.operations_edited },
        { "vocabularyNotWritten", notes.vocabulary_not_written },
        { "secretsOmitted", notes.secrets_omitted },
        { "requestsOnlyInExtension", notes.requests_only_in_extension },
        { "operationsAdded", notes.operations_added }, { "boundMode", notes.bound_mode } };
}

} // namespace vayu::core
