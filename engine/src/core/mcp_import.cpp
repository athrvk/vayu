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

#include "schema_sampler.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/http/mcp_body.hpp"
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
    /// The `{name, inputSchema}` the `mcp` body stores, or null for none.
    json mcp_tool = nullptr;
    /// The tool's schema is one a send refuses, so `mcp_tool` is null (a tool
    /// with no schema is not this).
    bool tool_schema_unusable = false;
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

/// The tool's `inputSchema` when it is an object, the one shape both the
/// sampler and `mcpTool` take.
const json* input_schema_of (const json& tool) {
    const auto found = tool.find ("inputSchema");
    return found != tool.end () && found->is_object () ? &*found : nullptr;
}

/// The tool's `outputSchema` when it is an object, the one shape the request
/// builder reads (a default `assert.jsonschema`, the Body tab's editor).
const json* output_schema_of (const json& tool) {
    const auto found = tool.find ("outputSchema");
    return found != tool.end () && found->is_object () ? &*found : nullptr;
}

/**
 * The arguments a call to a tool described by @p schema carries: the required
 * ones only, each as its schema states it (a `const`, a `default`, an `enum`'s
 * first member) and otherwise a typed stub. Stubs, not `{{variables}}`: a name
 * still written at send is refused (`resolve_residual_tokens`), so a
 * placeholder would leave the generated run failing until it is edited.
 */
json sampled_arguments (const json& schema) {
    const SchemaSampler sampler (schema,
    SampleOptions{
    .use_default = true, .required_only = true, .enum_any_type = true, .honour_bounds = true });
    json arguments = sampler.sample (&schema);
    return arguments.is_object () ? std::move (arguments) : json::object ();
}

/// What an `mcp` body stores of a tool, or null when `read_mcp_tool` refuses it
/// (an `x-mcp-header` that is not a usable header name): `POST /import/apply`
/// refuses the whole tree over one such body, so it is left out of the request.
/// `outputSchema` is stored for the builder; a send never reads it (#3986).
json storable_tool (const std::string& name, const json* schema, const json* output_schema) {
    json tool    = json::object ();
    tool["name"] = name;
    if (schema != nullptr) {
        tool["inputSchema"] = *schema;
    }
    if (output_schema != nullptr) {
        tool["outputSchema"] = *output_schema;
    }
    if (!vayu::http::read_mcp_tool (nlohmann::json (tool))) {
        return nullptr;
    }
    return tool;
}

std::optional<EntryRequest> tool_request (const json& tool) {
    const auto name = nonempty_string (tool, "name");
    if (!name) {
        return std::nullopt;
    }
    const json* schema = input_schema_of (tool);
    json params        = named_call_params (*name);
    if (schema != nullptr) {
        params["arguments"] = sampled_arguments (*schema);
    }
    EntryRequest request{ *name, description_of (tool), "tools/call", std::move (params) };
    request.mcp_tool = storable_tool (*name, schema, output_schema_of (tool));
    request.tool_schema_unusable = request.mcp_tool.is_null ();
    return request;
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

/// Every generated request expects a `200`; the MCP reply's own failure classes
/// (a JSON-RPC error, a tool's `isError`) are judged by the engine without an
/// element. No `assert.jsonschema` from a tool's `outputSchema`: that kind reads
/// draft-07, which a 2020-12 schema can fail by construction (#3763).
json expected_status_elements () {
    json config       = json::object ();
    config["in"]      = json::array ({ 200 });
    json element      = json::object ();
    element["kind"]   = "assert.status";
    element["config"] = std::move (config);
    json elements     = json::array ();
    elements.push_back (std::move (element));
    return elements;
}

json request_draft (EntryRequest entry, const json& header_rows) {
    json body       = json::object ();
    body["mode"]    = "mcp";
    body["content"] = bare_call (entry);
    if (!entry.mcp_tool.is_null ()) {
        body["mcpTool"] = std::move (entry.mcp_tool);
    }
    json request           = json::object ();
    request["name"]        = std::move (entry.name);
    request["description"] = std::move (entry.description);
    request["method"]      = "POST";
    request["url"]         = "{{" + std::string (MCP_BASE_URL_VARIABLE) + "}}";
    request["params"]      = json::array ();
    request["headers"]     = with_required_content_type (header_rows, body);
    request["body"]        = std::move (body);
    request["auth"]        = json{ { "mode", "inherit" } };
    request["elements"]    = expected_status_elements ();
    return request;
}

/// Appends a request per usable entry of @p entries to @p requests, counting
/// each one with no identity as a `malformed_item` and each tool whose schema a
/// send would refuse as an `unusable_tool_schema`, named by the tool.
void append_requests (const json& entries,
EntryReader read,
const json& header_rows,
json& requests,
ImportTally& tally) {
    for (const json& entry : entries) {
        auto request = read (entry);
        if (!request) {
            tally.add ("malformed_item");
            continue;
        }
        if (request->tool_schema_unusable) {
            tally.set_subject (request->name);
            tally.add ("unusable_tool_schema");
            tally.set_subject ("");
        }
        requests.push_back (request_draft (std::move (*request), header_rows));
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

/// The root's auth and variables: the endpoint every request sends to, and a
/// bearer import's token as a secret variable the user fills, never the token
/// itself.
void set_root_scope (json& root, const McpServerListing& listing) {
    json variables                                 = json::object ();
    json base_url                                  = json::object ();
    base_url["value"]                              = listing.url;
    base_url["enabled"]                            = true;
    variables[std::string (MCP_BASE_URL_VARIABLE)] = std::move (base_url);
    if (!listing.bearer) {
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
        append_requests (*listing.tools, tool_request, header_rows, tools, tally);
        add_folder ("Tools", std::move (tools));
    }
    if (listing.resources) {
        json resources = json::array ();
        append_requests (*listing.resources, resource_request, header_rows, resources, tally);
        if (listing.resource_templates) {
            append_requests (*listing.resource_templates, template_request,
            header_rows, resources, tally);
        }
        add_folder ("Resources", std::move (resources));
    }
    if (listing.prompts) {
        json prompts = json::array ();
        append_requests (*listing.prompts, prompt_request, header_rows, prompts, tally);
        add_folder ("Prompts", std::move (prompts));
    }

    json root           = json::object ();
    root["name"]        = listing.name;
    root["description"] = "";
    set_root_scope (root, listing);
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
