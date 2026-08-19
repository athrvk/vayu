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
 * identity such a test would present, and `CrlServer` below is the CRL that
 * fixture should reuse rather than build a second one (#819).
 *
 * **The CA publishes a CRL, and the leaf says where to find it** (#819). A
 * backend that revocation-checks the chain - curl's Schannel path passes
 * `CERT_CHAIN_REVOCATION_CHECK_CHAIN` - refuses a leaf whose revocation status
 * it cannot determine, with the anchor loaded and the signature good. That is
 * not a verdict about trust, and it made the *positive* half of
 * `tls_verification_test.cpp` unhostable on that backend. So the CA signs an
 * empty CRL, a plain-HTTP listener serves it, and the leaf carries a
 * distribution point naming that listener. The other backends never ask, so
 * nothing about them changes.
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
#include <sstream>
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
struct CrlDeleter {
    void operator() (X509_CRL* value) const noexcept {
        X509_CRL_free (value);
    }
};
struct Asn1TimeDeleter {
    void operator() (ASN1_TIME* value) const noexcept {
        ASN1_TIME_free (value);
    }
};

using X509Ptr     = std::unique_ptr<X509, X509Deleter>;
using KeyPtr      = std::unique_ptr<EVP_PKEY, KeyDeleter>;
using BioPtr      = std::unique_ptr<BIO, BioDeleter>;
using CrlPtr      = std::unique_ptr<X509_CRL, CrlDeleter>;
using Asn1TimePtr = std::unique_ptr<ASN1_TIME, Asn1TimeDeleter>;

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

inline std::string to_der (X509_CRL* crl) {
    BioPtr bio (BIO_new (BIO_s_mem ()));
    if (!bio || i2d_X509_CRL_bio (bio.get (), crl) != 1) {
        fail ("could not serialize a CRL to DER");
    }
    return read_bio (bio, "a CRL");
}

/// Whatever the BIO holds, empty included - unlike `read_bio`, which treats
/// empty as a fixture defect. A certificate that carries no extension at all
/// prints nothing, and that is an answer a guard wants to read rather than a
/// reason to abort the run.
inline std::string read_bio_text (const BioPtr& bio) {
    char* data        = nullptr;
    const long length = BIO_get_mem_data (bio.get (), &data);
    if (length <= 0 || data == nullptr) {
        return {};
    }
    return { data, static_cast<std::string::size_type> (length) };
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

    /**
     * @brief The `crlDistributionPoints` extension as OpenSSL prints it, or
     *        empty if the certificate carries none.
     *
     * Read off the certificate object the listener actually serves rather than
     * off the string that was passed in when it was minted - the two agreeing
     * is the thing worth asserting, since a distribution point the leaf does
     * not carry is one no backend will ever fetch.
     */
    std::string crl_distribution_point_text () const {
        const int index =
        X509_get_ext_by_NID (certificate.get (), NID_crl_distribution_points, -1);
        if (index < 0) {
            return {};
        }
        X509_EXTENSION* extension = X509_get_ext (certificate.get (), index);
        tls_detail::BioPtr bio (BIO_new (BIO_s_mem ()));
        if (!bio || extension == nullptr ||
        X509V3_EXT_print (bio.get (), extension, 0, 0) != 1) {
            return {};
        }
        return tls_detail::read_bio_text (bio);
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
     * @param crl_distribution_point Where a backend that revocation-checks the
     *        chain can fetch @ref crl_der, or empty for a leaf that names none.
     *        `CERT_CHAIN_REVOCATION_CHECK_CHAIN` checks the chain below the
     *        root, so this belongs on the *leaf* - the self-signed root is its
     *        own trust anchor and answers to nobody.
     */
    CertificateAndKey issue (const std::string& common_name,
    const std::string& subject_alt_names,
    const std::string& crl_distribution_point = {}) const {
        return sign (common_name, subject_alt_names, crl_distribution_point,
        identity_.certificate.get (), identity_.key.get ());
    }

    /**
     * @brief An empty CRL this CA signed, DER-encoded - the answer "nothing
     *        issued here is revoked", which is the answer a fresh CA owes and
     *        the one it could not give before #819.
     *
     * Empty is the whole point: a backend refusing the chain over an *unknown*
     * revocation status is refusing for want of a document, not for want of
     * trust, and this is that document.
     */
    std::string crl_der () const {
        tls_detail::CrlPtr crl (X509_CRL_new ());
        if (!crl) {
            tls_detail::fail ("could not allocate a CRL");
        }
        // v2. A v1 CRL takes no extensions, and `crlNumber` below is one.
        if (X509_CRL_set_version (crl.get (), 1) != 1 ||
        X509_CRL_set_issuer_name (
        crl.get (), X509_get_subject_name (identity_.certificate.get ())) != 1) {
            tls_detail::fail ("could not seed a CRL");
        }
        set_crl_validity (crl.get ());
        set_crl_number (crl.get ());
        if (X509_CRL_sort (crl.get ()) != 1 ||
        X509_CRL_sign (crl.get (), identity_.key.get (), EVP_sha256 ()) == 0) {
            tls_detail::fail ("could not sign a CRL");
        }
        return tls_detail::to_der (crl.get ());
    }

    /**
     * @brief Why @p der is not a CRL this CA would vouch for, or empty if it
     *        is one.
     *
     * The fixture's own guard reads this. A CRL that is served but unparseable,
     * or signed by nothing, or already expired, leaves the revocation question
     * exactly where it was while looking fixed - and on the backends that never
     * ask, nothing would notice.
     */
    std::string crl_defect (const std::string& der) const {
        if (der.empty ()) {
            return "nothing was served";
        }
        const auto* data = reinterpret_cast<const unsigned char*> (der.data ());
        tls_detail::CrlPtr crl (
        d2i_X509_CRL (nullptr, &data, static_cast<long> (der.size ())));
        if (!crl) {
            return "the " + std::to_string (der.size ()) + " bytes served are not a DER-encoded CRL";
        }
        if (X509_NAME_cmp (X509_CRL_get_issuer (crl.get ()),
            X509_get_subject_name (identity_.certificate.get ())) != 0) {
            return "the CRL names an issuer other than this CA";
        }
        tls_detail::KeyPtr public_key (X509_get_pubkey (identity_.certificate.get ()));
        if (!public_key || X509_CRL_verify (crl.get (), public_key.get ()) != 1) {
            return "the CRL is not signed by this CA's key";
        }
        const ASN1_TIME* next = X509_CRL_get0_nextUpdate (crl.get ());
        if (next == nullptr || X509_cmp_current_time (next) <= 0) {
            return "the CRL names no nextUpdate in the future, so a validator "
                   "may treat it as stale";
        }
        return {};
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

    /// The same window as a certificate's, and backdated for the same reason.
    static void set_crl_validity (X509_CRL* crl) {
        tls_detail::Asn1TimePtr last (ASN1_TIME_new ());
        tls_detail::Asn1TimePtr next (ASN1_TIME_new ());
        if (!last || !next || X509_gmtime_adj (last.get (), -3600) == nullptr ||
        X509_gmtime_adj (next.get (), 86400) == nullptr ||
        X509_CRL_set1_lastUpdate (crl, last.get ()) != 1 ||
        X509_CRL_set1_nextUpdate (crl, next.get ()) != 1) {
            tls_detail::fail ("could not set a CRL validity window");
        }
    }

    /// One CRL per run, so its number never has to advance.
    static void set_crl_number (X509_CRL* crl) {
        ASN1_INTEGER* number = ASN1_INTEGER_new ();
        if (number == nullptr || ASN1_INTEGER_set (number, 1) != 1 ||
        X509_CRL_add1_ext_i2d (crl, NID_crl_number, number, 0, 0) != 1) {
            ASN1_INTEGER_free (number);
            tls_detail::fail ("could not set a CRL number");
        }
        ASN1_INTEGER_free (number);
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
    const std::string& crl_distribution_point,
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
        if (!crl_distribution_point.empty ()) {
            add_extension (certificate, issuer, NID_crl_distribution_points,
            "URI:" + crl_distribution_point);
        }
        if (X509_sign (certificate, issuer_key, EVP_sha256 ()) == 0) {
            tls_detail::fail ("could not sign a leaf certificate");
        }
        return leaf;
    }

    CertificateAndKey identity_;
};

/**
 * @brief A plain-HTTP listener on 127.0.0.1 serving one CA's CRL (#819).
 *
 * Plain HTTP on purpose: a revocation fetch that needed TLS would need its own
 * trust decision, and the chain being validated is the one asking. RFC 5280
 * distribution points are `http:` for the same reason.
 *
 * The path carries a per-instance token because Windows caches a fetched CRL
 * **by URL**. Two runs on one machine can land on the same ephemeral port, and
 * the second would then be served the first run's CRL out of the cache - signed
 * by a CA that no longer exists, which reads as a revocation failure and would
 * make this fixture flake for a reason nothing in it names.
 */
class CrlServer {
    public:
    explicit CrlServer (const TestCertificateAuthority& ca)
    : der_ (ca.crl_der ()) {
        svr_.Get (path (), [this] (const httplib::Request&, httplib::Response& res) {
            res.set_content (der_, "application/pkix-crl");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~CrlServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    CrlServer (const CrlServer&)            = delete;
    CrlServer& operator= (const CrlServer&) = delete;

    /// What a leaf's distribution point names, and where the guard fetches.
    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + path ();
    }

    private:
    /// No `.` in the path on purpose: httplib compiles a route pattern as a
    /// regular expression, and a literal here reads as one.
    std::string path () const {
        std::ostringstream token;
        token << "/crl-" << std::hex << reinterpret_cast<uintptr_t> (this);
        return token.str ();
    }

    std::string der_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
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
    : crl_ (ca),
      identity_ (ca.issue ("127.0.0.1", "IP:127.0.0.1,DNS:localhost", crl_.url ())),
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

    /// Where this listener's CRL is served, which is also what its certificate
    /// names as a distribution point - the fixture guard asserts those agree.
    std::string crl_url () const {
        return crl_.url ();
    }

    /// The `crlDistributionPoints` extension as it stands on the certificate
    /// this listener presents, or empty if it carries none.
    std::string crl_distribution_point_text () const {
        return identity_.crl_distribution_point_text ();
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

    /// Declared first because the leaf below is minted naming its URL: the
    /// distribution point has to exist before the certificate that points at
    /// it, and member order is what enforces that here.
    CrlServer crl_;
    CertificateAndKey identity_;
    std::string cert_pem_;
    std::string key_pem_;
    httplib::SSLServer svr_;
    std::thread thread_;
    int port_ = 0;
};

} // namespace vayu::tests
