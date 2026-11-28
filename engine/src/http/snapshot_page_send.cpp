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

/// @p page's time added to @p step. Its engine cost leaves the page
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

LoadListPages::LoadListPages (const runtime::ScriptSendInputs& route, const Response& received)
: route_ (route), received_ (received) {
}

void LoadListPages::bind (core::ElementContext& ctx) {
    ctx.send_list_page = [this, &ctx] (const Request& page_request) {
        return send (ctx, page_request);
    };
}

const Response& LoadListPages::step () const {
    return paged_ ? *paged_ : received_;
}

double LoadListPages::page_ms () const {
    return paged_ ? paged_->timing.total_ms - received_.timing.total_ms : 0.0;
}

std::optional<Response> LoadListPages::take () {
    if (paged_ && jar_) {
        paged_->cookie_lines = jar_->lines_for (config_.cookie_scope);
    }
    return std::exchange (paged_, std::nullopt);
}

std::expected<std::string, core::ListPageFailure>
LoadListPages::send (core::ElementContext& ctx, const Request& page_request) {
    Response& step = paged_ ? *paged_ : start_paging (ctx);
    return send_list_page (config_, page_request, step, ctx.response);
}

// Deferred to the first page, so a completion that follows none copies neither
// its response nor the run's transport policy.
Response& LoadListPages::start_paging (core::ElementContext& ctx) {
    Response& copy = paged_.emplace (received_);
    // The view the elements read moves to the copy when it was the received
    // response itself: the body is the same text, so a parse already made of
    // it stands, and a later `assert.duration` reads the pages too.
    if (ctx.response == &received_) {
        ctx.response = &copy;
    }
    config_.default_headers    = route_.default_headers;
    config_.transport          = route_.transport;
    config_.max_response_bytes = route_.max_response_bytes;
    config_.cancel             = route_.cancel;
    // A step's own transfer carries the session as its request's cookie
    // lines (`Request::track_cookies`), which a `Client` does not read: the
    // pages carry it in a jar of their own, seeded with what the step's reply
    // left.
    if (ctx.request.track_cookies) {
        CookieJar& jar = jar_.emplace ();
        jar.store (config_.cookie_scope, received_.cookie_lines);
        config_.cookie_jar = &jar;
    }
    return copy;
}

} // namespace vayu::http
