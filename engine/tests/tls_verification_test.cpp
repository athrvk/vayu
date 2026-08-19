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
 * These run on all three CI platforms deliberately: the trust decision is made
 * by a different backend on each (OpenSSL where curl is built against it,
 * Schannel on Windows), and a claim about trust that holds on one is not a
 * claim about the others. That is not a formality - the backends answered
 * differently the first time this ran. A backend that revocation-checks the
 * chain refuses a CA minted for this run, because a CA minted for this run
 * publishes no CRL, and the *positive* cases below therefore skip there rather
 * than assert. The skip is narrow and loud: it fires only when the backend's
 * own error text names revocation, prints that text, and is tracked by #819;
 * every other refusal, on every platform, still fails. The negative cases have
 * no such carve-out and are asserted everywhere.
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

/**
 * @brief Whether the backend refused for want of *revocation* information
 *        rather than for want of trust.
 *
 * The two are different verdicts and only one of them is about this engine.
 * A backend that asks the operating system to revocation-check the chain
 * cannot be satisfied by a certificate authority minted seconds ago: it
 * publishes no CRL, so the answer comes back "unknown" and the chain is
 * refused even though the anchor was loaded and the signature is good. That is
 * what curl's Schannel path does - `Curl_verify_certificate` passes
 * `CERT_CHAIN_REVOCATION_CHECK_CHAIN` unless `CURLSSLOPT_NO_REVOKE` is set,
 * and treats `CERT_TRUST_REVOCATION_STATUS_UNKNOWN` as a failure unless
 * `CURLSSLOPT_REVOKE_BEST_EFFORT` is (`lib/vtls/schannel_verify.c`) - so the
 * *positive* half of this suite cannot be hosted on such a backend until the
 * fixture serves a CRL, which is #819.
 *
 * Matched on the backend's own words rather than on `_WIN32`, deliberately.
 * The property that matters is "this backend demands revocation information",
 * not "this is Windows", and a test that asserts the host platform is exactly
 * what `CLAUDE.md` forbids - it would keep skipping on Windows if the reason
 * changed, and keep failing elsewhere if the reason spread.
 */
bool refused_for_want_of_revocation (const Response& response) {
    return response.error_code == ErrorCode::SslError &&
    response.error_message.find ("revocation") != std::string::npos;
}

/// What such a skip says. Loudly, in the backend's own words: a guard that
/// quietly does nothing on one platform is worse than no guard, so this has to
/// read as "not answered here, and here is why" rather than as a pass.
std::string revocation_skip_reason (const Response& response) {
    return "this TLS backend revocation-checks the chain, which a CA minted for"
           " this run cannot answer for - the anchor is not the thing it"
           " refused. Tracked by #819. The backend said: " +
    response.error_message;
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

TEST_F (CustomCaVerificationTest, AHostSignedByTheAddedCaVerifies) {
    TestCertificateAuthority ca;
    TlsServer server (ca);

    set_custom_ca (ca.pem ());
    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ())
    << "the paste was never materialized, so nothing about trust is being "
       "tested";

    const Response response = send_through (policy, server.url ("/hello"));
    if (refused_for_want_of_revocation (response)) {
        GTEST_SKIP () << revocation_skip_reason (response);
    }
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
    if (refused_for_want_of_revocation (response)) {
        GTEST_SKIP () << revocation_skip_reason (response);
    }
    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "a second anchor cost the first its trust: " << to_string (response.error_code)
    << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
}

} // namespace
} // namespace vayu::http
