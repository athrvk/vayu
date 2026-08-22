/**
 * @file tests/tls_verification_test.cpp
 * @brief Custom-CA verification on a wire (issue #812).
 *
 * `TransportPolicyDbTest` in `transport_policy_test.cpp` proves the
 * `customCaCertificates` setting is read, merged with the platform's anchors
 * and materialized into a file, and
 * `TlsBackend.AcceptsACustomCaBundleOnThisPlatform` proves this build's backend
 * does not refuse `CURLOPT_CAINFO` outright. What neither of them touches is
 * the claim a user actually cares about: that a host signed by a CA they pasted
 * in **verifies**, and that it does not verify before they paste it.
 *
 * That is a handshake, so these tests hold one. Each stands up an HTTPS
 * listener whose certificate a per-run CA signed (`tls_server.hpp`) and drives
 * the ordinary design-send path at it, changing only the setting.
 *
 * **Why the wrong-CA case is not optional.** A bundle that curl reads and
 * ignores would pass the happy path on any machine whose system store happens
 * to be permissive, and the whole feature would look tested. Verifying against
 * a CA that signed nothing here is what separates "the setting works" from
 * "the request succeeded" - so the suite asserts a success, a failure without
 * the setting, and a failure with the *wrong* setting.
 *
 * All four run on all three CI platforms, and getting there took two rounds.
 * The trust decision used to be made by a different backend on each (OpenSSL
 * where curl was built against it, Schannel on Windows), and a claim about
 * trust that holds on one is not a claim about the others - which was not a
 * formality, because the backends answered differently the first time this ran.
 * #851 pins one backend on all three, which removes the divergence rather than
 * the reason these run everywhere: the pin itself is what is now being checked
 * per leg. A backend that
 * revocation-checks the chain refused a CA minted for this run, since a CA
 * minted for this run published no CRL, and the two *positive* cases skipped
 * there rather than assert.
 *
 * **The fixture publishes one now** (#819): the CA signs an empty CRL, a
 * plain-HTTP listener serves it, and the leaf names that listener as its
 * distribution point. The skip that stood here, and the two helpers behind it,
 * are gone - on the observation rather than on the theory, since the leg that
 * skipped went to 2056 run, 2056 passed, 0 skipped (job 95970419762). A refusal
 * naming revocation is now an ordinary failure on every platform, which is what
 * it should be: the fixture answers that question, so a backend still asking it
 * is telling us something.
 *
 * `TheFixtureServesACaSignedCrlAtTheLeafsDistributionPoint` is what keeps this
 * honest on the backends that never ask, and after #851 that is every leg -
 * OpenSSL does not revocation-check the chain on its own. Without it the whole
 * CRL apparatus could rot - unparseable bytes, a wrong signer, a stale window -
 * with nothing anywhere saying so, and the day someone reaches for a backend
 * that does ask, it would go red for a reason pointing at trust rather than at
 * the fixture.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <system_error>

#include "temp_database.hpp"
#include "tls_server.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/transport_policy.hpp"

namespace vayu::http {
namespace {

using vayu::tests::TestCertificateAuthority;
using vayu::tests::TlsServer;

Request get_request (const std::string& url) {
    Request request;
    request.method = HttpMethod::GET;
    request.url    = url;
    return request;
}

/**
 * A design send with exactly the transport the settings resolved to - the same
 * path `POST /execute` takes, which is the point: the assertion is about the
 * shipped applier, not about a handle assembled here.
 *
 * A refused handshake is a `Response` carrying `error_code`, not a
 * `Result` error: `Client::send` reserves the error arm for a request it could
 * not even attempt, so a transport failure arrives with a status of 0 and a
 * code - the same shape the proxy tests read, and the same shape a stored
 * trace holds.
 */
Response send_through (const TransportPolicy& transport, const std::string& url) {
    ClientConfig config;
    config.transport = transport;
    Client client (config);
    auto result = client.send (get_request (url));
    EXPECT_TRUE (result.is_ok ())
    << "the send was never attempted: " << result.error ().message;
    return result.is_ok () ? result.value () : Response{};
}

class CustomCaVerificationTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (path_);
        db_ = std::make_unique<vayu::db::Database> (path_);
        db_->seed_default_config ();
        // The default `proxyMode` is `environment`, and a machine that exports
        // `https_proxy` - a corporate laptop, a sandboxed CI runner - would
        // send this handshake to a proxy instead of to the fixture on
        // loopback. The setting under test here is the trust store, so the
        // proxy is pinned off rather than left to the runner: an assertion
        // that passes or fails on an environment variable is not an assertion
        // about this engine.
        set_config ("proxyMode", "off");
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (path_);
        // The materialized bundle is written beside the database and is not
        // one of the database's own files, so it outlives the scratch set
        // unless it is named here.
        std::error_code ec;
        std::filesystem::remove ("ca-bundle.pem", ec);
    }

    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key << " is not seeded";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    void set_custom_ca (const std::string& pem) {
        set_config ("customCaCertificates", pem);
    }

    std::string path_ = "test_tls_verification.db";
    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------

TEST_F (CustomCaVerificationTest, TheFixtureServesACaSignedCrlAtTheLeafsDistributionPoint) {
    // The guard for everything the revocation half of this fixture rests on,
    // asserted where every backend can see it. A backend that revocation-checks
    // the chain fetches this document and refuses the handshake if it is not
    // there, not this CA's, or not current - and the backends that do not ask
    // would report none of that.
    TestCertificateAuthority ca;
    TlsServer server (ca);

    const std::string distribution_point = server.crl_distribution_point_text ();
    ASSERT_FALSE (distribution_point.empty ())
    << "the certificate the listener presents carries no crlDistributionPoints "
       "extension, so no backend will ever fetch the CRL below";
    EXPECT_NE (distribution_point.find (server.crl_url ()), std::string::npos)
    << "the leaf points somewhere other than where the CRL is served: " << distribution_point
    << " vs " << server.crl_url ();

    const auto policy       = resolve_transport_policy (*db_);
    const Response response = send_through (policy, server.crl_url ());
    ASSERT_EQ (response.status_code, 200)
    << "the distribution point answered " << response.status_code << ": "
    << to_string (response.error_code) << ": " << response.error_message;

    EXPECT_EQ (ca.crl_defect (response.body), "")
    << "what the distribution point served is not a CRL this CA vouches for, "
       "so a revocation-checking backend is no better off than before #819";
}

TEST_F (CustomCaVerificationTest, AHostSignedByTheAddedCaVerifies) {
    TestCertificateAuthority ca;
    TlsServer server (ca);

    set_custom_ca (ca.pem ());
    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ())
    << "the paste was never materialized, so nothing about trust is being "
       "tested";

    const Response response = send_through (policy, server.url ("/hello"));
    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "verification failed with the CA added: " << to_string (response.error_code)
    << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_NE (response.body.find ("over"), std::string::npos);
}

TEST_F (CustomCaVerificationTest, TheSameHostDoesNotVerifyWithoutIt) {
    // The other half of the claim, and the one that makes the test above mean
    // something: the endpoint is reachable either way, so a 200 there is the
    // setting's doing rather than a permissive default.
    TestCertificateAuthority ca;
    TlsServer server (ca);

    const auto policy = resolve_transport_policy (*db_);
    ASSERT_TRUE (policy.ca_bundle_path.empty ()) << "no certificate was pasted";

    const Response response = send_through (policy, server.url ("/hello"));
    EXPECT_EQ (response.status_code, 0)
    << "an untrusted certificate was accepted";
    EXPECT_EQ (response.error_code, ErrorCode::SslError)
    << "a verification refusal must read as a TLS error, not as an unreachable "
       "endpoint: "
    << to_string (response.error_code) << ": " << response.error_message;
}

TEST_F (CustomCaVerificationTest, ACaThatSignedNothingHereDoesNotVerify) {
    // A bundle libcurl reads and ignores would pass the happy path. This is
    // the case that fails if the anchors are not actually consulted.
    TestCertificateAuthority ca;
    TlsServer server (ca);
    const TestCertificateAuthority unrelated ("Vayu Test CA (unrelated)");

    set_custom_ca (unrelated.pem ());
    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ());

    const Response response = send_through (policy, server.url ("/hello"));
    EXPECT_EQ (response.status_code, 0)
    << "a certificate from an unrelated CA was accepted";
    EXPECT_EQ (response.error_code, ErrorCode::SslError)
    << to_string (response.error_code) << ": " << response.error_message;
}

TEST_F (CustomCaVerificationTest, TheAddedCaExtendsTheStoreRatherThanReplacingIt) {
    // The additive claim of #704 decision 4, asserted on a handshake rather
    // than by reading the file: a *second* CA pasted alongside the first must
    // not cost the first its trust. Verification succeeding after the paste
    // grew is the only observation that distinguishes appending from
    // overwriting at the point where it matters.
    TestCertificateAuthority ca;
    TlsServer server (ca);
    const TestCertificateAuthority other ("Vayu Test CA (also trusted)");

    set_custom_ca (other.pem () + ca.pem ());
    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ());

    const Response response = send_through (policy, server.url ("/hello"));
    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "a second anchor cost the first its trust: " << to_string (response.error_code)
    << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
}

// ---------------------------------------------------------------------------
// The anchors nobody pasted (issue #851)
// ---------------------------------------------------------------------------

/**
 * The trust a user has before they configure anything.
 *
 * Every case above changes `customCaCertificates` and reads the result, so all
 * of them would stay green on a build whose *default* store is empty - the
 * paste is the only anchor any of them needs. That gap was free to leave while
 * Windows ran on Schannel, because an OS-store backend cannot have an empty
 * default. #851 makes Windows an OpenSSL build, where `CURLOPT_CAINFO` is the
 * whole store and `curl_version_info()->cainfo` names a path from the machine
 * the port was built on - so the default store there is whatever
 * `CURLSSLOPT_NATIVE_CA` loads, and if the applier stopped setting it the
 * platform would trust nothing at all with every one of those four cases still
 * passing.
 *
 * Same fixture, opposite direction: nothing is pasted, and the handshake has to
 * succeed anyway.
 */
class NativeStoreVerificationTest : public CustomCaVerificationTest {};

TEST_F (NativeStoreVerificationTest, APublicCertificateVerifiesWithNothingPasted) {
    // The one place in this suite that needs a certificate the *platform*
    // vouches for, which no fixture can mint - so it is the one place that
    // leaves the loopback interface. `example.com` is IANA's reserved
    // documentation domain, held for exactly this and serving a certificate
    // from an ordinary public authority.
    static constexpr const char* PUBLIC_HTTPS_URL = "https://example.com/";

    const auto policy = resolve_transport_policy (*db_);
    ASSERT_TRUE (policy.ca_bundle_path.empty ())
    << "something was pasted, so this would pass on the paste rather than on "
       "the platform's own anchors";

    const Response response = send_through (policy, PUBLIC_HTTPS_URL);

    // A runner with no route to the public internet is a fact about the
    // runner. A refused *handshake* is the failure this test exists to catch,
    // so the two are separated rather than folded into "it did not work":
    // skipping on an SslError would hide precisely the narrowing #851 could
    // cause, and failing on a closed network would red every offline build.
    if (response.error_code == ErrorCode::ConnectionFailed ||
    response.error_code == ErrorCode::DnsError || response.error_code == ErrorCode::Timeout) {
        GTEST_SKIP ()
        << "no route to " << PUBLIC_HTTPS_URL << " ("
        << to_string (response.error_code) << ": " << response.error_message
        << ") - this asserts about the platform's trust store and "
           "needs a public host to assert against";
    }

    EXPECT_NE (response.error_code, ErrorCode::SslError)
    << "a public certificate did not verify with an empty "
       "`customCaCertificates`, "
       "so this build's default trust store is not the platform's: "
    << response.error_message;
    EXPECT_EQ (response.error_code, ErrorCode::None)
    << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
}

TEST_F (NativeStoreVerificationTest, APasteExtendsThatStoreRatherThanReplacingIt) {
    // The additive rule (#706) read on the branch the four cases above cannot
    // reach: with a paste in force, the anchors that were there beforehand must
    // still be. On the platforms that keep them in a file
    // `materialize_ca_bundle` merges it, and on Windows - which ships no such
    // file - `CURLSSLOPT_NATIVE_CA` keeps the store applying beside the bundle.
    // Two mechanisms, one promise, and this is the promise rather than either
    // mechanism: paste a CA that signed nothing here, and the public host that
    // verified above must go on verifying.
    static constexpr const char* PUBLIC_HTTPS_URL = "https://example.com/";

    const TestCertificateAuthority unrelated ("Vayu Test CA (unrelated)");
    set_custom_ca (unrelated.pem ());
    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ());

    const Response response = send_through (policy, PUBLIC_HTTPS_URL);

    if (response.error_code == ErrorCode::ConnectionFailed ||
    response.error_code == ErrorCode::DnsError || response.error_code == ErrorCode::Timeout) {
        GTEST_SKIP () << "no route to " << PUBLIC_HTTPS_URL << " ("
                      << to_string (response.error_code) << ": "
                      << response.error_message << ")";
    }

    EXPECT_NE (response.error_code, ErrorCode::SslError)
    << "pasting one CA cost this machine every anchor it already had - the "
       "additive rule is broken on this platform: "
    << response.error_message;
    EXPECT_EQ (response.status_code, 200);
}

} // namespace
} // namespace vayu::http
