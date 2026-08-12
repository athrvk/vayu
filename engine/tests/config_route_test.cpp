/**
 * @file tests/config_route_test.cpp
 * @brief Tests for POST /config validation (apply_config_update).
 *
 * Focus: a validation failure must return the *specific* reason (which key,
 * why) in the nested `error.message` shape the app reads - not a generic
 * "check the logs" string that surfaces as a bare "HTTP 400".
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> apply_config_update (vayu::db::Database& db,
const std::string& body);
} // namespace vayu::http::routes

namespace {

class ConfigRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_config_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        // The constructor only syncs the schema; seeding the default config
        // (incl. the "workers" key these tests exercise) happens in init(),
        // exactly as the daemon does at startup. Without this the config table
        // is empty and every keyed update is rejected as an unknown key.
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ConfigRouteTest, InvalidJsonIs400WithReason) {
    auto [status, body] = vayu::http::routes::apply_config_update (*db_, "not json");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "invalid_config");
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Invalid JSON"),
    std::string::npos);
}

TEST_F (ConfigRouteTest, InvalidRequestFormatIs400) {
    auto [status, body] = vayu::http::routes::apply_config_update (*db_, R"({"foo":"bar"})");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "invalid_config");
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Invalid request format"),
    std::string::npos);
}

TEST_F (ConfigRouteTest, UnknownKeyNamesTheKey) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"totally_made_up_key":"1"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("Unknown config key"), std::string::npos);
    EXPECT_NE (message.find ("totally_made_up_key"), std::string::npos);
}

TEST_F (ConfigRouteTest, OutOfRangeReportsBoundAndValue) {
    // "workers" is seeded as an integer with min 1 / max 128.
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"999"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("workers"), std::string::npos);
    EXPECT_NE (message.find ("128"), std::string::npos); // the exceeded bound
    EXPECT_NE (message.find ("999"), std::string::npos); // the offending value
}

TEST_F (ConfigRouteTest, NonIntegerReportsType) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"abc"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("workers"), std::string::npos);
    EXPECT_NE (message.find ("integer"), std::string::npos);
}

TEST_F (ConfigRouteTest, InvalidValueDoesNotPersist) {
    auto before = db_->get_config_entry ("workers");
    ASSERT_TRUE (before.has_value ());

    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"999"}})");

    auto after = db_->get_config_entry ("workers");
    ASSERT_TRUE (after.has_value ());
    EXPECT_EQ (after->value, before->value); // rejected update left the DB untouched
}

TEST_F (ConfigRouteTest, ValidUpdateSucceedsAndPersists) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"workers":"4"}})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("workers");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "4");
}

TEST_F (ConfigRouteTest, SingleUpdateFormatSucceeds) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"key":"workers","value":"8"})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("workers");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "8");
}

// Find one entry by key in the "entries" array of an apply_config_update
// response body. Fails the calling test if the key is missing.
json find_entry (const json& body, const std::string& key) {
    for (const auto& entry : body["entries"]) {
        if (entry["key"] == key) {
            return entry;
        }
    }
    ADD_FAILURE () << "entry '" << key << "' not found in response";
    return json{};
}

TEST_F (ConfigRouteTest, EnumEntrySerializesOptionsAsArrayOfValueLabel) {
    // Any successful update returns the full entry list, including the
    // seeded "defaultHttpVersion" enum entry - trigger via an unrelated key.
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json entry = find_entry (body, "defaultHttpVersion");
    ASSERT_EQ (entry["type"], "enum");
    ASSERT_TRUE (entry.contains ("options"));
    ASSERT_TRUE (entry["options"].is_array ());

    const auto& versions = vayu::all_http_versions ();
    ASSERT_EQ (entry["options"].size (), versions.size ());
    for (size_t i = 0; i < versions.size (); ++i) {
        EXPECT_EQ (entry["options"][i]["value"], vayu::to_string (versions[i]));
        EXPECT_EQ (entry["options"][i]["label"], vayu::http_version_label (versions[i]));
    }
}

TEST_F (ConfigRouteTest, NonEnumEntryOmitsOptionsEntirely) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json entry = find_entry (body, "workers");
    EXPECT_FALSE (entry.contains ("options")); // absent, not null
}

TEST_F (ConfigRouteTest, EnumUpdateRejectsValueOutsideOptionsWith400) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"defaultHttpVersion":"http3"}})");
    EXPECT_EQ (status, 400);
    const auto message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("defaultHttpVersion"), std::string::npos);
    EXPECT_NE (message.find ("http3"), std::string::npos);
}

TEST_F (ConfigRouteTest, EnumUpdateAcceptsValidOption) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"defaultHttpVersion":"http2"}})");
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["success"].get<bool> ());

    auto stored = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "http2");
    // save_config_entry replaces the whole row, so a value-only update must not
    // drop the option list - without it the entry becomes unrenderable.
    ASSERT_TRUE (stored->options.has_value ());
    EXPECT_EQ (nlohmann::json::parse (*stored->options).size (),
    vayu::all_http_versions ().size ());
}

TEST_F (ConfigRouteTest, MalformedOptionsOmitsTheKeyInsteadOfFailingTheWholeListing) {
    // Only seed_default_config writes this column, so this state means a
    // tampered or truncated row. It must cost one entry's option list, not the
    // entire GET /config payload - an unguarded parse here would 500 the whole
    // settings screen.
    auto entry = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (entry.has_value ());
    entry->options = "{not valid json";
    db_->save_config_entry (*entry);

    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json broken = find_entry (body, "defaultHttpVersion");
    EXPECT_EQ (broken["type"], "enum");
    EXPECT_FALSE (broken.contains ("options"));

    // The rest of the listing is unaffected.
    json healthy = find_entry (body, "workers");
    EXPECT_EQ (healthy["value"], "4");
}

// Mutation-check target: if seed_default_config() ever hardcodes the option
// list instead of deriving it from all_http_versions(), this must fail. The
// two most likely mutations - dropping an entry, or reordering it - are both
// caught because the comparison is index-by-index against the exact same
// domain source production is supposed to consult.
TEST_F (ConfigRouteTest, SeededDefaultHttpVersionOptionsMatchAllHttpVersionsInOrder) {
    auto entry = db_->get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (entry.has_value ());
    ASSERT_TRUE (entry->options.has_value ());

    json options         = json::parse (*entry->options);
    const auto& versions = vayu::all_http_versions ();
    ASSERT_EQ (options.size (), versions.size ());
    for (size_t i = 0; i < versions.size (); ++i) {
        EXPECT_EQ (options[i]["value"], vayu::to_string (versions[i]));
        EXPECT_EQ (options[i]["label"], vayu::http_version_label (versions[i]));
    }
}


// ---------------------------------------------------------------------------
// requiresRestart / advanced: typed metadata, not a label convention.
// ---------------------------------------------------------------------------

// The whole point of the field: a consumer asks the entry, not the prose. Both
// values are asserted, because a serializer that always sent `true` would pass
// a one-sided check.
TEST_F (ConfigRouteTest, RestartRequiredSerializesAsATypedFlagBothWays) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json restarts = find_entry (body, "workers");
    ASSERT_TRUE (restarts.contains ("requiresRestart"));
    EXPECT_TRUE (restarts["requiresRestart"].get<bool> ());

    // Read per run, so a change applies to the next run started.
    json does_not = find_entry (body, "defaultTimeout");
    ASSERT_TRUE (does_not.contains ("requiresRestart"));
    EXPECT_FALSE (does_not["requiresRestart"].get<bool> ());
}

// The convention this replaced, guarded against creeping back: the flag is the
// only statement, so no label may also spell it out. Scans the whole seeded
// catalogue and asserts it scanned something - a guard that reads an empty
// list passes for the wrong reason.
TEST_F (ConfigRouteTest, NoSeededLabelOrDescriptionSpellsOutTheRestartRequirement) {
    auto entries = db_->get_all_config_entries ();
    ASSERT_GT (entries.size (), 20u)
    << "catalogue empty or unseeded - nothing was scanned";

    size_t restart_required_count = 0;
    for (const auto& entry : entries) {
        EXPECT_EQ (entry.label.find ("Requires Restart"), std::string::npos)
        << "entry '" << entry.key << "' states the restart requirement in its "
        << "label";
        EXPECT_EQ (entry.description.find ("require engine restart"),
        std::string::npos)
        << "entry '" << entry.key << "' states the restart requirement in its "
        << "description";
        if (entry.requires_restart) {
            ++restart_required_count;
        }
    }
    // The statement has to live somewhere: dropping the suffix without setting
    // the flag would satisfy the scan above and tell the user nothing.
    EXPECT_GT (restart_required_count, 0u);
}

// The settings voice conventions (#518), guarded where they are mechanically
// checkable. Convention 4: labels abbreviate Max/Min, matching the app side.
// Convention 3: a unit lives once, on the input - so a label never ends in a
// parenthesised one. Both scans assert they scanned a seeded catalogue, since
// a guard that reads an empty list passes for the wrong reason.
TEST_F (ConfigRouteTest, NoSeededLabelSpellsOutMaxMinOrCarriesAUnit) {
    // A parenthesised label tail is only a breach when it names a unit -
    // "(Per Worker)" is a scope qualifier and stays. Kept as the units this
    // catalogue actually measures in, so a new one is added deliberately.
    const std::set<std::string> units = { "ms", "s", "sec", "secs", "second",
        "seconds", "m", "min", "mins", "minute", "minutes", "h", "hr", "hour",
        "hours", "day", "days", "b", "kb", "mb", "gb", "byte", "bytes", "rps",
        "req/s", "%" };

    auto entries = db_->get_all_config_entries ();
    ASSERT_GT (entries.size (), 20u)
    << "catalogue empty or unseeded - nothing was scanned";

    for (const auto& entry : entries) {
        EXPECT_NE (entry.label.rfind ("Maximum ", 0), 0u)
        << "entry '" << entry.key << "' spells out Maximum in its label; the "
        << "app side abbreviates it";
        EXPECT_NE (entry.label.rfind ("Minimum ", 0), 0u)
        << "entry '" << entry.key << "' spells out Minimum in its label; the "
        << "app side abbreviates it";

        if (entry.label.size () > 2 && entry.label.back () == ')') {
            const auto open = entry.label.rfind ('(');
            if (open != std::string::npos) {
                std::string tail = entry.label.substr (
                open + 1, entry.label.size () - open - 2);
                for (auto& c : tail) {
                    c = static_cast<char> (std::tolower (
                    static_cast<unsigned char> (c)));
                }
                EXPECT_EQ (units.count (tail), 0u)
                << "entry '" << entry.key << "' carries its unit in the label; "
                << "the unit belongs on the input, once";
            }
        }
    }
}

// Membership is the recorded decision (#520), so it is pinned by key rather
// than by count - an entry added to or dropped from the group has to say so
// here.
TEST_F (ConfigRouteTest, AdvancedFlagsExactlyTheRecordedInternals) {
    const std::set<std::string> expected = { "dbBusyTimeout",
        "oauth2RefreshRetryMs", "oauth2RefreshRetryMaxMs",
        "oauth2RefreshPollIntervalMs", "inboxLivePollIntervalMs" };

    auto entries = db_->get_all_config_entries ();
    ASSERT_FALSE (entries.empty ()) << "catalogue empty - nothing was scanned";

    std::set<std::string> actual;
    for (const auto& entry : entries) {
        if (entry.advanced) {
            actual.insert (entry.key);
        }
    }
    EXPECT_EQ (actual, expected);
}

TEST_F (ConfigRouteTest, AdvancedSerializesOnTheWire) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json internal = find_entry (body, "dbBusyTimeout");
    ASSERT_TRUE (internal.contains ("advanced"));
    EXPECT_TRUE (internal["advanced"].get<bool> ());

    json everyday = find_entry (body, "workers");
    ASSERT_TRUE (everyday.contains ("advanced"));
    EXPECT_FALSE (everyday["advanced"].get<bool> ());
}

// ---------------------------------------------------------------------------
// keywords: the search terms the copy never says.
// ---------------------------------------------------------------------------

// Always an array, on every entry. A client that had to tell "declares none"
// from "this engine does not send the field" would branch on absent-vs-empty,
// which is exactly the guessing the typed flags above replaced.
TEST_F (ConfigRouteTest, KeywordsSerializeAsAnArrayWithAndWithoutTerms) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json seeded = find_entry (body, "dbCacheSize");
    ASSERT_TRUE (seeded.contains ("keywords"));
    ASSERT_TRUE (seeded["keywords"].is_array ());
    EXPECT_NE (std::find (seeded["keywords"].begin (), seeded["keywords"].end (),
               json ("ram")),
    seeded["keywords"].end ())
    << "dbCacheSize lost the term a user arrives with for it";

    // An entry whose label and description already carry every word worth
    // typing declares none - and still sends the key.
    json none = find_entry (body, "maxScenarioSteps");
    ASSERT_TRUE (none.contains ("keywords"));
    ASSERT_TRUE (none["keywords"].is_array ());
    EXPECT_TRUE (none["keywords"].empty ());
}

// The rule that keeps the channel worth having: a keyword repeating a word the
// entry already carries lifts it over entries that match better, so ranking
// degrades into noise. Mechanically checkable, so it is checked rather than
// left to review - the corpus is the same three fields the matcher reads
// before it reaches keywords (key, label, description).
TEST_F (ConfigRouteTest, SeededKeywordsNeverRepeatWordsTheEntryAlreadyCarries) {
    auto entries = db_->get_all_config_entries ();
    ASSERT_GT (entries.size (), 20u)
    << "catalogue empty or unseeded - nothing was scanned";

    auto lowered = [] (std::string text) {
        for (auto& c : text) {
            c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
        }
        return text;
    };

    size_t with_keywords = 0;
    for (const auto& entry : entries) {
        json terms = json::parse (entry.keywords);
        ASSERT_TRUE (terms.is_array ())
        << "entry '" << entry.key << "' stores keywords that are not an array";
        if (!terms.empty ()) {
            ++with_keywords;
        }

        const std::string haystack =
        lowered (entry.key + " " + entry.label + " " + entry.description);
        for (const auto& term : terms) {
            ASSERT_TRUE (term.is_string ())
            << "entry '" << entry.key << "' has a non-string keyword";
            const std::string needle = lowered (term.get<std::string> ());
            EXPECT_FALSE (needle.empty ())
            << "entry '" << entry.key << "' has an empty keyword";
            EXPECT_EQ (haystack.find (needle), std::string::npos)
            << "entry '" << entry.key << "' repeats '" << needle
            << "', which its key, label or description already carries - the "
            << "matcher finds it there and ranks it higher";
        }
    }
    // The channel has to be used somewhere: a catalogue that declared none
    // would satisfy every assertion above and leave search where it was.
    EXPECT_GT (with_keywords, 0u);
}

// ---------------------------------------------------------------------------
// unit: what a numeric entry measures, so the app can put it on the input.
// ---------------------------------------------------------------------------

// Omitted, not null, when the entry measures nothing - the same shape as
// `min`/`max`/`options`, so this payload has one rule for optional scalars
// rather than one per field. Pinned here because "absent" is the only thing a
// client can read as "this number is a count".
TEST_F (ConfigRouteTest, UnitSerializesForAMeasuredEntryAndIsAbsentForACount) {
    auto [status, body] =
    vayu::http::routes::apply_config_update (*db_, R"({"entries":{"workers":"4"}})");
    ASSERT_EQ (status, 200);

    json milliseconds = find_entry (body, "defaultTimeout");
    ASSERT_TRUE (milliseconds.contains ("unit"));
    EXPECT_EQ (milliseconds["unit"].get<std::string> (), "ms");

    json bytes = find_entry (body, "dbCacheSize");
    ASSERT_TRUE (bytes.contains ("unit"));
    EXPECT_EQ (bytes["unit"].get<std::string> (), "bytes");

    // Worker threads are a count. Not "" and not null - the key is gone.
    json count = find_entry (body, "workers");
    EXPECT_FALSE (count.contains ("unit"))
    << "a count declared a unit; 'items' is noise, and an absent key is how a "
       "client tells the two apart";
}

// The catalogue guard. A key that names its unit and does not declare one is
// the defect this field exists to end: the app cannot infer it, so the unit
// would be nowhere on screen. Only the keys whose *name* settles the question
// are checked - dbCacheSize and scriptTimeout measure something too, and are
// covered by review rather than by a rule that would have to guess.
TEST_F (ConfigRouteTest, SeededUnitsCoverEveryKeyWhoseNameNamesOne) {
    auto entries = db_->get_all_config_entries ();
    ASSERT_GT (entries.size (), 20u)
    << "catalogue empty or unseeded - nothing was scanned";

    size_t checked = 0;
    for (const auto& entry : entries) {
        const char* expected = nullptr;
        if (entry.key.ends_with ("Ms")) {
            expected = "ms";
        } else if (entry.key.ends_with ("Bytes")) {
            expected = "bytes";
        } else if (entry.key.ends_with ("Days")) {
            expected = "days";
        }
        if (expected == nullptr) {
            continue;
        }
        ++checked;
        ASSERT_TRUE (entry.unit.has_value ())
        << "entry '" << entry.key << "' names its unit in its key and declares "
        << "none, so the input renders a bare number";
        EXPECT_EQ (*entry.unit, expected) << "entry '" << entry.key << "'";
    }
    EXPECT_GT (checked, 10u) << "the key-suffix scan matched nothing";

    // The converse: a unit on a value that is not a number would render a
    // suffix on a switch or a select, which have no input to carry it.
    for (const auto& entry : entries) {
        if (entry.type != "integer" && entry.type != "number") {
            EXPECT_FALSE (entry.unit.has_value ())
            << "non-numeric entry '" << entry.key << "' declares a unit";
        }
    }
}

// Convention 3 of the settings voice: units live once, as the input's suffix.
// An entry that declares one and still spells it out in prose states it twice
// - and that prose is what this field replaced, so it is checked rather than
// left to the next writer to remember. Only the clause form is rejected: "60 to
// 300 seconds suits a stable endpoint" is a number with its unit spelled, which
// convention 4 asks for.
TEST_F (ConfigRouteTest, SeededDescriptionsDoNotRestateTheUnitTheInputCarries) {
    auto entries = db_->get_all_config_entries ();
    ASSERT_GT (entries.size (), 20u)
    << "catalogue empty or unseeded - nothing was scanned";

    auto lowered = [] (std::string text) {
        for (auto& c : text) {
            c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
        }
        return text;
    };

    size_t with_unit = 0;
    for (const auto& entry : entries) {
        if (!entry.unit.has_value ()) {
            continue;
        }
        ++with_unit;
        const std::string description = lowered (entry.description);
        for (const char* clause : { "in milliseconds", "in seconds", "in bytes",
                 "in days", "in minutes", "in hours" }) {
            EXPECT_EQ (description.find (clause), std::string::npos)
            << "entry '" << entry.key << "' says '" << clause
            << "', which its input's suffix already says";
        }
    }
    EXPECT_GT (with_unit, 0u) << "no entry declares a unit - nothing was checked";
}

// A write must not flatten metadata it does not carry. POST /config sends only
// values, so the update path copies the stored row - if it ever rebuilt the
// entry instead, both flags would silently reset to false and every restart
// chip in the app would vanish after one save.
TEST_F (ConfigRouteTest, UpdatingAValueKeepsItsMetadataFlags) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    *db_, R"({"entries":{"dbBusyTimeout":"20000"}})");
    ASSERT_EQ (status, 200);

    auto stored = db_->get_config_entry ("dbBusyTimeout");
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->value, "20000");
    EXPECT_TRUE (stored->requires_restart);
    EXPECT_TRUE (stored->advanced);
    ASSERT_TRUE (stored->unit.has_value ());
    EXPECT_EQ (*stored->unit, "ms");

    json entry = find_entry (body, "dbBusyTimeout");
    EXPECT_TRUE (entry["requiresRestart"].get<bool> ());
    EXPECT_TRUE (entry["advanced"].get<bool> ());
    EXPECT_EQ (entry["unit"].get<std::string> (), "ms");
}

} // namespace
