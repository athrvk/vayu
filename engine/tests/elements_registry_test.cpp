/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/elements_registry_test.cpp
 * @brief The element registry, its wire validation, `GET /elements/kinds`,
 *        the round-trip through the two write routes, and the startup
 *        script-to-elements fold (issue #1513).
 *
 * `test.echo` is registered here, in the test binary only, as the
 * extensibility contract's own proof: a kind registered in one file must
 * appear in the catalogue, validate, and round-trip through storage with
 * nothing else in the engine touched for it.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;
using vayu::core::Element;
using vayu::core::ElementKind;
using vayu::core::HotPathClass;
using vayu::core::Phase;
using vayu::core::Registry;

namespace vayu::http::routes {
// Defined in requests.cpp / collections.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::create_collection_response;
using vayu::http::routes::create_request_response;
using vayu::http::routes::list_requests_body;
using vayu::http::routes::update_request_response;

/**
 * Test-only kind, registered once for the whole binary: proves the
 * extensibility contract (issue #1512, rule 5) rather than any one kind's
 * behaviour. Never runs (no `compile`) - phase 0 executes nothing.
 */
ElementKind make_test_echo_kind () {
    ElementKind kind;
    kind.kind          = "test.echo";
    kind.version       = 1;
    kind.phases        = { Phase::StepAfter };
    kind.label         = "Test echo";
    kind.description   = "Registered by the test binary only, to prove a kind "
                         "in one file needs nothing else touched.";
    kind.category      = "test";
    kind.hot_path      = HotPathClass::Declarative;
    kind.config_schema = { { "type", "object" },
        { "properties", { { "message", { { "type", "string" } } } } },
        { "required", nlohmann::json::array ({ "message" }) },
        { "additionalProperties", false } };
    return kind;
}

class ElementsRegistryTest : public ::testing::Test {
    protected:
    static void SetUpTestSuite () {
        Registry::instance ().register_kind_for_test (make_test_echo_kind ());
    }
};

TEST_F (ElementsRegistryTest, TheCatalogueListsInheritDisableAndTheTestOnlyKind) {
    const json catalogue = vayu::core::elements_catalogue ();
    ASSERT_TRUE (catalogue.is_array ());

    bool saw_inherit_disable = false;
    bool saw_test_echo       = false;
    for (const auto& kind : catalogue) {
        if (kind["kind"] == "inherit.disable") {
            saw_inherit_disable = true;
            EXPECT_TRUE (kind.contains ("configSchema"));
            EXPECT_TRUE (kind.contains ("phases"));
        }
        if (kind["kind"] == "test.echo") {
            saw_test_echo = true;
            EXPECT_EQ (kind["category"], "test");
        }
    }
    EXPECT_TRUE (saw_inherit_disable);
    EXPECT_TRUE (saw_test_echo);
}

TEST_F (ElementsRegistryTest, AnUnknownKindNamesItselfAndTheKnownList) {
    const json elements = json::array (
    { json{ { "id", "el_1" }, { "kind", "assert.sttus" }, { "enabled", true } } });
    auto reason = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("elements[0]"), std::string::npos);
    EXPECT_NE (reason->find ("assert.sttus"), std::string::npos);
    EXPECT_NE (reason->find ("not a known element kind"), std::string::npos);
}

TEST_F (ElementsRegistryTest, ABadConfigFieldNamesTheElementAndTheKind) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "test.echo" }, { "enabled", true }, { "config", json::object () } } });
    auto reason         = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason)
    << "config is missing the required 'message' field";
    EXPECT_NE (reason->find ("elements[0]"), std::string::npos);
    EXPECT_NE (reason->find ("test.echo"), std::string::npos);
}

TEST_F (ElementsRegistryTest, ADuplicateIdIsRejected) {
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "inherit.disable" },
                   { "config", { { "elementId", "el_x" } } } },
    json{ { "id", "el_1" }, { "kind", "inherit.disable" },
    { "config", { { "elementId", "el_y" } } } } });
    auto reason = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("duplicate id 'el_1'"), std::string::npos);
}

TEST_F (ElementsRegistryTest, AWellFormedListValidatesCleanly) {
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "test.echo" },
                   { "enabled", true }, { "config", { { "message", "hi" } } } },
    json{ { "id", "el_2" }, { "kind", "inherit.disable" },
    { "config", { { "elementId", "el_9" } } } } });
    EXPECT_FALSE (Registry::instance ().validate (elements).has_value ());
}

class ElementsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_elements_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::string make_collection () {
        auto [status, body] = create_collection_response (*db_, json{ { "name", "C" } });
        EXPECT_EQ (status, 200);
        return body["id"].get<std::string> ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ElementsRouteTest, PutWithAValidListStoresAndListsItThroughBothSerializers) {
    const std::string collection = make_collection ();
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "inherit.disable" },
    { "enabled", true }, { "config", { { "elementId", "el_ancestor" } } } } });

    auto [created_status, created] = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.test" }, { "elements", elements } });
    ASSERT_EQ (created_status, 200);
    EXPECT_EQ (created["elements"], elements);

    const std::string id = created["id"].get<std::string> ();
    const json listed    = json::parse (list_requests_body (*db_, collection));
    ASSERT_EQ (listed.size (), 1u);
    EXPECT_EQ (listed[0]["elements"], elements)
    << "the list serializer disagreed with the single-request one on elements";

    auto [updated_status, updated] =
    update_request_response (*db_, id, json{ { "elements", nullptr } });
    ASSERT_EQ (updated_status, 200);
    EXPECT_EQ (updated["elements"], json::array ());
}

TEST_F (ElementsRouteTest, PutWithAnUnknownKindReturns400NamingIt) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.test" },
             { "elements", json::array ({ json{ { "id", "el_1" }, { "kind", "not.a.kind" } } }) } });
    ASSERT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("not.a.kind"),
    std::string::npos);
}

TEST_F (ElementsRouteTest, LegacyScriptFieldsStillSaveBesideElements) {
    // #1513 lands `elements` additively: the app's two script tabs (#1516's
    // job to replace) still edit `preRequestScript` / `postRequestScript`
    // directly, and that must keep working exactly as before.
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.test" }, { "preRequestScript", "pm.test('ok', () => {});" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["preRequestScript"], "pm.test('ok', () => {});");
    EXPECT_EQ (body["elements"], json::array ());
}

class ScriptsFoldedIntoElementsTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scripts_fold.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    // `SetUp` already ran the fold on an empty database, which marks it done
    // (issue #1487's precedent) - a test adding 0.26-shaped data afterwards
    // must clear the marker first, or the pass skips it outright.
    void reset_fold_marker () {
        db_->save_config_entry (vayu::db::ConfigEntry{
        .key              = "scriptsFoldedIntoElements",
        .value            = "false",
        .type             = "boolean",
        .label            = "Scripts folded into elements",
        .description      = "",
        .category         = "general_engine",
        .default_value    = "false",
        .min_value        = std::nullopt,
        .max_value        = std::nullopt,
        .options          = std::nullopt,
        .updated_at       = 0,
        .requires_restart = false,
        .advanced         = true,
        .keywords         = "[]",
        .unit             = std::nullopt,
        });
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ScriptsFoldedIntoElementsTest, AScriptedRowGainsElementsAndKeepsItsScriptFields) {
    vayu::db::Collection col;
    col.id   = "col_1";
    col.name = "C";
    db_->create_collection (col);

    vayu::db::Request scripted;
    scripted.id                  = "req_scripted";
    scripted.collection_id       = "col_1";
    scripted.name                = "Scripted";
    scripted.url                 = "https://example.test/";
    scripted.pre_request_script  = "pm.environment.set('x', 1);";
    scripted.post_request_script = "pm.test('ok', () => {});";
    db_->save_request (scripted);

    vayu::db::Request plain;
    plain.id            = "req_plain";
    plain.collection_id = "col_1";
    plain.name          = "Plain";
    plain.url           = "https://example.test/plain";
    db_->save_request (plain);

    reset_fold_marker ();
    EXPECT_EQ (db_->fold_scripts_into_elements (), 1);

    auto folded = db_->get_request ("req_scripted");
    ASSERT_HAS_VALUE (folded);
    // Scripts are untouched - #1514's pipeline still runs them from here.
    EXPECT_EQ (folded->pre_request_script, "pm.environment.set('x', 1);");
    EXPECT_EQ (folded->post_request_script, "pm.test('ok', () => {});");
    const auto elements = json::parse (folded->elements);
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0]["kind"], "script.pre");
    EXPECT_EQ (elements[0]["config"]["script"], "pm.environment.set('x', 1);");
    EXPECT_EQ (elements[1]["kind"], "script.post");
    EXPECT_EQ (elements[1]["config"]["script"], "pm.test('ok', () => {});");
    EXPECT_TRUE (Registry::instance ().find ("script.pre") == nullptr)
    << "phase 0 registers no script kind - only the migration's shape is under "
       "test";

    auto untouched = db_->get_request ("req_plain");
    ASSERT_HAS_VALUE (untouched);
    EXPECT_EQ (untouched->elements, "[]");

    // Idempotent: the second call must find nothing left to fold.
    EXPECT_EQ (db_->fold_scripts_into_elements (), 0);
}

TEST_F (ScriptsFoldedIntoElementsTest, ASecondStartupSkipsTheScanOnceMarkedDone) {
    vayu::db::Collection col;
    col.id   = "col_marker";
    col.name = "C";
    db_->create_collection (col);

    vayu::db::Request scripted;
    scripted.id                 = "req_marker";
    scripted.collection_id      = "col_marker";
    scripted.name               = "Scripted";
    scripted.url                = "https://example.test/";
    scripted.pre_request_script = "pm.environment.set('x', 1);";
    db_->save_request (scripted);

    reset_fold_marker ();
    EXPECT_EQ (db_->fold_scripts_into_elements (), 1);
    EXPECT_TRUE (db_->get_config_bool ("scriptsFoldedIntoElements", false));

    // Added after the marker was set: a real scan would find and fold it,
    // but the marker means the pass never looks.
    vayu::db::Request late;
    late.id                 = "req_late";
    late.collection_id      = "col_marker";
    late.name               = "Late";
    late.url                = "https://example.test/late";
    late.pre_request_script = "pm.environment.set('y', 2);";
    db_->save_request (late);

    EXPECT_EQ (db_->fold_scripts_into_elements (), 0)
    << "the marker should have skipped the scan outright";
    auto still_unfolded = db_->get_request ("req_late");
    ASSERT_HAS_VALUE (still_unfolded);
    EXPECT_EQ (still_unfolded->elements, "[]");
}

} // namespace
