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

/**
 * Did this transfer ask for HTTP/2 and not get it?
 *
 * The two mappings above are individually correct and still let the failure
 * this exists to catch through: a request that names `http2` can come back
 * `200 OK` on `HTTP/1.1` with no error, no warning and nothing that
 * distinguishes it from success. That is not hypothetical - it was every
 * Windows request from v0.11.0 to v0.14.0 (issue #215), and the reason nobody
 * noticed for three releases is that a silent downgrade looks exactly like a
 * working feature. Someone benchmarking HTTP/2 gets HTTP/1.1 numbers labelled
 * HTTP/2.
 *
 * Only an *explicit* `http2` counts. `Auto` promises nothing, so there is
 * nothing to break; `Http1_1` got what it asked for.
 *
 * A negotiated version of "" means nothing was negotiated at all (DNS failure,
 * connection refused) - that is a transport error and `Response::error_code`
 * already carries it, so it is not reported a second time as a protocol
 * complaint. HTTP/3 is not a downgrade; it is unreachable from
 * to_curl_http_version today, and excluding it means adding an h3 mapping
 * later cannot silently start flagging correct transfers.
 *
 * Lives here rather than in either driver for the same reason the two mappings
 * do: `client.cpp` (POST /execute) and `curl_utils.cpp` (POST /runs) both call
 * it, and a Send and a load test of the same request must not disagree about
 * whether the protocol they asked for was honoured.
 */
inline bool http_version_downgraded (HttpVersion requested, const std::string& negotiated) {
    if (requested != HttpVersion::Http2 || negotiated.empty ()) {
        return false;
    }
    return negotiated != "HTTP/2" && negotiated != "HTTP/3";
}

} // namespace vayu::http
