#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/postman_format.hpp
 * @brief The Postman Collection names Vayu maps onto its own, read by both the
 *        importer (`import_document.cpp`) and the exporter
 *        (`postman_export.cpp`).
 *
 * One table per mapping so the two directions cannot disagree: a key renamed
 * here is renamed on the way in and on the way out, and a row added here is
 * imported and exported at once.
 */

#include <array>
#include <string_view>

namespace vayu::core::postman {

/// What `info.schema` says a v2.1 export is.
constexpr std::string_view SCHEMA_V21 =
"https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/// The raw-body `options.raw.language` values that are a Vayu body mode of
/// the same name. Every other language imports by sniffing the content.
constexpr auto RAW_LANGUAGES =
std::to_array<std::string_view> ({ "json", "text", "xml" });

/// A Vayu auth mode stored as `{mode, config}` and the Postman auth `type`
/// whose attribute array is that `config`, key for key.
struct ConfigAuthType {
    std::string_view vayu;
    std::string_view postman;
};

/// AWS Signature is `awsv4` on the wire and `aws` in Vayu; the others share
/// a name. None of them is executed: each is stored as data (`config`) and
/// sent without auth, counted as `nonExecutableAuth` on import.
constexpr auto CONFIG_AUTH_TYPES = std::to_array<ConfigAuthType> ({
{ "aws", "awsv4" },
{ "digest", "digest" },
{ "ntlm", "ntlm" },
{ "hawk", "hawk" },
{ "oauth1", "oauth1" },
{ "edgegrid", "edgegrid" },
{ "jwt", "jwt" },
});

/// An `oauth2` attribute that is one `OAuth2Config` string field.
struct OAuth2Field {
    std::string_view postman;
    std::string_view vayu;
};

/// In the order the importer writes the config's fields.
constexpr auto OAUTH2_STRING_FIELDS = std::to_array<OAuth2Field> ({
{ "authUrl", "authorizationUrl" },
{ "accessTokenUrl", "accessTokenUrl" },
{ "refreshTokenUrl", "refreshTokenUrl" },
{ "redirect_uri", "callbackUrl" },
{ "clientId", "clientId" },
{ "clientSecret", "clientSecret" },
{ "scope", "scope" },
{ "username", "username" },
{ "password", "password" },
});

/// A Postman `grant_type` and the Vayu `grantType` plus `pkce` it means.
struct OAuth2Grant {
    std::string_view postman;
    std::string_view vayu;
    bool pkce;
};

/**
 * Both directions read the first row matching their side. `implicit` is
 * import-only: Vayu has no implicit grant, runs one as authorization code with
 * PKCE, and so exports that as `authorization_code_with_pkce`, the row above
 * it.
 */
constexpr auto OAUTH2_GRANTS = std::to_array<OAuth2Grant> ({
{ "authorization_code", "authorization_code", false },
{ "authorization_code_with_pkce", "authorization_code", true },
{ "implicit", "authorization_code", true },
{ "password_credentials", "password", false },
{ "client_credentials", "client_credentials", false },
});

} // namespace vayu::core::postman
