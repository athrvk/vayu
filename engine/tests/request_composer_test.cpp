/**
 * @file tests/request_composer_test.cpp
 * @brief Tests for engine-side request composition (issue #226): the
 * cross-language conformance fixture, the dynamic-variable table, the
 * collection-chain inherit walk, and the POST /compose core.
 *
 * The fixture (`tests/fixtures/variable-resolution-conformance.json`) is the
 * contract between this suite and the app's vitest suite
 * (`app/src/lib/variable-resolution.conformance.test.ts`): both drive their
 * implementation over the same `(scopes, input, expected)` table, so a
 * divergence between engine execution and renderer preview fails somewhere
 * rather than reaching a user. Scopes are raw stored-variables bags, so the
 * fixture also exercises `parse_variables`' D17 tolerance (absent `enabled`
 * is enabled, a non-string `value` reads as "").
 *
 * The DB-backed tests mirror the suite's other route tests: they drive the
 * extracted core (`compose_request_core`) against a real database file, no
 * in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "variable-resolution-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

// Build a vayu::Environment from a fixture bag through the same parser the
// engine uses on stored blobs - the D17 rules live there, and reading the bag
// any other way would test a path production never takes.
vayu::Environment env_from_bag (const json& bag) {
    return vayu::json::parse_variables (bag.dump ());
}

vayu::http::VariableValues values_from_scopes (const json& scopes) {
    vayu::Environment globals, environment;
    std::vector<vayu::Environment> chain;
    if (scopes.contains ("globals")) {
        globals = env_from_bag (scopes["globals"]);
    }
    if (scopes.contains ("chain")) {
        for (const auto& bag : scopes["chain"]) {
            chain.push_back (env_from_bag (bag));
        }
    }
    if (scopes.contains ("environment")) {
        environment = env_from_bag (scopes["environment"]);
    }
    return vayu::http::build_variable_values (globals, chain, environment);
}

/// The bare names a case says a row will bind (issue #1007) - absent for every
/// case that predates the field, which is exactly "no dataset is bound".
vayu::http::BoundColumnNames bound_columns_from_case (const json& c) {
    vayu::http::BoundColumnNames out;
    if (const auto field = c.find ("boundColumns"); field != c.end ()) {
        for (const auto& name : *field) {
            out.insert (name.get<std::string> ());
        }
    }
    return out;
}

TEST (VariableResolutionConformance, EveryFixtureCasePasses) {
    const json fixture = load_fixture ();
    ASSERT_FALSE (fixture["cases"].empty ())
    << "conformance fixture scanned nothing";
    for (const auto& c : fixture["cases"]) {
        const auto vars = values_from_scopes (c["scopes"]);
        EXPECT_EQ (vayu::http::resolve_template (c["input"].get<std::string> (),
                   vars, bound_columns_from_case (c)),
        c["expected"].get<std::string> ())
        << "case: " << c["name"].get<std::string> ();
    }
}

TEST (VariableResolutionConformance, DynamicVariableNamesMatchFixture) {
    const json fixture = load_fixture ();
    std::vector<std::string> expected;
    for (const auto& name : fixture["dynamicVariableNames"]) {
        expected.push_back (name.get<std::string> ());
    }
    ASSERT_FALSE (expected.empty ()) << "conformance fixture scanned nothing";
    EXPECT_EQ (vayu::http::dynamic_variable_names (), expected);
}

TEST (DynamicVariables, EveryGeneratorProducesANonEmptyNonBraceValue) {
    const vayu::http::VariableValues no_vars;
    for (const auto& name : vayu::http::dynamic_variable_names ()) {
        const std::string input = "{{" + name + "}}";
        const std::string resolved = vayu::http::resolve_template (input, no_vars);
        EXPECT_FALSE (resolved.empty ()) << name;
        EXPECT_NE (resolved, input) << name;
    }
}

TEST (DynamicVariables, GuidIsAUuidV4AndDiffersPerOccurrence) {
    const vayu::http::VariableValues no_vars;
    const std::string out = vayu::http::resolve_template ("{{$guid}}|{{$guid}}", no_vars);
    const auto sep = out.find ('|');
    ASSERT_NE (sep, std::string::npos);
    const std::string a = out.substr (0, sep);
    const std::string b = out.substr (sep + 1);
    const std::regex uuid_v4 (
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    EXPECT_TRUE (std::regex_match (a, uuid_v4)) << a;
    EXPECT_TRUE (std::regex_match (b, uuid_v4)) << b;
    // Once per occurrence: two {{$guid}} in one payload are two different ids.
    EXPECT_NE (a, b);
}

// Issue #995. A payload a run repeats cannot carry a generated value, so a
// composition that says so leaves the token for the per-iteration bind. The
// three cases below are the whole of the rule: what defers, what does not, and
// where the deferral sits against the scopes.
TEST (DynamicVariables, DeferLeavesEveryGeneratorNameWrittenAsItStands) {
    const vayu::http::VariableValues no_vars;
    ASSERT_FALSE (vayu::http::dynamic_variable_names ().empty ())
    << "the generator table is empty, so this test asserts nothing";
    for (const auto& name : vayu::http::dynamic_variable_names ()) {
        const std::string input = "{{" + name + "}}";
        EXPECT_EQ (vayu::http::resolve_template (
                   input, no_vars, {}, vayu::http::DynamicResolution::Defer),
        input)
        << name;
        // The same call without the deferral still generates - the mutation
        // check for the arm above.
        EXPECT_NE (vayu::http::resolve_template (
                   input, no_vars, {}, vayu::http::DynamicResolution::Generate),
        input)
        << name;
    }
}

TEST (DynamicVariables, DeferIsTheTableOnly) {
    const vayu::http::VariableValues no_vars;
    // An unknown `$name` kept its braces before this existed and still does -
    // nothing would ever generate it, so there is nothing to defer (#186).
    EXPECT_EQ (vayu::http::resolve_template (
               "{{$typo}}", no_vars, {}, vayu::http::DynamicResolution::Defer),
    "{{$typo}}");
    // The identity names are reserved ahead of the table and are unaffected by
    // which side of it is running (#994).
    EXPECT_EQ (vayu::http::resolve_template ("{{$vu}}/{{$iteration}}", no_vars,
               {}, vayu::http::DynamicResolution::Defer),
    "{{$vu}}/{{$iteration}}");
    // An ordinary name is resolved by the scopes either way.
    const vayu::http::VariableValues vars{ { "host", "example.test" } };
    EXPECT_EQ (vayu::http::resolve_template (
               "{{host}}", vars, {}, vayu::http::DynamicResolution::Defer),
    "example.test");
}

TEST (DynamicVariables, ADefinedVariableStillOutranksTheGeneratorUnderDefer) {
    // The deferral sits in the table's own position, after the scopes, so a
    // variable someone defined as `$guid` answers for the token under either
    // value. A deferral placed ahead of the scopes would leave this token for a
    // bind that has no scope to read, and the name would mean two things.
    const vayu::http::VariableValues vars{ { "$guid", "pinned" } };
    EXPECT_EQ (vayu::http::resolve_template (
               "{{$guid}}", vars, {}, vayu::http::DynamicResolution::Defer),
    "pinned");
    EXPECT_EQ (vayu::http::resolve_template (
               "{{$guid}}", vars, {}, vayu::http::DynamicResolution::Generate),
    "pinned");
}

TEST (DynamicVariables, IsAGeneratorNameAnswersForTheTableAndNothingElse) {
    for (const auto& name : vayu::http::dynamic_variable_names ()) {
        EXPECT_TRUE (vayu::http::is_generator_variable_name (name)) << name;
    }
    EXPECT_FALSE (vayu::http::is_generator_variable_name ("$typo"));
    EXPECT_FALSE (vayu::http::is_generator_variable_name ("$vu"));
    EXPECT_FALSE (vayu::http::is_generator_variable_name ("$iteration"));
    EXPECT_FALSE (vayu::http::is_generator_variable_name ("data.id"));
    EXPECT_FALSE (vayu::http::is_generator_variable_name (""));
}

TEST (DynamicVariables, IsoTimestampIsTheShapeTheRendererProduces) {
    // The renderer's `$isoTimestamp` is `new Date().toISOString()`, and the two
    // tables are a contract: this is that shape, spelled out. The engine now
    // assembles it from two pieces - a formatted `std::tm` and the
    // milliseconds - so the assertion is on the whole string, joint included.
    //
    // Sampled over wall-clock time rather than in a tight loop, and that is the
    // whole design of this test. The half a tight loop never reaches is the
    // zero-padding: the millisecond field only needs it for one instant in ten,
    // and 200 back-to-back calls complete inside a single millisecond, so they
    // are 200 copies of one sample. The field visits every value once per
    // second, so pausing between samples until a padded one turns up reaches
    // that case instead of hoping for it - and the test says so afterwards,
    // rather than passing on a run that never sampled it.
    const vayu::http::VariableValues no_vars;
    const std::regex iso_8601 (R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$)");
    constexpr size_t kMillisAt = std::string_view ("2026-08-25T16:30:45.").size ();

    bool sampled_a_padded_millisecond = false;
    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (3);
    while (std::chrono::steady_clock::now () < deadline) {
        const std::string stamped =
        vayu::http::resolve_template ("{{$isoTimestamp}}", no_vars);
        ASSERT_TRUE (std::regex_match (stamped, iso_8601)) << stamped;
        if (stamped[kMillisAt] == '0') {
            sampled_a_padded_millisecond = true;
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }
    EXPECT_TRUE (sampled_a_padded_millisecond)
    << "never sampled a millisecond below 100, so the padding went unchecked";
}

TEST (DynamicVariables, TheRandomAlphabetsAreTheOnesTheCharactersComeFrom) {
    // Both alphabets are `constexpr std::string_view` now, indexed rather than
    // copied. A view whose length or contents went wrong reads past the literal
    // or draws from the wrong span, and either shows up here as a character
    // that does not belong.
    constexpr std::string_view alphanumeric =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    constexpr std::string_view password_chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+"
    "=";
    const vayu::http::VariableValues no_vars;

    for (int i = 0; i < 50; ++i) {
        const std::string one =
        vayu::http::resolve_template ("{{$randomAlphaNumeric}}", no_vars);
        ASSERT_EQ (one.size (), 1u) << one;
        EXPECT_NE (alphanumeric.find (one[0]), std::string_view::npos) << one;

        const std::string password =
        vayu::http::resolve_template ("{{$randomPassword}}", no_vars);
        ASSERT_EQ (password.size (), 15u) << password;
        for (const char c : password) {
            EXPECT_NE (password_chars.find (c), std::string_view::npos) << password;
        }
    }
}

TEST (DynamicVariables, RandomIntStaysInRange) {
    const vayu::http::VariableValues no_vars;
    for (int i = 0; i < 50; ++i) {
        const int value =
        std::stoi (vayu::http::resolve_template ("{{$randomInt}}", no_vars));
        EXPECT_GE (value, 0);
        EXPECT_LE (value, 1000);
    }
}

/// A `std::tm` already in UTC as a `time_t` - the inverse of `gmtime_r`, which
/// the standard leaves out and each platform spells its own way.
std::time_t utc_time_from (std::tm parts) {
#if defined(_WIN32)
    return _mkgmtime (&parts);
#else
    return timegm (&parts);
#endif
}

// The shape of every generator #1010 added, read off Postman's own documented
// example for that name. The values are random and the corpora behind them are
// ours, so the shape is the whole of what the two tables promise each other -
// the renderer's `dynamic-variables.test.ts` pins the same 24 patterns.
struct GeneratorShape {
    const char* name;
    const char* pattern;
};

// `Sat Mar 02 2019 09:09:26 GMT+0000 (Coordinated Universal Time)` - what
// JavaScript's `Date.prototype.toString` writes, which is how Postman documents
// its three date generators.
constexpr const char* JS_DATE_PATTERN =
R"(^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) )"
R"(\d{2} \d{4} \d{2}:\d{2}:\d{2} GMT\+0000 \(Coordinated Universal Time\)$)";

const std::vector<GeneratorShape>& generator_shapes () {
    static const std::vector<GeneratorShape> shapes = {
        { "$randomPhoneNumber", R"(^\d{3}-\d{3}-\d{4}$)" },
        { "$randomCity", R"(^[A-Za-z]+( [A-Za-z]+)*$)" },
        { "$randomStreetAddress", R"(^\d{3,4} [A-Za-z]+ [A-Za-z]+$)" },
        { "$randomCountry", R"(^[A-Za-z][A-Za-z '-]*$)" },
        { "$randomCountryCode", R"(^[A-Z]{2}$)" },
        { "$randomDatePast", JS_DATE_PATTERN },
        { "$randomDateFuture", JS_DATE_PATTERN },
        { "$randomDateRecent", JS_DATE_PATTERN },
        { "$randomWord", R"(^[a-z]+$)" },
        { "$randomWords", R"(^[a-z]+( [a-z]+){2,4}$)" },
        { "$randomLoremWord", R"(^[a-z]+$)" },
        { "$randomLoremWords", R"(^[a-z]+( [a-z]+){2}$)" },
        { "$randomLoremSentence", R"(^[A-Z][a-z]*( [a-z]+){3,8}\.$)" },
        { "$randomLoremSentences",
        R"(^[A-Z][a-z]*( [a-z]+){3,8}\.( [A-Z][a-z]*( [a-z]+){3,8}\.){1,5}$)" },
        { "$randomLoremParagraph",
        R"(^[A-Z][a-z]*( [a-z]+){3,8}\.( [A-Z][a-z]*( [a-z]+){3,8}\.){2,4}$)" },
        { "$randomColor", R"(^[a-z]+$)" },
        { "$randomHexColor", R"(^#[0-9a-f]{6}$)" },
        { "$randomUserAgent", R"(^Mozilla/5\.0 \(.+\).*$)" },
        // The reserved example space, not Postman's live-looking `gracie.biz`.
        { "$randomDomainName", R"(^[a-z]+\.(example\.(com|org|net)|test\.dev)$)" },
        { "$randomAbbreviation", R"(^[A-Z]{3,4}$)" },
        { "$randomPrice", R"(^\d{1,4}\.\d{2}$)" },
        { "$randomCurrencyCode", R"(^[A-Z]{3}$)" },
        { "$randomProductName", R"(^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$)" },
        { "$randomJobTitle", R"(^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$)" },
    };
    return shapes;
}

TEST (DynamicVariables, EveryAddedGeneratorMatchesItsDocumentedShape) {
    const vayu::http::VariableValues no_vars;
    const auto& names = vayu::http::dynamic_variable_names ();
    ASSERT_FALSE (generator_shapes ().empty ())
    << "the shape table scanned nothing";

    for (const auto& shape : generator_shapes ()) {
        EXPECT_NE (std::find (names.begin (), names.end (), shape.name), names.end ())
        << shape.name << " is pinned here but is not in the table";
        const std::regex expected (shape.pattern);
        // Sampled rather than called once: every one of these draws from a list
        // or an alphabet, so a single call reads one element of it.
        for (int i = 0; i < 30; ++i) {
            const std::string value = vayu::http::resolve_template (
            std::string ("{{") + shape.name + "}}", no_vars);
            EXPECT_TRUE (std::regex_match (value, expected))
            << shape.name << " produced " << value;
        }
    }
}

TEST (DynamicVariables, EveryAddedGeneratorVariesPerOccurrence) {
    // The shape test above would pass a generator that answered one fixed,
    // pattern-conforming string forever - a `pick` hoisted out of its lambda and
    // evaluated once at table construction reads exactly like a working one.
    // What separates them is that the value moves. Two draws are not enough for
    // that (a small corpus repeats), so this asks 30 draws for two distinct
    // answers: the least-varied generator here draws from five, which makes an
    // all-identical run of 30 a 5^-29 event rather than a flake.
    const vayu::http::VariableValues no_vars;
    for (const auto& shape : generator_shapes ()) {
        std::set<std::string> seen;
        for (int i = 0; i < 30; ++i) {
            seen.insert (vayu::http::resolve_template (
            std::string ("{{") + shape.name + "}}", no_vars));
        }
        EXPECT_GT (seen.size (), 1u) << shape.name << " answered one value 30 times";
    }
}

TEST (DynamicVariables, ThePriceStaysInsidePostmansDocumentedRange) {
    const vayu::http::VariableValues no_vars;
    for (int i = 0; i < 50; ++i) {
        const double value =
        std::stod (vayu::http::resolve_template ("{{$randomPrice}}", no_vars));
        EXPECT_GE (value, 0.0);
        EXPECT_LE (value, 1000.0);
    }
}

TEST (DynamicVariables, TheThreeDatesFallOnTheSidesOfNowTheirNamesClaim) {
    // The shape test above cannot tell the three apart - they write the same
    // string - so what separates them is asserted here, by parsing the value
    // back. A past date in the future is the failure this catches.
    const vayu::http::VariableValues no_vars;
    constexpr std::time_t kWeek = std::time_t{ 7 } * 24 * 60 * 60;
    const auto now =
    std::chrono::system_clock::to_time_t (std::chrono::system_clock::now ());
    const auto parse = [] (const std::string& rendered) {
        std::tm parts{};
        std::istringstream in (rendered);
        in >> std::get_time (&parts, "%a %b %d %Y %H:%M:%S");
        EXPECT_FALSE (in.fail ()) << rendered;
        return utc_time_from (parts);
    };

    for (int i = 0; i < 20; ++i) {
        const auto past =
        parse (vayu::http::resolve_template ("{{$randomDatePast}}", no_vars));
        const auto future =
        parse (vayu::http::resolve_template ("{{$randomDateFuture}}", no_vars));
        const auto recent =
        parse (vayu::http::resolve_template ("{{$randomDateRecent}}", no_vars));
        EXPECT_LT (past, now);
        EXPECT_GT (future, now);
        EXPECT_LT (recent, now);
        // Recent is the past year's last week, which is what makes it a
        // different generator rather than a second `$randomDatePast`.
        EXPECT_GE (recent, now - kWeek - 1);
    }
}

// --- DB-backed composition ---------------------------------------------------

class RequestComposerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_request_composer.db";

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

    void seed_collection (const std::string& id,
    const std::string& parent_id,
    const std::string& variables = "",
    const std::string& auth      = "",
    const std::string& pre       = "",
    const std::string& post      = "") {
        vayu::db::Collection col;
        col.id = id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.name                = "Collection " + id;
        col.variables           = variables;
        col.auth                = auth;
        col.pre_request_script  = pre;
        col.post_request_script = post;
        col.order               = 0;
        col.created_at          = 1;
        col.updated_at          = 1;
        db_->create_collection (col);
    }

    void seed_environment (const std::string& id, const std::string& variables) {
        vayu::db::Environment env;
        env.id         = id;
        env.name       = "Env " + id;
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    vayu::db::Request make_request (const std::string& id, const std::string& collection_id) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::POST;
        r.url           = "https://{{host}}/api/{{path}}";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        return r;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RequestComposerTest, CollectionChainIsRootFirstAndCycleGuarded) {
    seed_collection ("root", "");
    seed_collection ("mid", "root");
    seed_collection ("leaf", "mid");
    auto chain = vayu::http::collection_chain (*db_, "leaf");
    ASSERT_EQ (chain.size (), 3u);
    EXPECT_EQ (chain[0].id, "root");
    EXPECT_EQ (chain[1].id, "mid");
    EXPECT_EQ (chain[2].id, "leaf");

    // A parent cycle terminates instead of hanging under the DB mutex.
    seed_collection ("a", "b");
    seed_collection ("b", "a");
    auto cyclic = vayu::http::collection_chain (*db_, "a");
    EXPECT_EQ (cyclic.size (), 2u);

    EXPECT_TRUE (vayu::http::collection_chain (*db_, "missing").empty ());
    EXPECT_TRUE (vayu::http::collection_chain (*db_, "").empty ());
}

TEST_F (RequestComposerTest, InheritWalksLeafToRootAndNoauthTerminates) {
    seed_collection ("root", "", "", R"({"mode":"bearer","token":"root-token"})");
    seed_collection ("mid", "root", "", R"({"mode":"none"})");
    seed_collection ("leaf", "mid", "", "");

    // `none` (and an absent auth) step over; the nearest concrete auth wins.
    auto chain = vayu::http::collection_chain (*db_, "leaf");
    auto auth  = vayu::http::resolve_inherited_auth (chain);
    ASSERT_TRUE (auth.is_object ());
    EXPECT_EQ (auth["token"], "root-token");

    // An explicit noauth between leaf and that auth ends the walk: "send
    // nothing" is a different answer from "nobody configured any".
    seed_collection ("root2", "", "", R"({"mode":"bearer","token":"root2-token"})");
    seed_collection ("blocker", "root2", "", R"({"mode":"noauth"})");
    seed_collection ("leaf2", "blocker", "", "");
    auto blocked =
    vayu::http::resolve_inherited_auth (vayu::http::collection_chain (*db_, "leaf2"));
    EXPECT_TRUE (blocked.is_null ());

    EXPECT_TRUE (vayu::http::resolve_inherited_auth ({}).is_null ());
}

TEST_F (RequestComposerTest, ComposesASavedRequestById) {
    seed_collection ("root", "",
    R"({"host":{"value":"root.test","enabled":true},"path":{"value":"root-path","enabled":true}})",
    R"({"mode":"bearer","token":"{{token}}"})", "console.log('root pre');",
    "console.log('root post');");
    seed_collection ("leaf", "root",
    R"({"path":{"value":"leaf-path","enabled":true},"token":{"value":"leaf-token","enabled":true}})",
    "", "", "console.log('leaf post');");
    seed_environment ("env_1", R"({"host":{"value":"env.test","enabled":true}})");

    auto r = make_request ("req_1", "leaf");
    r.headers = R"([{"key":"X-Token","value":"{{token}}","enabled":true},{"key":"X-Off","value":"nope","enabled":false},{"key":"","value":"dropped"}])";
    r.body = R"({"mode":"json","content":"{\"host\":\"{{host}}\"}"})";
    r.auth = R"({"mode":"inherit"})";
    r.pre_request_script  = "console.log('own pre');";
    r.post_request_script = "";
    r.follow_redirects    = false;
    r.max_redirects       = 3;
    r.http_version        = "http2";
    r.verify_ssl          = false;
    db_->save_request (r);

    auto [status, payload] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_1" } });
    ASSERT_EQ (status, 200) << payload.dump ();

    // Variables: environment > chain leaf > chain root.
    EXPECT_EQ (payload["url"], "https://env.test/api/leaf-path");
    EXPECT_EQ (payload["method"], "POST");

    // Headers: enabled-only, empty keys dropped, values resolved.
    EXPECT_EQ (payload["headers"], (json{ { "X-Token", "leaf-token" } }));

    // Body content resolved.
    EXPECT_EQ (payload["body"]["mode"], "json");
    EXPECT_EQ (payload["body"]["content"], "{\"host\":\"env.test\"}");

    // Inherit resolved through the chain to root's bearer, then its
    // {{token}} resolved - the walk and the substitution compose.
    EXPECT_EQ (payload["auth"]["mode"], "bearer");
    EXPECT_EQ (payload["auth"]["token"], "leaf-token");

    // Script parts: chain root->leaf then the request's own, blanks dropped.
    ASSERT_EQ (payload["preRequestScripts"].size (), 2u);
    EXPECT_EQ (payload["preRequestScripts"][0]["origin"], "collection");
    EXPECT_EQ (payload["preRequestScripts"][0]["id"], "root");
    EXPECT_EQ (payload["preRequestScripts"][1]["origin"], "request");
    EXPECT_EQ (payload["preRequestScripts"][1]["script"], "console.log('own pre');");
    ASSERT_EQ (payload["postRequestScripts"].size (), 2u);
    EXPECT_EQ (payload["postRequestScripts"][0]["id"], "root");
    EXPECT_EQ (payload["postRequestScripts"][1]["id"], "leaf");

    // Execution options always emitted from the stored row.
    EXPECT_EQ (payload["followRedirects"], false);
    EXPECT_EQ (payload["maxRedirects"], 3);
    EXPECT_EQ (payload["httpVersion"], "http2");
    // Never elided at the default, and this one for a stronger reason than the
    // rest: the engine verifies unless told otherwise, so a dropped `false`
    // would verify the certificate the user turned verification off for
    // (issue #706).
    ASSERT_TRUE (payload.contains ("verifySSL"));
    EXPECT_EQ (payload["verifySSL"], false);

    // Ids echoed so the composed payload can be POSTed to /execute unchanged.
    EXPECT_EQ (payload["requestId"], "req_1");
    EXPECT_EQ (payload["environmentId"], "env_1");
}

TEST_F (RequestComposerTest, StoredRequestWithoutAuthBlobDefaultsToInherit) {
    seed_collection ("col", "", "", R"({"mode":"apikey","key":"X-Key","value":"k"})");
    auto r = make_request ("req_1", "col");
    r.url  = "https://example.test";
    r.auth = ""; // rows saved before the auth column's default existed
    db_->save_request (r);

    auto [status, payload] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["auth"]["mode"], "apikey");
}

TEST_F (RequestComposerTest, RequestLevelNoauthAndNoneSendNothing) {
    seed_collection ("col", "", "", R"({"mode":"bearer","token":"t"})");
    for (const char* mode : { R"({"mode":"noauth"})", R"({"mode":"none"})" }) {
        auto r = make_request ("req_1", "col");
        r.url  = "https://example.test";
        r.auth = mode;
        db_->save_request (r);
        auto [status, payload] =
        vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
        ASSERT_EQ (status, 200);
        EXPECT_FALSE (payload.contains ("auth")) << mode;
    }
}

TEST_F (RequestComposerTest, ComposesAnInlineRequestAgainstAScope) {
    seed_collection ("col", "", R"({"host":{"value":"col.test","enabled":true}})",
    R"({"mode":"bearer","token":"{{secret}}"})");
    seed_environment ("env_1", R"({"secret":{"value":"s3cr3t","enabled":true}})");

    const json body = { { "request",
                        { { "method", "get" }, { "url", "https://{{host}}/x" },
                        { "headers", { { "X-{{host}}", "{{secret}}" } } },
                        { "body", { { "mode", "text" }, { "content", "v={{secret}}" } } },
                        { "auth", { { "mode", "inherit" } } },
                        { "preRequestScripts",
                        json::array ({ { { "origin", "request" },
                        { "script", "pm.request; // {{not-touched}}" } } }) },
                        { "followRedirects", true } } },
        { "collectionId", "col" }, { "environmentId", "env_1" } };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["method"], "GET");
    EXPECT_EQ (payload["url"], "https://col.test/x");
    EXPECT_EQ (payload["headers"], (json{ { "X-col.test", "s3cr3t" } }));
    EXPECT_EQ (payload["body"]["content"], "v=s3cr3t");
    // Inline inherit resolves through the supplied collection scope, and the
    // winning block's own {{vars}} resolve (strictly before any OAuth cache
    // key could be derived from it - D10).
    EXPECT_EQ (payload["auth"]["token"], "s3cr3t");
    // Scripts pass through untouched - never interpolated (D16).
    EXPECT_EQ (payload["preRequestScripts"][0]["script"], "pm.request; // {{not-touched}}");
    EXPECT_EQ (payload["followRedirects"], true);
    EXPECT_EQ (payload["environmentId"], "env_1");
}

// Issue #995: `deferDynamicVariables` is what a client composing for a run
// says, and it reaches every field of the request half.
TEST_F (RequestComposerTest, DeferDynamicVariablesKeepsTheTokensForTheRunToBind) {
    seed_collection ("col", "", "", R"({"mode":"basic","username":"u-{{$guid}}","password":"p"})");

    const json request = { { "method", "post" },
        { "url", "https://example.test/{{$randomUUID}}" },
        { "headers", { { "X-Key", "{{$guid}}" } } },
        { "body", { { "mode", "json" }, { "content", R"({"id":"{{$guid}}"})" } } },
        { "auth", { { "mode", "inherit" } } } };

    auto [status, deferred] = vayu::http::compose_request_core (*db_,
    json{ { "request", request }, { "collectionId", "col" },
    { "deferDynamicVariables", true } });
    ASSERT_EQ (status, 200) << deferred.dump ();
    EXPECT_EQ (deferred["url"], "https://example.test/{{$randomUUID}}");
    EXPECT_EQ (deferred["headers"]["X-Key"], "{{$guid}}");
    EXPECT_EQ (deferred["body"]["content"], R"({"id":"{{$guid}}"})");
    // A credential is *encoded* when the request is built, so there is no later
    // moment for a bind to reach it: composition generates it here, once, and
    // says so (issue #1055 carries the deferral that would lift this).
    EXPECT_NE (deferred["auth"]["username"], "u-{{$guid}}");

    // Without the field, the same payload composes exactly as it always did -
    // the mutation check for every assertion above.
    auto [plain_status, composed] = vayu::http::compose_request_core (
    *db_, json{ { "request", request }, { "collectionId", "col" } });
    ASSERT_EQ (plain_status, 200) << composed.dump ();
    EXPECT_NE (composed["url"], "https://example.test/{{$randomUUID}}");
    EXPECT_NE (composed["headers"]["X-Key"], "{{$guid}}");
    EXPECT_NE (composed["body"]["content"], R"({"id":"{{$guid}}"})");
}

TEST_F (RequestComposerTest, DeferDynamicVariablesMustBeABoolean) {
    auto [status, payload] = vayu::http::compose_request_core (*db_,
    json{ { "request", { { "url", "https://example.test" } } },
    { "deferDynamicVariables", "yes" } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (payload["error"]["code"], "invalid_compose_request");
}

// A form body carries its content as `fields`, so resolution has to reach
// inside them - the composer's `content` pass alone would leave a form body
// full of literal `{{...}}` on the wire. The engine only started *sending*
// these bodies with issue #381; this pins the half of the pipeline that was
// already right, so the two cannot drift apart.
TEST_F (RequestComposerTest, ResolvesVariablesInsideFormFields) {
    seed_collection ("col", "", R"({"host":{"value":"col.test","enabled":true}})");
    seed_environment ("env_1", R"({"secret":{"value":"s3cr3t","enabled":true}})");

    const json body = {
        { "request",
        { { "method", "post" }, { "url", "https://{{host}}/x" },
        { "body",
        { { "mode", "x-www-form-urlencoded" },
        { "fields",
        json::array ({ { { "key", "at-{{host}}" }, { "value", "{{secret}}" }, { "enabled", true } },
        { { "key", "off" }, { "value", "{{secret}}" }, { "enabled", false } } }) } } } } },
        { "collectionId", "col" }, { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["body"]["mode"], "x-www-form-urlencoded");
    EXPECT_EQ (payload["body"]["fields"][0]["key"], "at-col.test");
    EXPECT_EQ (payload["body"]["fields"][0]["value"], "s3cr3t");
    // A disabled field is still resolved and still carried: it is dropped at
    // the wire, not during composition, so switching it back on in the UI
    // needs no re-compose.
    EXPECT_EQ (payload["body"]["fields"][1]["value"], "s3cr3t");
    EXPECT_EQ (payload["body"]["fields"][1]["enabled"], false);
}

// A file part's path is as templatable as any other field - a fixture
// directory is exactly what an environment variable holds - and an unresolved
// `{{...}}` reaching the transfer would be opened as a literal filename and
// refused. The declared filename and per-part Content-Type resolve with it.
TEST_F (RequestComposerTest, ResolvesVariablesInsideAFilePart) {
    seed_environment ("env_1", R"({"fixtures":{"value":"/data/fixtures","enabled":true},
                                   "ext":{"value":"png","enabled":true}})");

    const json body = {
        { "request",
        { { "method", "post" }, { "url", "https://x.test/upload" },
        { "body",
        { { "mode", "form-data" },
        { "fields",
        json::array ({ { { "key", "avatar" }, { "type", "file" },
        { "src", "{{fixtures}}/avatar.{{ext}}" }, { "fileName", "avatar.{{ext}}" },
        { "contentType", "image/{{ext}}" }, { "enabled", true } } }) } } } } },
        { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    const auto& field = payload["body"]["fields"][0];
    EXPECT_EQ (field["src"], "/data/fixtures/avatar.png");
    EXPECT_EQ (field["fileName"], "avatar.png");
    EXPECT_EQ (field["contentType"], "image/png");
    EXPECT_EQ (field["type"], "file");
}

// Issue #1009's rule 1, at the layer that decides what is *sent*: a name no
// scope defines leaves its token on the wire instead of a hole. Every field
// composition resolves, because the fixture pins `resolve_template` and this
// pins the fields wired to it - the URL is where the divergence shows worst
// (`https:///x` is a URL nobody wrote), and a form field is the one that
// reaches resolution through a second function.
TEST_F (RequestComposerTest, AnUnknownNameReachesTheWireAsItsTokenNotAsAHole) {
    seed_environment ("env_1", R"({"known":{"value":"k","enabled":true},
                                   "blank":{"value":"","enabled":true}})");

    const json body = {
        { "request",
        { { "method", "post" }, { "url", "https://{{host}}/x?k={{known}}" },
        { "headers", { { "X-Note", "{{missing}}" }, { "X-Known", "{{known}}" } } },
        { "body",
        { { "mode", "form-data" },
        { "fields", json::array ({ { { "key", "f" }, { "value", "{{gone}}" }, { "enabled", true } } }) } } } } },
        { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["url"], "https://{{host}}/x?k=k");
    EXPECT_EQ (payload["headers"]["X-Note"], "{{missing}}");
    EXPECT_EQ (payload["headers"]["X-Known"], "k");
    EXPECT_EQ (payload["body"]["fields"][0]["value"], "{{gone}}");

    // Defined-and-empty is still empty: the rule is about a name nothing
    // answers, and erasing that distinction would make an intentionally blank
    // variable send its own token.
    const json blank = { { "request", { { "method", "get" }, { "url", "https://x.test/?b={{blank}}" } } },
        { "environmentId", "env_1" } };
    auto [blank_status, blank_payload] = vayu::http::compose_request_core (*db_, blank);
    ASSERT_EQ (blank_status, 200) << blank_payload.dump ();
    EXPECT_EQ (blank_payload["url"], "https://x.test/?b=");
}

// Issue #1009's rule 2. The layering under test is the one every imported
// Postman environment is written with, and the cycle is the reason the walk is
// bounded rather than run to a fixpoint.
TEST_F (RequestComposerTest, AValueCarryingTokensResolvesThroughThemAndStopsOnACycle) {
    seed_collection ("col", "",
    R"({"baseUrl":{"value":"{{protocol}}://{{host}}","enabled":true}})");
    seed_environment ("env_1", R"({"protocol":{"value":"https","enabled":true},
                                   "host":{"value":"api.example.test","enabled":true},
                                   "a":{"value":"A{{b}}","enabled":true},
                                   "b":{"value":"B{{a}}","enabled":true}})");

    const json body = { { "request",
                        { { "method", "get" }, { "url", "{{baseUrl}}/orders" },
                        { "headers", { { "X-Cycle", "{{a}}" } } } } },
        { "collectionId", "col" }, { "environmentId", "env_1" } };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["url"], "https://api.example.test/orders");
    // A name already being expanded is left written as it stands, so the
    // composition terminates and the request says where it gave up.
    EXPECT_EQ (payload["headers"]["X-Cycle"], "AB{{a}}");
}

// The header refusal reads *substituted values*, and since #1009 a value can
// arrive through another variable. The refusal has to name the variable that
// carried the bytes, not the one the header spells - naming the outer one
// would send an author looking at a value that is fine.
TEST_F (RequestComposerTest, ANestedValueCarryingCrlfIsRefusedByTheNameThatCarriesIt) {
    seed_environment ("env_1", R"({"outer":{"value":"pre-{{inner}}","enabled":true},
                                   "inner":{"value":"ok\r\nX-Admin: true","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "X-Note", "{{outer}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "unsendable_header");
    const auto message = payload["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("{{inner}}"), std::string::npos) << message;
}

TEST_F (RequestComposerTest, InlineOverlayReplacesStoredFieldsAndStillResolves) {
    seed_collection ("col", "", R"({"host":{"value":"stored.test","enabled":true}})");
    auto r = make_request ("req_1", "col");
    db_->save_request (r);

    const json body        = { { "requestId", "req_1" },
               { "request", { { "url", "https://{{host}}/overridden" }, { "method", "put" } } } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["url"], "https://stored.test/overridden");
    EXPECT_EQ (payload["method"], "PUT");
    EXPECT_EQ (payload["requestId"], "req_1"); // stored identity survives overlay
}

TEST_F (RequestComposerTest, OAuth2ConfigIsResolvedBeforeAnyCacheKeyCanBe) {
    seed_collection ("col", "", "");
    seed_environment ("env_a", R"({"idp":{"value":"https://a.idp.test","enabled":true}})");
    seed_environment ("env_b", R"({"idp":{"value":"https://b.idp.test","enabled":true}})");
    auto r = make_request ("req_1", "col");
    r.url  = "https://example.test";
    r.auth = R"({"mode":"oauth2","config":{"grantType":"client_credentials","accessTokenUrl":"{{idp}}/token","clientId":"cid"}})";
    db_->save_request (r);

    auto [sa, pa] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_a" } });
    auto [sb, pb] = vayu::http::compose_request_core (
    *db_, json{ { "requestId", "req_1" }, { "environmentId", "env_b" } });
    ASSERT_EQ (sa, 200);
    ASSERT_EQ (sb, 200);
    // Two environments whose configs differ only through {{vars}} compose to
    // different concrete configs, so their token cache keys cannot collide.
    EXPECT_EQ (pa["auth"]["config"]["accessTokenUrl"], "https://a.idp.test/token");
    EXPECT_EQ (pb["auth"]["config"]["accessTokenUrl"], "https://b.idp.test/token");
}

TEST_F (RequestComposerTest, ComposedOutputIsNeverInterpolatedTwice) {
    // A body whose *resolved* content legitimately contains {{...}} (posting a
    // Postman collection, a Handlebars template) must survive composition
    // exactly once - and because /execute never interpolates, sending the
    // composed payload cannot resolve it again (D12).
    seed_environment ("env_1", R"({"tpl":{"value":"{{name}} says hi","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "POST" }, { "url", "https://example.test" },
                               { "body", { { "mode", "text" }, { "content", "{{tpl}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["body"]["content"], "{{name}} says hi");
}

TEST_F (RequestComposerTest, UnknownRequestIdIsADefinitive404) {
    auto [status, payload] =
    vayu::http::compose_request_core (*db_, json{ { "requestId", "req_missing" } });
    EXPECT_EQ (status, 404);
    EXPECT_EQ (payload["error"]["code"], "request_not_found");
    EXPECT_NE (
    payload["error"]["message"].get<std::string> ().find ("req_missing"), std::string::npos);
}

TEST_F (RequestComposerTest, MalformedBodiesAre400sInTheNestedShape) {
    for (const auto& body : { json::object (), json{ { "requestId", 42 } },
         json{ { "request", "nope" } }, json (nullptr), json ("string") }) {
        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (payload["error"]["code"], "invalid_compose_request") << body.dump ();
        EXPECT_TRUE (payload["error"]["message"].is_string ()) << body.dump ();
    }
}

// --- Bound data columns (#1007) ---------------------------------------------
//
// Postman binds a dataset's columns to bare names, so an imported data-driven
// collection spells them `{{username}}`. Composition cannot substitute one - a
// plan is composed once and a row is bound per iteration - so what it does is
// the same thing it does for the reserved spelling: leave the token written as
// it stands, for `core::apply_data_template` to join. The field that says which
// names those are is `dataColumns`.
//
// Mutation-check for the first: drop the `is_bound_column_name` arm of
// `lookup_variable` and the request goes out carrying the environment's value
// where this iteration's cell belonged.

TEST_F (RequestComposerTest, ABoundColumnOutranksASameNamedVariableByBeingDeferred) {
    seed_environment ("env_1", R"({"username":{"value":"from-the-environment","enabled":true},
                                   "host":{"value":"api.test","enabled":true}})");

    const json request = { { "method", "post" }, { "url", "https://{{host}}/u/{{username}}" },
        { "headers", { { "X-User", "{{username}}" } } },
        { "body", { { "mode", "raw" }, { "content", R"({"who":"{{username}}"})" } } },
        { "auth", { { "mode", "basic" }, { "username", "{{username}}" }, { "password", "s3cret" } } } };

    const json bound = { { "request", request }, { "environmentId", "env_1" },
        { "dataColumns", json::array ({ "username" }) } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, bound);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["url"], "https://api.test/u/{{username}}");
    EXPECT_EQ (payload["headers"]["X-User"], "{{username}}");
    EXPECT_EQ (payload["body"]["content"], R"({"who":"{{username}}"})");
    EXPECT_EQ (payload["auth"]["username"], "{{username}}");

    // The same payload with no dataset behind it resolves the name from the
    // environment, exactly as it always did - the rule is "while a row is
    // bound", and this is the other way round it has to be read.
    const json unbound = { { "request", request }, { "environmentId", "env_1" } };
    auto [plain_status, plain_payload] = vayu::http::compose_request_core (*db_, unbound);
    ASSERT_EQ (plain_status, 200) << plain_payload.dump ();
    EXPECT_EQ (plain_payload["url"], "https://api.test/u/from-the-environment");
    EXPECT_EQ (plain_payload["headers"]["X-User"], "from-the-environment");
    EXPECT_EQ (plain_payload["auth"]["username"], "from-the-environment");
}

TEST_F (RequestComposerTest, ABoundColumnDefersOnlyItsOwnNameAndNotTheReservedSpelling) {
    seed_environment ("env_1", R"({"username":{"value":"env","enabled":true},
                                   "region":{"value":"eu","enabled":true}})");
    const json body = { { "request",
                        { { "method", "get" },
                        { "url", "https://api.test/{{username}}/{{region}}/{{data.id}}" } } },
        { "environmentId", "env_1" }, { "dataColumns", json::array ({ "username" }) } };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    // The bound column deferred, the ordinary variable resolved, and the
    // reserved spelling still left alone by its own older rule.
    EXPECT_EQ (payload["url"], "https://api.test/{{username}}/eu/{{data.id}}");
}

TEST_F (RequestComposerTest, DataColumnsMustBeAListOfNames) {
    // A malformed field is a refusal rather than a silent empty set: a caller
    // that meant to bind columns and is quietly composed without them sends the
    // environment's values for a whole run and is told nothing.
    for (const json& columns : { json ("username"), json ({ { "username", true } }),
         json::array ({ 7 }), json::array ({ "" }) }) {
        const json body = { { "request", { { "method", "get" }, { "url", "https://api.test/" } } },
            { "dataColumns", columns } };
        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (payload["error"]["code"], "invalid_compose_request") << body.dump ();
    }

    // Absent and null both mean "no dataset", which is what every client that
    // has never heard of the field sends.
    for (const json& body :
    { json{ { "request", { { "method", "get" }, { "url", "https://api.test/" } } } },
    json{ { "request", { { "method", "get" }, { "url", "https://api.test/" } } },
    { "dataColumns", nullptr } } }) {
        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        EXPECT_EQ (status, 200) << payload.dump ();
    }
}

// --- Header forgery through a substituted variable (#738) --------------------
//
// #732 closed the same forgery from a bound `{{data.column}}`; an environment,
// collection or global variable reached `build_request_header_list` with no
// check at all. Composition is the layer that still knows *which* variable
// carried the byte, so it is the layer that can say so.
//
// Mutation-check for all four below: drop the `refusal` check in the headers
// loop of `compose_request_core` and every one of them fails - the first three
// on the status, the fourth on nothing (it must keep passing).

TEST_F (RequestComposerTest, AVariableCarryingCrlfIntoAHeaderValueIsRefusedByName) {
    seed_environment ("env_1", R"({"note":{"value":"ok\r\nX-Admin: true","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "X-Note", "{{note}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "unsendable_header");
    const auto message = payload["error"]["message"].get<std::string> ();
    // Naming the variable is the whole reason this layer exists beside the
    // pre-send gate - the gate can only name the header.
    EXPECT_NE (message.find ("{{note}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("line break"), std::string::npos) << message;
}

// A bare LF and a bare CR end the line as surely as the pair, and the header
// *name* is as forgeable as its value.
TEST_F (RequestComposerTest, EitherByteAndEitherHalfOfTheHeaderIsRefused) {
    seed_environment ("env_1", R"({"lf":{"value":"a\nb","enabled":true},
                                   "cr":{"value":"a\rb","enabled":true}})");
    const auto compose = [this] (const json& headers) {
        return vayu::http::compose_request_core (*db_,
        json{ { "request", { { "method", "GET" }, { "url", "https://x.test/" }, { "headers", headers } } },
        { "environmentId", "env_1" } });
    };

    for (const json& headers : { json{ { "X-A", "{{lf}}" } }, json{ { "X-A", "{{cr}}" } },
         json{ { "X-{{lf}}", "v" } }, json{ { "X-{{cr}}", "v" } } }) {
        auto [status, payload] = compose (headers);
        EXPECT_EQ (status, 400) << headers.dump ();
        EXPECT_EQ (payload["error"]["code"], "unsendable_header") << headers.dump ();
    }
}

// A NUL forges nothing - it truncates, because the engine hands
// `curl_slist_append` a C string. Same class of quiet wrong request, so the
// same refusal, with its own clause (#738 item 3).
TEST_F (RequestComposerTest, AVariableCarryingANulIntoAHeaderIsRefusedToo) {
    seed_environment ("env_1", R"({"nul":{"value":"ok\u0000dropped","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "X-Note", "{{nul}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    const auto message = payload["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("{{nul}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("NUL"), std::string::npos) << message;
}

// The refusal is scoped to the field that has a line terminator: the same
// variable is ordinary text in a URL, a body and a form field, and composing
// it there must stay a 200 carrying the bytes unchanged. This is the twin of
// PR #737's `TheSameCellIsFineEverywhereElse` - the two paths agree on where
// the rule applies, not just on what it refuses.
TEST_F (RequestComposerTest, TheSameVariableIsFineEverywhereElse) {
    seed_environment ("env_1", R"({"note":{"value":"ok\r\nX-Admin: true","enabled":true}})");
    const json body = {
        { "request",
        { { "method", "POST" }, { "url", "https://x.test/{{note}}" },
        { "body",
        { { "mode", "x-www-form-urlencoded" },
        { "fields", json::array ({ { { "key", "k" }, { "value", "{{note}}" }, { "enabled", true } } }) } } } } },
        { "environmentId", "env_1" }
    };

    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["url"], "https://x.test/ok\r\nX-Admin: true");
    EXPECT_EQ (payload["body"]["fields"][0]["value"], "ok\r\nX-Admin: true");
}

// A CR the user typed into the header themselves is not a variable's doing, so
// composition must not name one for it. The request is still refused - by the
// pre-send gate, which names the header instead (see curl_utils_test).
TEST_F (RequestComposerTest, ALiteralLineBreakInTheHeaderIsNotBlamedOnAVariable) {
    seed_environment ("env_1", R"({"ok":{"value":"fine","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "X-Note", "typed\r\nX-Admin: true {{ok}}" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["headers"]["X-Note"], "typed\r\nX-Admin: true fine");
}

// The twin of `TheBindRuleIsTheOneSharedHeaderTextRule` in the scenario-data
// suite: both layers are pinned to the same predicate over the same table, so
// the data path and the variable path cannot drift on what a header may hold.
// The composer answers for the NUL as well, which the bind path (older, #732)
// leaves to the gate.
TEST_F (RequestComposerTest, TheComposerRuleIsTheOneSharedHeaderTextRule) {
    const std::vector<std::string> values = { "plain", "a b", "a\tb", "a: b",
        "a\nb", "a\rb", "a\r\nb", std::string ("a\0b", 3) };
    for (const std::string& value : values) {
        seed_environment ("env_1",
        json{ { "v", { { "value", value }, { "enabled", true } } } }.dump ());
        const json body = { { "request",
                            { { "method", "GET" }, { "url", "https://x.test/" },
                            { "headers", { { "X-Note", "{{v}}" } } } } },
            { "environmentId", "env_1" } };

        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        const bool refused     = vayu::http::ends_a_header_line (value) ||
        vayu::http::truncates_a_header_line (value);
        EXPECT_EQ (status, refused ? 400 : 200)
        << "value: " << json (value).dump () << " - " << payload.dump ();
    }
}

// --- Two header names that resolve to one (#1051) ----------------------------
//
// The sibling of the block above, and the other half of what a substituted
// header name can do: there a value *forges* a header, here a name *erases*
// one. The map the payload becomes holds one value per name, so the second of
// two names that resolve alike takes the first's place and the request goes out
// a header short - which nothing downstream can notice, the pre-send gate
// included. See `http/header_names.hpp`.
//
// Mutation-check for the four below: drop the `collision` check in
// `resolve_header_block` and the first three fail on the status, while the
// fourth must keep passing - it is the case the refusal deliberately leaves
// alone.

TEST_F (RequestComposerTest, TwoTemplatedHeaderNamesResolvingAlikeAreRefused) {
    seed_environment ("env_1",
    R"({"a":{"value":"X-Tenant","enabled":true},"b":{"value":"X-Tenant","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "{{a}}", "acme" }, { "{{b}}", "legacy" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "colliding_header_names");
    const auto message = payload["error"]["message"].get<std::string> ();
    // Both spellings as written, because either is the one the author may have
    // meant - composition names them and repairs neither.
    EXPECT_NE (message.find ("{{a}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("{{b}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("X-Tenant"), std::string::npos) << message;
}

TEST_F (RequestComposerTest, ATemplatedNameCollidingWithALiteralHeaderIsRefused) {
    seed_environment ("env_1", R"({"tenant_header":{"value":"X-Tenant","enabled":true}})");
    const json body = {
        { "request",
        { { "method", "GET" }, { "url", "https://x.test/" },
        { "headers", { { "{{tenant_header}}", "acme" }, { "X-Tenant", "legacy" } } } } },
        { "environmentId", "env_1" }
    };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "colliding_header_names");
    const auto message = payload["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("{{tenant_header}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("X-Tenant"), std::string::npos) << message;
}

// `Headers` compares names without case, so a name that differs from another
// only in case is not a second header - it is the same one, arriving instead of
// it. This is the case composition alone can catch: the payload it would answer
// 200 with carries both names as distinct JSON keys, and the header is lost
// later, where `deserialize_request` parses them into the map.
TEST_F (RequestComposerTest, TheHeaderNameCollisionIsJudgedWithoutCase) {
    seed_environment ("env_1", R"({"h":{"value":"authorization","enabled":true}})");
    const json body = {
        { "request",
        { { "method", "GET" }, { "url", "https://x.test/" },
        { "headers", { { "{{h}}", "Bearer new" }, { "Authorization", "Bearer old" } } } } },
        { "environmentId", "env_1" }
    };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "colliding_header_names");
}

// Which of two colliding names is walked first is not the author's to choose:
// a `nlohmann::json` object is keyed in sorted order, so the walk follows the
// *unresolved* text. A template almost always sorts last - `{` is above every
// character a header name ordinarily holds - which is why reproducing the
// other order at all takes a literal name reaching past it, and `~` is an
// ordinary header-name character. The rule is symmetric and this is the half
// the cases above cannot reach: the templated name got there first, and a
// literal collided into it.
TEST_F (RequestComposerTest, TheCollisionIsRefusedWhicheverNameResolvedFirst) {
    seed_environment ("env_1", R"({"suffix":{"value":"~Tenant","enabled":true}})");
    const json body        = { { "request",
                               { { "method", "GET" }, { "url", "https://x.test/" },
                               { "headers", { { "X{{suffix}}", "acme" }, { "X~Tenant", "legacy" } } } } },
               { "environmentId", "env_1" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    EXPECT_EQ (status, 400) << payload.dump ();
    EXPECT_EQ (payload["error"]["code"], "colliding_header_names");
    const auto message = payload["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("X{{suffix}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("X~Tenant"), std::string::npos) << message;
}

// Two names the author typed are two lines they can see side by side, and the
// later one has always won - a rule that is visible in the editor and is not
// this refusal's to change. Only a collision resolution *made* is invisible,
// which is the whole distinction (the same one the bind-time rule draws in
// `docs/engine/api-reference.md`).
TEST_F (RequestComposerTest, TwoNamesTheAuthorTypedAreNotThisRefusal) {
    seed_environment ("env_1", R"({"ok":{"value":"fine","enabled":true}})");
    const json body = {
        { "request",
        { { "method", "GET" }, { "url", "https://x.test/" },
        { "headers", { { "Authorization", "Bearer {{ok}}" }, { "authorization", "Bearer other" } } } } },
        { "environmentId", "env_1" }
    };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);

    ASSERT_EQ (status, 200) << payload.dump ();
    EXPECT_EQ (payload["headers"]["Authorization"], "Bearer fine");
    EXPECT_EQ (payload["headers"]["authorization"], "Bearer other");
}

TEST_F (RequestComposerTest, UnknownScopeIdsDegradeToAnEmptyScope) {
    const json body = { { "request", { { "method", "GET" }, { "url", "https://x.test/{{missing}}" } } },
        { "collectionId", "col_missing" }, { "environmentId", "env_missing" } };
    auto [status, payload] = vayu::http::compose_request_core (*db_, body);
    // What degrades is the *scope lookup* - an id naming nothing is an empty
    // scope rather than a refusal. The token it leaves behind is #1009's rule:
    // a name no scope defines is written as it stands.
    ASSERT_EQ (status, 200);
    EXPECT_EQ (payload["url"], "https://x.test/{{missing}}");
}

} // namespace
