/**
 * @file tests/config_seed_test.cpp
 * @brief Guards for the config-seed split (#1611).
 *
 * `Database::seed_default_config` used to be one 990-line function; the seed
 * for each of the seven `config_entries.category` values now lives in its own
 * translation unit under `engine/src/db/config_seeds/`. `MatchesTheGoldenCatalogue`
 * pins the seeded catalogue to a fixture captured from the pre-split function,
 * so a category file that drops, adds or edits an entry reds here rather than
 * only in a review of a 64-entry diff. `RefusesAKeySeededTwice` exercises the
 * duplicate guard the split made necessary: one function could not seed a key
 * twice by construction, seven files can. `RefusesADependsOnNaming*` exercise
 * the `dependsOn` relation issue #1610 added: a dependent entry must name a
 * boolean sibling in its own category, checked once every category has seeded
 * (`validate_dependencies`), since seed order across files is not a contract.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include "../src/db/config_seeds/seed.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace {

constexpr const char* TEST_DB_PATH = "test_config_seed.db";

class ConfigSeedTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }
    void TearDown () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }
};

// The fields a category file can drift on: everything but `label`,
// `description` and `updated_at`, which the wording/copy tests in
// `config_route_test.cpp` already cover and which change too often (a label
// reworded for voice, say) to belong in a fixture meant to catch a dropped or
// duplicated entry.
//
// `workers` is normalized out of `default_value`: it seeds from
// `std::thread::hardware_concurrency ()`, so its value is this machine's core
// count, not a constant the split could have changed - comparing it verbatim
// would fail on every runner whose core count differs from whichever one
// captured the fixture, which is exactly the false failure this guard exists
// to avoid producing.
json catalogue_from (vayu::db::Database& db) {
    auto entries = db.get_all_config_entries ();
    std::sort (entries.begin (), entries.end (),
    [] (const auto& a, const auto& b) { return a.key < b.key; });

    json out = json::array ();
    for (const auto& entry : entries) {
        const bool machine_dependent = entry.key == "workers";
        out.push_back ({ { "key", entry.key }, { "category", entry.category },
        { "type", entry.type },
        { "default_value", machine_dependent ? "<core count>" : entry.default_value },
        { "min_value", entry.min_value.value_or ("") },
        { "max_value", entry.max_value.value_or ("") },
        { "requires_restart", entry.requires_restart }, { "advanced", entry.advanced },
        { "depends_on", entry.depends_on.value_or ("") } });
    }
    return out;
}

TEST_F (ConfigSeedTest, MatchesTheGoldenCatalogue) {
    vayu::db::Database db (TEST_DB_PATH);
    db.init ();

    const std::filesystem::path fixture_path =
    std::filesystem::path (__FILE__).parent_path () / "fixtures" / "config-catalogue.json";
    std::ifstream in (fixture_path);
    ASSERT_TRUE (in.is_open ()) << "fixture not found: " << fixture_path;
    json golden;
    in >> golden;

    json actual = catalogue_from (db);
    ASSERT_GT (actual.size (), 40u)
    << "catalogue empty or unseeded - nothing was scanned";
    EXPECT_EQ (actual, golden)
    << "the seeded catalogue drifted from the pre-split golden fixture - a "
    << "config_seeds/*.cpp file dropped, added or changed an entry";
}

TEST (ConfigSeederTest, RefusesAKeySeededTwice) {
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    {}, known, [] (const vayu::db::ConfigEntry&) {}, [] (const std::string&) {});

    vayu::db::ConfigEntry entry;
    entry.key           = "duplicateKey";
    entry.value         = "1";
    entry.type          = "integer";
    entry.label         = "Duplicate";
    entry.description   = "A key this test seeds twice on purpose.";
    entry.category      = "limits";
    entry.default_value = "1";
    entry.updated_at    = 0;

    EXPECT_NO_THROW (seed (entry));
    EXPECT_THROW (seed (entry), std::runtime_error)
    << "a second seed of the same key across two category files must fail "
    << "the engine's start, not silently overwrite the first";
}

vayu::db::ConfigEntry make_entry (std::string key, std::string type, std::string category) {
    vayu::db::ConfigEntry entry;
    entry.key           = std::move (key);
    entry.value         = "1";
    entry.type          = std::move (type);
    entry.label         = "Test entry";
    entry.description   = "A fixture entry for validate_dependencies tests.";
    entry.category      = std::move (category);
    entry.default_value = "1";
    entry.updated_at    = 0;
    return entry;
}

TEST (ConfigSeederTest, AcceptsADependsOnNamingABooleanSiblingInTheSameCategory) {
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    {}, known, [] (const vayu::db::ConfigEntry&) {}, [] (const std::string&) {});

    auto parent = make_entry ("switchKey", "boolean", "network_performance");
    auto child  = make_entry ("dependentKey", "string", "network_performance");
    child.depends_on = "switchKey";

    seed (parent);
    seed (child);
    EXPECT_NO_THROW (seed.validate_dependencies ());
}

TEST (ConfigSeederTest, RefusesADependsOnNamingAnUnseededKey) {
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    {}, known, [] (const vayu::db::ConfigEntry&) {}, [] (const std::string&) {});

    auto child = make_entry ("dependentKey", "string", "network_performance");
    child.depends_on = "noSuchKey";
    seed (child);

    EXPECT_THROW (seed.validate_dependencies (), std::runtime_error)
    << "a dependsOn naming a key nothing seeded must fail the engine's start";
}

TEST (ConfigSeederTest, RefusesADependsOnNamingANonBooleanKey) {
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    {}, known, [] (const vayu::db::ConfigEntry&) {}, [] (const std::string&) {});

    auto parent = make_entry ("switchKey", "integer", "network_performance");
    auto child  = make_entry ("dependentKey", "string", "network_performance");
    child.depends_on = "switchKey";

    seed (parent);
    seed (child);
    EXPECT_THROW (seed.validate_dependencies (), std::runtime_error)
    << "a dependsOn naming a non-boolean key must fail the engine's start";
}

TEST (ConfigSeederTest, RefusesADependsOnNamingAKeyInAnotherCategory) {
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    {}, known, [] (const vayu::db::ConfigEntry&) {}, [] (const std::string&) {});

    auto parent = make_entry ("switchKey", "boolean", "network_performance");
    auto child  = make_entry ("dependentKey", "string", "limits");
    child.depends_on = "switchKey";

    seed (parent);
    seed (child);
    EXPECT_THROW (seed.validate_dependencies (), std::runtime_error)
    << "a dependsOn naming a key outside the dependent's own category must "
    << "fail the engine's start";
}

} // namespace
