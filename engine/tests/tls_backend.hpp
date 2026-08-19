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
#include <vector>

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

/// The shape a client identity is stored in.
enum class ClientIdentityFormat {
    /// A PEM certificate and a PEM key, the pair libcurl reads by default.
    PemPair,
    /// A PKCS#12 file, which libcurl reads only when told the type is `P12`.
    Pkcs12,
};

/**
 * Every format @p backend can present a client identity in - which is a *set*,
 * not one answer (#833): an OpenSSL build reads both, Schannel only the bundle.
 *
 * Empty for a backend no statement in this repo covers, and that emptiness is
 * asserted rather than defaulted away: guessing a format for an unknown backend
 * would leave a leg testing a shape it cannot present. Since #851 every leg
 * this repo ships answers the first row - `engine/vcpkg.json` pins `openssl`
 * with `default-features: false`, and `TlsBackend` fails a build that resolved
 * anywhere else - so the Schannel row is what a manifest edit would land on,
 * kept for the same reason the classifier in `transport_policy_test.cpp` keeps
 * its own: a build nobody here reasoned about must be named, not guessed at.
 *
 * A certificate-store reference is Schannel's second shape and is deliberately
 * absent: it is not a file, so nothing in the registry can name one.
 */
inline std::vector<ClientIdentityFormat> client_identity_formats (std::string_view backend) {
    for (const std::string_view family : { "OpenSSL", "LibreSSL", "BoringSSL", "quictls" }) {
        if (backend.rfind (family, 0) == 0) {
            return { ClientIdentityFormat::PemPair, ClientIdentityFormat::Pkcs12 };
        }
    }
    if (backend.rfind ("Schannel", 0) == 0) {
        return { ClientIdentityFormat::Pkcs12 };
    }
    return {};
}

/// What this build can present, read off `curl_version_info()`.
inline std::vector<ClientIdentityFormat> client_identity_formats () {
    return client_identity_formats (tls_backend_name ());
}

/// The name a test parameter prints as, and the `certFormat` the registry
/// stores - one spelling, so a failure names the row a reader would look for.
inline std::string client_identity_format_name (ClientIdentityFormat format) {
    return format == ClientIdentityFormat::PemPair ? "pem" : "p12";
}

} // namespace vayu::tests
