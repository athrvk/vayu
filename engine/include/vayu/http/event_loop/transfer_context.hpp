#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/event_loop/connected_peer_check.hpp"
#include "vayu/http/stream_tally.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

// Forward declarations from event_loop.hpp
using RequestCallback = std::function<void (size_t request_id, Result<Response>)>;
using ProgressCallback =
std::function<void (size_t request_id, size_t downloaded, size_t total)>;

namespace detail {

struct RedirectState;

/**
 * @brief One transfer's read position in a request body's `ApprovedFile`: a
 * streamed binary body's, or a form-data file part's.
 *
 * The file is shared by every transfer of the request (or the run); the offset
 * is this transfer's alone, so concurrent transfers never share a position.
 * Holding the file keeps it open for as long as libcurl can read through this.
 */
struct FileReader {
    std::shared_ptr<const ApprovedFile> file;
    std::uint64_t offset = 0;
};

/**
 * @brief What a handle reads its request body from, owned for the transfer.
 *
 * libcurl keeps pointers to both - the multipart tree of a `form-data` body,
 * and the reader a large `binary` body streams through (`CURLOPT_READDATA`) -
 * so each has to outlive the transfer and be released once it is done with the
 * handle. One holder for both drivers: a local for the single-request client
 * and the SSE consumer, a member of `TransferData` for the event loop.
 */
struct BodySource {
    curl_mime* mime = nullptr;
    FileReader stream;

    BodySource () = default;
    ~BodySource ();
    BodySource (const BodySource&)            = delete;
    BodySource& operator= (const BodySource&) = delete;
    BodySource (BodySource&&)                 = delete;
    BodySource& operator= (BodySource&&)      = delete;
};

/**
 * @brief Data associated with each HTTP transfer
 *
 * This struct holds all state needed to track a single HTTP request
 * through its lifecycle in the event loop.
 */
struct TransferData {
    size_t request_id = 0;
    std::chrono::steady_clock::time_point submitted_at;
    Request request;
    Response response;
    std::string response_body;
    RequestCallback callback;
    ProgressCallback progress;
    std::promise<Result<Response>> promise;
    bool has_promise = false;
    /// Largest response body this transfer may buffer, 0 = unbounded.
    /// Set from EventLoopConfig when the handle is configured.
    size_t max_response_bytes = 0;
    /// Set by write_callback when it refused to buffer more, so the completion
    /// can name the cap instead of reporting curl's generic write failure.
    bool body_limit_exceeded = false;

    /// The bounded stream this transfer is, started from the request's
    /// `stream_bounds` when the handle is configured and inactive for every
    /// non-streaming transfer, which is what keeps the counter and both cap
    /// checks off the ordinary hot path. Its cap is distinct from
    /// `body_limit_exceeded`, which stays an error: the byte cap is a refusal
    /// to buffer, the stream caps are the stream's intended end.
    StreamTally stream;

    /// The status of the response block header_callback is reading, 0 before
    /// the first.
    int block_status = 0;
    /// Set by header_callback when the block it finished is a redirect the
    /// request follows, whose body is neither buffered, held to the byte cap
    /// nor counted as a stream's events (#3302).
    bool discard_body = false;
    /// The redirect chain this transfer is following, made at the first
    /// redirect it follows (#3302); null for a transfer never redirected.
    std::unique_ptr<RedirectState> redirects;

    /// The redacted, per-line collector for the one `cat=client` record this
    /// transfer emits when verbosity reaches 2 (issue #1557); empty otherwise.
    std::vector<std::string> debug_lines;
    /// Header names the debug collector redacts beyond the shared list - the
    /// request's `Request::secret_header_names`.
    std::vector<std::string> secret_header_names;

    /// The `CURLOPT_PREREQDATA` this transfer's handle carries: no peer rule on
    /// this path, only the count `connection_replays` is read from (#2799).
    ConnectedPeerCheck peer_check;

    CurlErrorBuffer errors;
    /// The first hop's request lines; `RedirectChain` takes them over at the
    /// first redirect followed.
    struct curl_slist* headers_list = nullptr;
    /// The current hop's DNS pin (`CURLOPT_RESOLVE`).
    struct curl_slist* resolve_list = nullptr;
    /// The body source attached to the handle (a multipart tree, or the
    /// reader a large binary body streams through), released with the rest of
    /// this transfer's curl state.
    BodySource body;

    // Both out of line, where `RedirectState` is complete.
    TransferData ();
    ~TransferData ();
    TransferData (const TransferData&)            = delete;
    TransferData& operator= (const TransferData&) = delete;
    TransferData (TransferData&&)                 = delete;
    TransferData& operator= (TransferData&&)      = delete;
};

} // namespace detail
} // namespace vayu::http
