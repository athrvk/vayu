#include "vayu/http/curl_version_map.hpp"
#include "vayu/types.hpp"
#include <gtest/gtest.h>

using vayu::HttpVersion;

TEST (HttpVersionDomain, EnumerationCoversTheWholeEnum) {
    // Every other test in this file iterates all_http_versions() rather than
    // the enum, so a member added to HttpVersion but forgotten here would slip
    // past all of them. Nothing else catches it either: MSVC's
    // missing-enumerator warnings (C4061/C4062) are off at /W4, and -Werror on
    // GCC/Clang is gated behind VAYU_STRICT_BUILD, which CI does not set - so a
    // forgotten member compiles clean and falls through to CURL_HTTP_VERSION_NONE.
    // This count is the trip-wire that forces a look at the vector.
    EXPECT_EQ (vayu::all_http_versions ().size (), 3U);
}

TEST (HttpVersionDomain, RoundTripsEveryMember) {
    for (auto v : vayu::all_http_versions ()) {
        auto parsed = vayu::http_version_from_string (vayu::to_string (v));
        ASSERT_TRUE (parsed.has_value ()) << vayu::to_string (v);
        EXPECT_EQ (*parsed, v);
    }
}

TEST (HttpVersionDomain, WireValuesAreStable) {
    // Stored as TEXT, so these strings are a persistence contract - changing
    // one silently re-reads every saved row as invalid.
    EXPECT_EQ (vayu::to_string (HttpVersion::Auto), "auto");
    EXPECT_EQ (vayu::to_string (HttpVersion::Http1_1), "http1.1");
    EXPECT_EQ (vayu::to_string (HttpVersion::Http2), "http2");
}

TEST (HttpVersionDomain, RejectsUnknown) {
    EXPECT_FALSE (vayu::http_version_from_string ("http3").has_value ());
    EXPECT_FALSE (vayu::http_version_from_string ("").has_value ());
    EXPECT_FALSE (vayu::http_version_from_string ("HTTP2").has_value ());
}

TEST (HttpVersionDomain, LabelValuesAreStable) {
    // Displayed verbatim in the settings UI: the engine seeds these into the
    // config entry's `options` list and the renderer prints them as given, so
    // changing one silently changes what the user sees.
    EXPECT_EQ (vayu::http_version_label (HttpVersion::Auto), "Auto");
    EXPECT_EQ (vayu::http_version_label (HttpVersion::Http1_1), "HTTP/1.x");
    EXPECT_EQ (vayu::http_version_label (HttpVersion::Http2), "HTTP/2");
}

TEST (HttpVersionDomain, EveryMemberHasALabel) {
    // Kept alongside the exact-value test above: this one guards a future
    // enum member that someone forgot to give a label at all, which the
    // exact-value test above would not catch since it only knows about the
    // three members that exist today.
    for (auto v : vayu::all_http_versions ()) {
        EXPECT_FALSE (vayu::http_version_label (v).empty ());
    }
}

TEST (HttpVersionDomain, MapsEveryMemberToACurlConstant) {
    EXPECT_EQ (vayu::http::to_curl_http_version (HttpVersion::Http1_1), CURL_HTTP_VERSION_1_1);
    EXPECT_EQ (vayu::http::to_curl_http_version (HttpVersion::Http2), CURL_HTTP_VERSION_2TLS);
    // Auto: whichever constant Task 1 Step 6 established.
    EXPECT_EQ (vayu::http::to_curl_http_version (HttpVersion::Auto), CURL_HTTP_VERSION_NONE);
}

// ----------------------------------------------------------------------------
// Reverse mapping: what CURLINFO_HTTP_VERSION reports after a transfer,
// translated to the display string Response::http_version carries. This is
// the opposite direction from to_curl_http_version above (request -> curl
// constant); this one is curl constant -> negotiated-outcome display string.
// ----------------------------------------------------------------------------

TEST (HttpVersionFromCurl, MapsKnownConstantsToDisplayStrings) {
    // Task 1 measured these two directly against real hosts: 2 is HTTP/1.1,
    // 3 is HTTP/2.
    EXPECT_EQ (vayu::http::http_version_from_curl (CURL_HTTP_VERSION_1_1), "HTTP/1.1");
    EXPECT_EQ (vayu::http::http_version_from_curl (CURL_HTTP_VERSION_2_0), "HTTP/2");
    EXPECT_EQ (vayu::http::http_version_from_curl (CURL_HTTP_VERSION_1_0), "HTTP/1.0");
    EXPECT_EQ (vayu::http::http_version_from_curl (CURL_HTTP_VERSION_3), "HTTP/3");
}

TEST (HttpVersionFromCurl, ReturnsEmptyForNoAnswerRatherThanGuessing) {
    // CURL_HTTP_VERSION_NONE (0) is curl's own "no answer" - the transfer
    // never got far enough to negotiate anything. Reporting HTTP/1.1 here
    // would be a guess dressed up as a fact.
    EXPECT_EQ (vayu::http::http_version_from_curl (CURL_HTTP_VERSION_NONE), "");
}

TEST (HttpVersionFromCurl, ReturnsEmptyForUnrecognizedValue) {
    // A value curl itself never returns from CURLINFO_HTTP_VERSION (this map
    // does not need to track every CURLOPT_HTTP_VERSION request-side option,
    // e.g. CURL_HTTP_VERSION_2_PRIOR_KNOWLEDGE, which getinfo never echoes
    // back) must not be silently coerced into a real-looking answer.
    EXPECT_EQ (vayu::http::http_version_from_curl (999L), "");
    EXPECT_EQ (vayu::http::http_version_from_curl (-1L), "");
}
