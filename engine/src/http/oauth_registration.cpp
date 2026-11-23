/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/oauth_registration.cpp
 * @brief Dynamic client registration (RFC 7591) for a discovered MCP server's
 *        authorization server (#3766).
 */

#include "vayu/http/oauth_registration.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/logger.hpp"

#include <optional>
#include <utility>

namespace vayu::http {

namespace {

namespace codes = oauth_registration;

std::unexpected<ClientRegistrationError> refuse (std::string_view code, std::string message) {
    return std::unexpected (
    ClientRegistrationError{ std::string (code), std::move (message) });
}

/// The string member @p name, or "" when it is absent or not a string.
std::string string_member (const nlohmann::json& doc, std::string_view name) {
    const auto it = doc.find (name);
    return it != doc.end () && it->is_string () ? it->get<std::string> () : std::string{};
}

vayu::http::ClientConfig registration_client_config (vayu::db::Database& db,
const std::string& server_url,
const std::atomic<bool>* cancel) {
    vayu::http::ClientConfig config;
    config.transport = resolve_transport_policy (db);
    config.cancel    = cancel;
    config.max_response_bytes = vayu::core::constants::http::MAX_PARSED_RESPONSE_BODY_BYTES;
    config.local_peer_rule = discovered_peer_rule (server_url);
    return config;
}

std::unexpected<ClientRegistrationError> transport_failure (vayu::ErrorCode code,
const std::string& detail,
const std::string& endpoint,
int timeout_ms) {
    if (code == vayu::ErrorCode::Timeout) {
        return refuse (codes::TIMEOUT,
        "Client registration at " + endpoint + " timed out after " +
        std::to_string (timeout_ms) + " ms (request timeout)");
    }
    return refuse (codes::NETWORK_ERROR,
    "Client registration at " + endpoint +
    " got no answer: " + (detail.empty () ? "connection error" : detail));
}

/// @p body as a JSON object no deeper than the token response's bound, or
/// nullopt.
std::optional<nlohmann::json> json_object_of (const std::string& body) {
    nlohmann::json parsed = nlohmann::json::parse (body, nullptr, false);
    if (parsed.is_discarded () || !parsed.is_object () ||
    !vayu::core::json_within_depth (parsed, vayu::core::constants::elements::MAX_BODY_DEPTH)) {
        return std::nullopt;
    }
    // In place: a json converts to an optional too, and -Wconversion asks
    // which conversion was meant.
    return std::optional<nlohmann::json> (std::in_place, std::move (parsed));
}

/// RFC 7591 section 3.2.2: the endpoint's `error` and `error_description`,
/// the only parts of a refusal quoted.
ClientRegistrationError
refusal_of (int status, const std::string& body, const std::string& endpoint) {
    std::string message = "Client registration at " + endpoint +
    " was refused (HTTP " + std::to_string (status) + ")";
    if (const auto doc = json_object_of (body)) {
        if (const std::string error = string_member (*doc, "error"); !error.empty ()) {
            message += ": " + error;
            if (const std::string why = string_member (*doc, "error_description");
            !why.empty ()) {
                message += " (" + why + ")";
            }
        }
    }
    return ClientRegistrationError{ std::string (codes::REFUSED), std::move (message) };
}

/// Whether the registered client must authenticate with a secret: its stated
/// method is not `none`, or it states none and was issued a secret.
bool registered_confidential (const nlohmann::json& doc) {
    const auto method = doc.find ("token_endpoint_auth_method");
    if (method != doc.end () && !method->is_null ()) {
        return !method->is_string () || method->get<std::string> () != "none";
    }
    return doc.contains ("client_secret");
}

std::expected<std::string, ClientRegistrationError>
client_id_of (const std::string& body, const std::string& endpoint) {
    const auto invalid = [&endpoint] (std::string_view why) {
        return refuse (codes::INVALID_RESPONSE,
        "Client registration at " + endpoint + " answered " + std::string (why));
    };
    const auto doc = json_object_of (body);
    if (!doc) {
        return invalid ("something that is not a JSON object");
    }
    std::string client_id = string_member (*doc, "client_id");
    if (client_id.empty ()) {
        return invalid ("no string `client_id`");
    }
    if (registered_confidential (*doc)) {
        return invalid (
        "a client that authenticates with a secret, and Vayu "
        "registers a public client - enter a client id and "
        "secret registered with the server in clientId instead");
    }
    return client_id;
}

} // namespace

nlohmann::json client_registration_request (const std::string& redirect_uri) {
    return nlohmann::json{ { "client_name", oauth_registration::CLIENT_NAME },
        { "redirect_uris", nlohmann::json::array ({ redirect_uri }) },
        { "grant_types", nlohmann::json::array ({ "authorization_code", "refresh_token" }) },
        { "response_types", nlohmann::json::array ({ "code" }) },
        { "token_endpoint_auth_method", "none" }, { "application_type", "native" } };
}

std::expected<std::string, ClientRegistrationError> register_oauth_client (
vayu::db::Database& db,
const std::string& registration_endpoint,
const std::string& redirect_uri,
const std::string& server_url,
int timeout_ms,
const std::atomic<bool>* cancel) {
    if (cancel != nullptr && cancel->load (std::memory_order_acquire)) {
        // libcurl reads the flag only at its first progress tick, which a
        // fast endpoint answers before: a stopping server must not register.
        return transport_failure (vayu::ErrorCode::Cancelled,
        "Request cancelled", registration_endpoint, timeout_ms);
    }
    vayu::http::Client client (registration_client_config (db, server_url, cancel));
    vayu::Headers headers;
    headers["Content-Type"] = "application/json";
    headers["Accept"]       = "application/json";
    vayu::utils::log_info ("oauth", "OAuth2: registering a client",
    { { "url", registration_endpoint } });
    auto result = client.post (registration_endpoint,
    client_registration_request (redirect_uri).dump (), timeout_ms, headers);
    if (!result.is_ok ()) {
        return transport_failure (result.error ().code, client.last_error (),
        registration_endpoint, timeout_ms);
    }
    const vayu::Response& response = result.value ();
    if (response.has_error ()) {
        return transport_failure (response.error_code, response.error_message,
        registration_endpoint, timeout_ms);
    }
    if (response.status_code < 200 || response.status_code >= 300) {
        return std::unexpected (
        refusal_of (response.status_code, response.body, registration_endpoint));
    }
    return client_id_of (response.body, registration_endpoint);
}

} // namespace vayu::http
