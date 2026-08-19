#pragma once

/**
 * @file tls_backend.hpp
 * @brief What TLS backend this build verifies with, and what a client identity
 *        has to look like for it.
 *
 * Two suites need the same fact for different reasons - `transport_policy_test`
 * asks whether `CURLOPT_CAINFO` replaces the trust store or adds to it,
 * `mutual_tls_test` asks what format a *client* certificate may be in - and a
 * second reader of `curl_version_info()` would be a second thing to correct
 * when a build's backend changes. It lives here so there is one.
 */

#include <curl/curl.h>

#include <string>
#include <string_view>

namespace vayu::tests {

/// What `curl_version_info()` says this build verifies with, or empty when it
/// will not say - which is itself a finding, not a default to paper over.
inline std::string tls_backend_name () {
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    if (info == nullptr || info->ssl_version == nullptr) {
        return {};
    }
    return info->ssl_version;
}

/// The shape a backend takes a client identity in.
enum class ClientIdentityFormat {
    /// A PEM certificate and a PEM key, the pair libcurl reads by default.
    PemPair,
    /// A PKCS#12 file, which libcurl reads only when told the type is `P12`,
    /// or a reference into the platform's certificate store.
    Pkcs12,
    /// A backend no statement in this repo covers.
    Unknown,
};

/// How @p backend expects a client identity to arrive. The families are the
/// ones the pinned vcpkg baseline's `curl` port can be built against, the same
/// set `verifies_through_a_bundle_file` in `transport_policy_test.cpp` covers.
inline ClientIdentityFormat client_identity_format (std::string_view backend) {
    for (const std::string_view family : { "OpenSSL", "LibreSSL", "BoringSSL", "quictls" }) {
        if (backend.rfind (family, 0) == 0) {
            return ClientIdentityFormat::PemPair;
        }
    }
    if (backend.rfind ("Schannel", 0) == 0) {
        return ClientIdentityFormat::Pkcs12;
    }
    return ClientIdentityFormat::Unknown;
}

} // namespace vayu::tests
