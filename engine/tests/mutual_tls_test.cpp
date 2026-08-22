/**
 * @file tests/mutual_tls_test.cpp
 * @brief A registered client certificate on a wire (issue #802).
 *
 * `client_certificates_test.cpp` proves the registry: what a row may say, which
 * row a target picks, and that the pick reaches every driver. All of that is
 * true of paths that hold no certificate at all - the files there are the bytes
 * `not-a-real-certificate`, because nothing in that suite puts one on a wire.
 * What it cannot answer is the claim #707 was opened for: that the bytes
 * libcurl loads from those paths are **accepted by a server demanding a client
 * certificate**.
 *
 * That is a handshake, so these tests hold one. `TlsServer` built with a second
 * CA demands a certificate that authority signed (`tls_server.hpp`), and each
 * case drives a shipped driver at it through a policy resolved from a real
 * registry row - `POST /client-certificates` writes the row, the transport
 * policy reads it back, and nothing here assembles a curl handle of its own.
 *
 * **Why the refusals are not optional.** A listener that asked for a
 * certificate and accepted the handshake anyway would make every success below
 * meaningless, so the suite asserts a failure with no entry registered, and a
 * failure with an entry whose identity a *different* CA signed. The second is
 * what separates "a certificate was presented" from "this certificate was
 * accepted".
 *
 * ## The per-backend format matrix
 *
 * A client identity does not travel in one shape, and since #833 the row says
 * which one it is in - so every case here runs **once per format this build can
 * present**, rather than once in the only format the engine could write:
 *
 * | Backend | This build | A client identity may arrive as |
 * |---|---|---|
 * | OpenSSL (Linux, macOS, Windows) | yes | a PEM certificate + PEM key, or PKCS#12 |
 * | Schannel | no, since #851 | PKCS#12 (or a certificate-store reference) |
 *
 * That set comes from `client_identity_formats()`, so no leg asserts a shape
 * its backend cannot load. A backend nothing here classifies presents an empty
 * set, which `ThisBuildCanPresentAClientIdentityAtAll` fails on rather than
 * letting the suite quietly instantiate nothing.
 *
 * **Every leg runs every case now** (#851). Windows used to skip the wire half
 * through `client_auth_defect()`: curl 8.21's Schannel client-certificate path
 * imports the bundle with `PKCS12_NO_PERSIST_KEY` and cannot then use the key,
 * which curl's own `KNOWN_BUGS` documents (curl 17626, 3145) and which measured
 * here as a failure at the second `InitializeSecurityContext` with a legacy-PBE
 * and a PBES2 bundle alike (#842). #851 routes around it by building Windows
 * against OpenSSL, so the defect is out of the build rather than skipped around
 * and both formats run on all three legs. A return to Schannel would bring the
 * skip back with it - closed #842 is the record of what it cost.
 *
 * A certificate-store reference is Schannel's other shape and is out of scope
 * (#833): the registry stores file paths, and a store expression is not a file.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "tls_backend.hpp"
#include "tls_server.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/runtime/script_engine.hpp"

namespace vayu::http::routes {
// Defined in client_certificates.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_client_certificate_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace vayu::http {
namespace {

using nlohmann::json;
using vayu::tests::CertificateAndKey;
using vayu::tests::ClientIdentityFormat;
using vayu::tests::TestCertificateAuthority;
using vayu::tests::TlsServer;
namespace routes = vayu::http::routes;

// ---------------------------------------------------------------------------
// Fixture material
// ---------------------------------------------------------------------------

/**
 * A file on disk, removed when the test ends.
 *
 * The registry stores **paths** and libcurl opens them itself, so a client
 * identity is the one piece of material here that cannot stay in memory the
 * way the listener's does. It lands in the per-process scratch directory
 * (`temp_database.hpp`), lives for one test, and is named after it. Binary,
 * because a PKCS#12 bundle is DER and a text-mode write would corrupt it on
 * the one platform that cannot use anything else.
 */
class IdentityFile {
    public:
    IdentityFile (std::string name, const std::string& contents)
    : path_ (std::move (name)) {
        std::ofstream out (path_, std::ios::binary | std::ios::trunc);
        out.write (contents.data (), static_cast<std::streamsize> (contents.size ()));
        out.close ();
        if (!out) {
            throw std::runtime_error ("mutual_tls_test: could not write " + path_);
        }
    }
    ~IdentityFile () {
        if (path_.empty ()) {
            return; // Moved from: the file belongs to whoever took it.
        }
        std::error_code ec;
        std::filesystem::remove (path_, ec);
    }
    IdentityFile (IdentityFile&& other) noexcept
    : path_ (std::move (other.path_)) {
        other.path_.clear ();
    }
    IdentityFile (const IdentityFile&)            = delete;
    IdentityFile& operator= (const IdentityFile&) = delete;
    IdentityFile& operator= (IdentityFile&&)      = delete;

    const std::string& path () const {
        return path_;
    }

    private:
    std::string path_;
};

/**
 * A client identity as the registry wants it, in one format or the other: a
 * certificate file, and a key file only where the format keeps the key in one.
 *
 * The `key` being *absent* rather than empty is the shape under test as much as
 * the bytes are - a PKCS#12 row names no key path at all, and a fixture that
 * passed an empty string would be registering something the route refuses.
 */
struct ClientIdentity {
    IdentityFile certificate;
    std::optional<IdentityFile> key;

    /// What the registry stores for the key, which is nothing for a bundle.
    std::string key_path () const {
        return key ? key->path () : std::string{};
    }
};

Request get_request (const std::string& url) {
    Request request;
    request.method = HttpMethod::GET;
    request.url    = url;
    return request;
}

/**
 * A design send with exactly the transport the settings resolved to - the same
 * path `POST /execute` takes.
 *
 * A refused handshake is a `Response` carrying `error_code`, not a `Result`
 * error: `Client::send` reserves the error arm for a request it could not even
 * attempt. Same shape `tls_verification_test.cpp` reads.
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
 * Every case, once per format this build can present (#833).
 *
 * Parameterized rather than skipped: the formats a backend takes are a set, so
 * "which cases run here" is a property of the build and not a leg being dark.
 * A case that does not read the parameter - the refusal with no entry
 * registered - still runs once per format, because it shares this fixture and a
 * second fixture for one test would cost more than the handshake does.
 */
class MutualTlsTest : public ::testing::TestWithParam<ClientIdentityFormat> {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (path_);
        db_ = std::make_unique<vayu::db::Database> (path_);
        db_->seed_default_config ();
        // The listener's own certificate is signed by a CA no store knows, so
        // the client half of the exchange needs it pasted in - otherwise every
        // case below would fail on *server* verification and say nothing about
        // the client certificate it was written for.
        set_config ("customCaCertificates", ca_.pem ());
        // The default `proxyMode` is `environment`: a runner exporting
        // `https_proxy` would send this handshake to a proxy instead of to the
        // fixture on loopback, and an assertion that turns on an environment
        // variable is not an assertion about this engine.
        set_config ("proxyMode", "off");
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (path_);
        // The materialized bundle is written beside the database and is not one
        // of the database's own files.
        std::error_code ec;
        std::filesystem::remove ("ca-bundle.pem", ec);
    }

    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key << " is not seeded";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    /// The format this instance is exercising, and the `certFormat` a row
    /// registered here declares.
    ClientIdentityFormat format () const {
        return GetParam ();
    }

    /**
     * An identity @p issuer signed, in this instance's format, written where
     * the registry can name it. @p passphrase protects the key when it is not
     * empty - the PEM key by encryption, the bundle by its import password,
     * which is the same `passphrase` column either way.
     */
    ClientIdentity identity (const std::string& name,
    const TestCertificateAuthority& issuer,
    const std::string& passphrase = {}) {
        const CertificateAndKey minted =
        issuer.issue ("vayu-test-client", "DNS:vayu-test-client");
        if (format () == ClientIdentityFormat::Pkcs12) {
            return ClientIdentity{ IdentityFile{ name + "_identity.p12",
                                   minted.pkcs12 (passphrase) },
                std::nullopt };
        }
        return ClientIdentity{ IdentityFile{ name + "_cert.pem", minted.pem () },
            IdentityFile{ name + "_key.pem",
            passphrase.empty () ? minted.key_pem () : minted.encrypted_key_pem (passphrase) } };
    }

    /// Register an entry the way the app does, through the route - so the row
    /// under test is one the shipped validation accepted, `certFormat` and the
    /// key path it does or does not carry included.
    void register_entry (const ClientIdentity& id,
    std::optional<int> port       = std::nullopt,
    const std::string& passphrase = {}) {
        json payload = { { "host", "127.0.0.1" }, { "certPath", id.certificate.path () },
            { "certFormat", vayu::tests::client_identity_format_name (format ()) } };
        if (!id.key_path ().empty ()) {
            payload["keyPath"] = id.key_path ();
        }
        if (port) {
            payload["port"] = *port;
        }
        if (!passphrase.empty ()) {
            payload["passphrase"] = passphrase;
        }
        const auto [status, created] =
        routes::create_client_certificate_response (*db_, payload);
        ASSERT_EQ (status, 200) << created.dump ();
    }

    TransportPolicy policy () {
        TransportPolicy resolved = resolve_transport_policy (*db_);
        EXPECT_FALSE (resolved.ca_bundle_path.empty ())
        << "the fixture CA was never materialized, so the listener's own "
           "certificate would be refused before any client certificate is read";
        return resolved;
    }

    /// Signs both the listener's certificate and the client identities it
    /// accepts. One authority for both ends keeps the setup readable; the
    /// identities that must be *refused* come from `stranger_`.
    TestCertificateAuthority ca_{ "Vayu Test CA (mTLS)" };
    TestCertificateAuthority stranger_{ "Vayu Test CA (unrelated)" };
    std::string path_ = "test_mutual_tls.db";
    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// The fixture's own guards
// ---------------------------------------------------------------------------

TEST (MutualTlsBackend, ClassifiesTheBackendsThisRepoCanBeBuiltAgainst) {
    // Runs everywhere, not only where each answer is taken: a classifier that
    // returned both formats for everything would be green on Linux and macOS
    // and would only be caught by the Windows leg - the rule that a
    // per-platform branch must not be asserted only where it happens to apply.
    EXPECT_EQ (vayu::tests::client_identity_formats ("OpenSSL/3.6.3"),
    (std::vector<ClientIdentityFormat>{
    ClientIdentityFormat::PemPair, ClientIdentityFormat::Pkcs12 }));
    EXPECT_EQ (vayu::tests::client_identity_formats ("Schannel"),
    (std::vector<ClientIdentityFormat>{ ClientIdentityFormat::Pkcs12 }));
    // A PEM pair is the shape Schannel takes *no* file in, which is the whole
    // reason the format is stored - assert the absence, not just the presence.
    EXPECT_TRUE (vayu::tests::client_identity_formats ("GnuTLS/3.8.4").empty ());
    EXPECT_TRUE (vayu::tests::client_identity_formats ("").empty ());
}

TEST (MutualTlsBackend, ThisBuildCanPresentAClientIdentityAtAll) {
    // The instantiation below draws its parameters from this list, so an empty
    // one would silently generate no tests - a leg reporting nothing, which is
    // exactly the darkness #833 removed. Failing here names the backend
    // instead.
    EXPECT_FALSE (vayu::tests::client_identity_formats ().empty ())
    << "TLS backend '" << vayu::tests::tls_backend_name ()
    << "' is one no statement in this repo covers, so what a client identity "
       "must look like for it is unknown - decide and record it rather than "
       "letting this fixture guess";
}

TEST (MutualTlsErrorMapping, AnUnreachableHttpsEndpointIsStillAConnectionFailure) {
    // The other half of the rule the refusals below rest on. `curl_to_error`
    // reads an https transfer that produced no response line as a TLS failure
    // *only* where the mapping has no answer of its own - so a port nothing
    // listens on, which fails before any TLS happens and has an answer, must
    // keep it. Widen the rule to "any https failure" and this test is what
    // says so. It runs on every platform, including the ones the fixture below
    // skips: the mapping is not backend-specific.
    TransportPolicy transport;
    transport.proxy_mode = ProxyMode::Off;

    const Response response = send_through (transport, "https://127.0.0.1:1/hello");

    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, ErrorCode::ConnectionFailed)
    << "an endpoint that could not be reached now reads as a TLS failure: "
    << to_string (response.error_code) << ": " << response.error_message;
}

TEST_P (MutualTlsTest, TheListenerRefusesAClientWithNoCertificate) {
    // Without this, every success below would prove nothing: a listener that
    // asked for a certificate and shrugged when none came would answer 200 to
    // an engine that presented nothing at all.
    TlsServer server (ca_, ca_);

    const TransportPolicy resolved = policy ();
    ASSERT_TRUE (resolved.client_certificates.empty ())
    << "no entry was registered";
    const Response response = send_through (resolved, server.url ("/hello"));

    EXPECT_EQ (response.status_code, 0)
    << "the listener answered a client that presented no certificate";
    EXPECT_EQ (response.error_code, ErrorCode::SslError)
    << "a handshake the server refused must read as a TLS error rather than as "
       "an unreachable endpoint: "
    << to_string (response.error_code) << ": " << response.error_message;
}

TEST_P (MutualTlsTest, AnIdentityFromAnotherAuthorityIsRefused) {
    // The case that tells "a certificate was presented" apart from "this
    // certificate was accepted". The identity is well-formed and loads
    // cleanly; only its issuer is wrong.
    TlsServer server (ca_, ca_);
    const ClientIdentity stranger = identity ("stranger", stranger_);
    register_entry (stranger);

    const Response response = send_through (policy (), server.url ("/hello"));

    EXPECT_EQ (response.status_code, 0)
    << "an identity signed by an authority the listener does not trust was "
       "accepted";
    EXPECT_EQ (response.error_code, ErrorCode::SslError)
    << to_string (response.error_code) << ": " << response.error_message;
}

// ---------------------------------------------------------------------------
// The drivers
// ---------------------------------------------------------------------------

TEST_P (MutualTlsTest, ADesignSendCompletesTheHandshakeAndNamesTheEntry) {
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("design", ca_);
    register_entry (client);

    const Response response = send_through (policy (), server.url ("/hello"));

    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "the registered certificate did not complete the handshake: "
    << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_NE (response.body.find ("over"), std::string::npos);
    // The same field the design funnels print, now on an exchange that could
    // not have happened without the entry it names.
    EXPECT_EQ (response.client_certificate, "127.0.0.1");
}

TEST_P (MutualTlsTest, AnSseStreamPresentsTheCertificate) {
    // The driver that had no proxy option at all before #705, and would have
    // been the one to miss certificates too if each driver configured its own
    // transport.
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("sse", ca_);
    register_entry (client);

    SseStreamRequest spec;
    spec.run_id    = "run-mtls-sse";
    spec.request   = get_request (server.url ("/events"));
    spec.transport = policy ();

    SseStreamContext context (spec.run_id, spec.limits);
    const Response response = consume_sse_stream (spec, context);

    ASSERT_EQ (response.error_code, ErrorCode::None)
    << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (response.client_certificate, "127.0.0.1");
}

TEST_P (MutualTlsTest, ALoadRunPresentsTheCertificate) {
    // The load path resolves the policy once at run start and matches per
    // transfer from that snapshot, and its handles are pooled - so this also
    // says a reused handle keeps presenting the identity.
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("load", ca_);
    register_entry (client);

    EventLoopConfig config;
    config.transport = policy ();
    EventLoop loop (config);
    loop.start ();
    std::vector<Request> requests;
    for (int i = 0; i < 3; ++i) {
        requests.push_back (get_request (server.url ("/hello")));
    }
    const auto batch = loop.execute_batch (requests);
    loop.stop ();

    // The counters alone prove nothing about TLS, and this test believed they
    // did until the Windows leg reported it green while every sibling case
    // failed the handshake: `execute_batch` counts a `Result` that is *ok*, and
    // a refused handshake is an ok Result carrying an `error_code` - the error
    // arm is reserved for a request that could not be attempted at all. So the
    // assertion is on each response.
    ASSERT_EQ (batch.responses.size (), 3u);
    EXPECT_EQ (batch.successful, 3u);
    EXPECT_EQ (batch.failed, 0u);
    for (const auto& result : batch.responses) {
        ASSERT_TRUE (result.is_ok ()) << result.error ().message;
        EXPECT_EQ (result.value ().error_code, ErrorCode::None)
        << "a pooled transfer did not complete the handshake: "
        << to_string (result.value ().error_code) << ": " << result.value ().error_message;
        EXPECT_EQ (result.value ().status_code, 200);
    }
}

TEST_P (MutualTlsTest, PmSendRequestPresentsTheCertificate) {
    // `pm.sendRequest` builds its own ClientConfig inside the script engine, so
    // the registry reaches it through the context or not at all - and a script
    // that logs in against an mTLS endpoint is exactly the transfer #707's
    // "a certificate belongs to a host, not to a request" was written for.
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("script", ca_);
    register_entry (client);

    vayu::runtime::ScriptConfig script_config;
    script_config.timeout_ms         = 10000;
    script_config.allow_send_request = true;
    vayu::runtime::ScriptEngine engine (script_config);

    Request request;
    Response response;
    response.status_code = 200;
    auto ctx = vayu::runtime::ScriptContext::for_test (request, response);
    vayu::Environment env;
    ctx.environment = &env;
    ctx.transport   = policy ();

    const auto result = engine.execute ("pm.sendRequest('" + server.url ("/hello") +
    "', function (err, res) { pm.test('reached', function () { "
    "pm.expect(res.code).to.eql(200); }); });",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests.front ().passed)
    << "the script's send did not complete the handshake: "
    << result.tests.front ().error_message;
}

// ---------------------------------------------------------------------------
// Precedence and the passphrase, on a wire
// ---------------------------------------------------------------------------

TEST_P (MutualTlsTest, ThePortEntryOutranksTheCatchAllOnAWire) {
    // Precedence is unit-tested in `client_certificates_test.cpp` against a
    // registry in memory. Here the two entries hold *different identities* and
    // only one of them is one the listener accepts, so the handshake itself is
    // the assertion: pick the catch-all and this connection never opens.
    TlsServer server (ca_, ca_);
    const ClientIdentity accepted = identity ("port_entry", ca_);
    const ClientIdentity refused  = identity ("catch_all", stranger_);
    register_entry (refused);
    register_entry (accepted, server.port ());

    const Response response = send_through (policy (), server.url ("/hello"));

    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "the catch-all's identity went out on a port another entry names: "
    << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (
    response.client_certificate, "127.0.0.1:" + std::to_string (server.port ()));
}

TEST_P (MutualTlsTest, AnEncryptedKeyOpensWithItsPassphraseAndNotWithout) {
    // Both halves in one test on purpose: the failure alone would pass against
    // an engine that never sends the passphrase at all, and the success alone
    // would pass against a key that was never encrypted. One column covers both
    // formats - libcurl reads `CURLOPT_KEYPASSWD` as the PKCS#12 import
    // password too, so the bundle instance proves that reading as well.
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("passphrase", ca_, "hunter2");
    register_entry (client, std::nullopt, "hunter2");

    const Response opened = send_through (policy (), server.url ("/hello"));
    ASSERT_EQ (opened.error_code, ErrorCode::None)
    << "the stored passphrase did not open the key: " << to_string (opened.error_code)
    << ": " << opened.error_message;
    EXPECT_EQ (opened.status_code, 200);

    // The same row, the same key, a passphrase that is not the one it was
    // encrypted under.
    auto row       = db_->get_client_certificates ().front ();
    row.passphrase = "not-the-passphrase";
    db_->save_client_certificate (row);

    const Response refused = send_through (policy (), server.url ("/hello"));
    EXPECT_EQ (refused.status_code, 0)
    << "a key that could not be opened still connected";
    EXPECT_EQ (refused.error_code, ErrorCode::SslError)
    << "a client certificate that will not load must read as a TLS error, not "
       "as an unreachable endpoint: "
    << to_string (refused.error_code) << ": " << refused.error_message;
    EXPECT_FALSE (refused.error_message.empty ())
    << "the refusal names nothing, so a user is left to guess which of the two "
       "settings is wrong";
}

TEST_P (MutualTlsTest, AnEntryThatNamesNoFormatIsReadOffTheFileAndStillConnects) {
    // The write-time default (#833), against real material rather than the
    // byte-shaped fixtures in `client_certificates_test.cpp`: a user who never
    // learns the field exists must still end up with a row that hands libcurl
    // the right type. Declaring nothing and connecting anyway is the assertion,
    // in both formats - a sniff that answered `pem` to everything would fail
    // the bundle instance here and nowhere else.
    TlsServer server (ca_, ca_);
    const ClientIdentity client = identity ("sniffed", ca_);

    json payload = { { "host", "127.0.0.1" }, { "certPath", client.certificate.path () } };
    if (!client.key_path ().empty ()) {
        payload["keyPath"] = client.key_path ();
    }
    const auto [status, created] =
    routes::create_client_certificate_response (*db_, payload);
    ASSERT_EQ (status, 200) << created.dump ();
    EXPECT_EQ (created["certFormat"], vayu::tests::client_identity_format_name (format ()));

    const Response response = send_through (policy (), server.url ("/hello"));

    ASSERT_EQ (response.error_code, ErrorCode::None)
    << "an entry whose format was read off the file did not complete the "
       "handshake: "
    << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (response.status_code, 200);
}

/**
 * One instance per format this build can present. `client_identity_formats()`
 * is the single source of that set - a leg gets the cases its backend can
 * actually load and no others, which is what replaced the Windows-wide skip.
 */
INSTANTIATE_TEST_SUITE_P (PerClientIdentityFormat,
MutualTlsTest,
::testing::ValuesIn (vayu::tests::client_identity_formats ()),
[] (const ::testing::TestParamInfo<ClientIdentityFormat>& info) {
    return vayu::tests::client_identity_format_name (info.param);
});

} // namespace
} // namespace vayu::http
