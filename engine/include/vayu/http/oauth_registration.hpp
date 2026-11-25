#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief Dynamic client registration (RFC 7591) for the authorize flow of a
 *        discovered MCP server (#3766).
 *
 * Vayu registers a public native client: no secret (`token_endpoint_auth_method`
 * `none`, so PKCE is what proves the client at the token endpoint) and
 * `application_type` `native`, which an OpenID Connect server needs before it
 * accepts a loopback redirect (its default, `web`, refuses one). The redirect
 * registered is the one the attempt uses: a loopback listener's port is
 * ephemeral, so it is known only once that listener is bound.
 */

#include <atomic>
#include <expected>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>

namespace vayu::db {
class Database;
} // namespace vayu::db

namespace vayu::http {

namespace oauth_registration {

/// The `client_name` every registration sends.
constexpr std::string_view CLIENT_NAME = "Vayu";

// The stable `ClientRegistrationError::code` values.

/// The registration got no HTTP answer: unreachable, refused, cancelled, or a
/// body past the bound.
constexpr std::string_view NETWORK_ERROR = "oauth_registration_network_error";
/// The registration's deadline ran out.
constexpr std::string_view TIMEOUT = "oauth_registration_timeout";
/// The registration endpoint answered with a status outside 2xx (an RFC 7591
/// section 3.2.2 error, whose `error` and `error_description` the message
/// quotes).
constexpr std::string_view REFUSED = "oauth_registration_refused";
/// A 2xx answer that is not a JSON object with a string `client_id`, or that
/// registered a client which must authenticate with a secret.
constexpr std::string_view INVALID_RESPONSE =
"oauth_registration_invalid_response";

} // namespace oauth_registration

/// Why a registration produced no client: one of the `oauth_registration`
/// codes and a sentence naming the endpoint. Never quotes a secret the
/// response carried.
struct ClientRegistrationError {
    std::string code;
    std::string message;
};

/// The RFC 7591 client metadata a registration for @p redirect_uri posts.
[[nodiscard]] nlohmann::json client_registration_request (const std::string& redirect_uri);

/**
 * @brief Register a public client for @p redirect_uri at
 *        @p registration_endpoint and answer its `client_id`.
 *
 * The post goes through `Client` under `resolve_transport_policy`, with the
 * response bound and @p cancel, the transport a token request uses. When
 * @p server_url (the MCP server the registration is for) names neither a
 * loopback nor a link-local host, it runs under an empty `LocalPeerRule`, as
 * that server's discovery did.
 *
 * Any `client_secret` in the response is neither kept nor reported: a
 * response whose `token_endpoint_auth_method` is not `none` (or that carries a
 * secret and states no method, RFC 7591's default being `client_secret_basic`)
 * is refused, because the client it describes cannot complete the flow without
 * that secret.
 */
[[nodiscard]] std::expected<std::string, ClientRegistrationError>
register_oauth_client (vayu::db::Database& db,
const std::string& registration_endpoint,
const std::string& redirect_uri,
const std::string& server_url,
int timeout_ms,
const std::atomic<bool>* cancel = nullptr);

} // namespace vayu::http
