/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/curl_callbacks.hpp"

#include <algorithm>
#include <chrono>
#include <string>
#include <string_view>
#include <utility>

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

    // A bounded stream (issue #576) counts what it just received and ends at
    // the event cap. Decided before the byte cap below because the two mean
    // opposite things: reaching the event cap is this transfer's intended end
    // and completes it *successfully*, while exceeding the byte cap is a
    // refusal to buffer and stays an error. Deciding it after would report a
    // stream that ended exactly as asked as a failed one whenever its final
    // chunk also crossed the byte cap.
    //
    // The whole chunk is counted before the cap is tested: those events are on
    // the wire either way, and a tally that stopped mid-chunk would under-report
    // the stream it exists to measure.
    bool stream_cap_hit = false;
    if (data->stream_bounds) {
        data->stream_counter.feed (std::string_view (ptr, total_size));
        stream_cap_hit = std::cmp_greater_equal (
        data->stream_counter.events (), data->stream_bounds->max_events);
    }

    // Bounded buffering. Without this a large or streaming response grows the
    // buffer as concurrency x body-size until allocation fails - and a
    // std::bad_alloc thrown here would have to unwind through libcurl's C
    // frame, which is undefined behaviour. Returning short of total_size is
    // libcurl's documented way to abort a transfer (CURLE_WRITE_ERROR), so the
    // overrun surfaces as an ordinary error completion instead.
    //
    // It still applies to a stream: the event cap bounds how many events are
    // delivered, not how large one of them is, so without this a single
    // unbounded event would be the hole the cap was supposed to close.
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

    if (stream_cap_hit) {
        data->stream_cap_reached = true;
        // Short count: the same documented abort, read as a success by
        // `stream_cap_reached`. One byte short rather than zero so the buffered
        // chunk above stays whole - the body is the events, and the cap is
        // about how many arrived, not about discarding the last one.
        return total_size > 0 ? total_size - 1 : 0;
    }

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

    // The duration half of a bounded stream (issue #576). It lives here rather
    // than in write_callback because this is the callback libcurl runs on a
    // stream that has gone *quiet* - a server holding a connection open and
    // sending nothing delivers no writes at all, which is exactly the case the
    // duration cap exists for. libcurl calls it at least once a second, so the
    // cap is honoured within about that of its expiry.
    //
    // A non-zero return is the documented abort (CURLE_ABORTED_BY_CALLBACK);
    // `stream_cap_reached` is what makes the completion read it as the stream's
    // intended end rather than as a failure.
    if (data->stream_bounds && std::chrono::steady_clock::now () >= data->stream_deadline) {
        data->stream_cap_reached = true;
        return 1;
    }
    return 0;
}

} // namespace vayu::http::detail
