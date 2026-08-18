#pragma once

/**
 * @file tls_server.hpp
 * @brief An in-process HTTPS listener whose certificate a test-only CA signs,
 *        so custom-CA verification can be asserted on a wire (issue #812).
 *
 * `TlsBackend.AcceptsACustomCaBundleOnThisPlatform` answers a narrower
 * question than its name suggests - whether this build's backend refuses
 * `CURLOPT_CAINFO` outright - and nothing in the suite ever proved that
 * pointing curl at a user's anchors *makes verification succeed*, or that it
 * fails without them. Neither can be answered without a real handshake, and a
 * handshake needs a server, so here is one.
 *
 * **The material is generated per run, never checked in.** A committed
 * certificate expires, and the suite would then fail on a date rather than on
 * a change - the worst shape of red there is, since the failure names TLS and
 * the cause is the calendar. Generating in-process also keeps a private key
 * out of the repository, and lets a test ask for a *second*, unrelated CA
 * cheaply, which is the only way to tell "verification works" apart from "any
 * bundle is accepted".
 *
 * In-process rather than a script under `scripts/test/`, following the
 * precedent of `mock_server.hpp`, `echo_server.hpp` and `proxy_server.hpp`.
 *
 * It is not a general-purpose TLS server. #802's mTLS fixture is expected to
 * extend `TlsServer` with a client-certificate store rather than stand up a
 * second listener - `TestCertificateAuthority::issue` already mints the client
 * identity such a test would present.
 */

#include <httplib.h>

#if !defined(CPPHTTPLIB_OPENSSL_SUPPORT)
#error "tls_server.hpp needs cpp-httplib's openssl feature (engine/vcpkg.json)"
#endif

#include <openssl/bn.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

namespace vayu::tests {

namespace tls_detail {

struct X509Deleter {
    void operator() (X509* value) const noexcept {
        X509_free (value);
    }
};
struct KeyDeleter {
    void operator() (EVP_PKEY* value) const noexcept {
        EVP_PKEY_free (value);
    }
};
struct BioDeleter {
    void operator() (BIO* value) const noexcept {
        BIO_free (value);
    }
};

using X509Ptr = std::unique_ptr<X509, X509Deleter>;
using KeyPtr  = std::unique_ptr<EVP_PKEY, KeyDeleter>;
using BioPtr  = std::unique_ptr<BIO, BioDeleter>;

/// Fail the way a fixture should: loudly, naming OpenSSL's own reason. A
/// silently degraded fixture would leave the tests below asserting nothing.
[[noreturn]] inline void fail (const std::string& what) {
    const unsigned long reason = ERR_get_error ();
    char detail[256]           = { 0 };
    if (reason != 0) {
        ERR_error_string_n (reason, detail, sizeof (detail));
    }
    throw std::runtime_error ("tls_server.hpp: " + what +
    (reason != 0 ? std::string (": ") + detail : std::string ()));
}

inline std::string read_bio (const BioPtr& bio, const char* what) {
    char* data        = nullptr;
    const long length = BIO_get_mem_data (bio.get (), &data);
    if (length <= 0 || data == nullptr) {
        fail (std::string ("serialized ") + what + " to an empty PEM");
    }
    return { data, static_cast<std::string::size_type> (length) };
}

inline std::string to_pem (X509* certificate) {
    BioPtr bio (BIO_new (BIO_s_mem ()));
    if (!bio || PEM_write_bio_X509 (bio.get (), certificate) != 1) {
        fail ("could not serialize a certificate to PEM");
    }
    return read_bio (bio, "a certificate");
}

inline std::string to_pem (EVP_PKEY* key) {
    BioPtr bio (BIO_new (BIO_s_mem ()));
    if (!bio ||
    PEM_write_bio_PrivateKey (bio.get (), key, nullptr, nullptr, 0, nullptr, nullptr) != 1) {
        fail ("could not serialize a private key to PEM");
    }
    return read_bio (bio, "a private key");
}

} // namespace tls_detail

/// A certificate and the key that goes with it.
struct CertificateAndKey {
    tls_detail::X509Ptr certificate;
    tls_detail::KeyPtr key;

    /// The certificate as PEM - what a CA hands out and a test pastes into a
    /// setting.
    std::string pem () const {
        return tls_detail::to_pem (certificate.get ());
    }

    /// The private key as unencrypted PEM. Only ever this process's own
    /// short-lived key material: nothing here is written to disk, and the
    /// listener below takes it from memory.
    std::string key_pem () const {
        return tls_detail::to_pem (key.get ());
    }
};

/**
 * @brief A self-signed CA that exists for the length of one test.
 *
 * Two of them in one test is the point as much as one is: a certificate this
 * CA signed must verify against *this* CA's PEM and must not verify against
 * another's, and only the second half tells real verification apart from a
 * bundle being read and ignored.
 */
class TestCertificateAuthority {
    public:
    explicit TestCertificateAuthority (
    const std::string& common_name = "Vayu Test CA")
    : identity_ (self_signed (common_name)) {
    }

    /// The CA certificate as PEM - what a test pastes into
    /// `customCaCertificates`.
    std::string pem () const {
        return identity_.pem ();
    }

    /**
     * @brief A leaf certificate this CA signs, for @p subject_alt_names.
     *
     * @param common_name  The subject CN, for a human reading a failure.
     * @param subject_alt_names OpenSSL's `subjectAltName` spelling, e.g.
     *        `"IP:127.0.0.1,DNS:localhost"`. An IP literal must appear as an
     *        `IP:` entry: a CN alone has not been enough for any backend this
     *        engine builds against for years, and a hostname SAN does not
     *        cover the address curl dials.
     */
    CertificateAndKey issue (const std::string& common_name,
    const std::string& subject_alt_names) const {
        return sign (common_name, subject_alt_names,
        identity_.certificate.get (), identity_.key.get ());
    }

    private:
    static tls_detail::KeyPtr generate_key () {
        tls_detail::KeyPtr key (EVP_RSA_gen (2048));
        if (!key) {
            tls_detail::fail ("could not generate an RSA key");
        }
        return key;
    }

    /// Serial numbers must differ within a CA; the address of the certificate
    /// under construction is unique for as long as this process runs, which is
    /// the whole life of the material.
    static void set_serial (X509* certificate) {
        ASN1_INTEGER* serial = X509_get_serialNumber (certificate);
        if (serial == nullptr ||
        ASN1_INTEGER_set_uint64 (serial,
        static_cast<uint64_t> (reinterpret_cast<uintptr_t> (certificate))) != 1) {
            tls_detail::fail ("could not set a serial number");
        }
    }

    static void set_name (X509_NAME* name, const std::string& common_name) {
        if (X509_NAME_add_entry_by_txt (name, "CN", MBSTRING_ASC,
            reinterpret_cast<const unsigned char*> (common_name.c_str ()), -1, -1, 0) != 1) {
            tls_detail::fail ("could not set a subject name");
        }
    }

    static void
    add_extension (X509* certificate, X509* issuer, int nid, const std::string& value) {
        X509V3_CTX ctx;
        X509V3_set_ctx_nodb (&ctx);
        X509V3_set_ctx (&ctx, issuer, certificate, nullptr, nullptr, 0);
        X509_EXTENSION* extension =
        X509V3_EXT_conf_nid (nullptr, &ctx, nid, value.c_str ());
        if (extension == nullptr) {
            tls_detail::fail ("could not build extension " + std::to_string (nid));
        }
        const int added = X509_add_ext (certificate, extension, -1);
        X509_EXTENSION_free (extension);
        if (added != 1) {
            tls_detail::fail ("could not add extension " + std::to_string (nid));
        }
    }

    /**
     * A certificate valid from an hour ago to a day from now. Backdated
     * because a runner whose clock sits a little behind the one that generated
     * the material would otherwise reject a certificate that is merely young,
     * and a day is long enough that no suite outlives it.
     */
    static void set_validity (X509* certificate) {
        if (X509_gmtime_adj (X509_getm_notBefore (certificate), -3600) == nullptr ||
        X509_gmtime_adj (X509_getm_notAfter (certificate), 86400) == nullptr) {
            tls_detail::fail ("could not set a validity window");
        }
    }

    static CertificateAndKey self_signed (const std::string& common_name) {
        CertificateAndKey identity{ tls_detail::X509Ptr (X509_new ()), generate_key () };
        X509* certificate = identity.certificate.get ();
        if (certificate == nullptr) {
            tls_detail::fail ("could not allocate a certificate");
        }

        X509_set_version (certificate, 2); // v3, the only version taking extensions
        set_serial (certificate);
        set_validity (certificate);
        set_name (X509_get_subject_name (certificate), common_name);
        if (X509_set_issuer_name (certificate, X509_get_subject_name (certificate)) != 1 ||
        X509_set_pubkey (certificate, identity.key.get ()) != 1) {
            tls_detail::fail ("could not seed the CA certificate");
        }
        add_extension (certificate, certificate, NID_basic_constraints, "critical,CA:TRUE");
        add_extension (certificate, certificate, NID_key_usage, "critical,keyCertSign,cRLSign");
        if (X509_sign (certificate, identity.key.get (), EVP_sha256 ()) == 0) {
            tls_detail::fail ("could not self-sign the CA certificate");
        }
        return identity;
    }

    static CertificateAndKey sign (const std::string& common_name,
    const std::string& subject_alt_names,
    X509* issuer,
    EVP_PKEY* issuer_key) {
        CertificateAndKey leaf{ tls_detail::X509Ptr (X509_new ()), generate_key () };
        X509* certificate = leaf.certificate.get ();
        if (certificate == nullptr) {
            tls_detail::fail ("could not allocate a certificate");
        }

        X509_set_version (certificate, 2);
        set_serial (certificate);
        set_validity (certificate);
        set_name (X509_get_subject_name (certificate), common_name);
        if (X509_set_issuer_name (certificate, X509_get_subject_name (issuer)) != 1 ||
        X509_set_pubkey (certificate, leaf.key.get ()) != 1) {
            tls_detail::fail ("could not seed a leaf certificate");
        }
        add_extension (certificate, issuer, NID_basic_constraints, "critical,CA:FALSE");
        add_extension (certificate, issuer, NID_key_usage,
        "critical,digitalSignature,keyEncipherment");
        add_extension (certificate, issuer, NID_ext_key_usage, "serverAuth,clientAuth");
        add_extension (certificate, issuer, NID_subject_alt_name, subject_alt_names);
        if (X509_sign (certificate, issuer_key, EVP_sha256 ()) == 0) {
            tls_detail::fail ("could not sign a leaf certificate");
        }
        return leaf;
    }

    CertificateAndKey identity_;
};

/**
 * @brief An HTTPS listener on 127.0.0.1, holding a certificate the given CA
 *        signed.
 *
 * Serves one route, `/hello`. What is under test is the handshake in front of
 * it: a body only arrives at all if verification passed, so a 200 here is the
 * assertion and the payload is only there to make a partial read visible.
 */
class TlsServer {
    public:
    explicit TlsServer (const TestCertificateAuthority& ca)
    : identity_ (ca.issue ("127.0.0.1", "IP:127.0.0.1,DNS:localhost")),
      cert_pem_ (identity_.pem ()), key_pem_ (identity_.key_pem ()),
      svr_ (pem_memory ()) {
        if (!svr_.is_valid ()) {
            tls_detail::fail ("the TLS listener refused its own certificate");
        }
        svr_.Get ("/hello", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"over":"tls"})", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~TlsServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    TlsServer (const TlsServer&)            = delete;
    TlsServer& operator= (const TlsServer&) = delete;

    std::string url (const std::string& path) const {
        return "https://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    /**
     * The listener takes its identity as PEM in memory rather than as a pair of
     * file paths - the only two shapes `httplib::SSLServer` offers since 0.53 -
     * so no private key is ever written to disk, not even to a scratch
     * directory a failing run would leave behind.
     *
     * `client_ca_pem` is left null: this listener asks for no client
     * certificate. That is the field #802's mTLS fixture fills in.
     */
    httplib::SSLServer::PemMemory pem_memory () const {
        return { cert_pem_.c_str (), cert_pem_.size (), key_pem_.c_str (),
            key_pem_.size (), nullptr, 0, nullptr };
    }

    CertificateAndKey identity_;
    std::string cert_pem_;
    std::string key_pem_;
    httplib::SSLServer svr_;
    std::thread thread_;
    int port_ = 0;
};

} // namespace vayu::tests
