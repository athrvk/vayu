/**
 * @file tests/curl_utils_test.cpp
 * @brief Tests for vayu::http::detail::extract_port - the per-transfer URL port
 *        parse that runs on the event loop worker thread, where a thrown
 *        exception has no handler and terminates the daemon.
 */

#include <gtest/gtest.h>

#include <limits>
#include <string>

#include "vayu/http/event_loop/curl_utils.hpp"

using vayu::http::detail::extract_port;

// The regression this file exists for: a port literal above INT_MAX made
// std::stoi throw std::out_of_range out of the worker thread's initial
// function -> std::terminate -> every run and SSE stream on the daemon dies.
// Mutation-check: restore the raw `std::stoi (match[1].str ())` and this throws
// instead of returning.
TEST (ExtractPort, PortAboveIntMaxDoesNotThrow) {
    EXPECT_NO_THROW ({ (void)extract_port ("http://example.com:99999999999/"); });
    EXPECT_EQ (extract_port ("http://example.com:99999999999/"), 80);
    EXPECT_EQ (extract_port ("https://example.com:99999999999/"), 443);
}

// A digit run long enough to overflow every integer width, and one built from
// the max value plus a trailing digit - both stay on the non-throwing path.
TEST (ExtractPort, AbsurdlyLongDigitRunDoesNotThrow) {
    const std::string huge (400, '9');
    EXPECT_NO_THROW ({ (void)extract_port ("http://h:" + huge + "/"); });
    EXPECT_EQ (extract_port ("http://h:" + huge + "/"), 80);

    const std::string past_int_max =
    std::to_string (std::numeric_limits<int>::max ()) + "0";
    EXPECT_EQ (extract_port ("https://h:" + past_int_max + "/"), 443);
}

// Ports that fit an int but name no dialable port are treated as absent rather
// than handed to the DNS cache, which would key a resolve entry curl can never
// match. 0 and 65536 bracket the valid range on both sides.
TEST (ExtractPort, OutOfRangeButRepresentablePortFallsBackToSchemeDefault) {
    EXPECT_EQ (extract_port ("https://h:0/"), 443);
    EXPECT_EQ (extract_port ("http://h:0/"), 80);
    EXPECT_EQ (extract_port ("http://h:65536/"), 80);
    EXPECT_EQ (extract_port ("https://h:70000/"), 443);
}

// The ordinary path must be unchanged by the hardening, boundaries included.
TEST (ExtractPort, ExplicitPortInRangeIsReturned) {
    EXPECT_EQ (extract_port ("http://h:8080/"), 8080);
    EXPECT_EQ (extract_port ("https://api.example.com:8443/v1/users"), 8443);
    EXPECT_EQ (extract_port ("http://h:1/"), 1);
    EXPECT_EQ (extract_port ("http://h:65535/"), 65535);
    EXPECT_EQ (extract_port ("h:3000/path"), 3000);
}

// No explicit port: scheme decides, and an unknown scheme keeps the historical
// HTTPS default.
TEST (ExtractPort, NoExplicitPortUsesSchemeDefault) {
    EXPECT_EQ (extract_port ("https://example.com/"), 443);
    EXPECT_EQ (extract_port ("http://example.com/path?q=1"), 80);
    EXPECT_EQ (extract_port ("example.com/path"), 443);
    EXPECT_EQ (extract_port (""), 443);
}
