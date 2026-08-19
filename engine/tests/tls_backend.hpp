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
 * would leave a leg testing a shape it cannot present. The families are the
 * ones the pinned vcpkg baseline's `curl` port can be built against, the same
 * set `verifies_through_a_bundle_file` in `transport_policy_test.cpp` covers.
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

/**
 * Why @p backend cannot complete a client-certificate handshake *at all* today,
 * or empty when it can (issue #842).
 *
 * Separate from the format matrix above, and the distinction is the whole
 * point: what a backend accepts as a *file* is a stable fact about the backend,
 * while this is a defect in the libcurl we happen to pin. Folding the two
 * together would say "Schannel takes no client identity", which is false and
 * would be the wrong thing to delete when upstream lands a fix.
 *
 * curl 8.21.0 - the pinned baseline - carries two entries in its own
 * `docs/KNOWN_BUGS.md` for this, one of them naming the exact call at
 * `lib/vtls/schannel.c:488`. Measured here as every wire case failing at the
 * second `InitializeSecurityContext`; the evidence is on #842.
 */
inline std::string client_auth_defect (std::string_view backend) {
    if (backend.rfind ("Schannel", 0) != 0) {
        return {};
    }
    return "TLS backend '" + std::string (backend) +
    "' cannot complete a client-certificate handshake with a certificate read "
    "from a file: curl imports it with PKCS12_NO_PERSIST_KEY, and the key that "
    "yields is one Schannel's credential path cannot use - measured as "
    "'SEC_E_INTERNAL_ERROR ... The Local Security Authority cannot be "
    "contacted' on every driver, with both a legacy-PBE and a PBES2 bundle. "
    "Documented upstream in curl 8.21.0's own KNOWN_BUGS (curl issues 17626 "
    "and 3145). The engine still names the format - that half is asserted on "
    "this leg by ClientCertificateBackend and the registry suites. Tracked in "
    "#842; delete this skip with it, not before.";
}

/// The defect this build carries, if any.
inline std::string client_auth_defect () {
    return client_auth_defect (tls_backend_name ());
}

/// The name a test parameter prints as, and the `certFormat` the registry
/// stores - one spelling, so a failure names the row a reader would look for.
inline std::string client_identity_format_name (ClientIdentityFormat format) {
    return format == ClientIdentityFormat::PemPair ? "pem" : "p12";
}

} // namespace vayu::tests
