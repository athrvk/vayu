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

#include <array>
#include <format>
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
    completions.push_back ({ { "label", "pm.expect" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.expect(${1:value})" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.expect(value: any, message?: string)" },
    { "documentation",
    "Create a Chai-style expectation for assertions.\n\nThe optional second "
    "argument is prefixed to the failure message, so a failing assertion says "
    "which value it was about.\n\nChain with:\n- "
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

    completions.push_back ({ { "label", "pm.response.errorCode" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.errorCode" }, { "detail", "string | undefined" },
    { "documentation",
    "Why the send failed before a response arrived - TIMEOUT, "
    "CONNECTION_FAILED, "
    "DNS_ERROR, SSL_ERROR and friends. Absent when the request reached the "
    "server, so its presence is the test for a transport failure; the status "
    "code in that case is the synthetic 0.\n\nExample:\nif "
    "(pm.response.errorCode) { console.log('never sent: ' + "
    "pm.response.errorCode); }" },
    { "sortText", "1_pm_response_errorCode" } });

    completions.push_back ({ { "label", "pm.response.errorMessage" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.errorMessage" }, { "detail", "string | undefined" },
    { "documentation",
    "The transport failure in words, alongside errorCode. Absent for the same "
    "reason errorCode is - a response that arrived did not fail." },
    { "sortText", "1_pm_response_errorMessage" } });

    completions.push_back ({ { "label", "pm.response.events" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.events" }, { "detail", "object[] | undefined" },
    { "documentation",
    "The events a streaming request received, as { event, id, data } entries "
    "(id absent when the origin sent none; dataTruncated when one event hit "
    "the per-event byte cap). Buffered, not live: the sandbox is synchronous "
    "with no event loop, so a post-request script runs once, after the stream "
    "has terminated, over this list.\n\nAbsent - not empty - for an ordinary "
    "response, so typeof separates 'not a stream' from 'a stream with no "
    "events'. The list is bounded by sseMaxStoredEvents; check "
    "eventsTruncated before asserting over it as a whole.\n\nExample:\nconst "
    "events = pm.response.events || [];\npm.test('got the done event', "
    "function () { pm.expect(events.some(function (e) { return e.event === "
    "'done'; })).to.be.true; });" },
    { "sortText", "1_pm_response_events" } });

    completions.push_back ({ { "label", "pm.response.totalEvents" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.totalEvents" }, { "detail", "number | undefined" },
    { "documentation",
    "How many events the stream received in total, including those beyond the "
    "stored list. Mirrors the run trace's totalEvents. Absent for a "
    "non-streaming response, like pm.response.events." },
    { "sortText", "1_pm_response_totalEvents" } });

    completions.push_back ({ { "label", "pm.response.eventsTruncated" },
    { "kind", KIND_FIELD }, { "insertText", "pm.response.eventsTruncated" },
    { "detail", "boolean | undefined" },
    { "documentation",
    "True when pm.response.events is a prefix of what the stream sent - "
    "totalEvents exceeded sseMaxStoredEvents. Guard a whole-stream assertion "
    "with it rather than asserting over a partial list.\n\nExample:\nif "
    "(!pm.response.eventsTruncated) { pm.test('exactly three events', function "
    "() { pm.expect(pm.response.events.length).to.equal(3); }); }" },
    { "sortText", "1_pm_response_eventsTruncated" } });

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
    { "detail", "pm.response.headers.has(name: string, value?: string): boolean" },
    { "documentation",
    "Whether the response carries a header of that name, case-insensitively. "
    "With a second argument, whether it also carries that exact value - the "
    "comparison is strict, so a number never matches the wire's string." },
    { "sortText", "1_pm_response_headers_has" } });

    completions.push_back ({ { "label", "pm.response.cookies" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.cookies" }, { "detail", "object" },
    { "documentation",
    "The response's Set-Cookie header, parsed: an array of { name, value, "
    "attrs } in wire order, with get()/has()/toObject() over it. `attrs` "
    "holds the raw attribute chunks ('Path=/', 'HttpOnly'). This is one "
    "response's Set-Cookie and nothing else - for what vayu will send on the "
    "next request, read pm.cookies." },
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
    { "detail", "pm.response.to.have.status(code: number | string)" },
    { "documentation",
    "Assert that the response has a specific HTTP status code, or - given a "
    "string - the reason phrase pm.response.reason() "
    "answers.\n\nExample:\npm.response.to.have.status(200);\npm.response.to."
    "have.status('OK');" },
    { "sortText", "1_pm_response_to_have_status" } });

    completions.push_back ({ { "label", "pm.response.to.have.header" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.response.to.have.header(\"${1:Content-Type}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.to.have.header(name: string, value?: string)" },
    { "documentation",
    "Assert that a specific header exists in the response, and - with a second "
    "argument - that it holds that exact value. The value comparison is "
    "strict, so a number never matches the wire's "
    "string.\n\nExample:\npm.response.to.have.header('Content-Type');\npm."
    "response.to.have.header('Content-Type', 'application/json');" },
    { "sortText", "1_pm_response_to_have_header" } });

    completions.push_back ({ { "label", "pm.response.to.have.body" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.to.have.body(\"${1:body}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.response.to.have.body(expected: string | RegExp | object)" },
    { "documentation",
    "Assert what the response body is. A string must equal the body exactly, a "
    "regular expression must match it, and an object must deeply equal the "
    "parsed JSON.\n\nExample:\npm.response.to.have.body('pong');\npm.response."
    "to.have.body(/^\\{\"ok\"/);\npm.response.to.have.body({ ok: true });" },
    { "sortText", "1_pm_response_to_have_body" } });

    completions.push_back ({ { "label", "pm.response.to.have.jsonBody" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.response.to.have.jsonBody()" },
    { "detail", "pm.response.to.have.jsonBody(path?: string, value?: unknown)" },
    { "documentation",
    "Assert that the response has a valid JSON body; with a path, that the "
    "body holds that property; with a value, that the property deeply equals "
    "it.\n\nExample:\npm.response.to.have.jsonBody();\npm.response.to.have."
    "jsonBody('data.id');\npm.response.to.have.jsonBody('data.id', 42);" },
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
    constexpr auto status_classes = std::to_array<StatusClassCompletion> ({
    { "ok", "status 200" },
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
    });

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
    { "insertText", "pm.request.url" }, { "detail", "string & object (writable pre-request)" },
    { "documentation",
    "The full request URL, as Postman's Url object: protocol, host, port, "
    "path, query and hash, plus getHost(), getPath(), getQueryString() and "
    "toString(). {{variables}} are already resolved here.\n\nIt still behaves "
    "as the string it used to be - concatenation, template literals, ==, the "
    "String methods and .length all give the full URL - so `===` and `typeof` "
    "are the two things that changed. Assign a string to retarget "
    "the request before it is sent, or call url.update(...); either way it "
    "must be non-empty." },
    { "sortText", "1_pm_request_url" } });

    completions.push_back ({ { "label", "pm.request.url.protocol" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.protocol" }, { "detail", "string" },
    { "documentation",
    "The scheme with no trailing colon (\"https\"). Empty when the URL "
    "cannot be parsed." },
    { "sortText", "2_pm_request_url_protocol" } });

    completions.push_back ({ { "label", "pm.request.url.host" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.host" }, { "detail", "string[]" },
    { "documentation",
    "The host split on dots, as Postman presents it: \"api.example.com\" is "
    "[\"api\", \"example\", \"com\"]. Use getHost() for the joined form.\n\n"
    "Editable in a pre-request script, the same way path is." },
    { "sortText", "2_pm_request_url_host" } });

    completions.push_back ({ { "label", "pm.request.url.port" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.port" }, { "detail", "string" },
    { "documentation",
    "The port the URL states, as a string. Empty when it states none - a "
    "scheme's default port is never filled in." },
    { "sortText", "2_pm_request_url_port" } });

    completions.push_back ({ { "label", "pm.request.url.path" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.path" }, { "detail", "string[]" },
    { "documentation",
    "The path as decoded segments: \"/v2/users\" is [\"v2\", \"users\"]. Each "
    "segment is decoded on its own, so an encoded slash stays inside the "
    "segment it belongs to. Use getPath() for the joined form.\n\nEditable in "
    "a pre-request script - push, splice, index assignment and replacing the "
    "whole array all reach the URL that is sent." },
    { "sortText", "2_pm_request_url_path" } });

    completions.push_back ({ { "label", "pm.request.url.length" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.length" }, { "detail", "number" },
    { "documentation",
    "The length of the whole URL string - defined on the object rather than "
    "inherited, so it is the URL's own length and not the 0 that String's "
    "prototype would have answered." },
    { "sortText", "2_pm_request_url_length" } });

    completions.push_back ({ { "label", "pm.request.url.hash" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.hash" }, { "detail", "string" },
    { "documentation", "The fragment with no leading #. Empty when there is none." },
    { "sortText", "2_pm_request_url_hash" } });

    completions.push_back ({ { "label", "pm.request.url.query" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url.query" }, { "detail", "Url query object" },
    { "documentation",
    "The query parameters, with Postman's PropertyList reads over them - "
    "get(name), has(name), all(), toObject(), count() - and its writers: "
    "add, upsert, remove, clear. Values are the wire bytes, not decoded - a "
    "signature has to canonicalize what was sent." },
    { "sortText", "2_pm_request_url_query" } });

    completions.push_back ({ { "label", "pm.request.url.query.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.get(\"${1:page}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.query.get(name: string): string | null" },
    { "documentation",
    "The first value of that parameter, or null when the name is absent or "
    "carries no value (\"?flag\"). First rather than last, matching "
    "Postman's PropertyList - all() is the view that keeps duplicates." },
    { "sortText", "3_pm_request_url_query_get" } });

    completions.push_back ({ { "label", "pm.request.url.query.has" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.has(\"${1:page}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.query.has(name: string): boolean" },
    { "documentation",
    "Whether the query carries that parameter at all, including a bare "
    "\"?flag\" that has no value." },
    { "sortText", "3_pm_request_url_query_has" } });

    completions.push_back ({ { "label", "pm.request.url.query.all" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.all()" },
    { "detail", "pm.request.url.query.all(): { key: string, value: string | null }[]" },
    { "documentation",
    "Every parameter as { key, value }, in wire order, duplicates kept - the "
    "view a canonical query string is built from. A parameter with no value "
    "has value null." },
    { "sortText", "3_pm_request_url_query_all" } });

    completions.push_back ({ { "label", "pm.request.url.query.toObject" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.toObject()" },
    { "detail", "pm.request.url.query.toObject(): { [key: string]: string | null }" },
    { "documentation",
    "The query as a plain { name: value } object, last wins on a repeated "
    "name. Use all() when duplicates matter." },
    { "sortText", "3_pm_request_url_query_toObject" } });

    completions.push_back ({ { "label", "pm.request.url.query.count" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.count()" },
    { "detail", "pm.request.url.query.count(): number" },
    { "documentation", "How many parameters the query carries, counting duplicates separately." },
    { "sortText", "3_pm_request_url_query_count" } });

    completions.push_back ({ { "label", "pm.request.url.query.add" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.url.query.add({ key: \"${1:trace}\", value: ${2:id} })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.query.add(param: { key: string, value?: string | number | boolean | null }): void" },
    { "documentation",
    "Append a parameter, even when the name is already there - a query may "
    "repeat a name, which is why all() exists. Omit value for a bare "
    "\"?flag\". Use upsert to replace instead of appending." },
    { "sortText", "3_pm_request_url_query_add" } });

    completions.push_back (
    { { "label", "pm.request.url.query.upsert" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.url.query.upsert({ key: \"${1:page}\", value: ${2:n} })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.query.upsert(param: { key: string, value?: string | number | boolean | null }): void" },
    { "documentation",
    "Replace the first parameter of that name, keeping its position in the "
    "query, or append it when there is none. Position is kept because a "
    "signature over the query changes shape if a parameter moves." },
    { "sortText", "3_pm_request_url_query_upsert" } });

    completions.push_back ({ { "label", "pm.request.url.query.remove" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.remove(\"${1:page}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.query.remove(name: string): void" },
    { "documentation",
    "Remove every parameter of that name, not just the first. A name that is "
    "not there is a no-op, the same rule pm.request.headers.remove follows." },
    { "sortText", "3_pm_request_url_query_remove" } });

    completions.push_back ({ { "label", "pm.request.url.query.clear" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.query.clear()" },
    { "detail", "pm.request.url.query.clear(): void" },
    { "documentation", "Drop every query parameter. The URL loses its \"?\" with them." },
    { "sortText", "3_pm_request_url_query_clear" } });

    completions.push_back ({ { "label", "pm.request.url.getHost" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.getHost()" },
    { "detail", "pm.request.url.getHost(): string" },
    { "documentation", "The host as one string - the segments of host joined by dots." },
    { "sortText", "2_pm_request_url_getHost" } });

    completions.push_back ({ { "label", "pm.request.url.getPath" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.getPath()" },
    { "detail", "pm.request.url.getPath(): string" },
    { "documentation",
    "The decoded path as one string, leading slash included (\"/v2/users\"). "
    "A URL with no path answers \"/\"." },
    { "sortText", "2_pm_request_url_getPath" } });

    completions.push_back ({ { "label", "pm.request.url.getQueryString" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.getQueryString()" },
    { "detail", "pm.request.url.getQueryString(): string" },
    { "documentation",
    "The query exactly as it appears on the wire, with no leading ?. Empty "
    "when the URL carries none." },
    { "sortText", "2_pm_request_url_getQueryString" } });

    completions.push_back ({ { "label", "pm.request.url.toString" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.toString()" },
    { "detail", "pm.request.url.toString(): string" },
    { "documentation",
    "The whole URL as a string. The same answer concatenation, a template "
    "literal and JSON.stringify already give, spelled out for the one place "
    "that needs a real string - strict equality." },
    { "sortText", "2_pm_request_url_toString" } });

    // `valueOf` and `toJSON` are the same answer toString gives - offered
    // because the runtime binds them, and a bound member the list never names
    // is one no user can discover in the editor.
    completions.push_back ({ { "label", "pm.request.url.valueOf" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.valueOf()" },
    { "detail", "pm.request.url.valueOf(): string" },
    { "documentation",
    "The whole URL as a string - what == and arithmetic-style coercion use, "
    "and the same answer toString() gives." },
    { "sortText", "2_pm_request_url_valueOf" } });

    completions.push_back ({ { "label", "pm.request.url.toJSON" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.request.url.toJSON()" },
    { "detail", "pm.request.url.toJSON(): string" },
    { "documentation",
    "The whole URL as a string, which is why JSON.stringify embeds the URL "
    "rather than an object dump." },
    { "sortText", "2_pm_request_url_toJSON" } });

    completions.push_back ({ { "label", "pm.request.url.update" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.request.url.update(\"${1:https://api.example.com/v2/users}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.request.url.update(url: string): void" },
    { "documentation",
    "Retarget the request, Postman's spelling of pm.request.url = '...'. "
    "Both re-parse the whole URL in place; editing a single member (pushing "
    "to path, changing a query entry) is not supported." },
    { "sortText", "2_pm_request_url_update" } });

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
    { "detail", "pm.request.headers.has(name: string, value?: string): boolean" },
    { "documentation",
    "Whether the outgoing request carries that header, case-insensitively. "
    "With a second argument, whether it also carries that exact value - the "
    "comparison is strict, so a number never matches the header's string." },
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
    "The request body as a string (if any). Assign a string to replace it, or "
    "delete it to send none. A body set on a request that had none is sent as "
    "raw text - set Content-Type yourself. A form body reads as its fields "
    "encoded `key=value&...`: for x-www-form-urlencoded that is the exact wire "
    "body and an assignment parses back into the fields, while for form-data "
    "it "
    "is a rendering of the parts (the multipart bytes carry a boundary that "
    "does not exist until the send) and an assignment is refused." },
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
    "a value.\n\niteration / iterationCount are set by the collection runner "
    "and by nothing else. A load test's Tests script runs once per sampled "
    "response rather than once per iteration, so it has no iteration number to "
    "report and reads undefined for both." },
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

    completions.push_back ({ { "label", "pm.info.iteration" }, { "kind", KIND_FIELD },
    { "insertText", "pm.info.iteration" }, { "detail", "number | undefined" },
    { "documentation",
    "Which pass of a collection run this step belongs to, 0-based. undefined "
    "everywhere else - a single Send and a load run's Tests script have no "
    "iteration to report.\n\nExample:\nif (pm.info.iteration === 0) { /* "
    "first pass only */ }" },
    { "sortText", "1_pm_info_iteration" } });

    completions.push_back ({ { "label", "pm.info.iterationCount" }, { "kind", KIND_FIELD },
    { "insertText", "pm.info.iterationCount" }, { "detail", "number | undefined" },
    { "documentation",
    "How many passes the collection run will make in total. undefined outside "
    "a collection run, and set by the runner alone.\n\nExample:\nconsole.log("
    "'pass ' + (pm.info.iteration + 1) + ' of ' + pm.info.iterationCount);" },
    { "sortText", "1_pm_info_iterationCount" } });

    // ========================================
    // pm.iterationData - this iteration's data row (#356)
    // ========================================
    completions.push_back ({ { "label", "pm.iterationData" },
    { "kind", KIND_VARIABLE }, { "insertText", "pm.iterationData" },
    { "detail", "This iteration's data row | undefined" },
    { "documentation",
    "The row a data-driven collection run bound to this iteration - row "
    "i % rows for iteration i - read through get(), has() and "
    "toObject().\n\nundefined "
    "wherever there is no row: a single Send, a load run's Tests script, and a "
    "collection run started without a data set. That is the opposite treatment "
    "to pm.execution, and it is deliberate - a row is data, so \"this run is "
    "not data-driven\" is a fact a script may branch on.\n\nExample:\nconst "
    "user = pm.iterationData ? pm.iterationData.get('username') : "
    "'default-user';\n\nRead-only: set, unset and clear throw. To put the row "
    "into the request itself, use a {{data.column}} token instead." },
    { "sortText", "0_pm_iterationData" } });

    completions.push_back ({ { "label", "pm.iterationData.get" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.iterationData.get(\"${1:column}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.iterationData.get(column: string): any" },
    { "documentation",
    "This iteration's value for that column. A column the row does not carry "
    "returns undefined, as every other pm scope reader does.\n\nValues keep "
    "their JSON type: a JSON file's 3 arrives as a number, a CSV column "
    "arrives as a string.\n\nOnly inside a data-driven collection run - "
    "elsewhere pm.iterationData is undefined, so guard with it before "
    "calling.\n\nExample:\nconst user = pm.iterationData.get('username');" },
    { "sortText", "1_pm_iterationData_get" } });

    completions.push_back ({ { "label", "pm.iterationData.has" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.iterationData.has(\"${1:column}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.iterationData.has(column: string): boolean" },
    { "documentation",
    "Whether this iteration's row carries that column. true for a column whose "
    "value is null - the row has it - which is the one answer get() cannot "
    "give directly.\n\nOnly inside a data-driven collection run - "
    "elsewhere pm.iterationData is undefined, so guard with it before "
    "calling.\n\nExample:\nif (pm.iterationData.has('coupon')) { /* the column "
    "is in this row */ }" },
    { "sortText", "1_pm_iterationData_has" } });

    completions.push_back ({ { "label", "pm.iterationData.toObject" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.iterationData.toObject()" },
    { "detail", "pm.iterationData.toObject(): object" },
    { "documentation",
    "The whole row as a plain object, for spreading into a body or logging "
    "the iteration's inputs.\n\nOnly inside a data-driven collection run - "
    "elsewhere pm.iterationData is undefined, so guard with it before "
    "calling.\n\nExample:\npm.request.body = "
    "JSON.stringify(pm.iterationData.toObject());" },
    { "sortText", "1_pm_iterationData_toObject" } });

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
    constexpr auto variable_scopes = std::to_array<VariableScopeCompletion> ({
    { "environment", "environment variable", "auth_token" },
    { "globals", "global variable", "api_key" },
    { "collectionVariables", "collection variable", "base_url" },
    });

    for (const auto& scope : variable_scopes) {
        const std::string accessor = std::string ("pm.") + scope.accessor;
        const std::string sort = std::string ("1_pm_") + scope.accessor + "_";
        const std::string noun = scope.noun;

        completions.push_back ({ { "label", accessor + ".has" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".has(\"${1:variable}\")" },
        { "insertTextRules", INSERT_AS_SNIPPET },
        { "detail", accessor + ".has(name: string): boolean" },
        { "documentation",
        std::format ("True when the {} exists and is enabled - the same rows "
                     "{}.get() can read.\n\nExample:\nif ({}.has('{}')) {{ /* "
                     "... */ }}",
        noun, accessor, accessor, scope.example) },
        { "sortText", sort + "has" } });

        completions.push_back ({ { "label", accessor + ".unset" },
        { "kind", KIND_FUNCTION }, { "insertText", accessor + ".unset(\"${1:variable}\")" },
        { "insertTextRules", INSERT_AS_SNIPPET },
        { "detail", accessor + ".unset(name: string): void" },
        { "documentation",
        std::format (
        "Remove the {} entirely. Not the same as setting it to \"\", "
        "which leaves an enabled empty variable behind for "
        "{{{{template}}}} resolution to find.\n\nExample:\n{}.unset('{}');",
        noun, accessor, scope.example) },
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
        std::format ("A plain object of every enabled {}, each value cast "
                     "by its declared "
                     "type.\n\nExample:\nconsole.log({}.toObject());",
        noun, accessor) },
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
    "header?: object; headers?: object; body?: string | { mode: 'raw'; raw: "
    "string }; auth?: { type: string; basic?: object; bearer?: object; "
    "apikey?: "
    "object }; timeout?: "
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
    "chain.\n\nThe url may be a string or pm.request.url, and {{variables}} in "
    "it, in header values, in a raw body and in auth credentials resolve as "
    "the "
    "call is made - so a value this script set two lines earlier is visible. "
    "Header names are sent as written.\n\nauth takes Postman's { type, <type>: "
    "params } shape in either spelling, and composes basic, bearer and apikey. "
    "Any other type - oauth2 included - is refused by name rather than "
    "dropped, "
    "and an Authorization header the script set itself wins.\n\nBounded on "
    "purpose: the request's timeout is capped "
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
    // pm.cookies - the jar, read-side
    // ========================================
    completions.push_back ({ { "label", "pm.cookies" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.cookies" }, { "detail", "The cookie jar for this request's URL" },
    { "documentation",
    "The cookies vayu holds that would be sent to this request's URL - what "
    "makes 'log in once, reuse the session' work. Matched on domain, path, "
    "Secure and expiry, so it answers for this URL and no other.\n\nOne jar "
    "per environment, kept in memory for as long as the engine runs and "
    "clearable in Settings; requests sent with no environment selected share "
    "one jar of their own. Load runs have no jar and these throw there. "
    "Writing is done through pm.cookies.jar(); use pm.response.cookies for "
    "what a single response set." },
    { "sortText", "0_pm_cookies" } });

    completions.push_back ({ { "label", "pm.cookies.get" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.cookies.get(\"${1:session}\")" }, { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.cookies.get(name: string): string | undefined" },
    { "documentation",
    "The value of a stored cookie that would be sent to this URL, or "
    "undefined when the jar holds none of that name for it. Cookie names are "
    "case-sensitive. When the jar holds the name on more than one path, the "
    "longest matching path answers - the value the server reads "
    "first.\n\nExample:\nconst session = pm.cookies.get('session');" },
    { "sortText", "1_pm_cookies_get" } });

    completions.push_back ({ { "label", "pm.cookies.has" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.cookies.has(\"${1:session}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", "pm.cookies.has(name: string): boolean" },
    { "documentation",
    "Whether the jar holds a cookie of that name that would be sent to this "
    "URL (case-sensitive)." },
    { "sortText", "1_pm_cookies_has" } });

    completions.push_back ({ { "label", "pm.cookies.toObject" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.cookies.toObject()" },
    { "detail", "pm.cookies.toObject(): object" },
    { "documentation",
    "Every stored cookie that would be sent to this URL, as a name-to-value "
    "object." },
    { "sortText", "1_pm_cookies_to_object" } });

    // pm.cookies.jar() - the write half (#337). Offered one level deeper than
    // the flat reads because every method is URL-scoped: the URL is what a
    // written cookie's domain and path come from.
    completions.push_back ({ { "label", "pm.cookies.jar" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.cookies.jar()" }, { "detail", "pm.cookies.jar(): object" },
    { "documentation",
    "Postman's cookie jar object - the write half, plus a URL-scoped read. "
    "get(url, name), set(url, cookie), unset(url, name) and clear(url) all "
    "take the URL the cookie belongs to rather than assuming this request's; "
    "clear() with no URL empties this environment's jar.\n\nA "
    "write is applied after the transfer it was made before, so the request "
    "that follows carries it and the jar keeps it.\n\nExample:\n"
    "pm.cookies.jar().set(pm.request.url, { name: 'session', value: token "
    "});" },
    { "sortText", "1_pm_cookies_jar" } });

    completions.push_back ({ { "label", "pm.cookies.jar().get" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.cookies.jar().get(\"${1:https://api.example.com}\", \"${2:session}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.cookies.jar().get(url: string, name: string, callback?: Function): string | undefined" },
    { "documentation",
    "The value of a stored cookie that would be sent to that URL, or "
    "undefined. Same matching as pm.cookies.get, against the URL you pass "
    "instead of this request's; a cookie this script has just set is "
    "included. The value is returned and also handed to the optional "
    "callback as (null, value)." },
    { "sortText", "1_pm_cookies_jar_get" } });

    completions.push_back ({ { "label", "pm.cookies.jar().set" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.cookies.jar().set(\"${1:https://api.example.com}\", { name: \"${2:session}\", value: ${3:token} })" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.cookies.jar().set(url: string, cookie: object | string, value?: string | Function, callback?: Function): void" },
    { "documentation",
    "Store a cookie for that URL. The cookie object needs name and value; "
    "domain, path, secure, httpOnly and expires (seconds since the epoch, 0 "
    "for a session cookie) are optional and default from the URL. "
    "set(url, name, value) is accepted too.\n\nThe cookie is matched by the "
    "same rules a received one is, so setting it for one host does not send "
    "it to another." },
    { "sortText", "1_pm_cookies_jar_set" } });

    completions.push_back ({ { "label", "pm.cookies.jar().unset" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.cookies.jar().unset(\"${1:https://api.example.com}\", \"${2:session}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.cookies.jar().unset(url: string, name: string, callback?: Function): void" },
    { "documentation",
    "Remove the cookies of that name the URL would have carried. Cookies of "
    "the same name stored for another host or path are left alone." },
    { "sortText", "1_pm_cookies_jar_unset" } });

    completions.push_back ({ { "label", "pm.cookies.jar().clear" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.cookies.jar().clear()" },
    { "detail", "pm.cookies.jar().clear(url?: string, callback?: Function): void" },
    { "documentation",
    "clear(url) removes every cookie that URL would have carried - unset "
    "without a name to narrow it. clear() with no URL empties this "
    "environment's jar: a session reset, and nothing wider, since other "
    "environments' jars are untouched. Nothing is on disk either way, so "
    "this costs a re-login and no more." },
    { "sortText", "1_pm_cookies_jar_clear" } });

    // ========================================
    // pm.execution - flow control inside a collection run (#355)
    // ========================================
    completions.push_back ({ { "label", "pm.execution" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.execution" }, { "detail", "Where this collection run goes next" },
    { "documentation",
    "Redirect the sequence a collection run is executing - jump to another "
    "request, end the iteration early, or skip this request entirely.\n\nOnly "
    "inside a collection run. A single Send has no next request and a load "
    "run's test scripts run after the run has finished, so both methods throw "
    "there rather than being quietly ignored." },
    { "sortText", "0_pm_execution" } });

    completions.push_back (
    { { "label", "pm.execution.setNextRequest" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.execution.setNextRequest(\"${1:Request name}\")" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.execution.setNextRequest(name: string | null): void" },
    { "documentation",
    "Run the named request next instead of the one that follows in the "
    "collection - the request's name, or the id pm.info.requestId reads, never "
    "its URL. Pass null - or the string \"null\" - to end this iteration and "
    "start the next one.\n\nThe current request still "
    "completes; the jump happens after it. Calling it more than once in a "
    "script keeps the last call. A target no request in the run answers to, or "
    "a name two requests share, fails the step by name rather than "
    "guessing.\n\n"
    "Jumping backwards is allowed and is how a retry loop is written; an "
    "iteration that never stops is cut off by the maxStepsPerIteration "
    "setting.\n\nExample:\nif (pm.response.code === 401) { "
    "pm.execution.setNextRequest('Log in'); }" },
    { "sortText", "1_pm_execution_setNextRequest" } });

    completions.push_back ({ { "label", "pm.execution.skipRequest" },
    { "kind", KIND_FUNCTION }, { "insertText", "pm.execution.skipRequest()" },
    { "detail", "pm.execution.skipRequest(): void" },
    { "documentation",
    "Do not send this request. The run continues with the next one and the "
    "step is reported as skipped - never as passed.\n\nPre-request scripts "
    "only: by the time a test script runs the request has already gone out, "
    "so it throws there.\n\nExample:\nif (!pm.environment.get('token')) { "
    "pm.execution.skipRequest(); }" },
    { "sortText", "1_pm_execution_skipRequest" } });

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

    // The rest of what the `deep` documentation above claims. `deep` is a
    // flag-setting getter on the one chain object, so the runtime has always
    // answered these - but the completion table listed `deep` with `equal`
    // alone, and the generated declarations are derived from the table, so
    // `pm.expect(value).to.deep.include({ a: 1 })` - the docs' own line - was
    // "Property 'include' does not exist" in the editor. Spelled as chai
    // spells them, since the getters commute and a pasted Postman script uses
    // chai's order.
    completions.push_back ({ { "label", "to.deep.include" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.deep.include(${1:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.deep.include(value: any)" },
    { "documentation",
    "Assert the array or string contains the value, comparing objects by value "
    "rather than by reference.\n\nExample:\n"
    "pm.expect(items).to.deep.include({id: 1});" },
    { "sortText", "2_to_deep_include" }, { "filterText", ".to.deep.include" } });

    completions.push_back ({ { "label", "to.have.deep.property" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.have.deep.property(\"${1:name}\", ${2:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.have.deep.property(name: string, value?: any)" },
    { "documentation",
    "Assert the object has a property whose value deeply equals the one "
    "given.\n\nExample:\n"
    "pm.expect(data).to.have.deep.property('meta', {page: 1});" },
    { "sortText", "2_to_have_deep_property" }, { "filterText", ".to.have.deep.property" } });

    completions.push_back ({ { "label", "to.have.deep.members" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.have.deep.members([${1:values}])" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.have.deep.members(values: any[])" },
    { "documentation",
    "Assert the array has the same members in any order, comparing them by "
    "value.\n\nExample:\n"
    "pm.expect(rows).to.have.deep.members([{id: 1}, {id: 2}]);" },
    { "sortText", "2_to_have_deep_members" }, { "filterText", ".to.have.deep.members" } });

    completions.push_back ({ { "label", "to.be.deep.oneOf" },
    { "kind", KIND_FUNCTION }, { "insertText", "to.be.deep.oneOf([${1:values}])" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.be.deep.oneOf(values: any[])" },
    { "documentation",
    "Assert the value deeply equals one of the candidates.\n\nExample:\n"
    "pm.expect(body.status).to.be.deep.oneOf([{code: 1}, {code: 2}]);" },
    { "sortText", "2_to_be_deep_oneOf" }, { "filterText", ".to.be.deep.oneOf" } });

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
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", ".to.have.property(name: string, value?: any)" },
    { "documentation",
    "Assert the object has a property, and optionally that it equals a value. "
    "The value is compared strictly unless the chain is `deep`.\n\nExample:\n"
    "pm.expect(data).to.have.property('id');\n"
    "pm.expect(data).to.have.property('id', 1);" },
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
    [] (const httplib::Request&, httplib::Response& res) {
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
    ctx.server.Get ("/scripting/types", [] (const httplib::Request&, httplib::Response& res) {
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
