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

// An OAuth 2.0 config's extra parameter rows (issue #2536) are redacted per
// row: what names and places a row survives, a credential's value does not,
// and a row or member nothing describes is blanked whole.
// Mutation-check: take the lists back out of `is_config_param_list` and every
// key is blanked; drop `names_param_credential` from the value test and the
// assertion and the header secret leave; admit an empty key as a key and the
// pasted value leaves.
TEST (VayuExtensions, BlanksTheCredentialRowsOfAnOAuth2ConfigsParamLists) {
    int omitted         = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"oauth2",
        "config":{"clientId":"cid",
          "tokenParams":[
            {"key":"audience","value":"https://api","enabled":true,"sendAs":"body"},
            {"key":"client_assertion","value":"eyJ.jwt","sendAs":"body"},
            {"key":"X-Api-Key","value":"k-1","sendAs":"header"},
            {"key":"org","value":"{{org}}","note":"internal"}],
          "authorizationParams":[{"key":"prompt","value":"login"},
            {"key":7,"value":"odd"},{"key":"","value":"pasted"}],
          "refreshParams":"refresh_token=rt"}})"),
    omitted);
    const Json& token   = redacted["config"]["tokenParams"];
    EXPECT_EQ (token[0],
    Json::parse (R"({"key":"audience","value":"https://api","enabled":true,"sendAs":"body"})"));
    EXPECT_EQ (token[1]["key"], "client_assertion");
    EXPECT_EQ (token[1]["value"], "");
    EXPECT_EQ (token[1]["sendAs"], "body");
    EXPECT_EQ (token[2]["key"], "X-Api-Key");
    EXPECT_EQ (token[2]["value"], "");
    EXPECT_EQ (token[3]["value"], "{{org}}");
    EXPECT_EQ (token[3]["note"], "");
    const Json& authorization = redacted["config"]["authorizationParams"];
    EXPECT_EQ (authorization[0]["value"], "login");
    EXPECT_EQ (authorization[1]["value"], "");
    EXPECT_EQ (authorization[2]["value"], "");
    EXPECT_EQ (redacted["config"]["refreshParams"], "");
    EXPECT_EQ (omitted, 6);
}

// The `jwt_bearer` grant (#3632) exports what describes it and withholds what
// is a credential or a path on one machine: the key is a `{{variable}}`
// reference (kept) or never stored, and the key file's path is not on the
// allowlist, so it is blanked and counted. The claims are a row list read like
// `tokenParams`, so a claim keeps its name and a credential-named one loses
// its value.
// Mutation-check: put `privateKeyFile` on `NON_SECRET_CONFIG_KEYS` and the
// path survives; take `assertionClaims` out of `is_config_param_list` and every
// claim is blanked; drop a member from the allowlist and its assertion fails.
TEST (VayuExtensions, KeepsWhatDescribesAJwtBearerGrantAndBlanksItsKeyFile) {
    int omitted         = 0;
    const Json redacted = ext::redact_auth (Json::parse (R"({"mode":"oauth2",
        "config":{"grantType":"jwt_bearer","clientId":"svc","subject":"ada@example.com",
          "assertionAudience":"https://idp.example.com","assertionLifetimeSeconds":300,
          "signingAlgorithm":"RS256","keyId":"key-1","fallbackExpiresIn":3600,
          "privateKey":"{{signingKey}}","privateKeyFile":"/etc/keys/svc.pem",
          "assertionClaims":[
            {"key":"tenant","value":"acme","enabled":true},
            {"key":"client_secret","value":"shh","enabled":false}]}})"),
    omitted);
    const Json& config  = redacted["config"];
    EXPECT_EQ (config["subject"], "ada@example.com");
    EXPECT_EQ (config["assertionAudience"], "https://idp.example.com");
    EXPECT_EQ (config["assertionLifetimeSeconds"], 300);
    EXPECT_EQ (config["signingAlgorithm"], "RS256");
    EXPECT_EQ (config["keyId"], "key-1");
    EXPECT_EQ (config["fallbackExpiresIn"], 3600);
    EXPECT_EQ (config["privateKey"], "{{signingKey}}");
    EXPECT_EQ (config["privateKeyFile"], "");
    EXPECT_EQ (config["assertionClaims"][0],
    Json::parse (R"({"key":"tenant","value":"acme","enabled":true})"));
    EXPECT_EQ (config["assertionClaims"][1],
    Json::parse (R"({"key":"client_secret","value":"","enabled":false})"));
    // The key file's path and the one credential-named claim, nothing else.
    EXPECT_EQ (omitted, 2);
}

// A pasted PEM is never kept: only a whole `{{variable}}` is a reference. The
// routes refuse one on write (`reject_literal_private_key`), so this is the
// export's own line for a document that did not come through them.
// Mutation-check: put `privateKey` on `NON_SECRET_CONFIG_KEYS` and it survives.
TEST (VayuExtensions, NeverKeepsABarePrivateKeyAndKeepsAReferenceToOne) {
    int omitted                  = 0;
    const auto private_key_after = [&omitted] (const char* key) {
        Json auth = Json{ { "mode", "oauth2" },
            { "config", { { "grantType", "jwt_bearer" }, { "privateKey", key } } } };
        return ext::redact_auth (auth, omitted)["config"]["privateKey"];
    };
    EXPECT_EQ (private_key_after (
               "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"),
    "");
    EXPECT_EQ (omitted, 1);
    EXPECT_EQ (private_key_after ("{{signingKey}}"), "{{signingKey}}");
    EXPECT_EQ (private_key_after (" {{ signingKey }} "), " {{ signingKey }} ");
    EXPECT_EQ (omitted, 1);
    // A reference with text around it carries a literal part.
    EXPECT_EQ (private_key_after ("{{head}}-----BEGIN"), "");
    EXPECT_EQ (omitted, 2);
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
        {"key":"f","value":"","enabled":true,"type":"file","src":"/home/me/a.png"}]})"));
    EXPECT_FALSE (body["fields"][0].contains ("src"));
    EXPECT_EQ (body["fields"][0]["type"], "file");
}

/// A binary body's file travels by name and type: the path is one machine's.
TEST (VayuExtensions, StripsTheLocalPathFromABinaryBodysFile) {
    const Json body = ext::portable_body (Json::parse (R"({"mode":"binary","file":{
        "src":"/home/me/a.png","fileName":"a.png","contentType":"image/png"}})"));
    EXPECT_EQ (body,
    Json::parse (R"({"mode":"binary","file":{"fileName":"a.png","contentType":"image/png"}})"));
}

/// Re-reading a binary body: a path it carries is kept and what the document
/// says about its trust is dropped (#2356); a `file` member that is not an
/// object, or one whose members are not strings, is refused.
TEST (VayuExtensions, ReadsABinaryBodyAndDropsWhatItSaysAboutTrust) {
    const auto carried = ext::body_of (Json::parse (
    R"({"mode":"binary","file":{"src":"/x/a.bin","unresolved":false}})"));
    ASSERT_HAS_VALUE (carried);
    EXPECT_EQ (*carried, Json::parse (R"({"mode":"binary","file":{"src":"/x/a.bin"}})"));
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
    // A `timeout` `POST /import/apply` would refuse is this piece's to drop
    // (#2937), so the import is never refused over it.
    for (const char* bad : { R"({"timeout":0})", R"({"timeout":86400001})",
         R"({"timeout":"2500"})", R"({"timeout":null})" }) {
        EXPECT_FALSE (ext::settings_of (Json::parse (bad))) << bad;
    }
    const auto timed = ext::settings_of (Json::parse (R"({"timeout":2500})"));
    ASSERT_HAS_VALUE (timed);
    EXPECT_EQ ((*timed)["timeout"], 2500);
    // An interim status is refused at create (#3117), so the reader drops the
    // piece instead of handing the applier a row it would reject.
    for (const char* bad : { R"([{"name":"x","status":42}])",
         R"([{"name":"x","status":100}])", R"([{"name":"x","status":199}])" }) {
        EXPECT_FALSE (ext::examples_of (Json::parse (bad))) << bad;
    }
    EXPECT_TRUE (ext::examples_of (Json::parse (R"([{"name":"x","status":200}])")));
    EXPECT_FALSE (ext::data_schema_of (Json::parse (R"({"columns":["a","a"]})")));
    EXPECT_FALSE (ext::folder_path_of (Json::parse (R"(["a",""])")));
    EXPECT_FALSE (ext::variables_of (Json::parse (R"({"v":{"value":1}})")));
    // A name the write routes refuse (#3251) is this piece's to drop, so the
    // import falls back to the standard reading instead of failing the apply.
    for (const char* bad : { R"({" v":{"value":"1"}})", R"({"v ":{"value":"1"}})",
         R"({"":{"value":"1"}})", R"({"  ":{"value":"1"}})" }) {
        EXPECT_FALSE (ext::variables_of (Json::parse (bad))) << bad;
    }
    EXPECT_TRUE (ext::variables_of (Json::parse (R"({"my v":{"value":"1"}})")));
}

// --- A saved example's `origin` (#2430) --------------------------------------

TEST (VayuExtensions, KeepsAnExamplesOriginWhenItNamesOneOfTheTwoWriters) {
    const auto examples = ext::examples_of (Json::parse (R"([
        {"name":"mine","status":200,"origin":"user"},
        {"name":"spec","status":404,"origin":"import"}])"));
    ASSERT_HAS_VALUE (examples);
    ASSERT_EQ (examples->size (), 2U);
    EXPECT_EQ ((*examples)[0]["origin"], "user");
    EXPECT_EQ ((*examples)[1]["origin"], "import");
}

// An older Vayu wrote no `origin`; the apply route reads that as `import`, so
// the reader must not invent a value of its own.
TEST (VayuExtensions, LeavesAnExampleWithNoOriginWithoutOne) {
    const auto examples =
    ext::examples_of (Json::parse (R"([{"name":"x","status":200}])"));
    ASSERT_HAS_VALUE (examples);
    EXPECT_FALSE ((*examples)[0].contains ("origin"));
}

TEST (VayuExtensions, RefusesAnExampleWhoseOriginIsNotOneOfTheTwoWriters) {
    for (const char* origin :
    { R"("other")", R"("")", R"("User")", "1", "true", "null", "[]" }) {
        const std::string document =
        std::string (R"([{"name":"x","status":200,"origin":)") + origin + "}]";
        EXPECT_FALSE (ext::examples_of (Json::parse (document))) << document;
    }
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

// A record says what was sent, so a withheld URL value reads `<redacted>` where
// an export leaves a blank (#3672). Every guard the blank form has still holds,
// and the count is the same. Mutation check: ignore `mark` in
// `redact_query_pair` and the query cases read blank.
TEST (VayuExtensions, TheMarkerFormWritesRedactedWhereTheBlankFormEmpties) {
    constexpr auto marker = ext::CredentialMark::Marker;
    int omitted           = 0;
    EXPECT_EQ (ext::redact_url_credentials (
               "https://h/p?client_secret=S&page=2", {}, omitted, marker),
    "https://h/p?client_secret=<redacted>&page=2");
    EXPECT_EQ (omitted, 1);

    EXPECT_EQ (ext::redact_url_credentials (
               "https://h/cb#access_token=T&state=abc", {}, omitted, marker),
    "https://h/cb#access_token=<redacted>&state=abc");
    EXPECT_EQ (ext::redact_url_credentials (
               "https://h/p?key=AIza&q=1", { "key" }, omitted, marker),
    "https://h/p?key=<redacted>&q=1");
    EXPECT_EQ (omitted, 3);

    // Mutation check: drop the marker from `drop_userinfo_password` and the
    // password reads as no password at all.
    EXPECT_EQ (ext::redact_url_credentials ("https://bob:s3cret@h/x?page=2", {}, omitted, marker),
    "https://bob:<redacted>@h/x?page=2");
    EXPECT_EQ (ext::redact_url_credentials ("http://u:p@ss@h/p", {}, omitted, marker),
    "http://u:<redacted>@h/p");
    EXPECT_EQ (omitted, 5);

    // Nothing was withheld, so nothing is marked: an empty value, a lone
    // variable reference, a bare name, a bare user and a non-secret name stay.
    const std::string kept =
    "https://u@h/p?sig=&token={{t}}&flag&code=US&page=2#section-2";
    EXPECT_EQ (ext::redact_url_credentials (kept, {}, omitted, marker), kept);
    EXPECT_EQ (ext::redact_url_credentials ("https://u:{{pw}}@h/p", {}, omitted, marker),
    "https://u:{{pw}}@h/p");
    EXPECT_EQ (omitted, 5);

    // The split count is the blank form's.
    ext::UrlOmitted split;
    EXPECT_EQ (ext::redact_url_credentials (
               "https://bob:s3cret@h/x?api_key=S&token=T", {}, split, marker),
    "https://bob:<redacted>@h/x?api_key=<redacted>&token=<redacted>");
    EXPECT_EQ (split.password, 1);
    EXPECT_EQ (split.query, 2);
}

// An export keeps blanking when it names no mark.
TEST (VayuExtensions, TheDefaultFormStillBlanksForAnExport) {
    int omitted = 0;
    EXPECT_EQ (ext::redact_url_credentials (
               "https://bob:s3cret@h/x?client_secret=S&page=2", {}, omitted),
    "https://bob@h/x?client_secret=&page=2");
    EXPECT_EQ (omitted, 2);
}

// The record masks a URL to the marker, in the request and in a redirect hop.
// A real hop arrives already redacted by the client (`record_hop`), marked as
// `pm.sendRequest` asks, and keeps that form here; a blank it arrives with
// cannot be told from a value sent empty, which is why the client marks it
// (`SendRequestTest.ARecordedHopUrlReadsRedactedLikeTheRequestUrl` drives a
// real redirect). An unredacted hop is still masked. Mutation check: drop
// `CredentialMark::Marker` from `mask_record_node`.
TEST (VayuExtensions, ARecordsUrlsReadRedactedWhereTheyWereWithheld) {
    nlohmann::json record = nlohmann::json::parse (R"({
        "request": {"url": "https://h/token?client_secret=S&page=2"},
        "response": {"redirects": [
            {"url": "https://bob:hunter2@h/hop?api_key=K"},
            {"url": "https://bob:<redacted>@h/hop?api_key=<redacted>"},
            {"url": "https://bob@h/hop?api_key="}]}})");
    ext::mask_script_request_record (record, {}, "");
    EXPECT_EQ (record["request"]["url"], "https://h/token?client_secret=<redacted>&page=2");
    const auto& hops = record["response"]["redirects"];
    EXPECT_EQ (hops[0]["url"], "https://bob:<redacted>@h/hop?api_key=<redacted>");
    EXPECT_EQ (hops[1]["url"], "https://bob:<redacted>@h/hop?api_key=<redacted>");
    EXPECT_EQ (hops[2]["url"], "https://bob@h/hop?api_key=");

    nlohmann::json claimed =
    nlohmann::json::parse (R"({"request": {"url": "https://h/p?sig=S&q=1"}})");
    ext::mask_script_request_record (claimed, {}, "sig");
    EXPECT_EQ (claimed["request"]["url"], "https://h/p?sig=<redacted>&q=1");
}

// The three challenge headers name a scheme, not a credential, so a record
// shows them in every header set; the credentials beside them stay masked.
// Mutation check: take `is_challenge_header` out of `masks_in_record`.
TEST (VayuExtensions, ARecordKeepsTheChallengeHeadersAndMasksTheCredentials) {
    nlohmann::json record = nlohmann::json::parse (R"({
        "request": {
            "headers": {"Authorization": "Bearer A", "Proxy-Authenticate": "Basic realm=p"},
            "sentHeaders": {"authorization": "Bearer A", "AUTHENTICATION-INFO": "nextnonce=n"},
            "headerLines": [
                {"name": "Authorization", "value": "Bearer A"},
                {"name": "www-authenticate", "value": "Bearer realm=\"api\""}]},
        "response": {
            "headers": {"WWW-Authenticate": "Bearer realm=\"api\"",
                        "Set-Cookie": "sid=1", "Proxy-Authorization": "Basic x"},
            "redirects": [{"url": "https://h/hop", "headers": {
                "Proxy-Authenticate": "Basic realm=p", "Cookie": "sid=1"}}]}})");
    ext::mask_script_request_record (record, {}, "");

    const auto& request  = record["request"];
    const auto& response = record["response"];
    EXPECT_EQ (request["headers"]["Authorization"], "<redacted>");
    EXPECT_EQ (request["headers"]["Proxy-Authenticate"], "Basic realm=p");
    EXPECT_EQ (request["sentHeaders"]["authorization"], "<redacted>");
    EXPECT_EQ (request["sentHeaders"]["AUTHENTICATION-INFO"], "nextnonce=n");
    EXPECT_EQ (request["headerLines"][0]["value"], "<redacted>");
    EXPECT_EQ (request["headerLines"][1]["value"], "Bearer realm=\"api\"");
    EXPECT_EQ (response["headers"]["WWW-Authenticate"], "Bearer realm=\"api\"");
    EXPECT_EQ (response["headers"]["Set-Cookie"], "<redacted>");
    EXPECT_EQ (response["headers"]["Proxy-Authorization"], "<redacted>");
    EXPECT_EQ (response["redirects"][0]["headers"]["Proxy-Authenticate"], "Basic realm=p");
    EXPECT_EQ (response["redirects"][0]["headers"]["Cookie"], "<redacted>");
}

// A header the call's own auth wrote stays masked even under a challenge name:
// the exemption is for what a server sends, not for a key a caller chose.
TEST (VayuExtensions, ARecordStillMasksAChallengeNamedHeaderTheCallsAuthWrote) {
    nlohmann::json record = nlohmann::json::parse (
    R"({"request": {"sentHeaders": {"WWW-Authenticate": "KEY"}}})");
    ext::mask_script_request_record (record, { "www-authenticate" }, "");
    EXPECT_EQ (record["request"]["sentHeaders"]["WWW-Authenticate"], "<redacted>");
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

    // A stored Postman cookie names itself `name`, not `key`.
    Json postman_named = Json::parse (R"([{"name":"sid","value":"abc","domain":"x"}])");
    ext::blank_cookie_values (postman_named, omitted);
    EXPECT_EQ (postman_named[0]["value"], "");
    EXPECT_EQ (omitted, 3);

    Json not_a_list = Json::parse (R"({"key":"sid","value":"abc"})");
    ext::blank_cookie_values (not_a_list, omitted);
    EXPECT_EQ (not_a_list["value"], "abc");
    EXPECT_EQ (omitted, 3);
}

} // namespace
