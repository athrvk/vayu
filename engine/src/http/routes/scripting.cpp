/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/scripting.cpp
 * @brief Scripting API routes - provides script engine capabilities for UI autocomplete
 */

#include <string>

#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

/**
 * @brief Get script engine completions for UI autocomplete
 *
 * This endpoint returns all available pm.* API functions, properties,
 * and assertion chains that the script engine supports. The frontend
 * uses this data to provide autocomplete in the Monaco editor.
 */
nlohmann::json get_script_completions () {
    // CompletionItem kinds (monaco.languages.CompletionItemKind values)
    constexpr int KIND_FUNCTION = 1;
    constexpr int KIND_FIELD    = 3;
    constexpr int KIND_VARIABLE = 4;
    constexpr int KIND_SNIPPET  = 28;

    // InsertTextRules (monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet)
    constexpr int INSERT_AS_SNIPPET = 4;

    nlohmann::json completions = nlohmann::json::array ();

    // ========================================
    // pm object
    // ========================================
    completions.push_back ({ { "label", "pm" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm" }, { "detail", "pm object (Postman-compatible)" },
    { "documentation",
    "The pm object provides access to request, response, environment, and "
    "testing utilities. Vayu implements a Postman-compatible scripting API." },
    { "sortText", "0_pm" } });

    // ========================================
    // pm.test() - Define tests
    // ========================================
    completions.push_back ({ { "label", "pm.test" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.test(\"${1:test name}\", function() {\n\t${2:// assertions}\n});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "pm.test(name: string, fn: () => void)" },
    { "documentation",
    "Define a test with assertions. The test name appears in "
    "results.\n\nExample:\npm.test('Status code is 200', () => {\n  "
    "pm.response.to.have.status(200);\n});" },
    { "sortText", "0_pm_test" } });

    // ========================================
    // pm.expect() - Chai-style assertions
    // ========================================
    completions.push_back ({ { "label", "pm.expect" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.expect(${1:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "pm.expect(value: any)" },
    { "documentation",
    "Create a Chai-style expectation for assertions.\n\nChain with:\n- "
    ".to.equal(expected) - strict (===), so two objects with the same contents "
    "are not equal\n- .to.eql(expected) / .to.deep.equal(expected) - deep "
    "equality, key order insensitive\n- .to.be.true / "
    ".to.be.false\n- .to.exist\n- .to.have.property(name)\n- "
    ".to.include(value)\n- .and to continue a chain" },
    { "sortText", "0_pm_expect" } });

    // ========================================
    // pm.response - Response object
    // ========================================
    completions.push_back ({ { "label", "pm.response" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.response" }, { "detail", "Response object" },
    { "documentation",
    "Access the HTTP response data including status code, headers, body, "
    "and timing information." },
    { "sortText", "0_pm_response" } });

    completions.push_back ({ { "label", "pm.response.code" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.code" }, { "detail", "number" },
    { "documentation", "The HTTP status code of the response (e.g., 200, 404, 500)." },
    { "sortText", "1_pm_response_code" } });

    completions.push_back ({ { "label", "pm.response.status" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.status" }, { "detail", "number" },
    { "documentation", "The HTTP status code (alias for pm.response.code)." },
    { "sortText", "1_pm_response_status" } });

    completions.push_back ({ { "label", "pm.response.responseTime" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.responseTime" }, { "detail", "number" },
    { "documentation",
    "Perceived response time in milliseconds (submit → completion). Use "
    "responseTimeWire for server-only timing." },
    { "sortText", "1_pm_response_time" } });

    completions.push_back ({ { "label", "pm.response.responseTimeWire" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.responseTimeWire" }, { "detail", "number" },
    { "documentation",
    "Wire-only response time in milliseconds (CURLINFO_TOTAL_TIME). Pre-#19 "
    "semantics - use for server-only SLA assertions." },
    { "sortText", "1_pm_response_time_wire" } });

    completions.push_back (
    { { "label", "pm.response.responseTimeQueueWait" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.responseTimeQueueWait" }, { "detail", "number" },
    { "documentation",
    "Generator-side overhead in milliseconds (responseTime − "
    "responseTimeWire). "
    "Near-zero for single-shot sends." },
    { "sortText", "1_pm_response_time_queue" } });

    completions.push_back ({ { "label", "pm.response.headers" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.headers" }, { "detail", "object" },
    { "documentation",
    "Response headers as key-value pairs, keyed by the lower-cased name the "
    "HTTP client parsed. Index it (pm.response.headers['content-type']) or use "
    "the case-insensitive get()/has() over it." },
    { "sortText", "1_pm_response_headers" } });

    completions.push_back ({ { "label", "pm.response.headers.get" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.headers.get(\"${1:Content-Type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.headers.get(name: string): string | undefined" },
    { "documentation",
    "Read a response header by name, case-insensitively. Returns undefined "
    "when the header is absent.\n\nExample:\nconst type = "
    "pm.response.headers.get('Content-Type');" },
    { "sortText", "1_pm_response_headers_get" } });

    completions.push_back ({ { "label", "pm.response.headers.has" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.headers.has(\"${1:Content-Type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.headers.has(name: string): boolean" },
    { "documentation", "Whether the response carries a header of that name, case-insensitively." },
    { "sortText", "1_pm_response_headers_has" } });

    completions.push_back ({ { "label", "pm.response.cookies" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.cookies" }, { "detail", "object" },
    { "documentation",
    "The response's Set-Cookie header, parsed: an array of { name, value, "
    "attrs } in wire order, with get()/has()/toObject() over it. `attrs` "
    "holds the raw attribute chunks ('Path=/', 'HttpOnly'). Read-only - vayu "
    "keeps no cookie jar, so nothing here is sent on a later request." },
    { "sortText", "1_pm_response_cookies" } });

    completions.push_back ({ { "label", "pm.response.cookies.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.cookies.get(\"${1:session}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.cookies.get(name: string): string | undefined" },
    { "documentation",
    "The value of a cookie the response set, or undefined when it set none of "
    "that name. Cookie names are case-sensitive. A name set twice answers with "
    "the last value, which is the one a browser would keep.\n\nExample:\nconst "
    "session = pm.response.cookies.get('session');" },
    { "sortText", "1_pm_response_cookies_get" } });

    completions.push_back ({ { "label", "pm.response.cookies.has" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.cookies.has(\"${1:session}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.cookies.has(name: string): boolean" },
    { "documentation", "Whether the response set a cookie of that name (case-sensitive)." },
    { "sortText", "1_pm_response_cookies_has" } });

    completions.push_back ({ { "label", "pm.response.cookies.toObject" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.cookies.toObject()" },
    { "detail", "pm.response.cookies.toObject(): object" },
    { "documentation",
    "Every cookie the response set, as a name-to-value object. Attributes are "
    "not included - read them off the array entries' `attrs`." },
    { "sortText", "1_pm_response_cookies_to_object" } });

    completions.push_back ({ { "label", "pm.response.reason" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.reason()" }, { "detail", "pm.response.reason(): string" },
    { "documentation",
    "The status line's reason phrase ('OK', 'Not Found'). A client-side "
    "failure reports vayu's synthetic status 0 as 'Error'." },
    { "sortText", "1_pm_response_reason" } });

    completions.push_back ({ { "label", "pm.response.size" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.size()" },
    { "detail", "pm.response.size(): { body: number, header: number, total: number }" },
    { "documentation",
    "Response size in bytes. `body` is the body the script can read through "
    "text(); `header` is the serialised header block reconstructed from the "
    "parsed headers, so it is not a wire-exact figure." },
    { "sortText", "1_pm_response_size" } });

    completions.push_back ({ { "label", "pm.response.json" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.json()" }, { "detail", "pm.response.json(): any" },
    { "documentation",
    "Parse and return the response body as JSON.\n\nExample:\nconst data = "
    "pm.response.json();\npm.expect(data.id).to.exist;" },
    { "sortText", "1_pm_response_json" } });

    completions.push_back ({ { "label", "pm.response.text" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.text()" }, { "detail", "pm.response.text(): string" },
    { "documentation", "Return the response body as a string." },
    { "sortText", "1_pm_response_text" } });

    // ========================================
    // pm.response.to.have - Response assertions
    // ========================================
    completions.push_back ({ { "label", "pm.response.to.have.status" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.to.have.status(${1:200})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.to.have.status(code: number)" },
    { "documentation",
    "Assert that the response has a specific HTTP status "
    "code.\n\nExample:\npm.response.to.have.status(200);\npm.response.to.have."
    "status(201);" },
    { "sortText", "1_pm_response_to_have_status" } });

    completions.push_back ({ { "label", "pm.response.to.have.header" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.to.have.header(\"${1:Content-Type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.to.have.header(name: string)" },
    { "documentation",
    "Assert that a specific header exists in the "
    "response.\n\nExample:\npm.response.to.have.header('Content-Type');" },
    { "sortText", "1_pm_response_to_have_header" } });

    completions.push_back ({ { "label", "pm.response.to.have.jsonBody" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.to.have.jsonBody()" },
    { "detail", "pm.response.to.have.jsonBody()" },
    { "documentation", "Assert that the response has a valid JSON body." },
    { "sortText", "1_pm_response_to_have_jsonBody" } });

    // ========================================
    // pm.response.to.be - Status-class assertions
    // ========================================
    // Getters, so the offered text is paren-less: writing the parentheses would
    // call the assertion's result rather than assert. Every name the runtime
    // implements belongs here - one it does not offer is one an author never
    // finds, and one that is offered but missing throws at run time.
    struct StatusClassCompletion {
        const char* name;
        const char* condition;
    };
    constexpr StatusClassCompletion status_classes[] = {
        { "ok", "a 2xx status code" },
        { "success", "a 2xx status code" },
        { "info", "a 1xx status code" },
        { "redirection", "a 3xx status code" },
        { "clientError", "a 4xx status code" },
        { "serverError", "a 5xx status code" },
        { "error", "a 4xx or 5xx status code" },
        { "accepted", "status 202" },
        { "badRequest", "status 400" },
        { "unauthorized", "status 401" },
        { "forbidden", "status 403" },
        { "notFound", "status 404" },
        { "rateLimited", "status 429" },
        { "json", "a body that parses as JSON" },
        { "withBody", "a non-empty body" },
    };

    for (const auto& status_class : status_classes) {
        const std::string label =
        std::string ("pm.response.to.be.") + status_class.name;
        completions.push_back ({ { "label", label }, { "kind", KIND_FIELD },
        { "insertText", label }, { "detail", label },
        { "documentation",
        std::string ("Assert that the response has ") + status_class.condition +
        ".\n\nWritten without parentheses - the property access is the "
        "assertion.\n\nExample:\n" +
        label + ";" },
        { "sortText", std::string ("1_pm_response_to_be_") + status_class.name } });
    }

    // ========================================
    // pm.request - Request object
    // ========================================
    // In a pre-request script these four are writable and the write-back sends
    // what they hold; in a test script they are a read-only record. The
    // documentation strings say so, because the completion list is where a
    // script author looks before the docs.
    completions.push_back ({ { "label", "pm.request" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.request" }, { "detail", "Request object" },
    { "documentation",
    "Access the HTTP request data including URL, method, headers, and body.\n\n"
    "In a **pre-request** script these are writable: whatever pm.request holds "
    "when the script ends is what is sent, and a script-set header overrides "
    "the one the Auth tab applied. In a **test** script it is a read-only "
    "record of what was already sent." },
    { "sortText", "0_pm_request" } });

    completions.push_back ({ { "label", "pm.request.url" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url" }, { "detail", "string (writable pre-request)" },
    { "documentation",
    "The full request URL. Assign to retarget the request before it is sent - "
    "must be a non-empty string. {{variables}} are already resolved here." },
    { "sortText", "1_pm_request_url" } });

    completions.push_back ({ { "label", "pm.request.method" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.method" }, { "detail", "string (writable pre-request)" },
    { "documentation",
    "The HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). Assign to "
    "change the verb; case does not matter. A HEAD request carrying a body is "
    "refused, so delete pm.request.body when switching to HEAD." },
    { "sortText", "1_pm_request_method" } });

    completions.push_back ({ { "label", "pm.request.headers" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.headers" }, { "detail", "object (writable pre-request)" },
    { "documentation",
    "Request headers as key-value pairs. The object is authoritative: the set "
    "it holds at the end is the set that is sent, so delete removes a header. "
    "Names are case-sensitive here (use 'Authorization', not "
    "'authorization'), and values must be a string, number or boolean." },
    { "sortText", "1_pm_request_headers" } });

    // The methods over that same object. They are non-enumerable properties of
    // it, so they never reach the wire, and they write the property the
    // write-back reads - method and assignment cannot disagree.
    completions.push_back ({ { "label", "pm.request.headers.get" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.headers.get(\"${1:Authorization}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.headers.get(name: string): string | undefined" },
    { "documentation",
    "Read an outgoing header by name, case-insensitively - unlike indexing, "
    "which is case-sensitive. Returns undefined when it is absent." },
    { "sortText", "1_pm_request_headers_get" } });

    completions.push_back ({ { "label", "pm.request.headers.has" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.headers.has(\"${1:Authorization}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.headers.has(name: string): boolean" },
    { "documentation", "Whether the outgoing request carries that header, case-insensitively." },
    { "sortText", "1_pm_request_headers_has" } });

    completions.push_back ({ { "label", "pm.request.headers.upsert" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.headers.upsert({ key: \"${1:X-Header}\", value: ${2:\"value\"} })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.headers.upsert({ key, value }) | (name, value)" },
    { "documentation",
    "Add the header, replacing any existing one of that name whatever its "
    "casing. The pre-request equivalent of assigning to "
    "pm.request.headers[name], and the safe choice when you do not know "
    "whether the header is already there." },
    { "sortText", "1_pm_request_headers_upsert" } });

    completions.push_back ({ { "label", "pm.request.headers.add" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.headers.add({ key: \"${1:X-Header}\", value: ${2:\"value\"} })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.headers.add({ key, value }) | (name, value)" },
    { "documentation",
    "Add a header that is not there yet. Throws if one of that name already "
    "exists - a request cannot carry the same header twice, so use upsert() to "
    "replace it." },
    { "sortText", "1_pm_request_headers_add" } });

    completions.push_back ({ { "label", "pm.request.headers.remove" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.headers.remove(\"${1:Authorization}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.headers.remove(name: string): void" },
    { "documentation",
    "Remove a header from the outgoing request, including one the Auth tab "
    "applied. Case-insensitive, and removing an absent header is a no-op." },
    { "sortText", "1_pm_request_headers_remove" } });

    completions.push_back ({ { "label", "pm.request.body" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.body" }, { "detail", "string | undefined (writable pre-request)" },
    { "documentation",
    "The request body content (if any). Assign a string to replace it, or "
    "delete it to send none. A body set on a request that had none is sent as "
    "raw text - set Content-Type yourself." },
    { "sortText", "1_pm_request_body" } });

    // Snippets for the mutation patterns. Without these, `pm.request.` offers
    // only the four reads and the capability is invisible in the editor.
    // filterText keeps each reachable from the prefix a user actually types.
    completions.push_back ({ { "label", "pm.request.headers[...] = ... (set a header)" },
    { "kind", KIND_SNIPPET },
    { "insertText", "pm.request.headers[\"${1:X-Header}\"] = ${2:\"value\"};" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "filterText", "pm.request.headers set" },
    { "detail", "Add or replace a header (pre-request)" },
    { "documentation",
    "Set a header on the outgoing request. Replaces an existing one of the "
    "same name." },
    { "sortText", "2_pm_request_headers_set" } });

    completions.push_back ({ { "label", "delete pm.request.headers[...] (remove a header)" },
    { "kind", KIND_SNIPPET }, { "insertText", "delete pm.request.headers[\"${1:Authorization}\"];" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "filterText", "pm.request.headers delete remove" },
    { "detail", "Remove a header (pre-request)" },
    { "documentation",
    "Remove a header from the outgoing request, including one the Auth tab "
    "applied. The name is case-sensitive - match it exactly." },
    { "sortText", "2_pm_request_headers_delete" } });

    completions.push_back (
    { { "label", "pm.request.body = JSON.stringify(...) (rewrite the body)" },
    { "kind", KIND_SNIPPET },
    { "insertText",
    "var body = JSON.parse(pm.request.body);\n${1:// body.field = \"value\";}\n"
    "pm.request.body = JSON.stringify(body);" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "filterText", "pm.request.body rewrite json" },
    { "detail", "Parse, edit and re-serialise the body (pre-request)" },
    { "documentation",
    "The body is a string in and a string out, so a structural edit is "
    "parse - mutate - stringify. Compute anything derived from the body after "
    "this, or it describes the old one." },
    { "sortText", "2_pm_request_body_rewrite" } });

    // ========================================
    // pm.info - Which request, which hook
    // ========================================
    completions.push_back ({ { "label", "pm.info" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.info" }, { "detail", "Script identity" },
    { "documentation",
    "What this script is attached to and which hook it is running in. Every "
    "field is optional - an ad-hoc request has no id, and an unsaved one has a "
    "name no stored request carries - so test with typeof rather than assuming "
    "a value.\n\niteration / iterationCount are deliberately absent: Vayu runs "
    "a load test's Tests script once per sampled response, not once per "
    "iteration, so there is no iteration number to report." },
    { "sortText", "0_pm_info" } });

    completions.push_back ({ { "label", "pm.info.requestId" }, { "kind", KIND_FIELD },
    { "insertText", "pm.info.requestId" }, { "detail", "string | undefined" },
    { "documentation",
    "The saved request's id, when the send was linked to one. undefined for an "
    "ad-hoc request." },
    { "sortText", "1_pm_info_requestId" } });

    completions.push_back ({ { "label", "pm.info.requestName" }, { "kind", KIND_FIELD },
    { "insertText", "pm.info.requestName" }, { "detail", "string | undefined" },
    { "documentation",
    "The request's name as the client sent it - the name in the editor, which "
    "may differ from the saved row for unsaved edits. undefined when the "
    "request has no name.\n\nExample:\nconsole.log('running ' + "
    "(pm.info.requestName || 'an unnamed request'));" },
    { "sortText", "1_pm_info_requestName" } });

    completions.push_back ({ { "label", "pm.info.eventName" }, { "kind", KIND_FIELD },
    { "insertText", "pm.info.eventName" }, { "detail", "'prerequest' | 'test'" },
    { "documentation",
    "Which hook is running: 'prerequest' in the Pre-request tab, 'test' in the "
    "Tests tab. Lets one shared script branch on where it was invoked "
    "from.\n\nExample:\nif (pm.info.eventName === 'prerequest') { /* sign the "
    "request */ }" },
    { "sortText", "1_pm_info_eventName" } });

    // ========================================
    // pm.environment - Environment variables
    // ========================================
    completions.push_back ({ { "label", "pm.environment" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.environment" }, { "detail", "Environment object" },
    { "documentation", "Access and modify environment variables. Changes persist to the active environment." },
    { "sortText", "0_pm_environment" } });

    completions.push_back ({ { "label", "pm.environment.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.environment.get(\"${1:variable}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.environment.get(name: string): string | undefined" },
    { "documentation",
    "Get an environment variable value by name.\n\nExample:\nconst token = "
    "pm.environment.get('auth_token');" },
    { "sortText", "1_pm_environment_get" } });

    completions.push_back ({ { "label", "pm.environment.set" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.environment.set(\"${1:variable}\", ${2:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.environment.set(name: string, value: any): void" },
    { "documentation",
    "Set an environment variable. The value will be "
    "persisted.\n\nExample:\npm.environment.set('auth_token', "
    "response.token);" },
    { "sortText", "1_pm_environment_set" } });

    // ========================================
    // pm.globals - Global variables
    // ========================================
    completions.push_back ({ { "label", "pm.globals" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.globals" }, { "detail", "Globals object" },
    { "documentation", "Access and modify global variables. Changes persist to global variables." },
    { "sortText", "0_pm_globals" } });

    completions.push_back ({ { "label", "pm.globals.get" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.globals.get(\"${1:variable}\")" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.globals.get(name: string): string | undefined" },
    { "documentation",
    "Get a global variable value by name.\n\nExample:\nconst apiKey = "
    "pm.globals.get('api_key');" },
    { "sortText", "1_pm_globals_get" } });

    completions.push_back ({ { "label", "pm.globals.set" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.globals.set(\"${1:variable}\", ${2:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.globals.set(name: string, value: any): void" },
    { "documentation", "Set a global variable. The value will be persisted.\n\nExample:\npm.globals.set('api_key', 'new_key');" },
    { "sortText", "1_pm_globals_set" } });

    // ========================================
    // pm.collectionVariables - Collection variables
    // ========================================
    completions.push_back ({ { "label", "pm.collectionVariables" },
    { "kind", KIND_VARIABLE }, { "insertText", "pm.collectionVariables" },
    { "detail", "CollectionVariables object" },
    { "documentation", "Access and modify collection variables. Changes persist to the collection." },
    { "sortText", "0_pm_collectionVariables" } });

    completions.push_back ({ { "label", "pm.collectionVariables.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.collectionVariables.get(\"${1:variable}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.collectionVariables.get(name: string): string | undefined" },
    { "documentation",
    "Get a collection variable value by name. Reads the whole collection chain "
    "- the nearest enabled definition wins, so a parent collection's variable "
    "resolves here too.\n\nExample:\nconst baseUrl = "
    "pm.collectionVariables.get('base_url');" },
    { "sortText", "1_pm_collectionVariables_get" } });

    completions.push_back ({ { "label", "pm.collectionVariables.set" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.collectionVariables.set(\"${1:variable}\", ${2:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.collectionVariables.set(name: string, value: any): void" },
    { "documentation",
    "Set a collection variable on the request's own collection - it shadows a "
    "parent collection's variable of the same name rather than changing it. "
    "The value will be "
    "persisted.\n\nExample:\npm.collectionVariables.set('base_url', "
    "'https://api.example.com');" },
    { "sortText", "1_pm_collectionVariables_set" } });

    // ========================================
    // has / unset / clear / toObject - identical on all three scopes, so
    // emitted from one table rather than nine more hand-written entries that
    // would then have to be kept in step with each other.
    // ========================================
    struct VariableScopeCompletion {
        const char* accessor; // pm.<accessor>
        const char* noun;     // what its variables are called in prose
        const char* example;  // a variable name that reads naturally for it
    };
    constexpr VariableScopeCompletion variable_scopes[] = {
        { "environment", "environment variable", "auth_token" },
        { "globals", "global variable", "api_key" },
        { "collectionVariables", "collection variable", "base_url" },
    };

    for (const auto& scope : variable_scopes) {
        const std::string accessor = std::string ("pm.") + scope.accessor;
        const std::string sort = std::string ("1_pm_") + scope.accessor + "_";
        const std::string noun = scope.noun;

        completions.push_back ({ { "label", accessor + ".has" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".has(\"${1:variable}\")" },
        { "insertTextRules", INSERT_AS_SNIPPET },
        { "detail", accessor + ".has(name: string): boolean" },
        { "documentation",
        "True when the " + noun + " exists and is enabled - the same rows " +
        accessor + ".get() can read.\n\nExample:\nif (" + accessor + ".has('" +
        scope.example + "')) { /* ... */ }" },
        { "sortText", sort + "has" } });

        completions.push_back ({ { "label", accessor + ".unset" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".unset(\"${1:variable}\")" },
        { "insertTextRules", INSERT_AS_SNIPPET },
        { "detail", accessor + ".unset(name: string): void" },
        { "documentation",
        "Remove the " + noun +
        " entirely. Not the same as setting it to \"\", which leaves an "
        "enabled empty variable behind for {{template}} resolution to "
        "find.\n\nExample:\n" +
        accessor + ".unset('" + scope.example + "');" },
        { "sortText", sort + "unset" } });

        completions.push_back ({ { "label", accessor + ".clear" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".clear()" },
        { "detail", accessor + ".clear(): void" },
        { "documentation", "Remove every " + noun + ", disabled ones included. Only this scope is affected." },
        { "sortText", sort + "clear" } });

        completions.push_back ({ { "label", accessor + ".toObject" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".toObject()" },
        { "detail", accessor + ".toObject(): Record<string, any>" },
        { "documentation",
        "A plain object of every enabled " + noun + ", each value cast by its declared type.\n\nExample:\nconsole.log(" +
        accessor + ".toObject());" },
        { "sortText", sort + "toObject" } });
    }

    // ========================================
    // pm.variables - merged read across the scopes
    // ========================================
    completions.push_back ({ { "label", "pm.variables" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.variables" }, { "detail", "Merged variables object (read-only)" },
    { "documentation",
    "Read a variable without naming its scope. Resolves environment, then "
    "collection, then global - the same order {{name}} uses. Writes must name "
    "a scope: pm.variables.set() throws." },
    { "sortText", "0_pm_variables" } });

    completions.push_back ({ { "label", "pm.variables.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.variables.get(\"${1:variable}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.variables.get(name: string): any | undefined" },
    { "documentation",
    "Get a variable from the highest-precedence scope that has it enabled: "
    "environment, then collection, then global.\n\nExample:\nconst baseUrl = "
    "pm.variables.get('base_url');" },
    { "sortText", "1_pm_variables_get" } });

    completions.push_back ({ { "label", "pm.variables.has" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.variables.has(\"${1:variable}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.variables.has(name: string): boolean" },
    { "documentation", "True when any scope has the variable enabled." },
    { "sortText", "1_pm_variables_has" } });

    completions.push_back ({ { "label", "pm.variables.toObject" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.variables.toObject()" },
    { "detail", "pm.variables.toObject(): Record<string, any>" },
    { "documentation",
    "Every enabled variable from all three scopes, merged in precedence "
    "order - each name resolves to what pm.variables.get() would answer." },
    { "sortText", "1_pm_variables_toObject" } });

    completions.push_back ({ { "label", "pm.variables.replaceIn" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.variables.replaceIn(\"${1:template}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.variables.replaceIn(template: string): string" },
    { "documentation",
    "Resolve {{name}} placeholders in a string, exactly as the request's own "
    "URL/headers/body are resolved: scopes first (environment > collection > "
    "global), then the dynamic-variable table - {{$guid}}, {{$timestamp}}, "
    "{{$random*}} generate a fresh value per occurrence. This is the way to "
    "use {{...}} inside a script: script code itself is never "
    "interpolated.\n\nExample:\nconst id = "
    "pm.variables.replaceIn('{{$guid}}');" },
    { "sortText", "1_pm_variables_replaceIn" } });

    // ========================================
    // pm.sendRequest - the one thing in the sandbox that touches the network
    // ========================================
    completions.push_back ({ { "label", "pm.sendRequest" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.sendRequest(${1:url}, function (err, res) {\n\t$0\n})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail",
    "pm.sendRequest(urlOrOptions: string | { url: string; method?: string; "
    "header?: object; body?: string | { mode: 'raw'; raw: string }; timeout?: "
    "number }, callback: (err: Error | null, res: any) => void): void" },
    { "documentation",
    "Send an auxiliary request - fetching a token in a pre-request script is "
    "what it is for.\n\nSynchronous despite the callback: the sandbox has no "
    "event loop, so the send blocks and the callback runs inline before "
    "sendRequest returns. Postman's promise-returning overload is deliberately "
    "absent - it could only never resolve.\n\nThe callback gets (err, res). "
    "Transport failures - refused, DNS, timeout - arrive as err with a .code; "
    "res is null then. res carries code, status, responseTime, headers.get() "
    "and json()/text() - a subset of pm.response, not the assertion "
    "chain.\n\nBounded on purpose: the request's timeout is capped "
    "at whatever is left of the script's own time budget, and one script may "
    "issue at most 10 requests. Both throw when exceeded.\n\n**Not available "
    "to agents.** Vayu's MCP target allowlist is checked before the engine is "
    "called, so a request sent from inside a script would bypass it. When a "
    "run comes from the MCP server this throws instead of "
    "sending.\n\nExample:\npm.sendRequest('https://auth.example.com/token', "
    "function (err, res) {\n  if (err) { return; }\n  "
    "pm.environment.set('token', res.json().access_token);\n});" },
    { "sortText", "0_pm_sendRequest" } });

    // ========================================
    // pm.crypto - Hashing, and the base64 globals that go with it
    // ========================================
    completions.push_back ({ { "label", "pm.crypto" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.crypto" }, { "detail", "Synchronous hashing" },
    { "documentation",
    "SHA-256 and HMAC-SHA256 for signing an outgoing request from a "
    "pre-request script.\n\nSynchronous, unlike Web Crypto's crypto.subtle: "
    "the sandbox has no event loop, so a Promise-based API would never "
    "settle. That is why this is pm.crypto rather than a global named "
    "crypto." },
    { "sortText", "0_pm_crypto" } });

    completions.push_back ({ { "label", "pm.crypto.sha256" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.crypto.sha256(${1:data})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail",
    "pm.crypto.sha256(data: string | Uint8Array, encoding?: 'hex' | 'base64' "
    "| 'base64url' | 'bytes'): string | Uint8Array" },
    { "documentation",
    "SHA-256 digest, hex by default. A string is hashed as its UTF-8 bytes; "
    "pass a Uint8Array to hash bytes directly.\n\nExample:\nconst digest = "
    "pm.crypto.sha256(pm.request.body || '');" },
    { "sortText", "1_pm_crypto_sha256" } });

    completions.push_back ({ { "label", "pm.crypto.hmacSha256" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.crypto.hmacSha256(${1:key}, ${2:data})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail",
    "pm.crypto.hmacSha256(key: string | Uint8Array, data: string | "
    "Uint8Array, encoding?: 'hex' | 'base64' | 'base64url' | 'bytes'): string "
    "| Uint8Array" },
    { "documentation",
    "HMAC-SHA256, hex by default. Use encoding 'bytes' to get a Uint8Array "
    "you can pass back as the key, which is what multi-round key derivation "
    "(AWS SigV4) needs.\n\nExample:\npm.request.headers['X-Signature'] =\n  "
    "pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);" },
    { "sortText", "1_pm_crypto_hmacSha256" } });

    completions.push_back ({ { "label", "btoa" }, { "kind", KIND_FUNCTION },
    { "insertText", "btoa(${1:text})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "btoa(data: string): string" },
    { "documentation",
    "Base64-encode a binary string, with the standard web semantics: one byte "
    "per character, so a code point above U+00FF throws rather than being "
    "silently UTF-8 encoded." },
    { "sortText", "2_btoa" } });

    completions.push_back ({ { "label", "atob" }, { "kind", KIND_FUNCTION },
    { "insertText", "atob(${1:encoded})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "atob(encoded: string): string" },
    { "documentation",
    "Decode base64 to a binary string - one character per byte. Throws on "
    "input that is not valid base64." },
    { "sortText", "2_atob" } });

    completions.push_back ({ { "label", "Sign the outgoing request" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "// Pre-request: sign what is actually about to be sent.\nconst timestamp "
    "= Date.now().toString();\nconst canonical = [pm.request.method, "
    "pm.request.url, timestamp, pm.request.body || "
    "''].join('\\n');\npm.request.headers['X-Timestamp'] = "
    "timestamp;\npm.request.headers['X-Signature'] = "
    "pm.crypto.hmacSha256(pm.environment.get(\"${1:secret}\"), canonical);" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Script template" },
    { "documentation",
    "HMAC-sign the request from a pre-request script. Build the canonical "
    "string after any other edits, so the signature covers what is sent." },
    { "sortText", "3_snippet_sign" } });

    // ========================================
    // console - Console output
    // ========================================
    completions.push_back ({ { "label", "console.log" }, { "kind", KIND_FUNCTION },
    { "insertText", "console.log(${1:message})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "console.log(...args: any[]): void" },
    { "documentation",
    "Log a message to the console output. Output appears in the test "
    "results.\n\nExample:\nconsole.log('Response:', pm.response.json());" },
    { "sortText", "0_console_log" } });

    completions.push_back ({ { "label", "console.info" }, { "kind", KIND_FUNCTION },
    { "insertText", "console.info(${1:message})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "console.info(...args: any[]): void" },
    { "documentation", "Log an info message to the console." },
    { "sortText", "0_console_info" } });

    completions.push_back ({ { "label", "console.warn" }, { "kind", KIND_FUNCTION },
    { "insertText", "console.warn(${1:message})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "console.warn(...args: any[]): void" },
    { "documentation", "Log a warning message to the console." },
    { "sortText", "0_console_warn" } });

    completions.push_back ({ { "label", "console.error" }, { "kind", KIND_FUNCTION },
    { "insertText", "console.error(${1:message})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "console.error(...args: any[]): void" },
    { "documentation", "Log an error message to the console." },
    { "sortText", "0_console_error" } });

    // ========================================
    // Chai assertion chains (for pm.expect)
    // ========================================
    completions.push_back ({ { "label", "to.equal" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.equal(${1:expected})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.equal(expected: any)" },
    { "documentation",
    "Assert strict equality (===). Objects and arrays compare by reference, so "
    "use .to.eql for contents.\n\nExample:\npm.expect(status).to.equal(200);" },
    { "sortText", "2_to_equal" }, { "filterText", ".to.equal" } });

    completions.push_back ({ { "label", "to.eql" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.eql(${1:expected})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.eql(expected: any)" },
    { "documentation",
    "Assert deep equality (for objects/arrays). Key order does not "
    "matter.\n\nExample:\npm.expect(data).to.eql({id: 1, "
    "name: 'test'});" },
    { "sortText", "2_to_eql" }, { "filterText", ".to.eql" } });

    completions.push_back ({ { "label", "to.deep.equal" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.deep.equal(${1:expected})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.deep.equal(expected: any)" },
    { "documentation",
    "Assert deep equality (alias for .to.eql). The `deep` chainer also applies "
    "to .include, .property, .members and "
    ".oneOf.\n\nExample:\npm.expect(data).to.deep.equal({id: 1});" },
    { "sortText", "2_to_deep_equal" }, { "filterText", ".to.deep.equal" } });

    completions.push_back ({ { "label", "to.be.true" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.true" }, { "detail", ".to.be.true" },
    { "documentation", "Assert the value is true." },
    { "sortText", "2_to_be_true" }, { "filterText", ".to.be.true" } });

    completions.push_back ({ { "label", "to.be.false" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.false" }, { "detail", ".to.be.false" },
    { "documentation", "Assert the value is false." },
    { "sortText", "2_to_be_false" }, { "filterText", ".to.be.false" } });

    completions.push_back ({ { "label", "to.be.null" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.null" }, { "detail", ".to.be.null" },
    { "documentation", "Assert the value is null." },
    { "sortText", "2_to_be_null" }, { "filterText", ".to.be.null" } });

    completions.push_back ({ { "label", "to.be.undefined" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.undefined" }, { "detail", ".to.be.undefined" },
    { "documentation", "Assert the value is undefined." },
    { "sortText", "2_to_be_undefined" }, { "filterText", ".to.be.undefined" } });

    completions.push_back ({ { "label", "to.be.ok" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.ok" }, { "detail", ".to.be.ok" },
    { "documentation", "Assert the value is truthy." },
    { "sortText", "2_to_be_ok" }, { "filterText", ".to.be.ok" } });

    completions.push_back ({ { "label", "to.exist" }, { "kind", KIND_FIELD },
    { "insertText", "to.exist" }, { "detail", ".to.exist" },
    { "documentation", "Assert the value is not null or undefined." },
    { "sortText", "2_to_exist" }, { "filterText", ".to.exist" } });

    completions.push_back ({ { "label", "to.be.above" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.above(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.above(n: number)" },
    { "documentation",
    "Assert the number is greater than "
    "n.\n\nExample:\npm.expect(responseTime).to.be.above(0);" },
    { "sortText", "2_to_be_above" }, { "filterText", ".to.be.above" } });

    completions.push_back ({ { "label", "to.be.below" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.below(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.below(n: number)" },
    { "documentation",
    "Assert the number is less than "
    "n.\n\nExample:\npm.expect(pm.response.responseTime).to.be.below(1000);" },
    { "sortText", "2_to_be_below" }, { "filterText", ".to.be.below" } });

    completions.push_back ({ { "label", "to.be.at.least" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.at.least(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.at.least(n: number)" },
    { "documentation", "Assert the number is greater than or equal to n." },
    { "sortText", "2_to_be_at_least" }, { "filterText", ".to.be.at.least" } });

    completions.push_back ({ { "label", "to.be.at.most" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.at.most(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.at.most(n: number)" },
    { "documentation", "Assert the number is less than or equal to n." },
    { "sortText", "2_to_be_at_most" }, { "filterText", ".to.be.at.most" } });

    completions.push_back ({ { "label", "to.have.property" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.property(\"${1:name}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.property(name: string)" },
    { "documentation", "Assert the object has a property.\n\nExample:\npm.expect(data).to.have.property('id');" },
    { "sortText", "2_to_have_property" }, { "filterText", ".to.have.property" } });

    completions.push_back ({ { "label", "to.have.length" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.length(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.length(n: number)" },
    { "documentation", "Assert array or string length.\n\nExample:\npm.expect(items).to.have.length(5);" },
    { "sortText", "2_to_have_length" }, { "filterText", ".to.have.length" } });

    completions.push_back ({ { "label", "to.have.lengthOf" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.lengthOf(${1:n})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.lengthOf(n: number)" },
    { "documentation", "Assert array or string length (alias for .to.have.length)." },
    { "sortText", "2_to_have_lengthOf" }, { "filterText", ".to.have.lengthOf" } });

    completions.push_back ({ { "label", "to.include" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.include(${1:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.include(value: any)" },
    { "documentation",
    "Assert array includes value or string contains "
    "substring.\n\nExample:\npm.expect(tags).to.include('featured');" },
    { "sortText", "2_to_include" }, { "filterText", ".to.include" } });

    completions.push_back ({ { "label", "to.contain" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.contain(${1:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.contain(value: any)" },
    { "documentation", "Assert array includes value (alias for .to.include)." },
    { "sortText", "2_to_contain" }, { "filterText", ".to.contain" } });

    completions.push_back ({ { "label", "to.be.a" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.be.a(\"${1:type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.a(type: string)" },
    { "documentation",
    "Assert the value is of a specific "
    "type.\n\nExample:\npm.expect(name).to.be.a('string');\npm.expect("
    "count).to.be.a('number');" },
    { "sortText", "2_to_be_a" }, { "filterText", ".to.be.a" } });

    completions.push_back ({ { "label", "to.be.an" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.be.an(\"${1:type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.an(type: string)" },
    { "documentation",
    "Assert the value is of a specific type (use with "
    "vowels).\n\nExample:\npm.expect(items).to.be.an('array');\npm.expect("
    "data).to.be.an('object');" },
    { "sortText", "2_to_be_an" }, { "filterText", ".to.be.an" } });

    completions.push_back ({ { "label", "to.match" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.match(/${1:pattern}/)" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.match(regex: RegExp)" },
    { "documentation",
    "Assert the string matches a regular "
    "expression.\n\nExample:\npm.expect(email).to.match(/"
    "^[\\w-]+@[\\w-]+\\.[a-z]+$/);" },
    { "sortText", "2_to_match" }, { "filterText", ".to.match" } });

    completions.push_back ({ { "label", "to.be.empty" }, { "kind", KIND_FIELD },
    { "insertText", "to.be.empty" }, { "detail", ".to.be.empty" },
    { "documentation", "Assert the array/string/object is empty." },
    { "sortText", "2_to_be_empty" }, { "filterText", ".to.be.empty" } });

    completions.push_back ({ { "label", "to.not" }, { "kind", KIND_FIELD },
    { "insertText", "to.not" }, { "detail", ".to.not" },
    { "documentation", "Negate the assertion chain.\n\nExample:\npm.expect(value).to.not.equal(0);" },
    { "sortText", "2_to_not" }, { "filterText", ".to.not" } });

    completions.push_back ({ { "label", "to.be.oneOf" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.oneOf([${1:values}])" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.oneOf(values: any[])" },
    { "documentation",
    "Assert the value is one of the given "
    "candidates.\n\nExample:\npm.expect(pm.response.code).to.be.oneOf([200, "
    "201]);" },
    { "sortText", "2_to_be_oneOf" }, { "filterText", ".to.be.oneOf" } });

    completions.push_back ({ { "label", "to.eqls" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.eqls(${1:expected})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.eqls(expected: any)" },
    { "documentation", "Assert deep equality (alias for .to.eql)." },
    { "sortText", "2_to_eqls" }, { "filterText", ".to.eqls" } });

    completions.push_back ({ { "label", "to.have.keys" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.keys(\"${1:key}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.keys(...keys: string[])" },
    { "documentation",
    "Assert the object has exactly these keys - not a subset. Accepts names or "
    "one array.\n\nExample:\npm.expect(json).to.have.keys(\"id\", \"name\");" },
    { "sortText", "2_to_have_keys" }, { "filterText", ".to.have.keys" } });

    completions.push_back ({ { "label", "to.have.all.keys" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.all.keys(\"${1:key}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.all.keys(...keys: string[])" },
    { "documentation",
    "Assert the object has exactly these keys. `all` is chai's default and "
    "changes nothing; `any` is not supported." },
    { "sortText", "2_to_have_all_keys" }, { "filterText", ".to.have.all.keys" } });

    completions.push_back ({ { "label", "to.have.key" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.key(\"${1:key}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.key(key: string)" },
    { "documentation", "Assert the object has exactly this key (alias for .to.have.keys)." },
    { "sortText", "2_to_have_key" }, { "filterText", ".to.have.key" } });

    completions.push_back ({ { "label", "to.have.members" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.members([${1:values}])" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.members(values: any[])" },
    { "documentation",
    "Assert the array has the same members in any order. Prefix with `deep` to "
    "compare object members by "
    "value.\n\nExample:\npm.expect(ids).to.have.members([3, 1, 2]);" },
    { "sortText", "2_to_have_members" }, { "filterText", ".to.have.members" } });

    completions.push_back ({ { "label", "to.have.nested.property" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.nested.property(\"${1:a.b.c}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.have.nested.property(path: string, value?: any)" },
    { "documentation",
    "Assert a property at a dotted or indexed path exists (and optionally "
    "equals a "
    "value).\n\nExample:\npm.expect(json).to.have.nested.property(\"data.items["
    "0].id\");" },
    { "sortText", "2_to_have_nested_property" },
    { "filterText", ".to.have.nested.property" } });

    completions.push_back ({ { "label", "to.have.string" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.string(\"${1:substring}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.string(substring: string)" },
    { "documentation",
    "Assert the string contains a substring. Unlike .to.include it refuses a "
    "non-string "
    "target.\n\nExample:\npm.expect(pm.response.text()).to.have.string(\"ok\")"
    ";" },
    { "sortText", "2_to_have_string" }, { "filterText", ".to.have.string" } });

    completions.push_back ({ { "label", "to.throw" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.throw()" }, { "detail", ".to.throw(message?: string | RegExp)" },
    { "documentation",
    "Assert the function throws, optionally matching the message.\n\nExample:\n"
    "pm.expect(function() { JSON.parse(\"{\"); }).to.throw();" },
    { "sortText", "2_to_throw" }, { "filterText", ".to.throw" } });

    completions.push_back ({ { "label", "to.throws" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.throws()" }, { "detail", ".to.throws(message?: string | RegExp)" },
    { "documentation", "Assert the function throws (alias for .to.throw)." },
    { "sortText", "2_to_throws" }, { "filterText", ".to.throws" } });

    completions.push_back ({ { "label", "to.be.instanceOf" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.be.instanceOf(${1:Array})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.be.instanceOf(constructor: Function)" },
    { "documentation",
    "Assert the value is an instance of a "
    "constructor.\n\nExample:\npm.expect(json.items).to.be.instanceOf(Array)"
    ";" },
    { "sortText", "2_to_be_instanceOf" }, { "filterText", ".to.be.instanceOf" } });

    completions.push_back ({ { "label", "to.be.closeTo" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.be.closeTo(${1:expected}, ${2:delta})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.be.closeTo(expected: number, delta: number)" },
    { "documentation",
    "Assert the number is within delta of expected. The delta is "
    "required.\n\nExample:\npm.expect(total).to.be.closeTo(9.99, 0.01);" },
    { "sortText", "2_to_be_closeTo" }, { "filterText", ".to.be.closeTo" } });

    completions.push_back ({ { "label", "to.satisfy" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.satisfy(function(value) { return ${1:true}; })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.satisfy(predicate: (value: any) => boolean)" },
    { "documentation",
    "Assert the predicate returns a truthy value for the "
    "target.\n\nExample:\npm.expect(n).to.satisfy(function(v) { return v % 2 "
    "=== 0; });" },
    { "sortText", "2_to_satisfy" }, { "filterText", ".to.satisfy" } });

    completions.push_back ({ { "label", "and" }, { "kind", KIND_FIELD },
    { "insertText", "and" }, { "detail", ".and" },
    { "documentation",
    "Continue an assertion chain. Flags already set (including `not`) carry "
    "over.\n\nExample:\npm.expect(n).to.be.above(0).and.to.be.below(10);" },
    { "sortText", "2_and" }, { "filterText", ".and" } });

    // ========================================
    // Common snippets / templates
    // ========================================
    completions.push_back ({ { "label", "Test: Status code" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "pm.test(\"Status code is ${1:200}\", function() "
    "{\n\tpm.response.to.have.status(${1:200});\n});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Test template" },
    { "documentation", "Quick template for status code test." },
    { "sortText", "3_snippet_status" } });

    completions.push_back ({ { "label", "Test: Response time" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "pm.test(\"Response time is less than ${1:500}ms\", function() "
    "{\n\tpm.expect(pm.response.responseTime).to.be.below(${1:500});\n});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Test template" },
    { "documentation", "Quick template for response time test." },
    { "sortText", "3_snippet_time" } });

    completions.push_back ({ { "label", "Test: JSON property" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "pm.test(\"Response has ${1:property}\", function() {\n\tconst json = "
    "pm.response.json();\n\tpm.expect(json).to.have.property(\"${1:property}\")"
    ";\n});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Test template" },
    { "documentation", "Quick template for JSON property test." },
    { "sortText", "3_snippet_property" } });

    completions.push_back ({ { "label", "Test: JSON value" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "pm.test(\"${1:Field} equals ${2:value}\", function() {\n\tconst json = "
    "pm.response.json();\n\tpm.expect(json.${1:field}).to.equal(${2:value});\n}"
    ");" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Test template" },
    { "documentation", "Quick template for JSON value assertion." },
    { "sortText", "3_snippet_value" } });

    completions.push_back ({ { "label", "Test: Content-Type JSON" }, { "kind", KIND_SNIPPET },
    { "insertText",
    // get() rather than an index: response header keys are lower-cased by the
    // HTTP client, so headers["Content-Type"] reads back undefined and this
    // fails as an assertion, which reads as a server fault rather than a bad
    // example. get() is case-insensitive, so the name stays spelled the way the
    // to.have.header line above spells it.
    "pm.test(\"Content-Type is JSON\", function() "
    "{\n\tpm.response.to.have.header(\"Content-Type\");\n\tpm.expect(pm."
    "response.headers.get("
    "\"Content-Type\")).to.include(\"application/json\");\n});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Test template" },
    { "documentation", "Quick template for Content-Type header test." },
    { "sortText", "3_snippet_content_type" } });

    completions.push_back ({ { "label", "Set environment variable" }, { "kind", KIND_SNIPPET },
    { "insertText",
    "// Extract and save ${1:token} to environment\nconst json = "
    "pm.response.json();\npm.environment.set(\"${1:token}\", "
    "json.${2:token});" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Script template" },
    { "documentation", "Extract a value from response and save to environment." },
    { "sortText", "3_snippet_set_env" } });

    completions.push_back ({ { "label", "Log response" }, { "kind", KIND_SNIPPET },
    { "insertText", "console.log(\"Response:\", JSON.stringify(pm.response.json(), null, 2));" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "Script template" },
    { "documentation", "Log the formatted JSON response." },
    { "sortText", "3_snippet_log" } });

    return completions;
}

void register_scripting_routes (RouteContext& ctx) {
    /**
     * GET /scripting/completions
     * Returns script engine API completions for UI autocomplete.
     * This is a startup API - frontend fetches once and caches.
     */
    ctx.server.Get ("/scripting/completions",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info (
        "GET /scripting/completions - Fetching script API completions");
        try {
            nlohmann::json response = { { "version", "1.0.0" }, { "engine", "quickjs" },
                { "completions", get_script_completions () } };
            send_json (res, response);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /scripting/completions - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * GET /scripting/types
     * Returns the TypeScript declarations for the same surface, generated from
     * the completion table above (see script_types.cpp). The app feeds these to
     * Monaco's TypeScript worker, which is what turns a suggestion list into
     * hover documentation, signature help and typo diagnostics.
     *
     * Served as text in a JSON envelope rather than as a `.d.ts` body so the
     * app can cache on `version` without re-parsing the declarations.
     */
    ctx.server.Get ("/scripting/types",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info (
        "GET /scripting/types - Generating script type declarations");
        try {
            const std::string dts = generate_script_typedefs ();
            nlohmann::json response = { { "version", "1.0.0" }, { "engine", "quickjs" },
                { "libUri", "ts:vayu/pm.d.ts" }, { "typeDefinitions", dts } };
            send_json (res, response);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "GET /scripting/types - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });
}

} // namespace vayu::http::routes
