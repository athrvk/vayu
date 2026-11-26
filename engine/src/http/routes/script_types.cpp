/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Generates the TypeScript declarations Monaco's language service needs from
 * the completion table, so the surface has one source.
 * `GET /scripting/completions` gives a flat suggestion list; hover text,
 * signature help and a squiggle under `pm.response.staus` come from the
 * TypeScript worker, which wants a `.d.ts`. A hand-written `pm.d.ts` in the app
 * would be a second declaration, drifting the first time a `pm.*` method is
 * added here, so this file derives the declarations from
 * `get_script_completions ()`.
 *
 * A completion entry already carries the type: a function's `detail` is its
 * signature (`pm.environment.get(name: string): string | undefined`), a field's
 * its type (`number`). The rules below read those strings, plus the one thing
 * an entry cannot express: which label roots open the assertion chain.
 *
 * The assertion chain is read by leaf, not path (#1209). A dotted label is how
 * the popup spells a chain (`to.have.deep.property`), but `create_expectation`
 * installs `to`, `have`, `deep` and `property` on the same expectation, each
 * handing it back. Read as a path tree, a matcher would be reachable only along
 * the route some label spells, so `.to.be.a('string').and.match(/x/)` would be
 * an editor error on a chain the engine runs. So each label's last segment is
 * the member, every earlier segment marks a chainer, and the chain is one
 * `VayuExpectation` interface: chai's model, and the object's.
 */

#include <algorithm>
#include <array>
// <cctype> for isalpha/isalnum and <cstddef> for size_t: libstdc++ pulls both
// in transitively through <string>, MSVC and libc++ do not promise to, and this
// file is built on all three.
#include <cctype>
#include <cstddef>
#include <format>
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

// The generated interface name. One interface, because the runtime is one
// object: every chain word is a property of this type and every matcher a
// method returning it, exactly as `@types/chai` declares chai (issue #1209).
constexpr const char* CHAIN      = "VayuExpectation";
constexpr const char* ANY_OBJECT = "{ [key: string]: any }";

/**
 * chai's language chains, the words that assert nothing (#1053). The generator
 * needs them only to place a label rooted at one: `that.is.not.empty` is a
 * chain, not a global `that`. What each word means no longer matters to the
 * declarations, as in one interface every one hands back the same object.
 * `script_types_test.cpp` asserts the table still offers each, since one
 * dropped there would declare a top-level `that` nothing binds.
 */
constexpr auto LANGUAGE_CHAINS = std::to_array<const char*> ({ "also", "been",
"but", "does", "has", "is", "of", "same", "still", "that", "which", "with" });

/// The two chain roots that are not language chains - see `opens_the_chain`.
constexpr auto CHAIN_ROOTS = std::to_array<const char*> ({ "to", "and" });

bool is_language_chain (const std::string& name) {
    return std::find (std::begin (LANGUAGE_CHAINS), std::end (LANGUAGE_CHAINS),
           name) != std::end (LANGUAGE_CHAINS);
}

/**
 * Names a script may reach for that this sandbox lacks: browser or Node host
 * globals, and the libraries Postman bundles. Declared, not left out, so using
 * one is an error the editor can explain: the app suppresses `Cannot find name`
 * (2304, `SUPPRESSED_DIAGNOSTICS` in `useScriptTypeDefinitions.ts`), so an
 * undeclared name draws no squiggle. Typed `never`, the call, member access or
 * assignment after it is an error, and the documentation is what hover shows
 * instead.
 *
 * A script declaring the name itself keeps it: the editor compiles each script
 * as a module (`moduleDetection` in `SCRIPT_COMPILER_OPTIONS`), where
 * `const data = ...` shadows the global, as in the function the engine wraps
 * the script in. `script_types_test.cpp` runs `typeof <name>` in the real
 * engine for every root, so the list cannot drift from the sandbox.
 */
struct AbsentGlobal {
    const char* name;
    const char* reason;
};
constexpr auto ABSENT_GLOBALS = std::to_array<AbsentGlobal> ({
{ "fetch",
"No fetch in the sandbox. Use pm.sendRequest(request, callback), or "
"await pm.sendRequest(request), which is synchronous and allowed only when "
"the run's allowScriptRequests setting is on." },
{ "XMLHttpRequest", "No XMLHttpRequest in the sandbox. Use pm.sendRequest." },
{ "process", "Not Node. There is no process, no argv and no env." },
{ "Buffer", "Not Node. Use btoa/atob, or pm.crypto for hashing." },
{ "URL",
"No WHATWG URL constructor in the sandbox. pm.request.url is "
"already Postman's Url object - read its protocol, host, port, "
"path, query and hash there." },
{ "URLSearchParams",
"No URLSearchParams. pm.request.url.query answers the same "
"questions: get, has, all, toObject, count." },
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

// The libraries Postman bundles that Vayu's require() shelf does not carry,
// each saying what Vayu has instead. One that ships leaves this list (#2578).
{ "cheerio",
"Postman's bundled HTML parser. Its replacement is require('cheerio'), "
"which Vayu's require() does not load either." },
{ "Backbone",
"Postman's bundled Backbone, which it names no replacement for. Vayu has "
"no Backbone." },
});

/**
 * The modules `require()` loads (#2578, #2650), the one table the
 * `declare module` blocks and `require`'s signature are written from. The
 * editor checks JavaScript, where `const lib = require('crypto-js')` resolves
 * as a module import, not a call to the declared `require`; undeclared, the
 * idiom Postman scripts open with is "Cannot find module". So each name is
 * declared as a module and `require` answers `typeof import(name)`.
 *
 * `body` sits inside `declare module '<name>' { ... }`, tab-indented and ending
 * in the `export =` naming the module's value: one line for a module with a
 * global to point at (crypto-js, lodash, tv4), its own declaration otherwise
 * (uuid, moment, csv-parse/lib/sync, xml2js, chai, ajv).
 * `script_types_test.cpp` runs `require(name)` for every module here and checks
 * every name `require` accepts (`vayu::runtime::SHELF_MODULE_NAMES`) has a row.
 */
struct ShelfModule {
    const char* name;
    const char* body;
};
constexpr auto SHELF_MODULES = std::to_array<ShelfModule> ({
{ "crypto-js", "\texport = CryptoJS;\n" },
{ "uuid",
// npm's own members plus the callable form (`uuid()` is a v4); the
// signatures follow npm's, including the optional output buffer.
"\ttype Bytes = ArrayLike<number>;\n"
"\ttype Target = number[] | Uint8Array;\n"
"\tinterface RandomOptions {\n"
"\t\trandom?: Bytes;\n"
"\t\trng?: () => Bytes;\n"
"\t}\n"
"\tinterface V1Options extends RandomOptions {\n"
"\t\tnode?: Bytes;\n"
"\t\tclockseq?: number;\n"
"\t\tmsecs?: number | Date;\n"
"\t\tnsecs?: number;\n"
"\t}\n"
"\tinterface Randomised<Options> {\n"
"\t\t(options?: Options): string;\n"
"\t\t<T extends Target>(options: Options | null | undefined, buffer: T, "
"offset?: number): T;\n"
"\t}\n"
"\tinterface FromName {\n"
"\t\t(name: string | Bytes, namespace: string | Bytes): string;\n"
"\t\t<T extends Target>(name: string | Bytes, namespace: string | Bytes, "
"buffer: T, offset?: number): T;\n"
"\t\tDNS: string;\n"
"\t\tURL: string;\n"
"\t}\n"
"\tconst uuid: Randomised<RandomOptions> & {\n"
"\t\tv1: Randomised<V1Options>;\n"
"\t\tv3: FromName;\n"
"\t\tv4: Randomised<RandomOptions>;\n"
"\t\tv5: FromName;\n"
"\t\tNIL: string;\n"
"\t\tparse(uuid: string): Uint8Array;\n"
"\t\tstringify(bytes: Bytes, offset?: number): string;\n"
"\t\tvalidate(uuid: unknown): boolean;\n"
"\t\tversion(uuid: string): number;\n"
"\t};\n"
"\texport = uuid;\n" },
{ "lodash", "\texport = _;\n" },
// `any`, as lodash's `_` is: moment's API is not restated here, and a partial
// list would flag the members it left out on correct code. Postman gives
// moment no global, so the module carries its own declaration.
{ "moment",
"\tconst moment: any;\n"
"\texport = moment;\n" },
// The module is the parse function. Its options are csv-parse 1.2.4's and are
// not restated, so any option object types; the answer is `any` because
// `columns` and `objname` change its shape. Input is a string only.
{ "csv-parse/lib/sync",
"\tconst parse: (input: string, options?: { [option: string]: unknown }) => "
"any;\n"
"\texport = parse;\n" },
// xml2js 0.6.2's whole export. `xml2Json` is not this module but a function
// over it, declared from its own completion entry. A Parser instance is `any`:
// it is an event emitter whose members (options, saxParser, on, reset, ...)
// scripts rarely reach and a partial list would flag.
{ "xml2js",
"\ttype Options = { [option: string]: unknown };\n"
"\ttype Callback = (err: Error | null, result?: any) => void;\n"
"\ttype Processor = (value: string, name?: string) => any;\n"
"\tconst xml2js: {\n"
"\t\tparseString(xml: string, callback?: Callback): unknown;\n"
"\t\tparseString(xml: string, options: Options, callback?: Callback): "
"unknown;\n"
"\t\tparseStringPromise(xml: string, options?: Options): Promise<any>;\n"
"\t\tParser: new (options?: Options) => any;\n"
"\t\tBuilder: new (options?: Options) => { options: Options; "
"buildObject(root: unknown): string };\n"
"\t\tValidationError: new (message: string) => Error;\n"
"\t\tdefaults: { '0.1': Options; '0.2': Options };\n"
"\t\tprocessors: {\n"
"\t\t\tnormalize: Processor;\n"
"\t\t\tfirstCharLowerCase: Processor;\n"
"\t\t\tstripPrefix: Processor;\n"
"\t\t\tparseNumbers: Processor;\n"
"\t\t\tparseBooleans: Processor;\n"
"\t\t};\n"
"\t};\n"
"\texport = xml2js;\n" },
// chai 4.4.1's top-level export. An assertion chain is `any`: chai's few
// hundred chain members are not restated, and a partial list would flag the
// ones it left out on correct code. `should` on a value is not declared, since
// it exists only once `should()` has run.
{ "chai",
"\ttype Assertion = any;\n"
"\tinterface ExpectStatic {\n"
"\t\t(value: unknown, message?: string): Assertion;\n"
"\t\tfail(message?: string): never;\n"
"\t\tfail(actual: unknown, expected: unknown, message?: string, operator?: "
"string): never;\n"
"\t}\n"
"\tinterface AssertStatic {\n"
"\t\t(expression: unknown, message?: string): void;\n"
"\t\t[assertion: string]: (...args: any[]) => any;\n"
"\t}\n"
"\tinterface AssertionError extends Error {\n"
"\t\tshowDiff: boolean;\n"
"\t\tactual?: unknown;\n"
"\t\texpected?: unknown;\n"
"\t\toperator?: string;\n"
"\t}\n"
"\tinterface Chai {\n"
"\t\texpect: ExpectStatic;\n"
"\t\tassert: AssertStatic;\n"
"\t\tshould(): any;\n"
"\t\tShould(): any;\n"
"\t\tuse(plugin: (chai: any, utils: any) => void): Chai;\n"
"\t\tconfig: {\n"
"\t\t\tincludeStack: boolean;\n"
"\t\t\tshowDiff: boolean;\n"
"\t\t\ttruncateThreshold: number;\n"
"\t\t\tuseProxy: boolean;\n"
"\t\t\tproxyExcludedKeys: string[];\n"
"\t\t\tdeepEqual: ((expected: unknown, actual: unknown) => boolean) | null;\n"
"\t\t};\n"
"\t\tAssertionError: new (message?: string, properties?: object, ssf?: "
"(...args: any[]) => unknown) => AssertionError;\n"
"\t\tAssertion: any;\n"
"\t\tutil: any;\n"
"\t\tversion: string;\n"
"\t}\n"
"\tconst chai: Chai;\n"
"\texport = chai;\n" },
// ajv 6.12.5's export, the Ajv constructor, callable with or without `new`.
// The signatures are ajv's own `lib/ajv.d.ts`, trimmed to what a script
// writes: options and keyword definitions are open objects rather than
// restated, and a validator answers a promise only for an `$async` schema.
{ "ajv",
"\tinterface ErrorObject {\n"
"\t\tkeyword: string;\n"
"\t\tdataPath: string;\n"
"\t\tschemaPath: string;\n"
"\t\tparams: { [key: string]: any };\n"
"\t\tmessage?: string;\n"
"\t\tschema?: unknown;\n"
"\t\tparentSchema?: object;\n"
"\t\tdata?: unknown;\n"
"\t}\n"
"\tinterface ValidateFunction {\n"
"\t\t(data: unknown, dataPath?: string, parentData?: object, "
"parentDataProperty?: string | number, rootData?: object): boolean | "
"PromiseLike<any>;\n"
"\t\tschema?: object | boolean;\n"
"\t\terrors?: ErrorObject[] | null;\n"
"\t}\n"
"\tinterface Options {\n"
"\t\t[option: string]: any;\n"
"\t}\n"
"\tinterface Ajv {\n"
"\t\tvalidate(schemaKeyRef: object | string | boolean, data: unknown): "
"boolean | PromiseLike<any>;\n"
"\t\tcompile(schema: object | boolean): ValidateFunction;\n"
"\t\tcompileAsync(schema: object | boolean, meta?: boolean, callback?: "
"(error: Error, validate: ValidateFunction) => any): "
"PromiseLike<ValidateFunction>;\n"
"\t\taddSchema(schema: object | object[], key?: string): Ajv;\n"
"\t\taddMetaSchema(schema: object, key?: string): Ajv;\n"
"\t\tvalidateSchema(schema: object | boolean): boolean;\n"
"\t\tgetSchema(keyRef: string): ValidateFunction | undefined;\n"
"\t\tremoveSchema(schemaKeyRef?: object | string | RegExp | boolean): "
"Ajv;\n"
"\t\taddFormat(name: string, format: string | RegExp | ((data: string) => "
"boolean) | object): Ajv;\n"
"\t\taddKeyword(keyword: string, definition: object): Ajv;\n"
"\t\tgetKeyword(keyword: string): object | boolean;\n"
"\t\tremoveKeyword(keyword: string): Ajv;\n"
"\t\tvalidateKeyword(definition: object, throwError: boolean): boolean;\n"
"\t\terrorsText(errors?: ErrorObject[] | null, options?: { separator?: "
"string; dataVar?: string }): string;\n"
"\t\terrors?: ErrorObject[] | null;\n"
"\t}\n"
"\tinterface AjvStatic {\n"
"\t\tnew (options?: Options): Ajv;\n"
"\t\t(options?: Options): Ajv;\n"
"\t\tValidationError: new (errors: ErrorObject[]) => Error & { errors: "
"ErrorObject[]; ajv: true; validation: true };\n"
"\t\tMissingRefError: new (baseId: string, ref: string, message?: string) "
"=> Error & { missingRef: string; missingSchema: string };\n"
"\t}\n"
"\tconst Ajv: AjvStatic;\n"
"\texport = Ajv;\n" },
{ "tv4", "\texport = tv4;\n" },
});

/**
 * Standard-library members quickjs-ng runs that the editor's TypeScript lib
 * (`esnext`, SCRIPT_LIB) does not declare yet (#3462; retired by #3485). Each
 * row is an interface augmentation merging into the lib's interface, so
 * `RegExp.escape(...)` is no false "Property does not exist". `head` repeats
 * the lib's declaration, type parameters and defaults included, or TypeScript
 * refuses the merge; `members` is the body, one per line.
 *
 * A stopgap with an exit: a row retires when Monaco's bundled TypeScript
 * declares its members. Declared by both, a method would silently merge into an
 * overload, so the app's `script-typedefs.docs-compile.test.ts` compiles the
 * bare lib and fails on the day it knows one: delete the row then.
 * `script_types_test.cpp` runs every member in the real engine, so no row
 * declares what the runtime lacks.
 */
struct LibraryGap {
    const char* head;
    const char* members;
};
constexpr auto LIBRARY_GAPS = std::to_array<LibraryGap> ({
{ "interface RegExpConstructor", "\tescape(string: string): string;\n" },
{ "interface Math", "\tsumPrecise(values: Iterable<number>): number;\n" },
{ "interface JSON",
"\trawJSON(text: string): { readonly rawJSON: string };\n"
"\tisRawJSON(value: unknown): value is { readonly rawJSON: string };\n" },
{ "interface Uint8ArrayConstructor",
"\tfromBase64(string: string, options?: { alphabet?: 'base64' | 'base64url'; "
"lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' }): "
"Uint8Array<ArrayBuffer>;\n"
"\tfromHex(string: string): Uint8Array<ArrayBuffer>;\n" },
{ "interface Uint8Array<TArrayBuffer extends ArrayBufferLike = "
  "ArrayBufferLike>",
"\ttoBase64(options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: "
"boolean }): string;\n"
"\ttoHex(): string;\n"
"\tsetFromBase64(string: string, options?: { alphabet?: 'base64' | "
"'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' "
"}): { read: number; written: number };\n"
"\tsetFromHex(string: string): { read: number; written: number };\n" },
});

/// Written into the output above the augmentations; the tests find them by it.
constexpr std::string_view LIBRARY_GAPS_BANNER =
"// Library members the runtime has and TypeScript's lib does not declare "
"yet.\n";

/**
 * Whether a label's first segment opens the assertion chain: a label rooted at
 * `to`, `and` or a language chain continues `pm.expect(...)`, so it is no
 * global (without the last, `.that` would declare a top-level `that`).
 */
bool opens_the_chain (const std::string& root_segment) {
    return is_language_chain (root_segment) ||
    std::find (std::begin (CHAIN_ROOTS), std::end (CHAIN_ROOTS), root_segment) !=
    std::end (CHAIN_ROOTS);
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
 * The table's one way to say "this member may not be there": a `detail` ending
 * in ` | undefined`, for a leaf (`pm.info.iteration` is `number | undefined`)
 * and a whole surface (`pm.iterationData` is `undefined` outside a data-driven
 * collection run). A leaf keeps the union; a surface with members has none to
 * put it in, so it becomes a `?` on the property. One reader, so `field_type`
 * and `render_member` agree on it.
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
 * Splits a parameter list on top-level commas: a parameter's own type can hold
 * commas (`size(): { body: number, header: number }`, `Record<string, any>`,
 * `(value: any) => boolean`).
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
 * Where @p name's own parameter list opens in @p detail. The first `(` is not
 * always the member's: a jar entry names the producing call first
 * (`pm.cookies.jar().get(url: string, name: string, ...)`), and reading from
 * `jar()`'s empty list would drop the return type too. So the search anchors on
 * the member name, falling back to the first `(` when the detail does not
 * restate it.
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
 * Reads a function entry's `detail` as a TypeScript signature, in the table's
 * two shapes (`name(params): Return` and `name(params)`). Two entries document
 * an overload in prose TypeScript cannot parse
 * (`upsert({ key, value }) | (name, value)`); those fall back to
 * `...args: any[]`, keeping the member callable and documented instead of
 * dropped or uncompilable.
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
    if (rest.rfind (':', 0) == 0) {
        sig.return_type = trim (rest.substr (1));
    }
    return sig;
}

/**
 * Whether every `|`-separated alternative is a quoted string literal: a closed
 * set of strings is a type, not prose. `pm.info.eventName` is
 * `'prerequest' | 'test'`; read as `void`, the documented
 * `pm.info.eventName === 'prerequest'` would be a no-overlap comparison error.
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
 * The primitive a member's own members sit on, or "" for none. One member needs
 * it: `pm.request.url` is Postman's `Url` object, with `query` / `path` /
 * `host` plus a prototype and `@@toPrimitive` keeping it usable wherever the
 * string it replaced was (#991). As an object alone, the documented
 * `jar().set(pm.request.url, ...)` stops compiling; as a string,
 * `url.query.get(...)` does. Only `string & { ... }` types both, and the table
 * says so by spelling the type `string & object`. The member is emitted as the
 * accessor pair it is at run time: the getter answers the object, the setter
 * takes what a script assigns (`assigned_type`).
 */
std::string intersection_base (const std::string& detail) {
    std::string base = trim (detail);
    const auto paren = base.find (" (");
    if (paren != std::string::npos) {
        base = trim (base.substr (0, paren));
    }
    const auto amp = base.find ('&');
    if (amp == std::string::npos || trim (base.substr (amp + 1)) != "object") {
        return {};
    }
    // Not `const`: it is returned by value, and a const local is copied where a
    // non-const one is moved (performance-no-automatic-move).
    std::string left = trim (base.substr (0, amp));
    if (left == "string" || left == "number" || left == "boolean") {
        return left;
    }
    return {};
}

/**
 * A non-function leaf's type, from its `detail`. A `detail` restating the
 * member's dotted name (`.to.be.true`) is an assertion getter, which yields
 * nothing, so `void`. Trailing prose such as `(writable pre-request)` is
 * stripped: it says when the field may be assigned, which a type cannot.
 */
std::string field_type (const std::string& detail) {
    std::string base = trim (detail);
    const auto paren = base.find (" (");
    if (paren != std::string::npos) {
        base = trim (base.substr (0, paren));
    }

    // `T | undefined` is T, optional - so the suffix is split off and put back
    // rather than every pair being listed.
    const auto [stripped, optional] = split_optional_suffix (base);
    base                            = stripped;

    // `T[]` is the element type, listed: a suffix rather than its own spelling,
    // so a list of anything the table names (`pm.response.events` is
    // `object[]`) declares as a real array, not as `void` that errors on
    // correct code.
    std::string suffix;
    if (base.size () > 2 && base.compare (base.size () - 2, 2, "[]") == 0) {
        base   = trim (base.substr (0, base.size () - 2));
        suffix = "[]";
    }

    std::string resolved;
    if (base == "number" || base == "string" || base == "boolean" || base == "any") {
        resolved = base;
    } else if (base == "object") {
        resolved = ANY_OBJECT;
    } else if (is_string_literal_union (base)) {
        // `('a' | 'b')[]` - a union needs its parentheses back before the
        // suffix, or the array binds to the last alternative alone.
        resolved = suffix.empty () ? base : "(" + base + ")";
    } else {
        // Prose rather than a type - an assertion getter restating its own
        // name, or a description. `void` is the honest answer, and
        // `void | undefined` is not a type, so the suffix goes with it.
        return "void";
    }
    resolved += suffix;
    return optional ? resolved + std::string (OPTIONAL_SUFFIX) : resolved;
}

void append_doc (std::string& out, const std::string& documentation, const std::string& indent) {
    if (documentation.empty ()) {
        return;
    }
    // A `*/` inside the documentation would close the comment early and take
    // the rest of the file's declarations down with it.
    std::string body = documentation;
    for (size_t pos = body.find ("*/"); pos != std::string::npos;
    pos             = body.find ("*/", pos + 3)) {
        body.replace (pos, 2, "*\\/");
    }

    out += indent + "/**\n";
    std::string line;
    for (char c : body) {
        if (c == '\n') {
            out += indent;
            out += " * ";
            out += line;
            out += '\n';
            line.clear ();
        } else {
            line += c;
        }
    }
    out += indent + " * " + line + "\n";
    out += indent + " */\n";
}

/**
 * What a listed call returns, asked by both callable shapes: `forced_return`
 * when the table cannot say it (`pm.expect` opens the chain unannounced), the
 * documented return type when it can, else nothing. One reader, so a plain
 * function and one with members agree. The chain does not ask: every matcher
 * returns the chain, as `render_chain_member` says once.
 */
std::string function_return_type (const TypeNode& node, const Signature& sig) {
    if (!node.forced_return.empty ()) {
        return node.forced_return;
    }
    if (!sig.return_type.empty ()) {
        return sig.return_type;
    }
    return "void";
}

/**
 * What assigning an intersection member takes: its `update ()`'s parameter,
 * else @p base. Assigning and `update ()` are one write at run time
 * (`pm.request.url = x` is `url.update (x)`; `pm.request.body` takes what
 * `body.update ()` does, #3131), so the table states the type once, on
 * `update`.
 */
std::string assigned_type (const TypeNode& node, const std::string& base) {
    const auto update = node.children.find ("update");
    if (update == node.children.end () || update->second.kind != KIND_FUNCTION) {
        return base;
    }
    const Signature sig = parse_signature (update->second.detail, "update");
    const auto params =
    sig.parsed ? split_params (sig.params) : std::vector<std::string>{};
    if (params.size () != 1 || !is_typed_param (params.front ())) {
        return base;
    }
    const std::string& param = params.front ();
    return trim (param.substr (param.find (':') + 1));
}

std::string
render_member (const TypeNode& node, const std::string& name, const std::string& indent);

/// Render a node's children as the body of an object type or interface.
std::string render_body (const TypeNode& node, const std::string& indent) {
    std::string out;
    // A node whose own `detail` is `object` is indexable as well as having the
    // members the labels gave it - `pm.response.headers['content-type']` is the
    // documented way to read one, alongside `.get()`.
    if (trim (node.detail).rfind ("object", 0) == 0) {
        out += indent + "[key: string]: any;\n";
    }
    for (const auto& [child_name, child] : node.children) {
        out += render_member (child, child_name, indent);
    }
    return out;
}

std::string
render_member (const TypeNode& node, const std::string& name, const std::string& indent) {
    std::string out;
    append_doc (out, node.documentation, indent);

    if (!node.children.empty ()) {
        // Both a listed call and the parent of members: `pm.cookies.jar` is
        // offered itself, and the `pm.cookies.jar().set` labels give it
        // children. Emitted as two `jar` members, TypeScript resolves a call
        // against the first (`jar(): object`), failing every documented jar
        // line, so it is one member whose return type is the members the labels
        // gave it.
        if (node.called) {
            const Signature sig = parse_signature (node.detail, name);
            out += indent + name + "(" + (sig.parsed ? sig.params : "") + "): {\n";
            out += render_body (node, indent + "\t");
            out += indent + "};\n";
            return out;
        }
        // A function whose children were reached without a call
        // (`pm.expect.fail`, not `pm.expect().fail`), so `fail` is a member of
        // the function object, not of what it returns. The label's `()` is the
        // whole distinction: read as the jar's shape, `pm.expect(x)` would
        // return `{ fail }` and break every documented `pm.expect(x).to...`.
        // TypeScript writes a callable with members as a call signature beside
        // them.
        if (node.kind == KIND_FUNCTION) {
            const Signature sig = parse_signature (node.detail, name);
            out += indent + name + ": {\n";
            out += indent + "\t(" + (sig.parsed ? sig.params : "...args: any[]") +
            "): " + function_return_type (node, sig) + ";\n";
            out += render_body (node, indent + "\t");
            out += indent + "};\n";
            return out;
        }
        // `pm.request.url` - members on top of the string it still behaves as.
        // See intersection_base.
        if (const std::string base = intersection_base (node.detail); !base.empty ()) {
            out += indent + "get " + name + "(): " + base + " & {\n";
            out += render_body (node, indent + "\t");
            out += indent + "};\n";
            out += indent + "set " + name + "(value: " + assigned_type (node, base) + ");\n";
            return out;
        }
        // `pm.iterationData?: {...}`: undefined outside a data-driven
        // collection run, and an object type has nowhere else to say so. Under
        // the renderer's compiler options this shows in hover, not as a
        // diagnostic (`useScriptTypeDefinitions`).
        out += indent + name + (node.optional ? "?: {\n" : ": {\n");
        out += render_body (node, indent + "\t");
        out += indent + "};\n";
        return out;
    }

    if (node.kind == KIND_FUNCTION) {
        const Signature sig      = parse_signature (node.detail, name);
        const std::string params = sig.parsed ? sig.params : "...args: any[]";
        const std::string ret    = function_return_type (node, sig);
        // A member documented as answering the chain is reached as the chain
        // too: the runtime builds each one (`pm.response.to.have.responseTime`)
        // with `chainable_method`, a callable whose prototype is the
        // expectation, so `.responseTime.below(200)` runs (#2528).
        if (ret == CHAIN) {
            out += indent + name + ": ((" + params + ") => " + CHAIN + ") & " + CHAIN + ";\n";
            return out;
        }
        out += indent + name + "(" + params + "): " + ret + ";\n";
        return out;
    }

    out += indent + name + ": " + field_type (node.detail) + ";\n";
    return out;
}

/// One label that named a chain member, and how deep in the label it sat.
struct ChainEntry {
    std::string label;
    size_t depth         = 0;
    const TypeNode* node = nullptr;
};

/// Every chain member by name, with each label that named it. Sorted, because
/// the output is a generated file the tests compare against.
using ChainMembers = std::map<std::string, std::vector<ChainEntry>>;

/**
 * The chain's members by leaf name, not path: every segment of every chain
 * label is a member of the one expectation, so each node is filed under its
 * last segment whatever its depth. A word only ever a prefix (`be`, `have`,
 * `at`, `deep`, `nested`, `all`) is a member with no entry of its own; one that
 * is both (none today; `to.deep` beside `to.deep.equal` would be) keeps every
 * entry, and `render_chain_member` picks one.
 */
void collect_chain_members (const TypeNode& node,
const std::string& path,
size_t depth,
ChainMembers& members) {
    for (const auto& [name, child] : node.children) {
        std::string label = path;
        if (!label.empty ()) {
            label += '.';
        }
        label += name;
        std::vector<ChainEntry>& entries = members[name];
        if (child.listed) {
            entries.push_back (ChainEntry{ label, depth, &child });
        }
        collect_chain_members (child, label, depth + 1, members);
    }
}

/**
 * One member's documentation with its longer spellings folded in. The table
 * describes `property` three times (`to.have.property`,
 * `to.have.deep.property`, `to.have.nested.property`): three things to type,
 * one member. The plainest spelling leads, as it describes the member rather
 * than a flag set before it; each longer one follows under its label, the only
 * statement in the declarations of what `deep` or `nested` changes.
 */
std::string chain_member_doc (const std::vector<ChainEntry>& entries) {
    if (entries.empty ()) {
        return {};
    }
    std::string doc = entries.front ().node->documentation;
    for (size_t i = 1; i < entries.size (); i++) {
        const std::string& longer = entries[i].node->documentation;
        if (longer.empty () || doc.find (longer) != std::string::npos) {
            continue;
        }
        doc += "\n\n`" + entries[i].label + "`:\n" + longer;
    }
    return doc;
}

/**
 * One member of the chain interface. Every non-function member is the chain: a
 * chain word hands the expectation back, and so does a terminal getter
 * (`expect_true` returns `expect_chained (...)`, so `.to.be.true.and.equal(1)`
 * runs), with no chain vocabulary in the table. Every call returns the chain
 * too, whatever its entry documents: `expect_chained` is what every matcher
 * returns.
 */
std::string render_chain_member (const std::string& name,
const std::vector<ChainEntry>& entries) {
    std::string out;
    append_doc (out, chain_member_doc (entries), "\t");

    const TypeNode* declared = entries.empty () ? nullptr : entries.front ().node;
    if (declared != nullptr && declared->kind == KIND_FUNCTION) {
        const Signature sig      = parse_signature (declared->detail, name);
        const std::string params = sig.parsed ? sig.params : "...args: any[]";
        // A call the table also continues with a longer label - `to.have.length`
        // beside `to.have.length.within` - is the call *and* the chain, as the
        // runtime's `length` is (#2528). Typed as a method it would make
        // `.length.above(2)` an editor error for a script that runs.
        if (!declared->children.empty ()) {
            out += "\t" + name + ": ((" + params + ") => " + CHAIN + ") & " + CHAIN + ";\n";
            return out;
        }
        out += "\t" + name + "(" + params + "): " + CHAIN + ";\n";
        return out;
    }
    out += "\t" + name + ": " + CHAIN + ";\n";
    return out;
}

void render_absent_global (std::string& out, const AbsentGlobal& absent) {
    // Every root carries this sentence: `script_types_test.cpp` finds the
    // absent names by it.
    out += "\n/**\n * Not available in the Vayu script sandbox.\n *\n * ";
    out += absent.reason;
    out += "\n */\ndeclare const ";
    out += absent.name;
    out += ": never;\n";
}

/**
 * `require`, written from SHELF_MODULES, not its completion entry, whose
 * `detail` cannot give each module its return type; overloads would turn a name
 * off the shelf from TS2345 into the vaguer TS2769 "No overload matches". One
 * generic signature keyed on the names keeps the parameter a literal union
 * (`require('cheerio')` is "not assignable to 'crypto-js' | ... | 'tv4'"). Only
 * the entry's documentation is read.
 */
void render_require (std::string& out, const TypeNode& require) {
    out += "interface VayuShelfModules {\n";
    for (const auto& shelf_module : SHELF_MODULES) {
        out += std::format ("\t'{0}': typeof import('{0}');\n", shelf_module.name);
    }
    out += "}\n\n";
    append_doc (out, require.documentation, "");
    out +=
    "declare function require<N extends keyof VayuShelfModules>(name: N): "
    "VayuShelfModules[N];\n";
}

} // namespace

/**
 * The completion table as a tree of declarable names; `pm.expect(value)`'s
 * opening of the chain is linked at the end (`forced_return`).
 */
void build_type_tree (TypeNode& global_root, TypeNode& chain_root) {
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
        TypeNode* node = opens_the_chain (segments[0]) ? &chain_root : &global_root;
        for (const auto& raw : segments) {
            // `pm.cookies.jar().set` spells the call that produced its object.
            // The call belongs to `jar`, listed in its own right, so this is
            // one node, not a `jar` beside a `jar()` the sorted map would emit
            // as two members.
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

    // `pm.expect(value)` opens the chain; see `forced_return`.
    if (auto pm = global_root.children.find ("pm"); pm != global_root.children.end ()) {
        if (auto expect = pm->second.children.find ("expect");
        expect != pm->second.children.end ()) {
            expect->second.forced_return = CHAIN;
        }
    }
}

/** The assertion chain, as the one interface the runtime's one object is. */
std::string render_chain (const TypeNode& chain_root) {
    ChainMembers members;
    collect_chain_members (chain_root, "", 0, members);

    std::string out = "interface ";
    out += CHAIN;
    out += " {\n";
    for (auto& [name, entries] : members) {
        // Plainest spelling first: it is the one whose signature and
        // documentation describe the member rather than a flag set before it.
        std::sort (entries.begin (), entries.end (),
        [] (const ChainEntry& a, const ChainEntry& b) {
            return a.depth != b.depth ? a.depth < b.depth : a.label < b.label;
        });
        out += render_chain_member (name, entries);
    }
    out += "}\n";
    return out;
}

/// The LIBRARY_GAPS augmentations, one interface block per row.
void render_library_gaps (std::string& out) {
    out += "\n";
    out += LIBRARY_GAPS_BANNER;
    for (const auto& gap : LIBRARY_GAPS) {
        out += std::format ("{} {{\n{}}}\n", gap.head, gap.members);
    }
}

/**
 * Every global the sandbox declares, then the ones it deliberately lacks
 * (ABSENT_GLOBALS). An absent global the table starts offering for real is
 * skipped, so a runtime gaining a capability never declares it twice.
 */
std::string render_globals (const TypeNode& global_root) {
    std::string out;
    for (const auto& [name, child] : global_root.children) {
        out += "\n";
        if (name == "require" && child.kind == KIND_FUNCTION) {
            render_require (out, child);
            continue;
        }
        if (!child.children.empty ()) {
            append_doc (out, child.documentation, "");
            out += "declare const " + name + ": {\n";
            out += render_body (child, "\t");
            out += "};\n";
            continue;
        }
        append_doc (out, child.documentation, "");
        if (child.kind == KIND_FUNCTION) {
            const Signature sig = parse_signature (child.detail, name);
            const std::string params = sig.parsed ? sig.params : "...args: any[]";
            const std::string ret = sig.return_type.empty () ? "void" : sig.return_type;
            out += std::format ("declare function {}({}): {};\n", name, params, ret);
        } else {
            out += "declare const " + name + ": " + field_type (child.detail) + ";\n";
        }
    }

    // The globals the sandbox lacks (ABSENT_GLOBALS).
    for (const auto& absent : ABSENT_GLOBALS) {
        if (global_root.children.count (absent.name) != 0) {
            continue;
        }
        render_absent_global (out, absent);
    }
    return out;
}

/**
 * The `.d.ts` the app hands Monaco's TypeScript worker. Deterministic (members
 * in sorted order), so the same table yields byte-identical output and the app
 * can cache on its hash.
 */
std::string generate_script_typedefs () {
    TypeNode global_root;
    TypeNode chain_root;
    build_type_tree (global_root, chain_root);

    std::string out =
    "// Generated by the Vayu engine from its script completion table\n"
    "// (GET /scripting/types). Do not edit - add to the table instead.\n\n";
    out += render_chain (chain_root);
    out += render_globals (global_root);
    render_library_gaps (out);
    for (const auto& shelf_module : SHELF_MODULES) {
        out += std::format ("\ndeclare module '{}' {{\n{}}}\n",
        shelf_module.name, shelf_module.body);
    }
    return out;
}

} // namespace vayu::http::routes
