/**
 * @file script_engine_test.cpp
 * @brief Tests for QuickJS scripting engine
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

class ScriptEngineTest : public ::testing::Test {
protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp() override {
        // Setup default request
        request.method = HttpMethod::GET;
        request.url = "https://api.example.com/users";
        request.headers = {{"Content-Type", "application/json"},
                           {"Authorization", "Bearer token123"}};

        // Setup default response
        response.status_code = 200;
        response.status_text = "OK";
        response.body = R"({"id": 1, "name": "John Doe", "email": "john@example.com"})";
        response.headers = {{"Content-Type", "application/json"}, {"X-Request-Id", "abc123"}};
        response.timing.total_ms = 150.5;

        // Setup environment
        env["api_key"] = Variable{"secret123", true, true};
        env["base_url"] = Variable{"https://api.example.com", false, true};
    }
};

// ============================================================================
// Basic Engine Tests
// ============================================================================

TEST_F(ScriptEngineTest, IsAvailable) {
#ifdef VAYU_HAS_QUICKJS
    EXPECT_TRUE(ScriptEngine::is_available());
    EXPECT_FALSE(ScriptEngine::version().empty());
#else
    EXPECT_FALSE(ScriptEngine::is_available());
    EXPECT_TRUE(ScriptEngine::version().empty());
#endif
}

TEST_F(ScriptEngineTest, ExecuteEmptyScript) {
    ScriptContext ctx;
    ctx.response = &response;

    auto result = engine.execute("", ctx);
    EXPECT_TRUE(result.success);
    EXPECT_TRUE(result.tests.empty());
}

TEST_F(ScriptEngineTest, ExecuteSimpleExpression) {
    ScriptContext ctx;
    auto result = engine.execute("1 + 1", ctx);
    EXPECT_TRUE(result.success);
}

// ============================================================================
// pm.test() Tests
// ============================================================================

TEST_F(ScriptEngineTest, PmTestPassing) {
    auto result = engine.execute_test(R"(
        pm.test("Always passes", function() {
            // Empty test should pass
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
    ASSERT_EQ(result.tests.size(), 1);
    EXPECT_EQ(result.tests[0].name, "Always passes");
    EXPECT_TRUE(result.tests[0].passed);
}

TEST_F(ScriptEngineTest, PmTestFailing) {
    auto result = engine.execute_test(R"(
        pm.test("Always fails", function() {
            throw new Error("Intentional failure");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_FALSE(result.success);
    ASSERT_EQ(result.tests.size(), 1);
    EXPECT_EQ(result.tests[0].name, "Always fails");
    EXPECT_FALSE(result.tests[0].passed);
}

TEST_F(ScriptEngineTest, PmTestMultiple) {
    auto result = engine.execute_test(R"(
        pm.test("First test", function() {
            pm.expect(true).to.be.true;
        });

        pm.test("Second test", function() {
            pm.expect(1).to.equal(1);
        });

        pm.test("Third test", function() {
            pm.expect("hello").to.include("ell");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
    ASSERT_EQ(result.tests.size(), 3);
    EXPECT_TRUE(result.tests[0].passed);
    EXPECT_TRUE(result.tests[1].passed);
    EXPECT_TRUE(result.tests[2].passed);
}

// ============================================================================
// pm.expect() Assertion Tests
// ============================================================================

TEST_F(ScriptEngineTest, ExpectEqual) {
    auto result = engine.execute_test(R"(
        pm.test("Equal numbers", function() {
            pm.expect(42).to.equal(42);
        });

        pm.test("Equal strings", function() {
            pm.expect("hello").to.equal("hello");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectEqualFails) {
    auto result = engine.execute_test(R"(
        pm.test("Should fail", function() {
            pm.expect(42).to.equal(43);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_FALSE(result.success);
    ASSERT_EQ(result.tests.size(), 1);
    EXPECT_FALSE(result.tests[0].passed);
    EXPECT_FALSE(result.tests[0].error_message.empty());
}

TEST_F(ScriptEngineTest, ExpectNotEqual) {
    auto result = engine.execute_test(R"(
        pm.test("Not equal", function() {
            pm.expect(42).to.not.equal(43);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectExist) {
    auto result = engine.execute_test(R"(
        pm.test("Value exists", function() {
            pm.expect("something").to.exist;
        });

        pm.test("Number exists", function() {
            pm.expect(0).to.exist;
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectAboveBelow) {
    auto result = engine.execute_test(R"(
        pm.test("Above check", function() {
            pm.expect(10).to.be.above(5);
        });

        pm.test("Below check", function() {
            pm.expect(5).to.be.below(10);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectInclude) {
    auto result = engine.execute_test(R"(
        pm.test("String includes", function() {
            pm.expect("hello world").to.include("world");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectProperty) {
    auto result = engine.execute_test(R"(
        pm.test("Has property", function() {
            var obj = {name: "John", age: 30};
            pm.expect(obj).to.have.property("name");
        });

        pm.test("Has property with value", function() {
            var obj = {name: "John", age: 30};
            pm.expect(obj).to.have.property("age", 30);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ExpectTrueFalse) {
    auto result = engine.execute_test(R"(
        pm.test("True check", function() {
            pm.expect(true).to.be.true;
        });

        pm.test("False check", function() {
            pm.expect(false).to.be.false;
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

// ============================================================================
// pm.response Tests
// ============================================================================

TEST_F(ScriptEngineTest, ResponseStatusCode) {
    auto result = engine.execute_test(R"(
        pm.test("Status code is 200", function() {
            pm.expect(pm.response.code).to.equal(200);
        });

        pm.test("Status is also available", function() {
            pm.expect(pm.response.status).to.equal(200);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ResponseJson) {
    auto result = engine.execute_test(R"(
        pm.test("Response has correct name", function() {
            var json = pm.response.json();
            pm.expect(json.name).to.equal("John Doe");
        });

        pm.test("Response has id", function() {
            var json = pm.response.json();
            pm.expect(json.id).to.equal(1);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ResponseHeaders) {
    auto result = engine.execute_test(R"(
        pm.test("Content-Type header", function() {
            pm.expect(pm.response.headers["Content-Type"]).to.equal("application/json");
        });

        pm.test("X-Request-Id header", function() {
            pm.expect(pm.response.headers["X-Request-Id"]).to.exist;
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ResponseTime) {
    auto result = engine.execute_test(R"(
        pm.test("Response time is reasonable", function() {
            pm.expect(pm.response.responseTime).to.be.below(1000);
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, ResponseText) {
    auto result = engine.execute_test(R"(
        pm.test("Response text contains name", function() {
            var text = pm.response.text();
            pm.expect(text).to.include("John Doe");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

// ============================================================================
// pm.request Tests
// ============================================================================

TEST_F(ScriptEngineTest, RequestUrl) {
    auto result = engine.execute_test(R"(
        pm.test("Request URL", function() {
            pm.expect(pm.request.url).to.include("example.com");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, RequestMethod) {
    auto result = engine.execute_test(R"(
        pm.test("Request method is GET", function() {
            pm.expect(pm.request.method).to.equal("GET");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, RequestHeaders) {
    auto result = engine.execute_test(R"(
        pm.test("Request has auth header", function() {
            pm.expect(pm.request.headers["Authorization"]).to.include("Bearer");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

// ============================================================================
// pm.environment Tests
// ============================================================================

TEST_F(ScriptEngineTest, EnvironmentGet) {
    auto result = engine.execute_test(R"(
        pm.test("Can get env var", function() {
            var baseUrl = pm.environment.get("base_url");
            pm.expect(baseUrl).to.equal("https://api.example.com");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
}

TEST_F(ScriptEngineTest, EnvironmentSet) {
    auto result = engine.execute_test(R"(
        pm.environment.set("new_var", "new_value");
        pm.test("Can set env var", function() {
            pm.expect(pm.environment.get("new_var")).to.equal("new_value");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
    EXPECT_EQ(env["new_var"].value, "new_value");
}

// ============================================================================
// Console Output Tests
// ============================================================================

TEST_F(ScriptEngineTest, ConsoleLog) {
    auto result = engine.execute_test(R"(
        console.log("Hello, World!");
        console.log("Value:", 42);
        pm.test("dummy", function() {});
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
    ASSERT_GE(result.console_output.size(), 2);
    EXPECT_EQ(result.console_output[0], "Hello, World!");
    EXPECT_EQ(result.console_output[1], "Value: 42");
}

// ============================================================================
// Error Handling Tests
// ============================================================================

TEST_F(ScriptEngineTest, SyntaxError) {
    auto result = engine.execute_test(R"(
        pm.test("Bad syntax", function() {
            var x = ;  // Syntax error
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_FALSE(result.success);
    EXPECT_FALSE(result.error_message.empty());
}

TEST_F(ScriptEngineTest, RuntimeError) {
    auto result = engine.execute_test(R"(
        pm.test("Runtime error", function() {
            undefinedFunction();  // Reference error
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_FALSE(result.success);
    ASSERT_EQ(result.tests.size(), 1);
    EXPECT_FALSE(result.tests[0].passed);
}

// ============================================================================
// Pre-request Script Tests
// ============================================================================

TEST_F(ScriptEngineTest, PreRequestScript) {
    Request req;
    req.method = HttpMethod::GET;
    req.url = "https://api.example.com";

    auto result = engine.execute_prerequest(R"(
        console.log("Pre-request script running");
        pm.environment.set("timestamp", Date.now().toString());
    )",
                                            req,
                                            env);

    EXPECT_TRUE(result.success);
    EXPECT_TRUE(env.find("timestamp") != env.end());
}

// ============================================================================
// Complex Script Tests
// ============================================================================

TEST_F(ScriptEngineTest, ComplexTestScript) {
    auto result = engine.execute_test(R"(
        // Multiple assertions in complex test
        pm.test("Comprehensive response check", function() {
            pm.expect(pm.response.code).to.equal(200);
            
            var json = pm.response.json();
            pm.expect(json).to.have.property("id");
            pm.expect(json).to.have.property("name");
            pm.expect(json).to.have.property("email");
            
            pm.expect(json.name).to.exist;
            pm.expect(json.id).to.be.above(0);
        });

        pm.test("Response time acceptable", function() {
            pm.expect(pm.response.responseTime).to.be.below(5000);
        });

        pm.test("Correct content type", function() {
            pm.expect(pm.response.headers["Content-Type"]).to.include("json");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_TRUE(result.success);
    EXPECT_EQ(result.tests.size(), 3);
    for (const auto& test : result.tests) {
        EXPECT_TRUE(test.passed) << "Failed: " << test.name;
    }
}

TEST_F(ScriptEngineTest, MixedPassFail) {
    auto result = engine.execute_test(R"(
        pm.test("This passes", function() {
            pm.expect(200).to.equal(200);
        });

        pm.test("This fails", function() {
            pm.expect(200).to.equal(404);
        });

        pm.test("This also passes", function() {
            pm.expect("ok").to.equal("ok");
        });
    )",
                                      request,
                                      response,
                                      env);

    EXPECT_FALSE(result.success);  // Overall should fail
    ASSERT_EQ(result.tests.size(), 3);
    EXPECT_TRUE(result.tests[0].passed);
    EXPECT_FALSE(result.tests[1].passed);
    EXPECT_TRUE(result.tests[2].passed);
}

TEST_F(ScriptEngineTest, ContextPooling) {
    // Run multiple executions to verify context pooling works and doesn't crash
    for (int i = 0; i < 10; ++i) {
        auto result = engine.execute_test(R"(
            pm.test("Pooling test", function() {
                pm.expect(1).to.equal(1);
            });
        )",
                                          request,
                                          response,
                                          env);

        EXPECT_TRUE(result.success);
        ASSERT_EQ(result.tests.size(), 1);
        EXPECT_TRUE(result.tests[0].passed);
    }
}
