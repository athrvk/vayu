#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "vayu/http/sse_parser.hpp"
#include "vayu/types.hpp"

/**
 * @brief The MCP reply reader (#3762): what an `mcp` request's reply says, as
 *        the final JSON-RPC response and the failure class it carries.
 *
 * A modern-era server answers a POST with one JSON object, or with a
 * request-scoped event stream whose progress and log notifications precede the
 * final response. Either way a test is about that final response, so the
 * reader finds it once, where each driver hands its response on, and stores
 * the reading on `Response::mcp_reply`. The element pipeline reads it in place
 * of the body (`mcp_element_view`), so `assert.jsonpath` and `extract.json`
 * address `$.result...` on every path; the body itself, `pm.response.text()`
 * and `pm.response.events` stay the raw reply.
 *
 * Its own file rather than a part of `mcp_body.hpp`: that one is the request
 * half and touches no response, and this one reads event streams, which the
 * request half has no use for.
 *
 * Nothing here retries or falls back. A version refusal (`-32022`) or a legacy
 * server's `400` is reported with what the reply says, because a retry hides a
 * mismatch from a regression test and doubles a load run's traffic.
 */

namespace vayu::http {

/**
 * @brief The `id` a reply to @p request answers: the wire body's own `id`, or
 *        the constant `1` `mcp_wire_body` stamps on a bare call and assumes for
 *        a body it cannot read. Nothing for a notification, an envelope written
 *        without an `id`, which a server answers with no response at all.
 */
[[nodiscard]] std::optional<nlohmann::ordered_json> mcp_request_id (const Request& request);

/**
 * @brief The final response among an event stream's events, kept as they
 *        arrive, for a consumer that does not keep the stream's bytes
 *        (`consume_sse_stream`).
 *
 * The final response is the last `message` event whose `data` is a JSON-RPC
 * response (a `result` or `error` member) carrying the request's `id`. A
 * notification carries no `id`, and a request the server sends the client
 * carries neither member, so neither is mistaken for it, even under the same
 * `id`: the two sides number their requests independently.
 */
class McpReplyStream {
    public:
    explicit McpReplyStream (std::optional<nlohmann::ordered_json> request_id);

    void observe (const SseEvent& event);

    /// The final response's text, or nothing when none has arrived.
    [[nodiscard]] const std::optional<std::string>& final_response () const {
        return final_response_;
    }
    /// True when a `message` event was cut at the per-event byte cap, so the
    /// final response may have arrived and been unreadable.
    [[nodiscard]] bool saw_cut_event () const {
        return saw_cut_event_;
    }

    private:
    std::optional<nlohmann::ordered_json> request_id_;
    std::optional<std::string> final_response_;
    bool saw_cut_event_ = false;
};

/**
 * @brief The reply reader: @p response to @p request as its final JSON-RPC
 *        response and failure class.
 *
 * The final response is the body of a JSON reply, or of a `text/event-stream`
 * reply the event the stream carried (`McpReplyStream`'s rule), read from
 * @p live when the consumer kept the events rather than the bytes and from the
 * buffered body otherwise. Then, in order:
 *
 * - A failed transfer (`Response::error_code`) is `transport`, in its own words.
 * - A final response with an `error` member is `protocol`, carrying its `code`.
 *   `-32022` names the versions its `error.data.supported` lists beside the
 *   one this request speaks.
 * - A non-2xx status with no JSON-RPC error is `transport`; a `400` says the
 *   server looks legacy-era and points at an explicit `initialize` request.
 * - A 2xx reply with no final response is `transport`, except to a
 *   notification, which expects none.
 * - A `result` with `isError: true` is `tool`.
 */
[[nodiscard]] McpReply read_mcp_reply (const Request& request,
const Response& response,
const McpReplyStream* live = nullptr);

/// Sets @p response's `mcp_reply` from the buffered reply when @p request is an
/// `mcp` request; leaves every other request's response untouched.
void attach_mcp_reply (const Request& request, Response& response);

/**
 * @brief The response the element pipeline reads for @p response: itself, or
 *        for an `mcp` reply whose final response is not already the body, a
 *        copy in @p storage whose body is that final response.
 *
 * A copy rather than a rewrite, so the body scripts, the trace and a load run's
 * samples keep stays the raw reply.
 */
[[nodiscard]] Response*
mcp_element_view (Response& response, std::optional<Response>& storage);

/**
 * @brief The failed test an `mcp` failure fails its step with, the way a failed
 *        assertion does; nothing when the reply succeeded, for a request of
 *        another mode, and for a failed transfer, which already fails its step
 *        as an error.
 */
[[nodiscard]] std::optional<TestResult> mcp_failure_test (const Response& response);

/**
 * @brief @p response's `mcp_reply` when it failed although its status alone
 *        counts as a success (`is_success_status`), which is when a load run's
 *        error tally would otherwise miss it; null otherwise. A failed transfer
 *        and a 4xx or 5xx are counted as errors already.
 */
[[nodiscard]] const McpReply* mcp_failure_behind_success_status (const Response& response);

} // namespace vayu::http
