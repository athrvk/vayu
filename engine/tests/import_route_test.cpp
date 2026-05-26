/**
 * @file tests/import_route_test.cpp
 * @brief Tests for the /import/fetch proxy helper.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

namespace vayu::http::routes {
// Declared in import.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body);
} // namespace vayu::http::routes

namespace {

class MockSpecServer {
    public:
    MockSpecServer () {
        svr_.Get ("/spec.json", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"openapi":"3.0.0"})", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        while (!svr_.is_running ())
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
    }
    ~MockSpecServer () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }
    int port () const {
        return port_;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

TEST (ImportFetch, RejectsInvalidJson) {
    auto [status, body] = vayu::http::routes::import_fetch ("not json");
    EXPECT_EQ (status, 400);
    EXPECT_TRUE (body.contains ("error"));
}

TEST (ImportFetch, RejectsNonHttpUrl) {
    auto [status, body] = vayu::http::routes::import_fetch (R"({"url":"ftp://x/y"})");
    EXPECT_EQ (status, 400);
}

TEST (ImportFetch, ProxiesSuccessfully) {
    MockSpecServer mock;
    std::string body =
    R"({"url":"http://127.0.0.1:)" + std::to_string (mock.port ()) + R"(/spec.json"})";
    auto [status, json] = vayu::http::routes::import_fetch (body);
    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> (), R"({"openapi":"3.0.0"})");
}

TEST (ImportFetch, ReturnsBadGatewayOnFetchFailure) {
    // Port 1 is not listening → connection failure.
    auto [status, body] = vayu::http::routes::import_fetch (R"({"url":"http://127.0.0.1:1/x"})");
    EXPECT_EQ (status, 502);
}

} // namespace
