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
    // CompletionItem kinds (Monaco editor constants)
    constexpr int KIND_FUNCTION = 1;
    constexpr int KIND_FIELD    = 5;
    constexpr int KIND_VARIABLE = 6;
    constexpr int KIND_SNIPPET  = 27;

    // InsertTextRules
    constexpr int INSERT_AS_SNIPPET = 4;

    nlohmann::json completions = nlohmann::json::array ();

    // ========================================
    // pm object
    // ========================================
    completions.push_back ({ { "label", "pm" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm" }, { "detail", "Postman API object" },
    { "documentation",
    "The pm object provides access to request, response, environment, and "
    "testing utilities." },
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
    ".to.equal(expected)\n- .to.eql(expected) - deep equality\n- .to.be.true / "
    ".to.be.false\n- .to.exist\n- .to.have.property(name)\n- "
    ".to.include(value)" },
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

    completions.push_back ({ { "label", "pm.response.responseTime" },
    { "kind", KIND_FIELD }, { "insertText", "pm.response.responseTime" },
    { "detail", "number" }, { "documentation", "The total response time in milliseconds." },
    { "sortText", "1_pm_response_time" } });

    completions.push_back ({ { "label", "pm.response.headers" }, { "kind", KIND_FIELD },
    { "insertText", "pm.response.headers" }, { "detail", "object" },
    { "documentation",
    "Response headers as key-value pairs. Access individual headers like "
    "pm.response.headers['Content-Type']." },
    { "sortText", "1_pm_response_headers" } });

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
    // pm.request - Request object
    // ========================================
    completions.push_back ({ { "label", "pm.request" }, { "kind", KIND_VARIABLE },
    { "insertText", "pm.request" }, { "detail", "Request object" },
    { "documentation", "Access the HTTP request data including URL, method, headers, and body." },
    { "sortText", "0_pm_request" } });

    completions.push_back ({ { "label", "pm.request.url" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.url" }, { "detail", "string" },
    { "documentation", "The full request URL." }, { "sortText", "1_pm_request_url" } });

    completions.push_back ({ { "label", "pm.request.method" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.method" }, { "detail", "string" },
    { "documentation", "The HTTP method (GET, POST, PUT, DELETE, etc.)." },
    { "sortText", "1_pm_request_method" } });

    completions.push_back ({ { "label", "pm.request.headers" },
    { "kind", KIND_FIELD }, { "insertText", "pm.request.headers" },
    { "detail", "object" }, { "documentation", "Request headers as key-value pairs." },
    { "sortText", "1_pm_request_headers" } });

    completions.push_back ({ { "label", "pm.request.body" }, { "kind", KIND_FIELD },
    { "insertText", "pm.request.body" }, { "detail", "string | undefined" },
    { "documentation", "The request body content (if any)." },
    { "sortText", "1_pm_request_body" } });

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
    "Get a collection variable value by name.\n\nExample:\nconst baseUrl = "
    "pm.collectionVariables.get('base_url');" },
    { "sortText", "1_pm_collectionVariables_get" } });

    completions.push_back ({ { "label", "pm.collectionVariables.set" }, { "kind", KIND_FUNCTION },
    { "insertText", "pm.collectionVariables.set(\"${1:variable}\", ${2:value})" },
    { "insertTextRules", INSERT_AS_SNIPPET },
    { "detail", "pm.collectionVariables.set(name: string, value: any): void" },
    { "documentation", "Set a collection variable. The value will be persisted.\n\nExample:\npm.collectionVariables.set('base_url', 'https://api.example.com');" },
    { "sortText", "1_pm_collectionVariables_set" } });

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
    { "documentation", "Assert strict equality (===).\n\nExample:\npm.expect(status).to.equal(200);" },
    { "sortText", "2_to_equal" }, { "filterText", ".to.equal" } });

    completions.push_back ({ { "label", "to.eql" }, { "kind", KIND_FUNCTION },
    { "insertText", "to.eql(${1:expected})" },
    { "insertTextRules", INSERT_AS_SNIPPET }, { "detail", ".to.eql(expected: any)" },
    { "documentation",
    "Assert deep equality (for "
    "objects/arrays).\n\nExample:\npm.expect(data).to.eql({id: 1, "
    "name: 'test'});" },
    { "sortText", "2_to_eql" }, { "filterText", ".to.eql" } });

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
    "pm.test(\"Content-Type is JSON\", function() "
    "{\n\tpm.response.to.have.header(\"Content-Type\");\n\tpm.expect(pm."
    "response.headers["
    "\"Content-Type\"]).to.include(\"application/json\");\n});" },
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
}

} // namespace vayu::http::routes
