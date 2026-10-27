// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// A script can check a body against a JSON Schema three ways:
// `pm.response.to.have.jsonSchema` (and `pm.expect(x).to.have.jsonSchema`),
// which run the engine's native draft-07 validator (`json_schema_failure`
// over `core/schema_validation.hpp`), or the shelf's ajv 6.12.5 and tv4 1.3.0
// (#2656). On the schemas all of them cover they must answer the same verdict,
// so a script ported from Postman does not pass on one and fail on another.
// `fixtures/json-schema-conformance.json` holds each datum's verdict, and
// the data they answer differently, each with both verdicts and the reason.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <string>

#include "library_call_config.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;
using nlohmann::json;

namespace {

const json& conformance_table () {
    static const json table = [] {
        const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
        "tests" / "fixtures" / "json-schema-conformance.json";
        std::ifstream in (path);
        if (!in.good ()) {
            ADD_FAILURE () << "fixture missing: " << path;
            return json::object ();
        }
        return json::parse (in);
    }();
    return table;
}

std::size_t datum_count (const json& cases) {
    std::size_t count = 0;
    for (const auto& c : cases) {
        count += c.at ("data").size ();
    }
    return count;
}

// Every datum of every case through ajv, tv4 (where the case is in its reach)
// and the native validator behind `pm.expect(value).to.have.jsonSchema`, in
// one execution so ajv is evaluated once. An AssertionError is a failed
// verdict; anything else the native check throws is reported as text, so a
// refused schema cannot read as a verdict.
constexpr const char* TABLE_SCRIPT = R"JS(
var Ajv = require('ajv');
var verdicts = CASES.map(function (c) {
    var validate = new Ajv().compile(c.schema);
    return c.data.map(function (d) {
        var native;
        try {
            pm.expect(d.value).to.have.jsonSchema(c.schema);
            native = true;
        } catch (e) {
            native = e.name === 'AssertionError' ? false : 'threw ' + e.name + ': ' + e.message;
        }
        return {
            ajv: validate(d.value),
            tv4: c.tv4 ? tv4.validate(d.value, c.schema) : null,
            native: native,
        };
    });
});
pm.environment.set('verdicts', JSON.stringify(verdicts));
)JS";

class ScriptJsonSchemaConformanceTest : public ::testing::Test {
    protected:
    /// The 47 cases compile every schema in ajv inside one script: 4.6 s on an
    /// idle Windows Debug build, over the 5 s default under ASan. The budget
    /// is a hang detector here, not a speed check.
    static vayu::runtime::ScriptConfig conformance_config () {
        auto config       = vayu::tests::library_call_config ();
        config.timeout_ms = 60'000;
        return config;
    }

    ScriptEngine engine{ conformance_config () };
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::GET;
        request.url          = "https://api.example.com/users";
        response.status_code = 200;
        response.headers     = { { "Content-Type", "application/json" } };
    }

    /// The JSON @p script stored under `verdicts`, with @p cases bound to CASES.
    json run_script (const json& cases, const char* script) {
        const auto result = engine.execute_test (
        "var CASES = " + cases.dump () + ";\n" + script, request, response, env);
        if (!result.success) {
            ADD_FAILURE () << result.error_message;
            return json::array ();
        }
        return json::parse (env["verdicts"].value);
    }
};

} // namespace

TEST_F (ScriptJsonSchemaConformanceTest, AjvTv4AndJsonSchemaAgreeOnEveryCase) {
    const json& cases = conformance_table ().value ("cases", json::array ());
    ASSERT_GE (cases.size (), 40u) << "the table holds the shared suite";

    const json verdicts = run_script (cases, TABLE_SCRIPT);
    ASSERT_EQ (verdicts.size (), cases.size ());
    std::size_t checked_by_tv4 = 0;
    for (std::size_t i = 0; i < cases.size (); ++i) {
        const json& c    = cases.at (i);
        const json& data = c.at ("data");
        ASSERT_EQ (verdicts.at (i).size (), data.size ()) << c.at ("name");
        for (std::size_t j = 0; j < data.size (); ++j) {
            const json& expected    = data.at (j).at ("valid");
            const json& verdict     = verdicts.at (i).at (j);
            const std::string where = c.at ("name").get<std::string> () +
            " on " + data.at (j).at ("value").dump ();
            EXPECT_EQ (verdict.at ("native"), expected) << "jsonSchema, " << where;
            EXPECT_EQ (verdict.at ("ajv"), expected) << "ajv, " << where;
            if (c.at ("tv4").get<bool> ()) {
                EXPECT_EQ (verdict.at ("tv4"), expected) << "tv4, " << where;
                ++checked_by_tv4;
            }
        }
    }
    EXPECT_GE (checked_by_tv4, 80u) << "tv4 ran the draft-04 part of the table";
}

// The same verdicts through `pm.response.to.have.jsonSchema`, against each
// datum as the response body. It is the native validator alone, so each
// execution loads no library.
TEST_F (ScriptJsonSchemaConformanceTest, ResponseJsonSchemaAnswersTheTablesVerdicts) {
    const json& cases = conformance_table ().value ("cases", json::array ());
    ASSERT_GE (datum_count (cases), 100u) << "the table holds the shared suite";

    for (const auto& c : cases) {
        for (const auto& datum : c.at ("data")) {
            response.body = datum.at ("value").dump ();
            const auto result =
            engine.execute_test ("pm.test('schema', function () "
                                 "{ pm.response.to.have.jsonSchema(" +
            c.at ("schema").dump () + "); });",
            request, response, env);
            const std::string where =
            c.at ("name").get<std::string> () + " on " + response.body;
            ASSERT_EQ (result.tests.size (), 1u) << where << ": " << result.error_message;
            EXPECT_EQ (result.tests[0].passed, datum.at ("valid").get<bool> ())
            << where << ": " << result.tests[0].error_message;
        }
    }
}

// The keywords the native validator does not evaluate (2019-09 and later, and
// OpenAPI's `nullable` and `discriminator`) are where the two part on
// purpose: jsonSchema refuses to pass on a schema it read only partly and
// names the keyword, while ajv 6 ignores a keyword it does not know, so its
// verdict leaves the keyword out (each row's datum is valid without it). None
// of them is a keyword ajv evaluates.
TEST_F (ScriptJsonSchemaConformanceTest, KeywordsJsonSchemaRefusesAreOnesAjvIgnores) {
    const json& rows = conformance_table ().value ("ignoredByAjv", json::array ());
    ASSERT_EQ (rows.size (), 13u)
    << "one row per keyword collect_unevaluated_keywords names";

    constexpr const char* SCRIPT = R"JS(
var Ajv = require('ajv');
var verdicts = CASES.map(function (row) {
    var message = '';
    try { pm.expect(row.value).to.have.jsonSchema(row.schema); } catch (e) { message = e.message; }
    var validate = new Ajv().compile(row.schema);
    return { ajv: validate(row.value), native: message };
});
pm.environment.set('verdicts', JSON.stringify(verdicts));
)JS";
    const json verdicts          = run_script (rows, SCRIPT);
    ASSERT_EQ (verdicts.size (), rows.size ());
    for (std::size_t i = 0; i < rows.size (); ++i) {
        const std::string keyword = rows.at (i).at ("keyword");
        const json& verdict       = verdicts.at (i);
        EXPECT_EQ (verdict.at ("ajv"), true) << keyword << ": ajv evaluated it";
        const std::string message = verdict.at ("native");
        EXPECT_NE (
        message.find ("keywords the draft-07 validator does not evaluate"), std::string::npos)
        << keyword << ": " << message;
        EXPECT_NE (message.find (keyword + " (1)"), std::string::npos)
        << keyword << ": " << message;
    }
}

// `propertyNames` is the other way round: ajv 6 evaluates it wherever it sits,
// and the native validator only at the schema's root (valijson builds a nested
// one from its parent's node path, #2729). Each row is a datum ajv refuses, and
// jsonSchema declines to pass it rather than agree with a validator that
// never read the keyword.
TEST_F (ScriptJsonSchemaConformanceTest,
ANestedPropertyNamesIsOneAjvEvaluatesAndJsonSchemaDiscloses) {
    const json& rows =
    conformance_table ().value ("nestedPropertyNames", json::array ());
    ASSERT_EQ (rows.size (), 4u)
    << "properties, allOf, items and a $ref target";

    constexpr const char* SCRIPT = R"JS(
var Ajv = require('ajv');
var verdicts = CASES.map(function (row) {
    var message = '';
    try { pm.expect(row.value).to.have.jsonSchema(row.schema); } catch (e) { message = e.message; }
    var validate = new Ajv().compile(row.schema);
    return { ajv: validate(row.value), native: message };
});
pm.environment.set('verdicts', JSON.stringify(verdicts));
)JS";
    const json verdicts          = run_script (rows, SCRIPT);
    ASSERT_EQ (verdicts.size (), rows.size ());
    for (std::size_t i = 0; i < rows.size (); ++i) {
        const std::string where = rows.at (i).at ("where");
        const json& verdict     = verdicts.at (i);
        EXPECT_EQ (verdict.at ("ajv"), false) << where << ": ajv evaluated it";
        const std::string message = verdict.at ("native");
        EXPECT_NE (
        message.find ("keywords the draft-07 validator does not evaluate"), std::string::npos)
        << where << ": " << message;
        EXPECT_NE (message.find ("propertyNames (1)"), std::string::npos)
        << where << ": " << message;
    }
}

// Where the two answer differently today, each side's verdict as recorded, so
// the record stays true: a fix on either side fails here until its row moves
// into `cases`.
TEST_F (ScriptJsonSchemaConformanceTest, DivergencesAreTheRecordedOnes) {
    const json& rows = conformance_table ().value ("divergences", json::array ());
    ASSERT_FALSE (rows.empty ()) << "the fixture's divergences were not read";

    constexpr const char* SCRIPT = R"JS(
var Ajv = require('ajv');
var verdicts = CASES.map(function (row) {
    var native = true;
    try { pm.expect(row.value).to.have.jsonSchema(row.schema); } catch (e) { native = false; }
    return { ajv: new Ajv().compile(row.schema)(row.value), native: native };
});
pm.environment.set('verdicts', JSON.stringify(verdicts));
)JS";
    const json verdicts          = run_script (rows, SCRIPT);
    ASSERT_EQ (verdicts.size (), rows.size ());
    for (std::size_t i = 0; i < rows.size (); ++i) {
        const json& row = rows.at (i);
        ASSERT_NE (row.at ("ajv"), row.at ("native"))
        << row.at ("name") << " is not a divergence";
        const std::string where =
        row.at ("name").get<std::string> () + " on " + row.at ("value").dump ();
        EXPECT_EQ (verdicts.at (i).at ("ajv"), row.at ("ajv")) << "ajv, " << where;
        EXPECT_EQ (verdicts.at (i).at ("native"), row.at ("native"))
        << "jsonSchema, " << where;
    }
}
