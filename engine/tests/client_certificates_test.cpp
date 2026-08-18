/**
 * @file tests/client_certificates_test.cpp
 * @brief The client-certificate registry (issue #707): what a row may say, how
 *        a target picks one, and that the pick reaches every driver.
 *
 * **What is not here, and why.** There is no live mTLS handshake. A TLS server
 * exists in the suite now - #812 added `tests/tls_server.hpp` and the
 * `cpp-httplib[openssl]` feature it needs - so the first of the two reasons
 * this was deferred is gone, and what remains is the second and harder one:
 * the certificate *formats* the CI backends accept differ (Schannel wants a
 * PKCS#12 or a store thumbprint where OpenSSL wants a PEM pair), so a fixture
 * that presents one identity everywhere would fail on Windows while proving
 * nothing about the code under test. #802 owns that matrix, and is expected to
 * extend `TlsServer` rather than stand up a second listener. What that
 * leaves is covered three ways instead: the lookup is unit-tested at the
 * boundary, the *outcome* of the lookup is asserted end-to-end through the
 * design and stream drivers (both record the entry they matched on the
 * response), and the backend's willingness to take the three curl options at
 * all is probed on each platform the way `TlsBackend` probes `CURLOPT_CAINFO`.
 * The live handshake is tracked separately.
 */

#include <curl/curl.h>
#include <gtest/gtest.h>
#include <httplib.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
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
    explicit ScratchFile (std::string name) : path_ (std::move (name)) {
        std::ofstream out (path_, std::ios::binary | std::ios::trunc);
        out << "not-a-real-certificate\n";
    }
    ~ScratchFile () {
        std::error_code ec;
        std::filesystem::remove (path_, ec);
    }
    ScratchFile (const ScratchFile&)            = delete;
    ScratchFile& operator= (const ScratchFile&) = delete;

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
    // Not a suffix match: an entry for the apex must not answer for a
    // subdomain, because v1 registers exact hosts and a certificate quietly
    // presented to a host nobody registered is the opposite of the promise.
    EXPECT_EQ (match_client_certificate (policy, "eu.api.example.com", 443), nullptr);
    EXPECT_EQ (match_client_certificate (policy, "", 443), nullptr);
}

TEST (ClientCertMatching, TheHostComparisonIgnoresCase) {
    TransportPolicy policy;
    policy.client_certificates.push_back (rule ("cert_1", "api.example.com", std::nullopt));

    EXPECT_NE (match_client_certificate (policy, "API.Example.COM", 443), nullptr);
}

// ---------------------------------------------------------------------------
// What a row may say
// ---------------------------------------------------------------------------

TEST (ClientCertValidation, AcceptsAHostAndAReadablePair) {
    ScratchFile cert{ "validation_cert.pem" };
    ScratchFile key{ "validation_key.pem" };

    EXPECT_FALSE (
    client_cert_rejection ("api.example.com", std::nullopt, cert.path (), key.path ())
    .has_value ());
    EXPECT_FALSE (
    client_cert_rejection ("api.example.com", 8443, cert.path (), key.path ()).has_value ());
    // An IPv6 literal, bracketless - the form `parse_authority` yields, so the
    // form a match will compare against.
    EXPECT_FALSE (
    client_cert_rejection ("::1", 8443, cert.path (), key.path ()).has_value ());
}

TEST (ClientCertValidation, RejectsAHostThatCouldNeverMatch) {
    ScratchFile cert{ "validation_cert2.pem" };
    ScratchFile key{ "validation_key2.pem" };
    const auto reject = [&] (const std::string& host) {
        return client_cert_rejection (host, std::nullopt, cert.path (), key.path ());
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

TEST (ClientCertValidation, RejectsAPortOutsideTheRange) {
    ScratchFile cert{ "validation_cert3.pem" };
    ScratchFile key{ "validation_key3.pem" };

    EXPECT_TRUE (
    client_cert_rejection ("api.example.com", 0, cert.path (), key.path ()).has_value ());
    EXPECT_TRUE (
    client_cert_rejection ("api.example.com", 70000, cert.path (), key.path ()).has_value ());
    EXPECT_TRUE (
    client_cert_rejection ("api.example.com", -1, cert.path (), key.path ()).has_value ());
}

TEST (ClientCertValidation, RejectsAFileThatIsNotThere) {
    ScratchFile cert{ "validation_cert4.pem" };
    ScratchFile key{ "validation_key4.pem" };

    const auto missing_cert = client_cert_rejection (
    "api.example.com", std::nullopt, "/nope/client.pem", key.path ());
    ASSERT_TRUE (missing_cert.has_value ());
    // The message has to name the file, or the user is left with "invalid
    // certificate" and two paths to check by hand.
    EXPECT_NE (missing_cert->find ("/nope/client.pem"), std::string::npos);

    const auto missing_key = client_cert_rejection (
    "api.example.com", std::nullopt, cert.path (), "/nope/client.key");
    ASSERT_TRUE (missing_key.has_value ());
    EXPECT_NE (missing_key->find ("/nope/client.key"), std::string::npos);

    // A directory is not a file, and opening one succeeds on some platforms -
    // which is why the check asks for a *regular* file.
    EXPECT_TRUE (
    client_cert_rejection ("api.example.com", std::nullopt, ".", key.path ()).has_value ());
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
    EXPECT_EQ (rows.front ().host, "api.example.com");
    ASSERT_TRUE (rows.front ().port.has_value ());
    EXPECT_EQ (*rows.front ().port, 8443);
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
    // The three CI legs build against three TLS backends, and a backend that
    // refuses one of these options outright would leave every mTLS request
    // going out with no certificate and nothing anywhere saying so.
    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    const char* backend =
    info != nullptr && info->ssl_version != nullptr ? info->ssl_version : "unknown";

    EXPECT_EQ (curl_easy_setopt (curl, CURLOPT_SSLCERT, "/certs/client.pem"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_SSLCERT";
    EXPECT_EQ (curl_easy_setopt (curl, CURLOPT_SSLKEY, "/certs/client.key"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_SSLKEY";
    EXPECT_EQ (curl_easy_setopt (curl, CURLOPT_KEYPASSWD, "secret"), CURLE_OK)
    << "TLS backend '" << backend << "' refuses CURLOPT_KEYPASSWD";
    curl_easy_cleanup (curl);
}

} // namespace
} // namespace vayu::http
