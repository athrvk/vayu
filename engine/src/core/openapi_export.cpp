/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_export.cpp
 * @brief Assembling a collection back into an OpenAPI document (issue #855).
 *        See the header for the two directions and why neither invents.
 *
 * The rules here are the renderer's, ported rather than re-derived: every one
 * of them was learned from a document somebody exported and could not
 * re-import, and `openapi_export_test.cpp` carries the cases that found them.
 */

#include "vayu/core/openapi_export.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/operation_match.hpp"
#include "vayu/utils/ascii_case.hpp"

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

/**
 * The dialect a skeleton is written in. 3.1 rather than 3.0 because it is the
 * current one and this document is new - there is no stored dialect to
 * preserve, which is the only reason the bound direction pins one.
 */
constexpr std::string_view SKELETON_VERSION = "3.1.0";

/**
 * `info.version` is required and a collection records none. `0.0.0` rather than
 * `1.0.0`: a version nobody chose should not read like a release.
 */
constexpr std::string_view PLACEHOLDER_VERSION = "0.0.0";

/**
 * The sentence a derived schema carries. Load-bearing: it is the difference
 * between "the API declares this" and "Vayu saw one body that looked like
 * this", and the exported document is read by people who were not here when it
 * was made.
 */
constexpr std::string_view DERIVED_SCHEMA_NOTE =
"Shape derived from an example body, not a declared schema.";

/// The method keys a Path Item Object may carry - OpenAPI defines exactly
/// these. `trace` is here and absent from `declared_operations_of`'s list on
/// purpose: no request can carry a `trace` identity, but a document that
/// declares one still has it removed when nothing claims it.
constexpr std::array<std::string_view, 8> PATH_ITEM_METHODS = { "get", "put",
    "post", "delete", "options", "head", "patch", "trace" };

/**
 * Headers an operation does not declare as parameters. `Authorization` is
 * described by `security`, `Content-Type` by the request body's media type -
 * the same two the OpenAPI import drops on the way in, so a round trip does not
 * grow a parameter each time.
 */
constexpr std::array<std::string_view, 2> NON_PARAMETER_HEADERS = {
    "authorization", "content-type"
};

std::string upper (std::string_view text) {
    std::string out (text);
    std::transform (out.begin (), out.end (), out.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    return out;
}

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

/// A node's string value when it is a non-empty string, `""` otherwise - the
/// renderer's `asStr` plus the falsiness every one of its call sites applies.
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
 * An example body as the value an `example` field holds.
 *
 * JSON when it parses as JSON, the text itself when it does not. A body Vayu
 * stored is whatever the server sent or the spec declared, so a non-JSON body -
 * XML, a plain-text error - is written as the string it is rather than dropped:
 * `example` is typed as "any value", and a string is a value.
 */
Json example_value (const std::string& body) {
    const std::string_view text = trim (body);
    if (text.empty ()) {
        return std::string ();
    }
    Json parsed = Json::parse (text, /*cb=*/nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded ()) {
        return body;
    }
    return parsed;
}

/**
 * The shape of one example value.
 *
 * Deliberately shallow in what it claims: types, `properties` for an object and
 * `items` for an array's first element, and nothing else - no `required`, no
 * formats, no enums. Those are assertions about the endpoint, and one sample
 * cannot support them.
 *
 * @p depth stops at the reader's own nesting bound, and for the same reason it
 * has one: this walk is recursive, and the value under it came out of a stored
 * body rather than out of anything Vayu wrote.
 */
Json shape_of (const Json& value, size_t depth) {
    if (value.is_null ()) {
        return Json{ { "type", "null" } };
    }
    if (value.is_array ()) {
        // An empty array says its type and nothing about its members - `items`
        // from no member would be an invention.
        Json out{ { "type", "array" } };
        if (!value.empty () && depth < constants::spec_document::MAX_READ_DEPTH) {
            out["items"] = shape_of (value.front (), depth + 1);
        }
        return out;
    }
    if (value.is_string ()) {
        return Json{ { "type", "string" } };
    }
    if (value.is_boolean ()) {
        return Json{ { "type", "boolean" } };
    }
    if (value.is_number ()) {
        return Json{ { "type", value.is_number_integer () ? "integer" : "number" } };
    }
    Json properties = Json::object ();
    if (depth < constants::spec_document::MAX_READ_DEPTH) {
        for (auto member = value.begin (); member != value.end (); ++member) {
            properties[member.key ()] = shape_of (member.value (), depth + 1);
        }
    }
    return Json{ { "type", "object" }, { "properties", std::move (properties) } };
}

Json schema_from_example (const Json& value) {
    Json schema           = shape_of (value, 0);
    schema["description"] = std::string (DERIVED_SCHEMA_NOTE);
    return schema;
}

/**
 * Items grouped by a key, in the order the keys were first seen.
 *
 * Insertion-ordered rather than sorted, because the order examples were stored
 * in is the order their statuses are written in, and a hash order would make
 * one collection's document differ from another's for no reason a reader could
 * name.
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
 * A key @p map does not hold yet - @p wanted, or the first free suffix of it.
 *
 * A name two examples share is suffixed rather than allowed to overwrite -
 * losing an example to a key collision is exactly the silent drop this export
 * may not make, and since the map can be the document's own, an entry Vayu
 * never read is one of the things that can be collided with.
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
 * Several examples of one status and media type, added to an `examples` map.
 *
 * Keyed by the example's name, which is what a reader of the document sees.
 * *Added*, never assigned over: the map is the document's in a bound export,
 * and an entry this export did not read is an entry it may not drop.
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
 * Stored examples as an operation's `responses`, for both export directions.
 *
 * One implementation, because it is one decision made twice: a bound document
 * writes examples into responses it may already declare, and a skeleton writes
 * them into responses that do not exist yet, but *which* status, *which* media
 * type, and what to do about a second example of the same pair are the same
 * questions with the same answers. What the two directions do not share is who
 * owns the document underneath: a skeleton is writing one that does not exist
 * yet, and a bound export is editing the user's contract. Everything below that
 * reads `ExportDirection` is a consequence of that one difference.
 */
enum class ExportDirection : std::uint8_t { Bound, Skeleton };

/**
 * The values a media object already documents - its `example`, and the payload
 * of every entry of its `examples` map.
 *
 * Read rather than assumed: a stored example equal to one of these is in the
 * contract already, and an imported example with none of these to be equal to
 * came from a schema the import sampled rather than from the document.
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
        // An Example Object carries its payload in `value`; `externalValue`
        // names a URL instead, which is nothing to compare a stored body to.
        if (const auto value = entry.find ("value");
        entry.is_object () && value != entry.end ()) {
            values.push_back (&*value);
        }
    }
    return values;
}

/** What one stored example is to the media object it would be written into. */
enum class ExampleDisposition : std::uint8_t {
    Write,
    AlreadyDeclared,
    SampledAtImport
};

/**
 * Whether this example is news to the document.
 *
 * A skeleton always writes: there is no document to be second to. A bound
 * export answers three ways, and the two that are not `Write` are why an
 * unedited spec-origin collection now exports the document it came from.
 */
ExampleDisposition disposition_of (const ExportExample& example,
const Json& value,
const Json* media,
ExportDirection direction) {
    if (direction == ExportDirection::Skeleton) {
        return ExampleDisposition::Write;
    }
    const std::vector<const Json*> declared = declared_example_values (media);
    const bool documented = std::any_of (declared.begin (), declared.end (),
    [&] (const Json* candidate) { return *candidate == value; });
    if (documented) {
        return ExampleDisposition::AlreadyDeclared;
    }
    // An imported example exists *because* the import read this media object
    // (`openapi_drafts.cpp`, `examples_v3`). One that the document declares no
    // example for is one the import sampled off the schema, and writing that
    // sample back would document a value the API never stated.
    if (declared.empty () && example.from_import) {
        return ExampleDisposition::SampledAtImport;
    }
    return ExampleDisposition::Write;
}

/**
 * The examples of one status that can honestly be written, and the counts for
 * the ones that cannot.
 *
 * A capped body is the first slice of a response, not the response (#659).
 * Written as an `example` it would be indistinguishable from a complete one -
 * and a body whose parse fails falls back to the raw string, so half a document
 * would enter the contract as a quoted fragment. The response still lands, and
 * the count says the body did not. Checked before the media type so a truncated
 * body with no recorded type is counted once, as the loss that actually stopped
 * it. A body whose media type nobody stated has no honest `content` key either -
 * the response still lands (a 204 documents itself) and the count says a body
 * was left out.
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
 * The media object a response already documents for @p content_type, or
 * `nullptr`.
 *
 * A read, deliberately, where the write path uses `child_record`: asking what
 * the document says must not add a `content` key to a response that has none.
 */
const Json* declared_media_of (const Json& response, const std::string& content_type) {
    const auto content = response.find ("content");
    if (content == response.end () || !content->is_object ()) {
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
 * Which of one media type's examples are news to the document, and the counts
 * for the ones that are not.
 *
 * Decided before anything is created, from the media object the document
 * already has (`nullptr` when it has none): a response nobody documented must
 * not gain an empty `content` from having been asked about.
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
 * The `examples` map a write goes into: everything the media object already
 * documents, in the order it documented it.
 *
 * A declared `example` moves in rather than being erased under the map. The two
 * members are mutually exclusive, so a media object that has to answer with a
 * map may not simply drop the one value it had; the key it moves under is the
 * member it came from, which says exactly what it is.
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
 * One media type's examples under a response.
 *
 * One of `example` / `examples`, never both: OpenAPI states they are mutually
 * exclusive. Which one this writes is the document's choice where it has made
 * one - a media object already answering with a map gains an entry and keeps
 * every entry it had, and a single `example` becomes a map only when a second
 * example has to go somewhere, carrying the declared value in rather than
 * dropping it. Erasing an `examples` map to write one `example` is what this
 * used to do, and what took the other examples of a user's own contract with it.
 */
void write_media_examples (Json& media, const MediaWrite& write, ExportNotes& notes, ExportDirection direction) {
    const std::vector<const ExportExample*>& writing = write.examples;
    const std::vector<Json>& values                  = write.values;
    if (direction == ExportDirection::Skeleton && media.find ("schema") == media.end ()) {
        // A bound document already states what its responses look like, and a
        // shape read off one stored body is not an improvement on the
        // contract's own schema.
        media["schema"] = schema_from_example (values.front ());
    }
    if (writing.size () == 1 && !media.contains ("examples")) {
        media["example"] = values.front ();
    } else {
        Json map = examples_map_of (media);
        add_named_examples (map, writing, values);
        media["examples"] = std::move (map);
    }
    notes.examples_written += static_cast<int> (writing.size ());
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
            // A Reference Object admits no siblings: a `content` written beside
            // a `$ref` is ignored by every conformant reader and rejects the
            // document at a validator. The component it names is shared with
            // every operation that references it, too - the same reason a
            // `$ref` parameter is left alone.
            notes.referenced_responses_left += 1;
            continue;
        }
        if (existing == responses.end () || !existing->is_object ()) {
            // A Response Object's `description` is required, so one has to be
            // written for a status the document does not already document. The
            // example's own name is what the user (or the import) called it,
            // which beats a generated line - and an existing description is
            // never replaced.
            responses[status] = Json{ { "description",
            group.front ()->name.empty () ? status + " response" :
                                            group.front ()->name } };
        }
        Json& response = responses[status];

        const std::vector<const ExportExample*> writable =
        writable_examples (group, notes);
        if (writable.empty ()) {
            continue;
        }

        for (const auto& [content_type, media_group] : group_by (
             writable, [] (const ExportExample& e) { return e.content_type; })) {
            const MediaWrite write = select_examples (media_group,
            declared_media_of (response, content_type), notes, direction);
            if (write.examples.empty ()) {
                continue;
            }
            write_media_examples (
            child_record (child_record (response, "content"), content_type),
            write, notes, direction);
        }
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
    return upper (method) + " " + std::string (path);
}

/**
 * The request this operation is, by the identity a bind or an import stamped.
 *
 * `operationId` first and method+path second, the same precedence the sync diff
 * follows: an id is the document's own stable name for an operation and
 * survives a path change, while a path survives a rename of the id.
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

/**
 * The lowered names of the parameters the operation declares, by where they sit.
 *
 * Collected while patching rather than walked twice: the pass that writes a
 * row's value into a declared parameter is the one that knows which rows the
 * document has a home for.
 */
struct DeclaredParameters {
    std::unordered_set<std::string> query;
    std::unordered_set<std::string> header;
};

/**
 * A declared parameter's `example`, from the request row that carries a value
 * for it, and the names the operation declared.
 *
 * A blank row writes nothing - an import creates blank header rows, and a blank
 * one deleting the document's example would lose the contract's own
 * documentation to a row nobody typed in.
 */
DeclaredParameters
patch_parameters (Json& operation, const ExportRequest& entry, ExportNotes& notes) {
    DeclaredParameters declared;
    const auto parameters = operation.find ("parameters");
    if (parameters == operation.end () || !parameters->is_array ()) {
        return declared;
    }
    for (Json& parameter : *parameters) {
        if (!parameter.is_object ()) {
            continue;
        }
        if (!string_member (parameter, "$ref").empty ()) {
            notes.shared_parameters_left += 1;
            continue;
        }
        const std::string name = string_member (parameter, "name");
        if (name.empty ()) {
            continue;
        }
        const std::string location = string_member (parameter, "in");
        const std::string wanted   = vayu::utils::ascii_lower (name);
        const std::vector<ExportKeyValue>* rows = nullptr;
        if (location == "query") {
            rows = &entry.params;
            declared.query.insert (wanted);
        } else if (location == "header") {
            rows = &entry.headers;
            declared.header.insert (wanted);
        } else {
            continue;
        }
        const auto row = std::find_if (
        rows->begin (), rows->end (), [&] (const ExportKeyValue& candidate) {
            return vayu::utils::ascii_lower (candidate.key) == wanted;
        });
        if (row == rows->end () || row->value.empty ()) {
            continue;
        }
        parameter["example"] = row->value;
    }
    return declared;
}

/**
 * Rows carrying a value that the operation declares no parameter for.
 *
 * A value goes into the parameter the document declares; a row somebody added
 * in Vayu would have this export declare a parameter the contract does not
 * have, which is the one thing neither direction does. `Authorization` and
 * `Content-Type` are not counted: OpenAPI states them as `security` and as the
 * request body's media type, so they were never parameters to begin with - the
 * same two the import drops on the way in.
 */
void count_undeclared_rows (const ExportRequest& entry,
const DeclaredParameters& declared,
ExportNotes& notes) {
    const auto count = [&] (const std::vector<ExportKeyValue>& rows,
                       const std::unordered_set<std::string>& names, bool headers) {
        for (const ExportKeyValue& row : rows) {
            if (row.key.empty () || row.value.empty ()) {
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
 * A request body the bound direction has no way to write.
 *
 * It patches parameters and examples: a document's `requestBody` states the
 * schema the endpoint accepts, and a body somebody typed into Vayu is one
 * machine's payload rather than a new contract. The count is what makes the
 * omission visible on the export it happened on, instead of only in the docs.
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
 * A request whose method or path is no longer the operation it is stamped as.
 *
 * The stamp is what finds the operation, so the request's values still land -
 * in the operation the document declares, under the method and path *it*
 * declares. Moving or renaming an operation is an edit to the contract, and
 * this export makes none; the count says so per export rather than leaving the
 * user to diff the file. A URL that states no path at all is not compared:
 * there is nothing to compare it with.
 */
void count_edited_identity (const ExportRequest& entry, ExportNotes& notes) {
    const auto& identity = entry.spec_operation;
    if (!identity) {
        return;
    }
    if (!vayu::utils::ascii_lower_equal (entry.method, identity->method)) {
        notes.operations_edited += 1;
        return;
    }
    const std::optional<std::string> shape = request_path_shape (entry.url);
    if (shape && *shape != spec_path_shape (identity->path)) {
        notes.operations_edited += 1;
    }
}

void patch_operation (Json& operation, const ExportRequest& entry, ExportNotes& notes) {
    const DeclaredParameters declared = patch_parameters (operation, entry, notes);
    count_undeclared_rows (entry, declared, notes);
    count_unwritten_body (entry, notes);
    count_edited_identity (entry, notes);
    if (entry.examples.empty ()) {
        return;
    }
    write_response_examples (child_record (operation, "responses"),
    entry.examples, notes, ExportDirection::Bound);
}

/**
 * The dialect the stored document declares.
 *
 * The dialect is never changed: a 3.0 document exports as 3.0, a 2.0 document as
 * 2.0. For 2.0 the presence pass still runs, but nothing is written into an
 * operation - parameters and examples are a different vocabulary there, and half
 * a translation is a file that is neither.
 *
 * @return why there is nothing to patch, or nothing.
 */
std::optional<std::string> read_dialect (const Json& document, Dialect& dialect) {
    if (const std::string version = string_member (document, "openapi");
    !version.empty ()) {
        dialect = { "OpenAPI " + version, true };
    } else if (const std::string legacy = string_member (document, "swagger");
    !legacy.empty ()) {
        // The dialect is never changed: a 3.0 document exports as 3.0, a 2.0
        // document as 2.0. For 2.0 the presence pass still runs, but nothing is
        // written into an operation - parameters and examples are a different
        // vocabulary there, and half a translation is a file that is neither.
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

/** Every operation on one path item, patched or removed. */
void patch_path_item (Assembly& assembly,
const std::vector<ExportRequest>& requests,
const Dialect& dialect,
const std::string& path,
const std::unordered_map<std::string, size_t>& by_operation_id,
const std::unordered_map<std::string, size_t>& by_method_path,
std::unordered_set<size_t>& claimed,
Json& path_item) {
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
        if (dialect.writable) {
            patch_operation (*operation, requests[*found], assembly.notes);
        }
    }
}

/**
 * Every operation the document declares, patched or removed.
 *
 * A path left with no operations goes with them. This is what makes a re-import
 * of the exported document produce the collection it came from.
 */
void patch_document_paths (Assembly& assembly,
const std::vector<ExportRequest>& requests,
const Dialect& dialect,
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
            patch_path_item (assembly, requests, dialect, entry.key (),
            by_operation_id, by_method_path, claimed, path_item);
            const bool has_operation = std::any_of (PATH_ITEM_METHODS.begin (),
            PATH_ITEM_METHODS.end (), [&] (std::string_view method) {
                return path_item.contains (std::string (method));
            });
            if (!has_operation) {
                // A path left with no operations goes with them. This is what
                // makes a re-import of the exported document produce the
                // collection it came from.
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
 * The stored bytes, patched.
 *
 * Everything Vayu does not model - `info`, `tags`, vendor extensions,
 * `security`, components no operation here references - is carried through
 * untouched, because it is carried through by simply not being visited. That is
 * the whole reason this direction exists: a rebuilt document would be Vayu's
 * opinion of the user's contract, and the parts it has no opinion about would
 * quietly disappear.
 */
Assembly patch_bound_document (const std::string& content,
const std::vector<ExportRequest>& requests) {
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
    assembly.notes = empty_notes ("document", dialect.label);
    assembly.notes.vocabulary_not_written = !dialect.writable;

    std::unordered_map<std::string, size_t> by_operation_id;
    std::unordered_map<std::string, size_t> by_method_path;
    index_requests (requests, by_operation_id, by_method_path);

    std::unordered_set<size_t> claimed;
    /*
     * Paths whose Path Item is itself a `$ref` (legal in 3.0/3.1, and what a
     * bundler emits when it hoists a shared item into `components.pathItems`).
     * Its methods are not readable from here without following the ref and
     * mutating a node other paths may share, so such an item is left exactly as
     * it is - and a request that names one of those paths is reported as
     * carried rather than as missing, which is what it is.
     */
    std::unordered_set<std::string> referenced_paths;

    patch_document_paths (assembly, requests, dialect, by_operation_id,
    by_method_path, claimed, referenced_paths);
    count_unclaimed_requests (requests, claimed, referenced_paths, assembly.notes);

    return assembly;
}

// --- The skeleton direction: a collection that was never a spec -------------

/**
 * A request path with Vayu's tokens written the way OpenAPI writes them:
 * `/pets/{{petId}}` becomes `/pets/{petId}`.
 *
 * Only a segment that is *entirely* one token converts. A token inside a longer
 * segment (`/files/{{name}}.json`) is not a path parameter - OpenAPI has no
 * syntax for part of a segment - so it is left as it stands rather than turned
 * into a template the document cannot mean.
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

/**
 * The `{name}` placeholders of the templated path, as required path parameters.
 *
 * `required: true` is not an inference: OpenAPI states that a path parameter is
 * always required, so this is the format's own rule rather than a claim about
 * this endpoint. The `string` schema is the same kind of minimum - a parameter
 * object must carry a schema, and a URL segment is text until something says
 * otherwise.
 */
void append_path_parameters (const std::string& templated, Json& parameters) {
    // The renderer's `/\{([^{}]+)\}/g`, read left to right: a `{` starts a name
    // over, so `{a{b}` declares `b` rather than nothing.
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
            parameters.push_back (Json{
            { "name", templated.substr (open + 1, index - open - 1) }, { "in", "path" },
            { "required", true }, { "schema", Json{ { "type", "string" } } } });
        }
        open = std::string::npos;
    }
}

/**
 * One Params or Headers row as a parameter.
 *
 * A disabled row is still declared - which is why `enabled` is not among the
 * fields this reads: the endpoint accepts the parameter either way, and the
 * toggle says what this request sends, not what the API takes. For the same
 * reason `required` is never written - a user enabling a row is not the API
 * demanding it.
 */
Json parameter_object (const ExportKeyValue& row, std::string_view location) {
    Json parameter{ { "name", row.key }, { "in", std::string (location) } };
    if (!row.description.empty ()) {
        parameter["description"] = row.description;
    }
    parameter["schema"] = Json{ { "type", "string" } };
    if (!row.value.empty ()) {
        parameter["example"] = row.value;
    }
    return parameter;
}

Json media_type_body (std::string_view content_type, const Json& value) {
    Json media{ { "schema", schema_from_example (value) }, { "example", value } };
    return Json{ { "content", Json{ { std::string (content_type), std::move (media) } } } };
}

/**
 * A request body as a `requestBody`, or nothing when the request states none.
 *
 * Nothing is inferred about the endpoint here either: the schema is read off
 * the body that is actually stored, and a mode whose stored text is not the
 * body the endpoint receives writes nothing at all.
 *
 * Every `Json` answer leaves through `std::make_optional`: copy-initializing an
 * `optional<Json>` from a `Json` puts nlohmann's `operator ValueType()` up
 * against `optional`'s converting constructor, which GCC reports as
 * -Wconversion. Direct-initializing considers the constructor alone.
 */
std::optional<Json> request_body_object (const ExportBody& body) {
    const std::string_view content = trim (body.content);
    if (body.mode == "json" || body.mode == "jsonrpc") {
        if (content.empty ()) {
            return std::nullopt;
        }
        return std::make_optional (
        media_type_body ("application/json", example_value (body.content)));
    }
    if (body.mode == "xml") {
        // The text as it stands, never parsed: an XML body is not JSON, so the
        // value under `example` is the document itself.
        if (content.empty ()) {
            return std::nullopt;
        }
        return std::make_optional (media_type_body ("application/xml", body.content));
    }
    if (body.mode == "text") {
        if (content.empty ()) {
            return std::nullopt;
        }
        return std::make_optional (media_type_body ("text/plain", body.content));
    }
    if (body.mode == "form-data" || body.mode == "x-www-form-urlencoded") {
        Json properties = Json::object ();
        for (const std::string& field : body.field_keys) {
            if (!field.empty ()) {
                properties[field] = Json{ { "type", "string" } };
            }
        }
        if (properties.empty ()) {
            return std::nullopt;
        }
        const std::string content_type = body.mode == "form-data" ?
        "multipart/form-data" :
        "application/x-www-form-urlencoded";
        // The field names are declared by the request itself, so this schema
        // states what the collection holds rather than a shape read off one
        // sample - it carries no derivation note.
        Json schema{ { "type", "object" }, { "properties", std::move (properties) } };
        return std::make_optional (Json{ { "content",
        Json{ { content_type, Json{ { "schema", std::move (schema) } } } } } });
    }
    // `graphql` and `none`. GraphQL over HTTP posts a JSON envelope, but the
    // stored body is the query text alone - Vayu composes the envelope at send
    // time. Writing the query as though it were the body would describe a
    // request the endpoint never receives, so this is left out and the
    // operation keeps its path, parameters and responses.
    return std::nullopt;
}

Json operation_object (const ExportRequest& entry, const std::string& templated, ExportNotes& notes) {
    Json operation = Json::object ();
    if (!entry.name.empty ()) {
        operation["summary"] = entry.name;
    }
    if (!entry.description.empty ()) {
        operation["description"] = entry.description;
    }

    Json parameters = Json::array ();
    append_path_parameters (templated, parameters);
    for (const ExportKeyValue& row : entry.params) {
        if (!row.key.empty ()) {
            parameters.push_back (parameter_object (row, "query"));
        }
    }
    for (const ExportKeyValue& row : entry.headers) {
        const std::string key = vayu::utils::ascii_lower (row.key);
        if (row.key.empty () ||
        std::find (NON_PARAMETER_HEADERS.begin (), NON_PARAMETER_HEADERS.end (),
        key) != NON_PARAMETER_HEADERS.end ()) {
            continue;
        }
        parameters.push_back (parameter_object (row, "header"));
    }
    if (!parameters.empty ()) {
        operation["parameters"] = std::move (parameters);
    }

    if (const auto body = request_body_object (entry.body)) {
        operation["requestBody"] = *body;
    }

    if (!entry.examples.empty ()) {
        // The skeleton direction, unlike the bound one: there is no declared
        // schema here to defer to, and a shape read off the example -
        // saying so in its own description - is the most a skeleton may claim.
        // An operation with no stored example documents no response at all,
        // which is legal in 3.1 and honest: an invented `200 OK` would be the
        // one claim this export is most likely to be believed about.
        Json responses = Json::object ();
        write_response_examples (responses, entry.examples, notes, ExportDirection::Skeleton);
        operation["responses"] = std::move (responses);
    }
    return operation;
}

Assembly skeleton_document (const ExportCollection& collection,
const std::vector<ExportRequest>& requests) {
    Assembly assembly;
    assembly.notes =
    empty_notes ("skeleton", "OpenAPI " + std::string (SKELETON_VERSION));

    Json paths = Json::object ();
    std::vector<std::string> servers;
    std::unordered_set<std::string> claimed;

    for (const ExportRequest& entry : requests) {
        const RequestUrlParts parts = split_request_url (entry.url);
        if (!parts.path) {
            assembly.notes.requests_without_path += 1;
            continue;
        }
        const std::string templated = path_template (*parts.path);
        const std::string method    = vayu::utils::ascii_lower (entry.method);
        if (!claimed.insert (std::format ("{} {}", method, templated)).second) {
            // Two requests on the same method and path are one operation in a
            // document, and the second would silently replace the first.
            assembly.notes.duplicate_operations += 1;
            continue;
        }
        if (parts.origin &&
        std::find (servers.begin (), servers.end (), *parts.origin) == servers.end ()) {
            servers.push_back (*parts.origin);
        }

        Json& item   = child_record (paths, templated);
        item[method] = operation_object (entry, templated, assembly.notes);
        assembly.notes.requests_exported += 1;
    }

    Json info{ { "title", collection.name.empty () ? "Untitled API" : collection.name },
        { "version", std::string (PLACEHOLDER_VERSION) } };
    if (!collection.description.empty ()) {
        info["description"] = collection.description;
    }

    assembly.document = Json{ { "openapi", std::string (SKELETON_VERSION) },
        { "info", std::move (info) } };
    if (!servers.empty ()) {
        Json entries = Json::array ();
        for (const std::string& url : servers) {
            entries.push_back (Json{ { "url", url } });
        }
        assembly.document["servers"] = std::move (entries);
    }
    assembly.document["paths"] = std::move (paths);
    return assembly;
}

// --- Serialization ----------------------------------------------------------

std::string serialize (const Json& document, ExportFormat format) {
    if (format == ExportFormat::Yaml) {
        return emit_yaml (document);
    }
    // `error_handler_t::replace` for the same reason the YAML writer carries
    // it: a stored example body is bytes off somebody's server, and one invalid
    // sequence in it must not cost the user the whole export.
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
ExportFormat format) {
    Assembly assembly = spec_content ? patch_bound_document (*spec_content, requests) :
                                       skeleton_document (collection, requests);

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
        { "vocabularyNotWritten", notes.vocabulary_not_written } };
}

} // namespace vayu::core
