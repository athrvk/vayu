/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief An MCP request's `_meta` and mirrored headers. See
 *        `vayu/http/mcp_body.hpp` for why the engine writes both.
 */

#include "vayu/http/mcp_body.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <format>

#include "vayu/core/constants.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/jsonrpc_body.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/ordered_json.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

namespace {

using ordered_json = nlohmann::ordered_json;

constexpr std::string_view SENTINEL_PREFIX = "=?base64?";
constexpr std::string_view SENTINEL_SUFFIX = "?=";

/// The request metadata a bare call is stamped with. Built per call rather
/// than held in a static, because the engine version is the only part that
/// is not a literal and the object is a few members.
ordered_json request_meta () {
    ordered_json meta                              = ordered_json::object ();
    meta[std::string (mcp::META_PROTOCOL_VERSION)] = mcp::PROTOCOL_VERSION;
    meta[std::string (mcp::META_CLIENT_INFO)] =
    ordered_json{ { "name", mcp::CLIENT_NAME }, { "version", vayu::Version::string } };
    meta[std::string (mcp::META_CLIENT_CAPABILITIES)] = ordered_json::object ();
    return meta;
}

void stamp_meta (ordered_json& call) {
    auto params = call.find ("params");
    if (params == call.end ()) {
        call["params"] = ordered_json::object ();
        params         = call.find ("params");
    } else if (params->is_null ()) {
        *params = ordered_json::object ();
    }
    if (!params->is_object () || params->contains ("_meta")) {
        return;
    }
    (*params)["_meta"] = request_meta ();
}

/// Printable ASCII with no edge space: what may go on a header line as
/// written. Tab is left to the sentinel, which every server must decode.
bool is_plain_header_value (std::string_view value) {
    if (value.empty () || value.front () == ' ' || value.back () == ' ') {
        return false;
    }
    return std::ranges::all_of (value, [] (char ch) {
        const auto byte = static_cast<unsigned char> (ch);
        return byte >= 0x20 && byte <= 0x7E;
    });
}

bool looks_like_sentinel (std::string_view value) {
    return value.starts_with (SENTINEL_PREFIX) && value.ends_with (SENTINEL_SUFFIX);
}

const std::string* string_member (const ordered_json& object, std::string_view key) {
    const auto member = object.find (key);
    if (member == object.end () || !member->is_string ()) {
        return nullptr;
    }
    return &member->get_ref<const std::string&> ();
}

const ordered_json* object_member (const ordered_json& object, std::string_view key) {
    const auto member = object.find (key);
    if (member == object.end () || !member->is_object ()) {
        return nullptr;
    }
    return &*member;
}

std::string_view protocol_version_of (const ordered_json& params) {
    if (const auto* meta = object_member (params, "_meta")) {
        if (const auto* version = string_member (*meta, mcp::META_PROTOCOL_VERSION)) {
            return *version;
        }
    }
    return mcp::PROTOCOL_VERSION;
}

/// Which `params` member the method's `Mcp-Name` mirrors, or none.
std::string_view name_source (std::string_view method) {
    if (method == "tools/call" || method == "prompts/get") {
        return "name";
    }
    if (method == "resources/read") {
        return "uri";
    }
    return {};
}

/// An argument as the text its header carries: a string as written, a number
/// or boolean as JSON spells it. Anything else has no header form.
std::optional<std::string> argument_text (const ordered_json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_boolean () || value.is_number ()) {
        return value.dump ();
    }
    return std::nullopt;
}

const ordered_json*
argument_at (const ordered_json& arguments, const McpParamHeader& annotation) {
    const ordered_json* node = &arguments;
    for (const auto& key : annotation.path) {
        if (!node->is_object ()) {
            return nullptr;
        }
        const auto member = node->find (key);
        if (member == node->end ()) {
            return nullptr;
        }
        node = &*member;
    }
    return node;
}

void append_param_headers (std::vector<HeaderLine>& headers,
const ordered_json& params,
const McpTool& tool) {
    const auto* called    = string_member (params, "name");
    const auto* arguments = object_member (params, "arguments");
    if (called == nullptr || *called != tool.name || arguments == nullptr) {
        return;
    }
    for (const auto& annotation : tool.param_headers) {
        const auto* value = argument_at (*arguments, annotation);
        if (value == nullptr) {
            continue;
        }
        if (auto text = argument_text (*value)) {
            headers.push_back (
            HeaderLine{ std::string (mcp::PARAM_HEADER_PREFIX) + annotation.header,
            mcp_header_value (*text) });
        }
    }
}

void append_plain (std::vector<HeaderLine>& headers, std::string_view name, std::string_view value) {
    if (is_plain_header_value (value)) {
        headers.push_back (HeaderLine{ std::string (name), std::string (value) });
    }
}

std::string joined_path (const std::vector<std::string>& path) {
    std::string out;
    for (const auto& key : path) {
        out += out.empty () ? key : "." + key;
    }
    return out;
}

/// The annotation on one property, appended to @p out, or why it is unusable.
std::optional<std::string> read_annotation (const nlohmann::json& property,
const std::vector<std::string>& path,
std::vector<McpParamHeader>& out) {
    const auto annotation = property.find (mcp::HEADER_ANNOTATION);
    if (annotation == property.end ()) {
        return std::nullopt;
    }
    const std::string where = joined_path (path);
    if (!annotation->is_string ()) {
        return std::format ("'mcpTool' property '{}': '{}' must be a string",
        where, mcp::HEADER_ANNOTATION);
    }
    const auto& header = annotation->get_ref<const std::string&> ();
    if (auto refusal = invalid_header_token (header)) {
        return std::format ("'mcpTool' property '{}': {}", where, *refusal);
    }
    const bool repeated =
    std::ranges::any_of (out, [&header] (const McpParamHeader& seen) {
        return utils::ascii_lower_equal (seen.header, header);
    });
    if (repeated) {
        return std::format ("'mcpTool' property '{}': '{}' names a header "
                            "another property already mirrors",
        where, header);
    }
    out.push_back (McpParamHeader{ path, header });
    return std::nullopt;
}

/// Every annotation reachable from @p schema through `properties` keys alone,
/// the only place the specification lets one sit.
std::optional<std::string> collect_param_headers (const nlohmann::json& schema,
std::vector<std::string>& path,
std::vector<McpParamHeader>& out) {
    const auto properties = schema.find ("properties");
    if (properties == schema.end () || !properties->is_object ()) {
        return std::nullopt;
    }
    for (const auto& [key, property] : properties->items ()) {
        if (!property.is_object ()) {
            continue;
        }
        path.push_back (key);
        if (auto refusal = read_annotation (property, path, out)) {
            return refusal;
        }
        if (auto refusal = collect_param_headers (property, path, out)) {
            return refusal;
        }
        path.pop_back ();
    }
    return std::nullopt;
}

} // namespace

std::string mcp_wire_body (const std::string& content) {
    auto call = bare_jsonrpc_call (content);
    if (!call) {
        return content;
    }
    stamp_meta (*call);
    return complete_jsonrpc_call (*call);
}

std::vector<HeaderLine> mcp_derived_headers (std::string_view wire_body,
const std::optional<McpTool>& tool) {
    std::vector<HeaderLine> headers{ HeaderLine{
    std::string (mcp::ACCEPT_HEADER), std::string (mcp::ACCEPT_VALUE) } };

    // Bounded for the reason `jsonrpc_wire_body` is (#2672); a call past the
    // bound reads as one that does not parse.
    const auto parsed = utils::parse_ordered_json (
    wire_body, vayu::core::constants::request_body::MAX_JSON_DEPTH);
    if (!parsed || !parsed->is_object ()) {
        append_plain (headers, mcp::PROTOCOL_VERSION_HEADER, mcp::PROTOCOL_VERSION);
        return headers;
    }
    const ordered_json& call   = *parsed;
    const ordered_json* params = object_member (call, "params");
    append_plain (headers, mcp::PROTOCOL_VERSION_HEADER,
    params != nullptr ? protocol_version_of (*params) : mcp::PROTOCOL_VERSION);

    const auto* method = string_member (call, "method");
    if (method == nullptr) {
        return headers;
    }
    append_plain (headers, mcp::METHOD_HEADER, *method);
    if (params == nullptr) {
        return headers;
    }
    const std::string_view source = name_source (*method);
    if (const auto* name = source.empty () ? nullptr : string_member (*params, source)) {
        headers.push_back (
        HeaderLine{ std::string (mcp::NAME_HEADER), mcp_header_value (*name) });
    }
    if (tool && *method == "tools/call") {
        append_param_headers (headers, *params, *tool);
    }
    return headers;
}

std::string mcp_header_value (std::string_view value) {
    if (is_plain_header_value (value) && !looks_like_sentinel (value)) {
        return std::string (value);
    }
    return std::string (SENTINEL_PREFIX) + utils::base64_encode (value) +
    std::string (SENTINEL_SUFFIX);
}

std::expected<McpTool, std::string> read_mcp_tool (const nlohmann::json& value) {
    if (!value.is_object ()) {
        return std::unexpected ("'mcpTool' must be an object");
    }
    const auto name = value.find ("name");
    if (name == value.end () || !name->is_string () ||
    name->get_ref<const std::string&> ().empty ()) {
        return std::unexpected ("'mcpTool.name' must be a non-empty string");
    }
    McpTool tool;
    tool.name = name->get<std::string> ();

    const auto schema = value.find ("inputSchema");
    if (schema == value.end () || schema->is_null ()) {
        return tool;
    }
    if (!schema->is_object ()) {
        return std::unexpected ("'mcpTool.inputSchema' must be an object");
    }
    std::vector<std::string> path;
    if (auto refusal = collect_param_headers (*schema, path, tool.param_headers)) {
        return std::unexpected (std::move (*refusal));
    }
    return tool;
}

} // namespace vayu::http
