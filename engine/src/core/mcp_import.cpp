/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/mcp_import.cpp
 * @brief An MCP server's listing as an `ImportResult`. See
 *        `vayu/core/mcp_import.hpp`.
 */

#include "vayu/core/mcp_import.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/import_document.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/utils/log_redact.hpp"

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

/// The request one listed entry becomes, before the rows every request shares.
struct EntryRequest {
    std::string name;
    std::string description;
    /// The call's method and `params`.
    std::string method;
    json params;
};

using EntryReader = std::optional<EntryRequest> (*) (const json& entry);

/// @p entry's member @p key when it is a non-empty string.
std::optional<std::string> nonempty_string (const json& entry, const char* key) {
    if (!entry.is_object ()) {
        return std::nullopt;
    }
    const auto found = entry.find (key);
    if (found == entry.end () || !found->is_string () ||
    found->get_ref<const std::string&> ().empty ()) {
        return std::nullopt;
    }
    return found->get<std::string> ();
}

std::string description_of (const json& entry) {
    return nonempty_string (entry, "description").value_or ("");
}

json named_call_params (const std::string& name) {
    json params         = json::object ();
    params["name"]      = name;
    params["arguments"] = json::object ();
    return params;
}

json uri_params (const std::string& uri) {
    json params   = json::object ();
    params["uri"] = uri;
    return params;
}

std::optional<EntryRequest> tool_request (const json& tool) {
    auto name = nonempty_string (tool, "name");
    if (!name) {
        return std::nullopt;
    }
    json params = named_call_params (*name);
    return EntryRequest{ std::move (*name), description_of (tool), "tools/call",
        std::move (params) };
}

std::optional<EntryRequest> prompt_request (const json& prompt) {
    auto name = nonempty_string (prompt, "name");
    if (!name) {
        return std::nullopt;
    }
    json params = named_call_params (*name);
    return EntryRequest{ std::move (*name), description_of (prompt),
        "prompts/get", std::move (params) };
}

std::optional<EntryRequest> resource_request (const json& resource) {
    const auto uri = nonempty_string (resource, "uri");
    if (!uri) {
        return std::nullopt;
    }
    return EntryRequest{ nonempty_string (resource, "name").value_or (*uri),
        description_of (resource), "resources/read", uri_params (*uri) };
}

/// A template is read with its URI as written; the description says it is one,
/// because the `{placeholders}` are the user's to fill.
std::optional<EntryRequest> template_request (const json& resource_template) {
    const auto uri = nonempty_string (resource_template, "uriTemplate");
    if (!uri) {
        return std::nullopt;
    }
    std::string description = "URI template: " + *uri;
    if (const std::string own = description_of (resource_template); !own.empty ()) {
        description += "\n\n" + own;
    }
    return EntryRequest{ nonempty_string (resource_template, "name").value_or (*uri),
        std::move (description), "resources/read", uri_params (*uri) };
}

/// The caller's headers as request rows; a credential's value is withheld and
/// its row disabled, so no request carries it or sends it empty.
json carried_header_rows (const std::vector<HeaderLine>& headers) {
    json rows = json::array ();
    for (const auto& [name, value] : headers) {
        const bool secret = vayu::utils::is_secret_header_name (name, {});
        json row          = json::object ();
        row["key"]        = name;
        row["value"]      = secret ? std::string () : value;
        row["enabled"]    = !secret;
        rows.push_back (std::move (row));
    }
    return rows;
}

/// The bare call an `mcp` body holds: the engine adds `jsonrpc`, `id` and
/// `_meta` at send, which it would not do to a written envelope.
std::string bare_call (const EntryRequest& entry) {
    json call      = json::object ();
    call["method"] = entry.method;
    call["params"] = entry.params;
    return call.dump (2);
}

json request_draft (EntryRequest entry, const McpServerListing& listing, const json& header_rows) {
    json body              = json::object ();
    body["mode"]           = "mcp";
    body["content"]        = bare_call (entry);
    json request           = json::object ();
    request["name"]        = std::move (entry.name);
    request["description"] = std::move (entry.description);
    request["method"]      = "POST";
    request["url"]         = listing.url;
    request["params"] =
    json (reconcile_query_rows (nlohmann::json::array (), listing.url));
    request["headers"]  = with_required_content_type (header_rows, body);
    request["body"]     = std::move (body);
    request["auth"]     = json{ { "mode", "inherit" } };
    request["elements"] = json::array ();
    return request;
}

/// Appends a request per usable entry of @p entries to @p requests, counting
/// each one with no identity as a `malformed_item`.
void append_requests (const json& entries,
EntryReader read,
const McpServerListing& listing,
const json& header_rows,
json& requests,
ImportTally& tally) {
    for (const json& entry : entries) {
        auto request = read (entry);
        if (!request) {
            tally.add ("malformed_item");
            continue;
        }
        requests.push_back (request_draft (std::move (*request), listing, header_rows));
    }
}

json folder_draft (std::string_view name, json requests) {
    json folder           = json::object ();
    folder["name"]        = std::string (name);
    folder["description"] = "";
    folder["variables"]   = json::object ();
    folder["auth"]        = json{ { "mode", "none" } };
    folder["elements"]    = json::array ();
    folder["children"]    = json::array ();
    folder["requests"]    = std::move (requests);
    return folder;
}

/// The root's auth and variables: a bearer import's token as a secret
/// variable the user fills, never the token itself.
void set_root_auth (json& root, bool bearer) {
    json variables = json::object ();
    if (!bearer) {
        root["variables"] = std::move (variables);
        root["auth"]      = json{ { "mode", "none" } };
        return;
    }
    json token                                  = json::object ();
    token["value"]                              = "";
    token["enabled"]                            = true;
    token["secret"]                             = true;
    variables[std::string (MCP_TOKEN_VARIABLE)] = std::move (token);
    root["variables"]                           = std::move (variables);
    root["auth"]                                = json{ { "mode", "bearer" },
        { "token", "{{" + std::string (MCP_TOKEN_VARIABLE) + "}}" } };
}

json import_meta (std::size_t requests, std::size_t folders, const ImportTally& tally) {
    json meta                   = json::object ();
    meta["format"]              = std::string (MCP_IMPORT_FORMAT);
    meta["requestCount"]        = requests;
    meta["folderCount"]         = folders;
    meta["environmentCount"]    = 0;
    meta["globalCount"]         = 0;
    meta["exampleCount"]        = 0;
    meta["skipped"]             = tally.items ();
    meta["nonExecutableAuth"]   = 0;
    meta["unattachedFileParts"] = 0;
    return meta;
}

} // namespace

json mcp_import_result (const McpServerListing& listing) {
    const json header_rows = carried_header_rows (listing.headers);
    ImportTally tally;
    json children         = json::array ();
    std::size_t requests  = 0;
    const auto add_folder = [&] (std::string_view name, json folder_requests) {
        requests += folder_requests.size ();
        children.push_back (folder_draft (name, std::move (folder_requests)));
    };

    if (listing.tools) {
        json tools = json::array ();
        append_requests (*listing.tools, tool_request, listing, header_rows, tools, tally);
        add_folder ("Tools", std::move (tools));
    }
    if (listing.resources) {
        json resources = json::array ();
        append_requests (*listing.resources, resource_request, listing,
        header_rows, resources, tally);
        if (listing.resource_templates) {
            append_requests (*listing.resource_templates, template_request,
            listing, header_rows, resources, tally);
        }
        add_folder ("Resources", std::move (resources));
    }
    if (listing.prompts) {
        json prompts = json::array ();
        append_requests (
        *listing.prompts, prompt_request, listing, header_rows, prompts, tally);
        add_folder ("Prompts", std::move (prompts));
    }

    json root           = json::object ();
    root["name"]        = listing.name;
    root["description"] = "";
    set_root_auth (root, listing.bearer);
    root["elements"]          = json::array ();
    const std::size_t folders = children.size ();
    root["children"]          = std::move (children);
    root["requests"]          = json::array ();

    json result = json::object ();
    // Pushed rather than listed: an initializer list copies, and the root
    // holds every request.
    result["collections"] = json::array ();
    result["collections"].push_back (std::move (root));
    result["environments"] = json::array ();
    result["globals"]      = json::object ();
    result["meta"]         = import_meta (requests, folders, tally);
    return result;
}

} // namespace vayu::core
