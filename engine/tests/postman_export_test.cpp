/**
 * @file tests/postman_export_test.cpp
 * @brief The Postman v2.1.0 exporter (`core/postman_export.hpp`).
 *
 *  - **Shape.** Every mapping written as Postman writes it: key order per
 *    object, the row and attribute `type`s, what is left absent, and the text
 *    itself (`JSON.stringify(x, null, "\t")`).
 *  - **Notes.** Everything stored that the document does not carry is a
 *    `notCarried` entry, never a silent drop.
 *
 * The round trip through the importer is `postman_export_route_test.cpp`.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/import_document.hpp"
#include "vayu/core/postman_export.hpp"

namespace {

using ordered = nlohmann::ordered_json;
using nlohmann::json;
using vayu::core::export_postman;
using vayu::core::PostmanExportExample;
using vayu::core::PostmanExportFolder;
using vayu::core::PostmanExportOptions;
using vayu::core::PostmanExportRequest;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

std::vector<std::string> keys_of (const ordered& node) {
    std::vector<std::string> keys;
    for (auto member = node.begin (); member != node.end (); ++member) {
        keys.push_back (member.key ());
    }
    return keys;
}

using Keys = std::vector<std::string>;

PostmanExportFolder collection (const std::string& name = "Pets") {
    PostmanExportFolder root;
    root.name = name;
    return root;
}

PostmanExportRequest request (const std::string& name, const std::string& url) {
    PostmanExportRequest out;
    out.name = name;
    out.url  = url;
    return out;
}

vayu::core::PostmanExportOutcome run (const PostmanExportFolder& root, bool secrets = true) {
    PostmanExportOptions options;
    options.collection_id   = "col_2f1c3a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
    options.include_secrets = secrets;
    return export_postman (root, options);
}

ordered document (const PostmanExportFolder& root, bool secrets = true) {
    return ordered::parse (run (root, secrets).text);
}

/// The one request of a collection holding exactly one.
ordered only_item (const PostmanExportRequest& entry, bool secrets = true) {
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    return document (root, secrets).at ("item").at (0);
}

/// `notCarried` as `{code: count}`.
json losses (const vayu::core::PostmanExportOutcome& outcome) {
    json out = json::object ();
    for (const auto& entry : outcome.notes.not_carried) {
        out[entry.code] = entry.count;
    }
    return out;
}

ordered row (const std::string& key, const std::string& value, bool enabled = true) {
    return ordered{ { "key", key }, { "value", value }, { "enabled", enabled } };
}

ordered element (const std::string& kind, const ordered& config) {
    return ordered{ { "id", "el_" + kind }, { "kind", kind }, { "config", config } };
}

// ---------------------------------------------------------------------------
// The document envelope
// ---------------------------------------------------------------------------

TEST (PostmanExport, WritesTheTextPostmanWrites) {
    PostmanExportFolder root = collection ();
    root.requests.push_back (request ("List", "{{baseUrl}}/pets"));
    const std::string text = run (root).text;
    // `JSON.stringify(document, null, "\t")`: tab indentation, `": "`, no
    // trailing newline, `[]` / `{}` for an empty container.
    EXPECT_EQ (text.rfind ("{\n\t\"info\": {\n\t\t\"_postman_id\": \"", 0), 0U) << text;
    EXPECT_NE (text.find ("\n\t\t\t\"response\": []\n"), std::string::npos) << text;
    EXPECT_EQ (text.back (), '}');
    EXPECT_EQ (text.find ("    "), std::string::npos) << "no space indentation";
}

TEST (PostmanExport, InfoAndRootInPostmansKeyOrder) {
    PostmanExportFolder root = collection ("Pet Store");
    root.description         = "All the pets.";
    root.auth = ordered{ { "mode", "bearer" }, { "token", "t" } };
    root.elements = ordered::array ({ element ("script.pre", { { "script", "a()" } }) });
    root.variables = ordered{ { "baseUrl", { { "value", "x" }, { "enabled", true } } } };
    ordered doc = document (root);
    EXPECT_EQ (keys_of (doc), (Keys{ "info", "item", "auth", "event", "variable" }));
    EXPECT_EQ (keys_of (doc.at ("info")),
    (Keys{ "_postman_id", "name", "description", "schema" }));
    EXPECT_EQ (doc["info"]["schema"],
    "https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
    EXPECT_EQ (doc["info"]["_postman_id"], "2f1c3a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b");
    EXPECT_EQ (doc["item"], ordered::array ());
}

TEST (PostmanExport, AnEmptyCollectionWritesOnlyInfoAndItem) {
    ordered doc = document (collection ());
    EXPECT_EQ (keys_of (doc), (Keys{ "info", "item" }));
    EXPECT_EQ (keys_of (doc.at ("info")), (Keys{ "_postman_id", "name", "schema" }));
}

TEST (PostmanExport, PostmanIdIsTheCollectionsUuid) {
    using vayu::core::postman_collection_uuid;
    EXPECT_EQ (postman_collection_uuid ("9F400AC1-C634-472B-9CFD-93FCF9D5F21A"),
    "9f400ac1-c634-472b-9cfd-93fcf9d5f21a");
    EXPECT_EQ (
    postman_collection_uuid ("col_9f400ac1-c634-472b-9cfd-93fcf9d5f21a"),
    "9f400ac1-c634-472b-9cfd-93fcf9d5f21a");
    // Anything else derives one: stable, and shaped as a version-8 UUID.
    const std::string derived = postman_collection_uuid ("col_1");
    EXPECT_EQ (derived, postman_collection_uuid ("col_1"));
    EXPECT_NE (derived, postman_collection_uuid ("col_2"));
    ASSERT_EQ (derived.size (), 36U);
    EXPECT_EQ (derived.at (14), '8');
    EXPECT_NE (std::string ("89ab").find (derived.at (19)), std::string::npos);
}

TEST (PostmanExport, FileNameFollowsPostmansConvention) {
    EXPECT_EQ (run (collection ("Pet Store")).file_name, "Pet Store.postman_collection.json");
    EXPECT_EQ (run (collection ("a/b:c*?\"<>|\\d. ")).file_name,
    "a_b_c_______d.postman_collection.json");
    EXPECT_EQ (run (collection ("")).file_name, "collection.postman_collection.json");
}

// ---------------------------------------------------------------------------
// Folders and ordering
// ---------------------------------------------------------------------------

TEST (PostmanExport, FoldersComeBeforeRequestsInStoredOrder) {
    PostmanExportFolder root = collection ();
    root.requests.push_back (request ("r1", "u"));
    root.requests.push_back (request ("r2", "u"));
    PostmanExportFolder first  = collection ("f1");
    PostmanExportFolder second = collection ("f2");
    second.description         = "Second";
    second.auth                = ordered{ { "mode", "noauth" } };
    second.elements =
    ordered::array ({ element ("script.post", { { "script", "t()" } }) });
    second.variables = ordered{ { "v", { { "value", "1" }, { "enabled", true } } } };
    PostmanExportFolder nested = collection ("f2a");
    nested.requests.push_back (request ("deep", "u"));
    second.folders.push_back (nested);
    root.folders.push_back (first);
    root.folders.push_back (second);

    const auto outcome = run (root);
    ordered doc        = ordered::parse (outcome.text);
    ordered& items     = doc.at ("item");
    ASSERT_EQ (items.size (), 4U);
    EXPECT_EQ (items[0]["name"], "f1");
    EXPECT_EQ (items[1]["name"], "f2");
    EXPECT_EQ (items[2]["name"], "r1");
    EXPECT_EQ (items[3]["name"], "r2");
    EXPECT_EQ (keys_of (items[0]), (Keys{ "name", "item" }));
    EXPECT_EQ (keys_of (items[1]),
    (Keys{ "name", "item", "description", "auth", "event", "variable" }));
    EXPECT_EQ (items[1]["auth"], (ordered{ { "type", "noauth" } }));
    EXPECT_EQ (items[1]["item"][0]["item"][0]["name"], "deep");
    EXPECT_EQ (outcome.notes.folders_exported, 3);
    EXPECT_EQ (outcome.notes.requests_exported, 3);
}

// ---------------------------------------------------------------------------
// Requests: method, headers, url, description
// ---------------------------------------------------------------------------

TEST (PostmanExport, RequestInPostmansKeyOrder) {
    PostmanExportRequest entry = request ("Create", "{{baseUrl}}/pets");
    entry.method               = "POST";
    entry.description          = "Makes one.";
    entry.auth = ordered{ { "mode", "bearer" }, { "token", "t" } };
    entry.body = ordered{ { "mode", "json" }, { "content", "{}" } };
    entry.elements =
    ordered::array ({ element ("script.pre", { { "script", "a()" } }) });
    entry.follow_redirects = false;
    ordered item           = only_item (entry);
    EXPECT_EQ (keys_of (item),
    (Keys{ "name", "event", "protocolProfileBehavior", "request", "response" }));
    EXPECT_EQ (keys_of (item["request"]),
    (Keys{ "auth", "method", "header", "body", "url", "description" }));
    EXPECT_EQ (item["request"]["description"], "Makes one.");
}

TEST (PostmanExport, APlainRequestWritesEmptyHeaderAndResponse) {
    ordered item = only_item (request ("List", "{{baseUrl}}/pets"));
    EXPECT_EQ (keys_of (item), (Keys{ "name", "request", "response" }));
    EXPECT_EQ (keys_of (item["request"]), (Keys{ "method", "header", "url" }));
    EXPECT_EQ (item["request"]["method"], "GET");
    EXPECT_EQ (item["request"]["header"], ordered::array ());
    EXPECT_EQ (item["response"], ordered::array ());
}

TEST (PostmanExport, HeaderRowsAreTypedTextAndDisabledOnlyWhenOff) {
    PostmanExportRequest entry = request ("r", "u");
    ordered described          = row ("X-Tenant", "acme");
    described["description"]   = "Which tenant";
    described["source"]        = "body-mode";
    entry.headers =
    ordered::array ({ row ("Accept", "a/b"), row ("X-Off", "1", false), described });
    ordered headers = only_item (entry)["request"]["header"];
    EXPECT_EQ (headers[0].dump (), R"({"key":"Accept","value":"a/b","type":"text"})");
    EXPECT_EQ (headers[1].dump (), R"({"key":"X-Off","value":"1","type":"text","disabled":true})");
    EXPECT_EQ (headers[2].dump (),
    R"({"key":"X-Tenant","value":"acme","description":"Which tenant","type":"text"})");
}

TEST (PostmanExport, RowMetadataAnImportKeptIsWrittenBack) {
    PostmanExportRequest entry = request ("r", "u?expand=");
    ordered typed              = row ("Accept", "a/b");
    typed["type"]              = "default";
    entry.headers              = ordered::array ({ typed });
    ordered equals             = row ("expand", "", false);
    equals["equals"]           = true;
    entry.params               = ordered::array ({ equals });
    ordered item               = only_item (entry);
    EXPECT_EQ (item["request"]["header"][0].dump (),
    R"({"key":"Accept","value":"a/b","type":"default"})");
    // `equals` after `value`, where Postman writes it.
    EXPECT_EQ (item["request"]["url"]["query"][0].dump (),
    R"({"key":"expand","value":"","equals":true,"disabled":true})");
}

TEST (PostmanExport, RowsWithoutANameAreDroppedAndCountedWhenTheyHeldAValue) {
    PostmanExportRequest entry = request ("r", "u");
    entry.headers =
    ordered::array ({ row ("", ""), row ("", "orphan"), row ("A", "1") });
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_EQ (ordered::parse (outcome.text)["item"][0]["request"]["header"].size (), 1U);
    EXPECT_EQ (losses (outcome), (json{ { "rows_without_key", 1 } }));
}

TEST (PostmanExport, QueryRowsComeFromParamsAndKeepTurnedOffRows) {
    PostmanExportRequest entry = request ("r", "{{baseUrl}}/pets?limit=10");
    ordered described          = row ("limit", "10");
    described["description"]   = "Page size";
    entry.params = ordered::array ({ described, row ("trace", "on", false) });
    ordered url  = only_item (entry)["request"]["url"];
    EXPECT_EQ (keys_of (url), (Keys{ "raw", "host", "path", "query" }));
    EXPECT_EQ (url["raw"], "{{baseUrl}}/pets?limit=10");
    EXPECT_EQ (url["query"].dump (),
    R"([{"key":"limit","value":"10","description":"Page size"},{"key":"trace","value":"on","disabled":true}])");
}

struct UrlCase {
    const char* raw;
    const char* expected;
};

TEST (PostmanExport, UrlPartsSplitTheWayPostmansParserSplits) {
    const std::vector<UrlCase> cases = {
        { "{{baseUrl}}/users", R"({"raw":"{{baseUrl}}/users","host":["{{baseUrl}}"],"path":["users"]})" },
        { "{{baseUrl}}", R"({"raw":"{{baseUrl}}","host":["{{baseUrl}}"]})" },
        { "https://api.example.com/v1/users/",
        R"({"raw":"https://api.example.com/v1/users/","protocol":"https","host":["api","example","com"],"path":["v1","users",""]})" },
        { "http://localhost:8080/x?a=1#top",
        R"({"raw":"http://localhost:8080/x?a=1#top","protocol":"http","host":["localhost"],"port":"8080","path":["x"],"hash":"top"})" },
        // A variable holding a separator stays whole, as in Postman.
        { "https://{{api.host}}/{{path/seg}}/end",
        R"({"raw":"https://{{api.host}}/{{path/seg}}/end","protocol":"https","host":["{{api.host}}"],"path":["{{path/seg}}","end"]})" },
        // A non-numeric port stays in the host.
        { "localhost:{{port}}/api",
        R"({"raw":"localhost:{{port}}/api","host":["localhost:{{port}}"],"path":["api"]})" },
        { "https://user:pw@example.com/a",
        R"({"raw":"https://user:pw@example.com/a","protocol":"https","host":["example","com"],"path":["a"]})" },
        { "", R"({"raw":""})" },
    };
    for (const UrlCase& entry : cases) {
        EXPECT_EQ (vayu::core::postman_url_parts (entry.raw).dump (), entry.expected)
        << entry.raw;
    }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

ordered body_of (const ordered& stored, const std::string& method = "POST") {
    PostmanExportRequest entry = request ("r", "u");
    entry.method               = method;
    entry.body                 = stored;
    ordered item               = only_item (entry);
    return item["request"].value ("body", ordered ());
}

TEST (PostmanExport, RawModesCarryTheirLanguage) {
    for (const char* mode : { "json", "text", "xml" }) {
        EXPECT_EQ (body_of ({ { "mode", mode }, { "content", "c" } }).dump (),
        std::string (R"({"mode":"raw","raw":"c","options":{"raw":{"language":")") + mode + "\"}}}")
        << mode;
    }
}

TEST (PostmanExport, ARawLanguageAnImportKeptIsWrittenBackWhileItStillHolds) {
    // Declared none: no `options` at all, as Postman wrote it.
    EXPECT_EQ (
    body_of ({ { "mode", "json" }, { "content", "{}" }, { "rawLanguage", "" } }).dump (),
    R"({"mode":"raw","raw":"{}"})");
    // A language Vayu has no mode for, sniffed into `text`.
    EXPECT_EQ (body_of ({ { "mode", "text" }, { "content", "let a;" },
                        { "rawLanguage", "javascript" } })
               .dump (),
    R"({"mode":"raw","raw":"let a;","options":{"raw":{"language":"javascript"}}})");
    // Edited since: the content no longer sniffs to the stored mode, so the
    // kept language would mislabel it and the mode's own name is written.
    EXPECT_EQ (
    body_of ({ { "mode", "json" }, { "content", "not json" }, { "rawLanguage", "" } })
    .dump (),
    R"({"mode":"raw","raw":"not json","options":{"raw":{"language":"json"}}})");
}

TEST (PostmanExport, NoBodyWritesNoBodyKey) {
    EXPECT_TRUE (body_of ({ { "mode", "none" } }).is_null ());
    EXPECT_TRUE (body_of (ordered::object ()).is_null ());
}

TEST (PostmanExport, JsonRpcIsARawJsonBodyAndANote) {
    PostmanExportRequest entry = request ("r", "u");
    entry.body = ordered{ { "mode", "jsonrpc" }, { "content", R"({"jsonrpc":"2.0"})" } };
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_EQ (
    ordered::parse (
    outcome.text)["item"][0]["request"]["body"]["options"]["raw"]["language"],
    "json");
    EXPECT_EQ (losses (outcome), (json{ { "jsonrpc_bodies", 1 } }));
}

TEST (PostmanExport, GraphqlVariablesAreThePanesText) {
    ordered object_vars = body_of ({ { "mode", "graphql" },
    { "content", R"({"query":"{ me }","variables":{"id":1},"operationName":"Me"})" } });
    EXPECT_EQ (object_vars.dump (),
    R"({"mode":"graphql","graphql":{"query":"{ me }","variables":"{\n    \"id\": 1\n}","operationName":"Me"}})");
    // A pane that is not JSON (it holds a `{{token}}`) is kept verbatim.
    ordered text_vars = body_of ({ { "mode", "graphql" },
    { "content", R"({"query":"q","variables":"{\"id\": {{id}}}"})" } });
    EXPECT_EQ (text_vars["graphql"]["variables"], "{\"id\": {{id}}}");
    ordered no_vars =
    body_of ({ { "mode", "graphql" }, { "content", R"({"query":"q"})" } });
    EXPECT_EQ (no_vars["graphql"]["variables"], "");
}

TEST (PostmanExport, UrlencodedRowsAreTypedText) {
    ordered body = body_of ({ { "mode", "x-www-form-urlencoded" },
    { "fields", ordered::array ({ row ("a", "1"), row ("b", "2", false) }) } });
    EXPECT_EQ (body.dump (),
    R"({"mode":"urlencoded","urlencoded":[{"key":"a","value":"1","type":"text"},{"key":"b","value":"2","type":"text","disabled":true}]})");
}

TEST (PostmanExport, FormDataFilePartsNameTheirPath) {
    ordered file               = row ("upload", "");
    file["type"]               = "file";
    file["src"]                = "/home/ada/report.pdf";
    file["fileName"]           = "report.pdf";
    file["contentType"]        = "application/pdf";
    file["unresolved"]         = true;
    file["description"]        = "The PDF";
    ordered renamed            = row ("thumb", "");
    renamed["type"]            = "file";
    renamed["src"]             = "/tmp/a.png";
    renamed["fileName"]        = "cover.png";
    ordered unpicked           = row ("later", "", false);
    unpicked["type"]           = "file";
    PostmanExportRequest entry = request ("r", "u");
    entry.method               = "POST";
    entry.body                 = ordered{ { "mode", "form-data" },
                        { "fields", ordered::array ({ row ("title", "T"), file, renamed, unpicked }) } };
    PostmanExportFolder root   = collection ();
    root.requests.push_back (entry);
    const auto outcome = run (root);
    ordered fields = ordered::parse (outcome.text)["item"][0]["request"]["body"]["formdata"];
    EXPECT_EQ (fields[0].dump (), R"({"key":"title","value":"T","type":"text"})");
    EXPECT_EQ (fields[1].dump (),
    R"({"key":"upload","description":"The PDF","type":"file","src":"/home/ada/report.pdf","contentType":"application/pdf"})");
    EXPECT_EQ (fields[3].dump (), R"({"key":"later","type":"file","src":[],"disabled":true})");
    // A file name that is not the path's own is the one thing lost.
    EXPECT_EQ (losses (outcome), (json{ { "form_file_names", 1 } }));
}

TEST (PostmanExport, UnknownBodyModeIsANote) {
    PostmanExportRequest entry = request ("r", "u");
    entry.body = ordered{ { "mode", "binary" }, { "content", "x" } };
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_FALSE (ordered::parse (outcome.text)["item"][0]["request"].contains ("body"));
    EXPECT_EQ (losses (outcome), (json{ { "unsupported_bodies", 1 } }));
}

// ---------------------------------------------------------------------------
// protocolProfileBehavior
// ---------------------------------------------------------------------------

TEST (PostmanExport, ProtocolProfileBehaviorOnlyForWhatDiffersFromDefault) {
    EXPECT_FALSE (only_item (request ("r", "u")).contains ("protocolProfileBehavior"));
    PostmanExportRequest entry = request ("r", "u");
    entry.verify_ssl           = false;
    entry.follow_redirects     = false;
    entry.max_redirects        = 3;
    EXPECT_EQ (only_item (entry)["protocolProfileBehavior"].dump (),
    R"({"strictSSL":false,"followRedirects":false,"maxRedirects":3})");
}

TEST (PostmanExport, AGetThatSendsABodyTellsPostmanNotToPruneIt) {
    PostmanExportRequest entry = request ("r", "u");
    entry.body = ordered{ { "mode", "json" }, { "content", "{}" } };
    EXPECT_EQ (only_item (entry)["protocolProfileBehavior"].dump (),
    R"({"disableBodyPruning":true})");
    entry.body = ordered{ { "mode", "json" }, { "content", "" } };
    EXPECT_FALSE (only_item (entry).contains ("protocolProfileBehavior"));
    entry.method = "POST";
    entry.body   = ordered{ { "mode", "json" }, { "content", "{}" } };
    EXPECT_FALSE (only_item (entry).contains ("protocolProfileBehavior"));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

ordered auth_of (const ordered& stored, bool secrets = true) {
    PostmanExportRequest entry = request ("r", "u");
    entry.auth                 = stored;
    return only_item (entry, secrets)["request"].value ("auth", ordered ());
}

TEST (PostmanExport, RequestAuthModes) {
    EXPECT_TRUE (auth_of ({ { "mode", "inherit" } }).is_null ());
    EXPECT_TRUE (auth_of (ordered::object ()).is_null ());
    EXPECT_EQ (auth_of ({ { "mode", "none" } }).dump (), R"({"type":"noauth"})");
    EXPECT_EQ (auth_of ({ { "mode", "noauth" } }).dump (), R"({"type":"noauth"})");
    EXPECT_EQ (auth_of ({ { "mode", "bearer" }, { "token", "t" } }).dump (),
    R"({"type":"bearer","bearer":[{"key":"token","value":"t","type":"string"}]})");
    EXPECT_EQ (
    auth_of ({ { "mode", "basic" }, { "username", "u" }, { "password", "p" } }).dump (),
    R"({"type":"basic","basic":[{"key":"username","value":"u","type":"string"},{"key":"password","value":"p","type":"string"}]})");
    EXPECT_EQ (auth_of ({ { "mode", "apikey" }, { "key", "X-Key" },
                        { "value", "v" }, { "in", "header" } })
               .dump (),
    R"({"type":"apikey","apikey":[{"key":"value","value":"v","type":"string"},{"key":"key","value":"X-Key","type":"string"}]})");
    EXPECT_EQ (auth_of ({ { "mode", "apikey" }, { "key", "k" },
               { "value", "v" }, { "in", "query" } })["apikey"][2]
               .dump (),
    R"({"key":"in","value":"query","type":"string"})");
}

TEST (PostmanExport, CollectionAuthNoneIsAbsentAndNoauthEndsInheritance) {
    PostmanExportFolder root = collection ();
    root.auth                = ordered{ { "mode", "none" } };
    EXPECT_FALSE (document (root).contains ("auth"));
    root.auth = ordered{ { "mode", "noauth" } };
    EXPECT_EQ (document (root)["auth"].dump (), R"({"type":"noauth"})");
}

TEST (PostmanExport, ConfigAuthTypesInPostmansAttributeOrder) {
    // An import stores these configs key-sorted; Postman's own order is
    // restored, and a boolean Postman declares comes back a boolean.
    ordered aws = auth_of ({ { "mode", "aws" },
    { "config",
    { { "accessKey", "A" }, { "addAuthDataToQuery", "false" }, { "region", "r" },
    { "secretKey", "S" }, { "service", "s3" }, { "extra", "x" } } } });
    EXPECT_EQ (aws.dump (),
    R"({"type":"awsv4","awsv4":[{"key":"service","value":"s3","type":"string"},{"key":"region","value":"r","type":"string"},{"key":"secretKey","value":"S","type":"string"},{"key":"accessKey","value":"A","type":"string"},{"key":"addAuthDataToQuery","value":false,"type":"boolean"},{"key":"extra","value":"x","type":"string"}]})");
    ordered digest = auth_of ({ { "mode", "digest" },
    { "config", { { "password", "p" }, { "username", "u" }, { "realm", "r" } } } });
    EXPECT_EQ (digest["digest"][0]["key"], "username");
    EXPECT_EQ (digest["digest"][1]["key"], "realm");
    EXPECT_EQ (digest["digest"][2]["key"], "password");
    ordered ntlm = auth_of ({ { "mode", "ntlm" },
    { "config", { { "domain", "D" }, { "password", "p" }, { "username", "u" } } } });
    EXPECT_EQ (ntlm["type"], "ntlm");
    EXPECT_EQ (ntlm["ntlm"][0]["key"], "password");
    EXPECT_EQ (ntlm["ntlm"][2]["key"], "domain");
}

TEST (PostmanExport, UnknownAuthModeIsANote) {
    PostmanExportRequest entry = request ("r", "u");
    entry.auth                 = ordered{ { "mode", "kerberos" } };
    PostmanExportFolder root   = collection ();
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_FALSE (ordered::parse (outcome.text)["item"][0]["request"].contains ("auth"));
    EXPECT_EQ (losses (outcome), (json{ { "unsupported_auth", 1 } }));
}

TEST (PostmanExport, DataOnlyAuthTypesAreTheirPostmanType) {
    PostmanExportRequest entry = request ("r", "u");
    entry.auth                 = ordered{ { "mode", "hawk" },
                        { "config", { { "authId", "id" }, { "includePayloadHash", "true" } } } };
    EXPECT_EQ (only_item (entry)["request"]["auth"].dump (),
    R"({"type":"hawk","hawk":[{"key":"authId","value":"id","type":"string"},{"key":"includePayloadHash","value":true,"type":"boolean"}]})");
}

ordered oauth2 (const ordered& config) {
    return ordered{ { "mode", "oauth2" }, { "config", config } };
}

/// An `oauth2` attribute array as `{key: value}`.
json attributes (const ordered& auth) {
    json out = json::object ();
    for (const ordered& entry : auth.at ("oauth2")) {
        out[entry.at ("key").get<std::string> ()] = entry.at ("value");
    }
    return out;
}

TEST (PostmanExport, OAuth2GrantsAndSettings) {
    ordered pkce = auth_of (oauth2 ({ { "grantType", "authorization_code" },
    { "pkce", true }, { "authorizationUrl", "https://a/authorize" },
    { "accessTokenUrl", "https://a/token" }, { "clientId", "id" },
    { "clientSecret", "s" }, { "callbackUrl", "https://cb" }, { "scope", "read" },
    { "credentialsPlacement", "body" }, { "tokenPlacement", "query" }, { "headerPrefix", "Token" },
    { "credentialsId", "ada" }, { "useEmbeddedBrowser", true } }));
    EXPECT_EQ (attributes (pkce),
    (json{ { "accessTokenUrl", "https://a/token" }, { "scope", "read" },
    { "grant_type", "authorization_code_with_pkce" },
    { "authUrl", "https://a/authorize" }, { "tokenName", "ada" }, { "useBrowser", false },
    { "challengeAlgorithm", "S256" }, { "redirect_uri", "https://cb" },
    { "clientSecret", "s" }, { "clientId", "id" }, { "headerPrefix", "Token" },
    { "addTokenTo", "queryParams" }, { "client_authentication", "body" } }));
    EXPECT_EQ (pkce["oauth2"][0]["key"], "accessTokenUrl");
    EXPECT_EQ (pkce["oauth2"].back ()["key"], "client_authentication");

    const auto grant = [] (const ordered& config) {
        return attributes (auth_of (oauth2 (config))).at ("grant_type");
    };
    EXPECT_EQ (grant ({ { "grantType", "authorization_code" }, { "pkce", false } }),
    "authorization_code");
    EXPECT_EQ (grant ({ { "grantType", "client_credentials" }, { "pkce", true } }),
    "client_credentials");
    EXPECT_EQ (grant ({ { "grantType", "password" } }), "password_credentials");

    ordered cc = auth_of (oauth2 ({ { "grantType", "password" },
    { "username", "u" }, { "password", "p" }, { "headerPrefix", "Bearer" } }));
    EXPECT_FALSE (attributes (cc).contains ("useBrowser"));
    EXPECT_FALSE (attributes (cc).contains ("headerPrefix"));
    EXPECT_EQ (attributes (cc).at ("addTokenTo"), "header");
    EXPECT_EQ (attributes (cc).at ("client_authentication"), "header");
}

TEST (PostmanExport, OAuth2SettingsPostmanCannotStateAreANote) {
    for (const ordered& extra :
    { ordered{ { "audience", "a" } }, ordered{ { "resource", "r" } },
    ordered{ { "autoFetchToken", false } }, ordered{ { "autoRefreshToken", false } },
    ordered{ { "queryParamName", "token" } }, ordered{ { "headerPrefix", "" } } }) {
        ordered config = { { "grantType", "client_credentials" } };
        config.update (extra);
        PostmanExportRequest entry = request ("r", "u");
        entry.auth                 = oauth2 (config);
        PostmanExportFolder root   = collection ();
        root.requests.push_back (entry);
        EXPECT_EQ (losses (run (root)), (json{ { "oauth2_settings", 1 } }))
        << extra.dump ();
    }
    PostmanExportRequest plain = request ("r", "u");
    plain.auth               = oauth2 ({ { "grantType", "client_credentials" },
                  { "queryParamName", "access_token" }, { "autoFetchToken", true } });
    PostmanExportFolder root = collection ();
    root.requests.push_back (plain);
    EXPECT_TRUE (run (root).notes.not_carried.empty ());
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

TEST (PostmanExport, AnImportedAuthBlockIsWrittenBackWhileItStillDescribesTheAuth) {
    // What the importer stores for an `oauth2` block holding only a seeded
    // token: the bearer token Postman sends, with the block as its source.
    const ordered source = ordered::parse (R"({"type":"oauth2","oauth2":[
        {"key":"accessToken","value":"tok-1","type":"string"},
        {"key":"addTokenTo","value":"header","type":"string"},
        {"key":"tokenType","value":"Bearer","type":"string"}]})");
    PostmanExportRequest entry = request ("r", "u");
    entry.auth =
    ordered{ { "mode", "bearer" }, { "token", "tok-1" }, { "postman", source } };
    EXPECT_EQ (only_item (entry)["request"]["auth"], source);

    // Without credentials the block is blanked the way any auth is.
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    const auto blanked = run (root, /*secrets=*/false);
    EXPECT_EQ (blanked.notes.secrets_omitted, 1);
    ordered written =
    ordered::parse (blanked.text)["item"][0]["request"]["auth"];
    EXPECT_EQ (written["oauth2"][0]["value"], "");
    EXPECT_EQ (written["oauth2"][2]["value"], "Bearer");

    // Edited in Vayu since: the block no longer describes the auth, so what
    // Vayu holds is written instead.
    entry.auth["token"] = "tok-2";
    EXPECT_EQ (only_item (entry)["request"]["auth"].dump (),
    R"({"type":"bearer","bearer":[{"key":"token","value":"tok-2","type":"string"}]})");
}

TEST (PostmanExport, SecretsAreBlankedAndCountedUnlessAskedFor) {
    PostmanExportFolder root = collection ();
    root.auth = ordered{ { "mode", "bearer" }, { "token", "{{token}}" } };
    root.variables =
    ordered{ { "apiKey", { { "value", "k" }, { "enabled", true }, { "secret", true } } },
        { "ref", { { "value", "{{other}}" }, { "enabled", true }, { "secret", true } } },
        { "plain", { { "value", "v" }, { "enabled", true } } } };
    PostmanExportRequest basic = request ("basic", "u");
    basic.auth =
    ordered{ { "mode", "basic" }, { "username", "ada" }, { "password", "pw" } };
    PostmanExportRequest key = request ("key", "u");
    key.auth = ordered{ { "mode", "apikey" }, { "key", "X" }, { "value", "v" },
        { "in", "header" } };
    PostmanExportRequest oauth = request ("oauth", "u");
    oauth.auth                 = oauth2 ({ { "grantType", "password" },
                    { "clientSecret", "cs" }, { "password", "pw" }, { "clientId", "id" } });
    PostmanExportRequest aws   = request ("aws", "u");
    aws.auth                   = ordered{ { "mode", "aws" },
                          { "config", { { "accessKey", "A" }, { "secretKey", "S" }, { "region", "r" } } } };
    // An imported OAuth 2.0 block kept as the auth's source: its PKCE
    // verifier and the credentials in its extra request parameters are
    // nested where a top-level walk does not look.
    const ordered source = ordered::parse (R"({"type":"oauth2","oauth2":[
        {"key":"code_verifier","value":"verifier-1","type":"string"},
        {"key":"tokenRequestParams","value":[
            {"key":"client_secret","value":"param-secret","enabled":true,"send_as":"request_body"},
            {"key":"client_assertion","value":"{{assertion}}","enabled":true,"send_as":"request_body"},
            {"key":"audience","value":"api","enabled":true,"send_as":"request_body"}],"type":"any"},
        {"key":"refreshRequestParams","value":[
            {"key":"refresh_token","value":"rt-1","enabled":true,"send_as":"request_body"}],"type":"any"},
        {"key":"grant_type","value":"authorization_code_with_pkce","type":"string"}]})");
    PostmanExportRequest nested = request ("nested", "u");
    nested.auth                 = vayu::core::postman_auth_mapping (source);
    nested.auth["postman"]      = source;
    root.requests               = { basic, key, oauth, aws, nested };

    const auto blanked = run (root, /*secrets=*/false);
    EXPECT_EQ (blanked.notes.secrets_omitted, 10);
    for (const char* secret : { "verifier-1", "param-secret", "rt-1" }) {
        EXPECT_EQ (blanked.text.find (secret), std::string::npos) << secret;
    }
    ordered doc = ordered::parse (blanked.text);
    // A whole-value `{{variable}}` reference names a secret without being one.
    EXPECT_EQ (doc["auth"]["bearer"][0]["value"], "{{token}}");
    EXPECT_EQ (doc["variable"].dump (),
    R"([{"key":"apiKey","value":"","type":"secret"},{"key":"ref","value":"{{other}}","type":"secret"},{"key":"plain","value":"v"}])");
    EXPECT_EQ (doc["item"][0]["request"]["auth"]["basic"][0]["value"], "ada");
    EXPECT_EQ (doc["item"][0]["request"]["auth"]["basic"][1]["value"], "");
    EXPECT_EQ (doc["item"][1]["request"]["auth"]["apikey"][0]["value"], "");
    EXPECT_EQ (attributes (doc["item"][2]["request"]["auth"]),
    (json{ { "clientSecret", "" }, { "clientId", "id" }, { "password", "" },
    { "grant_type", "password_credentials" }, { "addTokenTo", "header" },
    { "client_authentication", "header" } }));
    EXPECT_EQ (doc["item"][3]["request"]["auth"]["awsv4"][0]["key"], "region");
    EXPECT_EQ (doc["item"][3]["request"]["auth"]["awsv4"][1]["value"], "");
    EXPECT_EQ (doc["item"][3]["request"]["auth"]["awsv4"][2]["value"], "");
    const ordered params =
    doc["item"][4]["request"]["auth"]["oauth2"][1]["value"];
    EXPECT_EQ (params[1]["value"], "{{assertion}}")
    << "a reference is not a secret";
    EXPECT_EQ (params[2]["value"], "api");

    const auto kept = run (root, /*secrets=*/true);
    EXPECT_EQ (kept.notes.secrets_omitted, 0);
    ordered clear = ordered::parse (kept.text);
    EXPECT_EQ (clear["variable"][0]["value"], "k");
    EXPECT_EQ (clear["item"][0]["request"]["auth"]["basic"][1]["value"], "pw");
    EXPECT_NE (kept.text.find ("param-secret"), std::string::npos);
}

// ---------------------------------------------------------------------------
// Scripts and elements
// ---------------------------------------------------------------------------

TEST (PostmanExport, ScriptsAreEventsInPostmansShapePerLevel) {
    PostmanExportFolder root = collection ();
    root.elements =
    ordered::array ({ element ("script.pre", { { "script", "one()\ntwo()" } }) });
    PostmanExportRequest entry = request ("r", "u");
    entry.elements =
    ordered::array ({ element ("script.post", { { "script", "a()\n\nb()" } }),
    element ("script.pre", { { "script", "p()" } }) });
    root.requests.push_back (entry);
    ordered doc = document (root);
    EXPECT_EQ (doc["event"].dump (),
    R"j([{"listen":"prerequest","script":{"type":"text/javascript","packages":{},"requests":{},"exec":["one()","two()"]}}])j");
    // A request's script lists `exec` first; events keep element order, so a
    // test listed before its prerequest stays there.
    EXPECT_EQ (doc["item"][0]["event"].dump (),
    R"j([{"listen":"test","script":{"exec":["a()","","b()"],"type":"text/javascript","packages":{},"requests":{}}},{"listen":"prerequest","script":{"exec":["p()"],"type":"text/javascript","packages":{},"requests":{}}}])j");
}

TEST (PostmanExport, ElementsPostmanCannotHoldAreNotes) {
    PostmanExportRequest entry = request ("r", "u");
    ordered off    = element ("script.pre", { { "script", "off()" } });
    off["enabled"] = false;
    ordered named  = element ("script.post", { { "script", "n()" } });
    named["name"]  = "Check";
    entry.elements = ordered::array ({ element ("script.pre", { { "script", "a()" } }),
    element ("script.pre", { { "script", "b()" } }), off, named,
    element ("script.post", { { "script", "i()" }, { "inline", true } }),
    element ("script.post", { { "script", "  " } }),
    element ("assert.status", { { "equals", 200 } }),
    element ("timer.think", { { "ms", 5 } }) });
    PostmanExportFolder root = collection ();
    root.elements = ordered::array ({ element ("script.setup", { { "script", "" } }),
    element ("script.teardown", { { "script", "t()" } }) });
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_EQ (losses (outcome),
    (json{ { "vayu_elements", 3 }, { "script_settings", 2 } }));
    // One event per script element, none joined; a turned-off one is written
    // disabled, which Postman's runtime skips as Vayu does.
    ordered events = ordered::parse (outcome.text)["item"][0]["event"];
    ASSERT_EQ (events.size (), 5U);
    EXPECT_EQ (events[0]["script"]["exec"].dump (), R"j(["a()"])j");
    EXPECT_EQ (events[1]["script"]["exec"].dump (), R"j(["b()"])j");
    EXPECT_EQ (events[2]["listen"], "prerequest");
    EXPECT_EQ (events[2]["disabled"], true);
    EXPECT_FALSE (events[3].contains ("disabled"));
    EXPECT_EQ (events[4]["script"]["exec"].dump (), R"j(["i()"])j");
    // Codes arrive in their fixed order, each with its sentence.
    ASSERT_EQ (outcome.notes.not_carried.size (), 2U);
    EXPECT_EQ (outcome.notes.not_carried[0].code, "vayu_elements");
    EXPECT_FALSE (outcome.notes.not_carried[0].message.empty ());
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

TEST (PostmanExport, VariablesKeepTheirStateAndPostmanTypes) {
    PostmanExportFolder root = collection ();
    root.variables = ordered{ { "a", { { "value", "1" }, { "enabled", false } } },
        { "n", { { "value", "5" }, { "enabled", true }, { "type", "number" } } },
        { "j", { { "value", "{}" }, { "enabled", true }, { "type", "json" } } },
        { "s", { { "value", "x" }, { "enabled", true }, { "type", "string" } } },
        { "d", { { "value", "y" }, { "enabled", true }, { "description", "Why" } } } };
    const auto outcome = run (root);
    EXPECT_EQ (ordered::parse (outcome.text)["variable"].dump (),
    R"([{"key":"a","value":"1","disabled":true},{"key":"n","value":"5","type":"number"},{"key":"j","value":"{}"},{"key":"s","value":"x","type":"string"},{"key":"d","value":"y","description":"Why"}])");
    EXPECT_EQ (losses (outcome), (json{ { "variable_types", 1 } }));
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

TEST (PostmanExport, ExamplesAreResponsesWithTheirOriginalRequest) {
    PostmanExportRequest entry = request ("r", "{{baseUrl}}/pets?limit=1");
    entry.params               = ordered::array ({ row ("limit", "1") });
    entry.headers = ordered::array ({ row ("Accept", "application/json") });
    entry.examples.push_back ({ "One pet", 200,
    ordered::array ({ row ("Content-Type", "application/json; charset=utf-8"),
    row ("X-Off", "1", false) }),
    "[]", "application/json; charset=utf-8", false });
    entry.examples.push_back ({ "Gone", 410, ordered::array (), "", "", false });
    ordered item   = only_item (entry);
    ordered& first = item["response"][0];
    EXPECT_EQ (keys_of (first),
    (Keys{ "name", "originalRequest", "status", "code",
    "_postman_previewlanguage", "header", "cookie", "body" }));
    EXPECT_EQ (first["originalRequest"],
    (ordered{ { "method", "GET" }, { "header", item["request"]["header"] },
    { "url", item["request"]["url"] } }));
    EXPECT_EQ (first["status"], "OK");
    EXPECT_EQ (first["code"], 200);
    EXPECT_EQ (first["_postman_previewlanguage"], "json");
    EXPECT_EQ (first["header"].dump (),
    R"([{"key":"Content-Type","value":"application/json; charset=utf-8"},{"key":"X-Off","value":"1","disabled":true}])");
    EXPECT_EQ (first["cookie"], ordered::array ());
    EXPECT_EQ (first["body"], "[]");
    EXPECT_EQ (item["response"][1]["status"], "Gone");
    EXPECT_EQ (item["response"][1]["_postman_previewlanguage"], "Text");
}

/// A saved response as `request_examples.postman_response` holds it.
ordered recorded_response () {
    return ordered::parse (R"({
        "name": null,
        "originalRequest": {
            "method": "GET",
            "header": [],
            "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "tok-live", "type": "string"}]},
            "url": {"raw": "https://api.example.com/tweets?ids=20", "host": ["api", "example", "com"]}
        },
        "status": "Unprocessable Entity",
        "code": 422,
        "_postman_previewlanguage": "plain",
        "_postman_previewtype": "text",
        "header": [
            {"key": "Content-Type", "value": "text/plain", "name": "Content-Type"},
            {"key": "X-Left", "value": 450, "name": "X-Left", "description": ""}
        ],
        "cookie": [{"key": "sid", "value": "abc"}],
        "responseTime": "493",
        "body": null
    })");
}

/// The example the importer stores from @p recorded.
PostmanExportExample recorded_example (const ordered& recorded) {
    return { "Invalid", 422,
        ordered::array ({ row ("Content-Type", "text/plain"), row ("X-Left", "450") }),
        "nope", "text/plain", false, recorded };
}

// Every member of a stored saved response comes back in its own order, with
// the columns' values in the `name` / `body` / `code` positions. Mutation
// check: return the regenerated response even when `postman_response` is
// set, and every verbatim assertion reds.
TEST (PostmanExport, AStoredSavedResponseIsWrittenBackAsRecorded) {
    PostmanExportRequest entry = request ("r", "{{baseUrl}}/tweets?ids=1");
    entry.params               = ordered::array ({ row ("ids", "1") });
    entry.examples.push_back (recorded_example (recorded_response ()));
    ordered response = only_item (entry)["response"][0];
    EXPECT_EQ (keys_of (response),
    (Keys{ "name", "originalRequest", "status", "code", "_postman_previewlanguage",
    "_postman_previewtype", "header", "cookie", "responseTime", "body" }));
    EXPECT_EQ (response["name"], "Invalid");
    EXPECT_EQ (response["originalRequest"], recorded_response ()["originalRequest"]);
    EXPECT_EQ (response["status"], "Unprocessable Entity");
    EXPECT_EQ (response["code"], 422);
    EXPECT_EQ (response["_postman_previewlanguage"], "plain");
    EXPECT_EQ (response["_postman_previewtype"], "text");
    EXPECT_EQ (response["header"], recorded_response ()["header"]);
    EXPECT_EQ (response["header"][1]["value"], 450);
    EXPECT_EQ (response["cookie"], recorded_response ()["cookie"]);
    EXPECT_EQ (response["responseTime"], "493");
    EXPECT_EQ (response["body"], "nope");
}

// The status text belongs to the code it was recorded with. Mutation check:
// drop the `status_same` condition and this reds.
TEST (PostmanExport, AnEditedStatusRegeneratesTheStatusText) {
    PostmanExportRequest entry   = request ("r", "u");
    PostmanExportExample example = recorded_example (recorded_response ());
    example.status               = 201;
    entry.examples.push_back (example);
    ordered response = only_item (entry)["response"][0];
    EXPECT_EQ (response["status"], "Created");
    EXPECT_EQ (response["code"], 201);
}

// Edited header rows are written from the column; the preview members follow
// the declared Content-Type. Mutation check: drop the `rows_same` or
// `type_same` condition and the matching assertion reds.
TEST (PostmanExport, EditedHeadersRegenerateTheHeaderRowsAndPreview) {
    PostmanExportRequest entry   = request ("r", "u");
    PostmanExportExample example = recorded_example (recorded_response ());
    example.headers = ordered::array ({ row ("Content-Type", "application/json") });
    entry.examples.push_back (example);
    ordered response = only_item (entry)["response"][0];
    EXPECT_EQ (response["header"].dump (),
    R"([{"key":"Content-Type","value":"application/json"}])");
    EXPECT_EQ (response["_postman_previewlanguage"], "json");
    EXPECT_FALSE (response.contains ("_postman_previewtype"));
    EXPECT_EQ (response["status"], "Unprocessable Entity")
    << "the status was not edited";

    // A header edit that keeps the Content-Type keeps the preview members.
    PostmanExportRequest same_type = request ("r", "u");
    PostmanExportExample renamed   = recorded_example (recorded_response ());
    renamed.headers = ordered::array ({ row ("Content-Type", "text/plain") });
    same_type.examples.push_back (renamed);
    ordered kept = only_item (same_type)["response"][0];
    EXPECT_EQ (kept["header"].dump (), R"([{"key":"Content-Type","value":"text/plain"}])");
    EXPECT_EQ (kept["_postman_previewlanguage"], "plain");
    EXPECT_EQ (kept["_postman_previewtype"], "text");
}

// A member the source never wrote stays out while the column holds the
// importer's default for it, and is written once an edit gives it a value.
TEST (PostmanExport, AMemberTheSourceLeftOutStaysOutUntilEdited) {
    ordered recorded = ordered::parse (R"({"name": null, "originalRequest": {"method": "GET"},
        "_postman_previewlanguage": "json", "header": [], "cookie": [], "body": null})");
    PostmanExportRequest entry = request ("r", "u");
    entry.examples.push_back ({ "Old", 200, ordered::array (), "{}", "", false, recorded });
    ordered untouched = only_item (entry)["response"][0];
    EXPECT_EQ (keys_of (untouched),
    (Keys{ "name", "originalRequest", "_postman_previewlanguage", "header", "cookie", "body" }));

    entry.examples.at (0).status = 404;
    const ordered edited         = only_item (entry)["response"][0];
    EXPECT_EQ (edited["status"], "Not Found");
    EXPECT_EQ (edited["code"], 404);
}

// The recorded request's credentials are blanked like every other one.
// Mutation check: skip `redact_postman_auth` and the token survives.
TEST (PostmanExport, ARecordedRequestsCredentialsAreBlankedUnlessAskedFor) {
    PostmanExportRequest entry = request ("r", "u");
    entry.examples.push_back (recorded_example (recorded_response ()));
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    const auto blanked = run (root, /*secrets=*/false);
    EXPECT_EQ (blanked.notes.secrets_omitted, 1);
    EXPECT_EQ (blanked.text.find ("tok-live"), std::string::npos);
    const auto kept = run (root, /*secrets=*/true);
    EXPECT_NE (kept.text.find ("tok-live"), std::string::npos);
}

// A v2.0 file's recorded request states its auth as an object, which the
// v2.1 schema the export declares refuses. Mutation check: write the stored
// auth unconverted and this reds.
TEST (PostmanExport, ARecordedV20AuthIsWrittenInV21Shape) {
    ordered recorded                    = recorded_response ();
    recorded["originalRequest"]["auth"] = ordered::parse (
    R"({"type": "basic", "basic": {"username": "u", "password": "p", "showPassword": false}})");
    PostmanExportRequest entry = request ("r", "u");
    entry.examples.push_back (recorded_example (recorded));
    ordered response = only_item (entry)["response"][0];
    EXPECT_EQ (response["originalRequest"]["auth"].dump (),
    R"({"type":"basic","basic":[{"key":"username","value":"u","type":"string"},)"
    R"({"key":"password","value":"p","type":"string"},)"
    R"({"key":"showPassword","value":false,"type":"boolean"}]})");
}

TEST (PostmanExport, ExampleFactsPostmanCannotHoldAreNotes) {
    PostmanExportRequest entry = request ("r", "u");
    entry.examples.push_back ({ "cut", 200, ordered::array (), "par", "", true });
    entry.examples.push_back (
    { "typed", 200, ordered::array (), "{}", "application/json", false });
    PostmanExportFolder root = collection ();
    root.requests.push_back (entry);
    EXPECT_EQ (losses (run (root)),
    (json{ { "truncated_examples", 1 }, { "example_content_types", 1 } }));
}

// ---------------------------------------------------------------------------
// Vayu-only request and collection facts
// ---------------------------------------------------------------------------

TEST (PostmanExport, VayuOnlySettingsAreNotes) {
    PostmanExportRequest entry = request ("r", "u");
    entry.http_version         = "http2";
    entry.stream               = true;
    entry.mock_response_mode   = "random";
    entry.has_spec_operation   = true;
    PostmanExportFolder root   = collection ();
    root.data_schema = ordered{ { "columns", ordered::array ({ "id" }) } };
    root.spec_bound  = true;
    PostmanExportFolder folder = collection ("f");
    folder.data_schema         = ordered{ { "columns", ordered::array () } };
    root.folders.push_back (folder);
    root.requests.push_back (entry);
    const auto outcome = run (root);
    EXPECT_EQ (losses (outcome),
    (json{ { "http_version", 1 }, { "event_stream", 1 }, { "mock_response_mode", 1 },
    { "spec_operations", 1 }, { "data_contracts", 2 }, { "spec_bindings", 1 } }));
    json notes = vayu::core::postman_export_notes_json (outcome.notes);
    EXPECT_EQ (notes["requestsExported"], 1);
    EXPECT_EQ (notes["foldersExported"], 1);
    EXPECT_EQ (notes["secretsOmitted"], 0);
    EXPECT_EQ (notes["notCarried"][0]["code"], "http_version");
    EXPECT_TRUE (notes["notCarried"][0]["message"].is_string ());
}

TEST (PostmanExport, DefaultsAreNotNotes) {
    PostmanExportFolder root = collection ();
    root.requests.push_back (request ("r", "u"));
    root.data_schema = ordered::object ();
    EXPECT_TRUE (run (root).notes.not_carried.empty ());
}

} // namespace
