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
    EXPECT_EQ (body["notes"]["requestsExported"], 18);
    EXPECT_EQ (body["notes"]["foldersExported"], 4);
    EXPECT_EQ (body["notes"]["notCarried"], json::array ());
    EXPECT_EQ (body["notes"]["secretsOmitted"], 0);
}

TEST_F (PostmanExportRouteTest, WithoutSecretsEveryCredentialIsBlankedAndCounted) {
    const std::string id =
    import_text (read_text (fixture_path ("postman-export-roundtrip.json")));
    json body = export_ok (id, /*secrets=*/false);
    // The secret variable, the Admin folder's basic password, and the digest,
    // API-key, OAuth 2.0 client secret, AWS key pair and NTLM credentials;
    // the two `{{variable}}` references (bearer, the GraphQL API key) stay.
    EXPECT_EQ (body["notes"]["secretsOmitted"], 8);
    const std::string text = body["text"].get<std::string> ();
    for (const char* secret :
    { "s3cr3t", "hunter2", "\"pw\"", "k-123", "\"shh\"", "SECRET", "AKIA" }) {
        EXPECT_EQ (text.find (secret), std::string::npos) << secret;
    }
    EXPECT_NE (text.find ("{{token}}"), std::string::npos);
    EXPECT_NE (text.find ("{{apiKey}}"), std::string::npos);
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
