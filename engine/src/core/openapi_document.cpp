/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_document.cpp
 * @brief The engine's one reader of a stored OpenAPI document (issue #853).
 *        See the header for what it promises and why it lives here.
 *
 * This is the only translation unit in the engine that includes a YAML library.
 * Keep it that way: the DOM it produces is what every other reader takes, so a
 * second include is a second opinion about what a document says.
 */

#include "vayu/core/openapi_document.hpp"

#include "openapi_walk.hpp"

#include "vayu/core/constants.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <ryml/ryml.hpp>
#include <ryml/ryml_std.hpp>

namespace vayu::core {

namespace {

namespace limits = vayu::core::constants::spec_document;

// The one walk over a document's operations, and the helpers it is built from,
// live in `openapi_walk.hpp` so `openapi_drafts.cpp` reads the *same* operations
// this file indexes (issue #865).
using walk::find_object;
using walk::lower;
using walk::resolve_single_hop;
using walk::walk_operations;
using walk::WalkedOperation;

/// Raised by everything below, caught once in `read_document`. Its message is
/// the sentence a caller reads, so every throw site writes one.
class ReadFailure : public std::runtime_error {
    public:
    explicit ReadFailure (const std::string& message)
    : std::runtime_error (message) {
    }
};

std::string to_string (ryml::csubstr text) {
    return { text.str, text.len };
}

/// `line N: ` when the library knows where it was, nothing when it does not -
/// `Location` reports `npos` rather than 0 for "no idea".
std::string at_line (const ryml::Location& location) {
    if (location.line == ryml::npos || location.line == 0) {
        return {};
    }
    return "line " + std::to_string (location.line) + ": ";
}

[[noreturn]] void
throw_basic_error (ryml::csubstr message, const ryml::ErrorDataBasic& data, void* /*user*/) {
    throw ReadFailure (at_line (data.location) + to_string (message));
}

[[noreturn]] void
throw_parse_error (ryml::csubstr message, const ryml::ErrorDataParse& data, void* /*user*/) {
    // `ymlloc` is where in the *document* the parser gave up; `cpploc` is where
    // in rapidyaml's own source, which is no use to whoever sent the bytes.
    throw ReadFailure (at_line (data.ymlloc) + to_string (message));
}

[[noreturn]] void
throw_visit_error (ryml::csubstr message, const ryml::ErrorDataVisit& data, void* /*user*/) {
    throw ReadFailure (at_line (data.cpploc) + to_string (message));
}

/**
 * Point rapidyaml's error handlers at an exception.
 *
 * Its default ones call `abort()`, which measured here as a killed process on a
 * document with an unterminated flow sequence - the daemon taken down by an
 * upload. rapidyaml documents an error handler as a function that must not
 * return, and throwing is the mechanism it names first.
 *
 * `set_callbacks` writes global state and says it is not thread-safe, so it is
 * installed exactly once behind a `call_once` and never swapped afterwards;
 * nothing else in the engine parses YAML, so there is no second owner to race
 * with.
 */
void install_yaml_callbacks () {
    static std::once_flag once;
    std::call_once (once, [] {
        ryml::Callbacks callbacks = ryml::get_callbacks ();
        callbacks.set_error_basic (&throw_basic_error);
        callbacks.set_error_parse (&throw_parse_error);
        callbacks.set_error_visit (&throw_visit_error);
        ryml::set_callbacks (callbacks);
    });
}

bool is_decimal_digits (std::string_view text) {
    return !text.empty () &&
    std::all_of (text.begin (), text.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0; });
}

/**
 * One *plain* (unquoted) YAML scalar, typed by js-yaml's core schema.
 *
 * Typed here rather than taken from the library because a YAML library's own
 * opinion is what would drift from the importer's: yaml-cpp, measured against
 * this corpus, reports the quoted string `"2.0"` - the very key Swagger 2.0
 * detection turns on - as the number 2.0.
 */
/**
 * The constants YAML's core schema spells out, or nothing when @p text is not
 * one of them.
 *
 * JSON has no infinity or NaN, and `JSON.stringify` writes both as null - so
 * does the renderer when it hands one of these to the engine.
 */
std::optional<nlohmann::ordered_json> plain_constant (const std::string& text) {
    if (text.empty () || text == "~" || text == "null" || text == "Null" || text == "NULL") {
        return nlohmann::ordered_json (nullptr);
    }
    if (text == "true" || text == "True" || text == "TRUE") {
        return nlohmann::ordered_json (true);
    }
    if (text == "false" || text == "False" || text == "FALSE") {
        return nlohmann::ordered_json (false);
    }
    if (text == ".inf" || text == ".Inf" || text == ".INF" || text == "+.inf" ||
    text == "-.inf" || text == "-.Inf" || text == "-.INF" || text == ".nan" ||
    text == ".NaN" || text == ".NAN") {
        return nlohmann::ordered_json (nullptr);
    }
    return std::nullopt;
}

/** The base @p digits is written in - 10, 16, 8, 2 - or 0 for no integer. */
int integer_base (std::string_view digits) {
    if (is_decimal_digits (digits)) {
        return 10;
    }
    if (digits.size () > 2 && digits[0] == '0') {
        switch (digits[1]) {
        case 'x': return 16;
        case 'o': return 8;
        case 'b': return 2;
        default: return 0;
        }
    }
    return 0;
}

nlohmann::ordered_json plain_scalar (const std::string& text) {
    if (auto constant = plain_constant (text)) {
        return *constant;
    }

    const bool negative     = text[0] == '-';
    const bool signed_token = negative || text[0] == '+';
    const std::string_view digits = std::string_view (text).substr (signed_token ? 1 : 0);
    if (digits.empty ()) {
        return text;
    }

    if (const int base = integer_base (digits); base != 0) {
        const std::string body{ base == 10 ? digits : digits.substr (2) };
        errno                 = 0;
        char* end             = nullptr;
        const long long value = std::strtoll (body.c_str (), &end, base);
        if (errno == 0 && end != nullptr && *end == '\0' && end != body.c_str ()) {
            return negative ? -value : value;
        }
        // A document may write a number no integer type here holds. Its digits
        // are more use to a reader than a saturated value would be.
        return text;
    }

    // A float, but only in the spellings YAML writes: `strtod` also takes
    // "inf", "nan" and hex floats, so a leading digit or dot is required.
    if (digits[0] != '.' && std::isdigit (static_cast<unsigned char> (digits[0])) == 0) {
        return text;
    }
    errno             = 0;
    char* end         = nullptr;
    const double real = std::strtod (text.c_str (), &end);
    if (errno == 0 && end != nullptr && *end == '\0') {
        return real;
    }
    return text;
}

/**
 * The tree walk: rapidyaml nodes to a DOM, expanding aliases as it goes.
 *
 * Aliases are expanded here rather than by `Tree::resolve()` because that call
 * expands them all at once with no budget - it dies of `std::bad_alloc` on a
 * seven-level alias bomb - and because it does not implement merge keys, which
 * js-yaml does and real documents use. Doing it in the walk gives both, under
 * one budget.
 *
 * Anchors are collected during the walk, which is depth-first and therefore
 * document order, so an alias can only see an anchor declared before it - the
 * rule YAML states and js-yaml enforces.
 */
class Converter {
    public:
    Converter (const ryml::Tree& tree, size_t node_budget)
    : tree_ (tree), remaining_nodes_ (node_budget) {
    }

    /**
     * One value position - the root, a mapping's value, or a sequence entry.
     *
     * Every node in the DOM passes through here exactly once per *expansion*,
     * which is what makes the budget mean something: an alias converts what it
     * names again, and pays for it again.
     */
    nlohmann::ordered_json convert_value (ryml::ConstNodeRef node, size_t depth) {
        if (depth > limits::MAX_READ_DEPTH) {
            throw ReadFailure ("document nests deeper than " +
            std::to_string (limits::MAX_READ_DEPTH) + " levels");
        }
        spend ();

        // Registered before the node is walked, so an anchor that contains a
        // reference to itself is caught by the budget rather than read as an
        // unknown name.
        if (node.has_val_anchor ()) {
            anchors_[to_string (node.val_anchor ())] = node.id ();
        }
        if (node.is_val_ref ()) {
            return convert_value (resolve_alias (node.val_ref ()), depth);
        }
        if (node.is_map ()) {
            return convert_map (node, depth);
        }
        if (node.is_seq ()) {
            nlohmann::ordered_json out = nlohmann::ordered_json::array ();
            for (ryml::ConstNodeRef child : node.children ()) {
                out.push_back (convert_value (child, depth + 1));
            }
            return out;
        }
        if (!node.has_val () || node.val_is_null ()) {
            return nullptr;
        }
        const std::string value = to_string (node.val ());
        return node.is_val_quoted () ? nlohmann::ordered_json (value) :
                                       plain_scalar (value);
    }

    private:
    const ryml::Tree& tree_;
    size_t remaining_nodes_;
    /// Anchor name -> the node that declared it, newest declaration winning, as
    /// YAML resolves a name that is anchored twice.
    std::unordered_map<std::string, ryml::id_type> anchors_;

    void spend () {
        if (remaining_nodes_ == 0) {
            throw ReadFailure (
            "document expands to more nodes than its size allows - "
            "an alias or a merge key resolves to far more than it is written "
            "as");
        }
        --remaining_nodes_;
    }

    /// The node an alias names, or a failure naming the alias - never a hole,
    /// which would read downstream as "the document declared nothing here".
    ryml::ConstNodeRef resolve_alias (ryml::csubstr name) {
        const auto found = anchors_.find (to_string (name));
        if (found == anchors_.end ()) {
            throw ReadFailure ("unidentified alias \"" + to_string (name) + "\"");
        }
        return tree_.cref (found->second);
    }

    /// A mapping key: an alias may stand in for one, and every key becomes text
    /// - `responses: {200: ...}` declares the pattern `"200"`, which is what
    /// both the document and a JavaScript object mean by it.
    std::string convert_key (ryml::ConstNodeRef child) {
        if (child.has_key_anchor ()) {
            anchors_[to_string (child.key_anchor ())] = child.id ();
        }
        if (child.is_key_ref ()) {
            const ryml::ConstNodeRef anchored = resolve_alias (child.key_ref ());
            if (!anchored.has_val ()) {
                throw ReadFailure ("alias \"" + to_string (child.key_ref ()) +
                "\" is used as a key but names a collection");
            }
            return to_string (anchored.val ());
        }
        return to_string (child.key ());
    }

    nlohmann::ordered_json convert_map (ryml::ConstNodeRef node, size_t depth) {
        nlohmann::ordered_json out = nlohmann::ordered_json::object ();
        /// Keys this mapping got from a `<<`, which an explicit one may still
        /// override - the two kinds of "already there" mean opposite things.
        std::unordered_set<std::string> merged_keys;
        for (ryml::ConstNodeRef child : node.children ()) {
            const std::string key = convert_key (child);
            if (key == "<<") {
                merge_into (out, merged_keys, child, depth);
                continue;
            }
            if (out.contains (key) && merged_keys.erase (key) == 0) {
                // js-yaml refuses this too. A document that declares one key
                // twice declares nothing definite, and choosing a winner here
                // would choose a different one than the importer did. A key the
                // *merge* put there is not that: overriding a default is what
                // writing the key next to `<<` means, whichever side of it the
                // key sits on.
                throw ReadFailure ("duplicated mapping key \"" + key + "\"");
            }
            out[key] = convert_value (child, depth + 1);
        }
        return out;
    }

    /**
     * A merge key (`<<: *base`, or `<<: [*a, *b]`), with js-yaml's precedence:
     * a key the mapping states itself always wins, and among merged sources the
     * earlier one wins. Both are what "these are the defaults" means, and
     * getting either backwards would silently rewrite an operation.
     */
    void merge_into (nlohmann::ordered_json& out,
    std::unordered_set<std::string>& merged_keys,
    ryml::ConstNodeRef child,
    size_t depth) {
        const nlohmann::ordered_json merged = convert_value (child, depth + 1);
        if (merged.is_object ()) {
            merge_object (out, merged_keys, merged);
            return;
        }
        if (merged.is_array ()) {
            for (const auto& source : merged) {
                if (!source.is_object ()) {
                    throw ReadFailure ("a merge key must name a mapping");
                }
                merge_object (out, merged_keys, source);
            }
            return;
        }
        throw ReadFailure ("a merge key must name a mapping");
    }

    static void merge_object (nlohmann::ordered_json& out,
    std::unordered_set<std::string>& merged_keys,
    const nlohmann::ordered_json& source) {
        for (auto entry = source.begin (); entry != source.end (); ++entry) {
            if (!out.contains (entry.key ())) {
                out[entry.key ()] = entry.value ();
                merged_keys.insert (entry.key ());
            }
        }
    }
};

/**
 * The JSON branch's half of the depth promise.
 *
 * The YAML walk enforces `MAX_READ_DEPTH` as it converts; a JSON document is
 * handed to nlohmann whole, whose parser is iterative and so has no depth of
 * its own to run out of - but every reader *below* here recurses, and the schema
 * translation recurses over exactly the subtrees an attacker chooses the shape
 * of. So the same bound is checked once, on the way in, rather than by each
 * reader guessing at its own.
 */
void check_json_depth (const nlohmann::ordered_json& node, size_t depth) {
    if (depth > limits::MAX_READ_DEPTH) {
        throw ReadFailure ("document nests deeper than " +
        std::to_string (limits::MAX_READ_DEPTH) + " levels");
    }
    if (!node.is_structured ()) {
        return;
    }
    for (const auto& child : node) {
        check_json_depth (child, depth + 1);
    }
}

/// The node budget for @p text - see `read_document`'s contract.
size_t node_budget_for (size_t bytes) {
    if (bytes >= limits::MAX_READ_NODES - limits::READ_NODES_FLOOR) {
        return limits::MAX_READ_NODES;
    }
    return bytes + limits::READ_NODES_FLOOR;
}

// --- Writing a DOM back out as YAML (issue #855) -----------------------------

/// Spaces one nesting level indents by. Two, which is what every OpenAPI
/// document in the wild is written with and what js-yaml's `dump` wrote before
/// the export moved here.
constexpr size_t YAML_INDENT = 2;

/**
 * Whether @p text survives being written as a *plain* (unquoted) YAML scalar.
 *
 * The reader's rule, asked rather than restated: a string a plain scalar would
 * retype - `2.0`, `007`, `true`, `~` - has to be quoted, and `plain_scalar` is
 * the one place that knows which those are. The rest is YAML's own syntax,
 * where a plain scalar cannot start with an indicator, carry `: ` or ` #`, hold
 * a control character, or keep surrounding space.
 */
bool is_plain_safe (const std::string& text) {
    if (text.empty () || !plain_scalar (text).is_string ()) {
        return false;
    }
    const auto is_space = [] (char c) {
        return std::isspace (static_cast<unsigned char> (c)) != 0;
    };
    if (is_space (text.front ()) || is_space (text.back ())) {
        return false;
    }
    constexpr std::string_view INDICATORS = "-?:,[]{}#&*!|>'\"%@`";
    if (INDICATORS.find (text.front ()) != std::string_view::npos) {
        return false;
    }
    for (size_t i = 0; i < text.size (); ++i) {
        const auto c = static_cast<unsigned char> (text[i]);
        if (c < 0x20 || c == 0x7f) {
            return false;
        }
        if (c == ':' && (i + 1 == text.size () || text[i + 1] == ' ')) {
            return false;
        }
        if (c == '#' && i > 0 && text[i - 1] == ' ') {
            return false;
        }
    }
    return true;
}

/**
 * One scalar as YAML writes it.
 *
 * The quoted form is nlohmann's JSON string, because YAML's double-quoted style
 * takes JSON's escapes unchanged - one escaping table, already right, rather
 * than a second one here. `error_handler_t::replace` is what keeps a stored
 * example body that is not valid UTF-8 from throwing in the middle of an
 * export: the bytes came off somebody's server, and refusing the whole document
 * over one of them would be the wrong answer.
 */
std::string scalar_text (const nlohmann::ordered_json& value) {
    const auto dump = [] (const nlohmann::ordered_json& node) {
        return node.dump (-1, ' ', false, nlohmann::ordered_json::error_handler_t::replace);
    };
    if (!value.is_string ()) {
        return dump (value);
    }
    const auto text = value.get<std::string> ();
    return is_plain_safe (text) ? text : dump (value);
}

/// The one-line spelling of a leaf: an empty container as its brackets, a
/// scalar as `scalar_text`.
std::string leaf_text (const nlohmann::ordered_json& value) {
    if (value.is_object ()) {
        return "{}";
    }
    if (value.is_array ()) {
        return "[]";
    }
    return scalar_text (value);
}

void emit_map (const nlohmann::ordered_json& node, size_t indent, std::string& out);
void emit_seq (const nlohmann::ordered_json& node, size_t indent, std::string& out);

/// A value written after the `key:` or `-` that already stands on this line: on
/// the same line when it is a scalar or an empty container, indented beneath it
/// when it has members of its own.
void emit_after_marker (const nlohmann::ordered_json& value, size_t indent, std::string& out) {
    if (value.is_object () && !value.empty ()) {
        out += '\n';
        emit_map (value, indent + YAML_INDENT, out);
        return;
    }
    if (value.is_array () && !value.empty ()) {
        out += '\n';
        emit_seq (value, indent + YAML_INDENT, out);
        return;
    }
    out += ' ';
    out += leaf_text (value);
    out += '\n';
}

void emit_map (const nlohmann::ordered_json& node, size_t indent, std::string& out) {
    for (auto entry = node.begin (); entry != node.end (); ++entry) {
        out.append (indent, ' ');
        // A key is quoted by the same rule a value is: `200:` reads back as the
        // integer 200, and a `responses` map keyed by numbers is not the one the
        // document declared.
        out += scalar_text (nlohmann::ordered_json (entry.key ()));
        out += ':';
        emit_after_marker (entry.value (), indent, out);
    }
}

void emit_seq (const nlohmann::ordered_json& node, size_t indent, std::string& out) {
    for (const auto& item : node) {
        if ((item.is_object () || item.is_array ()) && !item.empty ()) {
            // The compact form - `- name: petId` rather than a bare `-` and the
            // mapping below it. The nested block is rendered one level in and
            // its first line's indent is exactly the width of the `- ` that
            // replaces it, so the two always line up.
            std::string nested;
            if (item.is_object ()) {
                emit_map (item, indent + YAML_INDENT, nested);
            } else {
                emit_seq (item, indent + YAML_INDENT, nested);
            }
            nested.replace (0, indent + YAML_INDENT, std::string (indent, ' ') + "- ");
            out += nested;
            continue;
        }
        out.append (indent, ' ');
        out += "- ";
        out += leaf_text (item);
        out += '\n';
    }
}

/// Where #649's bundler inlines the external files a document referenced.
constexpr const char* BUNDLED_KEY = "x-vayu-bundled";

/**
 * Keys OpenAPI adds to its schema language that a JSON Schema validator has
 * never heard of. Dropped rather than passed through: each one is either
 * documentation (`example`, `externalDocs`, `xml`) or a serialization concern
 * (`discriminator`), and none of them constrains a body.
 *
 * `nullable` is deliberately absent - it *does* constrain a body, so it is
 * translated rather than dropped.
 */
constexpr std::array<std::string_view, 4> OPENAPI_ONLY_KEYS = { "discriminator",
    "xml", "externalDocs", "example" };

/**
 * Where a keyword's value is itself a schema, or a list of them - one branch,
 * because translating a list is translating each entry of it and the walk below
 * already does that for any array it is handed.
 */
constexpr std::array<std::string_view, 15> SUBSCHEMA_KEYS = { "not", "if",
    "then", "else", "contains", "additionalProperties", "propertyNames",
    "additionalItems", "unevaluatedItems", "unevaluatedProperties", "items",
    "allOf", "anyOf", "oneOf", "prefixItems" };

/// Where a keyword holds a map of subschemas keyed by *data* names - the values
/// are schemas, the keys are a body's field names and mean nothing here.
constexpr std::array<std::string_view, 5> SUBSCHEMA_MAP_KEYS = { "properties",
    "patternProperties", "definitions", "$defs", "dependentSchemas" };

template <size_t N>
bool holds (const std::array<std::string_view, N>& keys, const std::string& key) {
    return std::find (keys.begin (), keys.end (), key) != keys.end ();
}

/**
 * Translate one schema - and everything below it - out of OpenAPI's dialect and
 * into JSON Schema.
 *
 * Recursion is over the *document's* structure, which is finite and bounded by
 * `MAX_READ_DEPTH`: a `$ref` is copied as-is rather than followed, so a
 * recursive schema terminates here for the same reason it terminates in storage.
 */
nlohmann::ordered_json to_json_schema (const nlohmann::ordered_json& schema);

/**
 * `exclusiveMinimum` / `exclusiveMaximum`, which changed meaning between drafts.
 *
 * draft-04 (and so OpenAPI 3.0) spells these as booleans modifying
 * `minimum`/`maximum`; draft-07 spells them as the bound itself. A boolean left
 * as-is is not a stricter check, it is a different one. `exclusiveMinimum: true`
 * with no bound leaves `minimum` doing the non-exclusive job the document did
 * not ask for - but dropping `minimum` too would lose a constraint the document
 * *did* state, so keeping it is the conservative half of the two.
 */
void translate_exclusive_bound (const nlohmann::ordered_json& schema,
const std::string& key,
const nlohmann::ordered_json& value,
nlohmann::ordered_json& out) {
    if (!value.is_boolean ()) {
        out[key] = value;
        return;
    }
    const auto bound = schema.find (key == "exclusiveMinimum" ? "minimum" : "maximum");
    if (value.get<bool> () && bound != schema.end () && bound->is_number ()) {
        out[key] = *bound;
    }
}

/**
 * OpenAPI 3.0's `nullable`, applied once against whatever `type` ended up being
 * - doing it per key would depend on key order.
 */
void apply_nullable (const nlohmann::ordered_json& schema, nlohmann::ordered_json& out) {
    const auto nullable = schema.find ("nullable");
    if (nullable == schema.end () || !nullable->is_boolean () || !nullable->get<bool> ()) {
        return;
    }
    const auto type = out.find ("type");
    if (type == out.end ()) {
        // With no `type` at all, `nullable` constrains nothing: every JSON value
        // was already allowed, null included.
        return;
    }
    if (type->is_string ()) {
        *type = nlohmann::ordered_json::array ({ type->get<std::string> (), "null" });
        return;
    }
    if (type->is_array () &&
    std::none_of (type->begin (), type->end (), [] (const nlohmann::ordered_json& name) {
        return name.is_string () && name.get<std::string> () == "null";
    })) {
        type->push_back ("null");
    }
}

/** One key of a schema object, translated into @p out. */
void translate_schema_key (const nlohmann::ordered_json& schema,
const std::string& key,
const nlohmann::ordered_json& value,
nlohmann::ordered_json& out) {
    if (key == "exclusiveMinimum" || key == "exclusiveMaximum") {
        translate_exclusive_bound (schema, key, value, out);
        return;
    }
    if (holds (SUBSCHEMA_KEYS, key)) {
        out[key] = to_json_schema (value);
        return;
    }
    if (holds (SUBSCHEMA_MAP_KEYS, key)) {
        if (!value.is_object ()) {
            out[key] = value;
            return;
        }
        nlohmann::ordered_json translated = nlohmann::ordered_json::object ();
        for (auto child = value.begin (); child != value.end (); ++child) {
            translated[child.key ()] = to_json_schema (child.value ());
        }
        out[key] = std::move (translated);
        return;
    }
    out[key] = value;
}

nlohmann::ordered_json to_json_schema (const nlohmann::ordered_json& schema) {
    if (schema.is_array ()) {
        nlohmann::ordered_json out = nlohmann::ordered_json::array ();
        for (const auto& entry : schema) {
            out.push_back (to_json_schema (entry));
        }
        return out;
    }
    // `true` / `false` are legal schemas, and any non-object leaf (a `type`
    // string, a `maxLength` number) is carried through untouched.
    if (!schema.is_object ()) {
        return schema;
    }

    nlohmann::ordered_json out = nlohmann::ordered_json::object ();
    for (auto entry = schema.begin (); entry != schema.end (); ++entry) {
        const std::string& key = entry.key ();
        // `nullable` is applied below, once, against whatever `type` ends up
        // being.
        if (holds (OPENAPI_ONLY_KEYS, key) || key == "nullable") {
            continue;
        }
        translate_schema_key (schema, key, entry.value (), out);
    }

    apply_nullable (schema, out);
    return out;
}

/// Each value of a name-keyed schema map, translated. The map itself is not a
/// schema - running the translation over the container would walk no further
/// than the container, which is how a `$ref`-ed 3.0 schema kept its `nullable`
/// and produced a wrong verdict for every null the document permits.
nlohmann::ordered_json map_schemas (const nlohmann::ordered_json& map) {
    nlohmann::ordered_json out = nlohmann::ordered_json::object ();
    for (auto entry = map.begin (); entry != map.end (); ++entry) {
        out[entry.key ()] = to_json_schema (entry.value ());
    }
    return out;
}

/**
 * The subtrees an in-document `$ref` may resolve into, translated once per
 * document so a `$ref`-ed schema is in the same dialect as an inline one.
 *
 * `null` when the document has none, which stores no `refRoots` at all rather
 * than an empty object.
 *
 * The rest of `components` - responses, parameters, examples, headers - is
 * deliberately dropped rather than carried: a schema `$ref` resolves to a
 * schema, so nothing here can point at them, and they are pure weight against
 * the byte cap the index shares with the document.
 */
nlohmann::ordered_json ref_roots_of (const nlohmann::ordered_json& document) {
    nlohmann::ordered_json roots = nlohmann::ordered_json::object ();

    if (const nlohmann::ordered_json* components = find_object (document, "components")) {
        if (const nlohmann::ordered_json* schemas = find_object (*components, "schemas")) {
            nlohmann::ordered_json carried = nlohmann::ordered_json::object ();
            carried["schemas"]             = map_schemas (*schemas);
            roots["components"]            = std::move (carried);
        }
    }
    if (const nlohmann::ordered_json* definitions = find_object (document, "definitions")) {
        roots["definitions"] = map_schemas (*definitions);
    }

    // A bundled file (#649) is a whole document inlined under its slug, and a
    // ref into it keeps that document's own shape - so each is reduced by this
    // same rule. One that carries neither container *is* a schema document (a
    // bare `pet.yaml`), and is translated as one.
    if (const nlohmann::ordered_json* bundled = find_object (document, BUNDLED_KEY)) {
        nlohmann::ordered_json inlined = nlohmann::ordered_json::object ();
        for (auto entry = bundled->begin (); entry != bundled->end (); ++entry) {
            if (!entry.value ().is_object ()) {
                continue;
            }
            if (nlohmann::ordered_json nested = ref_roots_of (entry.value ());
            !nested.is_null ()) {
                inlined[entry.key ()] = std::move (nested);
            } else {
                inlined[entry.key ()] = to_json_schema (entry.value ());
            }
        }
        if (!inlined.empty ()) {
            roots[BUNDLED_KEY] = std::move (inlined);
        }
    }

    return roots.empty () ? nlohmann::ordered_json (nullptr) : roots;
}

/// One `{status, contentType, schema}` row of the index.
nlohmann::ordered_json declared_response (const std::string& status,
std::string content_type,
const nlohmann::ordered_json& schema) {
    nlohmann::ordered_json row;
    row["status"]      = status;
    row["contentType"] = std::move (content_type);
    row["schema"]      = to_json_schema (schema);
    return row;
}

/// A schema position that holds something JSON Schema cannot read - `null`, a
/// string, a number - declares nothing checkable. Skipped like an absent one:
/// storing the row would put a value in the index no validator can use, and
/// refusing the whole document would block an import over one malformed
/// response. Only an object and the two boolean schemas are schemas.
bool is_schema (const nlohmann::ordered_json& node) {
    return node.is_object () || node.is_boolean ();
}

/**
 * An OpenAPI 3.x operation's declared response schemas.
 *
 * Every media type is kept, not just the JSON one: what can be validated is
 * decided at response time by what the server actually sent, and a document
 * declaring both `application/json` and `application/xml` describes two real
 * responses. A media type whose response declares no schema is skipped - there
 * is nothing to check against, and an empty schema would claim everything is
 * valid.
 */
nlohmann::ordered_json response_schemas_v3 (const nlohmann::ordered_json& document,
const nlohmann::ordered_json& operation) {
    nlohmann::ordered_json declared = nlohmann::ordered_json::array ();
    const nlohmann::ordered_json* responses = find_object (operation, "responses");
    if (responses == nullptr) {
        return declared;
    }
    for (auto entry = responses->begin (); entry != responses->end (); ++entry) {
        if (entry.key ().empty ()) {
            continue;
        }
        const nlohmann::ordered_json* response =
        resolve_single_hop (document, entry.value ());
        if (response == nullptr) {
            continue;
        }
        const nlohmann::ordered_json* content = find_object (*response, "content");
        if (content == nullptr) {
            continue;
        }
        for (auto media = content->begin (); media != content->end (); ++media) {
            if (!media.value ().is_object ()) {
                continue;
            }
            const auto schema = media.value ().find ("schema");
            if (schema == media.value ().end () || !is_schema (*schema)) {
                continue;
            }
            declared.push_back (
            declared_response (entry.key (), lower (media.key ()), *schema));
        }
    }
    return declared;
}

/**
 * The media types a Swagger 2.0 operation produces: its own `produces`, the
 * document's when it states none, and JSON when neither does. 2.0 states them
 * once for the whole operation and the schema once per response, so one
 * response declares the same schema for each type it produces.
 */
std::vector<std::string> produced_media_types (const nlohmann::ordered_json& document,
const nlohmann::ordered_json& operation) {
    const nlohmann::ordered_json* produces = nullptr;
    if (const auto own = operation.find ("produces");
    own != operation.end () && own->is_array ()) {
        produces = &(*own);
    } else if (const auto shared = document.find ("produces");
    shared != document.end () && shared->is_array ()) {
        produces = &(*shared);
    }

    std::vector<std::string> types;
    if (produces != nullptr) {
        for (const auto& type : *produces) {
            if (type.is_string () && !type.get<std::string> ().empty ()) {
                types.push_back (lower (type.get<std::string> ()));
            }
        }
    }
    if (types.empty ()) {
        types.emplace_back ("application/json");
    }
    return types;
}

/// A Swagger 2.0 operation's declared response schemas.
nlohmann::ordered_json response_schemas_v2 (const nlohmann::ordered_json& document,
const nlohmann::ordered_json& operation) {
    nlohmann::ordered_json declared = nlohmann::ordered_json::array ();
    const nlohmann::ordered_json* responses = find_object (operation, "responses");
    if (responses == nullptr) {
        return declared;
    }
    const std::vector<std::string> media_types = produced_media_types (document, operation);
    for (auto entry = responses->begin (); entry != responses->end (); ++entry) {
        if (entry.key ().empty ()) {
            continue;
        }
        const nlohmann::ordered_json* response =
        resolve_single_hop (document, entry.value ());
        if (response == nullptr) {
            continue;
        }
        const auto schema = response->find ("schema");
        if (schema == response->end () || !is_schema (*schema)) {
            continue;
        }
        for (const std::string& content_type : media_types) {
            declared.push_back (declared_response (entry.key (), content_type, *schema));
        }
    }
    return declared;
}

} // namespace

std::string emit_yaml (const nlohmann::ordered_json& document) {
    std::string out;
    if (document.is_object () && !document.empty ()) {
        emit_map (document, 0, out);
        return out;
    }
    if (document.is_array () && !document.empty ()) {
        emit_seq (document, 0, out);
        return out;
    }
    out += leaf_text (document);
    out += '\n';
    return out;
}

DocumentRead read_document (const std::string& text) {
    DocumentRead result;
    if (text.empty ()) {
        result.error = "an empty document is not a spec";
        return result;
    }

    // JSON first, YAML second - `parse-raw.ts`'s order, so a JSON document is
    // read by a JSON parser on both sides.
    nlohmann::ordered_json parsed =
    nlohmann::ordered_json::parse (text, /*cb=*/nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_discarded ()) {
        try {
            check_json_depth (parsed, 0);
        } catch (const ReadFailure& failure) {
            result.error = failure.what ();
            return result;
        }
        result.root = std::move (parsed);
        return result;
    }

    install_yaml_callbacks ();
    try {
        const ryml::Tree tree = ryml::parse_in_arena (ryml::to_csubstr (text));
        Converter converter (tree, node_budget_for (text.size ()));
        result.root = converter.convert_value (tree.crootref (), 0);
    } catch (const ReadFailure& failure) {
        result.root  = nullptr;
        result.error = failure.what ();
    } catch (const std::exception& e) {
        // Anything the YAML library throws that is not our own failure - an
        // allocation it could not make, a state we have no sentence for. It is
        // still the document's problem, never the daemon's.
        result.root = nullptr;
        result.error = std::string ("could not be read as JSON or YAML: ") + e.what ();
    }
    return result;
}

std::vector<DeclaredOperation> declared_operations_of (const nlohmann::ordered_json& document) {
    std::vector<DeclaredOperation> declared;
    for (WalkedOperation& walked : walk_operations (document)) {
        if (!walked.identified) {
            continue; // a `paths` key that is not a path declares nothing
        }
        declared.push_back (std::move (walked.identity));
    }
    return declared;
}

DocumentDescription describe_document (const nlohmann::ordered_json& document) {
    DocumentDescription described;
    switch (walk::spec_dialect (document)) {
    case walk::Dialect::V3: described.format = "OpenAPI 3.0"; break;
    case walk::Dialect::V2: described.format = "OpenAPI 2.0 (Swagger)"; break;
    case walk::Dialect::None:
        // Readable, and not a contract. Said as an empty format rather than as a
        // failure, because the caller asked what these bytes are and "not an
        // OpenAPI document" is an answer to that question.
        return described;
    }

    if (const auto info = document.find ("info");
    info != document.end () && info->is_object ()) {
        if (const auto title = info->find ("title");
        title != info->end () && title->is_string ()) {
            described.title = title->get<std::string> ();
        }
    }
    described.operations = declared_operations_of (document);
    return described;
}

nlohmann::ordered_json response_schemas_of (const nlohmann::ordered_json& document) {
    // Which dialect to read is the walk's question already answered, through the
    // same detector: a document it refuses walks no operations at all, so the
    // arm chosen for a `None` document is never reached.
    const bool v3 = walk::spec_dialect (document) == walk::Dialect::V3;

    nlohmann::ordered_json rows = nlohmann::ordered_json::array ();
    for (const WalkedOperation& walked : walk_operations (document)) {
        if (!walked.identified) {
            continue; // no identity to file its schemas under
        }
        nlohmann::ordered_json responses = v3 ?
        response_schemas_v3 (document, *walked.node) :
        response_schemas_v2 (document, *walked.node);
        if (responses.empty ()) {
            continue;
        }
        nlohmann::ordered_json row;
        if (!walked.identity.operation_id.empty ()) {
            row["operationId"] = walked.identity.operation_id;
        }
        row["method"]    = walked.identity.method;
        row["path"]      = walked.identity.path;
        row["responses"] = std::move (responses);
        rows.push_back (std::move (row));
    }
    if (rows.empty ()) {
        return nullptr;
    }

    nlohmann::ordered_json index = nlohmann::ordered_json::object ();
    if (nlohmann::ordered_json roots = ref_roots_of (document); !roots.is_null ()) {
        index["refRoots"] = std::move (roots);
    }
    index["operations"] = std::move (rows);
    return index;
}

SpecIndexes spec_indexes_of (const nlohmann::ordered_json& document, size_t index_cap) {
    SpecIndexes indexes;
    std::vector<WalkedOperation> walked = walk_operations (document);
    // Only the operations that declare an identity are indexed; the rest are
    // the import's to build a request for (see `WalkedOperation::identified`).
    std::erase_if (
    walked, [] (const WalkedOperation& row) { return !row.identified; });
    if (walked.empty ()) {
        return indexes; // no index, which is not the same as an empty contract
    }
    if (walked.size () > limits::MAX_OPERATIONS) {
        indexes.error = "Spec declares " + std::to_string (walked.size ()) +
        " operations, over the limit of " + std::to_string (limits::MAX_OPERATIONS);
        return indexes;
    }

    nlohmann::ordered_json rows = nlohmann::ordered_json::array ();
    for (const WalkedOperation& operation : walked) {
        nlohmann::ordered_json row;
        if (!operation.identity.operation_id.empty ()) {
            row["operationId"] = operation.identity.operation_id;
        }
        row["method"]    = operation.identity.method;
        row["path"]      = operation.identity.path;
        row["responses"] = operation.identity.responses;
        rows.push_back (std::move (row));
    }
    indexes.operations = rows.dump ();

    const nlohmann::ordered_json schemas = response_schemas_of (document);
    if (schemas.is_null ()) {
        return indexes;
    }
    std::string stored = schemas.dump ();
    if (stored.size () > index_cap) {
        // The document passed its own cap and its schemas did not: a document
        // whose `components` are most of its bytes indexes to nearly its own
        // size again. Named rather than truncated - an index silently cut short
        // reports a body as unchecked with no reason a user can act on.
        indexes.error = "Response schema index is " + std::to_string (stored.size ()) +
        " bytes, over the limit of " + std::to_string (index_cap) +
        " (raise the 'maxSpecDocumentBytes' setting to allow more)";
        return indexes;
    }
    indexes.response_schemas = std::move (stored);
    return indexes;
}

SpecIndexes derive_spec_indexes (const std::string& text, size_t index_cap) {
    const DocumentRead read = read_document (text);
    if (!read.ok ()) {
        SpecIndexes indexes;
        indexes.error = "Invalid 'content': " + read.error;
        return indexes;
    }
    return spec_indexes_of (read.root, index_cap);
}

} // namespace vayu::core
