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

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

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
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_EQ (
        result.tests[0].error_message.find ("not a supported assertion"), std::string::npos)
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
        const bool is_member    = label.rfind ("pm.request.headers.", 0) == 0 ||
        label.rfind ("pm.response.headers.", 0) == 0 ||
        label == "pm.response.reason" || label == "pm.response.size";
        if (!is_member) {
            continue;
        }
        offered++;

        const std::string script = "pm.environment.set('t', typeof " + label + ");";
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_TRUE (result.success) << label << ": " << result.error_message;
        EXPECT_EQ (env["t"].value, "function")
        << label << " is offered as a call but the runtime does not implement it";
    }

    EXPECT_GE (offered, 7)
    << "the header accessors are missing from the completion list";
}

// Same guard for both cookie surfaces (#301): `pm.response.cookies.*`, the
// response's own Set-Cookie, and `pm.cookies.*`, the jar. Both are offered one
// level down (`…cookies.get`), so a member the runtime lacks would only show up
// when a user accepts the suggestion and the script throws.
TEST (ScriptCompletions, EveryOfferedCookieMemberIsCallableInTheRuntime) {
    const auto completions = get_script_completions ();

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    response.headers     = { { "set-cookie", "session=abc; Path=/" } };
    response.body        = R"({"ok": true})";

    int offered = 0;
    for (const auto& item : completions) {
        const std::string label = item.value ("label", std::string{});
        if (label.rfind ("pm.response.cookies.", 0) != 0 &&
        label.rfind ("pm.cookies.", 0) != 0) {
            continue;
        }
        offered++;

        const std::string script = "pm.environment.set('t', typeof " + label + ");";
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_TRUE (result.success) << label << ": " << result.error_message;
        EXPECT_EQ (env["t"].value, "function")
        << label << " is offered as a call but the runtime does not implement it";
    }

    EXPECT_GE (offered, 6)
    << "the cookie accessors are missing from the completion list";
}

// The guard above is offered-implies-callable only, so a method the runtime
// binds and the list forgets fails nothing there - which is how the write half
// could ship invisible to every user who discovers the API through completions.
// These are the entries #337 requires, named.
TEST (ScriptCompletions, TheCookieJarsWriteHalfIsOffered) {
    const auto completions = get_script_completions ();

    std::vector<std::string> labels;
    for (const auto& item : completions) {
        labels.push_back (item.value ("label", std::string{}));
    }
    ASSERT_FALSE (labels.empty ());

    for (const char* expected : { "pm.cookies.jar", "pm.cookies.jar().get",
         "pm.cookies.jar().set", "pm.cookies.jar().unset", "pm.cookies.jar().clear" }) {
        EXPECT_NE (std::find (labels.begin (), labels.end (), expected), labels.end ())
        << expected << " is bound by the runtime but not offered";
    }
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
        const std::string prefix =
        split == std::string::npos ? "" : chain.substr (0, split);
        const std::string member =
        split == std::string::npos ? chain : chain.substr (split + 1);
        offered++;

        const std::string target = "pm.expect(1)" + (prefix.empty () ? "" : "." + prefix);
        // A function must be callable; a chainer or terminal getter only has to
        // be a declared own property of the object it hangs off.
        const std::string check = item.value ("kind", 0) == KIND_FUNCTION ?
        "if (typeof " + target + "[\"" + member +
        "\"] !== \"function\") { throw new Error(\"missing\"); }" :
        "if (!Object.getOwnPropertyDescriptor(" + target + ", \"" + member +
        "\")) { throw new Error(\"missing\"); }";

        const std::string script = "pm.test(\"t\", function() { " + check + " });";
        auto result = engine.execute_test (script, request, response, env);
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
            const size_t dot          = match.find ('.', start);
            const std::string segment = match.substr (
            start, dot == std::string::npos ? std::string::npos : dot - start);
            if (!segment.empty ()) {
                segments.insert (segment);
            }
            if (dot == std::string::npos) {
                break;
            }
            start = dot + 1;
        }
    }
    ASSERT_FALSE (segments.empty ())
    << "no assertion chains found to compare against";

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
    "  var missing = bound.filter(function (name) { return "
    "offered.indexOf(name) === -1; });\n"
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

// A different drift from the ones above: the member exists, the spelling of the
// key does not. Response header names are lower-cased by the HTTP client and
// indexing `pm.response.headers` is a plain property read, so an offered
// example spelled `["Content-Type"]` reads back `undefined` (#310). `get()` and
// `has()` are case-insensitive and unaffected - only the index form can be
// wrong this way.
TEST (ScriptCompletions, NoOfferedResponseHeaderIndexUsesAMixedCaseKey) {
    const auto completions = get_script_completions ();

    const std::string index_prefix = "pm.response.headers[";
    int indexed                    = 0;
    for (const auto& item : completions) {
        for (const char* field : { "insertText", "documentation", "detail" }) {
            const std::string text = item.value (field, std::string{});
            for (size_t at = text.find (index_prefix); at != std::string::npos;
            at             = text.find (index_prefix, at + 1)) {
                const size_t open = at + index_prefix.size ();
                ASSERT_LT (open, text.size ()) << text;
                const char quote = text[open];
                ASSERT_TRUE (quote == '"' || quote == '\'')
                << "index example with no quoted key: " << text;
                const size_t close = text.find (quote, open + 1);
                ASSERT_NE (close, std::string::npos) << text;

                const std::string key = text.substr (open + 1, close - open - 1);
                indexed++;

                std::string lowered = key;
                std::transform (lowered.begin (), lowered.end (),
                lowered.begin (), [] (unsigned char c) {
                    return static_cast<char> (std::tolower (c));
                });
                EXPECT_EQ (key, lowered)
                << item.value ("label", std::string{})
                << " indexes pm.response.headers with '" << key
                << "', which never matches - the HTTP client lower-cases "
                   "response header names";
            }
        }
    }

    ASSERT_GT (indexed, 0) << "nothing offered indexes pm.response.headers at "
                              "all, so this scan proved nothing";
}

// The executable half of the same guard, and the one that would have caught
// #310: the snippet Monaco inserts is run against a JSON response and has to
// pass. A shape check could not catch it - the broken form was valid JS that
// failed as an *assertion*, so it read as "the server sent the wrong
// Content-Type" rather than "the example is wrong".
TEST (ScriptCompletions, TheContentTypeSnippetPassesAgainstAJsonResponse) {
    const auto completions = get_script_completions ();
    const auto* snippet = find_by_label (completions, "Test: Content-Type JSON");
    ASSERT_NE (snippet, nullptr)
    << "the Content-Type snippet is no longer offered";

    const std::string insert = snippet->value ("insertText", std::string{});
    ASSERT_EQ (insert.find ("${"), std::string::npos)
    << "the snippet gained a placeholder, so it is no longer runnable as "
       "written";

    vayu::runtime::ScriptEngine engine;
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    request.method       = vayu::HttpMethod::GET;
    request.url          = "https://api.example.com/users";
    response.status_code = 200;
    // Spelled the way the HTTP client stores it, which is the whole point.
    response.headers = { { "content-type", "application/json; charset=utf-8" } };
    response.body = R"({"ok": true})";

    auto result = engine.execute_test (insert, request, response, env);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed)
    << "the offered Content-Type snippet fails against a JSON response: "
    << result.tests[0].error_message;
}

// ---------------------------------------------------------------------------
// The general callable-implies-offered guard (#418).
//
// Every guard above this line is either offered-implies-callable, or the
// reverse for one named surface (the cookie jar's write half, the variable
// scopes, the expect matchers). So a whole new `pm.*` surface could be bound
// and listed nowhere and nothing failed - which is exactly what happened to
// `pm.iterationData`: shipped by #356, documented in scripting.md, and absent
// from all 126 completion entries. The #337 closure verification predicted it
// in those words, and the very next surface fell through.
//
// This closes the direction rather than the instance. It asks the *runtime*
// what it bound rather than comparing against a list written out here, because
// a hand-maintained list of expected names is a second copy that drifts the
// same way the completions did - a new surface would have to be added to it
// too, and forgetting that fails nothing again.
// ---------------------------------------------------------------------------

// A context with every optional surface populated, so the enumeration below
// sees the *largest* `pm` the runtime ever builds. Several members are bound
// conditionally - `pm.iterationData` only with a data row, `pm.info.iteration`
// only in a scenario run, `pm.response.errorCode` only on a transport failure -
// and a guard run against a bare context would silently not check them.
struct FullyBoundContext {
    vayu::Request request;
    vayu::Response response;
    vayu::Environment env;
    vayu::Environment globals;
    vayu::Environment collection_variables;
    nlohmann::json row = nlohmann::json{ { "username", "ada" }, { "id", 7 } };
    /// A streamed run's stored `events` node, which binds pm.response.events
    /// and its two markers - conditional exactly as the data row is (#575).
    nlohmann::json events =
    nlohmann::json{ { "items",
                    nlohmann::json::array ({ nlohmann::json{ { "event", "tick" },
                    { "data", "1" }, { "sourceId", "e0" } } }) },
        { "totalEvents", 3 }, { "eventsTruncated", true }, { "endReason", "completed" } };
    vayu::runtime::ScriptContext ctx;

    FullyBoundContext () {
        request.method  = vayu::HttpMethod::GET;
        request.url     = "https://api.example.com/users";
        request.headers = { { "Authorization", "Bearer t" } };

        response.status_code = 200;
        response.headers     = { { "content-type", "application/json" },
                { "set-cookie", "session=abc; Path=/" } };
        response.body        = R"({"ok": true})";
        // Binds pm.response.errorCode / errorMessage, which exist only here.
        response.error_code    = vayu::ErrorCode::Timeout;
        response.error_message = "timed out";

        ctx.request             = &request;
        ctx.response            = &response;
        ctx.environment         = &env;
        ctx.globals             = &globals;
        ctx.collectionVariables = &collection_variables;
        ctx.iteration           = 0;
        ctx.iteration_count     = 4;
        ctx.iteration_data      = &row;
        ctx.response_events     = &events;
        ctx.in_scenario         = true;
    }
};

// Members the runtime binds and the editor must not offer, each with the reason
// it is not a completion. Anything not on this list has to be in the list the
// endpoint serves.
bool is_deliberately_uncompletable (const std::string& name) {
    return
    // Bound only to throw, naming the three real scopes - offering it would be
    // suggesting a call that cannot work.
    name == "pm.variables.set" ||
    // Bound only to throw: the rows are a run input, not a scope, so a write
    // has nowhere to land (#356). Same reasoning as pm.variables.set.
    name == "pm.iterationData.set" || name == "pm.iterationData.unset" ||
    name == "pm.iterationData.clear" ||
    // The assertion chain root and everything hanging off it. It is offered as
    // the terminal `pm.response.to.be.*` labels instead, which is what an
    // author types and what EveryOfferedResponseStatusClassExistsInTheRuntime
    // checks; `pm.response.to` on its own asserts nothing, so a completion for
    // it would suggest an expression with no effect.
    name == "pm.response.to" || name.rfind ("pm.response.to.", 0) == 0;
}

std::vector<std::string> split_commas (const std::string& joined) {
    std::vector<std::string> parts;
    for (size_t start = 0; start <= joined.size ();) {
        const size_t comma     = joined.find (',', start);
        const std::string part = joined.substr (
        start, comma == std::string::npos ? std::string::npos : comma - start);
        if (!part.empty ()) {
            parts.push_back (part);
        }
        if (comma == std::string::npos) {
            break;
        }
        start = comma + 1;
    }
    return parts;
}

// The walk, as JavaScript. Two levels of plain property reads, plus the two
// shapes a plain walk cannot reach:
//
// - **The data maps.** `pm.request.headers`, `pm.response.headers` and
//   `pm.response.cookies` carry one property per header or cookie on the wire
//   *and* their accessors, so descending naively would demand a completion
//   entry for `Authorization`. The runtime already separates the two, and not
//   in a side table this test would have to keep in step:
//   `install_header_methods` defines the accessors **non-enumerable**
//   (HEADER_METHOD_FLAGS omits JS_PROP_ENUMERABLE) while `define_header_entry`
//   defines the wire entries with JS_PROP_C_W_E. So the walk descends and
//   requires exactly the non-enumerable functions - an accessor added tomorrow
//   is required, a header named `Authorization` is not, and a wire header that
//   happens to be named `get` overwrites the method as an enumerable string and
//   is data again, which is what those flags exist to produce.
// - **The cookie jar**, which is behind a *call* (`pm.cookies.jar()`) and so is
//   not reachable by property reads at all. There is exactly one such factory,
//   so it is named here rather than generalised into a machine for finding
//   factories.
//
// `data` collects what was classified as wire data, so the test beside this can
// assert the split happened rather than a widening that quietly requires
// everything or nothing.
constexpr const char* ENUMERATE_PM = R"JS(
    var names = [];
    var data = [];
    var DATA_MAPS = ['pm.request.headers', 'pm.response.headers', 'pm.response.cookies',
                     'pm.response.events'];

    function descend(path, value) {
        var isDataMap = DATA_MAPS.indexOf(path) !== -1;
        var members = Object.getOwnPropertyNames(value).sort();
        for (var i = 0; i < members.length; i++) {
            var member = members[i];
            if (!isDataMap) {
                names.push(path + '.' + member);
                continue;
            }
            // API on a data map is what the runtime hid from enumeration and
            // bound as a function; everything else is a header, a cookie, an
            // array index or `length`.
            var descriptor = Object.getOwnPropertyDescriptor(value, member);
            if (!descriptor.enumerable && typeof value[member] === 'function') {
                names.push(path + '.' + member);
            } else {
                data.push(path + '.' + member);
            }
        }
    }

    var top = Object.getOwnPropertyNames(pm).sort();
    for (var t = 0; t < top.length; t++) {
        var key = top[t];
        names.push('pm.' + key);
        var value = pm[key];
        if (value === null || typeof value !== 'object') continue;
        descend('pm.' + key, value);

        // One more level, which is where the data maps and the header
        // accessors live.
        var members = Object.getOwnPropertyNames(value).sort();
        for (var m = 0; m < members.length; m++) {
            var nested = value[members[m]];
            if (nested === null || typeof nested !== 'object') continue;
            descend('pm.' + key + '.' + members[m], nested);
        }
    }

    // The jar, reached the only way it can be.
    var jar = pm.cookies.jar();
    var jarMembers = Object.getOwnPropertyNames(jar).sort();
    for (var j = 0; j < jarMembers.length; j++) {
        names.push('pm.cookies.jar().' + jarMembers[j]);
    }

    pm.environment.set('bound', names.join(','));
    pm.environment.set('data', data.join(','));
)JS";

TEST (ScriptCompletions, EveryPmMemberTheRuntimeBindsIsOffered) {
    const auto completions = get_script_completions ();

    FullyBoundContext bound;
    vayu::runtime::ScriptEngine engine;

    auto enumerated = engine.execute (ENUMERATE_PM, bound.ctx);
    ASSERT_TRUE (enumerated.success) << enumerated.error_message;

    const auto bound_names = split_commas (bound.env["bound"].value);
    ASSERT_FALSE (bound_names.empty ())
    << "the runtime enumeration found nothing, so this guard proved nothing";

    std::vector<std::string> missing;
    int checked = 0;
    for (const auto& name : bound_names) {
        if (is_deliberately_uncompletable (name)) {
            continue;
        }
        checked++;
        if (find_by_label (completions, name) == nullptr) {
            missing.push_back (name);
        }
    }

    EXPECT_GT (checked, 40) << "far fewer pm members than the runtime binds - "
                               "the walk above is broken, "
                               "not the completion list";

    std::string report;
    for (const auto& name : missing) {
        report += (report.empty () ? "" : ", ") + name;
    }
    EXPECT_TRUE (missing.empty ())
    << "the runtime binds these but the completion list never offers them, so "
       "no user can discover them in the editor: "
    << report;
}

// The widening above trades one silent hole for a noisy false positive unless
// both halves hold, so both are asserted rather than left to the suite being
// green: the depth-3 accessors have to be *reached* (a walk that stops at two
// levels passes the guard by checking nothing there), and a header name on the
// wire must not be demanded as a completion (a walk that descends
// indiscriminately would demand `Authorization`).
TEST (ScriptCompletions, TheWalkSeparatesDepthThreeAccessorsFromWireEntries) {
    FullyBoundContext bound;
    vayu::runtime::ScriptEngine engine;

    auto enumerated = engine.execute (ENUMERATE_PM, bound.ctx);
    ASSERT_TRUE (enumerated.success) << enumerated.error_message;

    const auto required = split_commas (bound.env["bound"].value);
    const auto wire     = split_commas (bound.env["data"].value);
    ASSERT_FALSE (required.empty ());
    ASSERT_FALSE (wire.empty ())
    << "nothing was classified as wire data, so the split below proves nothing";

    auto is_required = [&required] (const std::string& name) {
        return std::find (required.begin (), required.end (), name) != required.end ();
    };
    auto is_wire = [&wire] (const std::string& name) {
        return std::find (wire.begin (), wire.end (), name) != wire.end ();
    };

    // The API three levels down, which the two-level walk never saw.
    for (const char* accessor :
    { "pm.request.headers.get", "pm.request.headers.has", "pm.request.headers.add",
    "pm.request.headers.upsert", "pm.request.headers.remove",
    "pm.response.headers.get", "pm.response.headers.has", "pm.response.cookies.get",
    "pm.response.cookies.has", "pm.response.cookies.toObject", "pm.cookies.jar().get",
    "pm.cookies.jar().set", "pm.cookies.jar().unset", "pm.cookies.jar().clear" }) {
        EXPECT_TRUE (is_required (accessor))
        << accessor << " is bound by the runtime but the walk never required it";
    }

    // And the data beside it, which must not be. FullyBoundContext puts each of
    // these on the wire, so a walk that stopped classifying would fail here.
    for (const char* entry : { "pm.request.headers.Authorization",
         "pm.response.headers.content-type", "pm.response.headers.set-cookie",
         "pm.response.cookies.0", "pm.response.cookies.length",
         // A stream's events are data for the same reason a header is: the
         // origin names them, so demanding a completion per entry would make
         // every event the origin ever sent a false positive.
         "pm.response.events.0", "pm.response.events.length" }) {
        EXPECT_TRUE (is_wire (entry))
        << entry << " is a wire entry but the walk did not classify it as one";
        EXPECT_FALSE (is_required (entry))
        << entry
        << " is on the wire, not API - demanding a completion for it "
           "would make every response header a false positive";
    }
}

// The named half of the same check. The guard above reads the runtime, so a
// surface deleted from both sides at once would pass it; this pins the entries
// #418 requires by name, the way the cookie jar's write half is pinned.
TEST (ScriptCompletions, TheIterationDataAccessorsAreOffered) {
    const auto completions = get_script_completions ();

    // `has` joined get / toObject in #435 - every other scope reader in the pm
    // surface answers it, and it is the one way to ask about a column whose
    // value is null without knowing how a null column comes back.
    for (const char* expected : { "pm.iterationData", "pm.iterationData.get",
         "pm.iterationData.has", "pm.iterationData.toObject" }) {
        const auto* item = find_by_label (completions, expected);
        ASSERT_NE (item, nullptr) << expected << " is bound by the runtime but not offered";
        // A completion that does not say so would promise a row in a plain
        // request script, where pm.iterationData is undefined (#300/#356).
        const std::string documentation = item->value ("documentation", std::string{});
        EXPECT_NE (documentation.find ("undefined"), std::string::npos)
        << expected
        << " does not say it is absent outside a data-driven run: " << documentation;
    }
}

} // namespace
