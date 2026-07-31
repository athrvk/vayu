// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// The `pm.*` completion list is served by the engine and rendered by Monaco
// (`useScriptCompletionProvider`), so a capability the runtime gained is
// invisible in the editor until it is listed here. That is what happened with
// `pm.request` write-back: the four fields were listed as reads, and nothing
// told a script author they could be assigned to.
//
// These guard the shape every item must have for Monaco to render it, and the
// mutation entries specifically - a snippet with no `insertTextRules` inserts
// its `${1:...}` placeholders as literal text, which looks like a typo rather
// than a feature.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Defined in scripting.cpp.
nlohmann::json get_script_completions ();
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::get_script_completions;

// monaco.languages.CompletionItemKind.Function
constexpr int KIND_FUNCTION = 1;
// monaco.languages.CompletionItemKind.Snippet
constexpr int KIND_SNIPPET = 28;
// monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
constexpr int INSERT_AS_SNIPPET = 4;

// The text Monaco matches the typed prefix against: `filterText` when present,
// otherwise the label.
std::string match_text (const nlohmann::json& item) {
    return item.value ("filterText", item.value ("label", std::string{}));
}

const nlohmann::json* find_by_label (const nlohmann::json& all, const std::string& label) {
    for (const auto& item : all) {
        if (item.value ("label", std::string{}) == label) {
            return &item;
        }
    }
    return nullptr;
}

TEST (ScriptCompletions, EveryItemHasWhatMonacoNeedsToRenderIt) {
    const auto completions = get_script_completions ();
    ASSERT_TRUE (completions.is_array ());
    ASSERT_FALSE (completions.empty ())
    << "an empty list would pass every check below";

    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        EXPECT_FALSE (label.empty ()) << item.dump ();
        EXPECT_TRUE (item.contains ("kind")) << label;
        EXPECT_FALSE (item.value ("insertText", std::string{}).empty ()) << label;
        EXPECT_FALSE (item.value ("sortText", std::string{}).empty ()) << label;

        // A snippet's placeholders are only expanded when the rule says so.
        const bool has_placeholder =
        item.value ("insertText", std::string{}).find ("${") != std::string::npos;
        if (has_placeholder) {
            EXPECT_EQ (item.value ("insertTextRules", 0), INSERT_AS_SNIPPET)
            << label << " carries ${...} placeholders but is not marked InsertAsSnippet";
        }
    }
}

TEST (ScriptCompletions, TheRequestFieldsAreDocumentedAsWritable) {
    const auto completions = get_script_completions ();

    // Each of the four mutable fields must say it is writable, or the list
    // still describes the read-only snapshot the runtime no longer has.
    for (const char* label : { "pm.request.url", "pm.request.method",
         "pm.request.headers", "pm.request.body" }) {
        const auto* item = find_by_label (completions, label);
        ASSERT_NE (item, nullptr) << label << " is missing from the completion list";
        const std::string detail = item->value ("detail", std::string{});
        EXPECT_NE (detail.find ("writable"), std::string::npos)
        << label << " detail does not mention writability: " << detail;
    }

    const auto* request = find_by_label (completions, "pm.request");
    ASSERT_NE (request, nullptr);
    const std::string documentation = request->value ("documentation", std::string{});
    // The half that is easy to forget: a test script's writes go nowhere.
    EXPECT_NE (documentation.find ("read-only"), std::string::npos) << documentation;
    EXPECT_NE (documentation.find ("pre-request"), std::string::npos) << documentation;
}

TEST (ScriptCompletions, TheMutationSnippetsAreOfferedAndReachable) {
    const auto completions = get_script_completions ();

    int snippets = 0;
    bool has_set_header = false, has_delete_header = false, has_body_rewrite = false;
    for (const auto& item : completions) {
        if (item.value ("kind", 0) != KIND_SNIPPET) {
            continue;
        }
        const std::string insert = item.value ("insertText", std::string{});
        const std::string match  = match_text (item);
        // Reachable from what a user types: every mutation snippet has to
        // survive filtering on the `pm.request` prefix that triggers it.
        if (insert.rfind ("delete pm.request.headers", 0) == 0) {
            has_delete_header = true;
            EXPECT_NE (match.find ("pm.request.headers"), std::string::npos) << match;
        } else if (insert.rfind ("pm.request.headers[", 0) == 0) {
            has_set_header = true;
            EXPECT_NE (match.find ("pm.request.headers"), std::string::npos) << match;
        } else if (insert.find ("pm.request.body = JSON.stringify") != std::string::npos) {
            has_body_rewrite = true;
            EXPECT_NE (match.find ("pm.request.body"), std::string::npos) << match;
        }
        snippets++;
    }

    EXPECT_GT (snippets, 0);
    EXPECT_TRUE (has_set_header) << "no snippet for setting a header";
    EXPECT_TRUE (has_delete_header) << "no snippet for removing a header";
    EXPECT_TRUE (has_body_rewrite) << "no snippet for rewriting the body";
}

// The list and the runtime are in different translation units, so nothing but
// this stops them drifting: an offered `to.be` matcher the runtime does not
// implement now throws "not a supported assertion" the moment it is used, which
// makes the editor's suggestion the source of a failing test.
TEST (ScriptCompletions, EveryOfferedResponseStatusClassExistsInTheRuntime) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    response.body        = R"({"ok": true})";

    int offered = 0;
    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        if (label.rfind ("pm.response.to.be.", 0) != 0) {
            continue;
        }
        offered++;

        const std::string insert = item.value ("insertText", std::string{});
        EXPECT_EQ (insert.find ('('), std::string::npos)
        << label << " is a getter - offering parentheses would call its result";

        // Whether the assertion passes against this response is beside the
        // point; only "the runtime has no such member" is a list defect.
        const std::string script = "pm.test(\"t\", function() { " + insert + "; });";
        auto result              = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_EQ (result.tests[0].error_message.find ("not a supported assertion"),
        std::string::npos)
        << label << " is offered but the runtime does not implement it";
    }

    EXPECT_GE (offered, 10)
    << "the pm.response.to.be matchers are missing from the completion list";
}

// Same drift risk one level down: `pm.response.headers.get` is offered as a
// call, so an author types it and it must be a function at run time. That
// exact line was suggested by the app's Tests panel for months while the
// runtime had no such member (#182), which is what this guards against
// returning.
TEST (ScriptCompletions, EveryOfferedHeaderMemberIsCallableInTheRuntime) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    request.headers      = { { "Authorization", "Bearer t" } };
    response.status_code = 200;
    response.headers     = { { "content-type", "application/json" } };
    response.body        = R"({"ok": true})";

    // Labels of the form pm.<request|response>.<member> or
    // pm.<...>.headers.<member> that the list offers as a call.
    int offered = 0;
    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        const bool is_member = label.rfind ("pm.request.headers.", 0) == 0 ||
        label.rfind ("pm.response.headers.", 0) == 0 ||
        label == "pm.response.reason" || label == "pm.response.size";
        if (!is_member) {
            continue;
        }
        offered++;

        const std::string script =
        "pm.environment.set('t', typeof " + label + ");";
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_TRUE (result.success) << label << ": " << result.error_message;
        EXPECT_EQ (env["t"].value, "function")
        << label << " is offered as a call but the runtime does not implement it";
    }

    EXPECT_GE (offered, 7) << "the header accessors are missing from the completion list";
}

// The same drift, on the variable scopes: `pm.variables` was offered by
// `scripting.md` for months while the runtime had no such object, and every
// scope method added in #184 is invisible in the editor until it is listed
// here. Both directions are defects, so both are checked - an offered method
// the runtime lacks throws "is not a function" the moment it is accepted, and a
// runtime method nobody lists is a feature no user can find.
TEST (ScriptCompletions, TheOfferedVariableScopeMethodsAreExactlyWhatTheRuntimeHas) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Environment env;
    vayu::Environment globals;
    vayu::Environment collection_variables;
    request.method = vayu::HttpMethod::GET;
    request.url    = "https://api.example.com/users";

    vayu::runtime::ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collection_variables;

    // Every offered `pm.<scope>.<method>` exists as a function.
    int offered = 0;
    std::string probe;
    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        for (const char* accessor : { "pm.environment.", "pm.globals.",
             "pm.collectionVariables.", "pm.variables." }) {
            if (label.rfind (accessor, 0) != 0) {
                continue;
            }
            offered++;
            probe += "if (typeof " + label + " !== 'function') missing.push('" + label + "');\n";
        }
    }
    ASSERT_GT (offered, 0)
    << "no variable-scope completions at all - the loop below proves nothing";

    auto result = engine.execute (
    "var missing = [];\n" + probe + "pm.environment.set('missing', missing.join(','));", ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "offered by the completion list, absent from the runtime";

    // And nothing the runtime has is missing from the list. Read off the
    // runtime rather than hardcoded, so a method added to
    // setup_pm_variable_scope has to be listed rather than merely renamed here.
    env.clear ();
    auto installed = engine.execute (R"JS(
        var names = [];
        var scopes = ['environment', 'globals', 'collectionVariables', 'variables'];
        for (var i = 0; i < scopes.length; i++) {
            var scope = pm[scopes[i]];
            for (var key in scope) {
                if (typeof scope[key] === 'function') names.push('pm.' + scopes[i] + '.' + key);
            }
        }
        pm.environment.set('names', names.join(','));
    )JS",
    ctx);
    ASSERT_TRUE (installed.success) << installed.error_message;

    const std::string names = env["names"].value;
    ASSERT_FALSE (names.empty ())
    << "the runtime enumeration found nothing to check";
    for (size_t start = 0; start <= names.size ();) {
        const size_t comma     = names.find (',', start);
        const std::string name = names.substr (
        start, comma == std::string::npos ? std::string::npos : comma - start);
        // pm.variables.set exists only to throw and name the three real scopes;
        // offering it in the editor would be suggesting a call that cannot work.
        if (!name.empty () && name != "pm.variables.set") {
            EXPECT_NE (find_by_label (completions, name), nullptr)
            << name << " is in the runtime but not in the completion list";
        }
        if (comma == std::string::npos) {
            break;
        }
        start = comma + 1;
    }
}

// The same drift, one chain over: an offered `pm.expect` matcher the runtime
// does not bind is `undefined`, so calling it throws "not a function" and the
// editor's own suggestion becomes the reason a test fails.
//
// The member is looked up rather than executed. A terminal getter (`.to.be.true`)
// asserts on access, so evaluating it would report whether the assertion held
// against an arbitrary value - which is not what this guards.
TEST (ScriptCompletions, EveryOfferedExpectMatcherExistsInTheRuntime) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    response.body        = R"({"ok": true})";

    int offered = 0;
    for (const auto& item : completions) {
        // The expectation chains are exactly the items whose match text starts
        // with a dot; `pm.*` items are members of the pm object instead.
        const std::string match = match_text (item);
        if (match.empty () || match[0] != '.') {
            continue;
        }
        const std::string chain = match.substr (1);
        const size_t split      = chain.rfind ('.');
        const std::string prefix = split == std::string::npos ? "" : chain.substr (0, split);
        const std::string member =
        split == std::string::npos ? chain : chain.substr (split + 1);
        offered++;

        const std::string target = "pm.expect(1)" + (prefix.empty () ? "" : "." + prefix);
        // A function must be callable; a chainer or terminal getter only has to
        // be a declared own property of the object it hangs off.
        const std::string check = item.value ("kind", 0) == KIND_FUNCTION ?
        "if (typeof " + target + "[\"" + member + "\"] !== \"function\") { throw new Error(\"missing\"); }" :
        "if (!Object.getOwnPropertyDescriptor(" + target + ", \"" + member +
        "\")) { throw new Error(\"missing\"); }";

        const std::string script = "pm.test(\"t\", function() { " + check + " });";
        auto result              = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_TRUE (result.tests[0].passed)
        << match << " is offered but the runtime does not bind it: "
        << result.tests[0].error_message;
    }

    EXPECT_GE (offered, 20)
    << "the pm.expect assertion chains are missing from the completion list";
}

// The other direction, and the one that goes stale silently: a matcher the
// runtime gained but nobody added to the list is invisible in the editor. The
// runtime is asked what it binds rather than the expectation being written out
// here, so a matcher added later cannot be missed by forgetting to update a
// list in a test.
//
// A name counts as offered when it appears as a segment of some chain, since a
// chainer like `have` is only ever reachable inside a longer label.
TEST (ScriptCompletions, EveryExpectMemberTheRuntimeBindsIsOffered) {
    const auto completions = get_script_completions ();

    std::set<std::string> segments;
    for (const auto& item : completions) {
        const std::string match = match_text (item);
        if (match.empty () || match[0] != '.') {
            continue;
        }
        size_t start = 1;
        while (start <= match.size ()) {
            const size_t dot = match.find ('.', start);
            const std::string segment = match.substr (start,
            dot == std::string::npos ? std::string::npos : dot - start);
            if (!segment.empty ()) {
                segments.insert (segment);
            }
            if (dot == std::string::npos) {
                break;
            }
            start = dot + 1;
        }
    }
    ASSERT_FALSE (segments.empty ()) << "no assertion chains found to compare against";

    std::string offered_literal;
    for (const auto& segment : segments) {
        offered_literal += (offered_literal.empty () ? "" : ", ");
        offered_literal += "\"" + segment + "\"";
    }

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    response.body        = R"({"ok": true})";

    const std::string script = "var offered = [" + offered_literal +
    "];\n"
    "pm.test(\"t\", function() {\n"
    "  var bound = Object.getOwnPropertyNames(pm.expect(1));\n"
    "  var missing = bound.filter(function (name) { return offered.indexOf(name) === -1; });\n"
    "  if (missing.length) { throw new Error(missing.join(', ')); }\n"
    "});";

    auto result = engine.execute_test (script, request, response, env);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed)
    << "pm.expect binds names the completion list never offers: "
    << result.tests[0].error_message;
}

// The signing surface (#187). Same drift risk as the matchers above, with a
// sharper edge: an author who is offered `pm.crypto.hmacSha256` and finds it
// undefined has no fallback - there is no other way to compute an HMAC in the
// sandbox. This calls every offered pm.crypto member for real rather than
// checking a name exists, because the failure mode being guarded is the list
// promising something the runtime never bound.
TEST (ScriptCompletions, EveryOfferedCryptoMemberIsCallableInTheRuntime) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    response.body        = R"({"ok": true})";

    int offered = 0;
    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        if (label.rfind ("pm.crypto.", 0) != 0 && label != "btoa" && label != "atob") {
            continue;
        }
        offered++;

        // Call it with arguments of the documented types rather than the
        // snippet's placeholders, which are not valid JS on their own.
        std::string call;
        if (label == "btoa")
            call = "btoa('abc')";
        else if (label == "atob")
            call = "atob('YWJj')";
        else if (label == "pm.crypto.sha256")
            call = "pm.crypto.sha256('abc')";
        else if (label == "pm.crypto.hmacSha256")
            call = "pm.crypto.hmacSha256('k', 'abc')";
        else
            FAIL () << label << " is offered but this test does not know how to call it";

        const std::string script = "pm.test(\"t\", function() { var out = " +
        call + "; if (typeof out !== 'string' || !out.length) throw new Error('no result'); });";
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_TRUE (result.tests[0].passed)
        << label << " is offered but the runtime does not provide it: "
        << result.tests[0].error_message;
    }

    EXPECT_EQ (offered, 4)
    << "the signing surface changed - update this test and the docs it backs";
}

} // namespace
