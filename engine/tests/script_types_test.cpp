// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// The `.d.ts` served by GET /scripting/types is *derived* from the completion
// table rather than hand-written, which is the whole point - a hand-written
// copy in the app would drift the first time a `pm.*` method is added here and
// not there. The cost of deriving it is that an innocuous edit to a `detail`
// string can silently degrade a declaration, so these guard the derivation.
//
// What they check, in order of how quietly it would break:
//   - the declared assertion chain is the object the runtime builds, member
//     for member in both directions (see TheDeclaredChainIsTheObjectTheRuntime
//     Builds: this is the guard that made the enumerated chain pins retirable,
//     because it fails on a member added to either side alone);
//   - the chain roots still exist in the table (see LANGUAGE_CHAINS and
//     CHAIN_ROOTS in script_types.cpp: a label the generator no longer
//     recognises as a chain declares a top-level `that` nothing binds);
//   - every listed non-snippet member reaches the output;
//   - the signature reader handles the shapes the table actually uses,
//     including the two it cannot parse.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <string_view>

#include "library_call_config.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/runtime/shelf_modules.hpp"
#include "vayu/utils/diagnostics.hpp"

namespace vayu::http::routes {
// Defined in scripting.cpp.
nlohmann::json get_script_completions ();
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::generate_script_typedefs;
using vayu::http::routes::get_script_completions;

constexpr int KIND_SNIPPET = 28;

bool contains (const std::string& haystack, const std::string& needle) {
    return haystack.find (needle) != std::string::npos;
}

/**
 * @brief The body of `interface VayuExpectation`, terminating newline included.
 *
 * The newline matters: a member is asserted as a whole line, and the closing
 * `\n}\n` shares its `\n` with the last member's, so a slice that stops at the
 * brace ends mid-line and the last member - `with`, alphabetically - can never
 * be found.
 */
std::string chain_interface_body (const std::string& dts) {
    const size_t open = dts.find ("interface VayuExpectation {");
    if (open == std::string::npos) {
        return {};
    }
    const size_t close = dts.find ("\n}\n", open);
    return close == std::string::npos ? std::string{} :
                                        dts.substr (open, close - open + 1);
}

/**
 * @brief The names declared at an interface body's own indent.
 *
 * A member is one tab, an identifier, then either its parameter list or its
 * type. Reading anything at that indent instead would collect the ` * ` lines
 * of every doc comment as members - which is how the first version of
 * TheDeclaredChainIsTheObjectTheRuntimeBuilds came to send ` * Example` to
 * QuickJS as a property name.
 */
std::set<std::string> declared_members (const std::string& body) {
    std::set<std::string> names;
    for (size_t pos = body.find ("\n\t"); pos != std::string::npos;
    pos             = body.find ("\n\t", pos + 1)) {
        size_t end = pos + 2;
        while (end < body.size () &&
        (std::isalnum (static_cast<unsigned char> (body[end])) ||
        body[end] == '_' || body[end] == '$')) {
            end++;
        }
        const std::string name = body.substr (pos + 2, end - pos - 2);
        if (name.empty () || std::isdigit (static_cast<unsigned char> (name.front ())) ||
        end >= body.size () || (body[end] != '(' && body[end] != ':')) {
            continue; // a doc-comment line, or a member one tab deeper
        }
        names.insert (name);
    }
    return names;
}

/**
 * @brief Whether an environment variable is present at all - see
 *        TheCheckedInDeclarationsMatchTheGenerator, its one caller.
 *
 * MSVC deprecates `std::getenv` in favour of `_dupenv_s` (C4996), and this
 * suite is built with `/W4 /WX`, so the deprecation is followed rather than
 * suppressed: a `#pragma warning(disable)` here would be a permanent
 * suppression for a one-line read.
 *
 * `concurrency-mt-unsafe` is silenced rather than fixed (#945): `getenv` races
 * only against a write to the environment, and the writers in this suite are
 * `ScopedEnv` (`scoped_env.hpp`) and the grant-secret test that calls
 * `take_grant_secret_from_environment`. gtest runs one test body at a time, so
 * those writes and this read never overlap.
 */
bool env_is_set (const char* name) {
#ifdef _WIN32
    char* value   = nullptr;
    size_t length = 0;
    if (_dupenv_s (&value, &length, name) != 0 || value == nullptr) {
        return false;
    }
    const std::unique_ptr<char, decltype (&std::free)> owned (value, &std::free);
    return true;
#else
    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    return std::getenv (name) != nullptr;
#endif
}

TEST (ScriptTypesTest, IsDeterministic) {
    EXPECT_EQ (generate_script_typedefs (), generate_script_typedefs ());
}

TEST (ScriptTypesTest, DeclaresEveryGlobalRoot) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "declare const pm: {"));
    EXPECT_TRUE (contains (dts, "declare const console: {"));
    EXPECT_TRUE (contains (dts, "declare function btoa("));
    EXPECT_TRUE (contains (dts, "declare function atob("));
}

// The bug the whole endpoint exists to make impossible: a capability the table
// gained that the editor's language service never hears about. Every member of
// every non-snippet label must appear.
TEST (ScriptTypesTest, EveryListedMemberReachesTheOutput) {
    const std::string dts = generate_script_typedefs ();
    size_t checked        = 0;

    for (const auto& item : get_script_completions ()) {
        if (item.value ("kind", 0) == KIND_SNIPPET) {
            continue;
        }
        const std::string label = item.value ("label", "");
        if (label.empty ()) {
            continue;
        }
        // The leaf name is what the declaration carries; the path to it is the
        // nesting, which the structural tests below cover.
        const auto dot = label.rfind ('.');
        const std::string leaf =
        dot == std::string::npos ? label : label.substr (dot + 1);
        EXPECT_TRUE (contains (dts, leaf))
        << "label '" << label << "' contributes no declaration";
        checked++;
    }

    // A scan that read an empty table would pass every assertion above.
    EXPECT_GT (checked, 100u)
    << "completion table looks empty - the scan proved nothing";
}

// See CHAIN_ROOTS and LANGUAGE_CHAINS in script_types.cpp. Which label roots
// open the chain is the one fact the table still cannot express, so the
// generator hardcodes them; a root it hardcodes and the table stops offering is
// a chain the generator no longer recognises, and a label rooted at it declares
// a top-level global instead. What the word *means* - a passthrough, `and`, or
// `not` - is no longer hardcoded anywhere: every chain word is the chain now.
TEST (ScriptTypesTest, TheChainRootsStillExistInTheTable) {
    std::set<std::string> labels;
    for (const auto& item : get_script_completions ()) {
        labels.insert (item.value ("label", ""));
    }
    EXPECT_TRUE (labels.count ("to.not")) << "the chain still declares `not`";
    EXPECT_TRUE (labels.count ("and"))
    << "`and` is a chain root the generator hardcodes - see CHAIN_ROOTS";
    EXPECT_TRUE (labels.count ("pm.expect"))
    << "generator types `expect` as opening the chain";

    // See LANGUAGE_CHAINS in script_types.cpp - chai's words that assert
    // nothing (issue #1053). Hardcoded there, so one dropped from the table is
    // a chain root the generator no longer recognises, and a label rooted at it
    // declares a top-level global instead.
    for (const char* word : { "also", "been", "but", "does", "has", "is", "of",
         "same", "still", "that", "which", "with" }) {
        EXPECT_TRUE (labels.count (word))
        << "generator types `" << word << "` as a language chain";
    }
}

// The runtime builds one object: `create_expectation` installs `to`, `be`,
// `have`, `at`, `not`, `deep`, `nested`, every language chain and every matcher
// on the same expectation, and every one of them hands that expectation back.
// So the declarations are one interface, and every chain word is that interface
// - which is what lets a matcher follow any of them. Declared as a path tree,
// `pm.expect(rows).to.be.an("array").and.not.empty` is an editor error on a
// script the runtime runs (issue #1209).
TEST (ScriptTypesTest, EveryChainWordCarriesTheWholeChain) {
    const std::string dts        = generate_script_typedefs ();
    const std::string chain_body = chain_interface_body (dts);
    ASSERT_FALSE (chain_body.empty ());

    // Every word a chain can be continued by, whether the table lists it in its
    // own right (`not`, `and`, the language chains) or only ever as a prefix of
    // a longer label (`be`, `have`, `at`, `deep`, `nested`, `all`).
    for (const char* word : { "to", "be", "have", "at", "and", "not", "deep",
         "nested", "all", "also", "been", "but", "does", "has", "is", "of",
         "same", "still", "that", "which", "with" }) {
        EXPECT_TRUE (contains (chain_body, std::string ("\t") + word + ": VayuExpectation;\n"))
        << word << " does not carry the chain, so no matcher can follow it";
    }

    // A language chain is a chain member, not a global: `that` reaching the
    // global scope would declare a top-level `that` nothing binds.
    EXPECT_FALSE (contains (dts, "declare const that"));
    EXPECT_FALSE (contains (dts, "declare function that"));
}

// One interface, so there is one place a member can be. The second one existed
// only to name what `.to.not` returned; every chain node is the same type now,
// so a chain word has nothing else to point at. Its absence is asserted rather
// than assumed - a half-collapsed generator that still emitted it would leave
// the paths it named reachable and the rest not.
TEST (ScriptTypesTest, TheChainIsOneInterface) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "interface VayuExpectation {"));
    EXPECT_FALSE (contains (dts, "VayuExpectTo"))
    << "the chain is declared as more than one interface again";

    // `pm.expect` opens the chain, which its own table entry does not say - see
    // forced_return. It carries `fail`, so it is a call signature beside its
    // members rather than a plain method (see the test below).
    EXPECT_TRUE (contains (dts, "(value: any, message?: string): VayuExpectation;"));
    // A matcher returns the chain, so a call stays chainable.
    EXPECT_TRUE (contains (dts, "equal(expected: any): VayuExpectation;"));
}

// The four chains issue #1209 reported, as the declarations the editor reads
// them through. Each was rejected with TS2339 against the two-interface shape
// because the member existed only under some other path: `match` under `to`
// alone, `not` under `to` alone, `equal` outside `be`, `empty` inside it. The
// docs-compile suite compiles the chains themselves; these pin the declarations
// they need, so a regression is located here rather than in a vitest diff.
TEST (ScriptTypesTest, TheChainDeclaresTheMembersItWasRejecting) {
    const std::string dts        = generate_script_typedefs ();
    const std::string chain_body = chain_interface_body (dts);
    ASSERT_FALSE (chain_body.empty ());

    EXPECT_TRUE (contains (chain_body, "\tmatch(regex: RegExp): VayuExpectation;\n"));
    EXPECT_TRUE (contains (chain_body, "\tnot: VayuExpectation;\n"));
    EXPECT_TRUE (contains (chain_body, "\tequal(expected: any): VayuExpectation;\n"));
    EXPECT_TRUE (contains (chain_body, "\tempty: VayuExpectation;\n"));
}

// The `()` in a label is what says whose members its children are. Read the
// `pm.cookies.jar()` way, `pm.expect.fail` would make `pm.expect(x)` return
// `{ fail }` - and every documented `pm.expect(x).to...` would stop compiling,
// which is the mutation this guards: restore the single
// `node.kind == KIND_FUNCTION || node.called` branch and the chain assertions
// below redden.
TEST (ScriptTypesTest, AFunctionsOwnMembersSitBesideItsCallSignature) {
    const std::string dts = generate_script_typedefs ();
    // `pm.expect.fail` - no `()` in the label, so `fail` is the function
    // object's own member and calling `pm.expect` still opens the chain.
    EXPECT_TRUE (contains (dts, "expect: {"));
    EXPECT_TRUE (contains (dts, "(value: any, message?: string): VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "fail(message?: string): never;"));
    EXPECT_FALSE (contains (dts, "expect(value: any, message?: string): {"));

    // `pm.cookies.jar().set` - the `()` says these are the members of what the
    // call returns, which is unchanged.
    EXPECT_TRUE (contains (dts, "jar(): {"));
}

// A getter that performs an assertion returns the chain - `expect_true` ends in
// `expect_chained (ctx, this_val)`, not `JS_UNDEFINED` - so `.to.be.true` is
// followable, and typing it `void` made `.to.be.true.and.equal(1)` an error on
// a script the runtime runs. That is also why the chain needs no vocabulary
// list any more: a terminal getter and a chain word have the same type, so
// nothing has to tell them apart. `field_type` still answers `void` for prose,
// which is right everywhere it is still asked - see AStringLiteralUnionIsAType.
TEST (ScriptTypesTest, TerminalAssertionGettersContinueTheChain) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "\ttrue: VayuExpectation;\n"));
    EXPECT_TRUE (contains (dts, "\texist: VayuExpectation;\n"));
    EXPECT_FALSE (contains (dts, "\ttrue: void;\n"));
    EXPECT_FALSE (contains (dts, "\texist: void;\n"));
}

/**
 * @brief The declared chain is the object `create_expectation` builds.
 *
 * This is the guard the enumerated chain pins above could not be: it reads the
 * interface's members out of the generated text and the object's out of the
 * real script engine, and fails on a member either side has alone. A matcher
 * added to `create_expectation` and not to the completion table is undeclared
 * and red-lines in the editor; a table label whose leaf the runtime does not
 * carry declares a member that throws by name at run time (the unknown-member
 * hook, #999). Both were previously invisible until someone wrote the chain.
 *
 * `Object.getOwnPropertyNames` rather than a walk that *reads* the members:
 * every terminal getter asserts on access, so enumerating values would run
 * eight assertions against the number 1 and throw on most of them.
 */
TEST (ScriptTypesTest, TheDeclaredChainIsTheObjectTheRuntimeBuilds) {
#ifdef VAYU_HAS_QUICKJS
    const std::string dts = generate_script_typedefs ();
    const std::set<std::string> declared = declared_members (chain_interface_body (dts));
    ASSERT_GT (declared.size (), 40u)
    << "the interface scan found nothing - it would agree with any runtime";

    std::string list;
    for (const std::string& name : declared) {
        list += (list.empty () ? "'" : ",'") + name + "'";
    }

    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;

    const auto result = engine.execute ("var declared = [" + list +
    "];\n"
    "var runtime = Object.getOwnPropertyNames(pm.expect(1));\n"
    "var undeclared = runtime.filter(function (n) { return declared.indexOf(n) "
    "< 0; });\n"
    "var absent = declared.filter(function (n) { return runtime.indexOf(n) < "
    "0; });\n"
    "if (runtime.length < 40) { throw new Error('the expectation looks "
    "empty'); }\n"
    "if (undeclared.length || absent.length) {\n"
    "  throw new Error('on the runtime and undeclared: [' + undeclared.join(', "
    "') +\n"
    "    '], declared and not on the runtime: [' + absent.join(', ') + ']');\n"
    "}\n",
    ctx);
    EXPECT_TRUE (result.success)
    << "the chain interface and create_expectation disagree: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// An optional field is `T | undefined` for any T the reader knows, not for the
// one pair someone happened to list. The list form carried `string | undefined`
// alone, so `pm.info.iteration` - documented as `number | undefined` - was
// declared `void`, and `pm.info.iteration + 1` was an error in the editor for a
// script the runtime runs happily.
TEST (ScriptTypesTest, OptionalFieldsKeepTheirUnderlyingType) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "iteration: number | undefined;"));
    EXPECT_TRUE (contains (dts, "iterationCount: number | undefined;"));
    // The pair that already worked must not regress on the way through.
    EXPECT_TRUE (contains (dts, "requestId: string | undefined;"));
    EXPECT_TRUE (contains (dts, "errorCode: string | undefined;"));
    // Prose is still not a type, and `void | undefined` is not one either.
    EXPECT_FALSE (contains (dts, "void | undefined"));
}

// A surface that has members has no union to carry `| undefined` in, so the
// optionality moves onto the property name. `pm.iterationData` is undefined
// outside a data-driven collection run - the documented, deliberate design -
// and the generated declarations described it as always present, so a plain
// request script calling `pm.iterationData.get('x')` got no squiggle for
// something that throws at run time.
TEST (ScriptTypesTest, AnOptionalSurfaceIsDeclaredOptional) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "iterationData?: {"))
    << "pm.iterationData is undefined outside a data-driven run and the "
       "declarations do not say so";

    // And the marker is not sprayed over every surface: the ones that are
    // always bound must stay required, or the declarations would invite a
    // needless guard on `pm.response` and `pm.info`.
    for (const char* required : { "response: {", "request: {", "info: {",
         "environment: {", "cookies: {", "execution: {" }) {
        EXPECT_TRUE (contains (dts, required))
        << required << " lost its always-present declaration";
    }
    EXPECT_FALSE (contains (dts, "response?: {"));
    EXPECT_FALSE (contains (dts, "info?: {"));
}

TEST (ScriptTypesTest, ReadsReturnTypesFromTheDetailString) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "get(name: string): string | undefined;"));
    EXPECT_TRUE (contains (dts, "toObject(): Record<string, any>;"));
    // A parameter whose own type contains a comma must not be split on it.
    EXPECT_TRUE (contains (dts, "satisfy(predicate: (value: any) => boolean)"));
}

// `pm.response.headers['content-type']` is the documented way to read a header,
// alongside `.get()`. Without the index signature the declarations would make
// the documented form an error.
TEST (ScriptTypesTest, ObjectFieldsStayIndexable) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "[key: string]: any;"));
}

// `length` is a call and a chain at run time (`length(3)`, `length.above(2)`),
// and the table says so by listing `to.have.length.within` under the call's own
// entry. Declared as a method alone, `.length.above(2)` would be an editor error
// for a script that runs; and a member that is only a call must stay one, so the
// rule is read off the table rather than applied to every function.
TEST (ScriptTypesTest, ACallTheTableContinuesIsDeclaredAsCallAndChain) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "\tlength: ((n: number) => VayuExpectation) & VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "\tlengthOf: ((n: number) => VayuExpectation) & VayuExpectation;"));
    // `include` and `contain` are chainable the same way (`.include.keys`,
    // `.contain.oneOf`), and the flag words they are followed by are chain
    // members like any other word.
    EXPECT_TRUE (contains (dts, "\tinclude: ((value: any) => VayuExpectation) & VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "\tcontain: ((value: any) => VayuExpectation) & VayuExpectation;"));
    for (const char* word : { "\tany: VayuExpectation;", "\town: VayuExpectation;",
         "\tordered: VayuExpectation;", "\tfinite: VayuExpectation;" }) {
        EXPECT_TRUE (contains (dts, word)) << word;
    }
    EXPECT_TRUE (contains (dts, "\townProperty(name: string, value?: any): VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "\tabove(n: number | Date): VayuExpectation;"));
    EXPECT_TRUE (contains (dts,
    "\twithin(start: number | Date, finish: number | Date): VayuExpectation;"));
}

// `pm.response.to.have.responseTime` is a call and a pm.expect chain on the
// time (`responseTime(120)`, `responseTime.below(200)`), and the table says so
// with a detail returning `VayuExpectation` (#2528). Declared as a method that
// returns the chain, `.responseTime.below(200)` would be an editor error for a
// script that runs; a pm.* call that returns anything else stays a method.
TEST (ScriptTypesTest, ACallThatAnswersTheChainIsDeclaredAsCallAndChain) {
    const std::string dts = generate_script_typedefs ();
    // `pm.response.to.have.*` sits four tabs in; `pm.response.to.not.have.*`,
    // the negated twin, five. The newline pins the depth.
    for (const char* member : { "responseTime", "responseSize" }) {
        const std::string declared = std::string (member) +
        ": ((value?: number) => VayuExpectation) & VayuExpectation;";
        EXPECT_TRUE (contains (dts, "\n\t\t\t\t" + declared)) << member;
        EXPECT_TRUE (contains (dts, "\n\t\t\t\t\t" + declared)) << member;
    }
    EXPECT_TRUE (contains (dts, "\n\t\t\t\tstatus(code: number | string): void;"));
}

// Two entries document an overload in prose TypeScript cannot parse
// (`upsert({ key, value }) | (name, value)`). Emitting that verbatim would
// produce a file that does not compile, taking every other declaration with it,
// so the reader falls back to a permissive signature and keeps the member.
TEST (ScriptTypesTest, UnparseableParameterListsFallBackRatherThanBreakTheFile) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "upsert(...args: any[])"));
    EXPECT_TRUE (contains (dts, "add(...args: any[])"));
}

// The declarations name the globals the sandbox lacks (`fetch`, `process`,
// Postman's bundled `cheerio`, ...) so that using one is an error the editor can
// explain, rather than the silence the app's suppression of "Cannot find name"
// would otherwise leave.
//
// A hand-written list of what a runtime does *not* have is exactly the kind
// that rots silently - nothing fails when the runtime gains one. So rather than
// trusting it, this runs `typeof <name>` in the real script engine for every
// entry. Give QuickJS a `fetch` and the test that claims it has none
// fails, which is the only honest way to hold this list to the sandbox.
//
// An absent root is found by the sentence every one of them carries, the one
// hover shows, rather than by its type.
TEST (ScriptTypesTest, DeclaredAbsentGlobalsAreGenuinelyAbsentFromTheRuntime) {
#ifdef VAYU_HAS_QUICKJS
    const std::string dts = generate_script_typedefs ();

    vayu::runtime::ScriptEngine engine{ vayu::tests::library_call_config () };
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;

    const std::string banner  = "Not available in the Vayu script sandbox.";
    const std::string declare = "declare const ";

    size_t checked = 0;
    // Read the names back out of the generated file rather than restating them,
    // so the test cannot agree with a stale copy of the list.
    for (size_t pos = dts.find (banner); pos != std::string::npos;
    pos             = dts.find (banner, pos + 1)) {
        const size_t decl = dts.find (declare, pos);
        ASSERT_NE (decl, std::string::npos)
        << "an absent global has no declaration";
        const size_t start = decl + declare.size ();
        const std::string name = dts.substr (start, dts.find (':', start) - start);

        const auto result = engine.execute ("pm.__t = typeof " + name + ";", ctx);
        EXPECT_TRUE (result.success)
        << "probing '" << name << "' threw: " << result.error_message;
        const auto again = engine.execute (
        "if (typeof " + name + " !== 'undefined') { throw new Error('present'); }", ctx);
        EXPECT_TRUE (again.success)
        << "'" << name << "' is declared absent but the runtime has it - "
        << "remove it from ABSENT_GLOBALS (" << again.error_message << ")";
        checked++;
    }

    EXPECT_GT (checked, 15u)
    << "too few absent globals were probed - the scan found nothing";
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The other direction (#2578): every module the declarations say `require()`
// loads, the real script engine loads, so the editor cannot type a line the
// runtime refuses.
TEST (ScriptTypesTest, EveryDeclaredModuleLoadsInTheRuntime) {
#ifdef VAYU_HAS_QUICKJS
    const std::string dts = generate_script_typedefs ();

    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;

    const std::string declare = "declare module '";
    size_t checked            = 0;
    for (size_t pos = dts.find (declare); pos != std::string::npos;
    pos             = dts.find (declare, pos + 1)) {
        const size_t start = pos + declare.size ();
        const std::string name = dts.substr (start, dts.find ('\'', start) - start);
        // crypto-js is an object; uuid is callable, as Postman's is.
        const auto result = engine.execute ("const type = typeof require('" + name +
        "'); if (type !== 'object' && type !== 'function') "
        "throw new Error('not a module');",
        ctx);
        EXPECT_TRUE (result.success)
        << "'" << name << "' is declared loadable but require() refuses it ("
        << result.error_message << ")";
        checked++;
    }
    EXPECT_GE (checked, 1u)
    << "no module declaration was found - the scan read nothing";
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The first direction above cannot see a module `require()` loads that the
// declarations omit: it would read clean in the engine and be "Cannot find
// module" in the editor. Every name the runtime accepts has a block.
TEST (ScriptTypesTest, EveryRuntimeShelfModuleIsDeclaredAsAModule) {
    const std::string dts = generate_script_typedefs ();
    for (const std::string_view name : vayu::runtime::SHELF_MODULE_NAMES) {
        EXPECT_TRUE (contains (dts, "\ndeclare module '" + std::string (name) + "' {\n"))
        << "require('" << name << "') loads but the editor has no module for it";
    }
}

/**
 * @brief The documentation comment directly above @p declaration, or empty.
 *
 * A reason is only worth having if hover shows it, so the replacement tests
 * below read it from the comment the declaration carries rather than from the
 * table.
 */
std::string documentation_above (const std::string& dts, const std::string& declaration) {
    const size_t at = dts.find (declaration);
    if (at == std::string::npos) {
        return {};
    }
    const size_t open = dts.rfind ("/**", at);
    return open == std::string::npos ? std::string{} : dts.substr (open, at - open);
}

// The libraries Postman bundles (#2576), each with the replacement Postman
// itself names (`LEGACY_GLOBS_ALTERNATIVES` in postman-sandbox). A script
// imported from Postman reaches for these by habit, and the editor says what
// to write instead on hover. Postman's pre-`pm.*` globals left this list when
// they started running (#2577), `CryptoJS` when the require() shelf did
// (#2578), `_` when lodash joined it (#2651), `moment` when it did (#2652;
// Postman binds no global of that name, only require('moment')),
// `xml2Json` when xml2js did (#2654) and `tv4` when it and ajv did (#2656).
//
// The pairs are pinned here rather than read from the table, so a name dropped
// from it, or reworded until it no longer names the replacement, fails. A name
// leaves this list in the commit that makes Vayu run it, and not before.
TEST (ScriptTypesTest, EveryPostmanBundledLibraryIsAbsentAndNamesItsReplacement) {
    const std::string dts = generate_script_typedefs ();

    struct Legacy {
        const char* name;
        const char* replacement;
    };
    constexpr auto globals = std::to_array<Legacy> ({
    { "cheerio", "require('cheerio')" },
    { "Backbone", "Backbone" },
    });
    for (const auto& legacy : globals) {
        const std::string doc =
        documentation_above (dts, std::string ("declare const ") + legacy.name + ":");
        EXPECT_TRUE (contains (doc, "Not available in the Vayu script sandbox."))
        << legacy.name << " is not declared absent";
        EXPECT_TRUE (contains (doc, legacy.replacement))
        << legacy.name << "'s hover does not name " << legacy.replacement;
    }
}

// The `postman` object runs (#2577): each method is an alias of the `pm.*`
// member Postman names as its replacement, so it is declared as the method it
// is, and its hover names what it aliases. Pinned here rather than read from
// the table, so a method dropped from it, or the object declared absent
// again, fails.
TEST (ScriptTypesTest, ThePostmanObjectDeclaresTheAliasesItRuns) {
    const std::string dts = generate_script_typedefs ();

    struct Alias {
        const char* signature;
        const char* target;
    };
    constexpr auto methods = std::to_array<Alias> ({
    { "setEnvironmentVariable(name: string, value: any): void;", "pm.environment.set(" },
    { "getEnvironmentVariable(name: string): any | undefined;", "pm.environment.get(" },
    { "clearEnvironmentVariable(name: string): void;", "pm.environment.unset(" },
    { "clearEnvironmentVariables(): void;", "pm.environment.clear(" },
    { "setGlobalVariable(name: string, value: any): void;", "pm.globals.set(" },
    { "getGlobalVariable(name: string): any | undefined;", "pm.globals.get(" },
    { "clearGlobalVariable(name: string): void;", "pm.globals.unset(" },
    { "clearGlobalVariables(): void;", "pm.globals.clear(" },
    { "setNextRequest(name: string | null): void;", "pm.execution.setNextRequest(" },
    { "getResponseHeader(name: string): string | undefined;", "pm.response.headers.get(" },
    { "getResponseCookie(name: string): {", "pm.cookies.get(" },
    });
    for (const auto& method : methods) {
        const std::string declaration = std::string ("\n\t") + method.signature;
        EXPECT_TRUE (contains (dts, declaration))
        << "postman." << method.signature << " is not declared";
        EXPECT_TRUE (contains (documentation_above (dts, declaration), method.target))
        << "postman." << method.signature << "'s hover does not name " << method.target;
    }

    const std::string root = documentation_above (dts, "declare const postman: {\n");
    EXPECT_FALSE (root.empty ()) << "the postman object is not declared";
    EXPECT_FALSE (contains (root, "Not available in the Vayu script sandbox."));
}

// Postman's pre-`pm.*` globals run (#2577), so each is declared as the value
// it is: `JSON.parse(responseBody)`, `responseTime < 200` and
// `iteration + 1` are correct code, and the editor must not flag them. Pinned
// here so a global declared absent again, or as a type that makes its
// ordinary use an error, fails.
TEST (ScriptTypesTest, ThePostmanLegacyGlobalsAreDeclaredAsTheValuesTheyAre) {
    const std::string dts       = generate_script_typedefs ();
    constexpr auto declarations = std::to_array<const char*> ({
    "declare const tests: { [key: string]: any };\n",
    "declare const responseBody: string;\n",
    "declare const responseTime: number;\n",
    "declare const responseHeaders: { [key: string]: any };\n",
    "declare const responseCookies: { [key: string]: any }[];\n",
    "declare const environment: { [key: string]: any };\n",
    "declare const globals: { [key: string]: any };\n",
    "declare const data: { [key: string]: any };\n",
    "declare const iteration: number;\n",
    "declare const responseCode: {\n",
    "declare const request: {\n",
    });
    for (const char* declaration : declarations) {
        EXPECT_TRUE (contains (dts, declaration)) << declaration << "is not declared";
        EXPECT_FALSE (contains (documentation_above (dts, declaration),
        "Not available in the Vayu script sandbox."))
        << declaration << "is still declared absent";
    }
    EXPECT_TRUE (contains (dts, "\tcode: number;\n"));
    EXPECT_TRUE (contains (dts, "\turl: string;\n"));
    // What stays absent stays `never`.
    EXPECT_TRUE (contains (dts, "declare const fetch: never;\n"));
    EXPECT_TRUE (contains (dts, "declare const cheerio: never;\n"));
}

// `require` and crypto-js run (#2578), so they are declared as what they are:
// `require('crypto-js')` answers the `CryptoJS` global's type, a name off the
// shelf is a type error at the call, and a hasher's result has the
// `toString(encoder)` every signing script calls.
TEST (ScriptTypesTest, TheRequireShelfIsDeclaredAsWhatItLoads) {
    const std::string dts = generate_script_typedefs ();

    // One signature keyed on the shelf's names, so a name off the shelf is a
    // type error at the call, and each module answers its own declaration.
    const std::string require =
    "declare function require<N extends keyof VayuShelfModules>(name: N): "
    "VayuShelfModules[N];\n";
    EXPECT_TRUE (contains (dts, require));
    EXPECT_FALSE (contains (documentation_above (dts, require),
    "Not available in the Vayu script sandbox."));
    EXPECT_TRUE (contains (dts,
    "interface VayuShelfModules {\n\t'crypto-js': typeof import('crypto-js');\n"
    "\t'uuid': typeof import('uuid');\n"
    "\t'lodash': typeof import('lodash');\n"
    "\t'moment': typeof import('moment');\n"
    "\t'csv-parse/lib/sync': typeof import('csv-parse/lib/sync');\n"
    "\t'xml2js': typeof import('xml2js');\n"
    "\t'chai': typeof import('chai');\n"
    "\t'ajv': typeof import('ajv');\n"
    "\t'tv4': typeof import('tv4');\n}\n"));

    const std::string crypto_js = "declare const CryptoJS: {\n";
    EXPECT_TRUE (contains (dts, crypto_js));
    EXPECT_FALSE (contains (documentation_above (dts, crypto_js),
    "Not available in the Vayu script sandbox."));
    EXPECT_TRUE (contains (dts,
    "\tHmacSHA256(message: string | object, key: string | object): { words: "
    "number[], sigBytes: number, toString(encoder?: { stringify(wordArray: "
    "any): "
    "string }): string,"));
    EXPECT_TRUE (contains (dts, "\t\tBase64: {\n"));
    // `const lib = require('crypto-js')`, which the editor reads as an import.
    EXPECT_TRUE (contains (dts, "declare module 'crypto-js' {\n\texport = CryptoJS;\n}\n"));
}

// lodash runs (#2651): `_` is declared as a value, not as an absent name, and
// `require('lodash')` answers the same declaration. `any`, because a partial
// list of lodash's members would flag the rest on correct code.
TEST (ScriptTypesTest, LodashIsDeclaredAsTheGlobalAndTheModule) {
    const std::string dts = generate_script_typedefs ();

    const std::string lodash = "declare const _: any;\n";
    EXPECT_TRUE (contains (dts, lodash));
    const std::string doc = documentation_above (dts, lodash);
    EXPECT_TRUE (contains (doc, "lodash 4.17.21")) << doc;
    EXPECT_FALSE (contains (doc, "Not available in the Vayu script sandbox."));
    EXPECT_FALSE (contains (dts, "declare const _: never;"));
    EXPECT_TRUE (contains (dts, "declare module 'lodash' {\n\texport = _;\n}\n"));
}

// moment runs (#2652), but only as `require('moment')`: Postman binds no
// `moment` global, so none is declared (neither a value nor an absent name) and
// the module carries its own declaration. `any`, as lodash's is.
TEST (ScriptTypesTest, MomentIsDeclaredAsAModuleAndNotAsAGlobal) {
    const std::string dts = generate_script_typedefs ();

    EXPECT_TRUE (contains (
    dts, "declare module 'moment' {\n\tconst moment: any;\n\texport = moment;\n}\n"));
    EXPECT_FALSE (contains (dts, "declare const moment"));
}

// csv-parse runs (#2653) as `require('csv-parse/lib/sync')`, whose value is the
// parse function itself; Postman binds no global for it and exposes no other
// path, so only that module is declared. The input is a string, as the vendored
// build reads no Buffer.
TEST (ScriptTypesTest, CsvParseIsDeclaredAsItsSyncPathOnly) {
    const std::string dts = generate_script_typedefs ();

    EXPECT_TRUE (contains (dts,
    "declare module 'csv-parse/lib/sync' {\n\tconst parse: (input: string, "
    "options?: { [option: string]: unknown }) => any;\n\texport = "
    "parse;\n}\n"));
    EXPECT_FALSE (contains (dts, "declare module 'csv-parse' {"));
}

// xml2js runs (#2654) as `require('xml2js')` and as Postman's `xml2Json`
// global, which is a function over the module rather than the module: so the
// global is declared from its own entry as the call it is, and the module
// carries its own declaration. Each declared member is pinned to the kind the
// runtime gives it, so a member the module lacks fails here rather than in a
// script.
TEST (ScriptTypesTest, Xml2jsIsDeclaredAsTheModuleAndXml2JsonAsItsParse) {
    const std::string dts = generate_script_typedefs ();

    const std::string xml2json =
    "declare function xml2Json(xml: string): any;\n";
    EXPECT_TRUE (contains (dts, xml2json));
    const std::string doc = documentation_above (dts, xml2json);
    EXPECT_TRUE (contains (doc, "xml2js 0.6.2")) << doc;
    EXPECT_FALSE (contains (doc, "Not available in the Vayu script sandbox."));
    EXPECT_FALSE (contains (dts, "declare const xml2Json"));

    const size_t open = dts.find ("declare module 'xml2js' {\n");
    ASSERT_NE (open, std::string::npos);
    const std::string body = dts.substr (open, dts.find ("\n}\n", open) - open);
    EXPECT_TRUE (contains (body, "\texport = xml2js;"));

    struct Member {
        const char* declaration;
        const char* path;
        const char* runtime_type;
    };
    constexpr auto members = std::to_array<Member> ({
    { "\t\tparseString(xml: string, callback?: Callback): unknown;", "parseString", "function" },
    { "\t\tparseStringPromise(xml: string, options?: Options): Promise<any>;",
    "parseStringPromise", "function" },
    { "\t\tParser: new (options?: Options) => any;", "Parser", "function" },
    { "\t\tBuilder: new (options?: Options) => {", "Builder", "function" },
    { "\t\tValidationError: new (message: string) => Error;", "ValidationError", "function" },
    { "\t\tdefaults: { '0.1': Options; '0.2': Options };", "defaults['0.2']", "object" },
    { "\t\t\tnormalize: Processor;", "processors.normalize", "function" },
    { "\t\t\tfirstCharLowerCase: Processor;", "processors.firstCharLowerCase", "function" },
    { "\t\t\tstripPrefix: Processor;", "processors.stripPrefix", "function" },
    { "\t\t\tparseNumbers: Processor;", "processors.parseNumbers", "function" },
    { "\t\t\tparseBooleans: Processor;", "processors.parseBooleans", "function" },
    });
#ifdef VAYU_HAS_QUICKJS
    vayu::runtime::ScriptEngine engine{ vayu::tests::library_call_config () };
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment   = &env;
    const auto builds = engine.execute (
    "if (typeof new (require('xml2js').Builder)().buildObject !== 'function' "
    "|| "
    "typeof new (require('xml2js').Builder)().options !== 'object') throw new "
    "Error('wrong kind');",
    ctx);
    EXPECT_TRUE (builds.success) << builds.error_message;
#endif
    for (const auto& member : members) {
        EXPECT_TRUE (contains (body, member.declaration))
        << member.declaration << " is not declared";
#ifdef VAYU_HAS_QUICKJS
        const auto result =
        engine.execute (std::string ("if (typeof require('xml2js').") + member.path +
        " !== '" + member.runtime_type + "') throw new Error('wrong kind');",
        ctx);
        EXPECT_TRUE (result.success)
        << "xml2js." << member.path << " is not a " << member.runtime_type
        << " at run time (" << result.error_message << ")";
#endif
    }
}

// chai runs (#2655) as require('chai') only, with no global, so the module
// carries its own declaration: chai's top-level members, an assertion chain
// as `any`. Each declared member is pinned to the kind the runtime gives it,
// so a member the module lacks fails here rather than in a script.
TEST (ScriptTypesTest, ChaiIsDeclaredAsTheLibrarysTopLevelMembers) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_FALSE (contains (dts, "declare const chai"));

    const size_t open = dts.find ("declare module 'chai' {\n");
    ASSERT_NE (open, std::string::npos);
    const std::string body = dts.substr (open, dts.find ("\n}\n", open) - open);
    EXPECT_TRUE (contains (body, "\texport = chai;"));

    struct Member {
        const char* declaration;
        const char* path;
        const char* runtime_type;
    };
    constexpr auto members = std::to_array<Member> ({
    { "\t\texpect: ExpectStatic;", "expect", "function" },
    { "\t\tfail(message?: string): never;", "expect.fail", "function" },
    { "\t\tassert: AssertStatic;", "assert", "function" },
    { "\t\tshould(): any;", "should", "function" },
    { "\t\tShould(): any;", "Should", "function" },
    { "\t\tuse(plugin: (chai: any, utils: any) => void): Chai;", "use", "function" },
    { "\t\t\tincludeStack: boolean;", "config.includeStack", "boolean" },
    { "\t\t\tshowDiff: boolean;", "config.showDiff", "boolean" },
    { "\t\t\ttruncateThreshold: number;", "config.truncateThreshold", "number" },
    { "\t\t\tuseProxy: boolean;", "config.useProxy", "boolean" },
    { "\t\t\tproxyExcludedKeys: string[];", "config.proxyExcludedKeys", "object" },
    { "\t\t\tdeepEqual: ((expected: unknown, actual: unknown) => boolean) | "
      "null;",
    "config.deepEqual", "object" },
    { "\t\tAssertionError: new (", "AssertionError", "function" },
    { "\t\tAssertion: any;", "Assertion", "function" },
    { "\t\tutil: any;", "util", "object" },
    { "\t\tversion: string;", "version", "string" },
    });
#ifdef VAYU_HAS_QUICKJS
    vayu::runtime::ScriptEngine engine{ vayu::tests::library_call_config () };
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment   = &env;
    const auto errors = engine.execute (
    "var e = new (require('chai').AssertionError)('m', { actual: 1 }); if "
    "(typeof e.showDiff !== 'boolean' || e.actual !== 1 || !(e instanceof "
    "Error)) throw new Error('wrong kind');",
    ctx);
    EXPECT_TRUE (errors.success) << errors.error_message;
#endif
    for (const auto& member : members) {
        EXPECT_TRUE (contains (body, member.declaration))
        << member.declaration << " is not declared";
#ifdef VAYU_HAS_QUICKJS
        const auto result =
        engine.execute (std::string ("if (typeof require('chai').") + member.path +
        " !== '" + member.runtime_type + "') throw new Error('wrong kind');",
        ctx);
        EXPECT_TRUE (result.success)
        << "chai." << member.path << " is not a " << member.runtime_type
        << " at run time (" << result.error_message << ")";
#endif
    }
}

// ajv runs (#2656) as require('ajv') only, with no global, so the module
// carries its own declaration: the Ajv constructor and an instance's methods.
// Each declared member is pinned to the kind the runtime gives it, so a member
// the module lacks fails here rather than in a script.
TEST (ScriptTypesTest, AjvIsDeclaredAsTheConstructorAndItsInstance) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_FALSE (contains (dts, "declare const Ajv"));

    const size_t open = dts.find ("declare module 'ajv' {\n");
    ASSERT_NE (open, std::string::npos);
    const std::string body = dts.substr (open, dts.find ("\n}\n", open) - open);
    EXPECT_TRUE (contains (body, "\texport = Ajv;"));
    EXPECT_TRUE (contains (body, "\t\tnew (options?: Options): Ajv;\n"));
    EXPECT_TRUE (contains (body, "\t\t(options?: Options): Ajv;\n"));
    EXPECT_TRUE (contains (body, "\t\terrors?: ErrorObject[] | null;\n"));

    struct Member {
        const char* declaration;
        const char* path;
        const char* runtime_type;
    };
    constexpr auto members = std::to_array<Member> ({
    { "\t\tvalidate(schemaKeyRef: ", "validate", "function" },
    { "\t\tcompile(schema: object | boolean): ValidateFunction;", "compile", "function" },
    { "\t\tcompileAsync(schema: ", "compileAsync", "function" },
    { "\t\taddSchema(schema: ", "addSchema", "function" },
    { "\t\taddMetaSchema(schema: ", "addMetaSchema", "function" },
    { "\t\tvalidateSchema(schema: ", "validateSchema", "function" },
    { "\t\tgetSchema(keyRef: ", "getSchema", "function" },
    { "\t\tremoveSchema(schemaKeyRef?: ", "removeSchema", "function" },
    { "\t\taddFormat(name: ", "addFormat", "function" },
    { "\t\taddKeyword(keyword: ", "addKeyword", "function" },
    { "\t\tgetKeyword(keyword: ", "getKeyword", "function" },
    { "\t\tremoveKeyword(keyword: ", "removeKeyword", "function" },
    { "\t\tvalidateKeyword(definition: ", "validateKeyword", "function" },
    { "\t\terrorsText(errors?: ", "errorsText", "function" },
    });
#ifdef VAYU_HAS_QUICKJS
    vayu::runtime::ScriptEngine engine{ vayu::tests::library_call_config () };
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;
    // The validator, the statics and both error classes are what they are
    // declared as.
    const auto statics = engine.execute (
    "var Ajv = require('ajv'); var v = new Ajv().compile({ type: 'string' }); "
    "if (v(1) !== false || !Array.isArray(v.errors) || typeof "
    "v.errors[0].keyword !== 'string' || typeof v.errors[0].dataPath !== "
    "'string' || typeof v.errors[0].schemaPath !== 'string' || typeof "
    "v.errors[0].params !== 'object' || typeof v.errors[0].message !== "
    "'string' || typeof Ajv().compile !== 'function' || !(new "
    "Ajv.ValidationError([]) instanceof Error) || !(new "
    "Ajv.MissingRefError('a', 'b') instanceof Error)) throw new "
    "Error('wrong kind');",
    ctx);
    EXPECT_TRUE (statics.success) << statics.error_message;
#endif
    for (const auto& member : members) {
        EXPECT_TRUE (contains (body, member.declaration))
        << member.declaration << " is not declared";
#ifdef VAYU_HAS_QUICKJS
        const auto result = engine.execute (
        std::string ("if (typeof new (require('ajv'))().") + member.path +
        " !== '" + member.runtime_type + "') throw new Error('wrong kind');",
        ctx);
        EXPECT_TRUE (result.success)
        << "an Ajv's " << member.path << " is not a " << member.runtime_type
        << " at run time (" << result.error_message << ")";
#endif
    }
}

// tv4 runs (#2656) as the tv4 global and require('tv4'), one object, so the
// global is declared from its completions and the module points at it, as
// lodash's does. Every member tv4 1.3.0 defines is declared, as the kind the
// runtime gives it, so a call that runs is never an editor error.
TEST (ScriptTypesTest, Tv4IsDeclaredAsTheGlobalTheModuleAnswers) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "declare module 'tv4' {\n\texport = tv4;\n}"));

    const std::string root = "declare const tv4: {\n";
    const size_t open      = dts.find (root);
    ASSERT_NE (open, std::string::npos);
    EXPECT_FALSE (contains (documentation_above (dts, root),
    "Not available in the Vayu script sandbox."));
    const std::string body = dts.substr (open, dts.find ("\n};\n", open) - open);
    EXPECT_TRUE (contains (body,
    "\tvalidate(data: unknown, schema: object | boolean | string, "
    "checkRecursive?: boolean, banUnknownProperties?: boolean): boolean;\n"));
    EXPECT_TRUE (contains (body, "\terror: any;\n"));
    EXPECT_TRUE (contains (body, "\tmissing: string[];\n"));
    EXPECT_TRUE (contains (body, "\tvalid: boolean;\n"));

    constexpr auto members =
    std::to_array<std::string_view> ({ "setErrorReporter", "addFormat", "language",
    "addLanguage", "freshApi", "validate", "validateResult", "validateMultiple",
    "addSchema", "getSchema", "getSchemaMap", "getSchemaUris", "getMissingUris",
    "dropSchemas", "defineKeyword", "defineError", "reset", "missing", "error",
    "valid", "normSchema", "resolveUrl", "getDocumentUri", "errorCodes", "tv4" });
    for (const std::string_view member : members) {
        EXPECT_TRUE (contains (body, "\t" + std::string (member) + "(") ||
        contains (body, "\t" + std::string (member) + ": "))
        << "tv4." << member << " is not declared";
    }
#ifdef VAYU_HAS_QUICKJS
    vayu::runtime::ScriptEngine engine{ vayu::tests::library_call_config () };
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;
    // The members are tv4's own keys, no more and no fewer; the fields hold
    // what they are declared as once a validate has run.
    std::string keys;
    for (const std::string_view member : members) {
        keys += (keys.empty () ? "" : ",") + std::string (member);
    }
    const auto result = engine.execute ("tv4.validate(1, { type: 'string' }); "
                                        "if (Object.keys(tv4).join() !== '" +
    keys +
    "' || !Array.isArray(tv4.missing) || typeof tv4.valid !== 'boolean' || "
    "typeof tv4.error.message !== 'string' || typeof tv4.errorCodes !== "
    "'object') throw new Error('wrong kind');",
    ctx);
    EXPECT_TRUE (result.success) << result.error_message;
#endif
}

// uuid has no global to point at (#2650), so its module carries the whole
// declaration: callable, with npm's members on it. Each member is pinned to
// the kind the runtime gives it, so a declared member the module lacks (or a
// function declared as a constant) fails here rather than in a script.
TEST (ScriptTypesTest, TheUuidModuleDeclaresWhatTheRuntimeGivesIt) {
    const std::string dts = generate_script_typedefs ();
    const size_t open     = dts.find ("declare module 'uuid' {\n");
    ASSERT_NE (open, std::string::npos);
    const std::string body = dts.substr (open, dts.find ("\n}\n", open) - open);

    EXPECT_TRUE (contains (body, "\tconst uuid: Randomised<RandomOptions> & {"));
    EXPECT_TRUE (contains (body, "\texport = uuid;"));

    struct Member {
        const char* declaration;
        const char* name;
        const char* runtime_type;
    };
    constexpr auto members = std::to_array<Member> ({
    { "\t\tv1: ", "v1", "function" },
    { "\t\tv3: FromName;", "v3", "function" },
    { "\t\tv4: ", "v4", "function" },
    { "\t\tv5: FromName;", "v5", "function" },
    { "\t\tNIL: string;", "NIL", "string" },
    { "\t\tparse(uuid: string): Uint8Array;", "parse", "function" },
    { "\t\tstringify(bytes: Bytes, offset?: number): string;", "stringify", "function" },
    { "\t\tvalidate(uuid: unknown): boolean;", "validate", "function" },
    { "\t\tversion(uuid: string): number;", "version", "function" },
    });
#ifdef VAYU_HAS_QUICKJS
    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;
#endif
    for (const auto& member : members) {
        EXPECT_TRUE (contains (body, member.declaration))
        << member.declaration << " is not declared";
#ifdef VAYU_HAS_QUICKJS
        const auto result =
        engine.execute (std::string ("if (typeof require('uuid').") + member.name +
        " !== '" + member.runtime_type + "') throw new Error('wrong kind');",
        ctx);
        EXPECT_TRUE (result.success)
        << "uuid." << member.name << " is not a " << member.runtime_type
        << " at run time (" << result.error_message << ")";
#endif
    }
}

// `pm.cookies.jar` is listed in its own right *and* is the parent of the
// `pm.cookies.jar().set` labels. Emitted separately those were two `jar`
// members - `jar(): object` sorting ahead of `jar(): {...}` - and TypeScript
// resolves a call against the first, so every line of the documented jar block
// was "Property 'set' does not exist on type 'object'". Nine of the twelve
// errors this file's compile guard now catches were that one member.
TEST (ScriptTypesTest, AListedCallIsMergedWithTheMembersItsLabelsImply) {
    const std::string dts = generate_script_typedefs ();

    // Declaration lines only - the documentation comments name
    // `pm.cookies.jar()` too, and those are not members.
    size_t members = 0;
    std::istringstream lines (dts);
    for (std::string line; std::getline (lines, line);) {
        const size_t first = line.find_first_not_of ('\t');
        if (first != std::string::npos && line.compare (first, 4, "jar(") == 0) {
            members++;
        }
    }
    EXPECT_EQ (members, 1u)
    << "pm.cookies.jar is declared more than once, and "
       "the call resolves against whichever sorts first";

    // The one that survives must be the one carrying the members, not the
    // `object` leaf - `pm.cookies.jar().set(...)` is the documented form.
    EXPECT_TRUE (contains (dts, "jar(): {")) << "pm.cookies.jar() returns an "
                                                "opaque object, so its methods "
                                                "are unreachable";
    EXPECT_FALSE (contains (dts, "jar(): object;"));
    // The segment is stripped, not carried into the declaration.
    EXPECT_FALSE (contains (dts, "jar()()"));
}

// `parse_signature` took the *first* `(` in the detail, which for every jar
// entry is the empty one in `jar()`: the parameter list read as empty and the
// text after it did not start with `:`, so the return type went too. Signature
// help was not merely wrong but inverted - "takes nothing", about a method that
// requires a URL.
TEST (ScriptTypesTest, ACallInsideALabelDoesNotEmptyTheSignature) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts,
    "get(url: string, name: string, callback?: "
    "Function): string | undefined;"));
    EXPECT_TRUE (contains (dts, "getAll(url: string, callback?: Function): object[];"));
    EXPECT_TRUE (contains (dts, "unset(url: string, name: string, callback?: Function): string;"));
    EXPECT_TRUE (contains (dts, "clear(url?: string, callback?: Function): void;"));
    // The flat `set(url, name, value)` form the docs also show has to fit the
    // one signature the table can express.
    EXPECT_TRUE (contains (dts,
    "set(url: string, cookie: object | string, "
    "value?: string | Function, callback?: Function): object;"));
    // The tab is the start of the member name: tv4's `reset(): void` is not
    // an emptied `set`.
    EXPECT_FALSE (contains (dts, "\tget(): void;"));
    EXPECT_FALSE (contains (dts, "\tset(): void;"));
    EXPECT_FALSE (contains (dts, "\tgetAll(): void;"));
}

// A closed set of strings is a type, and `field_type` called it prose. So
// `pm.info.eventName` was `void`, and the first example in its own section -
// `pm.info.eventName === 'prerequest'` - was a comparison between types with no
// overlap.
TEST (ScriptTypesTest, AStringLiteralUnionIsAType) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "eventName: 'prerequest' | 'test' | 'setup' | 'teardown';"));
    // And prose is still not one: a getter restating its own dotted name must
    // not start being read as a type because it contains quotes. The example is
    // from `pm.response.to.have.status`, which is a different object with its
    // own chain - `field_type` is unchanged, and the chain collapse (#1209)
    // deliberately did not reach it.
    EXPECT_TRUE (contains (dts, "ok: void;"));
}

// `deep` is a flag-setting getter on the one chain object, so the runtime has
// always answered `.to.deep.include`; the table listed `deep` with `equal`
// alone, and the declarations are derived from the table. The docs' own
// `pm.expect(value).to.deep.include({ a: 1 })` was "Property 'include' does not
// exist", and `have.property(name, value)` - which the runtime accepts and
// `nested.property` already declared - was "expected 1 arguments, but got 2".
TEST (ScriptTypesTest, TheChainDeclaresWhatTheDocsClaimAndTheRuntimeAnswers) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "property(name: string, value?: any): VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "include: ((value: any) => VayuExpectation) & VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "members(values: any[]): VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "oneOf(values: any[]): VayuExpectation;"));
}

// A `T[]` detail declares an array of T, not `void`. Without the suffix rule a
// list member falls through to the prose branch, and every `for (const e of
// pm.response.events)` in a correct script becomes an editor error - the same
// class of silent mis-declaration `number | undefined` fixed for
// `pm.info.iteration`.
TEST (ScriptTypesTest, AListFieldDeclaresAnArrayOfItsElementType) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "events: { [key: string]: any }[] | undefined;"))
    << "pm.response.events is `object[] | undefined` in the table; a member "
       "typed `void` here would make every use of it an error in the editor";
}

/**
 * The generated declarations, checked in so a test with a TypeScript compiler
 * can read them without a running engine.
 *
 * `app/src/hooks/script-typedefs.docs-compile.test.ts` compiles the 54 `pm.*`
 * blocks in `docs/engine/scripting.md` and `docs/app/pm-api-compatibility.md`
 * against this file and requires zero errors - the guard that found all four
 * defects above, and the only one that could have: a declaration can contain
 * every right name and still not type-check, which is what
 * `EveryListedMemberReachesTheOutput` above proves and nothing more.
 *
 * That test needs a TypeScript compiler, which ctest does not have, and this
 * suite is where the generator lives, which vitest cannot reach. So the two
 * halves meet at one checked-in artifact - the same shape as
 * `variable-resolution-conformance.json`, read by this suite and by
 * `variable-resolution.conformance.test.ts`.
 *
 * A generated artifact under version control drifts unless something pins it,
 * which is what this test is. Regenerate deliberately:
 *
 *     VAYU_UPDATE_SCRIPT_TYPEDEFS=1 ctest --preset linux-dev -R ScriptTypes
 *
 * and commit the result, so a change to the surface shows up as a diff in the
 * declarations the editor will serve.
 */
// Reading the fixture through `istreambuf_iterator`: GCC cannot see that the
// stream we just asserted `good()` on has a buffer. See utils/diagnostics.hpp.
VAYU_IGNORE_FALSE_NULL_DEREFERENCE
TEST (ScriptTypesTest, TheCheckedInDeclarationsMatchTheGenerator) {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "script-typedefs.d.ts";
    const std::string generated = generate_script_typedefs ();

    if (env_is_set ("VAYU_UPDATE_SCRIPT_TYPEDEFS")) {
        std::ofstream out (path, std::ios::binary);
        ASSERT_TRUE (out.good ()) << "cannot write fixture: " << path;
        out << generated;
        out.close ();
        GTEST_SKIP () << "regenerated " << path;
    }

    std::ifstream in (path, std::ios::binary);
    ASSERT_TRUE (in.good ()) << "fixture missing: " << path;
    const std::string checked_in (
    (std::istreambuf_iterator<char> (in)), std::istreambuf_iterator<char> ());

    // A fixture that had been emptied would compile every doc block trivially.
    EXPECT_GT (checked_in.size (), 20000u)
    << "the checked-in declarations look empty - the app-side compile guard "
       "would prove nothing against them";
    EXPECT_EQ (checked_in, generated)
    << "the checked-in declarations are stale. Regenerate with "
       "VAYU_UPDATE_SCRIPT_TYPEDEFS=1 ctest --preset linux-dev -R ScriptTypes";
}
VAYU_DIAGNOSTIC_POP

// Documentation is what hover text renders; a `*/` inside it would close the
// comment early and drop every declaration after it.
TEST (ScriptTypesTest, DocumentationIsEmittedAndCannotCloseTheCommentEarly) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "/**"));
    EXPECT_FALSE (contains (dts, "*/*"));

    size_t opens  = 0;
    size_t closes = 0;
    for (size_t i = 0; i + 1 < dts.size (); i++) {
        if (dts.compare (i, 3, "/**") == 0) {
            opens++;
        } else if (dts.compare (i, 2, "*/") == 0) {
            closes++;
        }
    }
    EXPECT_EQ (opens, closes)
    << "unbalanced JSDoc comments would swallow declarations";
}

} // namespace
