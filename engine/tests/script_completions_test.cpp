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

#include <string>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Defined in scripting.cpp.
nlohmann::json get_script_completions ();
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::get_script_completions;

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

} // namespace
