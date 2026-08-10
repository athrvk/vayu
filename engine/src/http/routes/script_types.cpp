/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/script_types.cpp
 * @brief Generates the TypeScript declarations Monaco's language service needs
 *        from the completion table, so there is no second copy of the surface.
 *
 * `GET /scripting/completions` gives Monaco a flat suggestion list, which is
 * enough for a dropdown and nothing else: no hover text on an existing call, no
 * signature help while typing arguments, no squiggle under `pm.response.staus`.
 * Those come from the TypeScript worker, which wants a `.d.ts`.
 *
 * The obvious way to get one is to hand-write `pm.d.ts` in the app. That would
 * be a second declaration of a surface the engine already owns, and the two
 * would drift the first time a `pm.*` method is added here and not there. So
 * this file *derives* the declarations from `get_script_completions ()`, which
 * stays the single source of truth.
 *
 * That derivation works because a completion entry already carries the type:
 * every function's `detail` is its signature (`pm.environment.get(name:
 * string): string | undefined`) and a field's `detail` is its type (`number`).
 * The rules below are just the reading of those strings, plus the one thing a
 * completion entry cannot express - see `chain vocabulary`.
 */

#include <algorithm>
// <cctype> for isalpha/isalnum and <cstddef> for size_t: libstdc++ pulls both
// in transitively through <string>, MSVC and libc++ do not promise to, and this
// file is built on all three.
#include <cctype>
#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/http/routes.hpp"

namespace vayu::http::routes {

// Defined in scripting.cpp - the one table this file reads.
nlohmann::json get_script_completions ();

namespace {

// monaco.languages.CompletionItemKind values used by the table.
constexpr int KIND_FUNCTION = 1;
constexpr int KIND_SNIPPET  = 28;

// The generated interface names. `VayuExpectTo` exists as a *named* interface
// only because `.to.not` continues the chain it sits in and so has to refer
// back to it; every other chain node is an inline object type.
constexpr const char* CHAIN      = "VayuExpectation";
constexpr const char* CHAIN_TO   = "VayuExpectTo";
constexpr const char* ANY_OBJECT = "{ [key: string]: any }";

/**
 * @brief The chain vocabulary - names whose type is the chain rather than a
 *        terminal assertion.
 *
 * This is the one fact the completion table genuinely cannot carry. A getter
 * that *continues* the chain (`.to.not`, `.and`) and one that *performs* an
 * assertion (`.to.be.true`) are indistinguishable as entries: both are a
 * non-function whose `detail` is its own dotted name. Only the meaning
 * separates them, so the meaning is written here rather than guessed.
 *
 * `script_types_test.cpp` asserts each of these names is still present in the
 * table, so removing or renaming one fails loudly instead of silently degrading
 * that member to `void` and breaking every `.to.not.` completion downstream.
 */
constexpr const char* CHAIN_CONTINUATIONS[] = { "not", "and" };

/**
 * @brief Host globals a browser or Node would have and this sandbox does not.
 *
 * Declared, rather than simply left out, so that using one is an *error the
 * editor can explain* instead of a bare "Cannot find name". That distinction
 * matters because the app has to suppress `Cannot find name` wholesale: a
 * collection-level script part is joined to the request's before the engine
 * runs it, so a name defined there is genuinely undeclared as far as the
 * editor's model can see, and flagging it would be a false positive on correct
 * code. Typing these as `never` keeps the real mistake caught (calling one is
 * "not callable") while that suppression is in force, and the documentation
 * below is what hover shows in place of the error text.
 *
 * `script_types_test.cpp` executes `typeof <name>` in the real script engine
 * for every entry, so the list cannot drift from the sandbox: giving the
 * runtime a `setTimeout` fails the test that says it has none.
 */
struct AbsentGlobal {
    const char* name;
    const char* reason;
};
constexpr AbsentGlobal ABSENT_GLOBALS[] = {
    { "setTimeout",
    "The sandbox is synchronous - a script runs to completion "
    "before the request is sent, so there is no later to defer to." },
    { "setInterval",
    "The sandbox is synchronous and a script has a wall-clock "
    "deadline (scriptTimeout)." },
    { "clearTimeout", "There is no setTimeout to cancel." },
    { "clearInterval", "There is no setInterval to cancel." },
    { "fetch",
    "Scripts cannot make network calls. The request being built is "
    "the only one sent; edit it through pm.request." },
    { "XMLHttpRequest", "Scripts cannot make network calls." },
    { "require",
    "No module system - QuickJS here has no loader, and there is "
    "no filesystem to load from." },
    { "process", "Not Node. There is no process, no argv and no env." },
    { "Buffer", "Not Node. Use btoa/atob, or pm.crypto for hashing." },
    { "URL", "No URL parser in the sandbox. pm.request.url is a plain string." },
    { "URLSearchParams", "No URL parser in the sandbox." },
    { "TextEncoder", "Absent. pm.crypto accepts strings directly." },
    { "TextDecoder", "Absent. pm.crypto accepts strings directly." },
    { "structuredClone", "Absent. Use JSON.parse(JSON.stringify(value))." },
    { "localStorage",
    "No browser storage. Persist through pm.environment or "
    "pm.globals, which outlive the script." },
    { "sessionStorage", "No browser storage. Use pm.variables instead." },
    { "window", "Not a browser." },
    { "document", "Not a browser." },
    { "alert",
    "Not a browser. Use console.log, shown in the response pane's "
    "Console tab." },
};

bool is_chain_continuation (const std::string& name) {
    return std::find (std::begin (CHAIN_CONTINUATIONS),
           std::end (CHAIN_CONTINUATIONS), name) != std::end (CHAIN_CONTINUATIONS);
}

/// A node in the declaration tree built from the dotted labels.
struct TypeNode {
    // Sorted rather than insertion-ordered: the output is a generated file that
    // tests compare against, so it must not depend on table ordering.
    std::map<std::string, TypeNode> children;
    std::string detail;
    std::string documentation;
    int kind    = 0;
    bool listed = false; // false for an interior node the labels only imply
    // Some label reached this node's members through a call - `pm.cookies.jar`
    // is written `pm.cookies.jar().set` one level down. See the `()` stripping
    // in generate_script_typedefs.
    bool called = false;
    // The member may be absent at run time - see split_optional_suffix. Only
    // read for a node that has children; a leaf carries it in its own type.
    bool optional = false;
    // Set only where the table cannot say it: `pm.expect` is the entry point
    // into the chain, and its `detail` documents no return type because the
    // completion popup has nothing useful to show there.
    std::string forced_return;
};

std::vector<std::string> split_dotted (const std::string& label) {
    std::vector<std::string> parts;
    std::string current;
    for (char c : label) {
        if (c == '.') {
            parts.push_back (current);
            current.clear ();
        } else {
            current += c;
        }
    }
    parts.push_back (current);
    return parts;
}

std::string trim (const std::string& s) {
    const auto first = s.find_first_not_of (" \t\n");
    if (first == std::string::npos) {
        return "";
    }
    const auto last = s.find_last_not_of (" \t\n");
    return s.substr (first, last - first + 1);
}

constexpr std::string_view OPTIONAL_SUFFIX = " | undefined";

/**
 * @brief The table's one way of saying "this member may not be there".
 *
 * A `detail` ending in ` | undefined` marks the member optional, with the same
 * spelling for a leaf (`pm.info.iteration` is `number | undefined`) and for a
 * whole surface (`pm.iterationData` is `undefined` outside a data-driven
 * collection run). Only the rendering differs: a leaf keeps the union, and a
 * surface that has members has no union to put it in, so it becomes a `?` on
 * the property name.
 *
 * One reader of the convention rather than two, so `field_type` and
 * `render_member` cannot come to disagree about what the suffix means.
 *
 * @return the detail with the suffix removed, and whether it was there.
 */
std::pair<std::string, bool> split_optional_suffix (const std::string& detail) {
    const std::string base = trim (detail);
    if (base.size () > OPTIONAL_SUFFIX.size () &&
    base.compare (base.size () - OPTIONAL_SUFFIX.size (),
    OPTIONAL_SUFFIX.size (), OPTIONAL_SUFFIX) == 0) {
        return { trim (base.substr (0, base.size () - OPTIONAL_SUFFIX.size ())), true };
    }
    return { base, false };
}

/**
 * @brief Split a parameter list on top-level commas.
 *
 * Depth-aware, because a parameter's own type can contain commas that are not
 * separators - `size(): { body: number, header: number }`, `Record<string,
 * any>`, `(value: any) => boolean`.
 */
std::vector<std::string> split_params (const std::string& params) {
    std::vector<std::string> parts;
    std::string current;
    int depth = 0;
    for (char c : params) {
        if (c == '<' || c == '(' || c == '[' || c == '{') {
            depth++;
        } else if (c == '>' || c == ')' || c == ']' || c == '}') {
            depth--;
        }
        if (c == ',' && depth == 0) {
            parts.push_back (current);
            current.clear ();
        } else {
            current += c;
        }
    }
    if (!trim (current).empty ()) {
        parts.push_back (current);
    }
    return parts;
}

/// Whether a single parameter reads as `name: T`, `name?: T` or `...name: T`.
bool is_typed_param (const std::string& param) {
    const std::string p = trim (param);
    if (p.empty ()) {
        return false;
    }
    size_t i = 0;
    if (p.rfind ("...", 0) == 0) {
        i = 3;
    }
    if (i >= p.size () ||
    (!std::isalpha (static_cast<unsigned char> (p[i])) && p[i] != '_' && p[i] != '$')) {
        return false;
    }
    while (i < p.size () &&
    (std::isalnum (static_cast<unsigned char> (p[i])) || p[i] == '_' || p[i] == '$')) {
        i++;
    }
    if (i < p.size () && p[i] == '?') {
        i++;
    }
    while (i < p.size () && p[i] == ' ') {
        i++;
    }
    return i < p.size () && p[i] == ':';
}

struct Signature {
    bool parsed = false;
    std::string params;
    std::string return_type;
};

/**
 * @brief Where @p name's own parameter list opens in @p detail.
 *
 * The first `(` in a detail is not always the member's. Every jar entry names
 * the call that produced the object before naming the member -
 * `pm.cookies.jar().get(url: string, name: string, ...)` - so reading from the
 * first `(` finds the empty one in `jar()`: an empty parameter list, whose
 * closing paren is immediately followed by `.get`, so the return type is
 * dropped too. Every `pm.cookies.jar().*` member was declared as a
 * no-argument `void`, which is not merely wrong but inverted - the editor said
 * "takes nothing" about a method that requires a URL.
 *
 * So the search is anchored to the member name, and falls back to the first
 * `(` only when the detail does not restate it.
 *
 * @return the index of the opening `(`, or `npos` if there is none.
 */
size_t find_params_open (const std::string& detail, const std::string& name) {
    for (size_t pos = name.empty () ? std::string::npos : detail.find (name);
         pos != std::string::npos; pos = detail.find (name, pos + 1)) {
        const size_t after = pos + name.size ();
        if (after >= detail.size () || detail[after] != '(') {
            continue;
        }
        // `.get(` anchors, `forget(` does not - the name has to be a whole
        // segment, not the tail of a longer one.
        if (pos > 0) {
            const char before = detail[pos - 1];
            if (std::isalnum (static_cast<unsigned char> (before)) ||
            before == '_' || before == '$') {
                continue;
            }
        }
        return after;
    }
    return detail.find ('(');
}

/**
 * @brief Read a function entry's `detail` as a TypeScript signature.
 *
 * Accepts the two shapes the table uses - `name(params): Return` and
 * `name(params)` - and reports an unusable parameter list rather than emitting
 * it. Two entries document an overload in prose that TypeScript cannot parse
 * (`upsert({ key, value }) | (name, value)`); those fall back to `...args:
 * any[]`, which keeps the member callable and its documentation reachable
 * instead of dropping it or emitting a file that does not compile.
 *
 * @param name the member being declared, used to find its own `(`.
 */
Signature parse_signature (const std::string& detail, const std::string& name) {
    Signature sig;
    const auto open = find_params_open (detail, name);
    if (open == std::string::npos) {
        return sig;
    }

    // Match the closing paren of the parameter list, not the first one seen: a
    // parameter's type can be a call signature - `(value: any) => boolean`.
    int depth    = 0;
    size_t close = std::string::npos;
    for (size_t i = open; i < detail.size (); i++) {
        if (detail[i] == '(') {
            depth++;
        } else if (detail[i] == ')') {
            depth--;
            if (depth == 0) {
                close = i;
                break;
            }
        }
    }
    if (close == std::string::npos) {
        return sig;
    }

    sig.parsed                   = true;
    const std::string raw_params = detail.substr (open + 1, close - open - 1);
    bool params_ok               = true;
    for (const auto& part : split_params (raw_params)) {
        if (!is_typed_param (part)) {
            params_ok = false;
            break;
        }
    }
    sig.params = params_ok ? trim (raw_params) : "...args: any[]";

    const auto rest = trim (detail.substr (close + 1));
    if (rest.rfind (":", 0) == 0) {
        sig.return_type = trim (rest.substr (1));
    }
    return sig;
}

/**
 * @brief Whether every `|`-separated alternative is a quoted string literal.
 *
 * A closed set of strings is a type the table can already write and the reader
 * would otherwise dismiss as prose. `pm.info.eventName` is `'prerequest' |
 * 'test'`, and reading that as `void` made the documented
 * `pm.info.eventName === 'prerequest'` an error - a comparison between types
 * with no overlap - on the very first example in its own section.
 */
bool is_string_literal_union (const std::string& base) {
    if (base.empty ()) {
        return false;
    }
    for (size_t start = 0;;) {
        const size_t bar       = base.find ('|', start);
        const std::string part = trim (base.substr (
        start, bar == std::string::npos ? std::string::npos : bar - start));
        const char quote       = part.empty () ? '\0' : part.front ();
        if (part.size () < 2 || (quote != '\'' && quote != '"') || part.back () != quote) {
            return false;
        }
        // An interior quote of the same kind is two literals with prose
        // between them, not one alternative.
        if (part.find (quote, 1) != part.size () - 1) {
            return false;
        }
        if (bar == std::string::npos) {
            return true;
        }
        start = bar + 1;
    }
}

/**
 * @brief The type of a non-function leaf, read from its `detail`.
 *
 * A `detail` that restates the member's own dotted name (`.to.be.true`) is an
 * assertion getter: reading it performs the assertion and yields nothing, so
 * `void` is the honest type. `(writable pre-request)` and similar trailing
 * prose is stripped - it qualifies when the field may be assigned, which the
 * documentation already says and a type cannot.
 */
std::string field_type (const std::string& detail) {
    std::string base = trim (detail);
    const auto paren = base.find (" (");
    if (paren != std::string::npos) {
        base = trim (base.substr (0, paren));
    }

    // `T | undefined` is T, optional - so the suffix is split off and put back
    // rather than every pair being listed. The list form had `string |
    // undefined` and not `number | undefined`, which silently declared
    // `pm.info.iteration` as `void` and made `pm.info.iteration + 1` an error
    // in the editor.
    const auto [stripped, optional] = split_optional_suffix (base);
    base                            = stripped;

    std::string resolved;
    if (base == "number" || base == "string" || base == "boolean" || base == "any") {
        resolved = base;
    } else if (base == "object") {
        resolved = ANY_OBJECT;
    } else if (is_string_literal_union (base)) {
        resolved = base;
    } else {
        // Prose rather than a type - an assertion getter restating its own
        // name, or a description. `void` is the honest answer, and
        // `void | undefined` is not a type, so the suffix goes with it.
        return "void";
    }
    return optional ? resolved + std::string (OPTIONAL_SUFFIX) : resolved;
}

void append_doc (std::string& out, const TypeNode& node, const std::string& indent) {
    if (node.documentation.empty ()) {
        return;
    }
    // A `*/` inside the documentation would close the comment early and take
    // the rest of the file's declarations down with it.
    std::string body = node.documentation;
    for (size_t pos = body.find ("*/"); pos != std::string::npos;
         pos        = body.find ("*/", pos + 3)) {
        body.replace (pos, 2, "*\\/");
    }

    out += indent + "/**\n";
    std::string line;
    for (char c : body) {
        if (c == '\n') {
            out += indent + " * " + line + "\n";
            line.clear ();
        } else {
            line += c;
        }
    }
    out += indent + " * " + line + "\n";
    out += indent + " */\n";
}

std::string render_member (const TypeNode& node,
const std::string& name,
const std::string& indent,
bool in_chain);

/// Render a node's children as the body of an object type or interface.
std::string render_body (const TypeNode& node, const std::string& indent, bool in_chain) {
    std::string out;
    // A node whose own `detail` is `object` is indexable as well as having the
    // members the labels gave it - `pm.response.headers['content-type']` is the
    // documented way to read one, alongside `.get()`.
    if (trim (node.detail).rfind ("object", 0) == 0) {
        out += indent + "[key: string]: any;\n";
    }
    for (const auto& [child_name, child] : node.children) {
        out += render_member (child, child_name, indent, in_chain);
    }
    return out;
}

std::string render_member (const TypeNode& node,
const std::string& name,
const std::string& indent,
bool in_chain) {
    std::string out;
    append_doc (out, node, indent);

    if (!node.children.empty ()) {
        // A member that is both a listed call and the parent of its own
        // members: `pm.cookies.jar` is offered in its own right, and the
        // `pm.cookies.jar().set` labels give it children. Emitted separately
        // those were two `jar` members - `jar(): object` beside `jar(): {...}`
        // - and TypeScript resolves a call against the *first*, so every line
        // of the documented jar block was "Property 'set' does not exist on
        // type 'object'". One member, whose return type is the members the
        // labels gave it.
        if (node.kind == KIND_FUNCTION || node.called) {
            const Signature sig = parse_signature (node.detail, name);
            out += indent + name + "(" + (sig.parsed ? sig.params : "") + "): {\n";
            out += render_body (node, indent + "\t", in_chain);
            out += indent + "};\n";
            return out;
        }
        // `pm.iterationData?: {...}` - the surface is undefined outside a
        // data-driven collection run, and an object type has nowhere else to
        // say so. Under the renderer's current compiler options this shows in
        // hover rather than producing a diagnostic; see useScriptTypeDefinitions.
        out += indent + name + (node.optional ? "?: {\n" : ": {\n");
        out += render_body (node, indent + "\t", in_chain);
        out += indent + "};\n";
        return out;
    }

    if (node.kind == KIND_FUNCTION) {
        const Signature sig = parse_signature (node.detail, name);
        std::string params  = sig.parsed ? sig.params : "...args: any[]";
        std::string ret     = sig.return_type;
        if (!node.forced_return.empty ()) {
            ret = node.forced_return;
        }
        if (ret.empty ()) {
            // An assertion that documents no return continues the chain when it
            // sits in one, and otherwise yields nothing.
            ret = in_chain ? CHAIN : "void";
        }
        out += indent + name + "(" + params + "): " + ret + ";\n";
        return out;
    }

    if (in_chain && is_chain_continuation (name)) {
        out += indent + name + ": " + (name == "not" ? CHAIN_TO : CHAIN) + ";\n";
        return out;
    }
    out += indent + name + ": " + field_type (node.detail) + ";\n";
    return out;
}

} // namespace

/**
 * @brief Build the `.d.ts` the app hands to Monaco's TypeScript worker.
 *
 * Deterministic: members are emitted in sorted order, so the same table always
 * produces byte-identical output and the app can cache on its hash.
 */
std::string generate_script_typedefs () {
    TypeNode global_root;
    TypeNode chain_root;

    for (const auto& item : get_script_completions ()) {
        const int kind = item.value ("kind", 0);
        // Snippets are editor templates, not API surface. Their labels are
        // prose ("Test: Status code"), which is not a declarable name.
        if (kind == KIND_SNIPPET) {
            continue;
        }
        const std::string label = item.value ("label", "");
        if (label.empty ()) {
            continue;
        }

        const auto segments = split_dotted (label);
        // A label rooted at `to`/`and` is a chain continuation offered after
        // `pm.expect(...)`, not a global.
        TypeNode* node =
        (segments[0] == "to" || segments[0] == "and") ? &chain_root : &global_root;
        for (const auto& raw : segments) {
            // `pm.cookies.jar().set` spells out the call that produced the
            // object it hangs off. The call belongs to `jar`, which the table
            // lists in its own right - so this is one node, not a `jar` beside
            // a `jar()` that the sorted map would emit as two members.
            const bool is_call =
            raw.size () > 2 && raw.compare (raw.size () - 2, 2, "()") == 0;
            node = &node->children[is_call ? raw.substr (0, raw.size () - 2) : raw];
            if (is_call) {
                node->called = true;
            }
        }
        node->detail        = item.value ("detail", "");
        node->documentation = item.value ("documentation", "");
        node->kind          = kind;
        node->listed        = true;
        node->optional      = split_optional_suffix (node->detail).second;
    }

    // `pm.expect(value)` opens the chain the `to.*` entries continue. Nothing
    // in its entry says so - see `forced_return`.
    if (auto pm = global_root.children.find ("pm"); pm != global_root.children.end ()) {
        if (auto expect = pm->second.children.find ("expect");
            expect != pm->second.children.end ()) {
            expect->second.forced_return = CHAIN;
        }
    }

    std::string out =
    "// Generated by the Vayu engine from its script completion table\n"
    "// (GET /scripting/types). Do not edit - add to the table instead.\n\n";

    // The chain, as two interfaces so `.to.not` can name the type it returns.
    const auto to_it = chain_root.children.find ("to");
    if (to_it != chain_root.children.end ()) {
        out += "interface ";
        out += CHAIN_TO;
        out += " {\n" + render_body (to_it->second, "\t", true) + "}\n\n";
    }

    out += "interface ";
    out += CHAIN;
    out += " {\n";
    for (const auto& [name, child] : chain_root.children) {
        if (name == "to") {
            out += std::string ("\tto: ") + CHAIN_TO + ";\n";
        } else {
            out += render_member (child, name, "\t", true);
        }
    }
    out += "}\n";

    for (const auto& [name, child] : global_root.children) {
        out += "\n";
        if (!child.children.empty ()) {
            append_doc (out, child, "");
            out += "declare const " + name + ": {\n";
            out += render_body (child, "\t", false);
            out += "};\n";
            continue;
        }
        append_doc (out, child, "");
        if (child.kind == KIND_FUNCTION) {
            const Signature sig = parse_signature (child.detail, name);
            const std::string params = sig.parsed ? sig.params : "...args: any[]";
            const std::string ret = sig.return_type.empty () ? "void" : sig.return_type;
            out += "declare function " + name + "(" + params + "): " + ret + ";\n";
        } else {
            out += "declare const " + name + ": " + field_type (child.detail) + ";\n";
        }
    }

    // The globals the sandbox does *not* have - see ABSENT_GLOBALS. Skipped if
    // the table ever starts offering one for real, so the runtime gaining a
    // capability can never produce a file that declares it twice.
    for (const auto& absent : ABSENT_GLOBALS) {
        if (global_root.children.count (absent.name) != 0) {
            continue;
        }
        out += "\n/**\n * Not available in the Vayu script sandbox.\n *\n * ";
        out += absent.reason;
        out += "\n */\ndeclare const ";
        out += absent.name;
        out += ": never;\n";
    }

    return out;
}

} // namespace vayu::http::routes
