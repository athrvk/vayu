/**
 * @file tests/vayu_extensions_test.cpp
 * @brief The `x-vayu-request` / `x-vayu-collection` helpers
 *        (`core/vayu_extensions.hpp`): what an export blanks, and what an
 *        import refuses to trust.
 *
 * The round trips themselves are pinned in `spec_export_route_test.cpp`; this
 * file holds the two rules a round trip cannot show, because a passing one
 * looks the same whether they hold or not: a secret never leaves, and a
 * hand-edited piece never reaches a write route malformed.
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/vayu_extensions.hpp"

namespace {

using Json    = vayu::core::vayu_ext::Json;
namespace ext = vayu::core::vayu_ext;

TEST (VayuExtensions, BlanksEveryCredentialAndKeepsWhatDescribesIt) {
    int omitted         = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"oauth2",
        "config":{"clientId":"cid","clientSecret":"shh","password":"pw",
                  "accessTokenUrl":"https://auth.example.com/t"}})"),
    omitted);
    EXPECT_EQ (redacted["config"]["clientId"], "cid");
    EXPECT_EQ (redacted["config"]["accessTokenUrl"], "https://auth.example.com/t");
    EXPECT_EQ (redacted["config"]["clientSecret"], "");
    EXPECT_EQ (redacted["config"]["password"], "");
    EXPECT_EQ (omitted, 2);

    const Json apikey = ext::redact_auth (
    Json::parse (R"({"mode":"apikey","key":"X-Key","value":"k","in":"header"})"), omitted);
    EXPECT_EQ (apikey["key"], "X-Key");
    EXPECT_EQ (apikey["value"], "");
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, BlanksTheCredentialsOfAPostmanImportsAuthSource) {
    int omitted = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"bearer","token":"t",
        "postman":{"type":"oauth2","oauth2":[{"key":"accessToken","value":"t"},
            {"key":"clientSecret","value":"{{secret}}"},{"key":"tokenType","value":"Bearer"}]}})"),
    omitted);
    EXPECT_EQ (redacted["token"], "");
    EXPECT_EQ (redacted["postman"]["oauth2"][0]["value"], "");
    EXPECT_EQ (redacted["postman"]["oauth2"][1]["value"], "{{secret}}");
    EXPECT_EQ (redacted["postman"]["oauth2"][2]["value"], "Bearer");
    EXPECT_EQ (omitted, 2);
}

TEST (VayuExtensions, KeepsAValueThatIsOnlyAVariableReference) {
    // `{{token}}` names where the secret lives; it is not the secret.
    int omitted         = 0;
    const Json redacted = ext::redact_auth (
    Json::parse (R"({"mode":"bearer","token":" {{token}} "})"), omitted);
    EXPECT_EQ (redacted["token"], " {{token}} ");
    EXPECT_EQ (omitted, 0);

    // A reference with text around it still carries a literal part.
    const Json mixed = ext::redact_auth (
    Json::parse (R"({"mode":"bearer","token":"x{{token}}"})"), omitted);
    EXPECT_EQ (mixed["token"], "");
    EXPECT_EQ (omitted, 1);
}

TEST (VayuExtensions, BlanksOnlyTheVariablesMarkedSecret) {
    int omitted         = 0;
    const Json redacted = ext::redact_variables (Json::parse (R"({
        "a":{"value":"plain","enabled":true},
        "b":{"value":"hidden","enabled":true,"secret":true},
        "c":{"value":"{{vault}}","enabled":true,"secret":true}})"),
    omitted);
    EXPECT_EQ (redacted["a"]["value"], "plain");
    EXPECT_EQ (redacted["b"]["value"], "");
    EXPECT_EQ (redacted["b"]["secret"], true);
    EXPECT_EQ (redacted["c"]["value"], "{{vault}}");
    EXPECT_EQ (omitted, 1);
}

TEST (VayuExtensions, NeverCarriesAFilePartsLocalPath) {
    const Json body = ext::portable_body (Json::parse (R"({"mode":"form-data","fields":[
        {"key":"f","value":"","enabled":true,"type":"file","src":"/home/me/a.png","unresolved":true}]})"));
    EXPECT_FALSE (body["fields"][0].contains ("src"));
    EXPECT_FALSE (body["fields"][0].contains ("unresolved"));
    EXPECT_EQ (body["fields"][0]["type"], "file");
}

/// A binary body's file travels by name and type: the path is one machine's,
/// and `unresolved` describes that path.
TEST (VayuExtensions, StripsTheLocalPathFromABinaryBodysFile) {
    const Json body = ext::portable_body (Json::parse (R"({"mode":"binary","file":{
        "src":"/home/me/a.png","fileName":"a.png","contentType":"image/png","unresolved":true}})"));
    EXPECT_EQ (body,
    Json::parse (R"({"mode":"binary","file":{"fileName":"a.png","contentType":"image/png"}})"));
}

/// Re-reading a binary body: a path it carries is nobody's choice here, so it
/// is marked unresolved whatever the document says; a `file` member that is
/// not an object, or one whose members are not strings, is refused.
TEST (VayuExtensions, ReadsABinaryBodyAndMarksACarriedPathUnresolved) {
    const auto carried = ext::body_of (Json::parse (
    R"({"mode":"binary","file":{"src":"/x/a.bin","unresolved":false}})"));
    ASSERT_HAS_VALUE (carried);
    EXPECT_EQ (*carried,
    Json::parse (R"({"mode":"binary","file":{"src":"/x/a.bin","unresolved":true}})"));
    const auto bare = ext::body_of (Json::parse (R"({"mode":"binary"})"));
    ASSERT_HAS_VALUE (bare);
    EXPECT_EQ (*bare, Json::parse (R"({"mode":"binary","file":{"src":""}})"));
    EXPECT_FALSE (ext::body_of (Json::parse (R"({"mode":"binary","file":"/x/a.bin"})")));
    EXPECT_FALSE (ext::body_of (Json::parse (R"({"mode":"binary","file":{"src":7}})")));
}

TEST (VayuExtensions, GivesEveryRowTheFieldsTheWriteRoutesRequire) {
    // `enabled` absent reads as enabled (D17) and `value` absent as "" -
    // exactly what `apply_key_value_field` then requires to be present.
    const auto rows = ext::rows_of (Json::parse (
    R"([{"key":"A"},{"key":"B","value":"1","enabled":false,"extra":1}])"));
    ASSERT_HAS_VALUE (rows);
    EXPECT_EQ ((*rows)[0], Json::parse (R"({"key":"A","value":"","enabled":true})"));
    EXPECT_EQ ((*rows)[1], Json::parse (R"({"key":"B","value":"1","enabled":false})"));
    EXPECT_FALSE (ext::rows_of (Json::parse (R"([{"value":"no key"}])")));
    EXPECT_FALSE (ext::rows_of (Json::parse (R"([{"key":"A","enabled":"yes"}])")));
}

// A Params row keeps `valueless: true`, which writes it as a bare `key` on
// the next table edit, and nothing that is not that boolean.
TEST (VayuExtensions, KeepsAValuelessQueryRow) {
    const auto rows = ext::param_rows_of (Json::parse (
    R"([{"key":"flag","valueless":true},{"key":"a","valueless":"yes"},{"key":"b","valueless":false}])"));
    ASSERT_HAS_VALUE (rows);
    EXPECT_EQ ((*rows)[0],
    Json::parse (R"({"key":"flag","value":"","enabled":true,"valueless":true})"));
    EXPECT_FALSE ((*rows)[1].contains ("valueless"));
    EXPECT_FALSE ((*rows)[2].contains ("valueless"));
}

TEST (VayuExtensions, RefusesWhatAWriteRouteWouldRefuse) {
    EXPECT_FALSE (ext::body_of (Json::parse (R"({"mode":"telepathy"})")));
    EXPECT_FALSE (ext::body_of (Json::parse (R"({"mode":"json","content":7})")));
    EXPECT_FALSE (ext::auth_of (Json::parse (R"({"mode":"inherit"})"), /*collection=*/true));
    EXPECT_TRUE (ext::auth_of (Json::parse (R"({"mode":"inherit"})"), /*collection=*/false));
    EXPECT_FALSE (ext::settings_of (Json::parse (R"({"httpVersion":"http9"})")));
    EXPECT_FALSE (ext::settings_of (Json::parse (R"({"verifySSL":"no"})")));
    EXPECT_FALSE (ext::examples_of (Json::parse (R"([{"name":"x","status":42}])")));
    EXPECT_FALSE (ext::data_schema_of (Json::parse (R"({"columns":["a","a"]})")));
    EXPECT_FALSE (ext::folder_path_of (Json::parse (R"(["a",""])")));
    EXPECT_FALSE (ext::variables_of (Json::parse (R"({"v":{"value":1}})")));
}

// --- A `config` bag is redacted by allowlist ---------------------------------

TEST (VayuExtensions, BlanksEveryUnlistedMemberOfAnInsomniaIamConfig) {
    // Insomnia names the AWS keys `accessKeyId` / `secretAccessKey`, which no
    // name list written for Postman's `accessKey` / `secretKey` knew.
    int omitted = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"aws","config":{
        "accessKeyId":"AKIAEXAMPLE","secretAccessKey":"wJalr","sessionToken":"FQoG",
        "region":"eu-west-1","service":"execute-api"}})"),
    omitted);
    EXPECT_EQ (redacted["config"]["accessKeyId"], "");
    EXPECT_EQ (redacted["config"]["secretAccessKey"], "");
    EXPECT_EQ (redacted["config"]["sessionToken"], "");
    EXPECT_EQ (redacted["config"]["region"], "eu-west-1");
    EXPECT_EQ (redacted["config"]["service"], "execute-api");
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, KeepsWhatDescribesEachDataOnlyModeAndBlanksTheRest) {
    int omitted = 0;
    const Json ntlm = ext::redact_auth (Json::parse (R"({"mode":"ntlm","config":{
        "username":"u","password":"p","domain":"CORP","workstation":"WS1"}})"),
    omitted);
    EXPECT_EQ (ntlm["config"]["username"], "u");
    EXPECT_EQ (ntlm["config"]["password"], "");
    EXPECT_EQ (ntlm["config"]["domain"], "CORP");
    EXPECT_EQ (ntlm["config"]["workstation"], "WS1");

    const Json jwt = ext::redact_auth (Json::parse (R"({"mode":"jwt","config":{
        "algorithm":"HS256","secret":"s","privateKey":"k","addTokenTo":"header",
        "isSecretBase64Encoded":false}})"),
    omitted);
    EXPECT_EQ (jwt["config"]["algorithm"], "HS256");
    EXPECT_EQ (jwt["config"]["secret"], "");
    EXPECT_EQ (jwt["config"]["privateKey"], "");
    EXPECT_EQ (jwt["config"]["addTokenTo"], "header");
    EXPECT_EQ (jwt["config"]["isSecretBase64Encoded"], false);
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, ABagMemberOfAnyShapeNobodyListedIsBlanked) {
    int omitted = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"hawk","config":{
        "authId":"id","brandNewCredential":"x","nested":{"deep":["y","{{vault}}"]},
        "count":3}})"),
    omitted);
    EXPECT_EQ (redacted["config"]["authId"], "id");
    EXPECT_EQ (redacted["config"]["brandNewCredential"], "");
    EXPECT_EQ (redacted["config"]["nested"]["deep"][0], "");
    EXPECT_EQ (redacted["config"]["nested"]["deep"][1], "{{vault}}");
    EXPECT_EQ (redacted["config"]["count"], 3);
    EXPECT_EQ (omitted, 2);

    const Json not_a_bag = ext::redact_auth (
    Json::parse (R"({"mode":"digest","config":"hunter2"})"), omitted);
    EXPECT_EQ (not_a_bag["config"], "");
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, TheAllowlistAlsoGovernsAConfigTypesPostmanSource) {
    int omitted = 0;
    Json source = Json::parse (R"({"type":"awsv4","awsv4":[
        {"key":"region","value":"us-east-1","type":"string"},
        {"key":"secretAccessKey","value":"s","type":"string"},
        {"key":"addAuthDataToQuery","value":false,"type":"boolean"}]})");
    ext::redact_postman_auth (source, omitted);
    EXPECT_EQ (source["awsv4"][0]["value"], "us-east-1");
    EXPECT_EQ (source["awsv4"][1]["value"], "");
    EXPECT_EQ (source["awsv4"][2]["value"], false);
    EXPECT_EQ (omitted, 1);

    // v2.0's detail object takes the same rule.
    Json detail = Json::parse (R"({"type":"hawk","hawk":{"authId":"id","authKey":"k"}})");
    ext::redact_postman_auth (detail, omitted);
    EXPECT_EQ (detail["hawk"]["authId"], "id");
    EXPECT_EQ (detail["hawk"]["authKey"], "");
    EXPECT_EQ (omitted, 2);
}

// --- Rows, URLs and the names an API-key auth claims -------------------------

TEST (VayuExtensions, BlanksTheValueOfASensitiveHeaderAndKeepsTheRow) {
    int omitted = 0;
    Json rows   = Json::parse (R"([
        {"key":"Authorization","value":"Bearer abc","enabled":true},
        {"key":"cookie","value":"sid=1","enabled":false},
        {"key":"X-Api-Key","value":"{{apiKey}}","enabled":true},
        {"key":"Proxy-Authorization","value":"","enabled":true},
        {"key":"Accept","value":"application/json","enabled":true}])");
    ext::blank_credential_rows (rows, {}, omitted);
    EXPECT_EQ (rows[0], Json::parse (R"({"key":"Authorization","value":"","enabled":true})"));
    EXPECT_EQ (rows[1]["value"], "");
    EXPECT_EQ (rows[1]["enabled"], false);
    EXPECT_EQ (rows[2]["value"], "{{apiKey}}");
    EXPECT_EQ (rows[4]["value"], "application/json");
    EXPECT_EQ (omitted, 2);
}

TEST (VayuExtensions, BlanksTheHeaderAnApiKeyAuthNames) {
    const Json auth = Json::parse (
    R"({"mode":"apikey","key":"X-Tenant-Token","value":"v","in":"header"})");
    const auto names = ext::apikey_header_names (auth);
    ASSERT_EQ (names.size (), 1U);
    EXPECT_EQ (names[0], "X-Tenant-Token");

    int omitted = 0;
    Json rows = Json::parse (R"([{"key":"x-tenant-token","value":"v","enabled":true}])");
    ext::blank_credential_rows (rows, {}, omitted);
    EXPECT_EQ (rows[0]["value"], "v");
    ext::blank_credential_rows (rows, names, omitted);
    EXPECT_EQ (rows[0]["value"], "");
    EXPECT_EQ (omitted, 1);
}

TEST (VayuExtensions, AnApiKeyAuthClaimsOnlyTheSideItIsPlacedOn) {
    const Json query =
    Json::parse (R"({"mode":"apikey","key":"k","value":"v","in":"query"})");
    EXPECT_TRUE (ext::apikey_header_names (query).empty ());
    ASSERT_EQ (ext::apikey_param_names (query).size (), 1U);
    EXPECT_EQ (ext::apikey_param_names (query)[0], "k");

    const Json header = Json::parse (R"({"mode":"apikey","key":"k","value":"v"})");
    EXPECT_EQ (ext::apikey_header_names (header).size (), 1U);
    EXPECT_TRUE (ext::apikey_param_names (header).empty ());

    EXPECT_TRUE (
    ext::apikey_header_names (Json::parse (R"({"mode":"bearer","key":"k"})")).empty ());
    EXPECT_TRUE (
    ext::apikey_header_names (Json::parse (R"({"mode":"apikey","key":""})")).empty ());
    EXPECT_TRUE (ext::apikey_header_names (Json::parse (R"("apikey")")).empty ());
}

TEST (VayuExtensions, ParamRowsUseANarrowerNameSetThanHeaders) {
    int omitted = 0;
    Json rows   = Json::parse (R"([
        {"key":"access_token","value":"t","enabled":true},
        {"key":"Signature","value":"s","enabled":true},
        {"key":"code","value":"US","enabled":true},
        {"key":"key","value":"cache-1","enabled":true},
        {"key":"page","value":"2","enabled":true},
        {"key":"password","value":"{{pw}}","enabled":true}])");
    ext::blank_credential_param_rows (rows, {}, omitted);
    EXPECT_EQ (rows[0]["value"], "");
    EXPECT_EQ (rows[1]["value"], "");
    EXPECT_EQ (rows[2]["value"], "US");
    EXPECT_EQ (rows[3]["value"], "cache-1");
    EXPECT_EQ (rows[4]["value"], "2");
    EXPECT_EQ (rows[5]["value"], "{{pw}}");
    EXPECT_EQ (omitted, 2);

    // The one place `key` is a credential: an API key auth names it.
    Json named = Json::parse (R"([{"key":"key","value":"AIza","enabled":true}])");
    ext::blank_credential_param_rows (named, { "key" }, omitted);
    EXPECT_EQ (named[0]["value"], "");
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, DropsAUrlsPasswordAndKeepsItsUserAndTheRest) {
    int omitted = 0;
    EXPECT_EQ (ext::redact_url_credentials (
               "https://bob:s3cret@api.example.com/v1/x?page=2", {}, omitted),
    "https://bob@api.example.com/v1/x?page=2");
    EXPECT_EQ (omitted, 1);

    // The userinfo ends at the last `@`, so a password holding one goes whole.
    EXPECT_EQ (ext::redact_url_credentials ("http://u:p@ss@h/p", {}, omitted), "http://u@h/p");
    EXPECT_EQ (omitted, 2);

    // A variable reference, a bare user and an `@` in the path are not secrets.
    EXPECT_EQ (ext::redact_url_credentials ("https://u:{{pw}}@h/p", {}, omitted),
    "https://u:{{pw}}@h/p");
    EXPECT_EQ (ext::redact_url_credentials ("https://u@h/p", {}, omitted), "https://u@h/p");
    EXPECT_EQ (ext::redact_url_credentials ("https://h/@me:x", {}, omitted), "https://h/@me:x");
    EXPECT_EQ (ext::redact_url_credentials ("{{baseUrl}}/users", {}, omitted),
    "{{baseUrl}}/users");
    EXPECT_EQ (omitted, 2);
}

TEST (VayuExtensions, BlanksASecretQueryValueAndKeepsTheOtherQueryData) {
    int omitted = 0;
    EXPECT_EQ (ext::redact_url_credentials (
               "{{baseUrl}}/p?api_key=S&code=US&page=2&flag&token={{t}}&sig=", {}, omitted),
    "{{baseUrl}}/p?api_key=&code=US&page=2&flag&token={{t}}&sig=");
    EXPECT_EQ (omitted, 1);

    // The implicit flow hands its token back in the fragment.
    EXPECT_EQ (
    ext::redact_url_credentials ("https://h/cb#access_token=T&state=abc", {}, omitted),
    "https://h/cb#access_token=&state=abc");
    EXPECT_EQ (ext::redact_url_credentials ("https://h/doc#section-2", {}, omitted),
    "https://h/doc#section-2");
    EXPECT_EQ (omitted, 2);

    EXPECT_EQ (ext::redact_url_credentials ("https://h/p?key=AIza&q=1", { "key" }, omitted),
    "https://h/p?key=&q=1");
    EXPECT_EQ (omitted, 3);
}

TEST (VayuExtensions, BlanksEveryCookieValueWhateverItsName) {
    Json cookies = Json::parse (R"([
        {"key":"sid","value":"abc","path":"/"},
        {"key":"theme","value":"dark"},
        {"key":"ref","value":"{{session}}"},
        {"key":"empty","value":""},
        {"key":"flag","value":true}])");
    int omitted  = 0;
    ext::blank_cookie_values (cookies, omitted);
    EXPECT_EQ (cookies[0].dump (), R"({"key":"sid","value":"","path":"/"})");
    EXPECT_EQ (cookies[1]["value"], "");
    EXPECT_EQ (cookies[2]["value"], "{{session}}");
    EXPECT_EQ (cookies[3]["value"], "");
    EXPECT_EQ (cookies[4]["value"], true);
    EXPECT_EQ (omitted, 2);

    Json not_a_list = Json::parse (R"({"key":"sid","value":"abc"})");
    ext::blank_cookie_values (not_a_list, omitted);
    EXPECT_EQ (not_a_list["value"], "abc");
    EXPECT_EQ (omitted, 2);
}

} // namespace
