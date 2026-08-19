/**
 * @file tests/transport_policy_test.cpp
 * @brief The transport policy: resolution, validation, and the one applier
 *        every outbound path goes through (issue #705).
 *
 * The traversal tests all assert the same way, and it is worth saying once:
 * curl writes an *absolute-form* request line ("GET http://host/path") only
 * when it is proxying, and never when it dials the origin directly. So
 * `MockProxy::seen()` holding the target is proof the bytes took the proxy
 * hop, and an empty `seen()` beside a successful response is proof they did
 * not. The `Via` header the proxy stamps is the same fact read from the other
 * end.
 */

#include <curl/curl.h>
#include <gtest/gtest.h>
#include <httplib.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "proxy_server.hpp"
#include "temp_database.hpp"
#include "tls_backend.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/debug_redact.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/runtime/script_engine.hpp"

namespace vayu::http::routes {
// Declared in import.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_fetch (const std::string& request_body,
const vayu::http::TransportPolicy& transport);
} // namespace vayu::http::routes

namespace vayu::http {
namespace {

using vayu::tests::MockProxy;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// The upstream every proxied request is ultimately for. Plain HTTP, because
/// what is under test is which socket the bytes leave by, not TLS.
class MockUpstream {
    public:
    MockUpstream () {
        svr.Get ("/hello", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"from":"upstream"})", "application/json");
        });
        svr.Get ("/events", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("data: one\n\ndata: two\n\n", "text/event-stream");
        });
        svr.Post ("/token", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"access_token":"AT-PROXIED","token_type":"Bearer","expires_in":3600})",
            "application/json");
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

/// Sets an environment variable for the length of a test and puts it back.
/// libcurl reads the proxy variables per transfer, so this is how the
/// `environment` and `off` modes are told apart at all - and restoring it
/// matters because the whole suite shares one process.
class ScopedEnv {
    public:
    ScopedEnv (const char* name, const std::string& value) : name_ (name) {
        if (auto previous = read (name)) {
            had_previous_ = true;
            previous_     = std::move (*previous);
        }
        set (name_.c_str (), value.c_str ());
    }
    ~ScopedEnv () {
        if (had_previous_) {
            set (name_.c_str (), previous_.c_str ());
        } else {
            set (name_.c_str (), "");
        }
    }
    ScopedEnv (const ScopedEnv&)            = delete;
    ScopedEnv& operator= (const ScopedEnv&) = delete;

    private:
    /**
     * The variable's current value, or nullopt when it is unset.
     *
     * MSVC deprecates `std::getenv` in favour of `_dupenv_s` (C4996) and this
     * suite is built `/W4 /WX`, so the deprecation is followed rather than
     * suppressed - the same shape `script_types_test.cpp`'s `env_is_set` uses,
     * and for the same reason: a `#pragma warning(disable)` would be a
     * permanent suppression bought for a one-line read.
     */
    static std::optional<std::string> read (const char* name) {
#ifdef _WIN32
        char* value   = nullptr;
        size_t length = 0;
        if (_dupenv_s (&value, &length, name) != 0 || value == nullptr) {
            return std::nullopt;
        }
        std::string copy (value);
        std::free (value);
        return copy;
#else
        if (const char* value = std::getenv (name)) {
            return std::string (value);
        }
        return std::nullopt;
#endif
    }

    static void set (const char* name, const char* value) {
#ifdef _WIN32
        // An empty value removes the variable on Windows, which is what the
        // restore path wants when there was nothing to restore.
        _putenv_s (name, value);
#else
        if (value[0] == '\0') {
            unsetenv (name);
        } else {
            setenv (name, value, 1);
        }
#endif
    }
    std::string name_;
    std::string previous_;
    bool had_previous_ = false;
};

/// Pins the bypass environment libcurl sees. Both spellings, because libcurl
/// reads `no_proxy` *and* `NO_PROXY` and a CI container that exports only the
/// uppercase one would decide these tests without them saying so.
class ScopedNoProxy {
    public:
    explicit ScopedNoProxy (const std::string& value)
    : lower_ ("no_proxy", value), upper_ ("NO_PROXY", value) {
    }

    private:
    ScopedEnv lower_;
    ScopedEnv upper_;
};

Request get_request (const std::string& url) {
    Request request;
    request.method = HttpMethod::GET;
    request.url    = url;
    return request;
}

/// The whole of @p path as a string - the bundle assertions read the file the
/// resolver wrote rather than the value it returned.
std::string read_whole_file (const std::string& path) {
    std::ifstream in (path, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

TransportPolicy manual_through (const MockProxy& proxy) {
    TransportPolicy policy;
    policy.proxy_mode = ProxyMode::Manual;
    policy.proxy_url  = proxy.url ();
    return policy;
}

class TransportPolicyDbTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (path_);
        db_ = std::make_unique<vayu::db::Database> (path_);
        db_->seed_default_config ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (path_);
    }

    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key << " is not seeded";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    std::string path_ = "test_transport_policy.db";
    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// Resolution from settings
// ---------------------------------------------------------------------------

TEST_F (TransportPolicyDbTest, SeededDefaultIsEnvironment) {
    const auto policy = resolve_transport_policy (*db_);
    EXPECT_EQ (policy.proxy_mode, ProxyMode::Environment);
    EXPECT_TRUE (policy.proxy_url.empty ());
    EXPECT_TRUE (policy.proxy_bypass.empty ());
}

TEST_F (TransportPolicyDbTest, ManualCarriesUrlAndBypass) {
    set_config ("proxyMode", "manual");
    set_config ("proxyUrl", "http://user:pass@proxy.example:8080");
    set_config ("proxyBypass", "localhost,.internal.example.com");

    const auto policy = resolve_transport_policy (*db_);
    EXPECT_EQ (policy.proxy_mode, ProxyMode::Manual);
    EXPECT_EQ (policy.proxy_url, "http://user:pass@proxy.example:8080");
    EXPECT_EQ (policy.proxy_bypass, "localhost,.internal.example.com");
}

TEST_F (TransportPolicyDbTest, StoredUrlIsNotReadOutsideManualMode) {
    // Keeping a proxy URL while the mode is off is a normal thing to do. What
    // must not happen is the URL reaching a handle anyway.
    set_config ("proxyMode", "off");
    set_config ("proxyUrl", "http://proxy.example:8080");

    const auto policy = resolve_transport_policy (*db_);
    EXPECT_EQ (policy.proxy_mode, ProxyMode::Off);
    EXPECT_TRUE (policy.proxy_url.empty ());
}

TEST_F (TransportPolicyDbTest, ManualWithUnusableUrlResolvesToOff) {
    // Only reachable from a hand-edited row - POST /config refuses the pair.
    // Manual-with-nothing must not resolve to "manual, no URL", which curl
    // reads as "no proxy" while Settings still says Manual.
    set_config ("proxyMode", "manual");
    set_config ("proxyUrl", "   ");

    const auto policy = resolve_transport_policy (*db_);
    EXPECT_EQ (policy.proxy_mode, ProxyMode::Off);
    EXPECT_TRUE (policy.proxy_url.empty ());
}

TEST_F (TransportPolicyDbTest, UnrecognisedModeFallsBackToTheDefault) {
    set_config ("proxyMode", "sometimes");
    EXPECT_EQ (resolve_transport_policy (*db_).proxy_mode, ProxyMode::Environment);
}

TEST_F (TransportPolicyDbTest, EveryModeIsOfferedBySettings) {
    // The seed derives its options from `all_proxy_modes`, so this fails if a
    // mode is ever added to the enum without reaching the settings row - which
    // would make it a value the engine honours and POST /config rejects.
    const auto entry = db_->get_config_entry ("proxyMode");
    ASSERT_TRUE (entry.has_value ());
    ASSERT_TRUE (entry->options.has_value ());
    const auto options = nlohmann::json::parse (*entry->options);
    ASSERT_EQ (options.size (), all_proxy_modes ().size ());
    for (const auto mode : all_proxy_modes ()) {
        const std::string wanted = to_string (mode);
        EXPECT_TRUE (std::any_of (options.begin (), options.end (),
        [&] (const nlohmann::json& option) {
            return option.at ("value").get<std::string> () == wanted;
        }))
        << wanted << " is a mode the engine parses but Settings does not offer";
    }
}

// ---------------------------------------------------------------------------
// URL validation - the one copy the route and the resolver share
// ---------------------------------------------------------------------------

TEST (ProxyUrlValidation, AcceptsTheShapesCurlTakes) {
    EXPECT_FALSE (proxy_url_rejection ("http://proxy.example:8080").has_value ());
    EXPECT_FALSE (proxy_url_rejection ("https://proxy.example:8443").has_value ());
    EXPECT_FALSE (proxy_url_rejection ("socks5h://127.0.0.1:1080").has_value ());
    EXPECT_FALSE (
    proxy_url_rejection ("http://user:p%40ss@proxy.example:8080").has_value ());
    // Scheme-less is curl's own shorthand for http://.
    EXPECT_FALSE (proxy_url_rejection ("proxy.example:8080").has_value ());
}

TEST (ProxyUrlValidation, RejectsTheShapesThatAreAlwaysMistakes) {
    EXPECT_TRUE (proxy_url_rejection ("").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("   ").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("http://proxy example:8080").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("htp://proxy.example:8080").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("ftp://proxy.example:8080").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("http://:8080").has_value ());
    EXPECT_TRUE (proxy_url_rejection ("http://").has_value ());
}

// ---------------------------------------------------------------------------
// TLS trust - the pasted bundle, and what this platform's backend does with it
// (issue #706)
// ---------------------------------------------------------------------------

/// A syntactically complete certificate block. Never parsed as a certificate by
/// anything under test - the validation here is deliberately about PEM shape,
/// so a body that is only base64-shaped is exactly the right fixture.
constexpr const char* SAMPLE_CERT =
"-----BEGIN CERTIFICATE-----\n"
"MIIBkTCB+wIJAJ2Vayu0TESTMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnZh\n"
"eXUtY2EwHhcNMjYwMTAxMDAwMDAwWhcNMzYwMTAxMDAwMDAwWjARMQ8wDQYDVQQD\n"
"-----END CERTIFICATE-----\n";

TEST (CaPemValidation, AcceptsACertificateBlock) {
    EXPECT_FALSE (ca_pem_rejection (SAMPLE_CERT).has_value ());
    // Two anchors in one paste is the normal corporate shape (root plus the
    // issuing intermediate).
    EXPECT_FALSE (ca_pem_rejection (std::string (SAMPLE_CERT) + SAMPLE_CERT).has_value ());
}

TEST (CaPemValidation, RejectsWhatIsNotAPemBundle) {
    EXPECT_TRUE (ca_pem_rejection ("").has_value ());
    EXPECT_TRUE (ca_pem_rejection ("   \n\t ").has_value ());
    EXPECT_TRUE (ca_pem_rejection ("not a certificate").has_value ());
    // Truncated at the paste: the half-copied block, which curl would refuse at
    // handshake time with an error naming nothing the user recognises.
    EXPECT_TRUE (
    ca_pem_rejection ("-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJ\n").has_value ());
}

TEST (CaPemValidation, NamesAPastedPrivateKeyForWhatItIs) {
    // The mistake worth its own message: the file this would land in is not a
    // secret store, and "no certificate found" would send the user looking for
    // a formatting problem instead of telling them what they pasted.
    const auto rejection = ca_pem_rejection (
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n");
    ASSERT_TRUE (rejection.has_value ());
    EXPECT_NE (rejection->find ("private key"), std::string::npos) << *rejection;
}

TEST_F (TransportPolicyDbTest, NoPastedCertificatesMeansNoBundle) {
    const auto policy = resolve_transport_policy (*db_);
    EXPECT_TRUE (policy.ca_bundle_path.empty ())
    << "with nothing pasted the backend's own trust store must be left alone";
}

TEST_F (TransportPolicyDbTest, PastedCertificatesAreMaterializedBesideTheDatabase) {
    set_config ("customCaCertificates", SAMPLE_CERT);

    const auto policy = resolve_transport_policy (*db_);
    ASSERT_FALSE (policy.ca_bundle_path.empty ());
    ASSERT_TRUE (std::filesystem::exists (policy.ca_bundle_path));
    // Beside the database, whatever shape its path has: this fixture opens one
    // by bare filename (parent path ""), which is the working directory - the
    // same case a CLI invocation produces.
    const std::filesystem::path db_dir =
    std::filesystem::path (db_->path ()).parent_path ();
    EXPECT_EQ (std::filesystem::absolute (
               std::filesystem::path (policy.ca_bundle_path).parent_path ()),
    std::filesystem::absolute (db_dir.empty () ? std::filesystem::path (".") : db_dir));

    const std::string bundle = read_whole_file (policy.ca_bundle_path);
    EXPECT_NE (bundle.find (SAMPLE_CERT), std::string::npos)
    << "the pasted certificate is not in the bundle curl is pointed at";

    // The additive rule of #704, asserted where it is actually enforceable:
    // wherever this platform exposes its anchors as a file (every
    // OpenSSL-backed build, which is where CAINFO *replaces* the default),
    // the merged bundle has to still contain them - otherwise adding one
    // corporate CA would quietly untrust the public web.
    const std::string system_anchors = system_ca_bundle_pem ();
    if (!system_anchors.empty ()) {
        EXPECT_NE (bundle.find (system_anchors), std::string::npos)
        << "the platform's own anchors were replaced rather than extended";
        EXPECT_GT (bundle.size (), system_anchors.size ());
    }
    std::filesystem::remove (policy.ca_bundle_path);
}

TEST_F (TransportPolicyDbTest, AChangedPasteReachesTheNextTransfer) {
    // The bundle is cached on the content that produced it, because the policy
    // is resolved per transfer. A cache that ignored a settings change would
    // keep verifying against the old anchors until the engine restarted.
    set_config ("customCaCertificates", SAMPLE_CERT);
    const auto first = resolve_transport_policy (*db_);
    ASSERT_FALSE (first.ca_bundle_path.empty ());

    const std::string second_cert = std::string (SAMPLE_CERT) +
    "-----BEGIN CERTIFICATE-----\nQkJCQkJC\n-----END CERTIFICATE-----\n";
    set_config ("customCaCertificates", second_cert);
    const auto second = resolve_transport_policy (*db_);
    ASSERT_FALSE (second.ca_bundle_path.empty ());

    const std::string bundle = read_whole_file (second.ca_bundle_path);
    EXPECT_NE (bundle.find ("QkJCQkJC"), std::string::npos)
    << "the second paste never reached the file";
    std::filesystem::remove (second.ca_bundle_path);
}

TEST_F (TransportPolicyDbTest, AnUnusablePasteIsNotMaterialized) {
    // Only reachable from a hand-edited row - POST /config refuses this shape.
    // What must not happen is a file curl is pointed at that holds no
    // certificate: every HTTPS request would then fail verification, with the
    // trust store looking configured.
    set_config ("customCaCertificates", "-----BEGIN PRIVATE KEY-----\nMIIB\n");

    const auto policy = resolve_transport_policy (*db_);
    EXPECT_TRUE (policy.ca_bundle_path.empty ());
}

using vayu::tests::tls_backend_name;

/// Whether @p backend verifies against the file `CURLOPT_CAINFO` names - which
/// is the same question as whether that option *replaces* the trust store
/// rather than adding to one the OS keeps - or nullopt for a backend no
/// statement in this repo covers.
///
/// The pinned vcpkg baseline's `curl` port offers three TLS features
/// (`openssl`, `sspi`, `wolfssl`) and nothing else, so the set below is the
/// set this repo can be built against. A backend outside it is a build nobody
/// here has reasoned about, and `IsTheBackendEveryTrustStatementHereAssumes`
/// says so rather than guessing which half it belongs to.
std::optional<bool> verifies_through_a_bundle_file (std::string_view backend) {
    for (const std::string_view family : { "OpenSSL", "LibreSSL", "BoringSSL", "quictls" }) {
        if (backend.rfind (family, 0) == 0) {
            return true;
        }
    }
    if (backend.rfind ("Schannel", 0) == 0) {
        return false;
    }
    return std::nullopt;
}

TEST (TlsBackend, ClassifiesTheBackendsThisRepoCanBeBuiltAgainst) {
    // The two tests below can only read the backend this host happens to have,
    // so the classifier they lean on is exercised here with both answers
    // stubbed - `CLAUDE.md`'s rule that a per-platform branch must not be
    // asserted only where it happens to be taken. Without this, a classifier
    // that answered "bundle file" to everything would still be green on Linux
    // and macOS and would only be caught by the Windows leg.
    EXPECT_EQ (verifies_through_a_bundle_file ("OpenSSL/3.6.3"), std::optional<bool> (true));
    EXPECT_EQ (verifies_through_a_bundle_file ("Schannel"), std::optional<bool> (false));
    // Not a backend anything here has a statement about, and saying so is the
    // point: guessing would put a build under a trust model nobody checked.
    EXPECT_EQ (verifies_through_a_bundle_file ("GnuTLS/3.8.4"), std::nullopt);
    EXPECT_EQ (verifies_through_a_bundle_file (""), std::nullopt);
}

TEST (TlsBackend, IsTheBackendEveryTrustStatementHereAssumes) {
    // The fact #818 exists to establish, read off the build instead of
    // reasoned out of a port file. Six statements in this repo used to
    // describe a three-way spread with macOS on Apple SecTrust; the baseline's
    // `curl` port maps its default `ssl` feature to `openssl` on
    // `uwp | !windows` and to `sspi` only on Windows, which makes the spread
    // two-way. A port file is not a build, so the corrected statements are
    // pinned here and checked on each CI leg - the whole defect #812 and this
    // issue share is a claim confident enough that no reader doubts it.
    const std::string backend = tls_backend_name ();
    ASSERT_FALSE (backend.empty ())
    << "curl_version_info() names no TLS backend, so nothing this repo says "
       "about trust is checked on this build";

    const std::optional<bool> bundle_file_backend = verifies_through_a_bundle_file (backend);
    ASSERT_TRUE (bundle_file_backend.has_value ())
    << "TLS backend '" << backend
    << "' is one no statement in this repo covers - decide which trust model it "
       "follows and say so, rather than leaving the docs describing a build "
       "nobody is running";

#ifdef _WIN32
    EXPECT_FALSE (*bundle_file_backend)
    << "Windows is documented as the one leg whose anchors live in an OS store, "
       "but this build verifies with '"
    << backend << "'";
#else
    EXPECT_TRUE (*bundle_file_backend)
    << "every non-Windows leg is documented as verifying through the file "
       "CURLOPT_CAINFO names, but this build verifies with '"
    << backend << "'";
#endif
}

TEST (TlsBackend, FindsTheSystemAnchorsTheMergeExtends) {
    // The security-shaped half of #818, and the reason the backend question is
    // not cosmetic. Where `CURLOPT_CAINFO` replaces the store,
    // `materialize_ca_bundle` keeps #704 decision 4's additive promise by
    // concatenating the platform's own anchors into the file it writes - so a
    // build that verifies through a bundle and cannot *find* the system one
    // narrows the user's trust to their pasted CA alone the moment they paste
    // it, while every doc still says trust was extended.
    //
    // `PastedCertificatesAreMaterializedBesideTheDatabase` asserts the merge,
    // but only when there are anchors to merge; without this test that whole
    // failure would show up as a quietly unasserted branch on a green leg.
    const std::string backend = tls_backend_name ();
    ASSERT_FALSE (backend.empty ());
    const std::optional<bool> bundle_file_backend = verifies_through_a_bundle_file (backend);
    ASSERT_TRUE (bundle_file_backend.has_value ()) << backend;

    if (!*bundle_file_backend) {
        // Narrow and loud, the way the revocation skip in
        // `tls_verification_test.cpp` is: an OS-store backend has no file to
        // merge with, so there is nothing here to be right or wrong about.
        GTEST_SKIP () << "TLS backend '" << backend
                      << "' verifies through an OS store, which is not a file to merge";
    }

    EXPECT_FALSE (system_ca_bundle_pem ().empty ())
    << "TLS backend '" << backend
    << "' verifies against the file CURLOPT_CAINFO names, but no system bundle "
       "was found - so pasting a CA would replace the platform's anchors "
       "instead of extending them";
}

TEST (TlsBackend, AcceptsACustomCaBundleOnThisPlatform) {
    // The per-platform claim, checked on the platform rather than reasoned
    // about: `CURLOPT_CAINFO` is the one transport option a TLS backend can
    // refuse outright (`CURLE_NOT_BUILT_IN`), and the CI legs do not all build
    // against the same backend - OpenSSL on Linux and macOS, Schannel on
    // Windows. A refusal here means the docs' additive-trust claim is false for
    // this build, which is a security claim, so it fails the suite rather than
    // being discovered by a user whose requests all stop verifying.
    CURL* curl = curl_easy_init ();
    ASSERT_NE (curl, nullptr);
    const CURLcode result =
    curl_easy_setopt (curl, CURLOPT_CAINFO, "/nonexistent/ca-bundle.pem");
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    EXPECT_EQ (result, CURLE_OK)
    << "TLS backend '"
    << (info != nullptr && info->ssl_version != nullptr ? info->ssl_version : "unknown")
    << "' refuses CURLOPT_CAINFO: " << curl_easy_strerror (result);
    curl_easy_cleanup (curl);
}

// ---------------------------------------------------------------------------
// Every outbound path traverses the proxy
// ---------------------------------------------------------------------------

TEST (TransportPolicyPaths, DesignSendTraversesManualProxy) {
    MockUpstream upstream;
    MockProxy proxy;

    ClientConfig config;
    config.transport = manual_through (proxy);
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 200);
    EXPECT_NE (response.body.find ("upstream"), std::string::npos);

    ASSERT_EQ (proxy.count (), 1u);
    EXPECT_EQ (proxy.seen ().front (), upstream.url ("/hello"));
}

TEST (TransportPolicyPaths, ScriptSendRequestTraversesManualProxy) {
    // `pm.sendRequest` builds its own ClientConfig inside the script engine, so
    // the policy has to reach it through the context. Otherwise a script that
    // logs in with sendRequest goes direct while the request it authenticates
    // goes through the proxy - and behind a corporate network the login is the
    // half that fails.
    MockUpstream upstream;
    MockProxy proxy;

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
    ctx.transport   = manual_through (proxy);

    const auto result = engine.execute ("pm.sendRequest('" + upstream.url ("/hello") +
    "', function (err, res) { pm.test('reached', function () { "
    "pm.expect(res.code).to.eql(200); }); });",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (proxy.count (), 1u);
    EXPECT_EQ (proxy.seen ().front (), upstream.url ("/hello"));
}

TEST (TransportPolicyPaths, LoadRunTraversesManualProxy) {
    MockUpstream upstream;
    MockProxy proxy;

    EventLoopConfig config;
    config.transport = manual_through (proxy);
    EventLoop loop (config);
    loop.start ();

    std::vector<Request> requests;
    for (int i = 0; i < 3; ++i) {
        requests.push_back (get_request (upstream.url ("/hello")));
    }
    const auto batch = loop.execute_batch (requests);
    loop.stop ();

    EXPECT_EQ (batch.successful, 3u);
    EXPECT_EQ (proxy.count (), 3u);
}

TEST (TransportPolicyPaths, SseStreamTraversesManualProxy) {
    // The load-bearing case: this path had no CURLOPT_PROXY at all before
    // #705, so a configured proxy covered every send and every load run and
    // silently skipped streams.
    MockUpstream upstream;
    MockProxy proxy;

    SseStreamRequest spec;
    spec.run_id    = "run-proxy-sse";
    spec.request   = get_request (upstream.url ("/events"));
    spec.transport = manual_through (proxy);

    SseStreamContext context (spec.run_id, spec.limits);
    const auto response = consume_sse_stream (spec, context);

    EXPECT_EQ (response.status_code, 200);
    ASSERT_EQ (proxy.count (), 1u);
    EXPECT_EQ (proxy.seen ().front (), upstream.url ("/events"));
}

TEST (TransportPolicyPaths, ImportFetchTraversesManualProxy) {
    // Spec re-fetch and $ref bundling ride this route, so this is what makes
    // "import an OpenAPI document by URL" work behind a proxy.
    MockUpstream upstream;
    MockProxy proxy;

    const nlohmann::json body = { { "url", upstream.url ("/hello") } };
    const auto [status, json] =
    routes::import_fetch (body.dump (), manual_through (proxy));

    EXPECT_EQ (status, 200);
    ASSERT_EQ (proxy.count (), 1u);
    EXPECT_EQ (proxy.seen ().front (), upstream.url ("/hello"));
}

TEST_F (TransportPolicyDbTest, OAuthTokenFetchTraversesManualProxy) {
    // The token endpoint is the one a corporate proxy most often fronts. An
    // execute path that proxied while this did not would report every
    // authenticated request as an auth failure.
    MockUpstream upstream;
    MockProxy proxy;

    set_config ("proxyMode", "manual");
    set_config ("proxyUrl", proxy.url ());

    const nlohmann::json config = { { "grantType", "client_credentials" },
        { "accessTokenUrl", upstream.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "secret" } };

    const auto result = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result))
    << std::get<oauth::TokenError> (result).message;
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).access_token, "AT-PROXIED");
    EXPECT_EQ (proxy.count (), 1u);
}

TEST_F (TransportPolicyDbTest, MonitorScrapeInheritsThePolicy) {
    // The monitor client is built from a resolved policy rather than a default
    // ClientConfig - a vitals endpoint inside a corporate network is reached
    // the same way everything else is.
    MockUpstream upstream;
    MockProxy proxy;

    set_config ("proxyMode", "manual");
    set_config ("proxyUrl", proxy.url ());

    ClientConfig config;
    config.transport = resolve_transport_policy (*db_);
    Client client (config);
    ASSERT_TRUE (client.send (get_request (upstream.url ("/hello"))).is_ok ());
    EXPECT_EQ (proxy.count (), 1u);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

TEST (TransportPolicyModes, EnvironmentModeUsesTheExportedProxy) {
    MockUpstream upstream;
    MockProxy proxy;
    ScopedEnv proxy_env ("http_proxy", proxy.url ());
    // Cleared explicitly: a CI container that exports a `no_proxy` covering
    // 127.0.0.1 would exempt the upstream and make this assert the opposite of
    // what it means to. `EnvironmentModeHonoursInheritedNoProxy` below is
    // where that variable is the subject rather than the noise.
    ScopedNoProxy bypass_env ("");

    ClientConfig config; // default policy: ProxyMode::Environment
    Client client (config);
    ASSERT_TRUE (client.send (get_request (upstream.url ("/hello"))).is_ok ());

    EXPECT_EQ (proxy.count (), 1u)
    << "environment mode must keep libcurl's own http_proxy pickup";
}

TEST (TransportPolicyModes, EnvironmentModeHonoursInheritedNoProxy) {
    // "Do what the environment says" includes the exemptions it names.
    MockUpstream upstream;
    MockProxy proxy;
    ScopedEnv proxy_env ("http_proxy", proxy.url ());
    ScopedNoProxy bypass_env ("127.0.0.1");

    ClientConfig config;
    Client client (config);
    ASSERT_TRUE (client.send (get_request (upstream.url ("/hello"))).is_ok ());
    EXPECT_EQ (proxy.count (), 0u);
}

TEST (TransportPolicyModes, ManualModeIgnoresInheritedNoProxy) {
    // The regression this environment taught us: libcurl consults `no_proxy`
    // whenever CURLOPT_NOPROXY is null, so a manually configured proxy was
    // silently bypassed for every host the ambient variable happened to name -
    // and nothing said so. Manual mode writes the (possibly empty) bypass list
    // instead, which makes the configured proxy mean what it says.
    MockUpstream upstream;
    MockProxy proxy;
    ScopedNoProxy bypass_env ("127.0.0.1");

    ClientConfig config;
    config.transport = manual_through (proxy);
    Client client (config);
    ASSERT_TRUE (client.send (get_request (upstream.url ("/hello"))).is_ok ());
    EXPECT_EQ (proxy.count (), 1u);
}

TEST (TransportPolicyModes, OffModeIgnoresTheExportedProxy) {
    // The pair above is what gives this one its meaning: same environment,
    // same upstream, and the only difference is the mode. `off` has to mean
    // off, or the mode is decorative for anyone running from a shell.
    MockUpstream upstream;
    MockProxy proxy;
    ScopedEnv proxy_env ("http_proxy", proxy.url ());
    ScopedNoProxy bypass_env ("");

    ClientConfig config;
    config.transport.proxy_mode = ProxyMode::Off;
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_EQ (proxy.count (), 0u);
}

TEST (TransportPolicyModes, BypassListSkipsTheProxy) {
    MockUpstream upstream;
    MockProxy proxy;

    ClientConfig config;
    config.transport              = manual_through (proxy);
    config.transport.proxy_bypass = "127.0.0.1";
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_EQ (proxy.count (), 0u)
    << "a bypassed host must reach the upstream directly";
}

TEST (TransportPolicyModes, AReusedHandleDoesNotKeepAnEarlierProxy) {
    // `Client` holds one curl handle for its lifetime, so a mode that skipped
    // CURLOPT_PROXY rather than writing it would inherit the previous send's
    // proxy. Two sends on one client, one proxied and one not.
    MockUpstream upstream;
    MockProxy proxy;

    ClientConfig config;
    config.transport = manual_through (proxy);
    Client client (config);
    ASSERT_TRUE (client.send (get_request (upstream.url ("/hello"))).is_ok ());
    ASSERT_EQ (proxy.count (), 1u);

    ClientConfig direct;
    direct.transport.proxy_mode = ProxyMode::Off;
    Client direct_client (direct);
    ASSERT_TRUE (direct_client.send (get_request (upstream.url ("/hello"))).is_ok ());
    EXPECT_EQ (proxy.count (), 1u);
}

// ---------------------------------------------------------------------------
// A proxy failure is reported as a proxy failure
// ---------------------------------------------------------------------------

TEST (TransportPolicyErrors, UnresolvableProxyIsProxyError) {
    MockUpstream upstream;

    ClientConfig config;
    config.transport.proxy_mode = ProxyMode::Manual;
    // .invalid is reserved by RFC 2606 and resolves nowhere, on any network.
    config.transport.proxy_url = "http://vayu-no-such-proxy.invalid:3128";
    Client client (config);

    const auto result = client.send (get_request (upstream.url ("/hello")));
    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, ErrorCode::ProxyError)
    << "got " << to_string (response.error_code) << ": " << response.error_message;
}

TEST (TransportPolicyErrors, RefusedConnectIsProxyError) {
    // An https target makes curl issue a CONNECT, which the fixture answers
    // with 407. curl reports that as CURLE_RECV_ERROR - indistinguishable from
    // an upstream hangup by code alone, which is how it used to land in
    // INTERNAL_ERROR. Nothing listens on the target port and nothing needs to:
    // the tunnel is refused before any TLS happens.
    MockProxy proxy;

    ClientConfig config;
    config.transport = manual_through (proxy);
    Client client (config);

    const auto result =
    client.send (get_request ("https://vayu-target.invalid/secure"));
    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, ErrorCode::ProxyError)
    << "got " << to_string (response.error_code) << ": " << response.error_message;
    EXPECT_EQ (proxy.count (), 1u);
}

TEST (TransportPolicyErrors, ProxyErrorHasItsOwnWireName) {
    // Appended to the enum, never inserted: the numeric value is what a stored
    // trace's error_code holds.
    EXPECT_STREQ (to_string (ErrorCode::ProxyError), "PROXY_ERROR");
    EXPECT_GT (static_cast<int> (ErrorCode::ProxyError),
    static_cast<int> (ErrorCode::DataBindingFailed));
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

TEST (TransportPolicyRedaction, ProxyAuthorizationNeverReachesATrace) {
    // Credentials ride the proxy URL, and curl turns them into a
    // Proxy-Authorization header on the CONNECT - which the debug stream
    // captures and the trace stores. This asserts the redaction that keeps
    // them out, on both halves of the exchange.
    EXPECT_EQ (
    detail::redact_header_line ("Proxy-Authorization: Basic dXNlcjpwYXNz"),
    "Proxy-Authorization: <redacted>");
    EXPECT_EQ (
    detail::redact_header_line ("proxy-authenticate: Basic realm=\"corp\""),
    "proxy-authenticate: <redacted>");
}

} // namespace
} // namespace vayu::http
