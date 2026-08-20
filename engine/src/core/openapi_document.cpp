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

/// Raised by everything below, caught once in `read_document`. Its message is
/// the sentence a caller reads, so every throw site writes one.
class ReadFailure : public std::runtime_error {
    public:
    explicit ReadFailure (const std::string& message) : std::runtime_error (message) {
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
    return !text.empty () && std::all_of (text.begin (), text.end (), [] (unsigned char c) {
        return std::isdigit (c) != 0;
    });
}

/**
 * One *plain* (unquoted) YAML scalar, typed by js-yaml's core schema.
 *
 * Typed here rather than taken from the library because a YAML library's own
 * opinion is what would drift from the importer's: yaml-cpp, measured against
 * this corpus, reports the quoted string `"2.0"` - the very key Swagger 2.0
 * detection turns on - as the number 2.0.
 */
nlohmann::ordered_json plain_scalar (const std::string& text) {
    if (text.empty () || text == "~" || text == "null" || text == "Null" || text == "NULL") {
        return nullptr;
    }
    if (text == "true" || text == "True" || text == "TRUE") {
        return true;
    }
    if (text == "false" || text == "False" || text == "FALSE") {
        return false;
    }
    // JSON has no infinity or NaN, and `JSON.stringify` writes both as null -
    // so does the renderer when it hands one of these to the engine.
    if (text == ".inf" || text == ".Inf" || text == ".INF" || text == "+.inf" ||
    text == "-.inf" || text == "-.Inf" || text == "-.INF" || text == ".nan" ||
    text == ".NaN" || text == ".NAN") {
        return nullptr;
    }

    const bool negative     = text[0] == '-';
    const bool signed_token = negative || text[0] == '+';
    const std::string_view digits (text.data () + (signed_token ? 1 : 0),
    text.size () - (signed_token ? 1 : 0));
    if (digits.empty ()) {
        return text;
    }

    int base = 0;
    if (is_decimal_digits (digits)) {
        base = 10;
    } else if (digits.size () > 2 && digits[0] == '0' &&
    (digits[1] == 'x' || digits[1] == 'o' || digits[1] == 'b')) {
        base = digits[1] == 'x' ? 16 : (digits[1] == 'o' ? 8 : 2);
    }
    if (base != 0) {
        const std::string body { base == 10 ? digits : digits.substr (2) };
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
        return node.is_val_quoted () ? nlohmann::ordered_json (value) : plain_scalar (value);
    }

    private:
    const ryml::Tree& tree_;
    size_t remaining_nodes_;
    /// Anchor name -> the node that declared it, newest declaration winning, as
    /// YAML resolves a name that is anchored twice.
    std::unordered_map<std::string, ryml::id_type> anchors_;

    void spend () {
        if (remaining_nodes_ == 0) {
            throw ReadFailure ("document expands to more nodes than its size allows - "
                               "an alias or a merge key resolves to far more than it is written as");
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

/// The node budget for @p text - see `read_document`'s contract.
size_t node_budget_for (size_t bytes) {
    if (bytes >= limits::MAX_READ_NODES - limits::READ_NODES_FLOOR) {
        return limits::MAX_READ_NODES;
    }
    return bytes + limits::READ_NODES_FLOOR;
}

/// The seven methods Vayu executes, in the order the import parsers walk them,
/// which is therefore the order the index writes rows in. `trace` is not one:
/// no request can carry an identity Vayu has no verb for.
constexpr std::array<const char*, 7> HTTP_METHODS = { "get", "post", "put", "patch", "delete",
    "head", "options" };

const nlohmann::ordered_json* find_object (const nlohmann::ordered_json& node, const char* key) {
    if (!node.is_object ()) {
        return nullptr;
    }
    const auto found = node.find (key);
    if (found == node.end () || !found->is_object ()) {
        return nullptr;
    }
    return &(*found);
}

std::string upper (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    return value;
}

/// Whether the document claims to be one of the two formats Vayu imports.
/// Anything else declares no operations - it may be a perfectly good file that
/// simply is not a contract, which is `NotASpecError` on the renderer side.
bool is_openapi (const nlohmann::ordered_json& document) {
    if (!document.is_object ()) {
        return false;
    }
    if (const auto version = document.find ("openapi");
        version != document.end () && version->is_string ()) {
        return version->get<std::string> ().rfind ("3.", 0) == 0;
    }
    const auto swagger = document.find ("swagger");
    if (swagger == document.end ()) {
        return false;
    }
    // `2.0` unquoted is a number in YAML and in JSON alike, and generated
    // documents write it both ways - the renderer's detector accepts both.
    return (swagger->is_string () && swagger->get<std::string> () == "2.0") ||
    (swagger->is_number () && swagger->get<double> () == 2.0);
}

/**
 * A JSON Pointer into the document, for the one `$ref` hop a path item may be.
 *
 * In-document only, exactly as `createRefResolver` is: a ref naming another
 * file has no `#/` to strip, so every segment names a key no document has and
 * the walk lands on nothing. External refs are inlined before a document is
 * stored (the renderer's ref bundler), and one still external by now is one the
 * user has already been told about.
 */
const nlohmann::ordered_json*
resolve_ref (const nlohmann::ordered_json& document, const std::string& ref) {
    std::string_view pointer (ref);
    if (pointer.rfind ("#/", 0) == 0) {
        pointer.remove_prefix (2);
    } else if (pointer == "#") {
        return &document;
    }
    const nlohmann::ordered_json* node = &document;
    size_t start                       = 0;
    while (start <= pointer.size ()) {
        const size_t slash = pointer.find ('/', start);
        std::string segment (pointer.substr (start,
        slash == std::string_view::npos ? std::string_view::npos : slash - start));
        // JSON Pointer's two escapes, `~1` before `~0` so an escaped tilde in a
        // path key does not turn into a slash.
        for (size_t at = segment.find ("~1"); at != std::string::npos; at = segment.find ("~1", at)) {
            segment.replace (at, 2, "/");
            at += 1;
        }
        for (size_t at = segment.find ("~0"); at != std::string::npos; at = segment.find ("~0", at)) {
            segment.replace (at, 2, "~");
            at += 1;
        }
        if (!node->is_object ()) {
            return nullptr;
        }
        const auto found = node->find (segment);
        if (found == node->end ()) {
            return nullptr;
        }
        node = &(*found);
        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }
    return node;
}

/// A Path Item Object that is itself `{"$ref": ...}`, resolved one hop - the
/// shape a bundler emits when it hoists a shared path item into
/// `components.pathItems`. `nullptr` when there is nothing to read methods off,
/// which drops the path rather than looping over a non-object.
const nlohmann::ordered_json*
resolve_path_item (const nlohmann::ordered_json& document, const nlohmann::ordered_json& item) {
    if (!item.is_object ()) {
        return nullptr;
    }
    const auto ref = item.find ("$ref");
    if (ref == item.end () || !ref->is_string ()) {
        return &item;
    }
    const nlohmann::ordered_json* resolved = resolve_ref (document, ref->get<std::string> ());
    return resolved != nullptr && resolved->is_object () ? resolved : nullptr;
}

/// The status patterns an operation's `responses` map declares, verbatim and in
/// document order. A `$ref`-ed response object still writes its status *key*
/// here, so nothing needs resolving to read them.
std::vector<std::string> declared_responses_of (const nlohmann::ordered_json& operation) {
    std::vector<std::string> patterns;
    const nlohmann::ordered_json* responses = find_object (operation, "responses");
    if (responses == nullptr) {
        return patterns;
    }
    for (auto entry = responses->begin (); entry != responses->end (); ++entry) {
        if (!entry.key ().empty ()) {
            patterns.push_back (entry.key ());
        }
    }
    return patterns;
}

} // namespace

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
        result.root  = nullptr;
        result.error = std::string ("could not be read as JSON or YAML: ") + e.what ();
    }
    return result;
}

std::vector<DeclaredOperation> declared_operations_of (const nlohmann::ordered_json& document) {
    std::vector<DeclaredOperation> declared;
    if (!is_openapi (document)) {
        return declared;
    }
    const nlohmann::ordered_json* paths = find_object (document, "paths");
    if (paths == nullptr) {
        return declared;
    }

    /// Every `operationId` already stamped, so a repeated one is kept on its
    /// first declaration only (issue #715).
    std::unordered_map<std::string, bool> claimed_ids;

    for (auto entry = paths->begin (); entry != paths->end (); ++entry) {
        const std::string& path = entry.key ();
        const nlohmann::ordered_json* item = resolve_path_item (document, entry.value ());
        if (item == nullptr) {
            continue;
        }
        for (const char* method : HTTP_METHODS) {
            const nlohmann::ordered_json* operation = find_object (*item, method);
            if (operation == nullptr) {
                continue;
            }
            if (path.empty () || path[0] != '/') {
                // A `paths` key that is not a path: the request an import builds
                // for it carries no identity either, so neither does this index.
                continue;
            }
            DeclaredOperation row;
            row.method = upper (method);
            row.path   = path;
            if (const auto id = operation->find ("operationId");
                id != operation->end () && id->is_string () && !id->get<std::string> ().empty ()) {
                const std::string operation_id = id->get<std::string> ();
                if (claimed_ids.emplace (operation_id, true).second) {
                    row.operation_id = operation_id;
                }
            }
            row.responses = declared_responses_of (*operation);
            declared.push_back (std::move (row));
        }
    }
    return declared;
}

OperationsIndex derive_operations_index (const std::string& text) {
    OperationsIndex index;
    const DocumentRead read = read_document (text);
    if (!read.ok ()) {
        index.error = "Invalid 'content': " + read.error;
        return index;
    }

    const std::vector<DeclaredOperation> declared = declared_operations_of (read.root);
    if (declared.empty ()) {
        return index; // no index, which is not the same as an empty contract
    }
    if (declared.size () > limits::MAX_OPERATIONS) {
        index.error = "Spec declares " + std::to_string (declared.size ()) +
        " operations, over the limit of " + std::to_string (limits::MAX_OPERATIONS);
        return index;
    }

    nlohmann::ordered_json rows = nlohmann::ordered_json::array ();
    for (const DeclaredOperation& operation : declared) {
        nlohmann::ordered_json row;
        if (!operation.operation_id.empty ()) {
            row["operationId"] = operation.operation_id;
        }
        row["method"]    = operation.method;
        row["path"]      = operation.path;
        row["responses"] = operation.responses;
        rows.push_back (std::move (row));
    }
    index.stored = rows.dump ();
    return index;
}

} // namespace vayu::core
