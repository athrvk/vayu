/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

namespace {

/// Add what @p counter counted since it read @p before to the run's tally.
/// Relaxed: the tick only needs each event counted once, not ordered against
/// anything else the transfer wrote.
void publish_new_events (const SseFrameCounter& counter,
std::size_t before,
const std::optional<StreamBounds>& bounds) {
    const std::size_t after = counter.events ();
    if (after == before || !bounds || !bounds->live_events) {
        return;
    }
    bounds->live_events->fetch_add (after - before, std::memory_order_relaxed);
}

} // namespace

void TransferData::count_stream_chunk (std::string_view chunk) {
    const std::size_t before = stream_counter.events ();
    stream_counter.feed (chunk);
    publish_new_events (stream_counter, before, stream_bounds);
}

void TransferData::finish_stream_count () {
    const std::size_t before = stream_counter.events ();
    stream_counter.finish ();
    publish_new_events (stream_counter, before, stream_bounds);
}

BodySource::~BodySource () {
    // Freed after the transfer is done with the handle, which is what
    // curl_mime_free requires; the pool's curl_easy_reset on the next acquire
    // drops the handle's reference to it either way. The streamed file closes
    // with the last holder of it.
    if (mime) {
        curl_mime_free (mime);
    }
}

TransferData::~TransferData () {
    if (headers_list) {
        curl_slist_free_all (headers_list);
    }
    if (resolve_list) {
        curl_slist_free_all (resolve_list);
    }
}

} // namespace vayu::http::detail
