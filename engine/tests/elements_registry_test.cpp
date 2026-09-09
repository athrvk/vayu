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

#include <filesystem>
#include <fstream>
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
        { "properties",
        { { "message",
        { { "type", "string" }, { "title", "Message" },
        { "description", "The text this test-only kind echoes back." } } } } },
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
    bool saw_script_pre      = false;
    bool saw_script_post     = false;
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
        if (kind["kind"] == "script.pre") {
            saw_script_pre = true;
        }
        if (kind["kind"] == "script.post") {
            saw_script_post = true;
        }
    }
    EXPECT_TRUE (saw_inherit_disable);
    EXPECT_TRUE (saw_test_echo);
    // Validate-only (issue #1513 registers no behaviour yet), so
    // `fold_scripts_into_elements`'s own output round-trips through
    // `Registry::validate` rather than being rejected by its own migration.
    EXPECT_TRUE (saw_script_pre);
    EXPECT_TRUE (saw_script_post);
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

/**
 * Recursively asserts every property in a JSON-Schema `properties` map
 * (issue #1607) carries a non-empty `title` and `description`, and that the
 * two vendor annotation keywords stay inside their closed sets -
 * `x-vayu-group` only ever `"advanced"`, `x-vayu-unit` only ever one of
 * `"ms"`, `"%"`, `"B"`. Descends into a nested object property's own
 * `properties` (`assert.status`'s `range`, `timer.think`'s `gaussian`,
 * `metric.record`'s `source` and its own nested `condition`), holding a
 * nested field to the same rule as a top-level one.
 */
void expect_every_property_annotated (const std::string& kind_name, const json& properties) {
    for (const auto& [name, schema] : properties.items ()) {
        EXPECT_FALSE (schema.value ("title", std::string{}).empty ())
        << kind_name << "." << name << " has no title";
        EXPECT_FALSE (schema.value ("description", std::string{}).empty ())
        << kind_name << "." << name << " has no description";
        if (schema.contains ("x-vayu-group")) {
            EXPECT_EQ (schema["x-vayu-group"], "advanced")
            << kind_name << "." << name << " has an unknown x-vayu-group";
        }
        if (schema.contains ("x-vayu-unit")) {
            const std::string unit = schema.value ("x-vayu-unit", std::string{});
            EXPECT_TRUE (unit == "ms" || unit == "%" || unit == "B")
            << kind_name << "." << name << " has an unknown x-vayu-unit '"
            << unit << "'";
        }
        if (schema.value ("type", std::string{}) == "object" && schema.contains ("properties")) {
            std::string nested_name = kind_name;
            nested_name += ".";
            nested_name += name;
            expect_every_property_annotated (nested_name, schema["properties"]);
        }
    }
}

TEST_F (ElementsRegistryTest, EveryPropertyOfEveryKindCarriesATitleAndDescription) {
    const json catalogue = vayu::core::elements_catalogue ();
    ASSERT_GT (catalogue.size (), 20u);
    for (const auto& kind : catalogue) {
        const std::string kind_name = kind.value ("kind", std::string{});
        if (!kind.contains ("configSchema") || !kind["configSchema"].contains ("properties")) {
            continue; // e.g. control.once, whose schema declares no properties at all.
        }
        expect_every_property_annotated (kind_name, kind["configSchema"]["properties"]);
    }
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

TEST_F (ElementsRouteTest, AnElementWithNoIdGetsOneAssignedRatherThanRefused) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.test" },
             { "elements",
             json::array ({ json{ { "kind", "inherit.disable" },
             { "config", { { "elementId", "el_ancestor" } } } } }) } });
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["elements"].size (), 1u);
    const auto id = body["elements"][0].value ("id", "");
    EXPECT_TRUE (id.rfind ("el_", 0) == 0)
    << "expected an 'el_'-prefixed id, got: " << id;
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

TEST_F (ElementsRouteTest, LegacyScriptFieldsAreRefused) {
    // Issue #1514's clean cut (the owner's decision on #1512): no
    // transitional read/write alias, so a caller still sending
    // `preRequestScript` / `postRequestScript` / `tests` is refused rather
    // than silently accepted or ignored.
    const std::string collection = make_collection ();
    for (const char* key : { "preRequestScript", "postRequestScript", "tests" }) {
        auto [status, body] = create_request_response (*db_,
        json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
        { "url", "https://example.test" }, { key, "pm.test('ok', () => {});" } });
        EXPECT_EQ (status, 400) << key;
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("elements"), std::string::npos)
        << key;
    }
}

TEST_F (ElementsRouteTest, NeitherSerializerEmitsTheRetiredScriptKeys) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
             json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
             { "url", "https://example.test" },
             { "elements",
             json::array ({ json{ { "kind", "script.pre" },
             { "config", { { "script", "pm.test('ok', () => {});" } } } } }) } });
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("preRequestScript"));
    EXPECT_FALSE (body.contains ("postRequestScript"));
    EXPECT_EQ (body["elements"][0]["kind"], "script.pre");

    const json listed = json::parse (list_requests_body (*db_, collection));
    ASSERT_EQ (listed.size (), 1u);
    EXPECT_FALSE (listed[0].contains ("preRequestScript"));
    EXPECT_FALSE (listed[0].contains ("postRequestScript"));
}

/**
 * Writes the registry's catalogue to `tests/fixtures/element-kinds.json` on
 * every run (issue #1513's scope item 4), so the app's and MCP's future
 * conformance tests (#1516, #1517) have it without a running engine - the
 * same role `variable-resolution-conformance.json` plays for composition.
 *
 * A global `Environment`'s `SetUp` runs before any test suite's, in
 * particular before `ElementsRegistryTest::SetUpTestSuite` registers
 * `test.echo` - deliberately, since the fixture is a claim about what a real
 * build serves, not what this test binary adds to prove the registration
 * path.
 */
class ElementKindsFixtureWriter : public ::testing::Environment {
    public:
    void SetUp () override {
        const std::filesystem::path path =
        std::filesystem::path (__FILE__).parent_path () / "fixtures" / "element-kinds.json";
        std::ofstream out (path);
        out << vayu::core::elements_catalogue ().dump (2);
    }
};

} // namespace

// Called from main() before `RUN_ALL_TESTS` rather than as a namespace-scope
// static initialiser: `AddGlobalTestEnvironment(new ...)` running before
// `main` has no frame to catch an allocation failure in, which is exactly
// `engine/CLAUDE.md`'s "nothing at namespace scope is built at run time" rule
// (`cert-err58-cpp`).
void register_element_kinds_fixture_writer () {
    // gtest owns and deletes what `AddGlobalTestEnvironment` is handed - its
    // signature takes a raw pointer by contract, the same shape
    // `tests/task_queue.hpp`'s `pooled_task_queue` silences once for httplib's.
    // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
    ::testing::AddGlobalTestEnvironment (new ElementKindsFixtureWriter ());
}
