#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The follow-up requests `assert.snapshot` sends for a paged list
 *        (#3824), `ElementContext::send_list_page`: the one sender every path
 *        shares, and the binder a load run's completion uses.
 */

#include <expected>
#include <optional>
#include <string>

#include "vayu/core/elements.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * One list page: @p page_request sent through @p config, its reply read by the
 * reply reader, and the final JSON-RPC response's text answered. A page is part
 * of what the step does, so it is counted on @p step's `mcp_reply` and its time
 * and bytes are added to @p step, and to @p view as well when the elements read
 * a copy (`mcp_element_view`), so a later `assert.duration` reads the figure
 * the step records. A cancelled page answers `cancelled`, which is no verdict.
 */
[[nodiscard]] std::expected<std::string, core::ListPageFailure>
send_list_page (const ClientConfig& config, const Request& page_request, Response& step, Response* view);

/**
 * `ElementContext::send_list_page` on a load run's completion, where the step's
 * response is the event loop's and read-only. The first page copies it and
 * every page's cost lands on the copy, which the completion records in the
 * received response's place: the pages are in that step's latency, and are
 * no submission of their own, so the run's request and iteration counts do
 * not move.
 *
 * A page leaves the way the run's `pm.sendRequest` does (`RunContext::script_send`):
 * the run's transport, default headers and body bound, refused rather than cut
 * past the bound, and cancelled by its Stop. The send blocks the event-loop
 * worker that completed the step for the page's time, as an inline script's
 * `pm.sendRequest` does. A page's URL is its step's, which the run's target
 * policy already admitted at the submission. A step that tracks cookies sends
 * each page with the session its own reply left, and the copy keeps the
 * session the last page left.
 */
class LoadListPages {
    public:
    /// @p route and @p received outlive this object.
    LoadListPages (const runtime::ScriptSendInputs& route, const Response& received);
    ~LoadListPages () = default;

    // `bind` hands the context a pointer to this object.
    LoadListPages (const LoadListPages&)            = delete;
    LoadListPages& operator= (const LoadListPages&) = delete;
    LoadListPages (LoadListPages&&)                 = delete;
    LoadListPages& operator= (LoadListPages&&)      = delete;

    /// Points @p ctx's `send_list_page` here. @p ctx is the step's `step.after`
    /// context, whose `response` is `mcp_element_view` of the received
    /// response, and does not outlive this object.
    void bind (core::ElementContext& ctx);

    /// The step's response so far: the copy once a page was asked for.
    [[nodiscard]] const Response& step () const;

    /// What the pages added to the step's `total_ms`; 0 with no page.
    [[nodiscard]] double page_ms () const;

    /// The copy, or nothing when no page was asked for. Taken once the
    /// pipeline has run; the bound context reads nothing after it.
    [[nodiscard]] std::optional<Response> take ();

    private:
    std::expected<std::string, core::ListPageFailure>
    send (core::ElementContext& ctx, const Request& page_request);
    /// The copy, made at the first page.
    Response& start_paging (core::ElementContext& ctx);

    const runtime::ScriptSendInputs& route_;
    const Response& received_;
    ClientConfig config_;
    std::optional<Response> paged_;
    std::optional<CookieJar> jar_;
};

} // namespace vayu::http
