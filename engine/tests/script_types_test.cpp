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
//   - the chain vocabulary still exists in the table (see CHAIN_CONTINUATIONS
//     in script_types.cpp: a renamed `.to.not` would become `void` and take
//     every `.to.not.` completion with it, with nothing else failing);
//   - every listed non-snippet member reaches the output;
//   - the signature reader handles the shapes the table actually uses,
//     including the two it cannot parse.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"

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

// See CHAIN_CONTINUATIONS in script_types.cpp. These names carry meaning the
// table cannot express, so the generator hardcodes them; if the table stops
// offering one, the hardcoding is stale and the chain silently loses a link.
TEST (ScriptTypesTest, ChainVocabularyStillExistsInTheTable) {
    std::set<std::string> labels;
    for (const auto& item : get_script_completions ()) {
        labels.insert (item.value ("label", ""));
    }
    EXPECT_TRUE (labels.count ("to.not"))
    << "generator types `not` as the chain";
    EXPECT_TRUE (labels.count ("and")) << "generator types `and` as the chain";
    EXPECT_TRUE (labels.count ("pm.expect"))
    << "generator types `expect` as opening the chain";
}

TEST (ScriptTypesTest, ChainContinuationsReturnTheChain) {
    const std::string dts = generate_script_typedefs ();
    // `expect` opens the chain, `.and` continues it, `.not` re-enters the `to`
    // node it sits in - none of which the table says.
    EXPECT_TRUE (contains (dts, "expect(value: any): VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "and: VayuExpectation;"));
    EXPECT_TRUE (contains (dts, "not: VayuExpectTo;"));
    EXPECT_TRUE (contains (dts, "interface VayuExpectTo {"));
    EXPECT_TRUE (contains (dts, "interface VayuExpectation {"));
    // An assertion that documents no return continues the chain when it is in
    // one, so a chain call stays chainable.
    EXPECT_TRUE (contains (dts, "equal(expected: any): VayuExpectation;"));
}

// A getter that performs an assertion yields nothing. It looks identical to a
// continuation in the table, which is exactly why the distinction is guarded.
TEST (ScriptTypesTest, TerminalAssertionGettersAreVoid) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "true: void;"));
    EXPECT_TRUE (contains (dts, "exist: void;"));
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

// Two entries document an overload in prose TypeScript cannot parse
// (`upsert({ key, value }) | (name, value)`). Emitting that verbatim would
// produce a file that does not compile, taking every other declaration with it,
// so the reader falls back to a permissive signature and keeps the member.
TEST (ScriptTypesTest, UnparseableParameterListsFallBackRatherThanBreakTheFile) {
    const std::string dts = generate_script_typedefs ();
    EXPECT_TRUE (contains (dts, "upsert(...args: any[])"));
    EXPECT_TRUE (contains (dts, "add(...args: any[])"));
}

// The declarations name the host globals the sandbox lacks (`setTimeout`,
// `fetch`, …) so that using one is an error the editor can explain, rather than
// the bare "Cannot find name" the app has to suppress wholesale.
//
// A hand-written list of what a runtime does *not* have is exactly the kind
// that rots silently - nothing fails when the runtime gains one. So rather than
// trusting it, this runs `typeof <name>` in the real script engine for every
// entry. Give QuickJS a `setTimeout` and the test that claims it has none
// fails, which is the only honest way to hold this list to the sandbox.
TEST (ScriptTypesTest, DeclaredAbsentGlobalsAreGenuinelyAbsentFromTheRuntime) {
#ifdef VAYU_HAS_QUICKJS
    const std::string dts = generate_script_typedefs ();

    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;
    vayu::runtime::ScriptContext ctx;
    ctx.environment = &env;

    size_t checked = 0;
    // Read the names back out of the generated file rather than restating them,
    // so the test cannot agree with a stale copy of the list.
    for (size_t pos = dts.find ("declare const "); pos != std::string::npos;
         pos        = dts.find ("declare const ", pos + 1)) {
        const size_t start = pos + std::string ("declare const ").size ();
        const size_t colon = dts.find (':', start);
        if (colon == std::string::npos) {
            continue;
        }
        const std::string name = dts.substr (start, colon - start);
        const size_t end       = dts.find (';', colon);
        if (end == std::string::npos ||
        dts.substr (colon, end - colon).find ("never") == std::string::npos) {
            continue; // a real global (`pm`, `console`), not an absent one
        }

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
    << "no absent globals were probed - the scan found nothing";
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

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
