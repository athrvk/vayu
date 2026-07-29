#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/types.hpp"
#include <curl/curl.h>

namespace vayu::http {

/**
 * The single mapping from a stored HttpVersion to libcurl's constant.
 *
 * Header-only and shared deliberately: `client.cpp` (POST /execute) and
 * `curl_utils.cpp` (POST /runs) are separate curl drivers, and a second copy
 * of this mapping is how a Send and a load test of the same request would come
 * to disagree about which protocol they used.
 */
constexpr long to_curl_http_version (HttpVersion v) {
    switch (v) {
    case HttpVersion::Http1_1: return CURL_HTTP_VERSION_1_1;
    case HttpVersion::Http2: return CURL_HTTP_VERSION_2TLS;
    case HttpVersion::Auto: break;
    }
    return CURL_HTTP_VERSION_NONE;
}

/**
 * The reverse direction: what CURLINFO_HTTP_VERSION reports once a transfer
 * has actually run, translated to the display string vayu::Response::http_version
 * carries. This is not the inverse of to_curl_http_version above - that maps a
 * *request* (HttpVersion, including Auto, which has no wire form) to a curl
 * option; this maps an *outcome* (a concrete curl constant naming what was
 * negotiated) to display text. There is no Auto case here because a completed
 * transfer never negotiates "auto" - it negotiates something, or nothing.
 *
 * Kept in the same header as the forward mapping for the same reason that one
 * is shared: client.cpp and curl_utils.cpp are separate curl drivers, and a
 * second copy of either direction is how a Send and a load test of the same
 * request could disagree about what actually happened on the wire.
 *
 * CURL_HTTP_VERSION_NONE (0, curl's "no answer") and any value this switch
 * does not recognize both return "" rather than guessing HTTP/1.1. A transfer
 * that never reached a server (DNS failure, connection refused, etc.)
 * genuinely negotiated nothing, and an empty string says that honestly instead
 * of manufacturing a protocol that was never granted.
 */
inline std::string http_version_from_curl (long curl_version) {
    switch (curl_version) {
    case CURL_HTTP_VERSION_1_0: return "HTTP/1.0";
    case CURL_HTTP_VERSION_1_1: return "HTTP/1.1";
    case CURL_HTTP_VERSION_2_0: return "HTTP/2"; // == CURL_HTTP_VERSION_2
    case CURL_HTTP_VERSION_3: return "HTTP/3";
    default: return "";
    }
}

} // namespace vayu::http
