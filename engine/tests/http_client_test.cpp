/**
 * @file tests/http_client_test.cpp
 * @brief Tests for HTTP client
 */

#include <gtest/gtest.h>
#include "vayu/http/client.hpp"

namespace vayu::http
{
    namespace
    {

        class HttpClientTest : public ::testing::Test
        {
        protected:
            void SetUp() override
            {
                client_ = std::make_unique<Client>();
            }

            std::unique_ptr<Client> client_;
        };

        TEST_F(HttpClientTest, SendsGetRequest)
        {
            auto result = client_->get("https://httpbin.org/get");

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;

            const auto &response = result.value();
            EXPECT_EQ(response.status_code, 200);
            EXPECT_FALSE(response.body.empty());
            EXPECT_GT(response.timing.total_ms, 0);
        }

        TEST_F(HttpClientTest, SendsPostRequest)
        {
            Headers headers = {
                {"Content-Type", "application/json"}};

            auto result = client_->post(
                "https://httpbin.org/post",
                R"({"name": "test"})",
                headers);

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;

            const auto &response = result.value();
            EXPECT_EQ(response.status_code, 200);
            EXPECT_TRUE(response.body.find("test") != std::string::npos);
        }

        TEST_F(HttpClientTest, HandlesTimeout)
        {
            Request request;
            request.method = HttpMethod::GET;
            request.url = "https://httpbin.org/delay/10"; // 10 second delay
            request.timeout_ms = 1000;                    // 1 second timeout

            auto result = client_->send(request);

            ASSERT_TRUE(result.is_error());
            EXPECT_EQ(result.error().code, ErrorCode::Timeout);
        }

        TEST_F(HttpClientTest, HandlesInvalidUrl)
        {
            auto result = client_->get("not-a-valid-url");

            ASSERT_TRUE(result.is_error());
            // Could be InvalidUrl or ConnectionFailed depending on curl behavior
        }

        TEST_F(HttpClientTest, ParsesResponseHeaders)
        {
            auto result = client_->get("https://httpbin.org/response-headers?X-Custom=test");

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;

            const auto &response = result.value();
            EXPECT_TRUE(response.headers.contains("content-type"));
        }

        TEST_F(HttpClientTest, FollowsRedirects)
        {
            Request request;
            request.method = HttpMethod::GET;
            request.url = "https://httpbin.org/redirect/1";
            request.follow_redirects = true;

            auto result = client_->send(request);

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;
            EXPECT_EQ(result.value().status_code, 200);
        }

        TEST_F(HttpClientTest, DoesNotFollowRedirectsWhenDisabled)
        {
            Request request;
            request.method = HttpMethod::GET;
            request.url = "https://httpbin.org/redirect/1";
            request.follow_redirects = false;

            auto result = client_->send(request);

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;
            EXPECT_EQ(result.value().status_code, 302);
        }

        TEST_F(HttpClientTest, SendsCustomHeaders)
        {
            Request request;
            request.method = HttpMethod::GET;
            request.url = "https://httpbin.org/headers";
            request.headers["X-Custom-Header"] = "custom-value";

            auto result = client_->send(request);

            ASSERT_TRUE(result.is_ok()) << "Error: " << result.error().message;
            EXPECT_TRUE(result.value().body.find("X-Custom-Header") != std::string::npos);
        }

        TEST_F(HttpClientTest, HandlesHttpMethods)
        {
            // Test PUT
            {
                Request request;
                request.method = HttpMethod::PUT;
                request.url = "https://httpbin.org/put";
                request.body.mode = BodyMode::Json;
                request.body.content = R"({"updated": true})";
                request.headers["Content-Type"] = "application/json";

                auto result = client_->send(request);
                ASSERT_TRUE(result.is_ok()) << "PUT Error: " << result.error().message;
                EXPECT_EQ(result.value().status_code, 200);
            }

            // Test DELETE
            {
                Request request;
                request.method = HttpMethod::DELETE;
                request.url = "https://httpbin.org/delete";

                auto result = client_->send(request);
                ASSERT_TRUE(result.is_ok()) << "DELETE Error: " << result.error().message;
                EXPECT_EQ(result.value().status_code, 200);
            }

            // Test PATCH
            {
                Request request;
                request.method = HttpMethod::PATCH;
                request.url = "https://httpbin.org/patch";
                request.body.mode = BodyMode::Json;
                request.body.content = R"({"patched": true})";
                request.headers["Content-Type"] = "application/json";

                auto result = client_->send(request);
                ASSERT_TRUE(result.is_ok()) << "PATCH Error: " << result.error().message;
                EXPECT_EQ(result.value().status_code, 200);
            }
        }

    } // namespace
} // namespace vayu::http
