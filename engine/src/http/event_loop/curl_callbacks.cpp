/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/curl_callbacks.hpp"

#include <algorithm>
#include <string>

#include "vayu/http/debug_redact.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::detail {

int debug_callback (CURL* handle, curl_infotype type, char* data, size_t size, void* userptr) {
    (void)handle;
    (void)userptr;

    std::string text (data, size);
    // Remove trailing newlines
    while (!text.empty () && (text.back () == '\n' || text.back () == '\r')) {
        text.pop_back ();
    }

    switch (type) {
    case CURLINFO_TEXT: vayu::utils::log_debug ("* " + text); break;
    case CURLINFO_HEADER_OUT:
        vayu::utils::log_debug ("> " + redact_header_line (text));
        break;
    case CURLINFO_HEADER_IN:
        vayu::utils::log_debug ("< " + redact_header_line (text));
        break;
    default: break;
    }
    return 0;
}

size_t write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* data        = static_cast<TransferData*> (userdata);
    size_t total_size = size * nmemb;

    // Bounded buffering. Without this a large or streaming response grows the
    // buffer as concurrency x body-size until allocation fails - and a
    // std::bad_alloc thrown here would have to unwind through libcurl's C
    // frame, which is undefined behaviour. Returning short of total_size is
    // libcurl's documented way to abort a transfer (CURLE_WRITE_ERROR), so the
    // overrun surfaces as an ordinary error completion instead.
    if (data->max_response_bytes > 0) {
        const size_t buffered = data->response_body.size ();
        const size_t remaining =
        data->max_response_bytes - std::min (data->max_response_bytes, buffered);
        if (total_size > remaining) {
            // Keep the prefix that fits - it is what the caller sees as the
            // (truncated) body of the failed transfer.
            data->response_body.append (ptr, remaining);
            data->body_limit_exceeded = true;
            return remaining; // Short count: abort with CURLE_WRITE_ERROR.
        }
    }

    data->response_body.append (ptr, total_size);
    return total_size;
}

size_t header_callback (char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* data        = static_cast<TransferData*> (userdata);
    size_t total_size = size * nitems;

    std::string line (buffer, total_size);

    // Remove trailing \r\n
    while (!line.empty () && (line.back () == '\r' || line.back () == '\n')) {
        line.pop_back ();
    }

    if (line.empty ()) {
        return total_size;
    }

    // Status line: "HTTP/<version> <code> [<reason phrase>]"
    // Capture the wire reason phrase so we can preserve server-custom
    // text (e.g. "422 Unprocessable Entity", "404 Object Not Found").
    // HTTP/2+ status lines have no phrase - leave status_text empty and
    // let the caller fall back to a code→phrase lookup.
    if (line.starts_with ("HTTP/")) {
        auto first_space = line.find (' ');
        if (first_space != std::string::npos) {
            auto second_space = line.find (' ', first_space + 1);
            if (second_space != std::string::npos && second_space + 1 < line.size ()) {
                data->response.status_text = line.substr (second_space + 1);
            } else {
                data->response.status_text.clear ();
            }
        }
        // Reset headers between redirect hops so we end up with the
        // final response's set.
        data->response.headers.clear ();
        return total_size;
    }

    // Parse header: "Key: Value". A repeated name folds rather than replaces -
    // see ingest_header_line.
    ingest_header_line (line, data->response.headers);

    return total_size;
}

int progress_callback (void* clientp,
curl_off_t dltotal,
curl_off_t dlnow,
curl_off_t /*ultotal*/,
curl_off_t /*ulnow*/) {
    auto* data = static_cast<TransferData*> (clientp);
    if (data->progress) {
        data->progress (data->request_id, static_cast<size_t> (dlnow),
        static_cast<size_t> (dltotal));
    }
    return 0;
}

} // namespace vayu::http::detail
