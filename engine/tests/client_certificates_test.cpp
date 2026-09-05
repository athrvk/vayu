/**
 * @file tests/client_certificates_test.cpp
 * @brief The client-certificate registry (issue #707): what a row may say, how
 *        a target picks one, and that the pick reaches every driver.
 *
 * **The live handshake is in `mutual_tls_test.cpp`** (#802), not here, and the
 * split is deliberate: this file is about the *registry* - which row a target
 * picks, and what a row may say - so its material is the bytes
 * `not-a-real-certificate`, and nothing in it puts a certificate on a wire.
 * That keeps the lookup asserted at the boundary, the lookup's *outcome*
 * asserted end to end through the design and stream drivers (both record the
 * entry they matched), and the backend's willingness to take the three curl
 * options at all probed per platform the way `TlsBackend` probes
 * `CURLOPT_CAINFO` - while the question of whether the bytes behind those paths
 * are accepted by a server demanding a certificate is asked where a server
 * exists to answer it.
 */

#include <curl/curl.h>
#include <gtest/gtest.h>
#include <httplib.h>

#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "competing_writer.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/transport_policy.hpp"

namespace vayu::http::routes {
// Defined in client_certificates.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_client_certificate_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_client_certificate_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// The update core with its `before_write` seam - invoked inside the lock scope
// with the merged row staged and immediately before it is written (#1440).
std::pair<int, nlohmann::json> update_client_certificate_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write);
} // namespace vayu::http::routes

namespace vayu::http {
namespace {

using nlohmann::json;
namespace routes = vayu::http::routes;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A file on disk for a registry row to name.
 *
 * The bytes are not a certificate and do not need to be: nothing in this suite
 * puts one on a wire, and what the registry promises about a path is that it is
 * *there* - the certificate itself is judged by the TLS backend at handshake
 * time, with its own error, which is the split `client_cert_rejection` documents.
 */
class ScratchFile {
    public:
    /// @p contents defaults to bytes no format claims, which is what most of
    /// this suite wants: a path that is *there*. A test about `certFormat`
    /// passes shaped bytes instead - the marker or the ASN.1 tag - because that
    /// is the one rule here that reads the file rather than the directory
    /// entry.
    explicit ScratchFile (std::string name, const std::string& contents = "not-a-real-certificate\n")
    : path_ (std::move (name)) {
        std::ofstream out (path_, std::ios::binary | std::ios::trunc);
        out.write (contents.data (), static_cast<std::streamsize> (contents.size ()));
    }
    ~ScratchFile () {
        std::error_code ec;
        std::filesystem::remove (path_, ec);
    }
    ScratchFile (const ScratchFile&)            = delete;
    ScratchFile& operator= (const ScratchFile&) = delete;
    ScratchFile (ScratchFile&&)                 = delete;
    ScratchFile& operator= (ScratchFile&&)      = delete;

    const std::string& path () const {
        return path_;
    }

    private:
    std::string path_;
};

/// Plain HTTP, because what is under test is *which entry was chosen*, not TLS:
/// libcurl ignores the certificate options on a cleartext transfer, so the
/// exchange still completes and the response still names the entry that matched.
class MockUpstream {
    public:
    MockUpstream () {
        svr.Get ("/hello", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"from":"upstream"})", "application/json");
        });
        svr.Get ("/events", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("data: one\n\ndata: two\n\n", "text/event-stream");
        });
        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }
    ~MockUpstream () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    MockUpstream (const MockUpstream&)            = delete;
    MockUpstream& operator= (const MockUpstream&) = delete;
    MockUpstream (MockUpstream&&)                 = delete;
    MockUpstream& operator= (MockUpstream&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

Request get_request (const std::string& url) {
    Request request;
    request.method = HttpMethod::GET;
    request.url    = url;
    return request;
}

ClientCertRule rule (std::string id,
std::string host,
std::optional<int> port,
std::string cert_path = "/certs/client.pem",
std::string key_path  = "/certs/client.key") {
    ClientCertRule entry;
    entry.id        = std::move (id);
    entry.host      = std::move (host);
    entry.port      = port;
    entry.cert_path = std::move (cert_path);
    entry.key_path  = std::move (key_path);
    return entry;
}

class ClientCertificateDbTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (path_);
        db_ = std::make_unique<vayu::db::Database> (path_);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (path_);
    }

    /// A create body naming the scratch pair, which is the only shape the route
    /// accepts - the files have to exist.
    json body (const std::string& host, std::optional<int> port = std::nullopt) {
        json payload = { { "host", host }, { "certPath", cert_.path () },
            { "keyPath", key_.path () } };
        if (port) {
            payload["port"] = *port;
        }
        return payload;
    }

    std::string path_ = "test_client_certificates.db";
    std::unique_ptr<vayu::db::Database> db_;
    ScratchFile cert_{ "test_client_cert.pem" };
    ScratchFile key_{ "test_client_key.pem" };
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

TEST (ClientCertMatching, EmptyRegistryMatchesNothing) {
    TransportPolicy policy;
    EXPECT_EQ (match_client_certificate (policy, "api.example.com", 443), nullptr);
}

TEST (ClientCertMatching, AHostEntryAnswersOnEveryPort) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_1", "api.example.com", std::nullopt));

    const ClientCertRule* matched =
    match_client_certificate (policy, "api.example.com", 8443);
    ASSERT_NE (matched, nullptr);
    EXPECT_EQ (matched->id, "cert_1");
    EXPECT_EQ (client_cert_label (*matched), "api.example.com");
}

TEST (ClientCertMatching, APortEntryAnswersOnlyThatPort) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_1", "api.example.com", 8443));

    EXPECT_NE (match_client_certificate (policy, "api.example.com", 8443), nullptr);
    // The whole point of storing a port: a second service on the same host,
    // wanting a different certificate or none, must not inherit this one.
    EXPECT_EQ (match_client_certificate (policy, "api.example.com", 443), nullptr);
}

TEST (ClientCertMatching, ThePortEntryOutranksTheHostEntry) {
    // The precedence rule, and the only one there is. Both orders are asserted
    // because the naive implementation returns whichever came first: revert
    // `match_client_certificate` to "return the first host match" and one of
    // these two fails whatever order the rows arrive in.
    TransportPolicy host_first;
    host_first.client_certificates.push_back (
    rule ("cert_any", "api.example.com", std::nullopt));
    host_first.client_certificates.push_back (rule ("cert_8443", "api.example.com", 8443));

    TransportPolicy port_first;
    port_first.client_certificates.push_back (rule ("cert_8443", "api.example.com", 8443));
    port_first.client_certificates.push_back (
    rule ("cert_any", "api.example.com", std::nullopt));

    for (const auto* policy : { &host_first, &port_first }) {
        const ClientCertRule* matched =
        match_client_certificate (*policy, "api.example.com", 8443);
        ASSERT_NE (matched, nullptr);
        EXPECT_EQ (matched->id, "cert_8443");
        EXPECT_EQ (client_cert_label (*matched), "api.example.com:8443");
    }

    // …and a port the specific entry does not name still gets the catch-all.
    const ClientCertRule* other =
    match_client_certificate (host_first, "api.example.com", 443);
    ASSERT_NE (other, nullptr);
    EXPECT_EQ (other->id, "cert_any");
}

TEST (ClientCertMatching, AnotherHostMatchesNothing) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_1", "api.example.com", std::nullopt));

    EXPECT_EQ (match_client_certificate (policy, "other.example.com", 443), nullptr);
    // Not a suffix match: a plain host is an exact rule, so an entry for the
    // apex must not answer for a subdomain. Widening one is what the wildcard
    // form below is for, and it has to be asked for.
    EXPECT_EQ (match_client_certificate (policy, "eu.api.example.com", 443), nullptr);
    EXPECT_EQ (match_client_certificate (policy, "", 443), nullptr);
}

TEST (ClientCertMatching, TheHostComparisonIgnoresCase) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_1", "api.example.com", std::nullopt));

    EXPECT_NE (match_client_certificate (policy, "API.Example.COM", 443), nullptr);
}

// ---------------------------------------------------------------------------
// Wildcards (issue #803)
// ---------------------------------------------------------------------------

TEST (ClientCertWildcardMatching, AWildcardAnswersForEverySubdomain) {
    // The case the form exists for: one gateway fronting `api`, `auth` and
    // `events`, where a new service otherwise means a row nobody remembers to
    // add and an SSL error against the endpoint.
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_star", "*.example.com", std::nullopt));

    for (const char* host : { "api.example.com", "auth.example.com", "a.b.example.com" }) {
        const ClientCertRule* matched = match_client_certificate (policy, host, 443);
        ASSERT_NE (matched, nullptr) << host;
        EXPECT_EQ (matched->id, "cert_star") << host;
    }
}

TEST (ClientCertWildcardMatching, AWildcardAnswersForNeitherTheApexNorALookalike) {
    // The two near-misses the rule is stated by. The apex is the one a user
    // expects to be included and is not - `*.example.com` is "a subdomain of",
    // which `example.com` is not one of - and the lookalike is the one that
    // costs a client identity if the leading dot is ever dropped from the
    // comparison.
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_star", "*.example.com", std::nullopt));

    EXPECT_EQ (match_client_certificate (policy, "example.com", 443), nullptr);
    EXPECT_EQ (match_client_certificate (policy, "notexample.com", 443), nullptr);
    EXPECT_EQ (match_client_certificate (policy, "example.com.evil.test", 443), nullptr);
    EXPECT_EQ (match_client_certificate (policy, "api.example.org", 443), nullptr);
}

TEST (ClientCertWildcardMatching, AWildcardNeverAnswersForAnAddressLiteral) {
    // A wildcard is a rule about DNS labels. Without this, `*.0.1` would
    // present the user's identity to `127.0.0.1` - a certificate offered to a
    // host nobody registered, which is worse than one not offered at all.
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_star", "*.0.1", std::nullopt));

    EXPECT_EQ (match_client_certificate (policy, "127.0.0.1", 443), nullptr);
    // The IPv4-mapped form is the one that carries dots, so it is the one a
    // textual suffix rule would otherwise answer for.
    EXPECT_EQ (match_client_certificate (policy, "::ffff:127.0.0.1", 443), nullptr);
    // …while an exact entry for an address still answers, as it always did.
    policy.client_certificates.push_back (rule ("cert_exact", "127.0.0.1", std::nullopt));
    const ClientCertRule* matched = match_client_certificate (policy, "127.0.0.1", 443);
    ASSERT_NE (matched, nullptr);
    EXPECT_EQ (matched->id, "cert_exact");
}

TEST (ClientCertWildcardMatching, TheWildcardComparisonIgnoresCase) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_star", "*.example.com", std::nullopt));

    EXPECT_NE (match_client_certificate (policy, "API.Example.COM", 443), nullptr);
}

TEST (ClientCertWildcardMatching, AnExactHostOutranksAWildcardThatAlsoMatches) {
    // Tier one of three, asserted in both row orders because the implementation
    // that returns the first match passes one order and fails the other - and
    // the port is deliberately on the *wildcard* here: host specificity
    // dominates, so an exact entry answering every port still wins. That is
    // what makes the rule one a card can state.
    const auto exact_row = rule ("cert_exact", "api.example.com", std::nullopt);
    const auto wildcard_row = rule ("cert_star", "*.example.com", 8443);

    TransportPolicy exact_first;
    exact_first.client_certificates = { exact_row, wildcard_row };
    TransportPolicy wildcard_first;
    wildcard_first.client_certificates = { wildcard_row, exact_row };

    for (const auto* policy : { &exact_first, &wildcard_first }) {
        const ClientCertRule* matched =
        match_client_certificate (*policy, "api.example.com", 8443);
        ASSERT_NE (matched, nullptr);
        EXPECT_EQ (matched->id, "cert_exact");
    }

    // …and a host the exact entry does not name still reaches the wildcard.
    const ClientCertRule* other =
    match_client_certificate (exact_first, "auth.example.com", 8443);
    ASSERT_NE (other, nullptr);
    EXPECT_EQ (other->id, "cert_star");
}

TEST (ClientCertWildcardMatching, TheLongestWildcardWins) {
    // Tier two: two patterns can overlap - `*.example.com` and
    // `*.eu.example.com` both answer for `api.eu.example.com` - so the registry
    // needs a rule that is not "whichever row came back first". Longest suffix
    // is the one a reader can apply by eye.
    const auto broad  = rule ("cert_broad", "*.example.com", std::nullopt);
    const auto narrow = rule ("cert_narrow", "*.eu.example.com", std::nullopt);

    TransportPolicy broad_first;
    broad_first.client_certificates = { broad, narrow };
    TransportPolicy narrow_first;
    narrow_first.client_certificates = { narrow, broad };

    for (const auto* policy : { &broad_first, &narrow_first }) {
        const ClientCertRule* matched =
        match_client_certificate (*policy, "api.eu.example.com", 443);
        ASSERT_NE (matched, nullptr);
        EXPECT_EQ (matched->id, "cert_narrow");
        // The broader one still owns everything outside the narrower's subtree.
        const ClientCertRule* elsewhere =
        match_client_certificate (*policy, "api.us.example.com", 443);
        ASSERT_NE (elsewhere, nullptr);
        EXPECT_EQ (elsewhere->id, "cert_broad");
    }
}

TEST (ClientCertWildcardMatching, ThePortEntryOutranksTheWildcardCatchAll) {
    // Tier three, inside one pattern: the port rule that already governed exact
    // hosts governs wildcards the same way, so a second service on the same
    // subtree can still have its own certificate.
    const auto any_port  = rule ("cert_any", "*.example.com", std::nullopt);
    const auto this_port = rule ("cert_8443", "*.example.com", 8443);

    TransportPolicy any_first;
    any_first.client_certificates = { any_port, this_port };
    TransportPolicy port_first;
    port_first.client_certificates = { this_port, any_port };

    for (const auto* policy : { &any_first, &port_first }) {
        const ClientCertRule* matched =
        match_client_certificate (*policy, "api.example.com", 8443);
        ASSERT_NE (matched, nullptr);
        EXPECT_EQ (matched->id, "cert_8443");

        const ClientCertRule* other =
        match_client_certificate (*policy, "api.example.com", 443);
        ASSERT_NE (other, nullptr);
        EXPECT_EQ (other->id, "cert_any");
    }
}

// ---------------------------------------------------------------------------
// What a row may say
// ---------------------------------------------------------------------------

TEST (ClientCertValidation, AcceptsAHostAndAReadablePair) {
    ScratchFile cert{ "validation_cert.pem" };
    ScratchFile key{ "validation_key.pem" };

    EXPECT_FALSE (client_cert_rejection ("api.example.com", std::nullopt,
    ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
    EXPECT_FALSE (client_cert_rejection (
    "api.example.com", 8443, ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
    // An IPv6 literal, bracketless - the form `parse_authority` yields, so the
    // form a match will compare against.
    EXPECT_FALSE (client_cert_rejection (
    "::1", 8443, ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
}

TEST (ClientCertValidation, RejectsAHostThatCouldNeverMatch) {
    ScratchFile cert{ "validation_cert2.pem" };
    ScratchFile key{ "validation_key2.pem" };
    const auto reject = [&] (const std::string& host) {
        return client_cert_rejection (
        host, std::nullopt, ClientCertFormat::Pem, cert.path (), key.path ());
    };

    // Every one of these is what a user gets by copying an address bar, and
    // every one would store a row that silently never matches anything.
    EXPECT_TRUE (reject ("").has_value ());
    EXPECT_TRUE (reject ("   ").has_value ());
    EXPECT_TRUE (reject ("https://api.example.com").has_value ());
    EXPECT_TRUE (reject ("api.example.com/v1").has_value ());
    EXPECT_TRUE (reject ("api.example.com:8443").has_value ());
    EXPECT_TRUE (reject ("[::1]").has_value ());
    EXPECT_TRUE (reject ("api example com").has_value ());
}

TEST (ClientCertValidation, AcceptsTheWildcardFormAndRefusesEveryOtherStar) {
    ScratchFile cert{ "validation_cert_wildcard.pem" };
    ScratchFile key{ "validation_key_wildcard.pem" };
    const auto reject = [&] (const std::string& host) {
        return client_cert_rejection (
        host, std::nullopt, ClientCertFormat::Pem, cert.path (), key.path ());
    };

    EXPECT_FALSE (reject ("*.example.com").has_value ());
    // A single-label domain is the corporate-estate case this shipped for
    // (`api.corp`, `auth.corp` behind one gateway), so it is not refused for
    // looking too broad.
    EXPECT_FALSE (reject ("*.corp").has_value ());

    // Everything else carrying a `*` is refused *by name* rather than stored:
    // each of these would otherwise be a hostname no transfer can ever equal,
    // registered and silently never used.
    for (const char* host : { "*", "*.", "*..example.com", "*example.com",
         "api.*.com", "*.*.example.com", "**.example.com" }) {
        EXPECT_TRUE (reject (host).has_value ()) << host;
    }
}

TEST (ClientCertValidation, RejectsAPortOutsideTheRange) {
    ScratchFile cert{ "validation_cert3.pem" };
    ScratchFile key{ "validation_key3.pem" };

    EXPECT_TRUE (client_cert_rejection (
    "api.example.com", 0, ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
    EXPECT_TRUE (client_cert_rejection (
    "api.example.com", 70000, ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
    EXPECT_TRUE (client_cert_rejection (
    "api.example.com", -1, ClientCertFormat::Pem, cert.path (), key.path ())
    .has_value ());
}

TEST (ClientCertValidation, RejectsAFileThatIsNotThere) {
    ScratchFile cert{ "validation_cert4.pem" };
    ScratchFile key{ "validation_key4.pem" };

    const auto missing_cert = client_cert_rejection ("api.example.com",
    std::nullopt, ClientCertFormat::Pem, "/nope/client.pem", key.path ());
    ASSERT_HAS_VALUE (missing_cert);
    // The message has to name the file, or the user is left with "invalid
    // certificate" and two paths to check by hand.
    EXPECT_NE (missing_cert->find ("/nope/client.pem"), std::string::npos);

    const auto missing_key = client_cert_rejection ("api.example.com",
    std::nullopt, ClientCertFormat::Pem, cert.path (), "/nope/client.key");
    ASSERT_HAS_VALUE (missing_key);
    EXPECT_NE (missing_key->find ("/nope/client.key"), std::string::npos);

    // A directory is not a file, and opening one succeeds on some platforms -
    // which is why the check asks for a *regular* file.
    EXPECT_TRUE (client_cert_rejection (
    "api.example.com", std::nullopt, ClientCertFormat::Pem, ".", key.path ())
    .has_value ());
}

// ---------------------------------------------------------------------------
// The certificate format (issue #833)
// ---------------------------------------------------------------------------

/// The first bytes of each shape, which is all `sniff_client_cert_format`
/// reads. Not real material: what is under test is the classifier, and a real
/// bundle would prove the same thing while needing OpenSSL to mint it (the
/// wire tests in `mutual_tls_test.cpp` use real ones).
constexpr std::string_view PEM_SHAPED = "-----BEGIN CERTIFICATE-----\nMIIB\n";
constexpr std::string_view DER_SHAPED = "\x30\x82\x04\x0a not really a bundle";

TEST (ClientCertFormat, ReadsTheShapeOfAFileOrSaysNothing) {
    ScratchFile pem{ "format_pem.pem", std::string (PEM_SHAPED) };
    ScratchFile der{ "format_der.p12", std::string (DER_SHAPED) };
    ScratchFile neither{ "format_neither.txt", "hello\n" };
    ScratchFile empty{ "format_empty.pem", "" };

    EXPECT_EQ (sniff_client_cert_format (pem.path ()), ClientCertFormat::Pem);
    EXPECT_EQ (sniff_client_cert_format (der.path ()), ClientCertFormat::Pkcs12);
    // Unclassified, *not* wrong: a file this engine cannot name is left for the
    // backend to judge, the shallowness `ca_pem_rejection` is written with.
    EXPECT_FALSE (sniff_client_cert_format (neither.path ()).has_value ());
    EXPECT_FALSE (sniff_client_cert_format (empty.path ()).has_value ());
    EXPECT_FALSE (sniff_client_cert_format ("/nope/client.p12").has_value ());
}

TEST (ClientCertFormat, TheWireSpellingAndTheCurlTypeAreSeparate) {
    // Two vocabularies that happen to describe one thing: `certFormat` is ours
    // and appears in every stored row, `CURLOPT_SSLCERTTYPE` is libcurl's. A
    // helper that returned one for the other would send `pem` to a backend that
    // only answers to `PEM`.
    EXPECT_STREQ (to_string (ClientCertFormat::Pem), "pem");
    EXPECT_STREQ (to_string (ClientCertFormat::Pkcs12), "p12");
    EXPECT_STREQ (curl_ssl_cert_type (ClientCertFormat::Pem), "PEM");
    EXPECT_STREQ (curl_ssl_cert_type (ClientCertFormat::Pkcs12), "P12");

    EXPECT_EQ (client_cert_format_from_string ("pem"), ClientCertFormat::Pem);
    EXPECT_EQ (client_cert_format_from_string ("p12"), ClientCertFormat::Pkcs12);
    EXPECT_FALSE (client_cert_format_from_string ("PEM").has_value ());
    EXPECT_FALSE (client_cert_format_from_string ("pkcs12").has_value ());
    EXPECT_FALSE (client_cert_format_from_string ("").has_value ());
}

TEST (ClientCertValidation, APkcs12EntryCarriesItsOwnKeyAndMayNotNameOne) {
    ScratchFile bundle{ "validation_bundle.p12", std::string (DER_SHAPED) };
    ScratchFile key{ "validation_bundle_key.pem" };

    EXPECT_FALSE (client_cert_rejection ("api.example.com", std::nullopt,
    ClientCertFormat::Pkcs12, bundle.path (), "")
    .has_value ())
    << "a bundle with no key path is the only complete shape a PKCS#12 entry "
       "has";

    // Stored and ignored is the failure this refusal exists to prevent: the
    // card would keep asking for a file nothing ever opens.
    const auto with_key = client_cert_rejection ("api.example.com",
    std::nullopt, ClientCertFormat::Pkcs12, bundle.path (), key.path ());
    ASSERT_HAS_VALUE (with_key);
    EXPECT_NE (with_key->find ("PKCS#12"), std::string::npos) << *with_key;

    // And the mirror: a PEM entry without a key names what is missing rather
    // than failing later against the endpoint.
    const auto without_key = client_cert_rejection (
    "api.example.com", std::nullopt, ClientCertFormat::Pem, bundle.path (), "");
    ASSERT_HAS_VALUE (without_key);
    EXPECT_NE (without_key->find ("key file"), std::string::npos) << *without_key;
}

TEST (ClientCertValidation, RefusesAFileThatContradictsItsDeclaredFormat) {
    ScratchFile pem{ "contradiction_cert.pem", std::string (PEM_SHAPED) };
    ScratchFile der{ "contradiction_bundle.p12", std::string (DER_SHAPED) };
    ScratchFile key{ "contradiction_key.pem" };

    // The mistake worth catching at write time: a `.p12` registered as a PEM
    // pair fails at handshake time as libcurl's own parse error against the
    // endpoint, which is the misdiagnosis this registry exists to end.
    const auto bundle_as_pem = client_cert_rejection ("api.example.com",
    std::nullopt, ClientCertFormat::Pem, der.path (), key.path ());
    ASSERT_HAS_VALUE (bundle_as_pem);
    EXPECT_NE (bundle_as_pem->find ("p12"), std::string::npos) << *bundle_as_pem;
    EXPECT_NE (bundle_as_pem->find (der.path ()), std::string::npos) << *bundle_as_pem;

    const auto pem_as_bundle = client_cert_rejection (
    "api.example.com", std::nullopt, ClientCertFormat::Pkcs12, pem.path (), "");
    ASSERT_HAS_VALUE (pem_as_bundle);
    EXPECT_NE (pem_as_bundle->find ("pem"), std::string::npos) << *pem_as_bundle;
}

TEST (ClientCertValidation, LeavesAFileItCannotClassifyToTheBackend) {
    // The other half of the rule above, and the reason the check is a
    // contradiction rather than a whitelist: a DER certificate, a format nobody
    // here has seen, or the byte-shaped fixtures this suite uses must not be
    // refused by a parser of ours.
    ScratchFile unclassified{ "unclassified_cert.pem" };
    ScratchFile key{ "unclassified_key.pem" };

    EXPECT_FALSE (client_cert_rejection ("api.example.com", std::nullopt,
    ClientCertFormat::Pem, unclassified.path (), key.path ())
    .has_value ());
    EXPECT_FALSE (client_cert_rejection ("api.example.com", std::nullopt,
    ClientCertFormat::Pkcs12, unclassified.path (), "")
    .has_value ());
}

// ---------------------------------------------------------------------------
// The registry routes
// ---------------------------------------------------------------------------

TEST_F (ClientCertificateDbTest, CreatesAndListsAnEntry) {
    const auto [status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com", 8443));
    ASSERT_EQ (status, 200) << created.dump ();

    EXPECT_EQ (created["host"], "api.example.com");
    EXPECT_EQ (created["port"], 8443);
    EXPECT_EQ (created["certPath"], cert_.path ());
    EXPECT_EQ (created["hasPassphrase"], false);
    EXPECT_EQ (created["id"].get<std::string> ().rfind ("cert_", 0), 0u);

    const auto rows = db_->get_client_certificates ();
    ASSERT_EQ (rows.size (), 1u);
    const auto& only = rows.front ();
    EXPECT_EQ (only.host, "api.example.com");
    ASSERT_HAS_VALUE (only.port);
    EXPECT_EQ (*only.port, 8443);
}

TEST_F (ClientCertificateDbTest, RegistersAPkcs12EntryWithNoKeyPath) {
    // The shape a Windows user has to be able to store (#833). The bundle
    // carries the key, so the body names none at all - and the row echoes both
    // the format and an empty `keyPath`, which is what lets the card stop
    // asking for a file that does not exist.
    ScratchFile bundle{ "route_bundle.p12", std::string (DER_SHAPED) };
    const json payload = { { "host", "api.example.com" },
        { "certPath", bundle.path () }, { "certFormat", "p12" } };

    const auto [status, created] =
    routes::create_client_certificate_response (*db_, payload);
    ASSERT_EQ (status, 200) << created.dump ();
    EXPECT_EQ (created["certFormat"], "p12");
    EXPECT_EQ (created["keyPath"], "");
    EXPECT_EQ (db_->get_client_certificates ().front ().cert_format, "p12");
}

TEST_F (ClientCertificateDbTest, ReadsAnAbsentFormatOffTheFile) {
    // A user who never learns the field exists still gets a usable row - and
    // the guess comes from the bytes, not from a constant, so naming a bundle
    // is enough.
    ScratchFile bundle{ "sniffed_bundle.p12", std::string (DER_SHAPED) };
    ScratchFile pem{ "sniffed_cert.pem", std::string (PEM_SHAPED) };

    const auto [bundle_status, from_bundle] = routes::create_client_certificate_response (
    *db_, json{ { "host", "bundle.example.com" }, { "certPath", bundle.path () } });
    ASSERT_EQ (bundle_status, 200) << from_bundle.dump ();
    EXPECT_EQ (from_bundle["certFormat"], "p12");

    const auto [pem_status, from_pem] = routes::create_client_certificate_response (*db_,
    json{ { "host", "pem.example.com" }, { "certPath", pem.path () },
    { "keyPath", key_.path () } });
    ASSERT_EQ (pem_status, 200) << from_pem.dump ();
    EXPECT_EQ (from_pem["certFormat"], "pem");

    // And a file that says nothing falls back to `pem` - what every row written
    // before this field existed is, and what the column backfills to.
    const auto [plain_status, from_plain] =
    routes::create_client_certificate_response (*db_, body ("plain.example.com"));
    ASSERT_EQ (plain_status, 200) << from_plain.dump ();
    EXPECT_EQ (from_plain["certFormat"], "pem");
}

TEST_F (ClientCertificateDbTest, RefusesAFormatItDoesNotKnow) {
    json payload          = body ("api.example.com");
    payload["certFormat"] = "pkcs12";

    const auto [status, error] = routes::create_client_certificate_response (*db_, payload);
    EXPECT_EQ (status, 400);
    // Named rather than ignored: a row quietly stored as PEM because the
    // spelling was not ours is a handshake failure against the endpoint later.
    EXPECT_NE (error["error"]["message"].get<std::string> ().find ("'pem'"), std::string::npos)
    << error.dump ();
}

TEST_F (ClientCertificateDbTest, RefusesAPemEntryWithNoKeyFile) {
    json payload = { { "host", "api.example.com" }, { "certPath", cert_.path () } };

    const auto [status, error] = routes::create_client_certificate_response (*db_, payload);
    EXPECT_EQ (status, 400);
    EXPECT_NE (error["error"]["message"].get<std::string> ().find ("key file"),
    std::string::npos)
    << error.dump ();
}

TEST_F (ClientCertificateDbTest, MovingAnEntryToPkcs12ClearsTheKeyPath) {
    // The merged-row rule doing real work: the format and the certificate move
    // together, and `keyPath: null` is how the file the old format needed goes
    // away. Without the clear the merged row would still name a key, which a
    // PKCS#12 entry may not.
    ScratchFile bundle{ "moved_bundle.p12", std::string (DER_SHAPED) };
    const auto [created_status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com"));
    ASSERT_EQ (created_status, 200) << created.dump ();
    const std::string id = created["id"];

    const auto [kept_status, kept] = routes::update_client_certificate_response (
    *db_, id, json{ { "certFormat", "p12" }, { "certPath", bundle.path () } });
    EXPECT_EQ (kept_status, 400) << kept.dump ();

    const auto [status, updated] = routes::update_client_certificate_response (*db_, id,
    json{ { "certFormat", "p12" }, { "certPath", bundle.path () }, { "keyPath", nullptr } });
    ASSERT_EQ (status, 200) << updated.dump ();
    EXPECT_EQ (updated["certFormat"], "p12");
    EXPECT_EQ (updated["keyPath"], "");
}

TEST_F (ClientCertificateDbTest, StoresTheHostLowerCased) {
    // Stored folded, so the per-transfer match is a compare. A row that kept
    // its capitals would match nothing, because `parse_authority` never yields
    // one.
    const auto [status, created] =
    routes::create_client_certificate_response (*db_, body ("API.Example.COM"));
    ASSERT_EQ (status, 200) << created.dump ();
    EXPECT_EQ (created["host"], "api.example.com");
}

TEST_F (ClientCertificateDbTest, AnAbsentPortMeansEveryPort) {
    const auto [status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com"));
    ASSERT_EQ (status, 200) << created.dump ();
    // `null`, not 0 and not an omitted key - the card renders "every port" from
    // this and could not tell an absent key from an engine that cannot say.
    ASSERT_TRUE (created.contains ("port"));
    EXPECT_TRUE (created["port"].is_null ());
}

TEST_F (ClientCertificateDbTest, NeverEchoesThePassphrase) {
    json payload          = body ("api.example.com");
    payload["passphrase"] = "hunter2";

    const auto [status, created] =
    routes::create_client_certificate_response (*db_, payload);
    ASSERT_EQ (status, 200) << created.dump ();

    EXPECT_FALSE (created.contains ("passphrase"));
    EXPECT_EQ (created["hasPassphrase"], true);
    EXPECT_EQ (created.dump ().find ("hunter2"), std::string::npos);
    // Stored, though - the wire is what withholds it, not the database, and
    // curl needs it to open the key.
    EXPECT_EQ (db_->get_client_certificates ().front ().passphrase, "hunter2");
}

TEST_F (ClientCertificateDbTest, RefusesAnUnusableEntry) {
    json payload        = body ("api.example.com");
    payload["certPath"] = "/nope/client.pem";
    const auto [status, error] = routes::create_client_certificate_response (*db_, payload);
    EXPECT_EQ (status, 400);
    EXPECT_TRUE (db_->get_client_certificates ().empty ());

    json scheme = body ("https://api.example.com");
    const auto [scheme_status, scheme_error] =
    routes::create_client_certificate_response (*db_, scheme);
    EXPECT_EQ (scheme_status, 400);

    json bad_port    = body ("api.example.com");
    bad_port["port"] = "8443"; // a string, not an integer
    const auto [port_status, port_error] =
    routes::create_client_certificate_response (*db_, bad_port);
    // Loud, not ignored: a dropped port would widen the entry to every port,
    // which is the opposite of what was asked for.
    EXPECT_EQ (port_status, 400);

    json missing_host = { { "certPath", cert_.path () }, { "keyPath", key_.path () } };
    const auto [host_status, host_error] =
    routes::create_client_certificate_response (*db_, missing_host);
    EXPECT_EQ (host_status, 400);
}

TEST_F (ClientCertificateDbTest, RefusesAClientSuppliedId) {
    json payload  = body ("api.example.com");
    payload["id"] = "cert_mine";
    const auto [status, error] = routes::create_client_certificate_response (*db_, payload);
    EXPECT_EQ (status, 400);
}

TEST_F (ClientCertificateDbTest, RefusesASecondEntryForTheSameTarget) {
    ASSERT_EQ (routes::create_client_certificate_response (*db_, body ("api.example.com", 8443))
               .first,
    200);

    const auto [status, error] =
    routes::create_client_certificate_response (*db_, body ("api.example.com", 8443));
    // Two rows for one target would make the certificate presented depend on
    // row order - which is why `match_client_certificate` has no tie-break.
    EXPECT_EQ (status, 409);
    EXPECT_EQ (db_->get_client_certificates ().size (), 1u);

    // A different port on the same host is a different target, and allowed.
    EXPECT_EQ (routes::create_client_certificate_response (*db_, body ("api.example.com", 9443))
               .first,
    200);
    // As is the catch-all beside them.
    EXPECT_EQ (
    routes::create_client_certificate_response (*db_, body ("api.example.com")).first, 200);
}

TEST_F (ClientCertificateDbTest, AWildcardIsATargetLikeAnyOther) {
    // The uniqueness rule extends to patterns because the pattern *is* the
    // target string (#803) - without that, two rows for `*.example.com` would
    // put the certificate presented back at the mercy of row order, which is
    // the property the three-tier ranking exists to keep.
    ASSERT_EQ (
    routes::create_client_certificate_response (*db_, body ("*.example.com")).first, 200);

    const auto [status, error] =
    routes::create_client_certificate_response (*db_, body ("*.example.com"));
    EXPECT_EQ (status, 409);
    EXPECT_NE (error.dump ().find ("*.example.com"), std::string::npos);

    // Overlapping-but-different patterns are allowed, and are exactly what the
    // longest-suffix rule resolves: they can never tie, because two suffixes of
    // the same length that both match a host are the same string.
    EXPECT_EQ (
    routes::create_client_certificate_response (*db_, body ("*.eu.example.com")).first, 200);
    // As is the same pattern on one port, beside the catch-all.
    EXPECT_EQ (routes::create_client_certificate_response (*db_, body ("*.example.com", 8443))
               .first,
    200);
    EXPECT_EQ (db_->get_client_certificates ().size (), 3u);
}

TEST_F (ClientCertificateDbTest, RefusesAWildcardShapeThatCouldNeverMatch) {
    // The route's half of the write-time check: a `*` outside the one form is a
    // 400 naming the form, not a stored row that never answers.
    const auto [status, error] =
    routes::create_client_certificate_response (*db_, body ("*.*.com"));
    EXPECT_EQ (status, 400);
    EXPECT_NE (error.dump ().find ("*.example.com"), std::string::npos)
    << "the rejection has to show the one shape that works: " << error.dump ();
    EXPECT_TRUE (db_->get_client_certificates ().empty ());
}

TEST_F (ClientCertificateDbTest, UpdatesMergePatchStyle) {
    const auto [created_status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com", 8443));
    ASSERT_EQ (created_status, 200) << created.dump ();
    const std::string id = created["id"];

    // Absent fields keep their value.
    const auto [status, updated] = routes::update_client_certificate_response (
    *db_, id, json{ { "host", "internal.example.com" } });
    ASSERT_EQ (status, 200) << updated.dump ();
    EXPECT_EQ (updated["host"], "internal.example.com");
    EXPECT_EQ (updated["port"], 8443);
    EXPECT_EQ (updated["certPath"], cert_.path ());

    // `null` resets to the default - here, from one port to every port.
    const auto [widened_status, widened] =
    routes::update_client_certificate_response (*db_, id, json{ { "port", nullptr } });
    ASSERT_EQ (widened_status, 200) << widened.dump ();
    EXPECT_TRUE (widened["port"].is_null ());
}

TEST_F (ClientCertificateDbTest, UpdateChecksTheMergedRowNotTheBody) {
    const auto [created_status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com"));
    ASSERT_EQ (created_status, 200) << created.dump ();
    const std::string id = created["id"];

    // Only `keyPath` is in the body, and it is the half that is wrong - which a
    // check of the body's *own* fields against nothing would still catch, but a
    // check that skipped absent fields entirely would not.
    const auto [status, error] = routes::update_client_certificate_response (
    *db_, id, json{ { "keyPath", "/nope/client.key" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (db_->get_client_certificates ().front ().key_path, key_.path ());
}

/**
 * The update core's read, merge and write are one lock scope (#1440), so two
 * PUTs to one entry naming different fields both land. Merge-patch is what
 * makes an unheld read destructive: the write carries the fields the body never
 * named, so the loser's change is overwritten with a value nobody sent - here
 * either a passphrase that stops matching the key, or a port the entry was
 * narrowed to and silently widens back out of.
 *
 * The second writer runs from inside the first one's scope through the
 * `before_write` seam and is given a window to finish (`competing_writer.hpp`).
 * Mutation check: drop the `with_lock` and the `port` assertion reds.
 */
TEST_F (ClientCertificateDbTest, AConcurrentUpdateWaitsAndKeepsBothFieldsWritten) {
    const auto [created_status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com"));
    ASSERT_EQ (created_status, 200) << created.dump ();
    const std::string id = created["id"];

    int other_status = 0;
    json other_body;
    vayu::tests::CompetingWriter other ([&] {
        auto result = routes::update_client_certificate_response (
        *db_, id, json{ { "port", 8443 } });
        other_status = result.first;
        other_body   = result.second;
    });

    const auto [status, updated] = routes::update_client_certificate_response (
    *db_, id, json{ { "passphrase", "s3cret" } }, other.probe ());
    ASSERT_EQ (status, 200) << updated.dump ();
    other.join ();
    ASSERT_EQ (other_status, 200) << other_body.dump ();

    const auto stored = db_->get_client_certificate (id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->passphrase, "s3cret");
    EXPECT_EQ (stored->port, std::optional<int> (8443))
    << "the port write merged against the row this write had already staged";
}

TEST_F (ClientCertificateDbTest, UpdatingAMissingEntryIs404) {
    const auto [status, error] = routes::update_client_certificate_response (
    *db_, "cert_nope", body ("api.example.com"));
    EXPECT_EQ (status, 404);
    // Never a silent create.
    EXPECT_TRUE (db_->get_client_certificates ().empty ());
}

TEST_F (ClientCertificateDbTest, DeletesAnEntry) {
    const auto [status, created] =
    routes::create_client_certificate_response (*db_, body ("api.example.com"));
    ASSERT_EQ (status, 200) << created.dump ();

    db_->delete_client_certificate (created["id"]);
    EXPECT_TRUE (db_->get_client_certificates ().empty ());
    EXPECT_FALSE (db_->get_client_certificate (created["id"]).has_value ());
}

// ---------------------------------------------------------------------------
// Resolution into the policy
// ---------------------------------------------------------------------------

TEST_F (ClientCertificateDbTest, TheRegistryReachesTheResolvedPolicy) {
    ASSERT_EQ (routes::create_client_certificate_response (*db_, body ("api.example.com", 8443))
               .first,
    200);

    const auto policy = resolve_transport_policy (*db_);
    ASSERT_EQ (policy.client_certificates.size (), 1u);

    const ClientCertRule* matched =
    match_client_certificate (policy, "api.example.com", 8443);
    ASSERT_NE (matched, nullptr);
    EXPECT_EQ (matched->cert_path, cert_.path ());
    EXPECT_EQ (matched->key_path, key_.path ());
}

TEST_F (ClientCertificateDbTest, AStoredWildcardSurvivesTheResolverAndAnswers) {
    // The stored-to-matched path in one test, because the resolver re-runs
    // `client_cert_rejection` on every row it reads (a row hand-edited around
    // the routes is dropped there): a wildcard the route accepted but the
    // resolver refused would be a registry entry that vanished between the card
    // and the wire, which is worse than one refused up front.
    ASSERT_EQ (
    routes::create_client_certificate_response (*db_, body ("*.example.com")).first, 200);

    const auto policy = resolve_transport_policy (*db_);
    ASSERT_EQ (policy.client_certificates.size (), 1u);

    const ClientCertRule* matched =
    match_client_certificate (policy, "api.example.com", 443);
    ASSERT_NE (matched, nullptr);
    EXPECT_EQ (matched->cert_path, cert_.path ());
    // The label a trace and the response pane carry is the pattern itself, so a
    // user reading either learns which registry row answered.
    EXPECT_EQ (client_cert_label (*matched), "*.example.com");
    EXPECT_EQ (match_client_certificate (policy, "example.com", 443), nullptr);
}

TEST_F (ClientCertificateDbTest, ARowWhoseFileWentMissingIsDroppedAndNamed) {
    ASSERT_EQ (
    routes::create_client_certificate_response (*db_, body ("api.example.com")).first, 200);
    ASSERT_EQ (routes::create_client_certificate_response (*db_, body ("other.example.com"))
               .first,
    200);

    // A registered file can go away after the fact - the row keeps a path, not
    // the bytes. The policy must drop that row and keep the rest, rather than
    // handing curl a path it will fail on or refusing to resolve at all.
    {
        vayu::db::ClientCertificate broken = db_->get_client_certificates ().front ();
        broken.cert_path = "/nope/gone.pem";
        db_->save_client_certificate (broken);
    }

    const auto policy = resolve_transport_policy (*db_);
    EXPECT_EQ (policy.client_certificates.size (), 1u);
}

TEST_F (ClientCertificateDbTest, ARowDeclaringAFormatNobodyKnowsIsDroppedNotGuessed) {
    // The route refuses this spelling, so only a hand-edited row reaches the
    // resolver. Dropped rather than defaulted to PEM: presenting the wrong
    // shape is a handshake failure against the endpoint, and which format a
    // file is in is not a thing to guess on the user's behalf.
    ASSERT_EQ (
    routes::create_client_certificate_response (*db_, body ("api.example.com")).first, 200);
    {
        vayu::db::ClientCertificate row = db_->get_client_certificates ().front ();
        row.cert_format = "pkcs12";
        db_->save_client_certificate (row);
    }

    EXPECT_TRUE (resolve_transport_policy (*db_).client_certificates.empty ());

    // And an update of that row answers 400 rather than 200-while-unusable: the
    // merged format is read, not assumed, so the caller is told to name one.
    const std::string id       = db_->get_client_certificates ().front ().id;
    const auto [status, error] = routes::update_client_certificate_response (
    *db_, id, json{ { "host", "moved.example.com" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (
    error["error"]["message"].get<std::string> ().find ("certFormat"), std::string::npos)
    << error.dump ();
}

TEST_F (ClientCertificateDbTest, TheStoredFormatReachesTheRuleTheApplierReads) {
    // "Written but never read" is the defect this asserts against: a format
    // stored on the row and dropped on the way to `ClientCertRule` would leave
    // the applier writing PEM for every entry, exactly as before #833.
    ScratchFile bundle{ "resolved_bundle.p12", std::string (DER_SHAPED) };
    ASSERT_EQ (routes::create_client_certificate_response (*db_,
               json{ { "host", "bundle.example.com" },
               { "certPath", bundle.path () }, { "certFormat", "p12" } })
               .first,
    200);
    ASSERT_EQ (
    routes::create_client_certificate_response (*db_, body ("pem.example.com")).first, 200);

    const auto policy = resolve_transport_policy (*db_);
    const ClientCertRule* bundle_rule =
    match_client_certificate (policy, "bundle.example.com", 443);
    ASSERT_NE (bundle_rule, nullptr);
    EXPECT_EQ (bundle_rule->format, ClientCertFormat::Pkcs12);
    EXPECT_TRUE (bundle_rule->key_path.empty ())
    << "a bundle row carried a key path into the policy, which the applier "
       "would hand libcurl as CURLOPT_SSLKEY";

    const ClientCertRule* pem_rule =
    match_client_certificate (policy, "pem.example.com", 443);
    ASSERT_NE (pem_rule, nullptr);
    EXPECT_EQ (pem_rule->format, ClientCertFormat::Pem);
    EXPECT_EQ (pem_rule->key_path, key_.path ());
}

// ---------------------------------------------------------------------------
// Every driver applies the match
// ---------------------------------------------------------------------------

TEST (ClientCertificatePaths, ADesignSendRecordsTheEntryItMatched) {
    MockUpstream upstream;
    ScratchFile cert{ "paths_cert.pem" };
    ScratchFile key{ "paths_key.pem" };

    ClientConfig config;
    config.transport.client_certificates.push_back (
    rule ("cert_1", "127.0.0.1", upstream.port, cert.path (), key.path ()));
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    // The response carries which entry was used, which is what both funnels
    // print and the only way "why here and not there" is answerable after the
    // fact. Remove the applier's lookup and this is empty.
    EXPECT_EQ (result.value ().client_certificate,
    "127.0.0.1:" + std::to_string (upstream.port));
}

TEST (ClientCertificatePaths, ADesignSendToAnUnregisteredHostRecordsNothing) {
    MockUpstream upstream;
    ScratchFile cert{ "paths_cert2.pem" };
    ScratchFile key{ "paths_key2.pem" };

    ClientConfig config;
    config.transport.client_certificates.push_back (rule (
    "cert_1", "elsewhere.example.com", std::nullopt, cert.path (), key.path ()));
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_TRUE (result.value ().client_certificate.empty ());
}

TEST (ClientCertificatePaths, AnSseStreamRecordsTheEntryItMatched) {
    // The path that had no proxy option at all before #705, and would have been
    // the one to miss certificates too if each driver configured its own
    // transport. It reaches them through the same applier.
    MockUpstream upstream;
    ScratchFile cert{ "paths_cert3.pem" };
    ScratchFile key{ "paths_key3.pem" };

    SseStreamRequest spec;
    spec.run_id  = "run-cert-sse";
    spec.request = get_request (upstream.url ("/events"));
    spec.transport.client_certificates.push_back (
    rule ("cert_1", "127.0.0.1", std::nullopt, cert.path (), key.path ()));

    SseStreamContext context (spec.run_id, spec.limits);
    const auto response = consume_sse_stream (spec, context);

    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (response.client_certificate, "127.0.0.1");
}

TEST (ClientCertificatePaths, ALoadRunCarriesTheRegistryAndStillTransfers) {
    // The load path resolves the policy once at run start (#704 decision 3), so
    // what it holds is this snapshot and the per-transfer work is the in-memory
    // match. The transfer itself is asserted because the applier now writes
    // three more options on every handle in the pool, empty included, and a
    // mistake there would break every load run rather than only an mTLS one.
    MockUpstream upstream;
    ScratchFile cert{ "paths_cert4.pem" };
    ScratchFile key{ "paths_key4.pem" };

    EventLoopConfig config;
    config.transport.client_certificates.push_back (
    rule ("cert_1", "127.0.0.1", std::nullopt, cert.path (), key.path ()));
    ASSERT_NE (match_client_certificate (config.transport, "127.0.0.1", upstream.port), nullptr);

    EventLoop loop (config);
    loop.start ();
    std::vector<Request> requests;
    requests.reserve (3);
    for (int i = 0; i < 3; ++i) {
        requests.push_back (get_request (upstream.url ("/hello")));
    }
    const auto batch = loop.execute_batch (requests);
    loop.stop ();

    EXPECT_EQ (batch.successful, 3u);
}

TEST (ClientCertificateBackend, TakesTheCertificateOptionsOnThisPlatform) {
    // The per-platform claim, checked on the platform rather than reasoned
    // about - the shape `TlsBackend.AcceptsACustomCaBundleOnThisPlatform` set.
    // Since #851 the three CI legs build against the same TLS backend, which
    // is a reason to keep this and not to drop it: the claim is now that a
    // *pin* holds on three platforms, and a leg whose port resolved elsewhere
    // is exactly what would refuse one of these options - leaving every mTLS
    // request going out with no certificate and nothing anywhere saying so.
    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    const char* backend =
    info != nullptr && info->ssl_version != nullptr ? info->ssl_version : "unknown";

    EXPECT_EQ (set_opt<CURLOPT_SSLCERT> (curl, "/certs/client.pem"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_SSLCERT";
    EXPECT_EQ (set_opt<CURLOPT_SSLKEY> (curl, "/certs/client.key"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_SSLKEY";
    EXPECT_EQ (set_opt<CURLOPT_KEYPASSWD> (curl, "secret"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_KEYPASSWD";
    // Both types, on every leg: the option is how a stored format reaches
    // libcurl at all (#833), and a backend that refused one of them would leave
    // entries in that format going out as something else, or not at all.
    for (const auto format : all_client_cert_formats ()) {
        EXPECT_EQ (set_opt<CURLOPT_SSLCERTTYPE> (curl, curl_ssl_cert_type (format)), CURLE_OK)
        << "TLS backend '" << backend << "' refuses CURLOPT_SSLCERTTYPE '"
        << curl_ssl_cert_type (format) << "'";
    }
    curl_easy_cleanup (curl);
}

} // namespace
} // namespace vayu::http
