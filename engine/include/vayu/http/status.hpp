/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file status.hpp
 * @brief Canonical IANA HTTP reason phrases.
 *
 * Single source of truth for status-text rendering across the engine
 * (HTTP client header callbacks, CLI display, persisted results). The
 * frontend trusts whatever statusText the engine emits - it does not
 * have its own copy of this table.
 *
 * Verified against the IANA HTTP Status Code Registry:
 *   https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml
 *
 * Notable RFC 9110 renames:
 *   - 413: "Payload Too Large" → "Content Too Large"
 *   - 422: "Unprocessable Entity" → "Unprocessable Content"
 *
 * Codes that are registered but obsoleted/deprecated (305, 510) are
 * included so the UI shows meaningful text if a server still emits
 * them. Code 418 is marked "(Unused)" in IANA - intentionally omitted;
 * the class-based fallback (Client Error) applies.
 *
 * For codes outside the registry the function returns the class label
 * ("Informational", "Success", "Redirect", "Client Error",
 * "Server Error"). Status 0 - vayu's synthetic value for client-side
 * failures - returns "Error".
 */

#pragma once

#include <string>

namespace vayu::http {

inline std::string status_text (int code) {
    switch (code) {
    // Synthetic - no server response (client-side failure)
    case 0: return "Error";

    // 1xx Informational
    case 100: return "Continue";
    case 101: return "Switching Protocols";
    case 102: return "Processing";
    case 103: return "Early Hints";
    case 104: return "Upload Resumption Supported";

    // 2xx Success
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 203: return "Non-Authoritative Information";
    case 204: return "No Content";
    case 205: return "Reset Content";
    case 206: return "Partial Content";
    case 207: return "Multi-Status";
    case 208: return "Already Reported";
    case 226: return "IM Used";

    // 3xx Redirection
    case 300: return "Multiple Choices";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 305: return "Use Proxy";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";

    // 4xx Client Error
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 402: return "Payment Required";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 406: return "Not Acceptable";
    case 407: return "Proxy Authentication Required";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 410: return "Gone";
    case 411: return "Length Required";
    case 412: return "Precondition Failed";
    case 413: return "Content Too Large";
    case 414: return "URI Too Long";
    case 415: return "Unsupported Media Type";
    case 416: return "Range Not Satisfiable";
    case 417: return "Expectation Failed";
    case 421: return "Misdirected Request";
    case 422: return "Unprocessable Content";
    case 423: return "Locked";
    case 424: return "Failed Dependency";
    case 425: return "Too Early";
    case 426: return "Upgrade Required";
    case 428: return "Precondition Required";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 451: return "Unavailable For Legal Reasons";

    // 5xx Server Error
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    case 505: return "HTTP Version Not Supported";
    case 506: return "Variant Also Negotiates";
    case 507: return "Insufficient Storage";
    case 508: return "Loop Detected";
    case 510: return "Not Extended";
    case 511: return "Network Authentication Required";

    default:
        if (code >= 100 && code < 200) return "Informational";
        if (code >= 200 && code < 300) return "Success";
        if (code >= 300 && code < 400) return "Redirect";
        if (code >= 400 && code < 500) return "Client Error";
        if (code >= 500 && code < 600) return "Server Error";
        return "Unknown";
    }
}

} // namespace vayu::http
