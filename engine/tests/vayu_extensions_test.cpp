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

} // namespace
