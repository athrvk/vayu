/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "snapshot_pages.hpp"

#include <format>
#include <string>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/core/mcp_list_pages.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace vayu::core {

namespace {

using ordered_json = nlohmann::ordered_json;

/// @p reply's `result` when it is an object, else null.
const ordered_json* result_of (const ordered_json& reply) {
    const auto result = reply.find ("result");
    return result == reply.end () || !result->is_object () ? nullptr : &*result;
}

/// The cursor of the page after @p result's, when @p result holds the list at
/// the method's place and names one.
std::optional<std::string>
first_cursor (const ordered_json& result, const SnapshotList& list) {
    const auto items = result.find (std::string (list.result_key));
    if (items == result.end () || !items->is_array ()) {
        return std::nullopt;
    }
    return mcp_next_cursor (result);
}

/// @p step with its call's `params.cursor` set to @p cursor, or why the body
/// holds no call to set it in. The text is the composed body, so the send
/// stamps and derives from it exactly as it did for the first page.
std::expected<vayu::Request, std::string>
page_request (const vayu::Request& step, const std::string& cursor) {
    auto call = utils::parse_ordered_json (
    step.body.content, constants::request_body::MAX_JSON_DEPTH);
    if (!call || !call->is_object ()) {
        return std::unexpected (
        "the request body is not one JSON object to set params.cursor in");
    }
    auto& params = (*call)["params"];
    if (params.is_null ()) {
        params = ordered_json::object ();
    }
    if (!params.is_object ()) {
        return std::unexpected (
        "the request's params is not an object to set a cursor in");
    }
    params["cursor"]   = cursor;
    vayu::Request next = step;
    next.body.content = call->dump (-1, ' ', false, ordered_json::error_handler_t::replace);
    return next;
}

/// The `result` of a page's final response text, read under the bounds the
/// step's own body is read under (`ensure_parsed_body`).
std::expected<ordered_json, std::string> page_result (const std::string& text, size_t max_bytes) {
    auto reply = text.size () <= max_bytes ?
    utils::parse_ordered_json (text, constants::elements::MAX_BODY_DEPTH) :
    std::nullopt;
    if (!reply) {
        return std::unexpected (std::string (constants::elements::BODY_UNREADABLE_MESSAGE));
    }
    // No result object is a page with no list, which the loop names.
    const auto result = reply->find ("result");
    return result == reply->end () ? ordered_json () : std::move (*result);
}

/// Why the step's reply cannot be followed past its first page, before any
/// page is asked for.
std::optional<std::string> unfollowable (const ElementContext& ctx) {
    if (ctx.request.body.mode != vayu::BodyMode::Mcp) {
        return "the reply is paged (nextCursor), and only an mcp request's "
               "pages are followed";
    }
    if (!ctx.send_list_page) {
        return "the reply is paged (nextCursor), and this run cannot follow "
               "pages";
    }
    return std::nullopt;
}

/// The loop's own stop, worded for the assertion.
std::string loop_failure_text (const SnapshotList& list, const McpListFailure& failure) {
    switch (failure.kind) {
    case McpListFailureKind::PageCapReached:
        return std::format (
        "it still had a nextCursor after {} pages, the most "
        "assert.snapshot reads",
        constants::elements::MAX_SNAPSHOT_PAGES);
    case McpListFailureKind::RepeatedCursor:
        return std::format ("page {} handed back a cursor already sent, so the "
                            "list would never end",
        failure.pages_sent);
    case McpListFailureKind::ItemsOverBudget:
        return std::format ("its pages hold more than {} items, the most "
                            "assert.snapshot reads",
        constants::elements::MAX_SNAPSHOT_ITEMS);
    case McpListFailureKind::MissingList:
    case McpListFailureKind::SendFailed: break;
    }
    return std::format (
    "page {} holds no 'result.{}' list", failure.pages_sent, list.result_key);
}

ListPageFailure
not_compared (const SnapshotList& list, std::string why, bool cancelled = false) {
    return ListPageFailure{ .message =
                            std::format ("{} was not compared: {}", list.method, why),
        .cancelled = cancelled };
}

} // namespace

std::expected<std::optional<ordered_json>, ListPageFailure>
whole_snapshot_reply (const SnapshotList& list,
const ordered_json& first_page,
const ElementContext& ctx) {
    const ordered_json* first_result = result_of (first_page);
    if (first_result == nullptr || !first_cursor (*first_result, list)) {
        return std::nullopt;
    }
    if (auto why = unfollowable (ctx)) {
        return std::unexpected (not_compared (list, std::move (*why)));
    }
    // The sender's own failure, kept whole: the loop carries only its kind.
    std::optional<ListPageFailure> page_failure;
    const auto fail_page = [&page_failure] (ListPageFailure failure) {
        page_failure = std::move (failure);
        return std::unexpected (McpPageFailure{});
    };
    const McpPageSender send =
    [&] (const std::optional<std::string>& next) -> std::expected<ordered_json, McpPageFailure> {
        if (!next) {
            return *first_result;
        }
        auto request = page_request (ctx.request, *next);
        if (!request) {
            return fail_page (ListPageFailure{ .message = std::move (request.error ()) });
        }
        auto text = ctx.send_list_page (*request);
        if (!text) {
            return fail_page (std::move (text.error ()));
        }
        auto result = page_result (*text, ctx.max_body_bytes);
        if (!result) {
            return fail_page (ListPageFailure{ .message = std::move (result.error ()) });
        }
        return std::move (*result);
    };
    size_t items = 0;
    const std::string key (list.result_key);
    auto pages = collect_mcp_list_pages (send, key.c_str (),
    constants::elements::MAX_SNAPSHOT_PAGES, items, constants::elements::MAX_SNAPSHOT_ITEMS);
    if (pages) {
        ordered_json result = ordered_json::object ();
        result[key]         = std::move (pages->rows);
        ordered_json reply  = ordered_json::object ();
        reply["result"]     = std::move (result);
        return std::optional<ordered_json> (std::in_place, std::move (reply));
    }
    if (page_failure) {
        return std::unexpected (not_compared (list,
        std::format ("page {}: {}", pages.error ().pages_sent, page_failure->message),
        page_failure->cancelled));
    }
    return std::unexpected (not_compared (list, loop_failure_text (list, pages.error ())));
}

} // namespace vayu::core
