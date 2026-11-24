/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** The MCP reply reader. See `vayu/http/mcp_reply.hpp`. */

#include "vayu/http/mcp_reply.hpp"

#include <format>
#include <string_view>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/core/sample_capture.hpp"
#include "vayu/http/jsonrpc_body.hpp"
#include "vayu/http/mcp_body.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace vayu::http {

namespace {

using ordered_json = nlohmann::ordered_json;

constexpr std::string_view FAILURE_TEST_NAME   = "MCP reply";
constexpr std::int64_t UNSUPPORTED_VERSION     = -32022;
constexpr std::size_t MAX_QUOTED_MESSAGE_BYTES = 512;

/// A reply's JSON as the element pipeline would read it: bounded at the depth
/// its kinds accept, and an object, since a JSON-RPC response is one.
std::optional<ordered_json> parse_object (std::string_view text) {
    auto parsed =
    utils::parse_ordered_json (text, core::constants::elements::MAX_BODY_DEPTH);
    if (!parsed || !parsed->is_object ()) {
        return std::nullopt;
    }
    return parsed;
}

bool is_event_stream (const Response& response) {
    const auto found = response.headers.find ("content-type");
    return found != response.headers.end () &&
    core::media_type (found->second) == "text/event-stream";
}

bool is_2xx (int status) {
    return status >= 200 && status < 300;
}

/// Text a server chose, cut to a length a message can carry. Cut on a byte,
/// so the cut is made valid UTF-8 again before anything serialises it.
std::string server_text (std::string_view text) {
    if (text.size () <= MAX_QUOTED_MESSAGE_BYTES) {
        return std::string (text);
    }
    return sanitize_utf8 (text.substr (0, MAX_QUOTED_MESSAGE_BYTES)) + "...";
}

McpReply failed (McpReply reply, McpErrorClass error_class, std::string message) {
    reply.error_class = error_class;
    reply.message     = std::move (message);
    return reply;
}

/// The scope a token needs, when the response is a 401 or 403 whose Bearer
/// challenge says `insufficient_scope` (RFC 6750 section 3.1) - what a person
/// reading a refused run wants named (#3795). Reads only: nothing is retried
/// or re-authorized, and `invalid_token` or any other challenge is no answer.
std::optional<std::string> insufficient_scope_message (const Response& response) {
    if (response.status_code != 401 && response.status_code != 403) {
        return std::nullopt;
    }
    const auto challenge = response.headers.find ("www-authenticate");
    if (challenge == response.headers.end ()) {
        return std::nullopt;
    }
    const auto step_up = classify_bearer_challenge ({ challenge->second }, "");
    if (!step_up.step_up) {
        return std::nullopt;
    }
    if (step_up.required_scopes.empty ()) {
        return "insufficient_scope: the token lacks a scope the server did not "
               "name";
    }
    std::string scopes;
    for (const auto& scope : step_up.required_scopes) {
        scopes += (scopes.empty () ? "" : " ") + scope;
    }
    return std::format ("insufficient_scope: needs \"{}\"", server_text (scopes));
}

/// `"server supports A, B; this request is V"`, or nothing when the refusal
/// lists no version.
std::optional<std::string> supported_versions_message (const ordered_json& error) {
    const auto data = error.find ("data");
    if (data == error.end () || !data->is_object ()) {
        return std::nullopt;
    }
    const auto supported = data->find ("supported");
    if (supported == data->end () || !supported->is_array ()) {
        return std::nullopt;
    }
    std::string versions;
    for (const auto& version : *supported) {
        if (version.is_string ()) {
            versions += (versions.empty () ? "" : ", ") + version.get<std::string> ();
        }
    }
    if (versions.empty ()) {
        return std::nullopt;
    }
    return std::format ("server supports {}; this request is {}",
    server_text (versions), mcp::PROTOCOL_VERSION);
}

McpReply protocol_failure (McpReply reply, const ordered_json& error) {
    std::string text;
    if (error.is_object ()) {
        if (const auto code = error.find ("code");
        code != error.end () && code->is_number_integer ()) {
            reply.code = code->get<std::int64_t> ();
        }
        if (const auto message = error.find ("message");
        message != error.end () && message->is_string ()) {
            text = server_text (message->get_ref<const std::string&> ());
        }
        if (reply.code == UNSUPPORTED_VERSION) {
            if (auto versions = supported_versions_message (error)) {
                return failed (std::move (reply), McpErrorClass::Protocol,
                std::move (*versions));
            }
        }
    }
    std::string message = reply.code ? std::format ("JSON-RPC error {}", *reply.code) :
                                       std::string ("JSON-RPC error");
    if (!text.empty ()) {
        message += ": " + text;
    }
    return failed (std::move (reply), McpErrorClass::Protocol, std::move (message));
}

/// The first text block of a tool result, which is where a tool says why it
/// failed; empty when it carries none.
std::string first_text_content (const ordered_json& result) {
    const auto content = result.find ("content");
    if (content == result.end () || !content->is_array ()) {
        return {};
    }
    for (const auto& block : *content) {
        if (!block.is_object () || block.value ("type", "") != "text") {
            continue;
        }
        if (const auto text = block.find ("text");
        text != block.end () && text->is_string ()) {
            return server_text (text->get_ref<const std::string&> ());
        }
    }
    return {};
}

McpReply judge_final_response (McpReply reply, const ordered_json& frame, const Response& response) {
    if (const auto error = frame.find ("error");
    error != frame.end () && !error->is_null ()) {
        return protocol_failure (std::move (reply), *error);
    }
    if (!is_2xx (response.status_code)) {
        return failed (std::move (reply), McpErrorClass::Transport,
        insufficient_scope_message (response).value_or (std::format (
        "HTTP {} answered with a JSON-RPC result", response.status_code)));
    }
    const auto result = frame.find ("result");
    if (result != frame.end () && result->is_object () && result->value ("isError", false)) {
        const std::string why = first_text_content (*result);
        return failed (std::move (reply), McpErrorClass::Tool,
        why.empty () ? std::string ("the tool reported an error") :
                       "the tool reported an error: " + why);
    }
    return reply;
}

/// What a reply without a final response says, when it is a failure at all.
McpReply judge_missing_response (McpReply reply,
const Response& response,
bool expects_response,
bool streamed,
bool saw_cut_event) {
    const int status = response.status_code;
    if (status == 400) {
        return failed (std::move (reply), McpErrorClass::Transport,
        std::format (
        "HTTP 400 with no JSON-RPC error: the server looks legacy-era "
        "(before {}); send an explicit initialize request first",
        mcp::PROTOCOL_VERSION));
    }
    if (!is_2xx (status)) {
        return failed (std::move (reply), McpErrorClass::Transport,
        insufficient_scope_message (response).value_or (
        std::format ("HTTP {} with no JSON-RPC response", status)));
    }
    if (!expects_response) {
        return reply;
    }
    if (!streamed) {
        return failed (std::move (reply), McpErrorClass::Transport,
        "the reply carried no JSON-RPC response");
    }
    std::string message = "the event stream ended before the final response";
    if (saw_cut_event) {
        message += "; an event was cut at sseMaxEventBytes, and it may have "
                   "been the response";
    }
    return failed (std::move (reply), McpErrorClass::Transport, std::move (message));
}

/// The final response a buffered event stream carries, read by the same rule
/// the live consumer keeps. The body is already bounded by the transfer, so
/// the parser's per-event cap is the body's length and cuts nothing.
McpReplyStream read_buffered_stream (const std::optional<ordered_json>& request_id,
const std::string& body) {
    McpReplyStream stream (request_id);
    SseParser parser (body.size () + 1);
    for (const auto& event : parser.feed (body)) {
        stream.observe (event);
    }
    for (const auto& event : parser.finish ()) {
        stream.observe (event);
    }
    return stream;
}

} // namespace

std::optional<ordered_json> mcp_request_id (const Request& request) {
    // In place, because an `ordered_json` converts to an optional two ways.
    const auto id_of = [] (const ordered_json& id) {
        return std::optional<ordered_json> (std::in_place, id);
    };
    if (auto bare = bare_jsonrpc_call (request.body.content)) {
        const auto id = bare->find ("id");
        return id_of (id != bare->end () ? *id : ordered_json (1));
    }
    const auto envelope = utils::parse_ordered_json (
    request.body.content, core::constants::request_body::MAX_JSON_DEPTH);
    if (!envelope || !envelope->is_object ()) {
        return id_of (ordered_json (1));
    }
    const auto id = envelope->find ("id");
    if (id == envelope->end ()) {
        return std::nullopt;
    }
    return id_of (*id);
}

McpReplyStream::McpReplyStream (std::optional<ordered_json> request_id)
: request_id_ (std::move (request_id)) {
}

void McpReplyStream::observe (const SseEvent& event) {
    if (event.event != "message" || !request_id_) {
        return;
    }
    if (event.truncated) {
        saw_cut_event_ = true;
        return;
    }
    const auto frame = parse_object (event.data);
    if (!frame) {
        return;
    }
    const auto id = frame->find ("id");
    if (id == frame->end () || *id != *request_id_) {
        return;
    }
    if (frame->contains ("result") || frame->contains ("error")) {
        final_response_ = event.data;
    }
}

McpReply read_mcp_reply (const Request& request,
const Response& response,
const McpReplyStream* live) {
    McpReply reply;
    if (response.has_error ()) {
        return failed (std::move (reply), McpErrorClass::Transport, response.error_message);
    }
    const auto request_id = mcp_request_id (request);
    const bool streamed   = is_event_stream (response);
    bool saw_cut_event    = false;
    if (streamed) {
        std::optional<McpReplyStream> buffered;
        const McpReplyStream* stream = live;
        if (stream == nullptr) {
            stream =
            &buffered.emplace (read_buffered_stream (request_id, response.body));
        }
        reply.response = stream->final_response ().value_or ("");
        saw_cut_event  = stream->saw_cut_event ();
    } else {
        reply.response = response.body;
    }

    const auto frame =
    reply.response.empty () ? std::nullopt : parse_object (reply.response);
    if (!frame || !(frame->contains ("result") || frame->contains ("error"))) {
        reply.response.clear ();
        return judge_missing_response (std::move (reply), response,
        request_id.has_value (), streamed, saw_cut_event);
    }
    return judge_final_response (std::move (reply), *frame, response);
}

void attach_mcp_reply (const Request& request, Response& response) {
    if (request.body.mode != BodyMode::Mcp) {
        return;
    }
    response.mcp_reply = read_mcp_reply (request, response);
}

Response* mcp_element_view (Response& response, std::optional<Response>& storage) {
    const auto& reply = response.mcp_reply;
    if (!reply || reply->response.empty () || reply->response == response.body) {
        return &response;
    }
    storage.emplace (response);
    storage->body           = reply->response;
    storage->body_size      = storage->body.size ();
    storage->body_truncated = false;
    return &*storage;
}

std::optional<TestResult> mcp_failure_test (const Response& response) {
    const auto& reply = response.mcp_reply;
    if (response.has_error () || !reply || !reply->error_class) {
        return std::nullopt;
    }
    return TestResult{ std::string (FAILURE_TEST_NAME), false,
        std::format ("{} failure: {}", to_string (*reply->error_class), reply->message) };
}

const McpReply* mcp_failure_behind_success_status (const Response& response) {
    const auto& reply = response.mcp_reply;
    if (response.has_error () || !is_success_status (response.status_code) ||
    !reply || !reply->error_class) {
        return nullptr;
    }
    return &*reply;
}

} // namespace vayu::http
