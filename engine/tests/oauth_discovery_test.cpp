/**
 * @file tests/oauth_discovery_test.cpp
 * @brief OAuth discovery for an MCP server (#3766): the `WWW-Authenticate`
 *        parser, the resource and local-endpoint rules, and the whole
 *        discovery against an in-process server.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "oauth_discovery_server.hpp"
#include "optional_assert.hpp"
#include "proxy_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_discovery.hpp"

using nlohmann::json;
using vayu::http::AuthChallenge;
using vayu::http::AuthorizationServerMetadataCache;
using vayu::http::BearerChallenge;
using vayu::http::OAuthDiscoveryResult;
using vayu::tests::DiscoveryAnswer;
using vayu::tests::DiscoveryServer;
namespace codes = vayu::http::oauth_discovery;

namespace {

// ============================================================================
// The challenge parser
// ============================================================================

std::vector<AuthChallenge> challenges_of (std::string_view field) {
    auto parsed = vayu::http::parse_auth_challenges (field);
    if (!parsed) {
        ADD_FAILURE () << field << ": " << parsed.error ();
        return {};
    }
    return *parsed;
}

BearerChallenge bearer_of (std::string_view field) {
    auto parsed = vayu::http::parse_bearer_challenge (field);
    if (!parsed) {
        ADD_FAILURE () << field << ": " << parsed.error ();
        return {};
    }
    if (!*parsed) {
        ADD_FAILURE () << field << ": no Bearer challenge";
        return {};
    }
    return **parsed;
}

TEST (AuthChallengeParse, ReadsTheBearerParametersDiscoveryAndStepUpUse) {
    const BearerChallenge bearer = bearer_of (
    R"(Bearer realm="mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", )"
    R"(scope="files:read files:write", error="insufficient_scope", error_description="needs write")");
    EXPECT_EQ (bearer.resource_metadata,
    "https://mcp.example/.well-known/oauth-protected-resource");
    EXPECT_EQ (bearer.scope, "files:read files:write");
    EXPECT_EQ (bearer.error, "insufficient_scope");
    EXPECT_EQ (bearer.error_description, "needs write");
}

TEST (AuthChallengeParse, SchemeAndParameterNamesAreCaseInsensitive) {
    const BearerChallenge bearer =
    bearer_of (R"(bEaReR Resource_Metadata="https://a.example/prm", SCOPE=read)");
    EXPECT_EQ (bearer.resource_metadata, "https://a.example/prm");
    EXPECT_EQ (bearer.scope, "read");
}

TEST (AuthChallengeParse, TokenValuesAndQuotedValuesBothRead) {
    const BearerChallenge bearer = bearer_of (R"(Bearer error=invalid_token, scope="")");
    EXPECT_EQ (bearer.error, "invalid_token");
    // Present and empty is not absent.
    EXPECT_EQ (bearer.scope, "");
    EXPECT_EQ (bearer.resource_metadata, std::nullopt);
    EXPECT_EQ (bearer.error_description, std::nullopt);
}

TEST (AuthChallengeParse, QuotedPairsAreUnescaped) {
    const BearerChallenge bearer =
    bearer_of (R"(Bearer error_description="say \"hi\" \\ bye")");
    EXPECT_EQ (bearer.error_description, R"(say "hi" \ bye)");
}

// RFC 9110 section 11.6.1's own example: two challenges, the first with a
// quoted-pair inside its value.
TEST (AuthChallengeParse, SplitsSeveralChallengesWithParameters) {
    const auto challenges = challenges_of (
    R"(Newauth realm="apps", type=1, title="Login to \"apps\"", Basic realm="simple")");
    ASSERT_EQ (challenges.size (), 2U);
    EXPECT_EQ (challenges[0].scheme, "Newauth");
    ASSERT_EQ (challenges[0].params.size (), 3U);
    EXPECT_EQ (challenges[0].param ("title"), R"(Login to "apps")");
    EXPECT_EQ (challenges[0].param ("type"), "1");
    EXPECT_EQ (challenges[1].scheme, "Basic");
    EXPECT_EQ (challenges[1].param ("realm"), "simple");
}

TEST (AuthChallengeParse, FindsBearerAfterAToken68Challenge) {
    const auto challenges =
    challenges_of ("Negotiate YIIB==, Bearer scope=\"a\"");
    ASSERT_EQ (challenges.size (), 2U);
    EXPECT_EQ (challenges[0].token68, "YIIB==");
    EXPECT_TRUE (challenges[0].params.empty ());
    EXPECT_EQ (bearer_of ("Negotiate YIIB==, Bearer scope=\"a\"").scope, "a");
}

TEST (AuthChallengeParse, EmptyListElementsAreSkipped) {
    const auto challenges = challenges_of (" , ,Basic realm=\"x\" , ,Bearer, ");
    ASSERT_EQ (challenges.size (), 2U);
    EXPECT_EQ (challenges[1].scheme, "Bearer");
    EXPECT_TRUE (challenges[1].params.empty ());
}

TEST (AuthChallengeParse, AFieldWithNoBearerChallengeHasNone) {
    const auto parsed =
    vayu::http::parse_bearer_challenge ("Basic realm=\"x\"");
    ASSERT_HAS_VALUE (parsed) << parsed.error ();
    EXPECT_FALSE (parsed->has_value ());
    const auto empty = vayu::http::parse_bearer_challenge ("");
    ASSERT_HAS_VALUE (empty) << empty.error ();
    EXPECT_FALSE (empty->has_value ());
}

TEST (AuthChallengeParse, RefusesWhatIsNotTheGrammar) {
    for (const std::string_view field : {
         std::string_view (R"(Bearer realm="unterminated)"),
         std::string_view (R"(Bearer scope="a", SCOPE="b")"),
         std::string_view (R"(Bearer realm="a", scope=)"),
         std::string_view (R"(Bearer realm="a" junk)"),
         std::string_view ("Bearer\"x\""),
         std::string_view ("Bearer realm=\"a\x01\""),
         std::string_view ("=Bearer"),
         }) {
        const auto parsed = vayu::http::parse_auth_challenges (field);
        EXPECT_FALSE (parsed.has_value ()) << field;
        if (!parsed) {
            EXPECT_NE (parsed.error ().find ("at offset"), std::string::npos)
            << parsed.error ();
        }
    }
}

// ============================================================================
// The resource and local-endpoint rules
// ============================================================================

TEST (OAuthDiscoveryRules, AResourceCoversItsOwnURLAndWhatIsBelowIt) {
    using vayu::http::detail::resource_covers;
    EXPECT_TRUE (resource_covers ("https://mcp.example/mcp", "https://mcp.example/mcp"));
    EXPECT_TRUE (resource_covers ("https://mcp.example", "https://mcp.example/mcp"));
    EXPECT_TRUE (resource_covers ("https://mcp.example/", "https://mcp.example/mcp"));
    EXPECT_TRUE (resource_covers ("https://mcp.example/api", "https://mcp.example/api/mcp"));
    EXPECT_TRUE (resource_covers ("https://mcp.example/mcp/", "https://mcp.example/mcp"));
    EXPECT_TRUE (resource_covers ("HTTPS://MCP.Example:443/mcp", "https://mcp.example/mcp"));
    EXPECT_TRUE (resource_covers ("https://mcp.example/mcp?t=1", "https://mcp.example/mcp?t=1"));
}

TEST (OAuthDiscoveryRules, AResourceElsewhereDoesNotCover) {
    using vayu::http::detail::resource_covers;
    // A prefix that ends inside a segment names a different path.
    EXPECT_FALSE (resource_covers ("https://mcp.example/mc", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("https://mcp.example/mcp/v2", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("https://other.example/mcp", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("http://mcp.example/mcp", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("https://mcp.example:8443/mcp", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("https://mcp.example/mcp#frag", "https://mcp.example/mcp"));
    EXPECT_FALSE (resource_covers ("https://mcp.example?t=1", "https://mcp.example/mcp?t=1"));
    EXPECT_FALSE (resource_covers ("not a url", "https://mcp.example/mcp"));
}

TEST (OAuthDiscoveryRules, ALocalEndpointIsRefusedOnlyForARemoteServer) {
    using vayu::http::detail::is_refused_local_endpoint;
    const std::string remote = "https://mcp.example/mcp";
    EXPECT_TRUE (is_refused_local_endpoint (remote, "http://127.0.0.1:9000/token"));
    EXPECT_TRUE (is_refused_local_endpoint (remote, "http://localhost/authorize"));
    EXPECT_TRUE (is_refused_local_endpoint (remote, "http://[::1]:8080/token"));
    EXPECT_TRUE (is_refused_local_endpoint (remote, "http://169.254.169.254/latest"));
    EXPECT_FALSE (is_refused_local_endpoint (remote, "https://auth.example/token"));
    for (const std::string local : { "http://127.0.0.1:8000/mcp",
         "http://localhost:8000/mcp", "http://[::1]:8000/mcp" }) {
        EXPECT_FALSE (is_refused_local_endpoint (local, "http://127.0.0.1:9000/token"))
        << local;
        EXPECT_FALSE (is_refused_local_endpoint (local, "https://auth.example/token"))
        << local;
    }
}

// ============================================================================
// Discovery against an in-process server
// ============================================================================

constexpr int DISCOVERY_TIMEOUT_MS = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;

/// A clock a test moves by hand, for the cache's TTL.
class ManualClock {
    public:
    [[nodiscard]] AuthorizationServerMetadataCache::Clock reader () {
        return [this] { return now_; };
    }
    void advance (std::chrono::milliseconds by) {
        now_ += by;
    }

    private:
    std::chrono::steady_clock::time_point now_ = std::chrono::steady_clock::now ();
};

DiscoveryAnswer json_answer (const json& body) {
    return DiscoveryAnswer{ 200, body.dump (), "application/json", {} };
}

/// Authorization server metadata for @p issuer that discovery accepts.
json metadata_for (const std::string& issuer) {
    return json{ { "issuer", issuer }, { "authorization_endpoint", issuer + "/authorize" },
        { "token_endpoint", issuer + "/token" },
        { "registration_endpoint", issuer + "/register" },
        { "scopes_supported", json::array ({ "mcp:read", "mcp:write" }) },
        { "code_challenge_methods_supported", json::array ({ "plain", "S256" }) },
        { "authorization_response_iss_parameter_supported", true } };
}

json resource_metadata (const std::string& resource, const std::string& issuer) {
    return json{ { "resource", resource },
        { "authorization_servers", json::array ({ issuer }) },
        { "scopes_supported", json::array ({ "mcp:read" }) } };
}

class OAuthDiscoveryTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_oauth_discovery.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->seed_default_config ();
        // The default `proxyMode` is `environment`, and a runner that exports
        // `http_proxy` would send these fetches there instead of to loopback.
        set_config ("proxyMode", "off");
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not seeded";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    OAuthDiscoveryResult discover (const std::string& server_url) {
        return vayu::http::discover_oauth_server (
        *db_, server_url, DISCOVERY_TIMEOUT_MS, nullptr, cache_);
    }

    /// The MCP endpoint answering 401 with @p challenge.
    void challenge_with (const std::string& challenge) {
        server_.answer ("/mcp",
        DiscoveryAnswer{ 401, R"({"error":"unauthorized"})", "application/json",
        { { "WWW-Authenticate", challenge } } });
    }

    /// The well-known paths answer for `/mcp` with an issuer at `/tenant`.
    void serve_well_known () {
        server_.answer (PRM_INSERTED,
        json_answer (resource_metadata (server_.url ("/mcp"), server_.url ("/tenant"))));
        server_.answer (
        OAUTH_INSERTED, json_answer (metadata_for (server_.url ("/tenant"))));
    }

    static constexpr const char* PRM_INSERTED =
    "/.well-known/oauth-protected-resource/mcp";
    static constexpr const char* PRM_ROOT =
    "/.well-known/oauth-protected-resource";
    static constexpr const char* OAUTH_INSERTED =
    "/.well-known/oauth-authorization-server/tenant";
    static constexpr const char* OIDC_INSERTED =
    "/.well-known/openid-configuration/tenant";
    static constexpr const char* OIDC_APPENDED =
    "/tenant/.well-known/openid-configuration";

    DiscoveryServer server_;
    ManualClock clock_;
    AuthorizationServerMetadataCache cache_{ clock_.reader () };
    std::unique_ptr<vayu::db::Database> db_;
};

/// The error code of a failed discovery, or a failure naming the success.
std::string error_code_of (const OAuthDiscoveryResult& result) {
    if (result) {
        ADD_FAILURE () << "discovery succeeded for " << result->resource;
        return "";
    }
    return result.error ().code;
}

// The challenge names a URL no well-known rule would build, so only reading
// it finds the document.
//
// Mutation check: read no `WWW-Authenticate` in `locate_protected_resource`
// (always take the well-known branch) and this answers
// `oauth_discovery_resource_metadata_not_found`.
TEST_F (OAuthDiscoveryTest, AChallengesResourceMetadataLeadsToTheAuthorizationServer) {
    challenge_with (R"(Bearer realm="mcp", resource_metadata=")" +
    server_.url ("/custom/prm") + R"(", scope="mcp:read")");
    server_.answer ("/custom/prm",
    json_answer (resource_metadata (server_.url ("/mcp"), server_.url ("/tenant"))));
    server_.answer (OAUTH_INSERTED, json_answer (metadata_for (server_.url ("/tenant"))));

    const auto found = discover (server_.url ("/mcp"));
    ASSERT_HAS_VALUE (found) << found.error ().code << ": " << found.error ().message;
    EXPECT_EQ (found->resource, server_.url ("/mcp"));
    EXPECT_EQ (found->resource_metadata_url, server_.url ("/custom/prm"));
    EXPECT_TRUE (found->resource_metadata_from_challenge);
    EXPECT_EQ (found->challenge_scope, "mcp:read");
    EXPECT_EQ (found->resource_scopes_supported, std::vector<std::string>{ "mcp:read" });

    const auto& as = found->authorization_server;
    EXPECT_EQ (as.issuer, server_.url ("/tenant"));
    EXPECT_EQ (as.metadata_url, server_.url (OAUTH_INSERTED));
    EXPECT_EQ (as.authorization_endpoint, server_.url ("/tenant/authorize"));
    EXPECT_EQ (as.token_endpoint, server_.url ("/tenant/token"));
    EXPECT_EQ (as.registration_endpoint, server_.url ("/tenant/register"));
    EXPECT_EQ (as.scopes_supported, (std::vector<std::string>{ "mcp:read", "mcp:write" }));
    EXPECT_TRUE (as.authorization_response_iss_parameter_supported);

    EXPECT_EQ (server_.hits (PRM_INSERTED), 0);
    EXPECT_EQ (server_.hits (PRM_ROOT), 0);
    EXPECT_EQ (server_.last_accept ("/mcp"), "application/json");
}

TEST_F (OAuthDiscoveryTest, WithoutAChallengeTheInsertedWellKnownPathIsTriedFirst) {
    server_.answer ("/mcp", DiscoveryAnswer{ 405, "", "text/plain", {} });
    serve_well_known ();

    const auto found = discover (server_.url ("/mcp"));
    ASSERT_HAS_VALUE (found) << found.error ().message;
    EXPECT_EQ (found->resource_metadata_url, server_.url (PRM_INSERTED));
    EXPECT_FALSE (found->resource_metadata_from_challenge);
    EXPECT_EQ (found->challenge_scope, std::nullopt);
    EXPECT_EQ (server_.hits (PRM_ROOT), 0);
}

// A 401 whose challenge names no `resource_metadata` still carries a scope.
TEST_F (OAuthDiscoveryTest, TheRootWellKnownPathIsTheFallback) {
    challenge_with (R"(Bearer realm="mcp", scope="mcp:write")");
    server_.answer (PRM_ROOT,
    json_answer (resource_metadata (server_.origin (), server_.url ("/tenant"))));
    server_.answer (OAUTH_INSERTED, json_answer (metadata_for (server_.url ("/tenant"))));

    const auto found = discover (server_.url ("/mcp"));
    ASSERT_HAS_VALUE (found) << found.error ().message;
    EXPECT_EQ (found->resource_metadata_url, server_.url (PRM_ROOT));
    EXPECT_EQ (found->resource, server_.origin ());
    EXPECT_EQ (found->challenge_scope, "mcp:write");
    EXPECT_EQ (server_.hits (PRM_INSERTED), 1);
}

// Mutation check: drop the two OpenID Connect URLs from
// `authorization_server_metadata_urls` and both of these answer
// `oauth_discovery_authorization_server_metadata_not_found`.
TEST_F (OAuthDiscoveryTest, OpenIdConnectDiscoveryIsTheFallbackForRfc8414) {
    serve_well_known ();
    server_.answer (OAUTH_INSERTED, DiscoveryAnswer{ 404, "", "text/plain", {} });
    server_.answer (OIDC_INSERTED, json_answer (metadata_for (server_.url ("/tenant"))));

    const auto found = discover (server_.url ("/mcp"));
    ASSERT_HAS_VALUE (found) << found.error ().message;
    EXPECT_EQ (found->authorization_server.metadata_url, server_.url (OIDC_INSERTED));
    EXPECT_EQ (server_.hits (OAUTH_INSERTED), 1);
    EXPECT_EQ (server_.hits (OIDC_APPENDED), 0);
}

TEST_F (OAuthDiscoveryTest, TheAppendedOpenIdConnectPathIsTriedLast) {
    serve_well_known ();
    server_.answer (OAUTH_INSERTED, DiscoveryAnswer{ 404, "", "text/plain", {} });
    server_.answer (OIDC_APPENDED, json_answer (metadata_for (server_.url ("/tenant"))));

    const auto found = discover (server_.url ("/mcp"));
    ASSERT_HAS_VALUE (found) << found.error ().message;
    EXPECT_EQ (found->authorization_server.metadata_url, server_.url (OIDC_APPENDED));
    EXPECT_EQ (server_.hits (OIDC_INSERTED), 1);
}

TEST_F (OAuthDiscoveryTest, NoMetadataAnywhereNamesEveryURLTried) {
    serve_well_known ();
    server_.answer (OAUTH_INSERTED, DiscoveryAnswer{ 404, "", "text/plain", {} });

    const auto found = discover (server_.url ("/mcp"));
    EXPECT_EQ (error_code_of (found), codes::AUTHORIZATION_SERVER_METADATA_NOT_FOUND);
    ASSERT_FALSE (found.has_value ());
    for (const char* path : { OAUTH_INSERTED, OIDC_INSERTED, OIDC_APPENDED }) {
        EXPECT_NE (found.error ().message.find (server_.url (path)), std::string::npos)
        << found.error ().message;
    }
}

// Mutation check: drop the `S256` test in `refuse_authorization_server` and
// both cases are discovered.
TEST_F (OAuthDiscoveryTest, AServerThatDoesNotAdvertiseS256IsRefused) {
    serve_well_known ();
    json plain_only = metadata_for (server_.url ("/tenant"));
    plain_only["code_challenge_methods_supported"] = json::array ({ "plain" });
    server_.answer (OAUTH_INSERTED, json_answer (plain_only));
    const auto refused = discover (server_.url ("/mcp"));
    EXPECT_EQ (error_code_of (refused), codes::PKCE_UNSUPPORTED);
    if (!refused) {
        EXPECT_NE (refused.error ().message.find ("it lists plain"), std::string::npos)
        << refused.error ().message;
    }

    // The MCP spec reads an absent list as no PKCE at all.
    json unlisted = metadata_for (server_.url ("/tenant"));
    unlisted.erase ("code_challenge_methods_supported");
    server_.answer (OAUTH_INSERTED, json_answer (unlisted));
    AuthorizationServerMetadataCache fresh;
    const auto absent = vayu::http::discover_oauth_server (
    *db_, server_.url ("/mcp"), DISCOVERY_TIMEOUT_MS, nullptr, fresh);
    EXPECT_EQ (error_code_of (absent), codes::PKCE_UNSUPPORTED);
}

// Mutation check: drop the `issuer` comparison in
// `authorization_server_metadata` and this is discovered.
TEST_F (OAuthDiscoveryTest, MetadataNamingAnotherIssuerIsRefused) {
    serve_well_known ();
    server_.answer (OAUTH_INSERTED, json_answer (metadata_for (server_.url ("/other"))));

    const auto found = discover (server_.url ("/mcp"));
    EXPECT_EQ (error_code_of (found), codes::ISSUER_MISMATCH);
    // A refused document is not cached for the next discovery to reuse.
    server_.answer (OAUTH_INSERTED, json_answer (metadata_for (server_.url ("/tenant"))));
    EXPECT_TRUE (discover (server_.url ("/mcp")).has_value ());
}

// Mutation check: make `resource_covers` answer true and these are discovered.
TEST_F (OAuthDiscoveryTest, AResourceThatDoesNotCoverTheServerIsRefused) {
    serve_well_known ();
    for (const std::string& resource :
    { std::string ("https://elsewhere.example/mcp"), server_.url ("/other") }) {
        server_.answer (PRM_INSERTED,
        json_answer (resource_metadata (resource, server_.url ("/tenant"))));
        EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))), codes::RESOURCE_MISMATCH)
        << resource;
    }
}

// Mutation check: answer `cache.find` with nullopt and the second discovery
// fetches the metadata again.
TEST_F (OAuthDiscoveryTest, CachedMetadataIsNotFetchedAgainUntilItExpires) {
    serve_well_known ();
    ASSERT_HAS_VALUE (discover (server_.url ("/mcp")));
    ASSERT_HAS_VALUE (discover (server_.url ("/mcp")));
    EXPECT_EQ (server_.hits (OAUTH_INSERTED), 1);
    // The protected resource metadata is per server, and read every time.
    EXPECT_EQ (server_.hits (PRM_INSERTED), 2);

    clock_.advance (codes::CACHE_TTL);
    ASSERT_HAS_VALUE (discover (server_.url ("/mcp")));
    EXPECT_EQ (server_.hits (OAUTH_INSERTED), 2);
}

TEST_F (OAuthDiscoveryTest, AMemberOfTheWrongTypeRefusesTheDocument) {
    serve_well_known ();
    json servers_as_string =
    resource_metadata (server_.url ("/mcp"), server_.url ("/tenant"));
    servers_as_string["authorization_servers"] = server_.url ("/tenant");
    server_.answer (PRM_INSERTED, json_answer (servers_as_string));
    EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))), codes::INVALID_RESOURCE_METADATA);

    serve_well_known ();
    json numeric_endpoint              = metadata_for (server_.url ("/tenant"));
    numeric_endpoint["token_endpoint"] = 42;
    server_.answer (OAUTH_INSERTED, json_answer (numeric_endpoint));
    EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))),
    codes::INVALID_AUTHORIZATION_SERVER_METADATA);

    json script_endpoint = metadata_for (server_.url ("/tenant"));
    script_endpoint["authorization_endpoint"] = "javascript:alert(1)";
    server_.answer (OAUTH_INSERTED, json_answer (script_endpoint));
    EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))),
    codes::INVALID_AUTHORIZATION_SERVER_METADATA);

    server_.answer (
    OAUTH_INSERTED, DiscoveryAnswer{ 200, "<html></html>", "text/html", {} });
    EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))),
    codes::INVALID_AUTHORIZATION_SERVER_METADATA);
}

TEST_F (OAuthDiscoveryTest, AChallengeNamingANonHttpURLIsRefused) {
    challenge_with (R"(Bearer resource_metadata="file:///etc/passwd")");
    EXPECT_EQ (error_code_of (discover (server_.url ("/mcp"))), codes::INVALID_CHALLENGE);
}

TEST_F (OAuthDiscoveryTest, AServerURLThatIsNotHttpIsRefusedBeforeAnyFetch) {
    for (const std::string url : { "ftp://example.com/mcp", "not a url", "" }) {
        EXPECT_EQ (error_code_of (discover (url)), codes::INVALID_SERVER_URL) << url;
    }
    EXPECT_EQ (server_.total_hits (), 0);
}

TEST_F (OAuthDiscoveryTest, ACancelledDiscoveryFetchesNothing) {
    serve_well_known ();
    const std::atomic<bool> cancelled{ true };
    const auto found = vayu::http::discover_oauth_server (
    *db_, server_.url ("/mcp"), DISCOVERY_TIMEOUT_MS, &cancelled, cache_);
    EXPECT_EQ (error_code_of (found), codes::NETWORK_ERROR);
    EXPECT_EQ (server_.total_hits (), 0);
}

// A server that is not on this machine, reached through a proxy that stands
// for one that can resolve its name: the documents it serves come from the
// fixture on loopback, and every URL they name is judged by its text.
//
// Mutation check: make `is_refused_local_endpoint` answer false and the two
// refusals are discovered.
class RemoteOAuthDiscoveryTest : public OAuthDiscoveryTest {
    protected:
    void SetUp () override {
        OAuthDiscoveryTest::SetUp ();
        proxy_.forward_every_target_to (server_.origin ());
        set_config ("proxyMode", "manual");
        set_config ("proxyUrl", proxy_.url ());
        server_.answer ("/mcp",
        DiscoveryAnswer{ 401, "", "text/plain",
        { { "WWW-Authenticate", "Bearer realm=\"mcp\"" } } });
        server_.answer (PRM_INSERTED,
        json_answer (resource_metadata (REMOTE_MCP, REMOTE_ISSUER)));
        server_.answer (OAUTH_ROOT, json_answer (metadata_for (REMOTE_ISSUER)));
    }

    static constexpr const char* REMOTE_MCP    = "http://mcp.example.test/mcp";
    static constexpr const char* REMOTE_ISSUER = "http://auth.example.test";
    static constexpr const char* OAUTH_ROOT =
    "/.well-known/oauth-authorization-server";

    vayu::tests::MockProxy proxy_;
};

TEST_F (RemoteOAuthDiscoveryTest, ARemoteServerNamingRemoteEndpointsIsDiscovered) {
    const auto found = discover (REMOTE_MCP);
    ASSERT_HAS_VALUE (found) << found.error ().code << ": " << found.error ().message;
    EXPECT_EQ (found->authorization_server.token_endpoint,
    std::string (REMOTE_ISSUER) + "/token");
    EXPECT_GE (proxy_.count (), 3U);
}

TEST_F (RemoteOAuthDiscoveryTest, ARemoteServerMayNotNameALoopbackEndpoint) {
    json local_token              = metadata_for (REMOTE_ISSUER);
    local_token["token_endpoint"] = server_.url ("/token");
    server_.answer (OAUTH_ROOT, json_answer (local_token));
    const auto found = discover (REMOTE_MCP);
    EXPECT_EQ (error_code_of (found), codes::LOCAL_ENDPOINT_REFUSED);
    if (!found) {
        EXPECT_NE (found.error ().message.find (server_.url ("/token")), std::string::npos)
        << found.error ().message;
    }
}

// Metadata fetched for a server on this machine ran without the peer rule, so
// a remote server naming the same issuer fetches it again; the other way
// round the cached copy is good for both.
//
// Mutation check: drop `needs_peer_rule` from `AuthorizationServerMetadataCache::find`
// and the remote discovery reuses the local fetch.
TEST_F (RemoteOAuthDiscoveryTest, MetadataFetchedForALocalServerIsNotReusedForARemoteOne) {
    server_.answer ("/.well-known/oauth-protected-resource/local-mcp",
    json_answer (resource_metadata (server_.url ("/local-mcp"), REMOTE_ISSUER)));
    ASSERT_HAS_VALUE (discover (server_.url ("/local-mcp")));
    ASSERT_HAS_VALUE (discover (REMOTE_MCP));
    EXPECT_EQ (server_.hits (OAUTH_ROOT), 2);

    ASSERT_HAS_VALUE (discover (REMOTE_MCP));
    ASSERT_HAS_VALUE (discover (server_.url ("/local-mcp")));
    EXPECT_EQ (server_.hits (OAUTH_ROOT), 2);
}

TEST_F (RemoteOAuthDiscoveryTest, ARemoteServersChallengeMayNotNameALoopbackDocument) {
    server_.answer ("/mcp",
    DiscoveryAnswer{ 401, "", "text/plain",
    { { "WWW-Authenticate",
    "Bearer resource_metadata=\"" + server_.url ("/custom/prm") + "\"" } } });
    server_.answer (
    "/custom/prm", json_answer (resource_metadata (REMOTE_MCP, REMOTE_ISSUER)));
    EXPECT_EQ (error_code_of (discover (REMOTE_MCP)), codes::LOCAL_ENDPOINT_REFUSED);
    EXPECT_EQ (server_.hits ("/custom/prm"), 0);
}

} // namespace
