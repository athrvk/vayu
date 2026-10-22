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

// Every start reseeds, and the seed runs before the engine listens: an entry
// read back from the table must compare equal to the one this build seeds, or
// each start rewrites the whole catalogue for nothing. Driven over the real
// round trip - seeded, stored, read back - because an equality that held only
// for hand-built entries would say nothing about what SQLite hands back.
// Mutation check: drop the `updated != it->second` guard in `seed.hpp` and
// every entry is replaced here.
TEST_F (ConfigSeedTest, AReseedOverAnUnchangedCatalogueWritesNothing) {
    vayu::db::Database db (TEST_DB_PATH);
    db.init ();

    auto stored = db.get_all_config_entries ();
    ASSERT_GT (stored.size (), 40u)
    << "catalogue empty or unseeded - nothing was compared";

    std::unordered_set<std::string> known;
    std::vector<std::string> replaced;
    vayu::db::config_seeds::ConfigSeeder seed (
    std::move (stored), known,
    [&replaced] (
    const vayu::db::ConfigEntry& entry) { replaced.push_back (entry.key); },
    [] (const std::string&) {});
    const int64_t now = vayu::db::config_seeds::now_ms ();
    vayu::db::config_seeds::seed_general (seed, now);
    vayu::db::config_seeds::seed_network (seed, now);
    vayu::db::config_seeds::seed_services (seed, now);
    vayu::db::config_seeds::seed_observability (seed, now);
    vayu::db::config_seeds::seed_data_retention (seed, now);
    vayu::db::config_seeds::seed_limits (seed, now);
    vayu::db::config_seeds::seed_scripting (seed, now);

    ASSERT_GT (known.size (), 40u) << "the seed functions seeded nothing";
    std::string joined;
    for (const auto& key : replaced) {
        joined += (joined.empty () ? "" : ", ") + key;
    }
    EXPECT_TRUE (replaced.empty ()) << "rewrote unchanged entries: " << joined;
}

// The first word that breaks sentence case, or "" when the label holds it
// (docs/ux-writing.md, "Case"). The Settings page renders `label` verbatim, so
// this is the engine's half of the app's sentence-case scan (#2293). A later
// word may start with a capital only when it is all capitals (DNS, CA, URL,
// ID) or a name written that way: OAuth, OpenAPI, and the glossary's Send.
std::string first_non_sentence_case_word (const std::string& label) {
    static const std::unordered_set<std::string> capitalised_names = { "OAuth",
        "OpenAPI", "Send", "Sends", "Expect" };
    const auto is_upper = [] (char c) { return c >= 'A' && c <= 'Z'; };
    const auto is_lower = [] (char c) { return c >= 'a' && c <= 'z'; };

    std::string word;
    bool first_word = true;
    std::string offender;
    const auto judge = [&] {
        std::string bare = word;
        word.clear ();
        const auto begin = bare.find_first_not_of ('(');
        bare.erase (0, begin == std::string::npos ? bare.size () : begin);
        const auto end = bare.find_last_not_of ("):,");
        bare.erase (end == std::string::npos ? 0 : end + 1);
        if (bare.empty () || !offender.empty ())
            return;
        if (first_word) {
            first_word = false;
            return;
        }
        const bool all_caps = std::none_of (bare.begin (), bare.end (), is_lower);
        if (is_upper (bare.front ()) && !all_caps && !capitalised_names.contains (bare)) {
            offender = bare;
        }
    };
    for (const char c : label) {
        if (c == ' ' || c == '-') {
            judge ();
        } else {
            word += c;
        }
    }
    judge ();
    return offender;
}

TEST (ConfigSeederTest, TheSentenceCaseRuleFlagsATitleCaseWordAndAllowsNamesAndAcronyms) {
    for (const char* label :
    { "Default request timeout", "Max concurrent requests (per worker)", "Correlation ID",
    "Custom CA certificates", "Per-phase latency histograms", "OAuth 2.0 refresh lead time",
    "Max OpenAPI document size", "Max Send response body", "Max Sends retained",
    "Send Expect: 100-continue on large bodies", "Proxy URL", "Header name" }) {
        EXPECT_EQ (first_non_sentence_case_word (label), "") << label;
    }
    EXPECT_EQ (first_non_sentence_case_word ("Default Request Timeout"), "Request");
    EXPECT_EQ (first_non_sentence_case_word ("Correlation Id"), "Id");
    EXPECT_EQ (first_non_sentence_case_word ("Per-Phase latency histograms"), "Phase");
    EXPECT_EQ (first_non_sentence_case_word ("Max requests (Per worker)"), "Per");
}

// The Settings page renders every engine entry's label as written, so a label
// that reads as Title Case is a wording defect in the product. Mutation check:
// restore "Default Request Timeout" in `config_seeds/network.cpp` and this
// names it.
TEST_F (ConfigSeedTest, EveryEngineSettingLabelIsSentenceCase) {
    vayu::db::Database db (TEST_DB_PATH);
    db.init ();

    const auto entries = db.get_all_config_entries ();
    ASSERT_GE (entries.size (), 64u)
    << "catalogue empty or unseeded - nothing was scanned";

    for (const auto& entry : entries) {
        const std::string offender = first_non_sentence_case_word (entry.label);
        EXPECT_EQ (offender, "")
        << entry.key << ": label \"" << entry.label << "\" capitalises \""
        << offender << "\" - write it in sentence case (docs/ux-writing.md)";
    }
}

TEST (ConfigSeederTest, RewritesAnEntryWhoseMetadataChangedAndKeepsTheUsersValue) {
    vayu::db::ConfigEntry stored;
    stored.key           = "someLimit";
    stored.value         = "42"; // the user's
    stored.type          = "integer";
    stored.label         = "Old label";
    stored.description   = "Old description.";
    stored.category      = "limits";
    stored.default_value = "10";
    stored.updated_at    = 1234;

    vayu::db::ConfigEntry seeded = stored;
    seeded.value                 = seeded.default_value;
    seeded.label                 = "New label";
    seeded.updated_at            = 9999;

    std::unordered_set<std::string> known;
    std::vector<vayu::db::ConfigEntry> replaced;
    vayu::db::config_seeds::ConfigSeeder seed (
    { stored }, known,
    [&replaced] (
    const vayu::db::ConfigEntry& entry) { replaced.push_back (entry); },
    [] (const std::string&) {});
    seed (seeded);

    ASSERT_EQ (replaced.size (), 1u);
    EXPECT_EQ (replaced.front ().label, "New label");
    EXPECT_EQ (replaced.front ().value, "42");
    EXPECT_EQ (replaced.front ().updated_at, 1234);
}

// The adopt-new-default rule (#2419). `stored` is a row an older build wrote
// (default "0"); the build under test seeds default "1".
struct AdoptRuleRun {
    std::vector<vayu::db::ConfigEntry> replaced;
    std::string stored_value_after;
};

AdoptRuleRun
seed_over_old_row (const char* stored_value, const char* stored_default, bool opt_in) {
    vayu::db::ConfigEntry stored;
    stored.key           = "someKnob";
    stored.value         = stored_value;
    stored.type          = "enum";
    stored.label         = "Knob";
    stored.description   = "A knob whose default a build changed.";
    stored.category      = "limits";
    stored.default_value = stored_default;
    stored.updated_at    = 1234;

    vayu::db::ConfigEntry seeded = stored;
    seeded.value                 = "1";
    seeded.default_value         = "1";
    seeded.updated_at            = 9999;

    AdoptRuleRun run;
    std::unordered_set<std::string> known;
    vayu::db::config_seeds::ConfigSeeder seed (
    { stored }, known,
    [&run] (
    const vayu::db::ConfigEntry& entry) { run.replaced.push_back (entry); },
    [] (const std::string&) {});
    if (opt_in) {
        seed (seeded, vayu::db::config_seeds::adopt_new_default);
    } else {
        seed (seeded);
    }
    run.stored_value_after =
    run.replaced.empty () ? stored.value : run.replaced.back ().value;
    return run;
}

TEST (ConfigSeederTest, AdoptsTheNewDefaultWhenTheStoredValueIsTheOldDefault) {
    const auto run = seed_over_old_row ("0", "0", true);
    ASSERT_EQ (run.replaced.size (), 1u);
    EXPECT_EQ (run.replaced.front ().value, "1");
    EXPECT_EQ (run.replaced.front ().default_value, "1");
}

TEST (ConfigSeederTest, KeepsAValueTheUserSetAwayFromTheOldDefault) {
    const auto run = seed_over_old_row ("2", "0", true);
    EXPECT_EQ (run.stored_value_after, "2");
    ASSERT_EQ (run.replaced.size (), 1u) << "the new default is still recorded";
    EXPECT_EQ (run.replaced.front ().default_value, "1");
}

TEST (ConfigSeederTest, KeepsAnOffTheUserChoseAgainstTheCurrentDefault) {
    // Stored "0" beside a stored default that is already "1": the user chose
    // Off against the current default, which is not the untouched case.
    const auto run = seed_over_old_row ("0", "1", true);
    EXPECT_TRUE (run.replaced.empty ());
    EXPECT_EQ (run.stored_value_after, "0");
}

TEST (ConfigSeederTest, AMigratedRowIsNotRewrittenByTheNextStart) {
    vayu::db::ConfigEntry migrated;
    migrated.key           = "someKnob";
    migrated.value         = "1";
    migrated.type          = "enum";
    migrated.label         = "Knob";
    migrated.description   = "A knob whose default a build changed.";
    migrated.category      = "limits";
    migrated.default_value = "1";
    migrated.updated_at    = 9999;

    std::unordered_set<std::string> known;
    std::vector<vayu::db::ConfigEntry> replaced;
    vayu::db::config_seeds::ConfigSeeder seed (
    { migrated }, known,
    [&replaced] (
    const vayu::db::ConfigEntry& entry) { replaced.push_back (entry); },
    [] (const std::string&) {});
    // The next start stamps a later `updated_at` on the entry it seeds; a
    // rewrite that took it over would make every start write the row.
    vayu::db::ConfigEntry reseeded = migrated;
    reseeded.updated_at            = migrated.updated_at + 1000;
    seed (reseeded, vayu::db::config_seeds::adopt_new_default);

    EXPECT_TRUE (replaced.empty ());
}

TEST (ConfigSeederTest, AnEntryThatDoesNotOptInKeepsItsValueWhenItsDefaultMoves) {
    // The shape `workers` has on a machine with a different core count: value
    // equals the stored default, the seeded default differs. Without the
    // opt-in the user's row is left alone.
    const auto run = seed_over_old_row ("0", "0", false);
    EXPECT_EQ (run.stored_value_after, "0");
    ASSERT_EQ (run.replaced.size (), 1u);
    EXPECT_EQ (run.replaced.front ().default_value, "1");
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
