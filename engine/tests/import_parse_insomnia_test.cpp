/**
 * @file tests/import_parse_insomnia_test.cpp
 * @brief Insomnia v4 and v5 imports: paths, bodies, auth, environments, cookie settings and the
 * scripts and credentials a document carries.
 *
 * The helpers more than one of these files reads are in `import_parse_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/http/request_composer.hpp"
#include "wide_json.hpp"

#include "import_parse_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::parse_import;
using vayu::tests::import_parse::first_request;
using vayu::tests::import_parse::Names;
using vayu::tests::import_parse::names_in;
using vayu::tests::import_parse::skip_counts;
using vayu::tests::import_parse::skipped_named;

/**
 * Insomnia keeps `pathParameters` per request and writes each into its
 * `/:name` segment at send time (`applyPathParametersToUrl`), so they import
 * as that request's own path rows (issue #1764): the URL keeps `:userId`, the
 * value rides on an `in: "path"` row, and nothing is promoted to a
 * workspace or folder variable. A `:name` with no declared parameter gets no
 * row: the Params tab shows one for it without a stored row, and an invented
 * row would be exported as a variable the source never declared.
 */
TEST (InsomniaImport, KeepsAPathParameterAsTheRequestsOwnPathRow) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"grp","_type":"request_group","parentId":"wrk","name":"G"},
        {"_id":"req","_type":"request","parentId":"grp","name":"R","method":"get",
            "url":"https://api.example.com/users/:userId/:extra",
            "parameters":[{"name":"q","value":"1"}],
            "pathParameters":[{"name":"userId","value":"42"}]}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& collection = parsed.result.at ("collections")[0];
    EXPECT_TRUE (collection.at ("variables").empty ());
    const json& folder = collection.at ("children")[0];
    EXPECT_TRUE (folder.at ("variables").empty ());
    const json& request = folder.at ("requests")[0];
    // The query row is joined into the URL; the path rows are not.
    EXPECT_EQ (request.at ("url"), "https://api.example.com/users/:userId/:extra?q=1");
    EXPECT_EQ (request.at ("params"), json::parse (R"([
        {"key":"q","value":"1","enabled":true},
        {"key":"userId","value":"42","enabled":true,"in":"path"}])"));
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("path_variables"));
}

/**
 * An Insomnia binary body keeps the path in `fileName` and its media type in
 * `mimeType`: it imports as a `binary` body sending that file under that type,
 * counted, where it used to be dropped. A multipart file param with no path
 * imports as a part with no file chosen.
 */
TEST (InsomniaImport, ABinaryBodyImportsAsABinaryBodyNamingThePath) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"req","_type":"request","parentId":"wrk","name":"Put","method":"PUT",
            "url":"https://x.com/a",
            "body":{"mimeType":"application/octet-stream","fileName":"C:\\data\\a.bin"}},
        {"_id":"req2","_type":"request","parentId":"wrk","name":"Form","method":"POST",
            "url":"https://x.com/b",
            "body":{"mimeType":"multipart/form-data","params":[{"name":"doc","type":"file"}]}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const auto& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("body").dump (),
    R"({"mode":"binary","file":{"src":"C:\\data\\a.bin","fileName":"a.bin","contentType":"application/octet-stream"}})");
    EXPECT_EQ (requests[1].at ("body").dump (),
    R"({"mode":"form-data","fields":[{"key":"doc","value":"","enabled":true,"type":"file","src":""}]})");
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("file_body"), 1);
    EXPECT_EQ (parsed.result.at ("meta").at ("unattachedFileParts"), 1);
}

/**
 * A `:` inside a query value (a timestamp, a scoped tag, a port in a redirect
 * URL) is ordinary text, not a path-variable token (issue #1661): the URL
 * comes back as written and no row is invented for `color:id`.
 */
TEST (InsomniaImport, LeavesAColonInAQueryValueUntouched) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"req","_type":"request","parentId":"wrk","name":"R","method":"get",
            "url":"https://api.example.com/search?tag=color:id"}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("url"), "https://api.example.com/search?tag=color:id");
    EXPECT_TRUE (request.at ("params").empty ());
}

/**
 * Insomnia's rows keep `encodeURIComponent` on the join (issue #1771): Postman's
 * set would send a literal `+` raw, which a server reads as a space. Mutation
 * check: pass `QueryEncoding::Postman` for Insomnia and the `|` goes out raw.
 * An empty value joins as a bare `name`, as Insomnia's own strict join writes
 * it; mutation check: drop the `UriComponent` term from `query_string`'s
 * `bare` and `e` goes out as `e=`.
 */
TEST (InsomniaImport, JoinsItsParametersWithEncodeUriComponent) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"req","_type":"request","parentId":"wrk","name":"R","method":"get",
            "url":"https://api.example.com/search",
            "parameters":[{"name":"q","value":"a|b"},{"name":"p","value":"1+2"},{"name":"e","value":""}]}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("url"), "https://api.example.com/search?q=a%7Cb&p=1%2B2&e");
}

/**
 * Insomnia's explicit "No Auth" (`type: "none"`) must terminate inheritance
 * the same way Postman's `noauth` already does - falling through to
 * `inherit` would send a folder's credentials to a request the user
 * explicitly opted out of them for (issue #1444). Mutation check: removing
 * the `named == "none"` branch in `insomnia_auth` reds `mode` to `inherit`.
 */
TEST (InsomniaImport, ExplicitNoneAuthTerminatesInheritanceRatherThanFallingBackToIt) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"grp","_type":"request_group","parentId":"wrk","name":"G",
            "authentication":{"type":"bearer","token":"secret"}},
        {"_id":"req","_type":"request","parentId":"grp","name":"R","method":"get",
            "url":"https://api.example.com/public",
            "authentication":{"type":"none"}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& folder = parsed.result.at ("collections")[0].at ("children")[0];
    EXPECT_EQ (folder.at ("requests")[0].at ("auth").at ("mode"), "none");
}

/**
 * Insomnia writes `{{ _.a.b }}` for a nested environment value and the importer
 * rewrites it to `{{a.b}}`, which the composer looks up as one whole name. So
 * `data: {a: {b: 1}}` has to land as the variable `a.b`; stringified into one
 * `a` it left the template unresolved with no notice. Arrays and empty objects
 * stay one variable of JSON text, and a sub-environment overrides a nested
 * leaf in place. Mutation check: make `add_env_var` stringify an object again
 * and the dotted names, the resolved URL and the override all fail.
 */
TEST (InsomniaImport, FlattensANestedEnvironmentValueIntoDottedVariables) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W",
            "environment":{"a":{"b":1,"c":{"d":"deep"}},"flat":"v"}},
        {"_id":"req","_type":"request","parentId":"wrk","name":"R","method":"get",
            "url":"https://x.com/{{ _.a.b }}/{{ _.a.c.d }}/{{ _.flat }}"},
        {"_id":"env","_type":"environment","parentId":"wrk","name":"Base",
            "data":{"a":{"b":1,"c":{"d":"deep"}},"list":[1,2],"empty":{},"flat":"v"}},
        {"_id":"sub","_type":"environment","parentId":"env","name":"Prod",
            "data":{"a":{"b":2}}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& workspace =
    parsed.result.at ("collections")[0].at ("variables");
    EXPECT_FALSE (workspace.contains ("a"));
    EXPECT_EQ (workspace.at ("a.b").at ("value"), "1");
    EXPECT_EQ (workspace.at ("a.c.d").at ("value"), "deep");

    const std::string url = first_request (parsed.result.at ("collections")[0]).at ("url");
    ASSERT_EQ (url, "https://x.com/{{a.b}}/{{a.c.d}}/{{flat}}");
    const auto resolved = [&url] (const json& variables) {
        return vayu::http::substitute_tokens (url,
        [&variables] (const std::string& name) -> std::optional<std::string> {
            return variables.contains (name) ?
            std::optional<std::string> (
            variables.at (name).at ("value").get<std::string> ()) :
            std::nullopt;
        });
    };
    const json& prod = parsed.result.at ("environments")[0].at ("variables");
    EXPECT_EQ (prod.at ("list").at ("value"), "[1,2]");
    EXPECT_EQ (prod.at ("empty").at ("value"), "{}");
    EXPECT_EQ (resolved (prod), "https://x.com/2/deep/v");
    EXPECT_EQ (resolved (workspace), "https://x.com/1/deep/v");
}

/**
 * Insomnia keeps `settingSendCookies` and `settingStoreCookies` per request
 * (both on by default); Vayu's one `disableCookies` keeps a request away from
 * the jar in both directions, so either explicitly `false` sets it. Absent,
 * `true` and a non-boolean leave it unset. Mutation checks: drop the call to
 * `insomnia_cookie_settings` and every "disabled" case fails; stop at the
 * first setting (remove the loop's second name) and the store-only case fails.
 */
TEST (InsomniaImport, EitherCookieSettingOffDisablesTheRequestsCookies) {
    const std::vector<std::pair<std::string, bool>> cases{
        { R"("settingSendCookies":false)", true },
        { R"("settingStoreCookies":false)", true },
        { R"("settingSendCookies":false,"settingStoreCookies":false)", true },
        { R"("settingSendCookies":true,"settingStoreCookies":false)", true },
        { R"("settingSendCookies":true,"settingStoreCookies":true)", false },
        { R"("settingSendCookies":"false")", false },
        { R"("settingFollowRedirects":"on")", false },
    };
    for (const auto& [settings, disabled] : cases) {
        SCOPED_TRACE (settings);
        const ImportParse parsed = parse_import (
        R"({"_type":"export","__export_format":4,"resources":[
            {"_id":"wrk","_type":"workspace","name":"W"},
            {"_id":"req","_type":"request","parentId":"wrk","name":"R","method":"get",
            "url":"https://x.com",)" +
        settings + "}]}",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const auto& request = first_request (parsed.result.at ("collections")[0]);
        EXPECT_EQ (request.contains ("disableCookies"), disabled);
        if (disabled) {
            EXPECT_EQ (request.at ("disableCookies"), true);
        }
    }
}

/**
 * A digest, NTLM or IAM node is stored as an opaque `config` bag, but its
 * strings are template-bearing like any other auth field: `{{ _.x }}` becomes
 * `{{x}}`, in a nested member and an array element too, and a non-string
 * member is untouched. Mutation check: copy the member through unchanged in
 * `insomnia_config` and the three modes keep the `_.` spelling.
 */
TEST (InsomniaImport, NormalisesTemplatesInAnOpaqueAuthConfig) {
    for (const char* type : { "digest", "ntlm", "iam" }) {
        SCOPED_TRACE (type);
        const ImportParse parsed = parse_import (std::string (R"({"_type":"export","__export_format":4,"resources":[
            {"_id":"wrk","_type":"workspace","name":"W"},
            {"_id":"req","_type":"request","parentId":"wrk","name":"R","method":"get",
            "url":"https://x.com","authentication":{"type":")") +
        type +
        R"(","disabled":false,"username":"{{ _.user }}","password":"p",
            "retries":3,"extra":{"hosts":["{{ _.host }}","literal"]}}}]})",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const json& auth = first_request (parsed.result.at ("collections")[0]).at ("auth");
        EXPECT_EQ (auth.at ("config"),
        (json{ { "username", "{{user}}" }, { "password", "p" }, { "retries", 3 },
        { "extra", { { "hosts", json::array ({ "{{host}}", "literal" }) } } } }));
    }
}

/**
 * Insomnia v5 is read by flattening it into the v4 resource list (#2119), so
 * the same workspace exported by either version imports as the same tree;
 * only `meta.format` says which file it was. Mutation check: drop the
 * `insomnia_type` branch from `parse_import`'s chain and the v5 half answers
 * "Unrecognised format".
 */
TEST (InsomniaV5Import, ReadsTheSameWorkspaceItsV4ExportDoes) {
    const ImportParse v4 = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"Acme","description":"ws"},
        {"_id":"grp","_type":"request_group","parentId":"wrk","name":"Users",
            "description":"people","authentication":{"type":"bearer","token":"{{ _.token }}"},
            "preRequestScript":"console.log(1);"},
        {"_id":"req","_type":"request","parentId":"grp","name":"List","method":"get",
            "url":"{{ _.baseUrl }}/users","description":"all",
            "parameters":[{"name":"page","value":"1"},{"name":"q","value":"a|b","disabled":true}],
            "headers":[{"name":"Accept","value":"application/json"}],
            "body":{"mimeType":"application/json","text":"{}"},
            "authentication":{"type":"basic","username":"u","password":"p"},
            "afterResponseScript":"insomnia.test('x', () => {});",
            "settingFollowRedirects":"off"},
        {"_id":"ws","_type":"websocket_request","parentId":"wrk","name":"Live"},
        {"_id":"env","_type":"environment","parentId":"wrk","name":"Base Environment",
            "data":{"baseUrl":"https://a","port":8080}},
        {"_id":"sub","_type":"environment","parentId":"env","name":"Prod",
            "data":{"baseUrl":"https://b"}}]})",
    {}, {});
    const ImportParse v5 = parse_import (R"(type: collection.insomnia.rest/5.0
name: Acme
meta:
  id: wrk_acme
  description: ws
collection:
  - name: Users
    meta:
      id: fld_users
      description: people
    authentication:
      type: bearer
      token: "{{ _.token }}"
    scripts:
      preRequest: console.log(1);
    children:
      - url: "{{ _.baseUrl }}/users"
        name: List
        meta:
          id: req_list
          description: all
        method: get
        parameters:
          - name: page
            value: "1"
          - name: q
            value: a|b
            disabled: true
        headers:
          - name: Accept
            value: application/json
        body:
          mimeType: application/json
          text: "{}"
        authentication:
          type: basic
          username: u
          password: p
        scripts:
          afterResponse: insomnia.test('x', () => {});
        settings:
          followRedirects: "off"
  - url: wss://a.example/live
    name: Live
environments:
  name: Base Environment
  data:
    baseUrl: https://a
    port: 8080
  subEnvironments:
    - name: Prod
      data:
        baseUrl: https://b
)",
    {}, {});
    ASSERT_TRUE (v4.ok ()) << v4.error;
    ASSERT_TRUE (v5.ok ()) << v5.error;
    EXPECT_EQ (v4.result.at ("meta").at ("format"), "Insomnia Export v4");
    EXPECT_EQ (v5.result.at ("meta").at ("format"), "Insomnia Export v5");

    nlohmann::ordered_json from_v5 = v5.result;
    from_v5["meta"]["format"]      = "Insomnia Export v4";
    EXPECT_EQ (from_v5, v4.result);
    // The comparison above would pass on two empty trees.
    EXPECT_EQ (v5.result.at ("meta").at ("requestCount"), 1);
    EXPECT_EQ (v5.result.at ("meta").at ("environmentCount"), 1);
}

/**
 * A design document, a mock server export and a collection in another format
 * version are refused by name rather than as "Unrecognised format" (#2119): a
 * person who picked the wrong file is told what it is, and the dialog shows
 * the sentence as written. Mutation check: return `std::nullopt` from
 * `insomnia_type` and every case answers "Unrecognised format".
 */
TEST (InsomniaV5Import, RefusesWhatIsNotACollectionByName) {
    const std::vector<std::pair<std::string, std::string>> cases{
        { "spec.insomnia.rest/5.0",
        "Couldn't read the document: this is an Insomnia design document "
        "(spec) "
        "export, which Vayu does not read. Export the collection instead." },
        { "mock.insomnia.rest/5.0",
        "Couldn't read the document: this is an Insomnia mock server export, "
        "which Vayu does not read. Export the collection instead." },
        { "mcpClient.insomnia.rest/5.0",
        "Couldn't read the document: this is an Insomnia mcpClient export, "
        "which "
        "Vayu does not read. Export the collection instead." },
        { "collection.insomnia.rest/6.0",
        "Couldn't read the document: this is an Insomnia collection export in "
        "format 6.0, which this version of Vayu does not read. It reads format "
        "5." },
    };
    for (const auto& [type, sentence] : cases) {
        const ImportParse parsed =
        parse_import ("type: " + type + "\nname: Design\ncollection: []\n", {}, {});
        EXPECT_FALSE (parsed.ok ()) << type;
        EXPECT_FALSE (parsed.unrecognised) << type;
        EXPECT_EQ (parsed.error, sentence) << type;
    }
}

/// A minor revision of format 5 reads, and so does the same document written
/// as JSON - the reader takes either, and nothing about v5 is YAML-only.
TEST (InsomniaV5Import, ReadsAMinorRevisionAndAJsonEncodedExport) {
    for (const std::string& document :
    { std::string (
      "type: collection.insomnia.rest/5.1\nname: W\ncollection:\n"
      "  - name: R\n    url: https://x.example/a\n    method: POST\n"),
    std::string (R"({"type":"collection.insomnia.rest/5.0","name":"W","collection":[
            {"name":"R","url":"https://x.example/a","method":"POST"}]})") }) {
        const ImportParse parsed = parse_import (document, {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (parsed.result.at ("meta").at ("format"), "Insomnia Export v5");
        const auto& request =
        parsed.result.at ("collections")[0].at ("requests")[0];
        EXPECT_EQ (request.at ("method"), "POST");
        EXPECT_EQ (request.at ("url"), "https://x.example/a");
    }
}

/// A `type` that merely names something is not Insomnia's, and is still
/// unrecognised rather than refused as an Insomnia document.
TEST (InsomniaV5Import, LeavesAnUnrelatedTypeMemberUnrecognised) {
    for (const char* document : { R"({"type":"collection","name":"x"})",
         R"({"type":".insomnia.rest/5.0"})", R"({"type":"collection.insomnia.rest/"})" }) {
        const ImportParse parsed = parse_import (document, {}, {});
        EXPECT_TRUE (parsed.unrecognised) << document;
        EXPECT_EQ (parsed.error, "Unrecognised format") << document;
    }
}

/// v5 nests where v4 listed, so a broken export names the nested field.
TEST (InsomniaV5Import, NamesTheFieldOfAMalformedExport) {
    const std::vector<std::pair<std::string, std::string>> cases{
        { "collection: nope", "Malformed Insomnia export: `collection` must be an array" },
        { "collection:\n  - name: F\n    children: [1]", "Malformed Insomnia export: `collection[0].children[0]` must be an object" },
        { "environments: [1]", "Malformed Insomnia export: `environments` must be an object" },
        { "environments:\n  subEnvironments: {}", "Malformed Insomnia export: `environments.subEnvironments` must be an array" },
    };
    for (const auto& [body, sentence] : cases) {
        const ImportParse parsed =
        parse_import ("type: collection.insomnia.rest/5.0\n" + body + "\n", {}, {});
        EXPECT_FALSE (parsed.unrecognised) << body;
        EXPECT_EQ (parsed.error, sentence) << body;
    }
}

/**
 * An environment document holds environments only, gated by the same option
 * as every other format's. With no sub-environment the one environment is
 * named after the document, not after the base environment; with
 * sub-environments each is one environment, the base written under it.
 */
TEST (InsomniaV5Import, AnEnvironmentDocumentImportsItsEnvironmentsOnly) {
    const std::string document = R"(type: environment.insomnia.rest/5.0
name: Shared
environments:
  name: Base Environment
  data:
    region: eu
    key: k
  subEnvironments:
    - name: Staging
      data:
        region: us
)";
    const ImportParse parsed   = parse_import (document, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_TRUE (parsed.result.at ("collections").empty ());
    EXPECT_EQ (parsed.result.at ("environments").dump (),
    R"([{"name":"Staging","description":"","variables":{"region":{"value":"us","enabled":true},"key":{"value":"k","enabled":true}}}])");

    ImportOptions off;
    off.import_environments = false;
    const ImportParse gated = parse_import (document, off, {});
    ASSERT_TRUE (gated.ok ()) << gated.error;
    EXPECT_TRUE (gated.result.at ("environments").empty ());
    EXPECT_EQ (gated.result.at ("meta").at ("environmentCount"), 0);
}

/**
 * `settings.followRedirects` is a JSON boolean in v5 where v4 wrote a string;
 * both spellings land on the request's own `followRedirects`. Mutation check:
 * passing a boolean through unconverted in `carry_redirects` leaves the field
 * absent for both cases.
 */
TEST (InsomniaV5Import, ReadsABooleanFollowRedirectsSetting) {
    for (const bool follow : { true, false }) {
        SCOPED_TRACE (follow ? "true" : "false");
        const ImportParse parsed = parse_import (
        std::string (
        "type: collection.insomnia.rest/5.0\nname: W\ncollection:\n"
        "  - name: R\n    url: https://x.example/a\n    method: GET\n"
        "    settings:\n      followRedirects: ") +
        (follow ? "true" : "false") + "\n",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const auto& request = first_request (parsed.result.at ("collections")[0]);
        ASSERT_TRUE (request.contains ("followRedirects"));
        EXPECT_EQ (request.at ("followRedirects"), follow);
    }
}

/**
 * v5 spells the two cookie settings `settings.cookies.send` / `.store`; they
 * read as v4's `settingSendCookies` / `settingStoreCookies`, so either `false`
 * disables the request's cookies. Mutation check: remove the call to
 * `carry_cookie_settings` in the flattener and both cases lose the field.
 */
TEST (InsomniaV5Import, ReadsTheCookieSettingsOfARequest) {
    for (const std::string member : { "send", "store" }) {
        SCOPED_TRACE (member);
        for (const bool on : { true, false }) {
            SCOPED_TRACE (on);
            const ImportParse parsed = parse_import (
            "type: collection.insomnia.rest/5.0\nname: W\ncollection:\n"
            "  - name: R\n    url: https://x.example/a\n    method: GET\n"
            "    settings:\n      cookies:\n        " +
            member + ": " + (on ? "true" : "false") + "\n",
            {}, {});
            ASSERT_TRUE (parsed.ok ()) << parsed.error;
            const auto& request =
            first_request (parsed.result.at ("collections")[0]);
            EXPECT_EQ (request.contains ("disableCookies"), !on);
        }
    }
}

/**
 * A gRPC item is told apart by `protoFileId`, by `protoMethodName` or by the
 * `greq_` prefix of its `meta.id`, any one alone; each is tallied as `grpc`
 * and none becomes a request. Mutation check: dropping any one of the three
 * conditions in `v5_item_kind` turns that case into a request (the URL-bearing
 * items) or drops it uncounted.
 */
TEST (InsomniaV5Import, TalliesAGrpcItemByAnyOfItsThreeMarkers) {
    const std::vector<std::pair<std::string, std::string>> cases{
        { "protoFileId", "    protoFileId: pf_1\n" },
        { "protoMethodName", "    protoMethodName: /pkg.Svc/Call\n" },
        { "greq_ id", "    meta:\n      id: greq_1\n" },
    };
    for (const auto& [marker, member] : cases) {
        SCOPED_TRACE (marker);
        const ImportParse parsed = parse_import (
        "type: collection.insomnia.rest/5.0\nname: W\ncollection:\n"
        "  - name: G\n    url: grpcb.in:9000\n" +
        member,
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (parsed.result.at ("meta").at ("requestCount"), 0);
        EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("grpc"), 1);
    }
}

/**
 * `importScripts=false` drops a v5 item's `scripts` as it drops a v4 item's,
 * and the same document keeps them with the option on. Mutation check: carrying
 * the scripts regardless of the option, or never carrying them, reds one side.
 */
TEST (InsomniaV5Import, ImportScriptsOffDropsTheScripts) {
    const std::string document = R"(type: collection.insomnia.rest/5.0
name: W
collection:
  - name: R
    url: https://x.example/a
    method: GET
    scripts:
      preRequest: console.log(1);
      afterResponse: insomnia.test('x', () => {});
)";
    const ImportParse on       = parse_import (document, {}, {});
    ASSERT_TRUE (on.ok ()) << on.error;
    EXPECT_EQ (first_request (on.result.at ("collections")[0]).at ("elements").size (), 2U);

    ImportOptions off;
    off.import_scripts      = false;
    const ImportParse gated = parse_import (document, off, {});
    ASSERT_TRUE (gated.ok ()) << gated.error;
    EXPECT_FALSE (first_request (gated.result.at ("collections")[0]).contains ("elements"));
}

/**
 * An environment document with no sub-environment imports one environment
 * named after the document, whatever the base environment calls itself, and
 * "Environment" when the document has no name either. A collection document's
 * base keeps its own name. Mutation check: carrying the base's `name` for an
 * environment document (the `V5Collection` guard in `add_environments`) names
 * the first case after the base; the fallback is the `resource_name` default.
 */
TEST (InsomniaV5Import, NamesALoneEnvironmentAfterTheDocument) {
    const auto only_name = [] (const std::string& document) {
        const ImportParse parsed = parse_import (document, {}, {});
        EXPECT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (parsed.result.at ("environments").size (), 1U);
        return parsed.result.at ("environments")[0].at ("name");
    };
    EXPECT_EQ (
    only_name ("type: environment.insomnia.rest/5.0\nname: Shared\n"
               "environments:\n  name: Whatever\n  data:\n    a: 1\n"),
    "Shared");
    EXPECT_EQ (only_name ("type: environment.insomnia.rest/5.0\n"
                          "environments:\n  data:\n    a: 1\n"),
    "Environment");
    EXPECT_EQ (only_name ("type: collection.insomnia.rest/5.0\nname: Acme\n"
                          "environments:\n  name: Base\n  data:\n    a: 1\n"),
    "Base");
}

/**
 * An empty folder may be written without `children`; its `fld_` id is what
 * says it is a folder. A bare item with neither `url` nor `method` and no such
 * id stays dropped. Mutation check: returning `Unknown` for the `fld_` case in
 * `v5_item_kind` leaves no folder.
 */
TEST (InsomniaV5Import, KeepsAnEmptyFolderWrittenWithoutChildren) {
    const ImportParse parsed = parse_import (R"(type: collection.insomnia.rest/5.0
name: W
collection:
  - name: Empty
    meta:
      id: fld_empty
  - name: Stray
    meta:
      id: other_1
)",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("folderCount"), 1);
    const auto& children = parsed.result.at ("collections")[0].at ("children");
    ASSERT_EQ (children.size (), 1U);
    EXPECT_EQ (children[0].at ("name"), "Empty");
}

/// Insomnia's GraphQL body is sniffed for an envelope by parsing it (#2497).
/// Mutation check: parse with `nlohmann::ordered_json::parse` in
/// `to_graphql_envelope` and this runs for tens of seconds and fails the
/// budget.
TEST (InsomniaImport, AGraphqlBodyOfAHundredThousandMembersIsSniffedInLinearTime) {
    json envelope          = json::parse (vayu::tests::wide_object_json ());
    envelope["query"]      = "{ me }";
    const std::string text = envelope.dump ();
    const json document    = {
        { "_type", "export" },
        { "__export_format", 4 },
        { "resources",
        json::array ({ { { "_id", "wrk" }, { "_type", "workspace" }, { "name", "W" } },
        { { "_id", "req" }, { "_type", "request" }, { "parentId", "wrk" },
        { "name", "G" }, { "method", "POST" }, { "url", "https://x.com/g" },
        { "body", { { "mimeType", "application/graphql" }, { "text", text } } } } }) },
    };
    const std::string source = document.dump ();

    const auto started       = std::chrono::steady_clock::now ();
    const ImportParse parsed = parse_import (source, {}, {});
    const auto elapsed       = std::chrono::steady_clock::now () - started;

    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    const json& body = parsed.result.at ("collections")[0].at ("requests")[0].at ("body");
    EXPECT_EQ (body.at ("mode"), "graphql");
    EXPECT_EQ (body.at ("content"), text)
    << "already an envelope, kept as written";
}

/// One Insomnia v4 resource under @p parent: a folder when @p type is
/// "request_group", else a request.
json insomnia_resource (const char* type,
const std::string& id,
const std::string& parent,
const std::string& name,
const json& authentication = nullptr) {
    json resource = { { "_id", id }, { "_type", type }, { "parentId", parent },
        { "name", name } };
    if (std::string_view (type) == "request") {
        resource["method"] = "GET";
        resource["url"]    = "https://x.com/" + name;
    }
    if (!authentication.is_null ()) {
        resource["authentication"] = authentication;
    }
    return resource;
}

json insomnia_request (const std::string& id,
const std::string& parent,
const std::string& name,
const json& authentication = nullptr) {
    return insomnia_resource ("request", id, parent, name, authentication);
}

json insomnia_folder (const std::string& id,
const std::string& parent,
const std::string& name,
const json& authentication = nullptr) {
    return insomnia_resource ("request_group", id, parent, name, authentication);
}

/// A v4 export of workspace "W" (under @p workspace_auth when given) holding
/// @p resources. When @p ranked every resource carries a `metaSortKey` (its
/// place in the list), so the importer stamps each draft's `order`; otherwise
/// none does and the folders-first listing stands.
ImportParse parse_insomnia_tree (json resources, bool ranked, const json& workspace_auth = nullptr) {
    json workspace = { { "_id", "wrk" }, { "_type", "workspace" }, { "name", "W" } };
    if (!workspace_auth.is_null ()) {
        workspace["authentication"] = workspace_auth;
    }
    json list = json::array ({ std::move (workspace) });
    int key   = 0;
    for (json& resource : resources) {
        if (ranked) {
            resource["metaSortKey"] = key++;
        }
        list.push_back (std::move (resource));
    }
    return parse_import (
    json{ { "_type", "export" }, { "__export_format", 4 }, { "resources", list } }
    .dump (),
    {}, {});
}

/// The requests that lose a data-only auth are those whose *resolved* auth is
/// one (#2610): the folder declaring it is named beside them, not counted, and
/// a request that inherits it is. Both tree shapes run, because an unranked
/// Insomnia tree has no `order` and lists a folder's sub-folders first.
/// Mutation checks: make an `inherit` request stop at its own mode in
/// `walk_data_only_auth` and the inheriting names go missing; drop the
/// `ordered` guard in `items_in_document_order` and the unranked case fails to
/// parse.
TEST (InsomniaImport, CountsTheRequestsThatLoseADataOnlyAuthNotTheFolderDeclaringIt) {
    const json iam = { { "type", "iam" }, { "accessKeyId", "AK" } };
    for (const bool ranked : { true, false }) {
        SCOPED_TRACE (ranked ? "ranked" : "unranked");
        const ImportParse parsed = parse_insomnia_tree (
        json::array ({ insomnia_folder ("signed", "wrk", "Signed", iam),
        insomnia_request ("a", "signed", "Inherits"),
        insomnia_request ("b", "signed", "Opted out", json{ { "type", "none" } }),
        insomnia_folder ("deeper", "signed", "Deeper"),
        insomnia_request ("c", "deeper", "Inherits deep"),
        insomnia_request ("d", "signed", "Own digest", json{ { "type", "digest" } }),
        insomnia_request ("e", "signed", "Own bearer", json{ { "type", "bearer" } }),
        insomnia_request ("f", "wrk", "Outside") }),
        ranked);
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        const json meta = json::parse (parsed.result.at ("meta").dump ());
        EXPECT_EQ (meta.at ("nonExecutableAuth"), 3);
        EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"),
        ranked ? (Names{ "Inherits", "Inherits deep", "Own digest" }) :
                 (Names{ "Inherits deep", "Inherits", "Own digest" }));
        EXPECT_EQ (names_in (meta, "nonExecutableAuthFolders"), Names{ "Signed" });
        EXPECT_FALSE (meta.contains ("nonExecutableAuthCollection"));
    }
}

/// A folder set to Insomnia's No Authentication ends the walk for what is
/// under it, however deep, as `noauth` does in Postman; a folder with no auth,
/// an empty one or a disabled one says nothing and the walk passes through to
/// the workspace's. The workspace is named apart from the folders. Mutation
/// check: drop the `noauth` branch of `insomnia_collection_auth` and "Shielded"
/// and "Shielded deep" are counted.
TEST (InsomniaImport, AFolderSetToNoAuthenticationEndsTheWalkForDataOnlyAuth) {
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_folder ("public", "wrk", "Public", json{ { "type", "none" } }),
    insomnia_folder ("nested", "public", "Nested"), insomnia_request ("a", "nested", "Shielded deep"),
    insomnia_request ("b", "public", "Shielded"), insomnia_folder ("plain", "wrk", "Plain"),
    insomnia_request ("c", "plain", "Through plain"),
    insomnia_folder ("empty", "wrk", "Empty", json::object ()),
    insomnia_request ("d", "empty", "Through empty"),
    insomnia_folder ("off", "wrk", "Off", json{ { "type", "bearer" }, { "disabled", true } }),
    insomnia_request ("e", "off", "Through disabled"), insomnia_request ("f", "wrk", "Top") }),
    true, json{ { "type", "iam" } });
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json meta = json::parse (parsed.result.at ("meta").dump ());
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 4);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"),
    (Names{ "Through plain", "Through empty", "Through disabled", "Top" }));
    EXPECT_EQ (meta.at ("nonExecutableAuthCollection"), "W");
    EXPECT_FALSE (meta.contains ("nonExecutableAuthFolders"));

    const json& folders = parsed.result.at ("collections")[0].at ("children");
    EXPECT_EQ (folders[0].at ("auth").at ("mode"), "noauth");
    for (const size_t plain : { 1U, 2U, 3U }) {
        EXPECT_EQ (folders[plain].at ("auth").at ("mode"), "none") << plain;
    }
}

/// A workspace set to No Authentication stays `none`: nothing sits above it
/// for a `noauth` to shut out.
TEST (InsomniaImport, AWorkspaceSetToNoAuthenticationStaysNone) {
    const ImportParse parsed =
    parse_insomnia_tree (json::array ({ insomnia_request ("a", "wrk", "Top") }),
    true, json{ { "type", "none" } });
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("collections")[0].at ("auth").at ("mode"), "none");
}

/// A v5 export reaches the same walk: a folder holding one inheriting request
/// and one explicitly set to No Authentication loses one.
TEST (InsomniaV5Import, CountsTheRequestsThatLoseADataOnlyAuthNotTheFolderDeclaringIt) {
    const ImportParse parsed = parse_import (R"({"type":"collection.insomnia.rest/5.0",
        "name":"W","collection":[
          {"name":"Signed","authentication":{"type":"iam"},"children":[
            {"name":"Inherits","url":"https://x.example/a","method":"GET"},
            {"name":"Opted out","url":"https://x.example/b","method":"GET",
             "authentication":{"type":"none"}}]}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json meta = json::parse (parsed.result.at ("meta").dump ());
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 1);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"), Names{ "Inherits" });
    EXPECT_EQ (names_in (meta, "nonExecutableAuthFolders"), Names{ "Signed" });
    EXPECT_FALSE (meta.contains ("nonExecutableAuthCollection"));
}

/// Several workspaces in one export are one document: the requests of each
/// count, and the first workspace that declares the auth is the one named.
TEST (InsomniaImport, CountsTheRequestsOfEveryWorkspaceInTheExport) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"w1","_type":"workspace","name":"One"},
        {"_id":"w2","_type":"workspace","name":"Two","authentication":{"type":"digest"}},
        {"_id":"w3","_type":"workspace","name":"Three","authentication":{"type":"ntlm"}},
        {"_id":"r1","_type":"request","parentId":"w1","name":"Plain","method":"GET","url":"https://x.test"},
        {"_id":"r2","_type":"request","parentId":"w2","name":"Digest","method":"GET","url":"https://x.test"},
        {"_id":"r3","_type":"request","parentId":"w3","name":"Ntlm","method":"GET","url":"https://x.test"}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json meta = json::parse (parsed.result.at ("meta").dump ());
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 2);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"), (Names{ "Digest", "Ntlm" }));
    EXPECT_EQ (meta.at ("nonExecutableAuthCollection"), "Two");
}

/// Hawk and OAuth 1.0 are stored as data under their own modes, as Postman's
/// are, not dropped to `inherit`, and the shared `nonExecutableAuth` pass
/// reports them (#3193). Mutation check: take `hawk` and `oauth1` out of
/// `STORED_AUTH_TYPES` and both requests fall to `none`.
TEST (InsomniaImport, HawkAndOAuth1AreStoredAsDataNotInherited) {
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_request ("a", "wrk", "Hawk",
                   json{ { "type", "hawk" }, { "id", "{{ _.hawk_id }}" }, { "key", "k" } }),
    insomnia_request ("b", "wrk", "OAuth1",
    json{ { "type", "oauth1" }, { "consumerKey", "ck" } }) }),
    true, json{ { "type", "bearer" }, { "token", "outer" } });
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("auth").at ("mode"), "hawk");
    EXPECT_EQ (requests[0].at ("auth").at ("config"),
    (json{ { "id", "{{hawk_id}}" }, { "key", "k" } }));
    EXPECT_EQ (requests[1].at ("auth").at ("mode"), "oauth1");
    EXPECT_EQ (requests[1].at ("auth").at ("config"), (json{ { "consumerKey", "ck" } }));

    const json meta = json::parse (parsed.result.at ("meta").dump ());
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 2);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"), (Names{ "Hawk", "OAuth1" }));
    EXPECT_FALSE (skip_counts (meta.at ("skipped")).contains ("unsupported_auth"));
}

/// A type Vayu has no mode for imports as `none`, never `inherit`: inheriting
/// would send the folder's bearer token in place of the ASAP or netrc credential
/// the user chose. Each is counted under `unsupported_auth` and a request is
/// named, a folder is only counted (as Postman's are) and ends the walk
/// (`noauth`); an absent node, an explicit `none` and a node with no type are
/// not losses. Mutation check: return `inherit` again from the tail of
/// `insomnia_auth` and every `none` below turns into `inherit`.
TEST (InsomniaImport, AnAuthTypeWithoutAModeImportsAsNoneAndIsCounted) {
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_folder ("fld", "wrk", "Folder", json{ { "type", "bearer" } }),
    insomnia_request ("a", "fld", "Asap", json{ { "type", "asap" } }),
    insomnia_request ("b", "fld", "Netrc", json{ { "type", "netrc" } }),
    insomnia_request ("c", "fld", "Not a string", json{ { "type", 5 } }),
    insomnia_request ("d", "fld", "Inherits"),
    insomnia_request ("e", "fld", "No type", json::object ()),
    insomnia_request ("f", "fld", "Opted out", json{ { "type", "none" } }),
    insomnia_folder ("odd", "wrk", "Odd folder", json{ { "type", "asap" } }) }),
    true);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& folder = parsed.result.at ("collections")[0].at ("children")[0];
    const std::vector<std::string> expected{ "none", "none", "none", "inherit",
        "inherit", "none" };
    for (size_t at = 0; at < expected.size (); ++at) {
        EXPECT_EQ (folder.at ("requests")[at].at ("auth").at ("mode"), expected[at]) << at;
    }
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("children")[1].at ("auth").at (
    "mode"),
    "noauth");

    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("unsupported_auth"), 4);
    EXPECT_EQ (skipped_named (parsed, "unsupported_auth"),
    (Names{ "Asap", "Netrc", "Not a string" }));
}

/// An explicit `authentication.type` of `inherit` (Insomnia's own "Inherit from
/// parent") is `inherit`, not an unsupported type: it imports as `inherit` and
/// is not counted, on a request; on a folder it is transparent (`none`) like an
/// absent node. Mutation check: delete the `inherit` branch of `insomnia_auth`
/// and the request becomes `none` and `unsupported_auth` counts two.
TEST (InsomniaImport, AnExplicitInheritTypeInheritsAndIsNotCounted) {
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_folder ("fld", "wrk", "Folder", json{ { "type", "inherit" } }),
    insomnia_request ("a", "fld", "Inherits", json{ { "type", "inherit" } }) }),
    true, json{ { "type", "bearer" }, { "token", "outer" } });
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& folder = parsed.result.at ("collections")[0].at ("children")[0];
    EXPECT_EQ (folder.at ("auth").at ("mode"), "none");
    EXPECT_EQ (folder.at ("requests")[0].at ("auth").at ("mode"), "inherit");
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("unsupported_auth"));
}

/// A folder whose own auth Vayu cannot carry - a type with no mode, or a
/// cookie-placed API key - ends the walk (`noauth`), so a request inheriting
/// under it sends without auth instead of silently taking the workspace's.
/// The workspace stays `none`; a folder with no auth of its own still passes
/// the walk through. The resolved-auth pass sees the same thing: with a
/// data-only `iam` (stored as `aws`) workspace only the request under the plain folder is
/// counted. Mutation check: return `none` again from the folder branch of
/// `insomnia_collection_auth` and "Under asap" and "Under cookie" are counted.
TEST (InsomniaImport, AFolderWithAnUncarriableAuthEndsTheWalk) {
    const json cookie_key = { { "type", "apikey" }, { "addTo", "cookie" }, { "key", "sid" } };
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_folder ("asap", "wrk", "Asap", json{ { "type", "asap" } }),
    insomnia_request ("a", "asap", "Under asap"),
    insomnia_folder ("cookie", "wrk", "Cookie", cookie_key),
    insomnia_request ("b", "cookie", "Under cookie"), insomnia_folder ("plain", "wrk", "Plain"),
    insomnia_request ("c", "plain", "Under plain") }),
    true, json{ { "type", "iam" } });
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& collection = parsed.result.at ("collections")[0];
    EXPECT_EQ (collection.at ("children")[0].at ("auth").at ("mode"), "noauth");
    EXPECT_EQ (collection.at ("children")[1].at ("auth").at ("mode"), "noauth");
    EXPECT_EQ (collection.at ("children")[2].at ("auth").at ("mode"), "none");
    EXPECT_EQ (collection.at ("auth").at ("mode"), "aws");

    const json meta = json::parse (parsed.result.at ("meta").dump ());
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"), Names{ "Under plain" });
    EXPECT_EQ (skip_counts (meta.at ("skipped")).at ("unsupported_auth"), 1);
    EXPECT_EQ (skip_counts (meta.at ("skipped")).at ("security_unmapped_apikey_cookie"), 1);
}

/// The workspace has nothing above it to shut out, so an uncarriable auth of
/// its own stays `none`, counted. Mutation check: drop the `!workspace` guard
/// in `insomnia_collection_auth` and the workspace turns `noauth`.
TEST (InsomniaImport, AWorkspaceWithAnUncarriableAuthStaysNone) {
    for (const json& auth : { json{ { "type", "asap" } },
         json{ { "type", "apikey" }, { "addTo", "cookie" }, { "key", "sid" } } }) {
        const ImportParse parsed = parse_insomnia_tree (
        json::array ({ insomnia_request ("a", "wrk", "Top") }), true, auth);
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (parsed.result.at ("collections")[0].at ("auth").at ("mode"), "none")
        << auth.dump ();
    }
}

/// An API key placed in a cookie has no slot in Vayu's API-key mode, so it
/// becomes a `Cookie` header row with auth `none`, and the request is named. An
/// enabled `Cookie` row the request already sends takes it as a further cookie
/// (one header, "; " joined); a disabled one is left alone. Mutation checks:
/// drop the `api_key_in_cookie` branch of `insomnia_auth` and the first case
/// keeps a header-placed key; drop the `enabled` test in `with_cookie_api_key`
/// and the disabled row swallows the pair.
TEST (InsomniaImport, ACookiePlacedApiKeyBecomesACookieHeaderRow) {
    const json key = { { "type", "apikey" }, { "addTo", "cookie" },
        { "key", "sid" }, { "value", "{{ _.token }}" } };
    json plain     = insomnia_request ("a", "wrk", "Plain", key);
    json merged    = insomnia_request ("b", "wrk", "Merged", key);
    merged["headers"] =
    json::array ({ { { "name", "cookie" }, { "value", "theme=dark" } } });
    json disabled       = insomnia_request ("c", "wrk", "Disabled row", key);
    disabled["headers"] = json::array (
    { { { "name", "Cookie" }, { "value", "old=1" }, { "disabled", true } } });
    json header_key = insomnia_request ("d", "wrk", "Header key",
    json{ { "type", "apikey" }, { "addTo", "header" }, { "key", "X-Key" }, { "value", "v" } });
    const ImportParse parsed =
    parse_insomnia_tree (json::array ({ plain, merged, disabled, header_key }), true);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    for (const size_t at : { 0U, 1U, 2U }) {
        EXPECT_EQ (requests[at].at ("auth").at ("mode"), "none") << at;
    }
    EXPECT_EQ (requests[0].at ("headers"),
    (json::array (
    { { { "key", "Cookie" }, { "value", "sid={{token}}" }, { "enabled", true } } })));
    EXPECT_EQ (requests[1].at ("headers").size (), 1U);
    EXPECT_EQ (requests[1].at ("headers")[0].at ("value"), "theme=dark; sid={{token}}");
    EXPECT_EQ (requests[2].at ("headers").size (), 2U);
    EXPECT_EQ (requests[2].at ("headers")[0].at ("value"), "old=1");
    EXPECT_EQ (requests[2].at ("headers")[1].at ("value"), "sid={{token}}");
    EXPECT_EQ (requests[3].at ("auth").at ("mode"), "apikey");
    EXPECT_EQ (requests[3].at ("headers").size (), 0U);

    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("apikey_cookie_header"), 3);
    EXPECT_EQ (skipped_named (parsed, "apikey_cookie_header"),
    (Names{ "Plain", "Merged", "Disabled row" }));
}

/// A request's cookie-placed key with no name has no cookie to write, so it
/// adds no header row; it is counted under `security_unmapped_apikey_cookie`
/// and the request named, not dropped silently. A disabled one says nothing.
/// Mutation check: drop the count in `with_cookie_api_key`'s empty-name branch
/// and the preview hears nothing of "Unnamed" and "No key".
TEST (InsomniaImport, ACookieApiKeyWithNoNameIsCountedBecauseThereIsNothingToSend) {
    const json unnamed = { { "type", "apikey" }, { "addTo", "cookie" },
        { "key", "" }, { "value", "v" } };
    const json no_key = { { "type", "apikey" }, { "addTo", "cookie" }, { "value", "v" } };
    json off                 = unnamed;
    off["disabled"]          = true;
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_request ("a", "wrk", "Unnamed", unnamed),
    insomnia_request ("b", "wrk", "No key", no_key),
    insomnia_request ("c", "wrk", "Off", off) }),
    true);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    for (const size_t at : { 0U, 1U }) {
        EXPECT_EQ (requests[at].at ("auth").at ("mode"), "none") << at;
        EXPECT_EQ (requests[at].at ("headers").size (), 0U) << at;
    }
    const json& skipped = parsed.result.at ("meta").at ("skipped");
    EXPECT_EQ (skip_counts (skipped).at ("security_unmapped_apikey_cookie"), 2);
    EXPECT_FALSE (skip_counts (skipped).contains ("apikey_cookie_header"));
    EXPECT_EQ (skipped_named (parsed, "security_unmapped_apikey_cookie"),
    (Names{ "Unnamed", "No key" }));
}

/// A folder or workspace cannot carry a header row, so its cookie-placed key is
/// not imported: counted under `security_unmapped_apikey_cookie` (whose advice
/// is to add the Cookie header by hand), unnamed; the folder ends the walk
/// (`noauth`) and the workspace is `none`. A disabled one says nothing.
/// Mutation check: drop the `apikey_cookie_unmapped` count in
/// `insomnia_collection_auth` and the credential is lost with no notice.
TEST (InsomniaImport, AFolderCookieApiKeyIsCountedBecauseItCannotBeCarried) {
    const json key = { { "type", "apikey" }, { "addTo", "cookie" }, { "key", "sid" } };
    json off                 = key;
    off["disabled"]          = true;
    const ImportParse parsed = parse_insomnia_tree (
    json::array ({ insomnia_folder ("fld", "wrk", "Keyed", key),
    insomnia_request ("a", "fld", "Under"), insomnia_folder ("fld2", "wrk", "Off", off) }),
    true, key);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& collection = parsed.result.at ("collections")[0];
    EXPECT_EQ (collection.at ("auth").at ("mode"), "none");
    EXPECT_EQ (collection.at ("children")[0].at ("auth").at ("mode"), "noauth");
    EXPECT_EQ (collection.at ("children")[1].at ("auth").at ("mode"), "none");
    EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("security_unmapped_apikey_cookie"),
    2);
    EXPECT_TRUE (skipped_named (parsed, "security_unmapped_apikey_cookie").empty ());
}

/// An Insomnia export with @p resources under workspace "W", read with @p options.
ImportParse parse_insomnia_with (json resources, const ImportOptions& options) {
    json list =
    json::array ({ { { "_id", "wrk" }, { "_type", "workspace" }, { "name", "W" } } });
    for (json& resource : resources) {
        list.push_back (std::move (resource));
    }
    return parse_import (
    json{ { "_type", "export" }, { "__export_format", 4 }, { "resources", list } }
    .dump (),
    options, {});
}

/// A request or folder with the two script members set.
json with_scripts (json resource, const std::string& pre, const std::string& post = "") {
    resource["preRequestScript"]    = pre;
    resource["afterResponseScript"] = post;
    return resource;
}

/// The Insomnia scripting API is `insomnia.*`, which Vayu does not define, so
/// a script that calls it throws on first run. One notice kind names each
/// request and folder whose imported script does, once per owner whichever
/// script it is in; comments, strings and `pm.*` scripts name nothing, and the
/// Postman API notice stays out of it. With the scripts option off nothing is
/// imported, so nothing is named. Mutation checks: drop the `import_scripts`
/// gate around the count in `build_request` and the off case names "Pre"; make
/// `uses_insomnia_api` return false and the on case names nothing.
TEST (InsomniaImport, AScriptCallingTheInsomniaApiIsNamedOnlyWhenImported) {
    const auto resources = [] {
        return json::array ({ with_scripts (insomnia_folder ("fld", "wrk", "Folder"),
                              "insomnia.variables.set('a', 1);"),
        with_scripts (insomnia_request ("a", "fld", "Pre"),
        "const r = insomnia.request;\nr.addHeader('x', 'y');"),
        with_scripts (insomnia_request ("b", "fld", "Post"), "", "insomnia.test('ok', () => {});"),
        with_scripts (insomnia_request ("c", "fld", "Both"), "insomnia.x();", "insomnia.y();"),
        with_scripts (insomnia_request ("d", "fld", "Pm"), "pm.variables.set('a', 1);"),
        with_scripts (insomnia_request ("e", "fld", "Mentioned"), "// insomnia.x\nconsole.log('insomnia.y');"),
        with_scripts (insomnia_request ("f", "fld", "Own"), "const insomnia = {};\ninsomnia.x();"),
        with_scripts (insomnia_request ("g", "fld", "Blank"), "  \n") });
    };
    const ImportParse on = parse_insomnia_with (resources (), {});
    ASSERT_TRUE (on.ok ()) << on.error;
    EXPECT_EQ (skip_counts (on.result.at ("meta").at ("skipped")).at ("script_unsupported_insomnia"),
    4);
    EXPECT_EQ (skipped_named (on, "script_unsupported_insomnia"),
    (Names{ "Pre", "Post", "Both", "Folder" }));
    EXPECT_FALSE (on.result.at ("meta").contains ("unsupportedScriptApis"));

    ImportOptions off;
    off.import_scripts      = false;
    const ImportParse gated = parse_insomnia_with (resources (), off);
    ASSERT_TRUE (gated.ok ()) << gated.error;
    EXPECT_FALSE (
    skip_counts (gated.result.at ("meta").at ("skipped")).contains ("script_unsupported_insomnia"));
}

// The Insomnia counterpart of the above: an environment's `data` key is the
// variable name, and a nested object extends it with a dot.
TEST (InsomniaImport, TrimsAnEnvironmentVariableNameAndSkipsABlankOne) {
    const ImportParse parsed = parse_import (R"({"_type":"export","__export_format":4,"resources":[
        {"_id":"wrk","_type":"workspace","name":"W"},
        {"_id":"env","_type":"environment","parentId":"wrk","name":"Base",
            "data":{" host ":"a","  ":"skipped","":"skipped","nest":{"inner ":"b"}}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& variables =
    parsed.result.at ("environments")[0].at ("variables");
    EXPECT_EQ (variables.at ("host").at ("value"), "a");
    EXPECT_EQ (variables.at ("nest.inner").at ("value"), "b");
    EXPECT_EQ (variables.size (), 2U) << variables.dump ();
    for (auto member = variables.begin (); member != variables.end (); ++member) {
        EXPECT_TRUE (vayu::http::is_addressable_variable_name (member.key ()))
        << "'" << member.key () << "'";
    }
}

} // namespace
