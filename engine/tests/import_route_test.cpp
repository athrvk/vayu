/**
 * @file tests/import_route_test.cpp
 * @brief Tests for the /import/fetch proxy helper.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/http/transport_policy.hpp"

namespace vayu::http::routes {
// Declared in import.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body,
const vayu::http::TransportPolicy& transport);
} // namespace vayu::http::routes

namespace {

/// One chunk of the chunked endpoint, and how many of them it has to hand out.
/// Large enough that a transfer cut off at a 1 KiB bound cannot have been asked
/// for anything close to all of them - which is how `served()` proves the
/// refusal happened while the bytes were arriving.
constexpr size_t CHUNK_BYTES         = 1024;
constexpr size_t CHUNKED_TOTAL_BYTES = 4 * 1024 * 1024;

class MockSpecServer {
    public:
    /// @param large_bytes size of the `/large` body, which is served with a
    ///        `Content-Length` - the header-time half of the bound.
    explicit MockSpecServer (size_t large_bytes = 64 * 1024) {
        svr_.Get ("/spec.json", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"openapi":"3.0.0"})", "application/json");
        });
        svr_.Get ("/missing", [] (const httplib::Request&, httplib::Response& res) {
            res.status = 404;
            res.set_content (R"({"error":"not found"})", "application/json");
        });
        svr_.Get ("/large", [large_bytes] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (large_bytes, 'x'), "application/octet-stream");
        });
        // No Content-Length at all, so only the write callback can stop it.
        svr_.Get ("/chunked", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider ("application/octet-stream",
            [this] (size_t offset, httplib::DataSink& sink) {
                if (offset >= CHUNKED_TOTAL_BYTES) {
                    sink.done ();
                    return true;
                }
                const std::string chunk (CHUNK_BYTES, 'y');
                if (!sink.write (chunk.data (), chunk.size ())) {
                    return false;
                }
                served_.store (offset + chunk.size ());
                return true;
            });
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
    /// Bytes the chunked endpoint got as far as handing to the socket.
    size_t served () const {
        return served_.load ();
    }
    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    std::atomic<size_t> served_{ 0 };
};

/// The request body for one fetch, with or without a stated bound.
std::string fetch_body (const std::string& url) {
    return nlohmann::json{ { "url", url } }.dump ();
}
std::string fetch_body (const std::string& url, uint64_t max_bytes) {
    return nlohmann::json{ { "url", url }, { "maxBytes", max_bytes } }.dump ();
}

TEST (ImportFetch, RejectsInvalidJson) {
    auto [status, body] = vayu::http::routes::import_fetch (
    "not json", vayu::http::TransportPolicy{});
    EXPECT_EQ (status, 400);
    EXPECT_TRUE (body.contains ("error"));
}

TEST (ImportFetch, RejectsNonHttpUrl) {
    auto [status, body] = vayu::http::routes::import_fetch (
    R"({"url":"ftp://x/y"})", vayu::http::TransportPolicy{});
    EXPECT_EQ (status, 400);
}

TEST (ImportFetch, ProxiesSuccessfully) {
    MockSpecServer mock;
    std::string body =
    R"({"url":"http://127.0.0.1:)" + std::to_string (mock.port ()) + R"(/spec.json"})";
    auto [status, json] =
    vayu::http::routes::import_fetch (body, vayu::http::TransportPolicy{});
    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> (), R"({"openapi":"3.0.0"})");
}

TEST (ImportFetch, ReturnsBadGatewayOnFetchFailure) {
    // Port 1 is not listening → connection failure.
    auto [status, body] = vayu::http::routes::import_fetch (
    R"({"url":"http://127.0.0.1:1/x"})", vayu::http::TransportPolicy{});
    EXPECT_EQ (status, 502);
}

TEST (ImportFetch, ProxiesNon2xxRemoteResponse) {
    MockSpecServer mock;
    std::string body =
    R"({"url":"http://127.0.0.1:)" + std::to_string (mock.port ()) + R"(/missing"})";
    auto [status, json] =
    vayu::http::routes::import_fetch (body, vayu::http::TransportPolicy{});
    EXPECT_EQ (status, 200); // transport OK → proxied through, not 502
    EXPECT_EQ (json["content"].get<std::string> (), R"({"error":"not found"})");
}

// ---------------------------------------------------------------------------
// The caller-stated byte bound (issue #784)
// ---------------------------------------------------------------------------

TEST (ImportFetchBound, RefusesAnAdvertisedLengthOverTheStatedBound) {
    MockSpecServer mock;
    const auto [status, body] = vayu::http::routes::import_fetch (
    fetch_body (mock.url ("/large"), 1024), vayu::http::TransportPolicy{});

    // 413, not 502: the upstream answered, this engine refused the answer.
    EXPECT_EQ (status, 413);
    const std::string message = body["error"]["message"].get<std::string> ();
    // Both numbers, because either alone leaves the reader guessing what to do:
    // the count says how far over it is, the bound says what to raise.
    EXPECT_NE (message.find (std::to_string (64 * 1024)), std::string::npos) << message;
    EXPECT_NE (message.find ("1024"), std::string::npos) << message;
}

TEST (ImportFetchBound, CutsOffAChunkedResponseThatGrowsPastTheBound) {
    // No Content-Length, so nothing can be refused at header time - the body
    // has to be stopped while it arrives. That is the half of the fix that
    // makes the bound a bound on what is *read*, so the assertion is not only
    // the status: the server must never have been asked for the whole 4 MiB.
    MockSpecServer mock;
    const auto [status, body] = vayu::http::routes::import_fetch (
    fetch_body (mock.url ("/chunked"), CHUNK_BYTES), vayu::http::TransportPolicy{});

    EXPECT_EQ (status, 413);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find (std::to_string (CHUNK_BYTES)),
    std::string::npos);
    EXPECT_LT (mock.served (), CHUNKED_TOTAL_BYTES / 2);
}

TEST (ImportFetchBound, AcceptsAResponseExactlyAtTheBound) {
    // The bound is inclusive on both halves of the check - a document of
    // exactly `maxSpecDocumentBytes` is one the engine will store, so refusing
    // to fetch it would be the renderer and the engine disagreeing by one byte.
    MockSpecServer mock (4096);
    const auto [status, json] = vayu::http::routes::import_fetch (
    fetch_body (mock.url ("/large"), 4096), vayu::http::TransportPolicy{});

    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> ().size (), 4096u);
}

TEST (ImportFetchBound, FetchesAnExportLargerThanTheSpecCapWhenNoBoundIsStated) {
    // The regression this shape exists to avoid: `/import/fetch` is one proxy
    // for every format, and a Postman or Insomnia export is never stored as a
    // spec document - so the default bound must not be `maxSpecDocumentBytes`.
    const size_t over_spec_cap = vayu::core::constants::spec_document::MAX_BYTES + 1;
    MockSpecServer mock (over_spec_cap);
    const auto [status, json] = vayu::http::routes::import_fetch (
    fetch_body (mock.url ("/large")), vayu::http::TransportPolicy{});

    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> ().size (), over_spec_cap);
}

TEST (ImportFetchBound, RejectsAMaxBytesThatIsNotAPositiveInteger) {
    MockSpecServer mock;
    for (const auto& stated : { nlohmann::json (0), nlohmann::json (-1),
         nlohmann::json ("1024"), nlohmann::json (1024.5) }) {
        nlohmann::json body = { { "url", mock.url ("/spec.json") }, { "maxBytes", stated } };
        const auto [status, response] = vayu::http::routes::import_fetch (
        body.dump (), vayu::http::TransportPolicy{});
        EXPECT_EQ (status, 400) << stated.dump ();
        EXPECT_NE (
        response["error"]["message"].get<std::string> ().find ("maxBytes"),
        std::string::npos);
    }
}

TEST (ImportFetchBound, AbsentAndNullMaxBytesBothMeanTheCeiling) {
    MockSpecServer mock;
    nlohmann::json with_null = { { "url", mock.url ("/spec.json") }, { "maxBytes", nullptr } };
    const auto [status, json] = vayu::http::routes::import_fetch (
    with_null.dump (), vayu::http::TransportPolicy{});

    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> (), R"({"openapi":"3.0.0"})");
}

TEST (ImportFetchBound, AStatedBoundOverTheCeilingIsClampedRatherThanRefused) {
    // A user may raise `maxSpecDocumentBytes` to its own maximum, and the spec
    // paths pass that number straight through. Asking for more than the engine
    // allows is answered by the ceiling, not by a 400 that would break an
    // import the setting explicitly permits.
    static_assert (vayu::core::constants::import_fetch::MAX_BYTES > 100 * 1024 * 1024,
    "the transport ceiling must sit above the largest configurable "
    "maxSpecDocumentBytes");

    MockSpecServer mock;
    const auto [status, json] = vayu::http::routes::import_fetch (
    fetch_body (mock.url ("/spec.json"),
    static_cast<uint64_t> (vayu::core::constants::import_fetch::MAX_BYTES) + 1),
    vayu::http::TransportPolicy{});

    EXPECT_EQ (status, 200);
    EXPECT_EQ (json["content"].get<std::string> (), R"({"openapi":"3.0.0"})");
}

} // namespace
