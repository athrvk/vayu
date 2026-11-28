/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/snapshot_page_send.hpp"

#include <format>
#include <utility>

#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/mcp_reply.hpp"

namespace vayu::http {

namespace {

/// @p page's time and bytes added to @p step. Its engine cost leaves the page
/// out as it leaves out the step's own wire time.
void add_page_cost (Timing& step, const Timing& page) {
    step.total_ms += page.total_ms;
    step.wire_ms += page.wire_ms;
    step.queue_wait_ms += page.queue_wait_ms;
    step.bytes_down += page.bytes_down;
    step.bytes_up += page.bytes_up;
}

} // namespace

std::expected<std::string, core::ListPageFailure> send_list_page (const ClientConfig& config,
const Request& page_request,
Response& step,
Response* view) {
    Client client (config);
    auto sent = client.send (page_request);
    const Response page = sent.is_error () ? detail::error_response (sent.error ()) :
                                             std::move (sent).value ();
    if (step.mcp_reply) {
        ++step.mcp_reply->pages;
    }
    add_page_cost (step.timing, page.timing);
    if (view != nullptr && view != &step) {
        add_page_cost (view->timing, page.timing);
    }
    if (page.error_code == ErrorCode::Cancelled) {
        return std::unexpected (core::ListPageFailure{
        .message = "the run ended while the page was in flight", .cancelled = true });
    }
    auto reply = read_mcp_reply (page_request, page);
    if (reply.error_class) {
        return std::unexpected (
        core::ListPageFailure{ .message = std::format ("{} failure: {}",
                               to_string (*reply.error_class), reply.message) });
    }
    return std::move (reply.response);
}

} // namespace vayu::http
