/**
 * @file tests/postman_export_route_test.cpp
 * @brief `POST /export/postman`, and the round trip through the importer.
 *
 * `fixtures/postman-export-roundtrip.json` is written in Postman's own export
 * shape and exercises every field the importer reads; importing it and
 * exporting the collection gives back the same bytes, `_postman_id` aside.
 * The Postman documents of the import corpus (`fixtures/import-conformance.json`,
 * byte-identical to the renderer's old fixtures) come back equal after the
 * normalisation `normalise` documents, and for every one of them import ->
 * export -> import is a fixed point. The exporter's own shapes are pinned in
 * `postman_export_test.cpp`; follows the suite's route-test convention (the
 * extracted core called directly, no in-process HTTP server).
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Defined in postman_export.cpp and import.cpp; each returns
// {http_status, json_body}.
std::pair<int, nlohmann::json>
export_postman_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
import_response (vayu::db::Database& db, const nlohmann::json& body);
// Defined in requests.cpp and collections.cpp.
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// Defined in examples.cpp.
std::pair<int, nlohmann::json> update_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> create_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const nlohmann::json& json);
// Defined in collections.cpp and requests.cpp.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using ordered = nlohmann::ordered_json;
using nlohmann::json;

std::filesystem::path fixture_path (const char* name) {
    return std::filesystem::path (__FILE__).parent_path () / "fixtures" / name;
}

std::string read_text (const std::filesystem::path& path) {
    std::ifstream file (path, std::ios::binary);
    EXPECT_TRUE (file.is_open ()) << "missing fixture: " << path;
    std::ostringstream text;
    text << file.rdbuf ();
    return text.str ();
}

class PostmanExportRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_postman_export_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// @p text through `POST /import`, answering the new root's id.
    std::string import_text (const std::string& text) {
        auto [status, imported] =
        vayu::http::routes::import_response (*db_, json{ { "content", text } });
        EXPECT_EQ (status, 200) << imported.dump ();
        return imported["idMap"].value ("c1", std::string{});
    }

    json export_ok (const std::string& id, bool secrets = true) {
        auto [status, body] = vayu::http::routes::export_postman_response (
        *db_, json{ { "collectionId", id }, { "includeSecrets", secrets } });
        EXPECT_EQ (status, 200) << body.dump ();
        return body;
    }

    std::string export_text (const std::string& id) {
        return export_ok (id).value ("text", std::string{});
    }

    std::unique_ptr<vayu::db::Database> db_;
};

/// @p text with its `_postman_id` value replaced by a fixed one.
std::string without_postman_id (std::string text) {
    const std::string marker = "\"_postman_id\": \"";
    const size_t at          = text.find (marker);
    if (at == std::string::npos) {
        ADD_FAILURE () << "no _postman_id";
        return text;
    }
    text.replace (at + marker.size (), 36, "00000000-0000-4000-8000-000000000000");
    return text;
}

TEST_F (PostmanExportRouteTest, RefusesABadBody) {
    using vayu::http::routes::export_postman_response;
    for (const json& body : { json::array (), json{ { "collectionId", 5 } },
         json{ { "collectionId", "" } }, json::object (),
         json{ { "collectionId", "c" }, { "includeSecrets", "yes" } } }) {
        auto [status, response] = export_postman_response (*db_, body);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_TRUE (response["error"]["message"].is_string ()) << response.dump ();
    }
    auto [status, response] =
    export_postman_response (*db_, json{ { "collectionId", "col_nope" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (response["error"]["message"], "Collection not found");
}

TEST_F (PostmanExportRouteTest, TheRoundTripFixtureComesBackByteForByte) {
    // Written in Postman's own export shape: every field the importer reads,
    // in the order Postman writes it. Only the id is minted anew.
    const std::string fixture =
    read_text (fixture_path ("postman-export-roundtrip.json"));
    ASSERT_FALSE (fixture.empty ());
    const std::string id = import_text (fixture);
    json body            = export_ok (id);
    EXPECT_EQ (without_postman_id (body["text"].get<std::string> ()), fixture);
    EXPECT_EQ (body["fileName"], "Round Trip.postman_collection.json");
    EXPECT_EQ (body["notes"]["requestsExported"], 27);
    EXPECT_EQ (body["notes"]["foldersExported"], 4);
    EXPECT_EQ (body["notes"]["notCarried"], json::array ());
    EXPECT_EQ (body["notes"]["secretsOmitted"], 0);
}

/// The exported `protocolProfileBehavior` of the root item named @p name, as
/// the text it was written as (member order is the point).
std::string exported_protocol_behavior (const std::string& text, const std::string& name) {
    const ordered doc = ordered::parse (text);
    for (const ordered& item : doc.at ("item")) {
        if (item.value ("name", "") == name) {
            return item.contains ("protocolProfileBehavior") ?
            item.at ("protocolProfileBehavior").dump () :
            std::string ();
        }
    }
    ADD_FAILURE () << "no exported item " << name;
    return {};
}

// Issue #1765: an edit since the import is written over the carried
// `protocolProfileBehavior` in place, a key the carrier did not have is
// appended, and what Vayu does not apply stays. Mutation check: make
// `protocol_profile` return the carrier unconditionally and this reds.
TEST_F (PostmanExportRouteTest, AnEditedProtocolSettingIsWrittenOverTheImportedObject) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    std::string request_id;
    for (const auto& row : db_->get_requests_in_collection (id)) {
        if (row.name == "Raw and cookieless") {
            request_id = row.id;
        }
    }
    ASSERT_FALSE (request_id.empty ());
    auto [status, updated] = vayu::http::routes::update_request_response (*db_, request_id,
    json{ { "disableCookies", false }, { "followRedirects", false },
    { "disabledSystemHeaders", json::array ({ "user-agent", "postman-token", "accept" }) } });
    ASSERT_EQ (status, 200) << updated.dump ();

    EXPECT_EQ (exported_protocol_behavior (export_text (id), "Raw and cookieless"),
    R"({"disableUrlEncoding":true,"disableCookies":false,"disabledSystemHeaders":{"user-agent":true,"postman-token":true,"accept":true},"tlsDisabledProtocols":["TLSv1"],"followRedirects":false})");
}

/// A one-folder Postman v2.1 collection of the items in @p items.
std::string postman_collection (const std::string& items) {
    return R"({"info":{"name":"Protocol","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[)" +
    items + "]}";
}

/// The stored request named @p name under @p root.
std::optional<vayu::db::Request>
request_named (vayu::db::Database& db, const std::string& root, const std::string& name) {
    for (const auto& row : db.get_requests_in_collection (root)) {
        if (row.name == name) {
            return row;
        }
    }
    ADD_FAILURE () << "no request " << name;
    return std::nullopt;
}

// Issue #1765: a body given in Vayu to an imported GET needs
// `disableBodyPruning`, or Postman strips the body Vayu sends; the carrier
// only had it when the source did. Appended when absent, set in place when
// `false`, and an untouched bodyless import stays byte-identical. Mutation
// check: drop the `prunable_body` block from `reconciled_profile` and the two
// edited expectations red.
TEST_F (PostmanExportRouteTest, ABodyAddedToAnImportedGetIsKeptFromPruning) {
    const std::string id        = import_text (postman_collection (R"(
        {"name":"Absent","protocolProfileBehavior":{"disabledSystemHeaders":{}},
            "request":{"method":"GET","url":"https://x.com/a"}},
        {"name":"Off","protocolProfileBehavior":{"disableBodyPruning":false,"strictSSL":true},
            "request":{"method":"GET","url":"https://x.com/b"}})"));
    const std::string untouched = export_text (id);
    EXPECT_EQ (exported_protocol_behavior (untouched, "Absent"),
    R"({"disabledSystemHeaders":{}})");
    EXPECT_EQ (exported_protocol_behavior (untouched, "Off"),
    R"({"disableBodyPruning":false,"strictSSL":true})");

    const json body{ { "body", { { "mode", "json" }, { "content", R"({"a":1})" } } } };
    for (const char* name : { "Absent", "Off" }) {
        const auto row = request_named (*db_, id, name);
        ASSERT_HAS_VALUE (row);
        auto [status, updated] =
        vayu::http::routes::update_request_response (*db_, row->id, body);
        ASSERT_EQ (status, 200) << updated.dump ();
    }
    const std::string edited = export_text (id);
    EXPECT_EQ (exported_protocol_behavior (edited, "Absent"),
    R"({"disabledSystemHeaders":{},"disableBodyPruning":true})");
    EXPECT_EQ (exported_protocol_behavior (edited, "Off"),
    R"({"disableBodyPruning":true,"strictSSL":true})");
}

// A `disabledSystemHeaders` key that is no header name is dropped from what
// the request applies instead of failing the whole import, and a truthy
// non-boolean counts as Postman's runtime counts it; the carrier keeps the
// object verbatim for the export. Mutation check: drop the
// `invalid_header_token` filter in `postman_disabled_system_headers` and the
// import answers 400.
TEST_F (PostmanExportRouteTest, AMalformedDisabledHeaderNameDoesNotFailTheImport) {
    const std::string carried =
    R"({"disabledSystemHeaders":{"accept":true,"bad name":true,"User-Agent":1,"connection":0}})";
    const std::string id =
    import_text (postman_collection (R"({"name":"Odd","protocolProfileBehavior":)" +
    carried + R"(,"request":{"method":"GET","url":"https://x.com"}})"));
    ASSERT_FALSE (id.empty ());
    const auto row = request_named (*db_, id, "Odd");
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->disabled_system_headers, R"(["accept","user-agent"])");
    EXPECT_EQ (exported_protocol_behavior (export_text (id), "Odd"), carried);
}

// The app's Duplicate sends back the record `GET /requests/:id` answered, the
// carrier included: a duplicated import exports the same
// `protocolProfileBehavior` bytes as its source. Mutation check: answer the
// carrier as a parsed object from `postman_protocol_behavior_node` and the
// copy's members come out sorted.
TEST_F (PostmanExportRouteTest, ADuplicatedImportExportsTheSameProtocolBehavior) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    const auto source = request_named (*db_, id, "Raw and cookieless");
    ASSERT_HAS_VALUE (source);
    auto [status, record] =
    vayu::http::routes::get_request_response (*db_, source->id);
    ASSERT_EQ (status, 200) << record.dump ();
    for (const char* key : { "id", "createdAt", "updatedAt" }) {
        record.erase (key);
    }
    record["name"] = "Raw and cookieless (Copy)";
    auto [copy_status, copy] = vayu::http::routes::create_request_response (*db_, record);
    ASSERT_EQ (copy_status, 200) << copy.dump ();

    const std::string text = export_text (id);
    const std::string original = exported_protocol_behavior (text, "Raw and cookieless");
    ASSERT_FALSE (original.empty ());
    EXPECT_EQ (exported_protocol_behavior (text, "Raw and cookieless (Copy)"), original);
}

TEST_F (PostmanExportRouteTest, WithoutSecretsEveryCredentialIsBlankedAndCounted) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    json body = export_ok (id, /*secrets=*/false);
    // The secret variable, the Admin folder's basic password, and the digest,
    // API-key, OAuth 2.0 client secret, AWS key pair and NTLM credentials,
    // and the bearer token a saved response's recorded request carries, twice
    // (its `auth` and the `Authorization` header Postman writes beside it),
    // and the value of that response's `sid` cookie; the two `{{variable}}`
    // references (bearer, the GraphQL API key) stay.
    EXPECT_EQ (body["notes"]["secretsOmitted"], 11);
    const std::string text = body["text"].get<std::string> ();
    for (const char* secret : { "s3cr3t", "hunter2", "\"pw\"", "k-123",
         "\"shh\"", "SECRET", "AKIA", "tok-live", "\"value\": \"abc\"" }) {
        EXPECT_EQ (text.find (secret), std::string::npos) << secret;
    }
    EXPECT_NE (text.find ("{{token}}"), std::string::npos);
    EXPECT_NE (text.find ("{{apiKey}}"), std::string::npos);
}

// The case #1804 names, end to end from an Insomnia v4 file: a typed
// `Authorization` header, a secret in a query parameter and an IAM auth whose
// `secretAccessKey` the importer keeps in the auth's `config` under a name no
// list holds. None of the three leaves, and each is counted once.
// Mutation check: take `authorization` out of `is_secret_field_name` and this
// reds on the header; put `secretAccessKey` back on a name list instead of the
// allowlist and the IAM assertion reds only if the list lacks it.
TEST_F (PostmanExportRouteTest, AnInsomniaRequestsHeaderQueryAndIamKeyDoNotLeaveWithoutSecrets) {
    const std::string insomnia = R"({
        "_type": "export", "__export_format": 4,
        "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Signed"},
            {"_id": "req_1", "_type": "request", "parentId": "wrk_1", "name": "List",
             "method": "GET", "url": "https://api.test/pets",
             "parameters": [{"name": "api_key", "value": "QUERY-SECRET"},
                            {"name": "page", "value": "2"}],
             "headers": [{"name": "Authorization", "value": "Bearer HEADER-SECRET"},
                         {"name": "Accept", "value": "application/json"}],
             "authentication": {"type": "iam", "accessKeyId": "",
                                "secretAccessKey": "IAM-SECRET",
                                "region": "us-east-1", "service": "s3"}}
        ]})";
    const std::string id       = import_text (insomnia);
    ASSERT_FALSE (id.empty ());

    const json blanked     = export_ok (id, /*secrets=*/false);
    const std::string text = blanked["text"].get<std::string> ();
    for (const char* secret : { "HEADER-SECRET", "QUERY-SECRET", "IAM-SECRET" }) {
        EXPECT_EQ (text.find (secret), std::string::npos) << secret;
    }
    EXPECT_EQ (blanked["notes"]["secretsOmitted"], 3);
    EXPECT_NE (text.find ("us-east-1"), std::string::npos)
    << "what describes the auth stays";
    EXPECT_NE (text.find ("page=2"), std::string::npos)
    << "other query data stays";

    const std::string kept = export_text (id);
    for (const char* secret : { "HEADER-SECRET", "QUERY-SECRET", "IAM-SECRET" }) {
        EXPECT_NE (kept.find (secret), std::string::npos) << secret;
    }
}

/// The stored examples of the fixture's request named @p name.
std::vector<vayu::db::RequestExample>
examples_named (vayu::db::Database& db, const std::string& root, const std::string& name) {
    for (const auto& row : db.get_requests_in_collection (root)) {
        if (row.name == name) {
            return db.get_request_examples (row.id);
        }
    }
    ADD_FAILURE () << "no request " << name;
    return {};
}

/// The exported `response[]` of the root request named @p name.
ordered exported_responses (const std::string& text, const std::string& name) {
    const ordered doc = ordered::parse (text);
    for (const ordered& item : doc.at ("item")) {
        if (item.value ("name", "") == name) {
            return item.at ("response");
        }
    }
    ADD_FAILURE () << "no exported item " << name;
    return ordered::array ();
}

// The edit rule, end to end: an example edited through the route keeps its
// recorded request verbatim, and every member describing the edited column
// is regenerated rather than contradicting it. Mutation check: make
// `stored_response` keep the stored `status` / `header` unconditionally and
// the two regeneration assertions red.
TEST_F (PostmanExportRouteTest, AnEditedImportedExampleExportsItsEditNotTheStaleCopy) {
    const std::string fixture =
    read_text (fixture_path ("postman-export-roundtrip.json"));
    const std::string id = import_text (fixture);
    const auto examples  = examples_named (*db_, id, "Look up tweets");
    ASSERT_EQ (examples.size (), 2u);
    const ordered before = exported_responses (export_text (id), "Look up tweets");

    auto [status, edited] = vayu::http::routes::update_request_example_response (*db_,
    examples[0].request_id, examples[0].id,
    json{ { "status", 201 },
    { "headers",
    json::array ({ json{ { "key", "Content-Type" },
    { "value", "application/json" }, { "enabled", true } } }) } });
    ASSERT_EQ (status, 200) << edited.dump ();

    const ordered after = exported_responses (export_text (id), "Look up tweets");
    ordered response = after.at (0);
    EXPECT_EQ (response["originalRequest"], before[0]["originalRequest"])
    << "the recorded request is not the edited part and stays as recorded";
    EXPECT_EQ (response["code"], 201);
    EXPECT_EQ (response["status"], "Created");
    EXPECT_EQ (response["header"].dump (),
    R"([{"key":"Content-Type","value":"application/json"}])");
    EXPECT_EQ (response["_postman_previewlanguage"], "json");
    EXPECT_FALSE (response.contains ("_postman_previewtype"));
    EXPECT_EQ (response["cookie"], before[0]["cookie"])
    << "the edit left the enabled Set-Cookie rows as recorded (there were "
       "none), so the recorded cookies stay";
    EXPECT_EQ (response["responseTime"], "493");
    EXPECT_EQ (after.at (1), before.at (1))
    << "the untouched example is unchanged";

    // Clearing the stored response falls back to regeneration entirely.
    auto [cleared_status, cleared] =
    vayu::http::routes::update_request_example_response (*db_,
    examples[1].request_id, examples[1].id, json{ { "postmanResponse", nullptr } });
    ASSERT_EQ (cleared_status, 200) << cleared.dump ();
    const ordered regenerated =
    exported_responses (export_text (id), "Look up tweets").at (1);
    EXPECT_EQ (regenerated["status"], "Unprocessable Content");
    EXPECT_EQ (regenerated["originalRequest"]["url"]["raw"], "{{baseUrl}}/tweets?ids=1");
}

/// One `{key, value, enabled}` row.
json kv (const std::string& key, const std::string& value) {
    return json{ { "key", key }, { "value", value }, { "enabled", true } };
}

// #1763, end to end through the routes: an example saved in the app with the
// request it was sent with exports that request after the request is edited,
// and the server's reason phrase rather than the table's. An edit to the
// example's status still regenerates the status text (#1762's guard reads the
// blob the create path built), and an example saved without `savedFrom` still
// exports the request as it is now. Mutation check: skip
// `record_saved_response` in the create core and the url, header and status
// assertions red.
TEST_F (PostmanExportRouteTest, AnAppSavedExampleExportsTheRequestItWasSentWith) {
    using namespace vayu::http::routes;
    auto [collection_status, collection] =
    create_collection_response (*db_, json{ { "name", "Sent" } });
    ASSERT_EQ (collection_status, 200) << collection.dump ();
    const std::string collection_id = collection["id"].get<std::string> ();

    const std::string url_a        = "{{baseUrl}}/a";
    auto [request_status, request] = create_request_response (*db_,
    json{ { "collectionId", collection_id }, { "name", "Probe" }, { "method", "GET" },
    { "url", url_a }, { "headers", json::array ({ kv ("X-Trace", "1") }) },
    { "auth", json{ { "mode", "bearer" }, { "token", "t0k" } } } });
    ASSERT_EQ (request_status, 200) << request.dump ();
    const std::string request_id = request["id"].get<std::string> ();

    // Saved from the live response: the request as written at Send.
    const json saved_from = { { "request",
                              { { "method", "GET" }, { "url", url_a },
                              { "params", json::array () },
                              { "headers", json::array ({ kv ("X-Trace", "1") }) },
                              { "body", json{ { "mode", "none" } } } } },
        { "statusText", "Totally Fine" }, { "responseTimeMs", 42 } };
    auto [sent_status, sent] = create_request_example_response (*db_, request_id,
    json{ { "name", "Sent" }, { "status", 200 }, { "origin", "user" },
    { "headers", json::array ({ kv ("Set-Cookie", "s=1; Path=/") }) },
    { "savedFrom", saved_from } });
    ASSERT_EQ (sent_status, 200) << sent.dump ();
    // Saved with no record (a response restored from a stored run).
    auto [plain_status, plain] = create_request_example_response (*db_, request_id,
    json{ { "name", "Plain" }, { "status", 200 }, { "origin", "user" } });
    ASSERT_EQ (plain_status, 200) << plain.dump ();

    // The request is edited after the save.
    auto [edit_status, edited] = update_request_response (*db_, request_id,
    json{ { "url", "{{baseUrl}}/b" }, { "headers", json::array ({ kv ("X-Trace", "2") }) } });
    ASSERT_EQ (edit_status, 200) << edited.dump ();

    const ordered responses = exported_responses (export_text (collection_id), "Probe");
    ASSERT_EQ (responses.size (), 2u);
    const ordered& recorded = responses.at (0);
    EXPECT_EQ (recorded["originalRequest"]["url"]["raw"], url_a);
    EXPECT_EQ (recorded["originalRequest"]["header"][0]["value"], "1");
    EXPECT_FALSE (recorded["originalRequest"].contains ("auth"))
    << "auth is not recorded";
    EXPECT_EQ (recorded["status"], "Totally Fine");
    EXPECT_EQ (recorded["code"], 200);
    EXPECT_EQ (recorded["cookie"][0]["key"], "s");
    EXPECT_EQ (recorded["responseTime"], 42);
    EXPECT_EQ (recorded["name"], "Sent");

    const ordered& regenerated = responses.at (1);
    EXPECT_EQ (regenerated["originalRequest"]["url"]["raw"], "{{baseUrl}}/b");
    EXPECT_EQ (regenerated["originalRequest"]["header"][0]["value"], "2");
    EXPECT_EQ (regenerated["status"], "OK");

    // An edit to the recorded example's status regenerates its text.
    auto [status_edit, status_edited] = update_request_example_response (
    *db_, request_id, sent["id"].get<std::string> (), json{ { "status", 201 } });
    ASSERT_EQ (status_edit, 200) << status_edited.dump ();
    const ordered after =
    exported_responses (export_text (collection_id), "Probe").at (0);
    EXPECT_EQ (after["status"], "Created");
    EXPECT_EQ (after["code"], 201);
    EXPECT_EQ (after["originalRequest"]["url"]["raw"], url_a)
    << "the recorded request is not what the edit changed";
}

// A cookie is the Set-Cookie row it was read from: an edit that removes the
// row takes the cookie's value out of the export with it, while an untouched
// example keeps its recorded cookies. Mutation check: write the stored
// `cookie` unconditionally in `stored_member` and the secret survives.
TEST_F (PostmanExportRouteTest, ARemovedSetCookieRowTakesItsCookieWithIt) {
    using namespace vayu::http::routes;
    auto [collection_status, collection] =
    create_collection_response (*db_, json{ { "name", "Jar" } });
    ASSERT_EQ (collection_status, 200) << collection.dump ();
    const std::string collection_id = collection["id"].get<std::string> ();
    auto [request_status, request]  = create_request_response (*db_,
     json{ { "collectionId", collection_id }, { "name", "Login" },
     { "method", "GET" }, { "url", "{{baseUrl}}/login" } });
    ASSERT_EQ (request_status, 200) << request.dump ();
    const std::string request_id = request["id"].get<std::string> ();

    const json saved_from = { { "request", { { "method", "GET" }, { "url", "{{baseUrl}}/login" } } },
        { "statusText", "OK" } };
    const auto save = [&] (const std::string& name, const std::string& cookie) {
        auto [status, body] = create_request_example_response (*db_, request_id,
        json{ { "name", name }, { "status", 200 }, { "origin", "user" },
        { "headers", json::array ({ kv ("Set-Cookie", cookie) }) },
        { "savedFrom", saved_from } });
        EXPECT_EQ (status, 200) << body.dump ();
        return body.value ("id", "");
    };
    const std::string edited_id = save ("Edited", "sid=secret1; Path=/");
    save ("Untouched", "keep=kept1; Path=/");

    auto [edit_status, edited] = update_request_example_response (
    *db_, request_id, edited_id, json{ { "headers", json::array () } });
    ASSERT_EQ (edit_status, 200) << edited.dump ();

    const std::string text  = export_text (collection_id);
    const ordered responses = exported_responses (text, "Login");
    ASSERT_EQ (responses.size (), 2u);
    EXPECT_EQ (responses[0]["header"], ordered::array ());
    EXPECT_EQ (responses[0]["cookie"], ordered::array ());
    EXPECT_EQ (text.find ("secret1"), std::string::npos);
    ASSERT_EQ (responses[1]["cookie"].size (), 1u);
    EXPECT_EQ (responses[1]["cookie"][0]["key"], "keep");
    EXPECT_EQ (responses[1]["cookie"][0]["value"], "kept1");
}

// An edit that leaves the Set-Cookie rows alone - a Content-Type fixed after
// the save - keeps the recorded `cookie[]` byte for byte, its Max-Age still
// counted from `receivedAt` rather than from the export. Mutation check:
// guard `cookie` with `rows_same` again and this reds.
TEST_F (PostmanExportRouteTest, AnUnrelatedHeaderEditKeepsTheRecordedCookies) {
    using namespace vayu::http::routes;
    auto [collection_status, collection] =
    create_collection_response (*db_, json{ { "name", "Jar" } });
    ASSERT_EQ (collection_status, 200) << collection.dump ();
    const std::string collection_id = collection["id"].get<std::string> ();
    auto [request_status, request]  = create_request_response (*db_,
     json{ { "collectionId", collection_id }, { "name", "Login" },
     { "method", "GET" }, { "url", "{{baseUrl}}/login" } });
    ASSERT_EQ (request_status, 200) << request.dump ();
    const std::string request_id = request["id"].get<std::string> ();

    const json saved_from = { { "request", { { "method", "GET" }, { "url", "{{baseUrl}}/login" } } },
        { "statusText", "OK" }, { "receivedAt", 1767225600000.0 } };
    const json set_cookie = kv ("Set-Cookie", "sid=s1; Max-Age=60; Path=/");
    auto [saved_status, saved] = create_request_example_response (*db_, request_id,
    json{ { "name", "Saved" }, { "status", 200 }, { "origin", "user" },
    { "headers", json::array ({ kv ("Content-Type", "text/plain"), set_cookie }) },
    { "savedFrom", saved_from } });
    ASSERT_EQ (saved_status, 200) << saved.dump ();
    const ordered before =
    exported_responses (export_text (collection_id), "Login").at (0)["cookie"];
    ASSERT_EQ (before.size (), 1u) << before.dump ();
    EXPECT_EQ (before[0]["expires"],
    "Thu Jan 01 2026 00:01:00 GMT+0000 (Coordinated Universal Time)");

    auto [edit_status, edited] = update_request_example_response (*db_,
    request_id, saved["id"].get<std::string> (),
    json{ { "headers",
    json::array ({ kv ("Content-Type", "application/json"), set_cookie }) } });
    ASSERT_EQ (edit_status, 200) << edited.dump ();
    const ordered after =
    exported_responses (export_text (collection_id), "Login").at (0);
    EXPECT_EQ (after["cookie"].dump (), before.dump ());
    EXPECT_EQ (after["_postman_previewlanguage"], "json");
}

/// A collection whose root and one request carry an OAuth 2.0 block with a
/// literal client secret and an attribute Vayu has no field for
/// (`tokenName`), so the import keeps the block as the auth's `postman`
/// source.
constexpr const char* OAUTH2_SOURCE_DOCUMENT = R"({
  "info": {"name": "Rotated", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
  "item": [{"name": "Token", "request": {"method": "GET", "url": "https://api.test/me",
    "auth": {"type": "oauth2", "oauth2": [
      {"key": "clientSecret", "value": "live-request", "type": "string"},
      {"key": "clientId", "value": "id", "type": "string"},
      {"key": "accessTokenUrl", "value": "https://auth.test/token", "type": "string"},
      {"key": "tokenName", "value": "Mine", "type": "string"},
      {"key": "grant_type", "value": "client_credentials", "type": "string"}]}}}],
  "auth": {"type": "oauth2", "oauth2": [
    {"key": "clientSecret", "value": "live-root", "type": "string"},
    {"key": "clientId", "value": "id", "type": "string"},
    {"key": "accessTokenUrl", "value": "https://auth.test/token", "type": "string"},
    {"key": "tokenName", "value": "Root", "type": "string"},
    {"key": "grant_type", "value": "client_credentials", "type": "string"}]}
})";

// A replaced credential leaves with the source that still held it, whoever
// wrote the replacement (the app's editors, an MCP tool, the API): the write
// boundary drops a `postman` source that no longer describes the auth, and
// keeps one that does, so an untouched save still exports byte-identically.
// Mutation check: make `without_stale_postman_source` return its input and
// the "live" assertions go red.
TEST_F (PostmanExportRouteTest, AReplacedCredentialDropsTheSourceThatHeldIt) {
    using vayu::http::routes::get_request_response;
    using vayu::http::routes::update_collection_response;
    using vayu::http::routes::update_request_response;
    const std::string id = import_text (OAUTH2_SOURCE_DOCUMENT);
    const auto rows      = db_->get_requests_in_collection (id);
    ASSERT_EQ (rows.size (), 1U);
    const std::string request_id = rows[0].id;
    const std::string before     = without_postman_id (export_text (id));
    ASSERT_NE (before.find ("\"tokenName\""), std::string::npos) << before;

    auto [got_status, got] = get_request_response (*db_, request_id);
    ASSERT_EQ (got_status, 200) << got.dump ();
    json auth = got["auth"];
    ASSERT_TRUE (auth.contains ("postman")) << auth.dump ();
    const auto root = db_->get_collection (id);
    ASSERT_HAS_VALUE (root);
    json root_auth = json::parse (root->auth);
    ASSERT_TRUE (root_auth.contains ("postman")) << root_auth.dump ();

    // Saved as loaded: the source still describes the auth and stays.
    auto [same_status, same] =
    update_request_response (*db_, request_id, json{ { "auth", auth } });
    ASSERT_EQ (same_status, 200) << same.dump ();
    auto [same_root_status, same_root] =
    update_collection_response (*db_, id, json{ { "auth", root_auth } });
    ASSERT_EQ (same_root_status, 200) << same_root.dump ();
    EXPECT_EQ (without_postman_id (export_text (id)), before);

    // Rotated, with the stale block still attached the way a client that
    // spreads the loaded auth sends it.
    auth["config"]["clientSecret"]      = "rotated-request";
    root_auth["config"]["clientSecret"] = "rotated-root";
    auto [put_status, put] =
    update_request_response (*db_, request_id, json{ { "auth", auth } });
    ASSERT_EQ (put_status, 200) << put.dump ();
    auto [root_status, root_put] =
    update_collection_response (*db_, id, json{ { "auth", root_auth } });
    ASSERT_EQ (root_status, 200) << root_put.dump ();

    auto [after_status, after] = get_request_response (*db_, request_id);
    ASSERT_EQ (after_status, 200);
    EXPECT_EQ (after.dump ().find ("live-request"), std::string::npos) << after.dump ();
    EXPECT_FALSE (after["auth"].contains ("postman"));
    EXPECT_EQ (after["auth"]["config"]["clientSecret"], "rotated-request");
    const auto rotated_root = db_->get_collection (id);
    ASSERT_HAS_VALUE (rotated_root);
    EXPECT_EQ (rotated_root->auth.find ("live-root"), std::string::npos)
    << rotated_root->auth;
    const std::string exported = export_text (id);
    EXPECT_EQ (exported.find ("live-"), std::string::npos) << exported;
    EXPECT_NE (exported.find ("rotated-request"), std::string::npos) << exported;
}

TEST_F (PostmanExportRouteTest, WritesNothing) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    const size_t collections = db_->get_collections ().size ();
    const auto before        = db_->get_collection (id);
    ASSERT_HAS_VALUE (before);
    export_ok (id);
    export_ok (id, false);
    EXPECT_EQ (db_->get_collections ().size (), collections);
    const auto after = db_->get_collection (id);
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->updated_at, before->updated_at);
}

TEST_F (PostmanExportRouteTest, ExportsTheNamedSubtreeOnly) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    std::string admin;
    for (const auto& collection : db_->get_collections ()) {
        if (collection.name == "Admin" && collection.parent_id && *collection.parent_id == id) {
            admin = collection.id;
        }
    }
    ASSERT_FALSE (admin.empty ());
    json body   = export_ok (admin);
    ordered doc = ordered::parse (body["text"].get<std::string> ());
    EXPECT_EQ (doc["info"]["name"], "Admin");
    EXPECT_EQ (doc["info"]["description"], "Admin-only endpoints.");
    EXPECT_EQ (doc["item"][0]["name"], "Deep");
    EXPECT_EQ (body["notes"]["requestsExported"], 3);
    EXPECT_EQ (body["notes"]["foldersExported"], 1);
}

// --- The import corpus -------------------------------------------------------

/// The Postman collection documents of `fixtures/import-conformance.json` -
/// the renderer's retired fixtures, byte-identical to
/// `app/src/services/importers/__fixtures__/postman-v2{0,1}.json`.
std::vector<std::pair<std::string, std::string>> corpus_documents () {
    json fixture =
    json::parse (read_text (fixture_path ("import-conformance.json")));
    std::vector<std::pair<std::string, std::string>> out;
    for (const json& entry : fixture.at ("cases")) {
        const std::string name = entry.at ("name").get<std::string> ();
        if (name == "postman-v21" || name == "postman-v20" || name == "postman-bodies") {
            out.emplace_back (name, entry.at ("document").get<std::string> ());
        }
    }
    return out;
}

void normalise_rows (json& rows) {
    for (json& entry : rows) {
        if (entry.value ("type", "") == "text") {
            entry.erase ("type");
        }
    }
}

/// A v2.0 auth detail object as the v2.1 attribute array's `{key: value}`,
/// and a v2.1 array the same way - both spellings of one mapping.
void normalise_auth (json& auth) {
    const std::string type = auth.value ("type", "");
    if (type == "inherit") {
        auth = nullptr;
        return;
    }
    json detail = json::object ();
    if (auth.contains (type) && auth[type].is_array ()) {
        for (const json& entry : auth[type]) {
            detail[entry.at ("key").get<std::string> ()] = entry.at ("value");
        }
    } else if (auth.contains (type)) {
        detail = auth[type];
    }
    auth = json{ { "type", type }, { "detail", detail } };
}

/**
 * The provably lossless differences between a Postman document and Vayu's
 * export of it, folded away:
 *
 *  1. `info._postman_id` is minted by whoever exports; `info.schema` names
 *     the version the file is written in (a v2.0 input exports as v2.1).
 *  2. A `url` string is the `raw` of the object form; `host`, `path`,
 *     `protocol` and `port` are derived from `raw`. A string's query becomes
 *     rows, which is how v2.1 states the same query.
 *  3. `type: "text"` on a request-side row is the schema default, written out.
 *  4. An auth attribute's `type: "string"` likewise; a v2.0 auth detail
 *     object and a v2.1 attribute array state the same pairs.
 *  5. An event script's `type: "text/javascript"`, `packages: {}` and
 *     `requests: {}` are Postman's defaults; `exec` as a string or as lines
 *     is the same script.
 *  6. `auth: {type: "inherit"}` on a request is absent auth.
 *  7. An absent `header` is `[]`; an absent `response` is `[]`.
 *
 * `json`, not `ordered_json`: key order is compared nowhere here - the
 * byte-for-byte fixture test above owns that.
 */
void normalise (json& node, const std::string& key = {}) {
    if (node.is_array ()) {
        for (json& entry : node) {
            normalise (entry, key);
        }
        return;
    }
    if (!node.is_object ()) {
        return;
    }
    if (node.contains ("info")) {
        node["info"].erase ("_postman_id");
        node["info"].erase ("schema");
    }
    if (node.contains ("request") && node["request"].is_object ()) {
        json& request = node["request"];
        if (!request.contains ("header")) {
            request["header"] = json::array ();
        }
        normalise_rows (request["header"]);
        if (request.contains ("auth")) {
            normalise_auth (request["auth"]);
            if (request["auth"].is_null ()) {
                request.erase ("auth");
            }
        }
        json& url = request["url"];
        if (url.is_string ()) {
            const std::string raw = url.get<std::string> ();
            url                   = json{ { "raw", raw } };
            if (const size_t question = raw.find ('?'); question != std::string::npos) {
                json query = json::array ();
                std::stringstream pairs (raw.substr (question + 1));
                std::string pair;
                while (std::getline (pairs, pair, '&')) {
                    const size_t equals = pair.find ('=');
                    query.push_back ({ { "key", pair.substr (0, equals) },
                    { "value", equals == std::string::npos ? "" : pair.substr (equals + 1) } });
                }
                url["query"] = query;
            }
        }
        for (const char* derived : { "host", "path", "protocol", "port" }) {
            url.erase (derived);
        }
        if (request.contains ("body")) {
            for (const char* rows : { "urlencoded", "formdata" }) {
                if (request["body"].contains (rows)) {
                    normalise_rows (request["body"][rows]);
                }
            }
        }
        if (!node.contains ("response")) {
            node["response"] = json::array ();
        }
    }
    if (node.contains ("auth") && key != "request") {
        normalise_auth (node["auth"]);
    }
    if (node.contains ("script")) {
        json& script = node["script"];
        for (const char* placeholder : { "type", "packages", "requests" }) {
            script.erase (placeholder);
        }
        if (script["exec"].is_string ()) {
            json lines = json::array ();
            std::stringstream text (script["exec"].get<std::string> ());
            std::string line;
            while (std::getline (text, line)) {
                lines.push_back (line);
            }
            script["exec"] = lines;
        }
    }
    for (auto member = node.begin (); member != node.end (); ++member) {
        if (member.key () != "info") {
            normalise (member.value (), member.key ());
        }
    }
}

TEST_F (PostmanExportRouteTest, CorpusDocumentsComeBackEqualAfterTheLosslessNormalisation) {
    // `postman-bodies` is left out of this one: it holds a `null` item and a
    // file row with no file, which the importer drops and counts - the
    // fixed-point test below covers it.
    for (const auto& [name, text] : corpus_documents ()) {
        if (name == "postman-bodies") {
            continue;
        }
        json original = json::parse (text);
        json exported = json::parse (export_text (import_text (text)));
        normalise (original);
        normalise (exported);
        EXPECT_EQ (exported, original) << name << "\nexported: " << exported.dump (1);
    }
}

/// A stored JSON column, element ids dropped: the apply mints them.
json stored (const std::string& blob) {
    json parsed = json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_array ()) {
        for (json& entry : parsed) {
            if (entry.is_object ()) {
                entry.erase ("id");
            }
        }
    }
    return parsed;
}

/// Everything the UI shows for @p id's subtree, ids and timestamps aside.
json snapshot (vayu::db::Database& db, const std::string& id) {
    const auto collection = db.get_collection (id);
    if (!collection) {
        ADD_FAILURE () << "no collection " << id;
        return json ();
    }
    json out{ { "name", collection->name }, { "description", collection->description },
        { "variables", stored (collection->variables) },
        { "auth", stored (collection->auth) },
        { "elements", stored (collection->elements) } };
    json requests = json::array ();
    for (const auto& row : db.get_requests_in_collection (id)) {
        json examples = json::array ();
        for (const auto& example : db.get_request_examples (row.id)) {
            examples.push_back ({ example.name, example.status,
            stored (example.headers), example.body, example.content_type });
        }
        requests.push_back ({ { "name", row.name }, { "description", row.description },
        { "method", vayu::to_string (row.method) }, { "url", row.url },
        { "params", stored (row.params) }, { "headers", stored (row.headers) },
        { "body", stored (row.body) }, { "auth", stored (row.auth) },
        { "elements", stored (row.elements) }, { "followRedirects", row.follow_redirects },
        { "maxRedirects", row.max_redirects }, { "verifySSL", row.verify_ssl },
        { "disableCookies", row.disable_cookies },
        { "disabledSystemHeaders", stored (row.disabled_system_headers) },
        { "disableUrlEncoding", row.disable_url_encoding },
        { "postmanProtocolBehavior", row.postman_protocol_behavior.value_or ("") },
        { "order", row.order }, { "examples", examples } });
    }
    out["requests"] = requests;
    json folders    = json::array ();
    for (const auto& child : db.get_collections ()) {
        if (child.parent_id && *child.parent_id == id) {
            folders.push_back (
            { { "order", child.order }, { "folder", snapshot (db, child.id) } });
        }
    }
    out["folders"] = folders;
    return out;
}

TEST_F (PostmanExportRouteTest, ReimportingTheExportGivesTheSameCollection) {
    std::vector<std::pair<std::string, std::string>> documents = corpus_documents ();
    documents.emplace_back (
    "roundtrip", read_text (fixture_path ("postman-export-roundtrip.json")));
    for (const auto& [name, text] : documents) {
        const std::string first = import_text (text);
        const std::string again = import_text (export_text (first));
        EXPECT_EQ (snapshot (*db_, again), snapshot (*db_, first)) << name;
    }
}

TEST_F (PostmanExportRouteTest, ImportExportImportIsAFixedPoint) {
    std::vector<std::pair<std::string, std::string>> documents = corpus_documents ();
    documents.emplace_back (
    "roundtrip", read_text (fixture_path ("postman-export-roundtrip.json")));
    for (const auto& [name, text] : documents) {
        const std::string first  = export_text (import_text (text));
        const std::string second = export_text (import_text (first));
        const std::string third  = export_text (import_text (second));
        // Export -> import -> export is byte-identical from the first export
        // on: whatever the importer normalises, it normalises once.
        EXPECT_EQ (without_postman_id (second), without_postman_id (first)) << name;
        EXPECT_EQ (without_postman_id (third), without_postman_id (second)) << name;
    }
}

} // namespace
