/**
 * @file tests/import_parse_postman_body_test.cpp
 * @brief Postman imports: URL and variable handling, OAuth2 details, events, protocol behaviour,
 * body pruning and the content type a body mode implies.
 *
 * The helpers more than one of these files reads are in `import_parse_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/postman_export.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/request_composer.hpp"

#include "import_parse_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::ImportParse;
using vayu::core::parse_import;
using vayu::tests::import_parse::first_request;
using vayu::tests::import_parse::Names;
using vayu::tests::import_parse::parse_postman_items;
using vayu::tests::import_parse::POSTMAN_SCHEMA;
using vayu::tests::import_parse::skip_counts;
using vayu::tests::import_parse::skipped_named;

/// The fragment is the URL's, never a query value's: it is cut at the first
/// `#` before the query is looked for, kept on the url, and the query joined
/// before it. `url.hash` supplies it when `raw` has none. Mutation check:
/// splitting at `?` first leaves `#{{search}}` in the last row's key; ignoring
/// `url.hash` drops the `#top` of the no-raw shape.
TEST (PostmanImport, KeepsAUrlFragmentOffTheQueryRows) {
    const ImportParse parsed = parse_postman_items (
    // A bare string with the query before the fragment (collection-v2.json).
    R"j({"name":"Bare","request":{"method":"GET",
            "url":"https://x.com/p?query=string&a=b&abcd#{{ search }}"}},
        {"name":"Raw","request":{"method":"GET","url":{
            "raw":"https://x.com/p?q=1&flag#top","query":[{"key":"q","value":"1"},{"key":"flag","value":null}]}}},
        {"name":"RawOnly","request":{"method":"GET","url":{
            "raw":"https://x.com/p#top?not=query"}}},
        {"name":"NoRaw","request":{"method":"GET","url":{
            "protocol":"https","host":["x","com"],"path":["p"],"hash":"top",
            "query":[{"key":"q","value":"1"}]}}},
        {"name":"HashBeyondRaw","request":{"method":"GET","url":{
            "raw":"https://x.com/p?q=1","hash":"top"}}},
        {"name":"HashAlreadyInRaw","request":{"method":"GET","url":{
            "raw":"https://x.com/p#top","hash":"top"}}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");

    EXPECT_EQ (requests[0].at ("url"), "https://x.com/p?query=string&a=b&abcd#{{search}}");
    EXPECT_EQ (requests[0].at ("params").size (), 3u);
    EXPECT_EQ (requests[0].at ("params")[2].at ("key"), "abcd");
    EXPECT_EQ (requests[1].at ("url"), "https://x.com/p?q=1&flag#top");
    // The first `#` ends the URL: what follows it is the fragment, `?` included,
    // so there is no query to read.
    EXPECT_EQ (requests[2].at ("url"), "https://x.com/p#top?not=query");
    EXPECT_TRUE (requests[2].at ("params").empty ());
    EXPECT_EQ (requests[3].at ("url"), "https://x.com/p?q=1#top");
    EXPECT_EQ (requests[4].at ("url"), "https://x.com/p?q=1#top");
    EXPECT_EQ (requests[5].at ("url"), "https://x.com/p#top");

    // The export splits the same URL back to the hash it was read from.
    EXPECT_EQ (vayu::core::postman_url_parts (requests[0].at ("url")).at ("hash"), "{{search}}");
}

/// The shape of postman-collection's own `collection-v2.json` fixture: script
/// events as bare strings, a `packages` member beside the root events, a header
/// string carrying a Hawk `Authorization` and a `Content-Type`, and a bare URL
/// whose fragment is a variable. Every piece reads, and the one thing Vayu
/// cannot take (a `src`) is counted rather than lost. Mutation check: reverting
/// any one of the string-script, header-string, fragment or `src` fixes reds a
/// distinct assertion here.
TEST (PostmanImport, ReadsTheShapeOfPostmansOwnV2Fixture) {
    const ImportParse parsed = parse_import (
    R"j({"info":{"_postman_id":"4455f5e6-5f6a-4b9b-8f2a-9f4b9c8d1111","name":"Sample","version":"1.0.0",
            "schema":")j" +
    std::string (POSTMAN_SCHEMA) + R"j("},
        "event":[{"listen":"prerequest","script":"console.log('root pre');",
                  "id":"e1"},
                 {"listen":"test","script":{"id":"e2","exec":["pm.test('root', () => {});"],
                  "packages":{"p1":{"id":"p1","name":"shared"}}}}],
        "item":[
        {"id":"i1","name":"Folded","item":[
           {"id":"i2","name":"Echo","event":[{"listen":"test","script":{"src":"https://example.com/echo.js"}}],
            "request":{"url":"https://postman-echo.com/get?query=string&a=b&abcd#{{search}}",
                       "method":"GET",
                       "header":"Authorization: Hawk id=\"dh37fgj492je\", ts=\"1353832234\", mac=\"abc=\"\r\nContent-Type: application/json"}}]}
    ]})j",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& root    = parsed.result.at ("collections")[0];
    const json& request = root.at ("children")[0].at ("requests")[0];

    ASSERT_EQ (root.at ("elements").size (), 2u);
    EXPECT_EQ (root.at ("elements")[0].at ("kind"), "script.pre");
    EXPECT_EQ (root.at ("elements")[0].at ("config").at ("script"), "console.log('root pre');");
    EXPECT_EQ (root.at ("elements")[1].at ("kind"), "script.post");

    EXPECT_EQ (request.at ("url"),
    "https://postman-echo.com/get?query=string&a=b&abcd#{{search}}");
    ASSERT_EQ (request.at ("headers").size (), 2u);
    EXPECT_EQ (request.at ("headers")[0].at ("key"), "Authorization");
    EXPECT_EQ (request.at ("headers")[0].at ("value"),
    R"(Hawk id="dh37fgj492je", ts="1353832234", mac="abc=")");
    EXPECT_EQ (request.at ("headers")[1].at ("value"), "application/json");

    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (skipped_named (parsed, "script_unsupported"), Names{ "Echo" });
    EXPECT_EQ (meta.at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (R"j([{"request":"Sample","names":["script.packages"]}])j"));
}

/**
 * A Postman `:name` segment stays in the URL and its `url.variable[]` entry
 * becomes the request's own path row (issue #1764): value, description,
 * `type` and the disabled state kept, nothing promoted to a collection
 * variable, and no `path_variables` notice - nothing was lost. A declared
 * entry no segment uses is kept (it is exported again); a segment no entry
 * declares (`:postId`) gets no row, so the export does not invent one.
 */
TEST (PostmanImport, KeepsAPathVariableAsTheRequestsOwnPathRow) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":{
            "raw":"https://api.example.com/users/:userId/:postId?x=1",
            "query":[{"key":"x","value":"1"}],
            "variable":[{"key":"userId","value":"{{ who }}","type":"string",
                         "description":"the user"},
                        {"key":"unused","value":"u","disabled":true}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& collection = parsed.result.at ("collections")[0];
    const json& request    = collection.at ("requests")[0];
    // `join_params_into_urls` rejoins the enabled query param after `pm_url`
    // splits it off - see "The url/params invariant" in the Postman doc - and
    // leaves the path rows out of it.
    EXPECT_EQ (request.at ("url"), "https://api.example.com/users/:userId/:postId?x=1");
    EXPECT_EQ (request.at ("params"), json::parse (R"([
        {"key":"x","value":"1","enabled":true},
        {"key":"userId","value":"{{who}}","enabled":true,"in":"path",
         "type":"string","description":"the user"},
        {"key":"unused","value":"u","enabled":false,"in":"path"}])"));
    EXPECT_TRUE (collection.at ("variables").empty ());
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("path_variables"));
}

/**
 * The acceptance case of issue #1764: two requests on `:id` with different
 * values each keep their own, where the old import promoted the first value
 * to one collection variable both requests then sent.
 */
TEST (PostmanImport, TwoRequestsOnOnePathVariableKeepTheirOwnValues) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"A","request":{"method":"GET","url":{
            "raw":"https://api.example.com/users/:id","variable":[{"key":"id","value":"1"}]}}},
        {"name":"B","request":{"method":"GET","url":{
            "raw":"https://api.example.com/users/:id","variable":[{"key":"id","value":"2"}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& collection = parsed.result.at ("collections")[0];
    EXPECT_FALSE (collection.at ("variables").contains ("id"));
    const json& requests = collection.at ("requests");
    ASSERT_EQ (requests.size (), 2u);
    for (size_t i = 0; i < 2; ++i) {
        EXPECT_EQ (requests[i].at ("url"), "https://api.example.com/users/:id");
        ASSERT_EQ (requests[i].at ("params").size (), 1u);
        EXPECT_EQ (requests[i].at ("params")[0].at ("value"), std::to_string (i + 1));
        EXPECT_EQ (requests[i].at ("params")[0].at ("in"), "path");
    }
}

/// A v2.0 string URL carries no `url.variable[]`, so it declares no path row -
/// the `:name` segments stay in the URL and the Params tab shows a row for
/// each without one being stored; a v2.0 entry naming itself by `id` alone is
/// read by that name.
TEST (PostmanImport, StoresNoRowForAnUndeclaredPathVariable) {
    const ImportParse parsed = parse_import (R"({"info":{"schema":"https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},"item":[
        {"name":"S","request":{"method":"GET","url":"https://api.example.com/:a/:a/:b?t=1:2"}},
        {"name":"V","request":{"method":"GET","url":{"raw":"https://api.example.com/:c",
            "variable":[{"id":"c","value":"3"}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("url"), "https://api.example.com/:a/:a/:b?t=1:2");
    EXPECT_EQ (requests[0].at ("params"), json::parse (R"([
        {"key":"t","value":"1:2","enabled":true}])"));
    EXPECT_EQ (requests[1].at ("params"), json::parse (R"([
        {"key":"c","value":"3","enabled":true,"in":"path"}])"));
}

TEST (PostmanImport, AssemblesAUrlFromHostAndPathWhenRawIsAbsent) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":{
            "protocol":"https","host":["api","example","com"],"path":["v1","users"]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("url"),
    "https://api.example.com/v1/users");
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("url_without_raw"), 1);
}

TEST (PostmanImport, MapsStrictSSLFalseToVerifySSLThroughToTheApplyPayload) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://x.com/a"},
         "protocolProfileBehavior":{"strictSSL":false}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("verifySSL"), false);

    // The draft carrying the field is not the same as the apply payload
    // carrying it - `apply_request`'s optional-field allowlist has its own
    // copy to remember (issue #1436's class of defect).
    const json payload =
    json::parse (vayu::core::import_apply_payload (parsed.result).dump ());
    EXPECT_EQ (payload.at ("requests")[0].at ("verifySSL"), false);
}

TEST (PostmanImport, KeepsCollectionVariableMetadataAndCountsWhatHasNoHome) {
    const ImportParse collection =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[],
        "variable":[{"key":"host","value":"x","description":"the host"},
                    {"key":"token","value":"y","type":"secret"},
                    {"key":"limit","value":"5","type":"number"},
                    {"key":"plain","value":"p","type":"default"},
                    {"key":"blob","value":"b","type":"any"}]})",
    {}, {});
    ASSERT_TRUE (collection.ok ()) << collection.error;
    const json& variables =
    collection.result.at ("collections")[0].at ("variables");
    EXPECT_FALSE (variables.at ("host").contains ("secret"));
    // A collection's variables go back out through the Postman exporter, so
    // the description is kept for it.
    EXPECT_EQ (variables.at ("host").at ("description"), "the host");
    EXPECT_TRUE (variables.at ("token").at ("secret").get<bool> ());
    // Vayu's own type of the same name, cast the same way for a script.
    EXPECT_EQ (variables.at ("limit").at ("type"), "number");
    // `default` is Postman's unset marker: nothing stored, nothing counted.
    EXPECT_FALSE (variables.at ("plain").contains ("type"));
    // `any` has no Vayu counterpart - the one row still counted.
    EXPECT_FALSE (variables.at ("blob").contains ("type"));
    EXPECT_EQ (
    skip_counts (collection.result.at ("meta").at ("skipped")).at ("variable_metadata"), 1);

    const ImportParse environment = parse_import (
    R"({"_postman_variable_scope":"environment","name":"Prod",
        "values":[{"key":"host","value":"x","description":"the host"},
                  {"key":"user","value":"y","type":"boolean"}]})",
    {}, {});
    ASSERT_TRUE (environment.ok ()) << environment.error;
    // No exporter reads an environment's description, so it is not kept - and
    // is counted; the type is Vayu's own and is.
    const json& values =
    environment.result.at ("environments")[0].at ("variables");
    EXPECT_FALSE (values.at ("host").contains ("description"));
    EXPECT_EQ (values.at ("user").at ("type"), "boolean");
    EXPECT_EQ (skip_counts (environment.result.at ("meta").at ("skipped")).at ("variable_metadata"),
    1);
}

/**
 * Issue #3252: the stored variables blob comes back with its keys sorted, and
 * the app lists a scope by `createdAt`, so the stamp is what keeps a file's
 * order. Each scope's rows are stamped strictly ascending in document order,
 * whatever their names; only the relative order is asserted, never the clock.
 * Mutation check: drop the `createdAt` line in `to_var_record` and every scope
 * fails.
 */
TEST (PostmanImport, StampsEachVariableRowInFileOrder) {
    const std::string values = R"([
        {"key":"zeta","value":"z"},
        {"key":"alpha","value":"a"},
        {"key":"mid","value":"m"}])";

    const auto check = [] (const json& variables, const char* scope) {
        std::vector<std::int64_t> stamps;
        for (const char* name : { "zeta", "alpha", "mid" }) {
            const json& row = variables.at (name);
            ASSERT_TRUE (row.contains ("createdAt") &&
            row.at ("createdAt").is_number_integer ())
            << scope << ": " << variables.dump ();
            stamps.push_back (row.at ("createdAt").get<std::int64_t> ());
        }
        EXPECT_LT (stamps.at (0), stamps.at (1)) << scope;
        EXPECT_LT (stamps.at (1), stamps.at (2)) << scope;
    };

    const ImportParse environment = parse_import (
    R"({"_postman_variable_scope":"environment","name":"Prod","values":)" + values + "}",
    {}, {});
    ASSERT_TRUE (environment.ok ()) << environment.error;
    check (environment.result.at ("environments")[0].at ("variables"), "environment");

    const ImportParse globals = parse_import (
    R"({"_postman_variable_scope":"globals","values":)" + values + "}", {}, {});
    ASSERT_TRUE (globals.ok ()) << globals.error;
    check (globals.result.at ("globals"), "globals");

    const ImportParse collection = parse_import (R"({"info":{"schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"variable":)" + values +
    R"(,"item":[{"name":"F","item":[],"variable":)" + values + "}]}",
    {}, {});
    ASSERT_TRUE (collection.ok ()) << collection.error;
    const json& root = collection.result.at ("collections")[0];
    check (root.at ("variables"), "collection");
    check (root.at ("children")[0].at ("variables"), "folder");
}

/**
 * Issue #3251: the write routes refuse a variable key that is blank or differs
 * from its trim, and an import applies atomically, so one padded row in a
 * document must not reach the apply as written. Each scope's parse trims the
 * key and skips a row that trims to nothing, without counting it (an empty key
 * never was); two keys that trim alike collide and the later row wins, as exact
 * duplicates do. Mutation check: drop the trim in `to_var_record` and the
 * padded names, the collision and the lookup by trimmed name all fail.
 */
TEST (PostmanImport, TrimsAVariableKeyAndSkipsABlankOne) {
    const std::string values = R"([
        {"key":" host ","value":"a"},
        {"key":"\ttoken","value":"b"},
        {"key":"   ","value":"skipped"},
        {"key":"","value":"skipped"},
        {"key":"dup","value":"first"},
        {"key":" dup","value":"second"}])";

    const auto check = [] (const json& variables) {
        EXPECT_EQ (variables.size (), 3U) << variables.dump ();
        EXPECT_EQ (variables.at ("host").at ("value"), "a");
        EXPECT_EQ (variables.at ("token").at ("value"), "b");
        EXPECT_EQ (variables.at ("dup").at ("value"), "second");
        for (auto member = variables.begin (); member != variables.end (); ++member) {
            EXPECT_TRUE (vayu::http::is_addressable_variable_name (member.key ()))
            << "'" << member.key () << "'";
        }
    };

    const ImportParse environment = parse_import (
    R"({"_postman_variable_scope":"environment","name":"Prod","values":)" + values + "}",
    {}, {});
    ASSERT_TRUE (environment.ok ()) << environment.error;
    check (environment.result.at ("environments")[0].at ("variables"));
    EXPECT_TRUE (skip_counts (environment.result.at ("meta").at ("skipped")).empty ());

    const ImportParse globals = parse_import (
    R"({"_postman_variable_scope":"globals","values":)" + values + "}", {}, {});
    ASSERT_TRUE (globals.ok ()) << globals.error;
    check (globals.result.at ("globals"));
    EXPECT_EQ (globals.result.at ("meta").at ("globalCount"), 3);

    const ImportParse collection = parse_import (R"({"info":{"schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"item":[],"variable":)" + values + "}",
    {}, {});
    ASSERT_TRUE (collection.ok ()) << collection.error;
    check (collection.result.at ("collections")[0].at ("variables"));
}

/**
 * Three more Postman fields measured lossy after #1443 and left out of it
 * deliberately (issue #1460): an oauth2 block's `state` and `tokenName`, a
 * pre-fetched `accessToken` beside an explicit grant config, and a query
 * value whose invalid `%` escape changes when rejoined into the URL. Each
 * case is a mutation check on its own counter or stored field.
 */
TEST (PostmanImport, CountsAPreFetchedOAuth2TokenDroppedAlongsideAGrantConfig) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":[
                {"key":"grant_type","value":"client_credentials"},
                {"key":"accessTokenUrl","value":"https://auth.example.com/token"},
                {"key":"clientId","value":"abc"},
                {"key":"accessToken","value":"seed-token"}
            ]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& auth = parsed.result.at ("collections")[0].at ("requests")[0].at ("auth");
    EXPECT_EQ (auth.at ("mode"), "oauth2");
    // The pre-fetched token has nowhere to ride alongside an explicit grant -
    // the general shape always fetches through `accessTokenUrl` instead.
    EXPECT_FALSE (auth.at ("config").contains ("accessToken"));
    EXPECT_FALSE (auth.at ("config").contains ("token"));
    // The visible kind means the saved token alone, named per request.
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("oauth2_dropped_field"), 1);
    EXPECT_EQ (skipped_named (parsed, "oauth2_dropped_field"), Names{ "R" });
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("oauth2_state_regenerated"));
}

TEST (PostmanImport, CountsAnOAuth2StateThatVayuNeverStores) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":[
                {"key":"grant_type","value":"authorization_code"},
                {"key":"authUrl","value":"https://auth.example.com/authorize"},
                {"key":"accessTokenUrl","value":"https://auth.example.com/token"},
                {"key":"state","value":"csrf-nonce"}
            ]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& config =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("auth").at (
    "config");
    // Vayu generates and validates its own CSRF state per authorization
    // attempt; a fixed imported value has no field to sit in.
    EXPECT_FALSE (config.contains ("state"));
    // Counted apart from the saved-token kind (issue #2536): a regenerated
    // state changes nothing sent, so the preview can leave it out.
    const json counts = skip_counts (parsed.result.at ("meta").at ("skipped"));
    EXPECT_EQ (counts.at ("oauth2_state_regenerated"), 1);
    EXPECT_FALSE (counts.contains ("oauth2_dropped_field"));
}

TEST (PostmanImport, StoresOAuth2TokenNameAsCredentialsId) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":[
                {"key":"grant_type","value":"client_credentials"},
                {"key":"accessTokenUrl","value":"https://auth.example.com/token"},
                {"key":"tokenName","value":"Saved Prod Token"}
            ]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& config =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("auth").at (
    "config");
    // `credentialsId` is Vayu's field for keeping otherwise-identical token
    // cache entries apart - the real home `tokenName` maps onto.
    EXPECT_EQ (config.at ("credentialsId"), "Saved Prod Token");
    // Stored, not dropped: `tokenName` alone must not tally as a loss.
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("oauth2_dropped_field"));
}

/// The `names` a count carries (issue #2536), `[]` when it has none.
Names skipped_dropped_names (const ImportParse& parsed, const std::string& kind) {
    for (const auto& item : parsed.result.at ("meta").at ("skipped")) {
        if (item.at ("kind") == kind) {
            return item.contains ("names") ? item.at ("names").get<Names> () : Names{};
        }
    }
    ADD_FAILURE () << "no " << kind << " counted";
    return {};
}

/**
 * Postman's extra token, authorization and refresh request parameters
 * (issue #2536). An `audience` or `resource` sent in a token or authorization
 * request's body is the config field the engine already sends; every other
 * enabled row is carried in its list; a row with no key, a `send_as` with no
 * Vayu target, or a name the engine writes itself is counted by key alone.
 * Mutation checks: stop reading `tokenRequestParams` and the config
 * assertions fail; drop the `credentialsId` assignment and its assertion
 * fails.
 */
TEST (PostmanImport, ReadsOAuth2ExtraRequestParameters) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"Auth0","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":[
                {"key":"grant_type","value":"authorization_code"},
                {"key":"authUrl","value":"https://auth.example.com/authorize"},
                {"key":"accessTokenUrl","value":"https://auth.example.com/token"},
                {"key":"tokenRequestParams","value":[
                    {"key":"audience","value":"https://off.example","enabled":false,"send_as":"request_body"},
                    {"key":"audience","value":"https://api.example","enabled":true,"send_as":"request_body"},
                    {"key":"resource","value":"{{ resource }}","enabled":true},
                    {"key":"tenant","value":"t1","enabled":true,"send_as":"request_url"},
                    {"key":"acr_values","value":"mfa","enabled":true,"send_as":"request_body"},
                    {"key":"x-trace","value":"1","enabled":true,"send_as":"request_header"},
                    {"key":"client_secret","value":"s3cr3t-param","enabled":true,"send_as":"request_body"},
                    {"key":"","value":"orphan","enabled":true},
                    {"key":"nonce","value":"n","enabled":true,"send_as":"request_cookie"}
                ],"type":"any"},
                {"key":"authRequestParams","value":[
                    {"key":"audience","value":"https://api.example","enabled":true,"send_as":"request_body"},
                    {"key":"prompt","value":"consent","enabled":true,"send_as":"request_url"},
                    {"key":"audience","value":"https://other.example","enabled":true,"send_as":"request_body"}
                ],"type":"any"},
                {"key":"refreshRequestParams","value":[
                    {"key":"audience","value":"https://api.example","enabled":true,"send_as":"request_body"},
                    {"key":"refresh_token","value":"rt-1","enabled":true}
                ],"type":"any"}
            ]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& config =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("auth").at (
    "config");
    // The disabled row ahead of it is not read, so the enabled one is promoted.
    EXPECT_EQ (config.at ("audience"), "https://api.example");
    EXPECT_EQ (config.at ("resource"), "{{resource}}");
    // No `tokenName`: the audience separates this config's cached token.
    EXPECT_EQ (config.at ("credentialsId"), "https://api.example");
    EXPECT_EQ (config.at ("tokenParams"), json::parse (R"([
        {"key":"tenant","value":"t1","enabled":true,"sendAs":"url"},
        {"key":"acr_values","value":"mfa","enabled":true,"sendAs":"body"},
        {"key":"x-trace","value":"1","enabled":true,"sendAs":"header"}])"));
    // The repeated audience is already sent; a different one is carried
    // rather than contradicting it. No target: it rides in the authorize URL.
    EXPECT_EQ (config.at ("authorizationParams"), json::parse (R"([
        {"key":"prompt","value":"consent","enabled":true},
        {"key":"audience","value":"https://other.example","enabled":true}])"));
    // A refresh does not send the config's audience, so it stays a row.
    EXPECT_EQ (config.at ("refreshParams"), json::parse (R"([
        {"key":"audience","value":"https://api.example","enabled":true,"sendAs":"body"}])"));

    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("oauth2_unmapped_param"), 4);
    EXPECT_EQ (skipped_named (parsed, "oauth2_unmapped_param"), Names{ "Auth0" });
    EXPECT_EQ (skipped_dropped_names (parsed, "oauth2_unmapped_param"),
    (Names{ "client_secret", "nonce", "refresh_token" }));
    // A key is named, a value never: either can be a credential.
    const std::string skipped = parsed.result.at ("meta").at ("skipped").dump ();
    for (const char* value : { "s3cr3t-param", "rt-1", "orphan" }) {
        EXPECT_EQ (skipped.find (value), std::string::npos) << value;
    }
}

TEST (PostmanImport, ReadsOAuth2ExtraRequestParametersFromAV20DetailObject) {
    const ImportParse parsed = parse_import (R"({"info":{"schema":"https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},"item":[
        {"name":"V2","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":{
                "grant_type":"client_credentials",
                "accessTokenUrl":"https://auth.example.com/token",
                "tokenRequestParams":[
                    {"key":"resource","value":"https://graph.example"},
                    {"key":"scope","value":"read"},
                    {"key":"acr_values","value":"mfa","enabled":false}],
                "authRequestParams":[{"key":"prompt","value":"login","send_as":"request_url"}],
                "refreshRequestParams":[{"key":"tenant","value":"t1","send_as":"request_url"}]
            }}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& config =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("auth").at (
    "config");
    // A row with no `enabled` is on, and with no `send_as` is sent in the body.
    EXPECT_EQ (config.at ("resource"), "https://graph.example");
    EXPECT_FALSE (config.contains ("audience"));
    EXPECT_EQ (config.at ("credentialsId"), "https://graph.example");
    EXPECT_FALSE (config.contains ("tokenParams"));
    EXPECT_EQ (config.at ("authorizationParams"),
    json::parse (R"([{"key":"prompt","value":"login","enabled":true}])"));
    EXPECT_EQ (config.at ("refreshParams"), json::parse (R"([
        {"key":"tenant","value":"t1","enabled":true,"sendAs":"url"}])"));
    EXPECT_EQ (skipped_dropped_names (parsed, "oauth2_unmapped_param"), Names{ "scope" });
}

/// Two imports differing only in their audience must not share one cached
/// token: the cache key reads `credentialsId` and not `audience`, so the
/// audience fills it when Postman named no token. A `tokenName` still wins.
TEST (PostmanImport, SeparatesTheCachedTokensOfTwoImportedAudiences) {
    const auto request = [] (const std::string& name, const std::string& extra) {
        return R"({"name":")" + name + R"(","request":{"method":"GET","url":"https://api.example.com/x",
            "auth":{"type":"oauth2","oauth2":[
                {"key":"grant_type","value":"client_credentials"},
                {"key":"accessTokenUrl","value":"https://auth.example.com/token"},
                {"key":"clientId","value":"abc"})" +
        extra + R"(]}}})";
    };
    const auto audience = [] (const std::string& value) {
        return R"(,{"key":"tokenRequestParams","value":[{"key":"audience","value":")" +
        value + R"(","enabled":true,"send_as":"request_body"}]})";
    };
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) +
    R"("},"item":[)" + request ("A", audience ("https://a.example")) + "," +
    request ("B", audience ("https://b.example")) + "," +
    request ("Named", audience ("https://a.example") + R"(,{"key":"tokenName","value":"Prod"})") + "]}",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    const auto key_of    = [&requests] (size_t at) {
        return vayu::http::oauth::cache_key (requests.at (at).at ("auth").at ("config"));
    };
    EXPECT_NE (key_of (0), key_of (1));
    EXPECT_EQ (requests.at (2).at ("auth").at ("config").at ("credentialsId"), "Prod");
}

// Issue #1771: a query row holds raw query text, as Postman's
// `QueryParam.parse` reads it, and `%` is never encoded on the join, so an
// invalid escape is kept byte for byte and nothing is counted.
TEST (PostmanImport, KeepsAnInvalidPercentEscapeAsWritten) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) +
    R"("},"item":[{"name":"R","request":{"method":"GET",
        "url":"https://api.example.com/search?q=%ZZ"}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("params")[0].at ("value"), "%ZZ");
    EXPECT_EQ (request.at ("url"), "https://api.example.com/search?q=%ZZ");
    EXPECT_TRUE (parsed.result.at ("meta").at ("skipped").empty ());
}

// Issue #1771: a string URL's query is split, never decoded. Decoding would
// turn `%2B` into a `+` a server reads as a space. Mutation check: decode the
// key and value in `query_entries` and the row reads `a+b`.
TEST (PostmanImport, ReadsAStringUrlsQueryRawAndEncodesOnlyPostmansSet) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) +
    R"("},"item":[{"name":"R","request":{"method":"GET",
        "url":"https://api.example.com/search?q=a%2Bb&r=c d"}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    ASSERT_EQ (request.at ("params").size (), 2U);
    EXPECT_EQ (request.at ("params")[0].at ("value"), "a%2Bb");
    EXPECT_EQ (request.at ("params")[1].at ("value"), "c d");
    EXPECT_EQ (request.at ("url"), "https://api.example.com/search?q=a%2Bb&r=c%20d");
}

/**
 * What an export back to Postman needs the import to have kept (the Postman
 * exporter's round trip): each case pins one piece of a Postman document
 * that used to be rewritten or dropped on the way in, and is a mutation
 * check on it.
 */
TEST (PostmanImport, KeepsEveryEventInDocumentOrderAndADisabledOneTurnedOff) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"j("},"item":[
        {"name":"R","event":[
            {"listen":"test","script":{"exec":["t()"]}},
            {"listen":"prerequest","script":{"exec":["p()"]},"disabled":true},
            {"listen":"test","script":{"exec":["u()"]}}
        ],"request":{"method":"GET","url":"https://x.com"}}
    ]})j",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& elements =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("elements");
    ASSERT_EQ (elements.size (), 3U);
    EXPECT_EQ (elements[0].at ("kind"), "script.post");
    EXPECT_EQ (elements[0].at ("config").at ("script"), "t()");
    EXPECT_FALSE (elements[0].contains ("enabled"));
    // Postman's runtime skips a disabled event; importing it active would run
    // a script the collection had switched off.
    EXPECT_EQ (elements[1].at ("kind"), "script.pre");
    EXPECT_EQ (elements[1].at ("enabled"), false);
    // A second event of one listen used to be dropped without a count.
    EXPECT_EQ (elements[2].at ("config").at ("script"), "u()");
}

TEST (PostmanImport, KeepsARawBodysUndeclaredLanguageWithoutChangingItsMode) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"None","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"raw","raw":"{\"a\":1}"}}},
        {"name":"Js","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"raw","raw":"let a;","options":{"raw":{"language":"javascript"}}}}},
        {"name":"Json","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"raw","raw":"{}","options":{"raw":{"language":"json"}}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    // Still sniffed - what Vayu sends is unchanged - with "declared none" kept.
    EXPECT_EQ (requests[0].at ("body"),
    (json{ { "mode", "json" }, { "content", "{\"a\":1}" }, { "rawLanguage", "" } }));
    EXPECT_EQ (requests[1].at ("body"),
    (json{ { "mode", "text" }, { "content", "let a;" }, { "rawLanguage", "javascript" } }));
    // A language that is a Vayu mode needs nothing kept beside it.
    EXPECT_FALSE (requests[2].at ("body").contains ("rawLanguage"));
}

TEST (PostmanImport, KeepsAHeaderRowsTypeAndAQueryRowsEquals) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"POST",
            "header":[{"key":"A","value":"1","type":"default"},{"key":"B","value":"2","type":"text"}],
            "body":{"mode":"urlencoded","urlencoded":[{"key":"f","value":"v","type":"default"}]},
            "url":{"raw":"https://x.com/a?expand=","query":[{"key":"expand","value":"","equals":true}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("headers")[0].at ("type"), "default");
    // `text` is the default the exporter writes for a row with none.
    EXPECT_FALSE (request.at ("headers")[1].contains ("type"));
    EXPECT_EQ (request.at ("body").at ("fields")[0].at ("type"), "default");
    EXPECT_EQ (request.at ("params")[0].at ("equals"), true);
    // Carried beside the row, never onto the wire: the empty string is what
    // joins it as `expand=`.
    EXPECT_EQ (request.at ("url"), "https://x.com/a?expand=");
}

TEST (PostmanImport, ReadsAnItemLevelDescriptionWhenTheRequestHasNone) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"Item","description":"On the item","request":{"method":"GET","url":"https://x.com"}},
        {"name":"Both","description":"On the item",
            "request":{"method":"GET","url":"https://x.com","description":{"content":"On the request"}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("description"), "On the item");
    EXPECT_EQ (requests[1].at ("description"), "On the request");
}

/// The first request's auth of a one-request Postman collection whose request
/// auth is @p auth.
json request_auth_of (const std::string& auth) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) +
    R"("},"item":[{"name":"R","request":{"method":"GET","url":"https://x.com","auth":)" +
    auth + "}}]}",
    {}, {});
    if (!parsed.ok ()) {
        ADD_FAILURE () << parsed.error;
        return json ();
    }
    return json::parse (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("auth").dump ());
}

TEST (PostmanImport, ASeededOAuth2TokenIsSentAsPostmanSendsItAndKeepsItsBlock) {
    // commercetools' shape (a v2.0 detail object): no grant, a seeded token.
    const json bearer = request_auth_of (
    R"({"type":"oauth2","oauth2":{"accessToken":"{{t}}","addTokenTo":"header","tokenType":"Bearer"}})");
    EXPECT_EQ (bearer.at ("mode"), "bearer");
    EXPECT_EQ (bearer.at ("token"), "{{t}}");
    // The block rides beside it in v2.1 form, types as Postman converts them.
    EXPECT_EQ (bearer.at ("postman"), json::parse (R"({"type":"oauth2","oauth2":[
        {"key":"accessToken","value":"{{t}}","type":"string"},
        {"key":"addTokenTo","value":"header","type":"string"},
        {"key":"tokenType","value":"Bearer","type":"string"}]})"));

    // Placed in the query, or under another prefix, Postman sends something a
    // bearer token cannot: an API key in the right place says it exactly.
    const json query = request_auth_of (
    R"({"type":"oauth2","oauth2":[{"key":"accessToken","value":"t"},{"key":"addTokenTo","value":"queryParams"}]})");
    EXPECT_EQ (query.at ("mode"), "apikey");
    EXPECT_EQ (query.at ("key"), "access_token");
    EXPECT_EQ (query.at ("in"), "query");
    EXPECT_EQ (query.at ("value"), "t");
    const json prefixed = request_auth_of (
    R"({"type":"oauth2","oauth2":[{"key":"accessToken","value":"t"},{"key":"headerPrefix","value":"Token"}]})");
    EXPECT_EQ (prefixed.at ("mode"), "apikey");
    EXPECT_EQ (prefixed.at ("key"), "Authorization");
    EXPECT_EQ (prefixed.at ("value"), "Token t");
}

TEST (PostmanImport, KeepsAnAuthBlockOnlyWhenTheExportWouldNotGiveItBack) {
    // Exactly what the exporter writes for this bearer token: nothing kept.
    EXPECT_FALSE (request_auth_of (R"({"type":"bearer","bearer":[{"key":"token","value":"{{t}}","type":"string"}]})")
    .contains ("postman"));
    // An oauth2 grant carrying what the config has no field for (`state`,
    // a seeded token): kept, so the export writes those back.
    const json grant = request_auth_of (R"({"type":"oauth2","oauth2":[
        {"key":"state","value":"s","type":"string"},
        {"key":"grant_type","value":"client_credentials","type":"string"},
        {"key":"accessTokenUrl","value":"https://a.example.com/t","type":"string"},
        {"key":"accessToken","value":"seed","type":"string"}]})");
    EXPECT_EQ (grant.at ("mode"), "oauth2");
    EXPECT_EQ (grant.at ("postman").at ("oauth2")[0].at ("key"), "state");
    EXPECT_FALSE (grant.at ("config").contains ("accessToken"));
}

// Issue #1765: the three settings Vayu now applies are stored, so only a key
// Vayu keeps but does not apply is counted - once per request. Mutation check:
// put `disableCookies` back into the counted set and the count reads 3.
TEST (PostmanImport, CountsOnlyAProtocolBehaviourVayuStoresButDoesNotApply) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"Headers","protocolProfileBehavior":{"disabledSystemHeaders":{"accept":true}},
            "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Pruning","protocolProfileBehavior":{"disableBodyPruning":true},
            "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Cookies","protocolProfileBehavior":{"disableCookies":true,"disableUrlEncoding":true},
            "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Host","protocolProfileBehavior":{"disabledSystemHeaders":{"host":true,"accept":true}},
            "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Tls","protocolProfileBehavior":{"tlsDisabledProtocols":["TLSv1"],"insecureHTTPParser":true},
            "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Defaults","protocolProfileBehavior":{"insecureHTTPParser":false,"tlsDisabledProtocols":[]},
            "request":{"method":"GET","url":"https://x.com"}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("protocol_behavior"), 2);
}

// The typed fields and the carrier, read off the draft and off the payload
// `POST /import/apply` is sent. The carrier is JSON text in the source's
// member order. Mutation check: drop `disableCookies` from `apply_request`'s
// carry list and the payload assertion reds.
TEST (PostmanImport, StoresTheProtocolSettingsAndKeepsTheWholeObject) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"All","protocolProfileBehavior":{"followRedirects":true,"disableCookies":true,
            "disabledSystemHeaders":{"User-Agent":true,"connection":false,"accept":true},
            "disableUrlEncoding":true},
            "request":{"method":"GET","url":{"raw":"https://x.com/u/:id?q=a|b",
                "protocol":"https","host":["x","com"],"path":["u",":id"],
                "query":[{"key":"q","value":"a|b"}],
                "variable":[{"key":"id","value":"x/y"}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const auto& draft = first_request (parsed.result.at ("collections")[0]);
    EXPECT_EQ (draft.at ("disableCookies"), true);
    EXPECT_EQ (draft.at ("disableUrlEncoding"), true);
    EXPECT_EQ (draft.at ("disabledSystemHeaders"),
    nlohmann::ordered_json::array ({ "user-agent", "accept" }));
    EXPECT_EQ (draft.at ("postmanProtocolBehavior"),
    R"({"followRedirects":true,"disableCookies":true,"disabledSystemHeaders":{"User-Agent":true,"connection":false,"accept":true},"disableUrlEncoding":true})");
    // The query row joined as typed, as the request will send it.
    EXPECT_EQ (draft.at ("url"), "https://x.com/u/:id?q=a|b");

    const nlohmann::json payload =
    nlohmann::json::parse (vayu::core::import_apply_payload (parsed.result).dump ());
    const auto& item = payload.at ("requests")[0];
    EXPECT_EQ (item.at ("disableCookies"), true);
    EXPECT_EQ (item.at ("disableUrlEncoding"), true);
    EXPECT_EQ (item.at ("disabledSystemHeaders"),
    nlohmann::json::array ({ "user-agent", "accept" }));
    EXPECT_TRUE (item.at ("postmanProtocolBehavior").is_string ());
    EXPECT_EQ (item.at ("followRedirects"), true);
}

/// The request called @p name anywhere under @p collection, as a plain `json`.
json postman_request_named (const nlohmann::ordered_json& collection,
const std::string& name) {
    for (const auto& request : collection.at ("requests")) {
        if (request.at ("name") == name) {
            return json::parse (request.dump ());
        }
    }
    for (const auto& child : collection.at ("children")) {
        if (json found = postman_request_named (child, name); !found.is_null ()) {
            return found;
        }
    }
    return json ();
}

// Issue #2538: a folder's or the collection's `protocolProfileBehavior` reaches
// every request below it, nearest key winning (Postman's
// `getProtocolProfileBehaviorResolved`, one level deep), and the request keeps
// only its own object as the export's carrier. A key Vayu cannot apply is
// counted once, on the node that declared it, and named. Mutation checks: pass
// `json::object ()` instead of `behavior` to `pm_request_named` and the
// inheritance assertions fail; drop `note_unapplied_folder_behavior` and the
// count assertion fails.
TEST (PostmanImport, AFolderOrCollectionProtocolBehaviourReachesTheRequestsBelowIt) {
    const ImportParse parsed = parse_import (
    R"({"info":{"name":"Whole","schema":")" + std::string (POSTMAN_SCHEMA) + R"("},
        "protocolProfileBehavior":{"maxRedirects":3,"tlsDisabledProtocols":["TLSv1"]},
        "item":[
        {"name":"Inspect","protocolProfileBehavior":{"followRedirects":false,"strictSSL":false,
            "insecureHTTPParser":true,"disabledSystemHeaders":{"accept":true,"user-agent":true}},
         "item":[
            {"name":"Inherits","request":{"method":"GET","url":"https://x.com"}},
            {"name":"Overrides","protocolProfileBehavior":{"followRedirects":true},
                "request":{"method":"GET","url":"https://x.com"}},
            {"name":"Replaces","protocolProfileBehavior":{"disabledSystemHeaders":{"content-type":true}},
                "request":{"method":"GET","url":"https://x.com"}},
            {"name":"Nested","protocolProfileBehavior":{"disableCookies":true},"item":[
                {"name":"Deep","request":{"method":"GET","url":"https://x.com"}}]}]},
        {"name":"Outside","request":{"method":"GET","url":"https://x.com"}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const auto& root = parsed.result.at ("collections")[0];

    const json inherits = postman_request_named (root, "Inherits");
    EXPECT_EQ (inherits.at ("followRedirects"), false);
    EXPECT_EQ (inherits.at ("verifySSL"), false);
    EXPECT_EQ (inherits.at ("maxRedirects"), 3);
    EXPECT_EQ (inherits.at ("disabledSystemHeaders"),
    json::array ({ "accept", "user-agent" }));
    EXPECT_FALSE (inherits.contains ("disableCookies"));
    EXPECT_FALSE (inherits.contains ("postmanProtocolBehavior"));

    const json overrides = postman_request_named (root, "Overrides");
    EXPECT_EQ (overrides.at ("followRedirects"), true);
    EXPECT_EQ (overrides.at ("verifySSL"), false);
    EXPECT_EQ (overrides.at ("postmanProtocolBehavior"), R"({"followRedirects":true})");

    const json replaces = postman_request_named (root, "Replaces");
    EXPECT_EQ (replaces.at ("disabledSystemHeaders"), json::array ({ "content-type" }));
    EXPECT_EQ (replaces.at ("followRedirects"), false);

    const json deep = postman_request_named (root, "Deep");
    EXPECT_EQ (deep.at ("disableCookies"), true);
    EXPECT_EQ (deep.at ("followRedirects"), false);
    EXPECT_EQ (deep.at ("maxRedirects"), 3);
    EXPECT_FALSE (deep.contains ("postmanProtocolBehavior"));

    const json outside = postman_request_named (root, "Outside");
    EXPECT_EQ (outside.at ("maxRedirects"), 3);
    EXPECT_FALSE (outside.contains ("followRedirects"));
    EXPECT_FALSE (outside.contains ("verifySSL"));

    const json skipped = json::parse (parsed.result.at ("meta").at ("skipped").dump ());
    ASSERT_EQ (skipped.size (), 1u) << skipped.dump ();
    EXPECT_EQ (skipped[0].at ("kind"), "protocol_behavior_folder");
    EXPECT_EQ (skipped[0].at ("count"), 2);
    EXPECT_EQ (skipped[0].at ("names"), json::array ({ "Inspect", "Whole" }));
    EXPECT_FALSE (skipped[0].contains ("requests"));
}

/// One Postman request item, @p behavior and @p body as JSON text (empty omits).
std::string postman_item_text (const std::string& name,
const std::string& method,
const std::string& body,
const std::string& behavior = "") {
    return R"({"name":")" + name + "\"" +
    (behavior.empty () ? "" : R"(,"protocolProfileBehavior":)" + behavior) +
    R"(,"request":{"method":")" + method + "\"" +
    (body.empty () ? "" : R"(,"body":)" + body) + R"(,"url":"https://x.com"}})";
}

std::string join_postman_items (const std::vector<std::string>& items) {
    std::string joined;
    for (const std::string& item : items) {
        joined += (joined.empty () ? "" : ",") + item;
    }
    return joined;
}

/// A folder holding @p items, with its `protocolProfileBehavior` as JSON text.
std::string postman_folder_text (const std::string& name,
const std::string& behavior,
const std::vector<std::string>& items) {
    return R"({"name":")" + name + R"(","protocolProfileBehavior":)" +
    behavior + R"(,"item":[)" + join_postman_items (items) + "]}";
}

/// The names `meta.skipped` lists under `body_on_get` for a collection whose
/// top level carries @p top_level (a member list, or empty) and whose items are
/// @p items.
json body_on_get_names (const std::string& top_level, const std::vector<std::string>& items) {
    const ImportParse parsed = parse_import (R"({"info":{"name":"Whole","schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},)" + top_level +
    (top_level.empty () ? "" : ",") + R"("item":[)" + join_postman_items (items) + "]}",
    {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    const json skipped = json::parse (parsed.result.at ("meta").at ("skipped").dump ());
    for (const json& entry : skipped) {
        if (entry.at ("kind") != "body_on_get") {
            continue;
        }
        EXPECT_EQ (entry.at ("count"), entry.at ("requests").size ());
        return entry.at ("requests");
    }
    return json::array ();
}

// Issue #2540: Postman drops the body of a GET or HEAD before sending unless
// `protocolProfileBehavior.disableBodyPruning` is true, and Vayu sends it, so
// each such request is counted as `body_on_get` and named. "201" is the shape
// of Postman's own examples collection (GET, raw `blahblah`, no setting).
// Mutation checks: drop the method gate and the POST case in the next test
// fails; drop the `disableBodyPruning` overlay in `inherit_protocol_behavior`
// and the folder and collection opt-outs there fail.
TEST (PostmanImport, CountsAGetOrHeadThatCarriesABodyPostmanWouldPrune) {
    const std::string raw = R"({"mode":"raw","raw":"blahblah"})";
    const json names      = body_on_get_names ("",
    { postman_item_text ("201", "GET", raw), postman_item_text ("Head", "HEAD", raw),
    postman_item_text ("Lowercase", "get", raw),
    postman_item_text ("Urlencoded", "GET",
    R"({"mode":"urlencoded","urlencoded":[{"key":"off","value":"1","disabled":true},{"key":"a","value":"1"}]})"),
    postman_item_text ("Formdata", "GET",
    R"({"mode":"formdata","formdata":[{"key":"f","type":"file","src":"/tmp/a.bin"}]})"),
    postman_item_text ("Graphql", "GET",
    R"({"mode":"graphql","graphql":{"query":"{ me { id } }","variables":""}})"),
    postman_item_text ("File", "GET", R"({"mode":"file","file":{"src":"/tmp/a.bin"}})"),
    postman_item_text ("FalseSetting", "GET", raw, R"({"disableBodyPruning":false})"),
    postman_item_text ("NotABoolean", "GET", raw, R"({"disableBodyPruning":"true"})"),
    // The shape of the real collection's request "201": no `method` key,
    // which Postman and `to_method` both read as GET.
    R"({"name":"NoMethod","request":{"body":{"mode":"raw","raw":"blahblah"},"url":"https://x.com"}})" });
    EXPECT_EQ (names,
    json::array ({ "201", "Head", "Lowercase", "Urlencoded", "Formdata",
    "Graphql", "File", "FalseSetting", "NotABoolean", "NoMethod" }));
}

TEST (PostmanImport, DoesNotCountABodyPostmanSendsOrVayuDoesNot) {
    const std::string raw = R"({"mode":"raw","raw":"blahblah"})";
    const json names      = body_on_get_names ("",
    { postman_item_text ("Post", "POST", raw),
    postman_item_text ("Put", "PUT", raw), postman_item_text ("NoBody", "GET", ""),
    postman_item_text ("EmptyRaw", "GET", R"({"mode":"raw","raw":""})"),
    postman_item_text ("ModeNone", "GET", R"({"mode":"none"})"),
    postman_item_text ("Disabled", "GET", R"({"mode":"raw","raw":"x","disabled":true})"),
    postman_item_text ("OnlyDisabledFields", "GET",
    R"({"mode":"urlencoded","urlencoded":[{"key":"a","value":"1","disabled":true}]})"),
    postman_item_text ("NoFields", "GET", R"({"mode":"formdata","formdata":[]})"),
    // Postman's unselected file body; Vayu refuses to send one (#2540).
    postman_item_text ("FileNoSrc", "GET", R"({"mode":"file","file":{"src":null}})"),
    postman_item_text ("FileEmptySrc", "GET", R"({"mode":"file","file":{"src":""}})"),
    postman_item_text ("FileNoMember", "GET", R"({"mode":"file"})"),
    postman_item_text ("OptedOut", "GET", raw, R"({"disableBodyPruning":true})"),
    postman_item_text ("Verb", "PROPFIND", raw) });
    EXPECT_EQ (names, json::array ());
}

TEST (PostmanImport, ABodyPruningOptOutIsResolvedThroughFoldersNearestWinning) {
    const std::string raw     = R"({"mode":"raw","raw":"blahblah"})";
    const std::string opt_out = R"({"disableBodyPruning":true})";
    const std::string opt_in  = R"({"disableBodyPruning":false})";
    const json names =
    body_on_get_names (R"("protocolProfileBehavior":{"disableBodyPruning":true})",
    { postman_folder_text ("Opted", opt_out,
      { postman_item_text ("InFolder", "GET", raw),
      postman_folder_text ("Nested", "{}", { postman_item_text ("InNested", "GET", raw) }),
      postman_item_text ("Overrides", "GET", raw, opt_in) }),
    postman_item_text ("InCollection", "GET", raw),
    postman_folder_text ("Reverts", opt_in,
    { postman_item_text ("InReverted", "GET", raw),
    postman_item_text ("Restored", "GET", raw, opt_out) }) });
    // The collection opts out everywhere, so only a nearer `false` is counted.
    EXPECT_EQ (names, json::array ({ "Overrides", "InReverted" }));
}

TEST (PostmanImport, AFolderBodyPruningOptOutDoesNotReachItsSiblings) {
    const std::string raw = R"({"mode":"raw","raw":"blahblah"})";
    const json names      = body_on_get_names ("",
    { postman_folder_text ("Opted", R"({"disableBodyPruning":true})",
      { postman_item_text ("Inside", "GET", raw) }),
    postman_item_text ("Outside", "GET", raw) });
    EXPECT_EQ (names, json::array ({ "Outside" }));
}

// A GraphQL body's Content-Type is Postman's system header (issue #1765): the
// importer writes it as the body mode's own row, marked the way the Body panel
// marks it, and writes none for a request that refuses `content-type` - as
// Postman sends none. Truthy non-boolean values count, as Postman's runtime
// reads them. Mutation check: pass `false` for `refused` at the Postman call
// of `with_required_content_type` and the refused request gains the row.
TEST (PostmanImport, AGraphqlContentTypeIsTheBodyModesRowUnlessRefused) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"Kept","request":{"method":"POST","url":"https://x.com/g",
            "body":{"mode":"graphql","graphql":{"query":"{ me }"}}}},
        {"name":"Refused","protocolProfileBehavior":{"disabledSystemHeaders":{"content-type":1}},
            "request":{"method":"POST","url":"https://x.com/g",
            "body":{"mode":"graphql","graphql":{"query":"{ me }"}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const auto& requests = parsed.result.at ("collections")[0].at ("requests");
    ASSERT_EQ (requests.size (), 2u);
    EXPECT_EQ (json::parse (requests[0].at ("headers").dump ()),
    json::parse (R"([{"key":"Content-Type","value":"application/json","enabled":true,"source":"body-mode"}])"));
    EXPECT_EQ (requests[1].at ("headers"), nlohmann::ordered_json::array ());
    EXPECT_EQ (requests[1].at ("disabledSystemHeaders"),
    nlohmann::ordered_json::array ({ "content-type" }));
}

/// The requests of a one-folder Postman collection whose bodies are the raw
/// bodies in @p raw_bodies, each `{name, raw, language?, header?, extra?}`.
json raw_body_requests (const json& raw_bodies) {
    json items = json::array ();
    for (const json& spec : raw_bodies) {
        json request = { { "method", "POST" }, { "url", "https://x.com/r" },
            { "body", { { "mode", "raw" }, { "raw", spec.at ("raw") } } } };
        if (spec.contains ("language")) {
            request["body"]["options"] = { { "raw",
            { { "language", spec.at ("language") } } } };
        }
        if (spec.contains ("header")) {
            request["header"] = spec.at ("header");
        }
        json item = { { "name", spec.at ("name") }, { "request", request } };
        if (spec.contains ("behavior")) {
            item["protocolProfileBehavior"] = spec.at ("behavior");
        }
        items.push_back (item);
    }
    const json document = { { "info", { { "name", "C" }, { "schema", POSTMAN_SCHEMA } } },
        { "item", items } };
    const ImportParse parsed = parse_import (document.dump (), {}, {});
    if (!parsed.ok ()) {
        ADD_FAILURE () << parsed.error;
        return json::array ();
    }
    return json::parse (parsed.result.at ("collections")[0].at ("requests").dump ());
}

json body_mode_row (const std::string& content_type) {
    return json::parse (R"([{"key":"Content-Type","value":")" + content_type +
    R"(","enabled":true,"source":"body-mode"}])");
}

// Issue #2539: Postman sends a raw body under the type its language implies
// (`CONTENT_TYPE_LANGUAGE`), so an `html` or `javascript` body imports as a text
// body with that type as the body mode's own row - even when its content parses
// as JSON, which the sniff would have sent as `application/json`. Mutation
// check: drop the `rawLanguage` lookup in `required_content_type` and both rows
// vanish; restore the JSON sniff for a declared language and the first body
// reads `json`.
TEST (PostmanImport, AnHtmlOrJavascriptBodyCarriesItsLanguagesContentType) {
    const json requests = raw_body_requests (json::parse (R"([
        {"name":"Html","raw":"<p>hi</p>","language":"html"},
        {"name":"HtmlThatIsJson","raw":"{\"a\":1}","language":"html"},
        {"name":"Js","raw":"let a;","language":"javascript"}])"));
    ASSERT_EQ (requests.size (), 3U);
    EXPECT_EQ (requests[0].at ("body").at ("mode"), "text");
    EXPECT_EQ (requests[0].at ("body").at ("rawLanguage"), "html");
    EXPECT_EQ (requests[0].at ("headers"), body_mode_row ("text/html"));
    EXPECT_EQ (requests[1].at ("body").at ("mode"), "text");
    EXPECT_EQ (requests[1].at ("headers"), body_mode_row ("text/html"));
    EXPECT_EQ (requests[2].at ("body").at ("mode"), "text");
    EXPECT_EQ (requests[2].at ("headers"), body_mode_row ("application/javascript"));
}

// The row follows the same two guards GraphQL's does: a Content-Type the
// request declares is kept, and one it refuses leaves none. Mutation check:
// drop the `refused` early return, or the enabled-header scan, in
// `with_required_content_type`, and the matching request here reds.
TEST (PostmanImport, AnHtmlBodysRowYieldsToADeclaredOrRefusedContentType) {
    const json requests = raw_body_requests (json::parse (R"([
        {"name":"Own","raw":"<p/>","language":"html",
            "header":[{"key":"content-type","value":"text/html; charset=utf-8"}]},
        {"name":"Disabled","raw":"<p/>","language":"html",
            "header":[{"key":"Content-Type","value":"text/x","disabled":true}]},
        {"name":"Refused","raw":"<p/>","language":"html",
            "behavior":{"disabledSystemHeaders":{"content-type":true}}}])"));
    ASSERT_EQ (requests.size (), 3U);
    EXPECT_EQ (requests[0].at ("headers").size (), 1U);
    EXPECT_EQ (requests[0].at ("headers")[0].at ("value"), "text/html; charset=utf-8");
    EXPECT_FALSE (requests[0].at ("headers")[0].contains ("source"));
    // A disabled row is not sent, so it does not count as declaring one.
    EXPECT_EQ (requests[1].at ("headers").size (), 2U);
    EXPECT_EQ (requests[1].at ("headers")[1],
    json::parse (R"({"key":"Content-Type","value":"text/html","enabled":true,"source":"body-mode"})"));
    EXPECT_EQ (requests[2].at ("headers"), json::array ());
}

// Postman sends a language it has no content type for (`yaml`) as text/plain
// whatever the content looks like, where the sniff would have sent JSON. Only a
// body declaring no language is still sniffed. Mutation check: let a declared
// language fall through to the sniff in `postman_raw_body` and the yaml body
// reads `json`.
TEST (PostmanImport, ADeclaredLanguageWithNoModeIsTextEvenWhenItsContentIsJson) {
    const json requests = raw_body_requests (json::parse (R"([
        {"name":"Yaml","raw":"{\"a\":1}","language":"yaml"},
        {"name":"Unlabelled","raw":"{\"a\":1}"}])"));
    ASSERT_EQ (requests.size (), 2U);
    EXPECT_EQ (requests[0].at ("body"),
    (json{ { "mode", "text" }, { "content", "{\"a\":1}" }, { "rawLanguage", "yaml" } }));
    EXPECT_EQ (requests[0].at ("headers"), json::array ());
    EXPECT_EQ (requests[1].at ("body"),
    (json{ { "mode", "json" }, { "content", "{\"a\":1}" }, { "rawLanguage", "" } }));
    EXPECT_EQ (requests[1].at ("headers"), json::array ());
}

// A form-data text part's own type is Postman's `contentType` on a text row, and
// the engine sends it as that part's Content-Type. Mutation check: drop the
// `contentType` copy in `formdata_fields` and the first part reds.
TEST (PostmanImport, AFormDataTextPartKeepsItsContentType) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"formdata","formdata":[
                {"key":"meta","value":"{}","type":"text","contentType":"application/json"},
                {"key":"plain","value":"v","type":"text"},
                {"key":"blank","value":"v","type":"text","contentType":""}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& fields =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("body").at (
    "fields");
    ASSERT_EQ (fields.size (), 3U);
    EXPECT_EQ (fields[0].at ("contentType"), "application/json");
    EXPECT_FALSE (fields[1].contains ("contentType"));
    EXPECT_FALSE (fields[2].contains ("contentType"));
}

} // namespace
