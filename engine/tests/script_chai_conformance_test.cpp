// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// `pm.expect` is chai 4.4.1 and `pm.response.to` is chai-postman 2.0.1, and a
// script written against either runs here unchanged only as far as each member
// is implemented. `fixtures/chai-conformance.json` lists every public member of
// both, one row each, with a snippet that must pass, one that must fail and the
// shape of the message it fails with, and a member Vayu does not implement is a
// row marked `unsupported`: the table is what the docs' supported list is held
// to, so a member is never claimed without a snippet that runs and never
// dropped without a row that says so (#2528).
//
// The rows were checked against the real packages (every snippet passes or
// fails there as its row says), so the table states chai's behaviour rather
// than this runtime's.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <string_view>

#include "chai_conformance_table.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;
using nlohmann::json;

namespace {

// What chai 4.4.1 and chai-postman 2.0.1 publish, read off the packages:
// `Object.getOwnPropertyNames (chai.Assertion.prototype)` without
// `constructor`, `assert` and the `_`-prefixed internals (language chains and
// aliases included), plus `expect.fail`; and the names chai-postman's plugin
// adds to that prototype, plus `ok`, which it redefines. The table holds a row
// for each name and for nothing else, so a row deleted, renamed or swapped for
// another member fails by name rather than by a count.
constexpr auto CHAI_EXPECT_MEMBERS = std::to_array<std::string_view> (
{ "Arguments", "NaN", "Throw", "a", "above", "all", "also", "an", "and", "any",
"approximately", "arguments", "at", "be", "been", "below", "but", "by", "change",
"changes", "closeTo", "contain", "contains", "decrease", "decreases", "deep", "does",
"empty", "eq", "eql", "eqls", "equal", "equals", "exist", "exists", "extensible",
"false", "finite", "frozen", "greaterThan", "greaterThanOrEqual", "gt", "gte",
"has", "have", "haveOwnProperty", "haveOwnPropertyDescriptor", "include", "includes",
"increase", "increases", "instanceOf", "instanceof", "is", "itself", "key",
"keys", "least", "length", "lengthOf", "lessThan", "lessThanOrEqual", "lt", "lte",
"match", "matches", "members", "most", "nested", "not", "null", "of", "ok", "oneOf",
"ordered", "own", "ownProperty", "ownPropertyDescriptor", "property", "respondTo",
"respondsTo", "same", "satisfies", "satisfy", "sealed", "still", "string", "that",
"throw", "throws", "to", "true", "undefined", "which", "with", "within", "fail" });
static_assert (CHAI_EXPECT_MEMBERS.size () == 97,
"96 Assertion.prototype members and expect.fail");

constexpr auto CHAI_POSTMAN_MEMBERS =
std::to_array<std::string_view> ({ "accepted", "badRequest", "body", "clientError",
"error", "forbidden", "header", "info", "json", "jsonBody", "jsonSchema",
"notAcceptable", "notFound", "ok", "postmanRequest", "postmanRequestOrResponse",
"postmanResponse", "rateLimited", "redirection", "responseSize", "responseTime",
"serverError", "status", "statusCode", "statusCodeClass", "statusReason",
"success", "unauthorised", "unauthorized", "withBody", "withoutContent" });
static_assert (CHAI_POSTMAN_MEMBERS.size () == 31, "what chai-postman 2.0.1 installs");

// `pm.response.to.not` is chai's own `not`, which the response chain answers
// beside chai-postman's members.
constexpr std::string_view RESPONSE_CHAIN_NOT = "not";

// The words a row's `kind` may take; the completion check reads it.
bool is_known_kind (const std::string& kind) {
    static const std::set<std::string> kinds = { "language", "flag", "property",
        "method", "chainable" };
    return kinds.contains (kind);
}

bool is_unsupported (const json& row) {
    return row.value ("status", std::string{}) == "unsupported";
}

class ChaiConformanceTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Environment env;

    void SetUp () override {
        request.method = HttpMethod::GET;
        request.url    = "https://api.example.com/users";
    }

    /// The response a row's snippet runs against: the default 200 JSON one,
    /// with the row's `code` and `body` where it names them.
    static Response response_for (const json& overrides) {
        Response response;
        response.status_code = overrides.value ("code", 200);
        response.headers = { { "Content-Type", "application/json" }, { "X-Count", "5" } };
        response.body =
        overrides.value ("body", std::string (R"({"id": 1, "name": "ada"})"));
        response.timing.total_ms = 120;
        return response;
    }

    /// Runs one snippet inside a `pm.test`; the row it recorded.
    TestResult run (const std::string& snippet,
    const Response& response = response_for (json::object ())) {
        const std::string script = "pm.test(\"t\", function() {\n" + snippet + ";\n});";
        auto result = engine.execute_test (script, request, response, env);
        if (result.tests.size () != 1u) {
            TestResult missing;
            missing.error_message = "<no test recorded: " + result.error_message + ">";
            return missing;
        }
        return result.tests[0];
    }

    void expect_pass (const std::string& snippet) {
        const TestResult row = run (snippet);
        EXPECT_TRUE (row.passed) << snippet << " -> " << row.error_message;
    }

    /// Fails as an assertion, never as a script mistake, saying @p fragment.
    void expect_assertion_failure (const std::string& snippet, const std::string& fragment) {
        const TestResult row = run (snippet);
        EXPECT_FALSE (row.passed) << snippet << " passed";
        EXPECT_NE (row.error_message.find ("AssertionError"), std::string::npos)
        << snippet << " -> " << row.error_message;
        EXPECT_NE (row.error_message.find (fragment), std::string::npos)
        << snippet << " -> " << row.error_message;
    }

    void expect_type_error (const std::string& snippet, const std::string& fragment) {
        const TestResult row = run (snippet);
        EXPECT_FALSE (row.passed) << snippet << " passed";
        EXPECT_NE (row.error_message.find ("TypeError"), std::string::npos)
        << snippet << " -> " << row.error_message;
        EXPECT_NE (row.error_message.find (fragment), std::string::npos)
        << snippet << " -> " << row.error_message;
    }

    /// One row, both snippets, each against the response the row names.
    void check_supported_row (const json& row) {
        SCOPED_TRACE (row.at ("member").get<std::string> ());
        const std::string pass = row.value ("pass", std::string{});
        if (!pass.empty ()) {
            const TestResult held =
            run (pass, response_for (row.value ("passResponse", json::object ())));
            EXPECT_TRUE (held.passed) << pass << " -> " << held.error_message;
        }
        const std::string fail = row.at ("fail");
        const TestResult broken =
        run (fail, response_for (row.value ("failResponse", json::object ())));
        EXPECT_FALSE (broken.passed) << fail << " passed";
        EXPECT_NE (broken.error_message.find ("AssertionError"), std::string::npos)
        << fail << " -> " << broken.error_message;
        EXPECT_NE (broken.error_message.find (row.at ("message").get<std::string> ()),
        std::string::npos)
        << fail << " -> " << broken.error_message;
    }

    /// An unsupported member answers by name, as a TypeError and never as a
    /// verdict: a script that reaches it must not read a pass or a fail.
    void check_unsupported_row (const json& row) {
        const std::string member = row.at ("member");
        SCOPED_TRACE (member);
        const std::string pass  = row.at ("pass");
        const TestResult result = run (pass);
        EXPECT_FALSE (result.passed) << pass << " passed";
        EXPECT_NE (result.error_message.find ("TypeError"), std::string::npos)
        << pass << " -> " << result.error_message;
        EXPECT_NE (result.error_message.find (member + " is not a supported assertion"),
        std::string::npos)
        << pass << " -> " << result.error_message;
    }

    void check_section (const json& rows) {
        for (const auto& row : rows) {
            if (is_unsupported (row)) {
                check_unsupported_row (row);
            } else {
                check_supported_row (row);
            }
        }
    }
};

// ----------------------------------------------------------------------------
// The table
// ----------------------------------------------------------------------------

std::set<std::string> row_members (const json& rows) {
    std::set<std::string> members;
    for (const auto& row : rows) {
        members.insert (row.at ("member").get<std::string> ());
    }
    return members;
}

/// @p rows name exactly @p published, each once: a member with no row and a
/// row for no member both fail by name.
void expect_rows_name_exactly (const json& rows, const std::set<std::string>& published) {
    const std::set<std::string> listed = row_members (rows);
    EXPECT_EQ (listed.size (), rows.size ()) << "a member has two rows";
    for (const auto& member : published) {
        EXPECT_TRUE (listed.contains (member))
        << "no row for the published member `" << member << "`";
    }
    for (const auto& member : listed) {
        EXPECT_TRUE (published.contains (member))
        << "the row `" << member << "` is not a member the package publishes";
    }
}

// A table that lost a row would still pass every row it kept, so the rows are
// held to what chai and chai-postman publish, by name and in both directions.
TEST_F (ChaiConformanceTest, TheTableHoldsExactlyThePublicMembersOfBothPackages) {
    const json& table = vayu::tests::chai_conformance_table ();
    ASSERT_TRUE (table.contains ("expect")) << "the table did not load";
    ASSERT_TRUE (table.contains ("response")) << "the table did not load";

    expect_rows_name_exactly (table.at ("expect"),
    std::set<std::string> (CHAI_EXPECT_MEMBERS.begin (), CHAI_EXPECT_MEMBERS.end ()));
    std::set<std::string> response (
    CHAI_POSTMAN_MEMBERS.begin (), CHAI_POSTMAN_MEMBERS.end ());
    response.emplace (RESPONSE_CHAIN_NOT);
    expect_rows_name_exactly (table.at ("response"), response);
}

TEST_F (ChaiConformanceTest, EveryRowIsComplete) {
    const json& table = vayu::tests::chai_conformance_table ();
    ASSERT_TRUE (table.contains ("expect")) << "the table did not load";
    ASSERT_TRUE (table.contains ("response")) << "the table did not load";

    const json& expect   = table.at ("expect");
    const json& response = table.at ("response");
    for (const json* section : { &expect, &response }) {
        std::set<std::string> members;
        size_t supported = 0;
        for (const auto& row : *section) {
            const std::string member = row.at ("member");
            EXPECT_TRUE (members.insert (member).second) << member << " has two rows";
            EXPECT_FALSE (row.at ("pass").get<std::string> ().empty () && member != "fail")
            << member << " has no passing snippet";
            EXPECT_FALSE (row.at ("fail").get<std::string> ().empty ()) << member;
            if (is_unsupported (row)) {
                continue;
            }
            supported++;
            EXPECT_FALSE (row.at ("message").get<std::string> ().empty ())
            << member << " names no message shape";
        }
        EXPECT_GT (supported, section->size () / 2)
        << "most of the surface is meant to be supported";
    }

    for (const auto& row : expect) {
        EXPECT_TRUE (is_known_kind (row.at ("kind"))) << row.at ("member");
    }
    for (const auto& row : response) {
        EXPECT_TRUE (is_unsupported (row) || row.contains ("completion"))
        << row.at ("member") << " names no completion label";
    }
}

TEST_F (ChaiConformanceTest, EveryPmExpectRowPassesAndFailsAsChaiDoes) {
    const json& expect = vayu::tests::chai_conformance_table ().at ("expect");
    ASSERT_FALSE (expect.empty ());
    check_section (expect);
}

TEST_F (ChaiConformanceTest, EveryPmResponseToRowPassesAndFailsAsChaiPostmanDoes) {
    const json& response =
    vayu::tests::chai_conformance_table ().at ("response");
    ASSERT_FALSE (response.empty ());
    check_section (response);
}

// The unsupported path is what makes "unsupported" a statement and not a gap:
// it has to be exercised by at least one row, or the loop above could pass
// without ever reaching it.
TEST_F (ChaiConformanceTest, AtLeastOneRowIsUnsupportedAndAnswersByName) {
    const json& response =
    vayu::tests::chai_conformance_table ().at ("response");
    const auto unsupported =
    std::count_if (response.begin (), response.end (), is_unsupported);
    EXPECT_GE (unsupported, 1);
    expect_type_error ("pm.expect(pm.response).to.be.postmanResponse",
    "postmanResponse is not a supported assertion");
}

// ----------------------------------------------------------------------------
// The docs' vocabulary list is held to the table
// ----------------------------------------------------------------------------

std::string read_docs_page () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    ".." / "docs" / "app" / "pm-api-compatibility.md";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "docs page missing: " << path;
        return {};
    }
    std::ostringstream text;
    text << in.rdbuf ();
    return text.str ();
}

// The members the "Assertion chains (`pm.expect`)" block names: every dotted
// word that starts a token (`.to.equal(v)`, `.not`), which leaves out a path
// inside a sentence such as `err.message`.
std::set<std::string> documented_vocabulary (const std::string& page) {
    const size_t heading = page.find ("### Assertion chains (`pm.expect`)");
    const size_t open =
    heading == std::string::npos ? heading : page.find ("```\n", heading);
    const size_t close = open == std::string::npos ? open : page.find ("\n```", open + 4);
    std::set<std::string> words;
    if (close == std::string::npos) {
        return words;
    }
    const std::string block = page.substr (open, close - open);
    static const std::regex token (R"((?:^|[\s(/])((?:\.[A-Za-z]+)+))");
    for (std::sregex_iterator it (block.begin (), block.end (), token), end;
    it != end; ++it) {
        std::stringstream chain ((*it)[1].str ());
        std::string word;
        std::getline (chain, word, '.');
        while (std::getline (chain, word, '.')) {
            words.insert (word);
        }
    }
    return words;
}

TEST_F (ChaiConformanceTest, EveryMemberTheDocsListAsSupportedIsInTheTable) {
    const std::set<std::string> documented = documented_vocabulary (read_docs_page ());
    ASSERT_GT (documented.size (), 20u)
    << "the vocabulary block was not found or read nothing";

    // `jsonSchema` is chai-postman's, listed with the response rows, and is
    // chained off `pm.expect(...)` as well.
    std::set<std::string> supported;
    for (const char* section : { "expect", "response" }) {
        for (const auto& row : vayu::tests::chai_conformance_table ().at (section)) {
            if (!is_unsupported (row)) {
                supported.insert (row.at ("member"));
            }
        }
    }
    for (const auto& word : documented) {
        EXPECT_TRUE (supported.contains (word))
        << "docs/app/pm-api-compatibility.md lists `."
        << word << "` as supported but chai-conformance.json has no supported row for it";
    }
}

// The other direction: a member the table says works and the vocabulary list
// never mentions is a capability nobody can find.
TEST_F (ChaiConformanceTest, EveryMemberTheTableSupportsIsInTheDocsList) {
    const std::set<std::string> documented = documented_vocabulary (read_docs_page ());
    ASSERT_GT (documented.size (), 20u);

    for (const auto& row :
    vayu::tests::chai_conformance_table ().at ("expect")) {
        const std::string member = row.at ("member");
        if (is_unsupported (row) || member == "fail") {
            continue;
        }
        EXPECT_TRUE (documented.contains (member))
        << "`." << member << "` is supported but the docs vocabulary list omits it";
    }
}

// The `pm.response.to` members the page names: each member a span of the
// "Response assertions" row ends on (`pm.response.to.have.status(code)`,
// `.jsonBody(path)`, `pm.response.to.not`; `pm.response.to.be.*` names none),
// and each `.to.be.<word>` of the status-class block.
std::set<std::string> documented_response_members (const std::string& page) {
    std::set<std::string> words;
    const size_t row = page.find ("\n| Response assertions |");
    if (row != std::string::npos) {
        const std::string line =
        page.substr (row + 1, page.find ('\n', row + 1) - row - 1);
        static const std::regex span (
        R"(`(?:pm\.response\.to)?(?:\.[A-Za-z]+)*\.([A-Za-z]+)(?:\(|`))");
        for (std::sregex_iterator it (line.begin (), line.end (), span), end;
        it != end; ++it) {
            words.insert ((*it)[1].str ());
        }
    }
    const size_t heading =
    page.find ("### Response status classes (`pm.response.to.be`)");
    const size_t open =
    heading == std::string::npos ? heading : page.find ("```\n", heading);
    const size_t close = open == std::string::npos ? open : page.find ("\n```", open + 4);
    if (close != std::string::npos) {
        const std::string block = page.substr (open, close - open);
        static const std::regex getter (R"(\.to\.be\.([A-Za-z]+))");
        for (std::sregex_iterator it (block.begin (), block.end (), getter), end;
        it != end; ++it) {
            words.insert ((*it)[1].str ());
        }
    }
    return words;
}

// The same promise for `pm.response.to`, in both directions: a member the page
// says works has a supported row, and a supported row is on the page.
TEST_F (ChaiConformanceTest, TheDocsNameEveryResponseMemberTheTableSupportsAndNoOther) {
    const std::set<std::string> documented =
    documented_response_members (read_docs_page ());
    ASSERT_GT (documented.size (), 20u)
    << "the response assertions row or the status-class block was not found";

    std::set<std::string> supported;
    for (const auto& row :
    vayu::tests::chai_conformance_table ().at ("response")) {
        if (!is_unsupported (row)) {
            supported.insert (row.at ("member"));
        }
    }
    for (const auto& word : documented) {
        EXPECT_TRUE (supported.contains (word))
        << "docs/app/pm-api-compatibility.md documents pm.response.to's `" << word
        << "` but chai-conformance.json has no supported response row for it";
    }
    for (const auto& member : supported) {
        EXPECT_TRUE (documented.contains (member))
        << "pm.response.to's `" << member << "` is supported but the docs never name it";
    }
}

// ----------------------------------------------------------------------------
// The measured set, pinned by name
// ----------------------------------------------------------------------------

// Both bounds belong to the range, as chai's do.
TEST_F (ChaiConformanceTest, WithinIncludesBothBounds) {
    expect_pass ("pm.expect(1).to.be.within(1, 2)");
    expect_pass ("pm.expect(2).to.be.within(1, 2)");
    expect_pass ("pm.expect(3).to.not.be.within(1, 2)");
    expect_assertion_failure ("pm.expect(0).to.be.within(1, 2)", "to be within 1..2");
    expect_assertion_failure ("pm.expect(2).to.not.be.within(1, 2)", "to not be within 1..2");
}

TEST_F (ChaiConformanceTest, GreaterThanAndLessThanOrderStrictlyAndTheOrEqualSpellingsDoNot) {
    expect_pass ("pm.expect(2).to.be.greaterThan(1)");
    expect_assertion_failure ("pm.expect(1).to.be.greaterThan(1)", "to be above 1");
    expect_pass ("pm.expect(1).to.be.lessThan(2)");
    expect_assertion_failure ("pm.expect(2).to.be.lessThan(2)", "to be below 2");
    expect_pass ("pm.expect(1).to.be.greaterThanOrEqual(1)");
    expect_assertion_failure ("pm.expect(0).to.be.greaterThanOrEqual(1)", "to be at least 1");
    expect_pass ("pm.expect(2).to.be.lessThanOrEqual(2)");
    expect_assertion_failure ("pm.expect(3).to.be.lessThanOrEqual(2)", "to be at most 2");
}

TEST_F (ChaiConformanceTest, InstanceofIsTheLowercaseSpellingOfInstanceOf) {
    expect_pass ("pm.expect([]).to.be.instanceof(Array)");
    expect_assertion_failure ("pm.expect({}).to.be.instanceof(Array)", "an instance of Array");
}

TEST_F (ChaiConformanceTest, AnyKeysNeedsOneOfThemWhereKeysNeedsAll) {
    expect_pass ("pm.expect({ a: 1 }).to.have.any.keys('a', 'z')");
    expect_assertion_failure ("pm.expect({ a: 1 }).to.have.any.keys('y', 'z')",
    "any of the keys 'y', 'z'");
    expect_pass ("pm.expect({ a: 1 }).to.not.have.any.keys('y', 'z')");
    expect_assertion_failure (
    "pm.expect({ a: 1 }).to.have.all.keys('a', 'z')", "exactly the keys");
}

TEST_F (ChaiConformanceTest, IncludeKeysAcceptsASupersetWhereHaveKeysDoesNot) {
    expect_pass ("pm.expect({ a: 1, b: 2 }).to.include.keys('a')");
    expect_pass ("pm.expect({ a: 1, b: 2 }).to.contain.keys('a', 'b')");
    expect_assertion_failure (
    "pm.expect({ a: 1, b: 2 }).to.include.keys('a', 'z')", "contain the keys 'a', 'z'");
    expect_assertion_failure (
    "pm.expect({ a: 1, b: 2 }).to.have.keys('a')", "exactly the keys 'a'");
    expect_type_error ("pm.expect({ a: 1 }).to.include.keys([])", "at least one key");
}

TEST_F (ChaiConformanceTest, LengthOfIsAChainTheOrderingMatchersRead) {
    expect_pass ("pm.expect([1, 2, 3]).to.have.lengthOf.above(2)");
    expect_assertion_failure (
    "pm.expect([1, 2, 3]).to.have.lengthOf.above(3)", "length 3 to be above 3");
    expect_pass ("pm.expect('abc').to.have.length.within(3, 5)");
    expect_pass ("pm.expect([1, 2, 3]).to.have.lengthOf(3)");
    expect_assertion_failure ("pm.expect([1, 2, 3]).to.have.lengthOf(2)", "length 3 to equal 2");
}

TEST_F (ChaiConformanceTest, IncludeMembersAcceptsASuperset) {
    expect_pass ("pm.expect([1, 2, 3]).to.include.members([3, 1])");
    expect_assertion_failure (
    "pm.expect([1, 2, 3]).to.include.members([4])", "be a superset of [4]");
    expect_assertion_failure (
    "pm.expect([1, 2, 3]).to.have.members([1, 2])", "to have members [1,2]");
}

TEST_F (ChaiConformanceTest, OrderedMembersComparesByPosition) {
    expect_pass ("pm.expect([1, 2, 3]).to.have.ordered.members([1, 2, 3])");
    expect_assertion_failure (
    "pm.expect([1, 2, 3]).to.have.ordered.members([3, 2, 1])", "have ordered members [3,2,1]");
    expect_pass ("pm.expect([1, 2, 3]).to.include.ordered.members([1, 2])");
    expect_assertion_failure (
    "pm.expect([1, 2, 3]).to.include.ordered.members([2, 3])", "be an ordered superset of [2,3]");
}

TEST_F (ChaiConformanceTest, ContainOneOfAsksWhetherTheTargetHoldsACandidate) {
    expect_pass ("pm.expect('hello').to.contain.oneOf(['x', 'ell'])");
    expect_pass ("pm.expect([1, 2]).to.contain.oneOf([9, 2])");
    expect_assertion_failure ("pm.expect('hello').to.contain.oneOf(['x', 'y'])", "contain one of");
    expect_pass ("pm.expect(2).to.be.oneOf([1, 2])");
}

TEST_F (ChaiConformanceTest, ApproximatelyIsCloseTo) {
    expect_pass ("pm.expect(1.5).to.be.approximately(1, 0.5)");
    expect_assertion_failure ("pm.expect(1.5).to.be.approximately(1, 0.4)", "to be within");
    expect_pass ("pm.expect(1.5).to.not.be.approximately(1, 0.4)");
}

TEST_F (ChaiConformanceTest, FiniteChecksTheTypeAndTheMagnitude) {
    expect_pass ("pm.expect(1).to.be.finite");
    expect_assertion_failure ("pm.expect('1').to.be.finite", "a finite number");
    expect_assertion_failure ("pm.expect(Infinity).to.be.finite", "a finite number");
    expect_pass ("pm.expect(NaN).to.not.be.finite");
}

TEST_F (ChaiConformanceTest, NestedIncludeReadsEachKeyAsAPath) {
    expect_pass (
    "pm.expect({ a: { b: [{ c: 1 }] } }).to.nested.include({ 'a.b[0].c': 1 })");
    expect_assertion_failure (
    "pm.expect({ a: { b: [{ c: 1 }] } }).to.nested.include({ 'a.b[0].c': 2 })",
    "to include nested properties");
    expect_pass (
    "pm.expect({ a: { b: 1 } }).to.not.nested.include({ 'a.x': 1 })");
}

TEST_F (ChaiConformanceTest, OwnPropertyIgnoresWhatIsInherited) {
    expect_pass ("pm.expect({ a: 1 }).to.have.ownProperty('a')");
    expect_assertion_failure (
    "pm.expect({ a: 1 }).to.have.ownProperty('toString')", "own property 'toString'");
    expect_pass ("pm.expect({ a: 1 }).to.not.have.ownProperty('toString')");
    expect_pass ("pm.expect({ a: 1 }).to.have.property('toString')");
}

TEST_F (ChaiConformanceTest, NotHaveStatusOnTheResponseNegatesTheCheck) {
    expect_pass ("pm.response.to.not.have.status(500)");
    expect_assertion_failure ("pm.response.to.not.have.status(200)", "to not be 200");
}

TEST_F (ChaiConformanceTest, JsonSchemaIsOnBothChains) {
    expect_pass (
    "pm.expect({ id: 1 }).to.have.jsonSchema({ required: ['id'] })");
    expect_assertion_failure (
    "pm.expect({}).to.have.jsonSchema({ required: ['id'] })", "'id'");
    expect_pass ("pm.response.to.have.jsonSchema({ required: ['id'] })");
    expect_assertion_failure (
    "pm.response.to.have.jsonSchema({ required: ['missing'] })", "'missing'");
}

TEST_F (ChaiConformanceTest, ResponseTimeAndSizeAreACallAndAChain) {
    expect_pass ("pm.response.to.have.responseTime(120)");
    expect_pass ("pm.response.to.have.responseTime.below(121)");
    expect_assertion_failure ("pm.response.to.have.responseTime.above(120)",
    "Expected 120 to be above 120");
    const std::string size =
    "(pm.response.size().body + pm.response.size().header)";
    expect_pass ("pm.response.to.have.responseSize(" + size + ")");
    expect_pass ("pm.response.to.have.responseSize.at.most(" + size + ")");
    expect_assertion_failure ("pm.response.to.have.responseSize.below(1)", "to be below 1");
}

TEST_F (ChaiConformanceTest, JsonBodyReadsAnArrayRootByLodashPath) {
    Response response = response_for (json{ { "body", R"([{"id": 7}])" } });
    const TestResult held = run ("pm.response.to.have.jsonBody('[0].id', 7)", response);
    EXPECT_TRUE (held.passed) << held.error_message;
    const TestResult broken = run ("pm.response.to.have.jsonBody('[0].id', 8)", response);
    EXPECT_FALSE (broken.passed);
    EXPECT_NE (broken.error_message.find ("AssertionError"), std::string::npos);
}

// ----------------------------------------------------------------------------
// The members the table surfaced, each pinned by what it measures
// ----------------------------------------------------------------------------

TEST_F (ChaiConformanceTest, ExistsIsTheSecondSpellingOfExist) {
    expect_pass ("pm.expect(0).to.exists");
    expect_assertion_failure ("pm.expect(null).to.exists", "to exist");
    expect_pass ("pm.expect(undefined).to.not.exists");
}

TEST_F (ChaiConformanceTest, ThrowIsTheCapitalisedSpellingOfThrow) {
    expect_pass ("pm.expect(function () { throw new TypeError('x'); "
                 "}).to.Throw(TypeError, 'x')");
    expect_assertion_failure ("pm.expect(function () {}).to.Throw()", "to throw");
}

TEST_F (ChaiConformanceTest, ArgumentsIsTheTagOfAFunctionsArgumentsObject) {
    expect_pass (
    "pm.expect((function () { return arguments; })(1)).to.be.arguments");
    expect_assertion_failure ("pm.expect({ 0: 1, length: 1 }).to.be.Arguments", "to be arguments");
    expect_pass ("pm.expect([]).to.not.be.arguments");
}

// The language answers these, a primitive included: it is sealed and frozen
// and not extensible.
TEST_F (ChaiConformanceTest, ExtensibleSealedAndFrozenAreWhatObjectAnswers) {
    expect_pass ("pm.expect({}).to.be.extensible");
    expect_pass (
    "pm.expect(Object.preventExtensions({})).to.not.be.extensible");
    expect_pass ("pm.expect(Object.seal({ a: 1 })).to.be.sealed");
    expect_assertion_failure (
    "pm.expect(Object.preventExtensions({ a: 1 })).to.be.sealed", "to be sealed");
    expect_pass ("pm.expect(Object.freeze({ a: 1 })).to.be.frozen");
    expect_assertion_failure ("pm.expect(Object.seal({ a: 1 })).to.be.frozen", "to be frozen");
    expect_pass ("pm.expect(1).to.be.frozen");
    expect_pass ("pm.expect(1).to.be.sealed");
    expect_pass ("pm.expect(1).to.not.be.extensible");
}

TEST_F (ChaiConformanceTest, OwnPropertyDescriptorComparesTheDescriptorAndRetargetsAtIt) {
    expect_pass ("pm.expect({ a: 1 }).to.have.ownPropertyDescriptor('a')");
    expect_assertion_failure (
    "pm.expect({}).to.have.ownPropertyDescriptor('a')",
    "to have an own property descriptor for 'a'");
    expect_pass ("pm.expect({}).to.not.have.ownPropertyDescriptor('a')");
    // Not own: the prototype's `toString` is a property and not an own one.
    expect_pass ("pm.expect({}).to.not.have.ownPropertyDescriptor('toString')");

    expect_pass (
    "pm.expect(Object.freeze({ a: 1 })).to.have.ownPropertyDescriptor('a', "
    "{ value: 1, writable: false, enumerable: true, configurable: false })");
    expect_assertion_failure (
    "pm.expect({ a: 1 }).to.have.ownPropertyDescriptor('a', "
    "{ value: 1, writable: false, enumerable: true, configurable: true })",
    "to match");
    expect_pass (
    "pm.expect({ a: 1 }).to.not.have.ownPropertyDescriptor('a', { value: 2 })");

    // The one-argument form moves the chain to the descriptor.
    expect_pass ("pm.expect({ a: 1 }).to.have.ownPropertyDescriptor('a')"
                 ".that.has.property('writable', true)");
    // chai reads a string second argument as a message; it is not a descriptor.
    expect_pass (
    "pm.expect({ a: 1 }).to.have.ownPropertyDescriptor('a', 'why')");
    expect_type_error (
    "pm.expect({ a: 1 }).to.have.ownPropertyDescriptor('a', 5)", "expects a descriptor object");
    expect_type_error (
    "pm.expect({}).to.have.ownPropertyDescriptor()", "requires a property name");
}

TEST_F (ChaiConformanceTest, RespondToAsksAFunctionAboutItsPrototypeUnlessItself) {
    expect_pass ("pm.expect({ f: function () {} }).to.respondTo('f')");
    expect_assertion_failure ("pm.expect({ f: 1 }).to.respondTo('f')", "to respond to 'f'");
    expect_pass ("pm.expect({}).to.not.respondTo('f')");

    // A constructor's instances respond to what its prototype holds, and the
    // constructor itself to what it holds: `.itself` picks the second.
    const std::string ctor = "var C = function () {}; C.prototype.m = function "
                             "() {}; C.s = function () {};";
    expect_pass (ctor + "pm.expect(C).to.respondTo('m')");
    expect_assertion_failure (ctor + "pm.expect(C).to.respondTo('s')", "to respond to 's'");
    expect_pass (ctor + "pm.expect(C).itself.to.respondTo('s')");
    expect_assertion_failure (ctor + "pm.expect(C).itself.to.respondTo('m')", "to respond to 'm'");

    // chai reads `fn.prototype[name]`, a TypeError on an arrow function.
    // Answering "does not respond" would make `.not.respondTo` pass for it.
    expect_type_error ("pm.expect(() => 1).to.not.respondTo('m')", "cannot read the prototype");
    expect_pass ("pm.expect(() => 1).itself.to.respondTo('call')");
    expect_type_error ("pm.expect(null).to.respondTo('m')", "object or a function");
    expect_type_error ("pm.expect({}).to.respondTo(5)", "requires a method name");
}

TEST_F (ChaiConformanceTest, ChangeIncreaseAndDecreaseMeasureBeforeAndAfterOneCall) {
    // A property of an object, and a measuring function.
    expect_pass (
    "var o = { n: 1 }; pm.expect(function () { o.n = 2; }).to.change(o, 'n')");
    expect_assertion_failure (
    "var o = { n: 1 }; pm.expect(function () {}).to.change(o, 'n')", "Expected .n to change");
    expect_pass (
    "var o = { n: 1 }; pm.expect(function () {}).to.not.change(o, 'n')");
    expect_pass ("var n = 1; pm.expect(function () { n += 2; "
                 "}).to.increase(function () { return n; })");
    expect_assertion_failure ("var n = 1; pm.expect(function () { n -= 1; })"
                              ".to.increase(function () { return n; })",
    "Expected 1 to increase");
    expect_pass ("var o = { n: 3 }; pm.expect(function () { o.n -= 1; "
                 "}).to.decrease(o, 'n')");
    expect_assertion_failure (
    "var o = { n: 3 }; pm.expect(function () { o.n += 1; })"
    ".to.decrease(o, 'n')",
    "Expected .n to decrease");

    // The target runs once, and the subject is read before and after it.
    expect_pass ("var runs = 0, o = { n: 1 };"
                 "pm.expect(function () { runs++; o.n++; }).to.change(o, 'n');"
                 "pm.expect(runs).to.equal(1)");
    // A function that throws is the script's own error, not a verdict.
    expect_type_error (
    "var o = { n: 1 }; pm.expect(function () { throw new TypeError('boom'); })"
    ".to.change(o, 'n')",
    "boom");
}

TEST_F (ChaiConformanceTest, ByCountsTheMoveTheMatcherBeforeItMeasured) {
    const std::string two_up =
    "var o = { n: 1 }; var f = function () { o.n += 2; };";
    expect_pass (two_up + "pm.expect(f).to.increase(o, 'n').by(2)");
    expect_assertion_failure (two_up + "pm.expect(f).to.increase(o, 'n').by(3)",
    "Expected .n to increase by 3");
    // `decrease` counts the move downward, whatever sign `by` is given.
    expect_pass ("var o = { n: 5 }; pm.expect(function () { o.n -= 2; })"
                 ".to.decrease(o, 'n').by(-2)");
    // `change` counts the size of the move in either direction.
    expect_pass ("var o = { n: 5 }; pm.expect(function () { o.n -= 2; "
                 "}).to.change(o, 'n').by(2)");
    expect_pass (two_up + "pm.expect(f).to.change(o, 'n').by(2)");
    expect_assertion_failure (
    "var o = { n: 5 }; pm.expect(function () { o.n -= 2; })"
    ".to.change(o, 'n').by(3)",
    "to change by 3");
    // `.not` negates the `by` the same way it negates the matcher.
    expect_pass ("var o = { n: 1 }; pm.expect(function () { o.n += 2; })"
                 ".to.increase(o, 'n').but.not.by(5)");

    expect_type_error ("pm.expect(1).to.be.by(1)", "must follow change, increase or decrease");
    expect_type_error ("var o = { n: 1 }; pm.expect(function () { o.n++; })"
                       ".to.change(o, 'n').by('1')",
    "by() requires a number");
}

TEST_F (ChaiConformanceTest, TheDeltaMatchersRefuseWhatTheyCannotMeasure) {
    expect_type_error ("pm.expect(5).to.change(function () {})",
    "requires the target to be a function");
    expect_type_error ("pm.expect(function () {}).to.change()",
    "requires a function, or an object");
    expect_type_error ("pm.expect(function () {}).to.change(5)", "requires a function");
    expect_type_error ("pm.expect(function () {}).to.change({}, 'n')", "with a 'n' property");
    expect_type_error (
    "var o = { n: 'x' }; pm.expect(function () {}).to.increase(o, 'n')", "to be a number");
}

// ----------------------------------------------------------------------------
// What a matcher or a chainable method answers when read rather than called
// ----------------------------------------------------------------------------

// `.a` and `.an` are chai's chainable methods: the type check when called, and
// a language word that hands the chain on when read (#2528).
TEST_F (ChaiConformanceTest, AAndAnAreACallAndAChain) {
    expect_pass ("pm.expect([]).to.be.an.instanceof(Array)");
    expect_pass ("pm.expect(new Date()).to.be.a.instanceOf(Date)");
    expect_pass ("pm.expect([1]).to.be.an('array').that.includes(1)");
    expect_pass ("pm.expect('x').to.be.a.not.instanceOf(Array)");
    expect_pass (
    "pm.expect(typeof pm.expect(1).to.be.an).to.equal('function')");
    expect_assertion_failure ("pm.expect({}).to.be.an.instanceof(Array)", "an instance of Array");
    expect_assertion_failure (
    "pm.expect([2]).to.be.an('array').that.includes(1)", "to include 1");
    // The call keeps its own wording.
    expect_assertion_failure (
    "pm.expect('x').to.be.a('number')", "Expected type string to be number");
    expect_assertion_failure ("pm.expect([]).to.not.be.an('array')",
    "Expected type array to not be array");
    expect_type_error ("pm.expect(1).to.be.a()", "a() requires a type name");
}

// A name read off a chainable method or a matcher that nothing implements
// throws naming itself (#999), never evaluates to a value: a paren-less chain
// whose last word read as `undefined` or a function's own `name` would report
// PASS having asserted nothing. The listing does not come from the table, so
// it holds whatever the table says.
TEST_F (ChaiConformanceTest, ANameReadOffAMemberThatNothingImplementsThrowsByName) {
    struct Case {
        const char* snippet;
        const char* named;
    };
    const auto cases = std::to_array<Case> ({
    // After a chainable method, the expectation answers or refuses the name;
    // a function's own `name`, `call`, `apply`, `bind` and `prototype` are not
    // chain members.
    { "pm.expect([1]).to.include.name", "pm.expect(...).name" },
    { "pm.expect([1]).to.include.foo", "pm.expect(...).foo" },
    { "pm.expect([1]).to.contain.call", "pm.expect(...).call" },
    { "pm.expect([1]).to.includes.apply", "pm.expect(...).apply" },
    { "pm.expect([1]).to.contains.bind", "pm.expect(...).bind" },
    { "pm.expect([1]).to.have.lengthOf.prototype", "pm.expect(...).prototype" },
    { "pm.expect(1).to.be.a.foo", "pm.expect(...).foo" },
    { "pm.expect(1).to.be.an.name", "pm.expect(...).name" },
    // `length` directly after one is refused, as chai's length guard does.
    { "pm.expect([1]).to.include.length", "pm.expect(...).include.length" },
    { "pm.expect([1]).to.have.length.length", "pm.expect(...).length.length" },
    { "pm.expect([1]).to.be.an.length", "pm.expect(...).an.length" },
    { "pm.response.to.have.responseTime.length", "pm.response.to.have.responseTime.length" },
    { "pm.response.to.not.have.responseSize.length", "pm.response.to.not.have.responseSize.length" },
    { "pm.response.to.have.responseTime.name", "pm.response.to.have.responseTime.name" },
    // After a matcher, which is a call and not a chain, every name is refused.
    { "pm.expect(1).to.be.within.foo", "pm.expect(...).within.foo" },
    { "pm.expect(1).to.be.within.length", "pm.expect(...).within.length" },
    { "pm.expect(1).to.equal.name", "pm.expect(...).equal.name" },
    { "pm.expect(1).to.equal.to", "pm.expect(...).equal.to" },
    { "pm.expect({a:1}).to.have.keys.foo", "pm.expect(...).keys.foo" },
    { "pm.expect(1).to.be.above.call", "pm.expect(...).above.call" },
    { "pm.expect(function () {}).to.change.by", "pm.expect(...).change.by" },
    });
    for (const auto& [snippet, named] : cases) {
        expect_type_error (snippet, std::string (named) + " is not a supported assertion");
    }

    // What a runtime probes on any value still resolves.
    expect_pass ("pm.expect(typeof "
                 "pm.expect([1]).to.include.toString).to.equal('function')");
    expect_pass ("pm.expect(typeof "
                 "pm.expect(1).to.equal.hasOwnProperty).to.equal('function')");
    expect_pass ("pm.expect(pm.expect(1).to.equal.then).to.equal(undefined)");
    expect_pass (
    "pm.expect(JSON.stringify({ m: pm.expect(1).to.equal })).to.equal('{}')");
}

// A matcher reached through a chainable method hands back the expectation, not
// the chainable method it was read off (#2528): `.include.keys('a')` answers
// the chain, and calling what it answered is not a second `include`.
TEST_F (ChaiConformanceTest, AMatcherAfterAChainableMethodAnswersTheExpectation) {
    expect_pass ("var r = pm.expect({ a: 1 }).to.include.keys('a'); "
                 "pm.expect(typeof r).to.equal('object')");
    expect_pass (
    "pm.expect({ a: 1, b: 2 }).to.include.keys('a').and.have.property('b', 2)");
    expect_pass (
    "pm.expect([1, 2]).to.include.members([1]).and.have.lengthOf(2)");
    expect_assertion_failure (
    "pm.expect([1, 2]).to.include.members([1]).and.have.lengthOf(3)", "length 2 to equal 3");
    // A flag or language word read off one hands back the expectation too.
    expect_type_error ("pm.expect([1]).to.include.not(1)", "not a function");
    expect_type_error ("pm.expect([1]).to.include.that(1)", "not a function");
    expect_pass ("var r = pm.response.to.have.responseTime.below(100000); "
                 "pm.expect(typeof r).to.equal('object')");
}

// An unknown member of the chain a response measure starts names that chain,
// not `pm.expect(...)`, which the script never wrote.
TEST_F (ChaiConformanceTest, AnUnknownMemberAfterAResponseMeasureNamesItsChain) {
    expect_type_error ("pm.response.to.have.responseTime.belw(5)",
    "pm.response.to.have.responseTime.belw is not a supported assertion");
    expect_type_error ("pm.response.to.not.have.responseSize.abov(5)",
    "pm.response.to.not.have.responseSize.abov is not a supported assertion");
    expect_type_error ("pm.response.to.have.responseTime.to.be.belw(5)",
    "pm.response.to.have.responseTime.belw is not a supported assertion");
    expect_type_error ("pm.expect(1).to.belw(5)",
    "pm.expect(...).belw is not a supported assertion");
}

} // namespace
