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
 * twice by construction, seven files can.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
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
json catalogue_from (vayu::db::Database& db) {
    auto entries = db.get_all_config_entries ();
    std::sort (entries.begin (), entries.end (),
    [] (const auto& a, const auto& b) { return a.key < b.key; });

    json out = json::array ();
    for (const auto& entry : entries) {
        out.push_back ({ { "key", entry.key }, { "category", entry.category },
        { "type", entry.type }, { "default_value", entry.default_value },
        { "min_value", entry.min_value.value_or ("") },
        { "max_value", entry.max_value.value_or ("") },
        { "requires_restart", entry.requires_restart }, { "advanced", entry.advanced } });
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

} // namespace
