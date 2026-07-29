/**
 * @file tests/http_version_support_test.cpp
 * @brief Gate test: libcurl must be built with nghttp2, or every HTTP/2
 *        setting downstream (CURLOPT_HTTP_VERSION_2TLS, the Auto mapping,
 *        the request builder's HTTP Version control) is a silent no-op and
 *        all traffic goes out as HTTP/1.1.
 */

#include <curl/curl.h>
#include <gtest/gtest.h>

// The whole HTTP/2 feature rests on libcurl being built with nghttp2. Without
// the vcpkg `http2` feature this bit is off and every httpVersion setting is a
// silent no-op, which is exactly the state this test was written to prevent
// recurring.
TEST (HttpVersionSupport, LibcurlWasBuiltWithHttp2) {
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    ASSERT_NE (info, nullptr);
    EXPECT_TRUE ((info->features & CURL_VERSION_HTTP2) != 0)
    << "libcurl reports: " << curl_version ()
    << "\nExpected nghttp2. Check engine/vcpkg.json requests curl[http2].";
}
