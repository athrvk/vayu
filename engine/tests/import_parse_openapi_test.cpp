/**
 * @file tests/import_parse_openapi_test.cpp
 * @brief OpenAPI and Swagger imports: servers and base URLs, security schemes, `x-vayu` elements,
 * request bodies, folder order and response examples.
 *
 * The helpers more than one of these files reads are in `import_parse_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/import_document.hpp"

#include "import_parse_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::ImportSource;
using vayu::core::parse_import;
using vayu::tests::import_parse::first_request;
using vayu::tests::import_parse::header_pairs;
using vayu::tests::import_parse::HeaderPairs;
using vayu::tests::import_parse::Names;
using vayu::tests::import_parse::skip_counts;
using vayu::tests::import_parse::skipped_count;
using vayu::tests::import_parse::skipped_named;

TEST (ImportParse, GatingTheOptionsChangesWhatTheCountsPromise) {
    const std::string document = R"({"_postman_variable_scope":"environment","name":"Prod",
        "values":[{"key":"host","value":"x"}]})";
    ImportOptions off;
    off.import_environments = false;

    const ImportParse on    = parse_import (document, {}, {});
    const ImportParse gated = parse_import (document, off, {});
    ASSERT_TRUE (on.ok ());
    ASSERT_TRUE (gated.ok ());
    EXPECT_EQ (on.result.at ("meta").at ("environmentCount"), 1);
    // Gated at parse time rather than stripped afterwards, so the preview counts
    // what will actually be created.
    EXPECT_EQ (gated.result.at ("meta").at ("environmentCount"), 0);
    EXPECT_TRUE (gated.result.at ("environments").empty ());
}

/**
 * A relative `servers[0].url` against the URL the document was fetched from -
 * `new URL(reference, base)`, which the engine has to answer itself.
 *
 * The corpus covers the ordinary case (`../v2`); these are the shapes a
 * segment-wise resolver gets wrong, and each one changes the host a request
 * would reach. A base with no scheme is `new URL`'s `TypeError`, which the
 * caller reports as an unresolved base rather than guessing.
 */
TEST (ImportParse, ResolvesARelativeServerUrlAgainstTheDocumentsOwn) {
    const auto base_url = [] (const std::string& server, const std::string& source) {
        ImportSource from;
        from.source_url          = source;
        const ImportParse parsed = parse_import (
        R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":")" + server + R"("}],"paths":{}})",
        {}, from);
        EXPECT_TRUE (parsed.ok ()) << parsed.error;
        const json variables =
        json::parse (parsed.result.at ("collections")[0].at ("variables").dump ());
        return variables.contains ("baseUrl") ?
        variables.at ("baseUrl").at ("value").get<std::string> () :
        std::string ();
    };

    const std::string source = "https://api.example.com/specs/v1/openapi.yaml";
    EXPECT_EQ (base_url ("/v3", source), "https://api.example.com/v3");
    EXPECT_EQ (base_url ("api", source), "https://api.example.com/specs/v1/api");
    EXPECT_EQ (base_url ("../../v2", source), "https://api.example.com/v2");
    // `/specs/v1/..` resolves to `/specs/`; the slash that resolution keeps is
    // then trimmed like any other (issue #3029), since a request path follows.
    EXPECT_EQ (base_url ("..", source), "https://api.example.com/specs");
    EXPECT_EQ (base_url ("//other.example.com/v1", source), "https://other.example.com/v1");
    // Already absolute: nothing to resolve against.
    EXPECT_EQ (base_url ("https://other.example.com/v1", source), "https://other.example.com/v1");
    // A base that is not absolute resolves nothing; the URL imports as written.
    EXPECT_EQ (base_url ("/v3", "not-a-url"), "/v3");
}

/**
 * Every imported request is `{{baseUrl}}` + a path that starts with `/`, so a
 * base URL that ends in `/` sent each one to `//path` (issue #3029). Both
 * dialects trim it; what is not a path is left alone - the `//` after a scheme
 * and a lone `/`. Mutation check: returning `url` unchanged from
 * `without_trailing_slashes` fails every trimmed expectation.
 */
TEST (ImportParse, TrimsTheTrailingSlashFromTheBaseUrlInBothDialects) {
    const auto base_url = [] (const std::string& document, const std::string& source = "") {
        ImportSource from;
        from.source_url          = source;
        const ImportParse parsed = parse_import (document, {}, from);
        EXPECT_TRUE (parsed.ok ()) << parsed.error;
        const json variables =
        json::parse (parsed.result.at ("collections")[0].at ("variables").dump ());
        return variables.contains ("baseUrl") ?
        variables.at ("baseUrl").at ("value").get<std::string> () :
        std::string ();
    };
    const auto v3 = [&] (const std::string& server, const std::string& source = "") {
        return base_url (R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":")" +
        server + R"("}],"paths":{}})",
        source);
    };
    const auto v2 = [&] (const std::string& base_path) {
        return base_url (R"({"swagger":"2.0","info":{"title":"T"},"host":"h","basePath":")" +
        base_path + R"(","paths":{}})");
    };

    EXPECT_EQ (v3 ("https://h/v1/"), "https://h/v1");
    EXPECT_EQ (v3 ("https://h/"), "https://h");
    EXPECT_EQ (v3 ("https://h/v1//"), "https://h/v1");
    EXPECT_EQ (v3 ("https://h/v1"), "https://h/v1");
    // A relative URL is trimmed after it resolves, not before.
    EXPECT_EQ (v3 ("/v3/", "https://api.example.com/specs/openapi.yaml"),
    "https://api.example.com/v3");
    // The slashes after a scheme are not a path.
    EXPECT_EQ (v3 ("https://"), "https://");
    // A lone `/` with nothing to resolve against is kept as written.
    EXPECT_EQ (v3 ("/"), "/");

    EXPECT_EQ (v2 ("/v2/"), "https://h/v2");
    EXPECT_EQ (v2 ("/v2//"), "https://h/v2");
    EXPECT_EQ (v2 ("/v2"), "https://h/v2");
    EXPECT_EQ (v2 ("/"), "https://h");
}

/// Trimming the slash does not turn an unresolved base into a resolved one.
TEST (ImportParse, KeepsCountingAnUnresolvedBaseUrlWhoseSlashIsTrimmed) {
    const ImportParse parsed = parse_import (
    R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":"/api/"}],"paths":{}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")),
    (json{ { "unresolved_base_url", 1 } }));
}

/**
 * A round trip of the skeleton export's own `{{baseUrl}}` fix (issue #1441):
 * a single-brace server variable with a declared default substitutes to
 * exactly that default, rather than the self-referential value a bare
 * `{{baseUrl}}` with no declared variable used to produce.
 */
TEST (ImportParse, ResolvesATemplatedServerUrlFromItsOwnDeclaredDefault) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "servers":[{"url":"{baseUrl}",
        "variables":{"baseUrl":{"default":"https://api.example.com"}}}],
        "paths":{}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json variables =
    json::parse (parsed.result.at ("collections")[0].at ("variables").dump ());
    EXPECT_EQ (variables.at ("baseUrl").at ("value"), "https://api.example.com");
}

/**
 * A document that names no server URL imports with `{{baseUrl}}` undefined, and
 * says so as `no_server_url` (issue #2450) - every shape of "no server": no
 * `servers`, an empty array, a first entry with no `url`, an empty `url`, and
 * Swagger 2.0 with no `host`. Nothing is invented in its place.
 */
TEST (ImportParse, CountsADocumentWithNoServerUrlAndCreatesNoBaseUrl) {
    const std::vector<std::string> documents = {
        R"({"openapi":"3.0.0","info":{"title":"T"},"paths":{}})",
        R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[],"paths":{}})",
        R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{}],"paths":{}})",
        R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":""}],"paths":{}})",
        R"({"swagger":"2.0","info":{"title":"T"},"paths":{}})",
        R"({"swagger":"2.0","info":{"title":"T"},"host":"","paths":{}})",
    };
    for (const std::string& document : documents) {
        SCOPED_TRACE (document);
        const ImportParse parsed = parse_import (document, {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const json skipped = parsed.result.at ("meta").at ("skipped");
        ASSERT_FALSE (skipped.empty ());
        EXPECT_EQ (skip_counts (skipped), (json{ { "no_server_url", 1 } }));
        EXPECT_FALSE (
        parsed.result.at ("collections")[0].at ("variables").contains ("baseUrl"));
    }
}

/// A server URL the document did write is never `no_server_url`: a complete one
/// counts nothing, and a templated one with no default stays
/// `unresolved_base_url` alone.
TEST (ImportParse, DoesNotCountNoServerUrlWhenTheDocumentWroteOne) {
    const ImportParse complete = parse_import (
    R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":"https://x"}],"paths":{}})",
    {}, {});
    ASSERT_TRUE (complete.ok ()) << complete.error;
    EXPECT_TRUE (skip_counts (complete.result.at ("meta").at ("skipped")).empty ());

    const ImportParse templated = parse_import (
    R"({"openapi":"3.0.0","info":{"title":"T"},"servers":[{"url":"{scheme}://api.example.com"}],"paths":{}})",
    {}, {});
    ASSERT_TRUE (templated.ok ()) << templated.error;
    EXPECT_EQ (skip_counts (templated.result.at ("meta").at ("skipped")),
    (json{ { "unresolved_base_url", 1 } }));

    const ImportParse swagger = parse_import (
    R"({"swagger":"2.0","info":{"title":"T"},"host":"api.example.com","paths":{}})",
    {}, {});
    ASSERT_TRUE (swagger.ok ()) << swagger.error;
    EXPECT_TRUE (skip_counts (swagger.result.at ("meta").at ("skipped")).empty ());
}

/**
 * A JSON body's `example` is written as a plain string when the source text
 * is not valid JSON on its own - typically a `{{variable}}` token a JSON
 * parser cannot see through. Reading it back must return that text verbatim,
 * not re-quote it into a JSON string literal (issue #1441).
 */
TEST (ImportParse, ReadsATemplatedJsonBodyExampleVerbatimRatherThanReQuotingIt) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"post":{"requestBody":{"content":{"application/json":{
        "example":"{\"amount\": {{amount}}}"}}},"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& body =
    first_request (parsed.result.at ("collections")[0]).at ("body");
    EXPECT_EQ (body.at ("mode"), "json");
    EXPECT_EQ (body.at ("content"), R"({"amount": {{amount}}})");
}

TEST (ImportParse, ReadsATextPlainRequestBodyExampleBackIntoItsContent) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"post":{"requestBody":{"content":{"text/plain":{
        "example":"hello world"}}},"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& body =
    first_request (parsed.result.at ("collections")[0]).at ("body");
    EXPECT_EQ (body.at ("mode"), "text");
    EXPECT_EQ (body.at ("content"), "hello world");
}

/**
 * `x-vayu-enabled`, which a Vayu skeleton export writes on every Params and
 * Headers row (issue #1441), is trusted over the `required`/non-empty-value
 * heuristic used for a document Vayu did not write - the heuristic cannot
 * tell a disabled row with a value from an enabled one with none.
 */
TEST (ImportParse, TrustsAnExplicitEnabledMarkerOverTheValuePresenceHeuristic) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"parameters":[
            {"name":"verbose","in":"query","example":"1","x-vayu-enabled":false},
            {"name":"tag","in":"query","x-vayu-enabled":true}
        ],"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& params =
    first_request (parsed.result.at ("collections")[0]).at ("params");
    EXPECT_EQ (params[0].at ("key"), "verbose");
    EXPECT_EQ (params[0].at ("enabled"), false);
    EXPECT_EQ (params[1].at ("key"), "tag");
    EXPECT_EQ (params[1].at ("enabled"), true);
}

/**
 * An operation declared `security: []` is OpenAPI's explicit "this operation
 * takes no auth" (issue #1444) - before this fix every operation imported as
 * `inherit` regardless, so a request the document says takes none would have
 * sent the collection's bearer token. The optional-security spelling `[{}]` is
 * answered the same as `[]`. Mutation check: dropping the empty-array branch
 * in `operation_auth_override` reds the `[]` case back to `inherit`.
 */
TEST (ImportParse, OperationSecurityEmptyImportsWithNoAuth) {
    for (const std::string security : { "[]", "[{}]" }) {
        SCOPED_TRACE ("security: " + security);
        const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}}},
        "security":[{"bearerAuth":[]}],
        "paths":{"/public":{"get":{"security":)" +
        security + R"(,"responses":{}}}}})",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const nlohmann::ordered_json& auth =
        first_request (parsed.result.at ("collections")[0]).at ("auth");
        EXPECT_EQ (auth.at ("mode"), "none");
    }
}

/**
 * An operation naming a scheme other than the collection's own gets that
 * scheme's mapped mode, not the collection's (issue #1444).
 */
TEST (ImportParse, OperationSecurityNamingADifferentSchemeGetsThatSchemesMode) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{
            "bearerAuth":{"type":"http","scheme":"bearer"},
            "basicAuth":{"type":"http","scheme":"basic"}
        }},
        "security":[{"bearerAuth":[]}],
        "paths":{"/admin":{"delete":{"security":[{"basicAuth":[]}],"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& auth =
    first_request (parsed.result.at ("collections")[0]).at ("auth");
    EXPECT_EQ (auth.at ("mode"), "basic");
}

/**
 * An operation naming exactly the scheme the collection already took is
 * redundant with `inherit` and answered as `inherit` rather than as a
 * duplicate, explicit mode (issue #1444). Mutation check: removing the
 * `scheme_name == collection_scheme.name` guard in `operation_auth_override`
 * reds this to `bearer` instead.
 */
TEST (ImportParse, OperationSecurityNamingTheCollectionsOwnSchemeStaysInherited) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}}},
        "security":[{"bearerAuth":[]}],
        "paths":{"/orders":{"get":{"security":[{"bearerAuth":[]}],"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& auth =
    first_request (parsed.result.at ("collections")[0]).at ("auth");
    EXPECT_EQ (auth.at ("mode"), "inherit");
}

/**
 * A scheme type Vayu has no mode for (`mutualTLS`), an OR of alternatives, and
 * an AND of multiple schemes all stay `inherit` - the safe default - and each
 * is counted under its own `security_unmapped_*` kind rather than one shared
 * bucket (issue #1444). Mutation check: folding the three `tally.add` calls in
 * `operation_auth_override` back onto one literal reds this to three separate
 * kinds each missing, or `security_unmapped_type` picking up the OR/AND cases
 * `unmapped_security_kind` never sees.
 */
TEST (ImportParse, OperationSecurityItCannotMapStaysInheritedAndIsCounted) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{
            "bearerAuth":{"type":"http","scheme":"bearer"},
            "basicAuth":{"type":"http","scheme":"basic"},
            "mtls":{"type":"mutualTLS"}
        }},
        "security":[{"bearerAuth":[]}],
        "paths":{
            "/mtls-only":{"get":{"tags":["ops"],"security":[{"mtls":[]}],"responses":{}}},
            "/either":{"get":{"tags":["ops"],
                "security":[{"bearerAuth":[]},{"basicAuth":[]}],"responses":{}}},
            "/both":{"get":{"tags":["ops"],
                "security":[{"bearerAuth":[],"basicAuth":[]}],"responses":{}}}
        }})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    // All three share the `ops` tag, so all three land in one folder rather
    // than at root (issue #710) - grouped deliberately, so the loop below sees
    // every one of them.
    const nlohmann::ordered_json& folder =
    parsed.result.at ("collections")[0].at ("children")[0];
    ASSERT_EQ (folder.at ("requests").size (), 3u);
    for (const nlohmann::ordered_json& request : folder.at ("requests")) {
        EXPECT_EQ (request.at ("auth").at ("mode"), "inherit") << request.at ("url");
    }
    const nlohmann::json counts =
    skip_counts (parsed.result.at ("meta").at ("skipped"));
    EXPECT_EQ (counts.at ("security_unmapped_mutualtls"), 1);
    EXPECT_EQ (counts.at ("security_unmapped_or"), 1);
    EXPECT_EQ (counts.at ("security_unmapped_and"), 1);
    EXPECT_FALSE (counts.contains ("security_unmapped_type"));
}

/**
 * An operation naming a scheme the document never declares is a fourth,
 * distinct reason `security` cannot resolve to one mode - counted under its
 * own kind rather than folded into the type-mapping bucket (issue #1444).
 * Mutation check: reverting the `security_unmapped_scheme` call back to the
 * flat literal reds this to whatever kind that literal now spells.
 */
TEST (ImportParse, OperationSecurityNamingAnUndeclaredSchemeStaysInheritedAndIsCounted) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}}},
        "security":[{"bearerAuth":[]}],
        "paths":{"/ghost":{"get":{"security":[{"noSuchScheme":[]}],"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& auth =
    first_request (parsed.result.at ("collections")[0]).at ("auth");
    EXPECT_EQ (auth.at ("mode"), "inherit");
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("security_unmapped_scheme"),
    1);
}

/**
 * A 3.x `apiKey` scheme placed in a cookie has no slot in Vayu's apikey mode
 * (only header/query) - reinterpreting it as a header would send the
 * credential somewhere the document never named, so it stays unmapped and
 * counted under its own kind rather than silently becoming a header (issue
 * #1444). Mutation check: dropping the `*in == "cookie"` guard in
 * `scheme_to_auth_v3` reds this to `apikey`/`header`.
 */
TEST (ImportParse, ApiKeySchemeInACookieStaysUnmappedRatherThanBecomingAHeader) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{
            "cookieAuth":{"type":"apiKey","in":"cookie","name":"session"}}},
        "security":[{"cookieAuth":[]}],
        "paths":{"/x":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& collection = parsed.result.at ("collections")[0];
    EXPECT_EQ (collection.at ("auth").at ("mode"), "none");
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("security_unmapped_apikey_cookie"),
    1);
}

/**
 * An oauth2 scheme whose `flows` names none of the specification's four -
 * a malformed document - must not fabricate a plausible-looking
 * client_credentials config with blank URLs, since that would be
 * indistinguishable from a genuinely declared one (issue #1444). Mutation
 * check: reverting the `map_openapi_v3_oauth2`/`map_swagger_oauth2` else
 * branches to `oauth2_auth (openapi_oauth2_base ())` reds `auth.mode` to
 * `"oauth2"` with nothing counted.
 */
TEST (ImportParse, Oauth2WithNoRecognisedFlowStaysUnmappedRatherThanFabricatingAConfig) {
    const ImportParse v3 = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{"o":{"type":"oauth2","flows":{}}}},
        "security":[{"o":[]}],
        "paths":{"/x":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (v3.ok ()) << v3.error;
    EXPECT_EQ (v3.result.at ("collections")[0].at ("auth").at ("mode"), "none");
    EXPECT_EQ (
    skip_counts (v3.result.at ("meta").at ("skipped")).at ("security_unmapped_type"), 1);

    const ImportParse v2 = parse_import (R"({"swagger":"2.0","info":{"title":"T"},
        "securityDefinitions":{"o":{"type":"oauth2","flow":"bogus"}},
        "security":[{"o":[]}],
        "paths":{"/x":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (v2.ok ()) << v2.error;
    EXPECT_EQ (v2.result.at ("collections")[0].at ("auth").at ("mode"), "none");
    EXPECT_EQ (
    skip_counts (v2.result.at ("meta").at ("skipped")).at ("security_unmapped_type"), 1);
}

/// A 3.x OAuth flow's `refreshUrl` lands in `OAuth2Config.refreshTokenUrl`,
/// the same field Postman's own oauth2 import already fills (issue #1444).
TEST (ImportParse, OAuthFlowRefreshUrlIsRead) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "components":{"securitySchemes":{"o":{"type":"oauth2","flows":{
            "authorizationCode":{"authorizationUrl":"https://a","tokenUrl":"https://t",
                "refreshUrl":"https://r","scopes":{}}}}}},
        "security":[{"o":[]}],
        "paths":{"/x":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("collections")[0].at ("auth").at ("config").at ("refreshTokenUrl"),
    "https://r");
}

/**
 * A 3.1 top-level `webhooks` entry describes what the API sends *to* a
 * callback, not a request Vayu can send - counted rather than silently
 * imported as zero requests with nothing said (issue #1444). Mutation check:
 * removing the `note_webhook_operations` call in `walk_operations` reds this
 * to an empty `skipped` list.
 */
TEST (ImportParse, WebhookOperationsAreCountedNotSilentlyDropped) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.1.0","info":{"title":"T"},
        "webhooks":{"newPet":{"post":{"responses":{}}},"deletedPet":{"post":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("requestCount"), 0);
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("webhook_operations"), 2);
}

TEST (ImportParse, NamesTheRequestsACountIsAbout) {
    const ImportParse spec = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "servers":[{"url":"https://a.example.com"},{"url":"https://b.example.com"}],
        "components":{"securitySchemes":{"k":{"type":"apiKey","in":"header","name":"X"},
            "b":{"type":"http","scheme":"bearer"}}},
        "paths":{"/pet/{id}/image":{"post":{"summary":"Upload an image",
            "requestBody":{"content":{"application/octet-stream":{}}},"responses":{}}},
          "/pet/{id}":{"get":{"summary":"Find pet by ID","security":[{"k":[]},{"b":[]}],
            "responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (spec.ok ()) << spec.error;
    EXPECT_EQ (skipped_named (spec, "file_body"), Names{ "Upload an image" });
    EXPECT_EQ (skipped_named (spec, "security_unmapped_or"), Names{ "Find pet by ID" });
    // A second server is the document's, not any request's.
    EXPECT_EQ (skipped_named (spec, "servers_dropped"), Names{});

    const ImportParse postman = parse_import (R"({"info":{"name":"P",
        "schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item":[{"name":"Signed","request":{"method":"GET","url":"https://x.test",
                 "auth":{"type":"kerberos"}}},
                {"name":"Plain","request":{"method":"GET","url":"https://x.test"}},
                {"name":"Also signed","request":{"method":"GET","url":"https://x.test",
                 "auth":{"type":"negotiate"}}},
                {"name":"Digest","request":{"method":"GET","url":"https://x.test",
                 "auth":{"type":"digest"}}}]})",
    {}, {});
    ASSERT_TRUE (postman.ok ()) << postman.error;
    EXPECT_EQ (skipped_named (postman, "unsupported_auth"),
    (Names{ "Signed", "Also signed" }));
    EXPECT_EQ (postman.result.at ("meta").at ("nonExecutableAuthRequests").get<Names> (),
    Names{ "Digest" });
}

/// An operation's `deprecated: true` has nowhere to land on Vayu's request
/// model, so it is counted rather than imported identically to a current
/// operation with nothing said (issue #1444).
TEST (ImportParse, DeprecatedOperationIsCounted) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/old":{"get":{"deprecated":true,"responses":{}}},
                 "/new":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("deprecated_operation"), 1);
}

/// A 3.x parameter naming `content` instead of `schema` (a value that needs a
/// media type to parse, e.g. a JSON object serialized into a query string)
/// still gets an example value rather than importing empty/disabled (issue
/// #1444).
TEST (ImportParse, ParameterContentIsReadWhenSchemaIsAbsent) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/x":{"get":{"parameters":[
            {"name":"filter","in":"query","content":{"application/json":{
                "schema":{"type":"string"},"example":"active"}}}],
            "responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& params =
    first_request (parsed.result.at ("collections")[0]).at ("params");
    ASSERT_EQ (params.size (), 1u);
    EXPECT_EQ (params[0].at ("key"), "filter");
    EXPECT_EQ (params[0].at ("value"), "active");
    EXPECT_TRUE (params[0].at ("enabled").get<bool> ());
}

/// 3.1's JSON-Schema-2020-12 tuple form (`prefixItems`, no `items`) samples
/// each position rather than an empty array (issue #1444).
TEST (ImportParse, PrefixItemsSamplesEachTuplePosition) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.1.0","info":{"title":"T"},
        "paths":{"/x":{"post":{"requestBody":{"content":{"application/json":{"schema":{
            "type":"array","prefixItems":[{"type":"string"},{"type":"integer"}]}}}},
            "responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& body =
    first_request (parsed.result.at ("collections")[0]).at ("body");
    const nlohmann::json sampled =
    nlohmann::json::parse (body.at ("content").get<std::string> ());
    ASSERT_TRUE (sampled.is_array ());
    EXPECT_EQ (sampled.size (), 2u);
}

/// An operation with no `security` key at all keeps today's answer.
TEST (ImportParse, OperationWithNoSecurityKeyInheritsAndCountsNothing) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "servers":[{"url":"https://api.example.com"}],
        "components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}}},
        "security":[{"bearerAuth":[]}],
        "paths":{"/pets":{"get":{"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& auth =
    first_request (parsed.result.at ("collections")[0]).at ("auth");
    EXPECT_EQ (auth.at ("mode"), "inherit");
    EXPECT_TRUE (skip_counts (parsed.result.at ("meta").at ("skipped")).empty ());
}

/// The same per-operation `security` rule applies to Swagger 2.0's
/// `securityDefinitions`, not only to 3.x's `securitySchemes`.
TEST (ImportParse, OperationSecurityIsReadForSwagger20Too) {
    const ImportParse parsed = parse_import (R"({"swagger":"2.0","info":{"title":"T"},
        "host":"api.example.com",
        "securityDefinitions":{"basicAuth":{"type":"basic"}},
        "security":[{"basicAuth":[]}],
        "paths":{"/public":{"get":{"security":[],"responses":{}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& auth =
    first_request (parsed.result.at ("collections")[0]).at ("auth");
    EXPECT_EQ (auth.at ("mode"), "none");
}

/**
 * A `servers` array past the first entry names no environment an import
 * creates; it is counted as `servers_dropped` rather than silently ignored
 * (issue #1444).
 */
TEST (ImportParse, CountsEveryServerPastTheFirstAsDropped) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "servers":[
            {"url":"https://api.example.com"},
            {"url":"https://staging.example.com"},
            {"url":"https://dev.example.com"}
        ],
        "paths":{}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("servers_dropped"), 2);
}

/// `x-vayu-elements` (issue #1518) round-trips into the imported request's
/// own `elements` array, validated against the same registry a stored
/// request's write goes through.
TEST (ImportParse, ReadsXVayuElementsIntoTheImportedRequest) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{},
        "x-vayu-elements":[{"id":"el_1","kind":"extract.json","enabled":true,
        "config":{"path":"$.id","variable":"petId"}}]}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    ASSERT_TRUE (request.contains ("elements"));
    EXPECT_EQ (request.at ("elements")[0].at ("kind"), "extract.json");
}

/// `x-vayu-mock` (issue #1649) resolves its `"fixed"` target by matching
/// `example` against the imported example that came from the same `examples`
/// map key - `mockExampleIndex`, a position rather than an id nothing has
/// minted yet at parse time.
TEST (ImportParse, ReadsAFixedXVayuMockAsAnExampleIndex) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{"200":{"description":"ok","content":
        {"application/json":{"examples":{
            "first":{"value":{"id":"p1"}},
            "second":{"value":{"id":"p2"}}
        }}}}},
        "x-vayu-mock":{"mode":"fixed","example":"first"}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (request.at ("mockResponseMode"), "fixed");
    // `first_named_example_entry` only ever reads the first entry of the map
    // per status (`declared_example_value`), so "first" is what actually
    // imports as this operation's one example - index 0 - which is exactly
    // the entry `x-vayu-mock` names here.
    ASSERT_TRUE (request.contains ("examples"));
    EXPECT_EQ (request.at ("examples").size (), 1);
    EXPECT_EQ (request.at ("mockExampleIndex"), 0);
}

/// `"random"` needs no target and is applied outright.
TEST (ImportParse, ReadsARandomXVayuMock) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{},
        "x-vayu-mock":{"mode":"random"}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (request.at ("mockResponseMode"), "random");
    EXPECT_FALSE (request.contains ("mockExampleIndex"));
}

/// A `"fixed"` target naming an `examples` key this operation's response no
/// longer declares (hand-edited, or the entry the exporter suffixed is gone)
/// degrades the way `elements_invalid` does: counted, and the request keeps
/// no `mockResponseMode` at all, which is `pick_example`'s own "first"
/// default.
TEST (ImportParse, CountsAFixedXVayuMockNamingAMissingExample) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{"200":{"description":"ok","content":
        {"application/json":{"examples":{"kept":{"value":{"id":"p1"}}}}}}},
        "x-vayu-mock":{"mode":"fixed","example":"gone"}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_FALSE (request.contains ("mockResponseMode"));
    EXPECT_FALSE (request.contains ("mockExampleIndex"));
    const nlohmann::ordered_json& skipped =
    parsed.result.at ("meta").at ("skipped");
    const bool counted = std::any_of (
    skipped.begin (), skipped.end (), [] (const nlohmann::ordered_json& item) {
        return item.at ("kind") == "mock_example_missing";
    });
    EXPECT_TRUE (counted);
}

/// A hand-edited `x-vayu-elements` that fails the registry (an unknown kind,
/// here) is dropped and counted rather than applied or refusing the whole
/// document - the same "nothing dropped quietly, nothing invalid applied"
/// rule the rest of this parser follows.
TEST (ImportParse, DropsAndCountsAnInvalidXVayuElementsArray) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{},
        "x-vayu-elements":[{"id":"el_1","kind":"not.a.kind","enabled":true,"config":{}}]}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_FALSE (request.contains ("elements"));
    const nlohmann::ordered_json& skipped =
    parsed.result.at ("meta").at ("skipped");
    const bool counted = std::any_of (
    skipped.begin (), skipped.end (), [] (const nlohmann::ordered_json& item) {
        return item.at ("kind") == "elements_invalid";
    });
    EXPECT_TRUE (counted);
}

/// The kind's own validate rules apply too (#3043): an assertion with nothing
/// to compare against, written by an engine that still stored one, is dropped
/// and counted like any other invalid array.
TEST (ImportParse, DropsAnXVayuElementsAssertionThatCannotRun) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{},
        "x-vayu-elements":[{"id":"el_1","kind":"assert.status","enabled":true,"config":{}}]}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_FALSE (first_request (parsed.result.at ("collections")[0]).contains ("elements"));
    const nlohmann::ordered_json& skipped =
    parsed.result.at ("meta").at ("skipped");
    EXPECT_TRUE (std::any_of (
    skipped.begin (), skipped.end (), [] (const nlohmann::ordered_json& item) {
        return item.at ("kind") == "elements_invalid";
    }));
}

/// The document root's own `x-vayu-elements` is the collection's - a skeleton
/// export writes a collection's scripts there. It used to be written and never
/// read, so every re-import lost them.
TEST (ImportParse, ReadsRootXVayuElementsIntoTheCollection) {
    const ImportParse parsed = parse_import (R"json({"openapi":"3.1.0","info":{"title":"T"},
        "x-vayu-elements":[{"id":"el_1","kind":"script.pre","enabled":true,
        "config":{"script":"console.log(1)"}}],
        "paths":{}})json",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& root = parsed.result.at ("collections")[0];
    ASSERT_TRUE (root.contains ("elements"));
    EXPECT_EQ (root.at ("elements")[0].at ("kind"), "script.pre");
}

/// An XML request body imports as Vayu's own `xml` mode with the example as
/// its text - a skeleton export writes an `xml` body exactly this way, and it
/// used to come back as no body at all (`unmapped_body`).
TEST (ImportParse, ReadsAnXmlRequestBodyAsTheXmlMode) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.1.0","info":{"title":"T"},
        "servers":[{"url":"https://api.example.com"}],
        "paths":{"/soap":{"post":{"responses":{},
        "requestBody":{"content":{"application/xml":{"example":"<a>1</a>"}}}}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (request.at ("body").at ("mode"), "xml");
    EXPECT_EQ (request.at ("body").at ("content"), "<a>1</a>");
    EXPECT_TRUE (parsed.result.at ("meta").at ("skipped").empty ());
}

/**
 * A whole-file request body imports as a `binary` body with no file chosen -
 * the document names the upload, never the file - under the media type it
 * declares, and is counted as a file to choose rather than as an unmapped
 * body: `application/octet-stream` whatever its schema, any other type whose
 * schema is one `format: binary` string, and no content type at all for a
 * wildcard no request can be sent under.
 */
TEST (ImportParse, ReadsAWholeFileRequestBodyAsTheBinaryMode) {
    const ImportParse parsed = parse_import (R"({"openapi":"3.0.3","info":{"title":"T"},
        "paths":{
          "/raw":{"put":{"operationId":"raw","responses":{},
            "requestBody":{"content":{"application/octet-stream":{}}}}},
          "/png":{"put":{"operationId":"png","responses":{},
            "requestBody":{"content":{"image/png":{"schema":{"$ref":"#/components/schemas/Bytes"}}}}}},
          "/any":{"put":{"operationId":"any","responses":{},
            "requestBody":{"content":{"image/*":{"schema":{"type":"string","format":"binary"}}}}}},
          "/note":{"put":{"operationId":"note","responses":{},
            "requestBody":{"content":{"image/png":{"schema":{"type":"object"}}}}}}},
        "components":{"schemas":{"Bytes":{"type":"string","format":"binary"}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    std::map<std::string, std::string> bodies;
    const std::function<void (const nlohmann::ordered_json&)> walk =
    [&] (const nlohmann::ordered_json& collection) {
        for (const auto& request : collection.at ("requests")) {
            bodies[request.at ("name").get<std::string> ()] =
            request.at ("body").dump ();
        }
        for (const auto& child : collection.at ("children")) {
            walk (child);
        }
    };
    walk (parsed.result.at ("collections")[0]);
    EXPECT_EQ (bodies.at ("raw"),
    R"({"mode":"binary","file":{"src":"","contentType":"application/octet-stream"}})");
    EXPECT_EQ (bodies.at ("png"),
    R"({"mode":"binary","file":{"src":"","contentType":"image/png"}})");
    EXPECT_EQ (bodies.at ("any"), R"({"mode":"binary","file":{"src":""}})");
    EXPECT_EQ (bodies.at ("note"), R"({"mode":"none"})");
    const json counts = skip_counts (parsed.result.at ("meta").at ("skipped"));
    EXPECT_EQ (counts.at ("file_body"), 3);
    EXPECT_EQ (counts.at ("unmapped_body"), 1);
}

/// The 2.0 spelling: an `in: body` parameter whose schema is one binary
/// string, its media type read off `consumes`.
TEST (ImportParse, ReadsASwagger20BinaryBodyParameterAsTheBinaryMode) {
    const ImportParse parsed = parse_import (R"({"swagger":"2.0","info":{"title":"T"},
        "paths":{"/raw":{"put":{"operationId":"raw","responses":{},
          "consumes":["application/json","application/octet-stream"],
          "parameters":[{"name":"body","in":"body",
            "schema":{"type":"string","format":"binary"}}]}}}})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (request.at ("body").dump (),
    R"({"mode":"binary","file":{"src":"","contentType":"application/octet-stream"}})");
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("file_body"), 1);
}

/**
 * An `x-vayu-request` binary body round-trips its file's name and content
 * type; the export never writes the path, so none comes back. A path a
 * hand-edited document does carry - on the binary body or a form file part -
 * is kept, and whatever the document says about its trust is dropped: the
 * engine derives that from this machine's roots and grants (#2356).
 */
TEST (ImportParse, ReadsAnXVayuBinaryBodyAndKeepsACarriedPathWithoutTrust) {
    const auto body_of = [] (const std::string& stated) {
        const ImportParse parsed = parse_import (R"({"openapi":"3.1.0","info":{"title":"T"},
            "paths":{"/up":{"put":{"responses":{},"x-vayu-request":{"body":)" +
        stated + "}}}}}",
        {}, {});
        EXPECT_TRUE (parsed.ok ()) << parsed.error;
        return first_request (parsed.result.at ("collections")[0]).at ("body").dump ();
    };
    EXPECT_EQ (body_of (R"({"mode":"binary","file":{"fileName":"a.png","contentType":"image/png"}})"),
    R"({"mode":"binary","file":{"src":"","fileName":"a.png","contentType":"image/png"}})");
    EXPECT_EQ (body_of (R"({"mode":"binary","file":{"src":"/x/a.png","unresolved":false}})"),
    R"({"mode":"binary","file":{"src":"/x/a.png"}})");
    EXPECT_EQ (body_of (R"({"mode":"form-data","fields":[{"key":"f","type":"file","src":"/x/a.png"},
        {"key":"t","value":"v","src":"/x/b.png"}]})"),
    R"({"mode":"form-data","fields":[{"key":"f","value":"","enabled":true,"type":"file","src":"/x/a.png"},{"key":"t","value":"v","enabled":true}]})");
}

/// An `x-vayu-request` piece that fails its check is dropped and counted, and
/// the request keeps what the standard members said - a hand-edited vendor
/// key never refuses the import or reaches a write route malformed.
TEST (ImportParse, DropsAndCountsAnXVayuRequestPieceThatFailsItsCheck) {
    const ImportParse parsed = parse_import (R"json({"openapi":"3.1.0","info":{"title":"T"},
        "paths":{"/pets":{"get":{"responses":{},
          "parameters":[{"name":"X-Trace","in":"header","schema":{"type":"string"},"example":"1"}],
          "x-vayu-request":{"headers":"not rows","body":{"mode":"telepathy"},
                            "settings":{"httpVersion":"http9"},"name":"Listed pets"}}}}})json",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (request.at ("name"), "Listed pets");
    EXPECT_EQ (request.at ("headers")[0].at ("key"), "X-Trace");
    EXPECT_EQ (request.at ("body").at ("mode"), "none");
    EXPECT_FALSE (request.contains ("httpVersion"));
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("vayu_extension_invalid"),
    3);
}

/// A document carrying `x-vayu-collection` states its own tree: folders nest
/// as `folders` says, a request goes where its `x-vayu-request.folder` says,
/// and one with no folder stays on the root instead of landing in a folder
/// named after its path.
TEST (ImportParse, BuildsTheFolderTreeTheDocumentStates) {
    const ImportParse parsed = parse_import (R"json({"openapi":"3.1.0","info":{"title":"T"},
        "x-vayu-collection":{"folders":[
            {"path":["Pets"],"description":"All pets","auth":{"mode":"noauth"}},
            {"path":["Pets","Actions"],"variables":{"v":{"value":"1","enabled":true}}},
            {"path":["Empty"]}]},
        "paths":{
          "/pets/feed":{"post":{"tags":["Pets/Actions"],"responses":{},
            "x-vayu-request":{"folder":["Pets","Actions"]}}},
          "/health":{"get":{"responses":{}}}}})json",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& root = parsed.result.at ("collections")[0];
    ASSERT_EQ (root.at ("requests").size (), 1);
    EXPECT_EQ (root.at ("requests")[0].at ("url"), "{{baseUrl}}/health");
    ASSERT_EQ (root.at ("children").size (), 2);
    const nlohmann::ordered_json& pets = root.at ("children")[0];
    EXPECT_EQ (pets.at ("name"), "Pets");
    EXPECT_EQ (pets.at ("description"), "All pets");
    EXPECT_EQ (pets.at ("auth").at ("mode"), "noauth");
    ASSERT_EQ (pets.at ("children").size (), 1);
    const nlohmann::ordered_json& actions = pets.at ("children")[0];
    EXPECT_EQ (actions.at ("name"), "Actions");
    EXPECT_EQ (actions.at ("variables").at ("v").at ("value"), "1");
    ASSERT_EQ (actions.at ("requests").size (), 1);
    EXPECT_EQ (root.at ("children")[1].at ("name"), "Empty");
    EXPECT_FALSE (parsed.result.at ("meta").contains ("folderStrategy"));
}

/// A Vayu-written document whose root holds the folders `Pets` and `Users`
/// and the requests `/login` and `/logout`, each request's `order` as an
/// export states it. @p pets and @p users are the folder entries' own
/// `order` members, empty for a document written before #2535, which
/// numbered the requests from 0 in a space of their own.
std::string vayu_tree_document (const std::string& pets, const std::string& users) {
    return R"json({"openapi":"3.1.0","info":{"title":"T"},
        "x-vayu-collection":{"folders":[{"path":["Pets"])json" +
    pets + R"json(},{"path":["Users"])json" + users + R"json(}]},
        "paths":{
          "/login":{"post":{"responses":{},"x-vayu-request":{"order":0}}},
          "/logout":{"post":{"responses":{},"x-vayu-request":{"order":)json" +
    (pets.empty () ? "1" : "2") + R"json(}}}}})json";
}

/// The root's children as the payload numbers them, `folder:` / `request:`
/// and the name, in `order`.
std::vector<std::string> root_payload_listing (const ImportParse& parsed) {
    const json payload =
    json::parse (vayu::core::import_apply_payload (parsed.result).dump ());
    std::vector<std::pair<int, std::string>> slots;
    for (const json& c : payload.at ("collections")) {
        if (c.at ("parentTempId") == "c1") {
            slots.emplace_back (c.at ("order").get<int> (),
            "folder:" + c.at ("name").get<std::string> ());
        }
    }
    for (const json& r : payload.at ("requests")) {
        if (r.at ("collectionTempId") == "c1") {
            slots.emplace_back (r.at ("order").get<int> (),
            "request:" + r.at ("url").get<std::string> ());
        }
    }
    std::ranges::sort (slots);
    std::vector<std::string> listed;
    listed.reserve (slots.size ());
    for (auto& [order, name] : slots) {
        listed.push_back (std::move (name));
    }
    return listed;
}

// A folder's `order` in `x-vayu-collection.folders` shares its parent's space
// with the requests' `x-vayu-request.order` (#2535), so a request exported
// between two folders imports there. Mutation check: drop the folder's
// `order` in `VayuFolderTree` and the folder moves to the front.
TEST (ImportParse, AVayuDocumentsFolderOrderInterleavesItWithTheRequests) {
    const ImportParse parsed =
    parse_import (vayu_tree_document (R"(,"order":1)", R"(,"order":3)"), {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (root_payload_listing (parsed),
    (std::vector<std::string>{ "request:{{baseUrl}}/login", "folder:Pets",
    "request:{{baseUrl}}/logout", "folder:Users" }));
}

// A document written before #2535 numbered folders and requests in two
// spaces and stated no folder order: its requests keep following the folders
// rather than pairing up with them (`f0 r0 f1 r1`). Mutation check: stamp the
// requests' `order` in `VayuFolderTree::sorted` unconditionally and this reds.
TEST (ImportParse, AnOlderVayuDocumentKeepsItsFoldersFirst) {
    const ImportParse parsed = parse_import (vayu_tree_document ("", ""), {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (root_payload_listing (parsed),
    (std::vector<std::string>{ "folder:Pets", "folder:Users",
    "request:{{baseUrl}}/login", "request:{{baseUrl}}/logout" }));
}

// A stated `order` no row can store counts as unstated (#3451), so `/logout`
// takes the position an unordered request would rather than wrapping (2^31)
// or staying negative and sorting first. Mutation check: read `stated_order`
// with a bare `get<int> ()` again and `/logout` lists first.
TEST (ImportParse, AVayuDocumentsUnstorableOrderCountsAsUnstated) {
    for (const std::string order : { "2147483648", "-1" }) {
        const ImportParse parsed = parse_import (
        R"json({"openapi":"3.1.0","info":{"title":"T"},
            "x-vayu-collection":{"folders":[]},
            "paths":{
              "/login":{"post":{"responses":{},"x-vayu-request":{"order":0}}},
              "/logout":{"post":{"responses":{},"x-vayu-request":{"order":)json" +
        order + "}}}}}",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (root_payload_listing (parsed),
        (std::vector<std::string>{ "request:{{baseUrl}}/login", "request:{{baseUrl}}/logout" }))
        << order;
    }
}

TEST (ImportParse, ReportsA31DocumentApartFrom30) {
    const ImportParse v30 =
    parse_import (R"({"openapi":"3.0.3","info":{"title":"T"},"paths":{}})", {}, {});
    ASSERT_TRUE (v30.ok ()) << v30.error;
    EXPECT_EQ (v30.result.at ("meta").at ("format"), "OpenAPI 3.0");

    const ImportParse v31 =
    parse_import (R"({"openapi":"3.1.0","info":{"title":"T"},"paths":{}})", {}, {});
    ASSERT_TRUE (v31.ok ()) << v31.error;
    EXPECT_EQ (v31.result.at ("meta").at ("format"), "OpenAPI 3.1");
}

/// An OpenAPI `101` (a WebSocket upgrade) documents a response no mock can
/// serve, so it is counted with the keys that have no status line instead of
/// becoming an example the apply would refuse. Mutation check: a lower bound of
/// 100 imports it as an example.
TEST (OpenApiImport, SkipsAnInterimResponseAndCountsIt) {
    const ImportParse parsed = parse_import (R"j({"openapi":"3.0.0",
        "info":{"title":"T","version":"1"},
        "paths":{"/ws":{"get":{"operationId":"connect","responses":{
            "101":{"description":"Switching protocols"},
            "200":{"description":"ok"}}}}}})j",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("exampleCount"), 1);
    EXPECT_EQ (skipped_count (meta, "example_no_status"), 1);
}

namespace {

/// An OpenAPI 3.0 import of one `GET /r` operation carrying @p responses.
ImportParse parse_responses (const std::string& responses) {
    return parse_import (R"j({"openapi":"3.0.0","info":{"title":"T","version":"1"},
        "paths":{"/r":{"get":{"operationId":"r","responses":)j" +
    responses + "}}}}",
    {}, {});
}

/// The one example of @p status on the first request, which must exist.
const nlohmann::ordered_json& example_of_status (const ImportParse& parsed, int status) {
    static const nlohmann::ordered_json missing = nlohmann::ordered_json::object ();
    for (const nlohmann::ordered_json& example :
    first_request (parsed.result.at ("collections")[0]).at ("examples")) {
        if (example.at ("status") == status) {
            return example;
        }
    }
    ADD_FAILURE () << "no example with status " << status;
    return missing;
}

} // namespace

/// A response documented only in a text media type is an example with that
/// body under that media type (#3424), where the importer used to store an empty
/// body with no content type and the mock answered an empty `text/plain`. The
/// body is the string as written; a media type with parameters keeps them; an
/// `examples` map is read through its first entry. Mutation check: restoring
/// the JSON-only return gives all four rows an empty body and no content type.
TEST (OpenApiImport, ImportsATextResponseExampleWithItsBodyAndContentType) {
    const ImportParse parsed = parse_responses (R"j({
        "200":{"description":"pong","content":{"text/plain":{"example":"pong"}}},
        "404":{"description":"gone","content":{"text/html; charset=utf-8":{
            "examples":{"page":{"value":"<h1>Gone</h1>"}}}}},
        "500":{"description":"oops","content":{"application/xml":{"example":"<e/>"}}},
        "503":{"description":"busy","content":{"text/csv":{"example":42}}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& ok = example_of_status (parsed, 200);
    EXPECT_EQ (ok.at ("body"), "pong");
    EXPECT_EQ (ok.at ("contentType"), "text/plain");
    EXPECT_EQ (header_pairs (ok.at ("headers")),
    (HeaderPairs{ { "Content-Type", "text/plain" } }));

    const nlohmann::ordered_json& gone = example_of_status (parsed, 404);
    EXPECT_EQ (gone.at ("body"), "<h1>Gone</h1>");
    EXPECT_EQ (gone.at ("contentType"), "text/html; charset=utf-8");
    EXPECT_EQ (gone.at ("specExampleKey"), "page");

    EXPECT_EQ (example_of_status (parsed, 500).at ("body"), "<e/>");
    EXPECT_EQ (example_of_status (parsed, 500).at ("contentType"), "application/xml");
    // A text-family type takes a non-string example as the JSON text it is.
    EXPECT_EQ (example_of_status (parsed, 503).at ("body"), "42");
    EXPECT_EQ (example_of_status (parsed, 503).at ("contentType"), "text/csv");
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 0);
}

/// A JSON media type keeps precedence over a text one declared before it, and a
/// media type with no declared example is passed over for the next one that has
/// one. Mutation check: trying the text media types before the JSON one gives
/// the 200 the `plain` body.
TEST (OpenApiImport, PrefersJsonThenTheFirstMediaTypeThatDeclaresAnExample) {
    const ImportParse parsed = parse_responses (R"j({
        "200":{"description":"both","content":{
            "text/plain":{"example":"plain"},
            "application/json":{"example":{"ok":true}}}},
        "201":{"description":"later","content":{
            "image/png":{"schema":{"type":"string","format":"byte"}},
            "text/plain":{"example":"made"}}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    EXPECT_EQ (example_of_status (parsed, 200).at ("contentType"), "application/json");
    EXPECT_EQ (example_of_status (parsed, 200).at ("body"), "{\n  \"ok\": true\n}");
    EXPECT_EQ (example_of_status (parsed, 201).at ("contentType"), "text/plain");
    EXPECT_EQ (example_of_status (parsed, 201).at ("body"), "made");
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 0);
}

/// A response whose only media types declare no example is counted, never
/// given a body: a schema is sampled into JSON, and JSON bytes under `text/csv`
/// document nothing the spec said. The example still imports, undocumented, as
/// a `204` does. A `content` map with no entries lost nothing and is not
/// counted. Mutation check: dropping the tally leaves the count at 0.
TEST (OpenApiImport, CountsAResponseWhoseMediaTypesDeclareNoExample) {
    const ImportParse parsed = parse_responses (R"j({
        "200":{"description":"csv","content":{
            "text/csv":{"schema":{"type":"string"}},
            "application/pdf":{"schema":{"type":"string","format":"binary"}}}},
        "204":{"description":"empty"},
        "205":{"description":"none","content":{}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& csv = example_of_status (parsed, 200);
    EXPECT_EQ (csv.at ("body"), "");
    EXPECT_EQ (csv.at ("contentType"), "");
    EXPECT_TRUE (csv.at ("headers").empty ());
    EXPECT_EQ (parsed.result.at ("meta").at ("exampleCount"), 3);
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 1);
}

/// A JSON media type that yields nothing (an empty media object) does not end
/// the search: the text example beside it is imported, and with none the
/// response is counted rather than silently bodiless. Mutation check: returning
/// the JSON result directly gives the 200 an empty body and leaves the count 0.
TEST (OpenApiImport, FallsThroughFromAnEmptyJsonMediaTypeToATextExample) {
    const ImportParse parsed = parse_responses (R"j({
        "200":{"description":"pong","content":{
            "application/json":{},
            "text/plain":{"example":"pong"}}},
        "201":{"description":"bare","content":{"application/json":{}}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    EXPECT_EQ (example_of_status (parsed, 200).at ("body"), "pong");
    EXPECT_EQ (example_of_status (parsed, 200).at ("contentType"), "text/plain");
    EXPECT_EQ (example_of_status (parsed, 201).at ("body"), "");
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 1);
}

/// A media range is not a media type: `*/*` and `text/*` never become a literal
/// `Content-Type`, so the example under one is passed over for a named type
/// and, with none, counted. Mutation check: dropping the `*` guard of
/// `is_text_example` imports the 202 under `text/*` and the 203 under `*/*`.
TEST (OpenApiImport, NeverTakesAMediaRangeAsTheContentTypeOfAnExample) {
    const ImportParse parsed = parse_responses (R"j({
        "202":{"description":"named","content":{
            "*/*":{"example":"any"},
            "text/*":{"example":"text"},
            "text/plain":{"example":"plain"}}},
        "203":{"description":"ranges","content":{
            "*/*":{"example":"any"},
            "text/*":{"example":"text"}}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    EXPECT_EQ (example_of_status (parsed, 202).at ("body"), "plain");
    EXPECT_EQ (example_of_status (parsed, 202).at ("contentType"), "text/plain");
    EXPECT_EQ (example_of_status (parsed, 203).at ("body"), "");
    EXPECT_EQ (example_of_status (parsed, 203).at ("contentType"), "");
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 1);
}

namespace {

/// A Swagger 2.0 import of one `GET /r` operation whose `responses` is
/// @p responses, with @p operation_members (`"produces":[...],`, or empty)
/// leading the operation.
ImportParse parse_swagger_responses (const std::string& operation_members,
const std::string& responses) {
    return parse_import (R"j({"swagger":"2.0","info":{"title":"T","version":"1"},
        "paths":{"/r":{"get":{"operationId":"r",)j" +
    operation_members + R"j("responses":)j" + responses + "}}}}",
    {}, {});
}

} // namespace

/// A 2.0 text example imports under the key it is declared under, whatever
/// `produces` lists first: beside a JSON type, with no `produces` at all, under
/// a type that is not the first one, and under a key that carries parameters.
/// Mutation check: restoring the single `produces.front()` content type leaves
/// the first three rows with an empty body (and the fourth under the wrong
/// type); reading only the produced key does the same.
TEST (SwaggerImport, ImportsATextResponseExampleUnderTheKeyItIsDeclaredUnder) {
    struct Row {
        std::string produces;
        std::string examples;
        std::string body;
        std::string content_type;
    };
    const std::vector<Row> rows = {
        { R"j("produces":["application/json","text/plain"],)j",
        R"j({"text/plain":"pong"})j", "pong", "text/plain" },
        { "", R"j({"text/plain":"pong"})j", "pong", "text/plain" },
        { R"j("produces":["text/plain","application/xml"],)j",
        R"j({"application/xml":"<e/>"})j", "<e/>", "application/xml" },
        { R"j("produces":["text/plain"],)j", R"j({"text/plain; charset=utf-8":"pong"})j",
        "pong", "text/plain; charset=utf-8" },
        // A non-string example under a text-family key is the JSON text it is.
        { R"j("produces":["text/csv"],)j", R"j({"text/csv":42})j", "42", "text/csv" },
    };
    for (const Row& row : rows) {
        const ImportParse parsed = parse_swagger_responses (row.produces,
        R"j({"200":{"description":"ok","examples":)j" + row.examples + "}}");
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const nlohmann::ordered_json& example = example_of_status (parsed, 200);
        EXPECT_EQ (example.at ("body"), row.body) << row.examples;
        EXPECT_EQ (example.at ("contentType"), row.content_type) << row.examples;
        EXPECT_EQ (header_pairs (example.at ("headers")),
        (HeaderPairs{ { "Content-Type", row.content_type } }));
        EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 0);
    }
}

/// The JSON type keeps precedence in 2.0 as in 3.x: a JSON example beats a text
/// one declared before it, a schema is sampled under the JSON type, and a JSON
/// example under a key `produces` does not list is still JSON under its own key.
/// Mutation check: trying the text examples first gives the first row the
/// `plain` body.
TEST (SwaggerImport, KeepsTheJsonTypeAheadOfATextExample) {
    const ImportParse both =
    parse_swagger_responses (R"j("produces":["application/json","text/plain"],)j",
    R"j({"200":{"examples":{"text/plain":"plain","application/json":{"ok":true}}},
         "201":{"schema":{"type":"string"},"examples":{"text/plain":"plain"}}})j");
    ASSERT_TRUE (both.ok ()) << both.error;
    EXPECT_EQ (example_of_status (both, 200).at ("contentType"), "application/json");
    EXPECT_EQ (example_of_status (both, 200).at ("body"), "{\n  \"ok\": true\n}");
    EXPECT_EQ (example_of_status (both, 201).at ("contentType"), "application/json");
    EXPECT_NE (example_of_status (both, 201).at ("body"), "plain");

    const ImportParse unlisted = parse_swagger_responses (R"j("produces":["text/plain"],)j",
    R"j({"200":{"examples":{"application/json":{"ok":true}}}})j");
    ASSERT_TRUE (unlisted.ok ()) << unlisted.error;
    EXPECT_EQ (example_of_status (unlisted, 200).at ("contentType"), "application/json");
    EXPECT_EQ (example_of_status (unlisted, 200).at ("body"), "{\n  \"ok\": true\n}");
    EXPECT_EQ (skipped_count (unlisted.result.at ("meta"), "example_no_media_type"), 0);
}

/// A 2.0 schema is sampled only into JSON: under `produces: [text/csv]` the
/// sample would be JSON bytes labelled `text/csv`, so the response imports
/// without a body and is counted. A media range key is no media type either.
/// A response documenting nothing is no loss. Mutation check: sampling the
/// schema under `produces.front()` gives the first row a body and the count 0;
/// dropping the `*` guard imports the second row under `*/*`.
TEST (SwaggerImport, CountsAResponseWhoseProducedTypesHaveNoUsableBody) {
    const ImportParse parsed = parse_swagger_responses (R"j("produces":["text/csv"],)j",
    R"j({"200":{"description":"csv","schema":{"type":"string"}},
         "201":{"description":"any","examples":{"*/*":"x","text/*":"y"}},
         "204":{"description":"empty"}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    for (const int status : { 200, 201, 204 }) {
        EXPECT_EQ (example_of_status (parsed, status).at ("body"), "") << status;
        EXPECT_EQ (example_of_status (parsed, status).at ("contentType"), "") << status;
    }
    EXPECT_EQ (parsed.result.at ("meta").at ("exampleCount"), 3);
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "example_no_media_type"), 2);
}

} // namespace
