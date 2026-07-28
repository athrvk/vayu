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

} // namespace vayu::http
