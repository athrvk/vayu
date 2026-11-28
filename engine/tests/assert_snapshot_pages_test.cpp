/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file assert_snapshot_pages_test.cpp
 * @brief `assert.snapshot` over a paged list (#3824): every page a reply's
 *        `nextCursor` names is read and compared as one list, and a list that
 *        cannot be read to its end fails, never passes on its first pages.
 *
 * The element cases stub `ElementContext::send_list_page`. The exchange cases
 * send through `execute_exchange` to `McpFixtureServer`, whose list methods
 * page and whose header check refuses a follow-up whose headers disagree with
 * its body; the run case is a collection run's step.
 *
 * Mutation checks: return `std::nullopt` from `whole_snapshot_reply` (compare
 * page one only) and the later-page cases go red; compare the merged list in
 * order (`snapshot_drift` failing on an `order` mismatch) and the moved-item
 * cases do; drop `add_page_cost` and the latency cases do; drop the page count
 * in `send_list_page` and the trace cases do.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <expected>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "mcp_fixture_server.hpp"
#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

#include "scenario_runner_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::CompiledElement;
using vayu::core::ElementContext;
using vayu::core::ElementOutcome;
using vayu::core::ElementPipeline;
using vayu::core::ListPageFailure;
using vayu::core::Phase;
using vayu::tests::McpFixtureServer;

using PageAnswer = std::expected<std::string, ListPageFailure>;

json tool_item (const std::string& name, const std::string& type = "string") {
    return { { "name", name }, { "description", "does " + name },
        { "inputSchema",
        { { "type", "object" }, { "properties", { { "x", { { "type", type } } } } } } } };
}

/// One page of a list method's answer, the whole JSON-RPC response.
std::string list_page (const std::string& key,
const json& items,
const std::optional<std::string>& next = std::nullopt) {
    json result{ { key, items } };
    if (next) {
        result["nextCursor"] = *next;
    }
    return json{ { "jsonrpc", "2.0" }, { "id", 1 }, { "result", result } }.dump ();
}

json snapshot_element (const json& baseline, const std::string& method = "tools/list") {
    return { { "id", "n1" }, { "kind", "assert.snapshot" }, { "enabled", true },
        { "config", { { "method", method }, { "baseline", baseline } } } };
}

vayu::Request mcp_list_request (const std::string& content) {
    vayu::Request request;
    request.method       = vayu::HttpMethod::POST;
    request.url          = "http://127.0.0.1:1/mcp";
    request.body.mode    = vayu::BodyMode::Mcp;
    request.body.content = content;
    return request;
}

/// The `params.cursor` @p request carries, absent when it carries none.
std::optional<std::string> cursor_of (const vayu::Request& request) {
    const auto call = json::parse (request.body.content, nullptr, false);
    if (!call.is_object () || !call.contains ("params") ||
    !call["params"].contains ("cursor")) {
        return std::nullopt;
    }
    return call["params"]["cursor"].get<std::string> ();
}

// ---------------------------------------------------------------------------
// The element, its follow-up sender stubbed.
// ---------------------------------------------------------------------------

/// What one `step.after` run left: the outcomes and the step's test tally.
struct SnapshotRun {
    std::vector<ElementOutcome> outcomes;
    std::vector<vayu::TestResult> tests;
};

class AssertSnapshotPagesTest : public ::testing::Test {
    protected:
    vayu::Request request = mcp_list_request (R"({"method":"tools/list"})");
    vayu::Response response;
    /// The reply each cursor's page answers with; a cursor absent here is
    /// answered as an invalid cursor.
    std::map<std::string, std::string> pages;
    /// Replaces the page lookup above when set.
    std::function<PageAnswer (const vayu::Request&)> answer;
    bool bind_sender = true;
    /// Every follow-up the element asked for, in order.
    std::vector<vayu::Request> sent;

    void first_page (const std::string& text) {
        response.status_code = 200;
        response.body        = text;
        response.body_size   = text.size ();
    }

    [[nodiscard]] SnapshotRun apply (const json& element) {
        const auto elements = vayu::core::compile_elements (json::array ({ element }));
        vayu::ScriptResult pre;
        vayu::ScriptResult post;
        ElementContext ctx{
            .request            = request,
            .response           = &response,
            .run_pre_script     = {},
            .run_post_script    = {},
            .pre_script_result  = pre,
            .post_script_result = post,
            .set_variable       = {},
            .should_stop        = {},
            .record_metric      = {},
        };
        if (bind_sender) {
            ctx.send_list_page = [this] (const vayu::Request& page) {
                sent.push_back (page);
                return answer ? answer (page) : lookup (page);
            };
        }
        SnapshotRun run;
        ElementPipeline::run (Phase::StepAfter, ctx, elements, run.outcomes);
        run.tests = post.tests;
        return run;
    }

    private:
    PageAnswer lookup (const vayu::Request& page) const {
        const auto cursor = cursor_of (page);
        const auto found  = cursor ? pages.find (*cursor) : pages.end ();
        if (found == pages.end ()) {
            return std::unexpected (ListPageFailure{
            .message =
            "protocol failure: JSON-RPC error -32602: Invalid cursor" });
        }
        return found->second;
    }
};

std::string message_of (const SnapshotRun& run) {
    return run.outcomes.empty () ? "" : run.outcomes[0].message.value_or ("");
}

const json& three_tools () {
    static const json tools =
    json::array ({ tool_item ("alpha"), tool_item ("beta"), tool_item ("gamma") });
    return tools;
}

TEST_F (AssertSnapshotPagesTest, AChangeOnALaterPageFailsNamingTheItemAndItsPointer) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c2"));
    pages["c2"] = list_page ("tools",
    json::array ({ tool_item ("beta", "integer"), tool_item ("delta") }));

    const auto run = apply (snapshot_element (three_tools ()));
    ASSERT_EQ (run.outcomes.size (), 1u);
    EXPECT_EQ (run.outcomes[0].status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list changed: removed 'gamma'; added 'delta'; 'beta' differs at "
    "/inputSchema/properties/x/type");
    ASSERT_EQ (run.tests.size (), 1u);
    EXPECT_FALSE (run.tests[0].passed);
}

TEST_F (AssertSnapshotPagesTest, ItemsMovedAcrossPagesStillMatch) {
    first_page (list_page ("tools", json::array ({ tool_item ("gamma") }), "c2"));
    pages["c2"] = list_page ("tools", json::array ({ tool_item ("beta") }), "c3");
    pages["c3"] = list_page ("tools", json::array ({ tool_item ("alpha") }));

    const auto run = apply (snapshot_element (three_tools ()));
    ASSERT_EQ (run.outcomes.size (), 1u);
    EXPECT_EQ (run.outcomes[0].status, "ok") << message_of (run);
    ASSERT_EQ (sent.size (), 2u);
    EXPECT_EQ (cursor_of (sent[0]), "c2");
    EXPECT_EQ (cursor_of (sent[1]), "c3");
}

// The follow-up is the call the step sent with `params.cursor` added: a bare
// call gains `params`, and an envelope keeps its own id and members.
TEST_F (AssertSnapshotPagesTest, TheFollowUpIsTheStepsCallWithItsCursorSet) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c2"));
    pages["c2"] =
    list_page ("tools", json::array ({ tool_item ("beta"), tool_item ("gamma") }));
    request.headers.add ("X-Trace", "kept");

    for (const char* content : { R"({"method":"tools/list"})",
         R"({"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"x":1}})" }) {
        SCOPED_TRACE (content);
        request.body.content = content;
        sent.clear ();
        EXPECT_EQ (apply (snapshot_element (three_tools ())).outcomes.at (0).status, "ok");
        ASSERT_EQ (sent.size (), 1u);
        auto expected                = json::parse (content);
        expected["params"]["cursor"] = "c2";
        EXPECT_EQ (json::parse (sent[0].body.content), expected);
        EXPECT_EQ (sent[0].headers.at ("X-Trace"), "kept");
        EXPECT_EQ (sent[0].url, request.url);
    }
}

TEST_F (AssertSnapshotPagesTest, AnUnpagedReplyAsksForNoPage) {
    first_page (list_page ("tools", three_tools ()));
    EXPECT_EQ (apply (snapshot_element (three_tools ())).outcomes.at (0).status, "ok");
    // An empty cursor ends a list as an absent one does.
    first_page (list_page ("tools", three_tools (), ""));
    EXPECT_EQ (apply (snapshot_element (three_tools ())).outcomes.at (0).status, "ok");
    EXPECT_TRUE (sent.empty ());
}

TEST_F (AssertSnapshotPagesTest, APageCapFailsNamingTheCap) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c"));
    answer = [] (const vayu::Request& page) -> PageAnswer {
        return list_page ("tools", json::array (), cursor_of (page).value_or ("") + "c");
    };

    const auto run = apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list was not compared: it still had a nextCursor after 100 pages, "
    "the most assert.snapshot reads");
    EXPECT_EQ (sent.size (), vayu::core::constants::elements::MAX_SNAPSHOT_PAGES - 1);
}

TEST_F (AssertSnapshotPagesTest, ARepeatedCursorFails) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c2"));
    pages["c2"] = list_page ("tools", json::array ({ tool_item ("beta") }), "c2");

    const auto run = apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list was not compared: page 2 handed back a cursor already sent, so "
    "the list would never end");
}

TEST_F (AssertSnapshotPagesTest, AListPastTheItemBudgetFails) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c2"));
    json many = json::array ();
    for (size_t i = 0; i < vayu::core::constants::elements::MAX_SNAPSHOT_ITEMS; ++i) {
        many.push_back ({ { "name", "t" + std::to_string (i) } });
    }
    pages["c2"] = list_page ("tools", many);

    const auto run = apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list was not compared: its pages hold more than 10000 items, the "
    "most assert.snapshot reads");
}

TEST_F (AssertSnapshotPagesTest, APageThatCannotBeReadFailsNamingThePage) {
    first_page (list_page ("tools", json::array ({ tool_item ("alpha") }), "c2"));
    const std::vector<std::pair<std::string, std::string>> cases{
        { R"({"jsonrpc":"2.0","id":1,"result":{}})", "page 2 holds no 'result.tools' list" },
        { "not json", "page 2: " + std::string (vayu::core::constants::elements::BODY_UNREADABLE_MESSAGE) },
    };
    for (const auto& [text, why] : cases) {
        SCOPED_TRACE (text);
        pages["c2"]    = text;
        const auto run = apply (snapshot_element (three_tools ()));
        EXPECT_EQ (run.outcomes.at (0).status, "failed");
        EXPECT_EQ (message_of (run), "tools/list was not compared: " + why);
    }
    // The sender's own failure, as the reply reader worded it.
    pages.clear ();
    EXPECT_EQ (message_of (apply (snapshot_element (three_tools ()))),
    "tools/list was not compared: page 2: protocol failure: JSON-RPC error "
    "-32602: Invalid cursor");
}

// Page one alone matches the baseline here, so a run that compared it would
// pass: the failure is the evidence that nothing was compared on part of a list.
TEST_F (AssertSnapshotPagesTest, APagedReplyThisRunCannotFollowFails) {
    first_page (list_page ("tools", three_tools (), "c2"));
    bind_sender = false;
    auto run    = this->apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list was not compared: the reply is paged (nextCursor), and this "
    "run "
    "cannot follow pages");

    bind_sender       = true;
    request.body.mode = vayu::BodyMode::Json;
    run               = this->apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "failed");
    EXPECT_EQ (message_of (run),
    "tools/list was not compared: the reply is paged (nextCursor), and only an "
    "mcp request's pages are followed");
    EXPECT_TRUE (sent.empty ());
}

TEST_F (AssertSnapshotPagesTest, ABodyWithNoCallToSetACursorInFails) {
    first_page (list_page ("tools", three_tools (), "c2"));
    request.body.content = R"({"method":"tools/list","params":[1]})";
    EXPECT_EQ (message_of (apply (snapshot_element (three_tools ()))),
    "tools/list was not compared: page 2: the request's params is not an "
    "object to set a cursor in");
    EXPECT_TRUE (sent.empty ());
}

TEST_F (AssertSnapshotPagesTest, ACancelledPageIsNoVerdict) {
    first_page (list_page ("tools", three_tools (), "c2"));
    answer = [] (const vayu::Request&) -> PageAnswer {
        return std::unexpected (ListPageFailure{ .message = "stopped", .cancelled = true });
    };
    const auto run = apply (snapshot_element (three_tools ()));
    EXPECT_EQ (run.outcomes.at (0).status, "skipped");
    EXPECT_EQ (message_of (run), "tools/list was not compared: page 2: stopped");
    EXPECT_TRUE (run.tests.empty ());
}

// ---------------------------------------------------------------------------
// The design send: `execute_exchange`, which a collection run's steps share.
// ---------------------------------------------------------------------------

class AssertSnapshotPagesExchangeTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    vayu::http::routes::ExchangeOutcome send (const std::string& method,
    const json& element,
    const std::atomic<bool>* cancel = nullptr) {
        const json payload{ { "method", "POST" }, { "url", server_->url () },
            { "timeout", 5000 },
            { "body",
            { { "mode", "mcp" }, { "content", json{ { "method", method } }.dump () } } } };
        auto request = vayu::json::deserialize_request (payload);
        if (!request.is_ok ()) {
            ADD_FAILURE () << request.error ().message;
            return {};
        }
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;
        vayu::http::routes::ExchangeInputs inputs;
        inputs.request  = std::move (request).value ();
        inputs.elements = vayu::tests::compiled_elements ({ element });
        inputs.cancel   = cancel;
        return vayu::http::routes::execute_exchange (
        engine, jar, "", scopes, std::move (inputs));
    }

    /// The `params.cursor` of every @p method request the fixture received.
    std::vector<std::optional<std::string>> cursors_of (const std::string& method) const {
        std::vector<std::optional<std::string>> cursors;
        for (const auto& call : server_->calls ()) {
            if (call.method == method) {
                cursors.push_back (call.cursor);
            }
        }
        return cursors;
    }

    std::unique_ptr<McpFixtureServer> server_;
};

const ElementOutcome& snapshot_outcome (const vayu::http::routes::ExchangeOutcome& exchange) {
    static const ElementOutcome none;
    for (const auto& outcome : exchange.element_outcomes) {
        if (outcome.id == "n1") {
            return outcome;
        }
    }
    ADD_FAILURE () << "no assert.snapshot outcome";
    return none;
}

struct ListKind {
    const char* method;
    const char* key;
    const char* identity;
    void (McpFixtureServer::*set) (json, std::size_t);
};

// Every list the element knows pages on the fixture, one item a page, and is
// compared whole: the baseline lists the items in another order. Each page
// reached the server with headers that agree with its body, or the fixture
// would have answered `400`.
TEST_F (AssertSnapshotPagesExchangeTest, EveryListKindIsComparedOverEveryPage) {
    const std::vector<ListKind> kinds{
        { "tools/list", "tools", "name", &McpFixtureServer::set_tools },
        { "resources/list", "resources", "uri", &McpFixtureServer::set_resources },
        { "prompts/list", "prompts", "name", &McpFixtureServer::set_prompts },
    };
    for (const auto& kind : kinds) {
        SCOPED_TRACE (kind.method);
        json items = json::array ();
        for (const char* id : { "a", "b", "c" }) {
            items.push_back ({ { kind.identity, std::string ("item-") + id } });
        }
        ((*server_).*kind.set) (items, 1);
        const json reversed = json::array ({ items[2], items[1], items[0] });

        const auto exchange =
        send (kind.method, snapshot_element (reversed, kind.method));
        EXPECT_EQ (snapshot_outcome (exchange).status, "ok")
        << snapshot_outcome (exchange).message.value_or ("");
        EXPECT_EQ (cursors_of (kind.method),
        (std::vector<std::optional<std::string>>{ std::nullopt, "cursor-1", "cursor-2" }));
        ASSERT_HAS_VALUE (exchange.response.mcp_reply);
        EXPECT_EQ (exchange.response.mcp_reply->pages, 3u);
    }
}

TEST_F (AssertSnapshotPagesExchangeTest, ARenameOnPageTwoFailsTheStep) {
    server_->set_tools (
    json::array ({ tool_item ("alpha"), tool_item ("beta-renamed") }), 1);
    const auto exchange = send ("tools/list",
    snapshot_element (json::array ({ tool_item ("alpha"), tool_item ("beta") })));

    EXPECT_EQ (snapshot_outcome (exchange).status, "failed");
    EXPECT_EQ (snapshot_outcome (exchange).message.value_or (""),
    "tools/list changed: removed 'beta'; added 'beta-renamed'");
    bool failed_test = false;
    for (const auto& test : exchange.post_script_result.tests) {
        failed_test = failed_test ||
        (test.name == "tools/list matches the snapshot" && !test.passed);
    }
    EXPECT_TRUE (failed_test);
}

// The page count is on the live answer's `mcp` and the stored trace's alike,
// and a one-page reply carries none.
TEST_F (AssertSnapshotPagesExchangeTest, TheTraceCountsThePagesTheStepRead) {
    server_->set_tools (three_tools (), 2);
    auto exchange = send ("tools/list", snapshot_element (three_tools ()));
    EXPECT_EQ (snapshot_outcome (exchange).status, "ok");
    auto trace =
    vayu::http::routes::build_result_trace (exchange.request, exchange.response);
    EXPECT_EQ (trace["response"]["mcp"].value ("pages", 0), 2)
    << trace["response"].dump ();
    EXPECT_EQ (
    vayu::json::serialize (exchange.response, false)["mcp"].value ("pages", 0), 2);

    server_->set_tools (three_tools ());
    exchange = send ("tools/list", snapshot_element (three_tools ()));
    trace = vayu::http::routes::build_result_trace (exchange.request, exchange.response);
    EXPECT_EQ (trace["response"]["mcp"], json::object ()) << trace["response"].dump ();
}

// A page's time is the step's: the second page is held for `PAGE_DELAY`, so a
// healthy reading is at least that and one that drops the page is the first
// page's few milliseconds. Only a lower bound, which a slow runner cannot fail.
TEST_F (AssertSnapshotPagesExchangeTest, APagesTimeCountsTowardTheStep) {
    constexpr std::chrono::milliseconds PAGE_DELAY{ 300 };
    server_->set_tools (three_tools (), 2);
    server_->delay_cursor_pages (PAGE_DELAY);

    const auto exchange = send ("tools/list", snapshot_element (three_tools ()));
    EXPECT_EQ (snapshot_outcome (exchange).status, "ok");
    const double delay_ms = static_cast<double> (PAGE_DELAY.count ());
    EXPECT_GE (exchange.response.timing.total_ms, delay_ms);
    EXPECT_GE (exchange.response.timing.wire_ms, delay_ms);
}

// A run that ends while a page is in flight is the run ending: the assertion
// records no verdict, and the step is not failed by it.
TEST_F (AssertSnapshotPagesExchangeTest, ACancelledPageEndsTheStepWithoutAVerdict) {
    server_->set_tools (three_tools (), 2);
    server_->hang_cursor_pages ();
    std::atomic<bool> cancel{ false };
    vayu::http::routes::ExchangeOutcome exchange;
    std::thread step ([&] {
        exchange = send ("tools/list", snapshot_element (three_tools ()), &cancel);
    });
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] { return cursors_of ("tools/list").size () == 2; }));
    cancel.store (true);
    step.join ();

    EXPECT_EQ (snapshot_outcome (exchange).status, "skipped");
    for (const auto& test : exchange.post_script_result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// ---------------------------------------------------------------------------
// A collection run's step, whose latency and trace carry every page.
// ---------------------------------------------------------------------------

using vayu::tests::scenario_runner::ScenarioRunnerTest;

// Mutation check: leave `send_list_page` unbound in `execute_exchange` and the
// step fails "this run cannot follow pages".
TEST_F (ScenarioRunnerTest, AnMcpListStepIsComparedOverEveryPageInACollectionRun) {
    constexpr std::chrono::milliseconds PAGE_DELAY{ 300 };
    McpFixtureServer mcp;
    mcp.set_tools (three_tools (), 2);
    mcp.delay_cursor_pages (PAGE_DELAY);
    seed_collection ("col_1");
    const std::string body =
    json{ { "mode", "mcp" }, { "content", R"({"method":"tools/list"})" } }.dump ();
    seed_request ("req_a", 0, "", "", "", mcp.url (), "", "", body);
    auto stored = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (stored);
    stored->elements = json::array ({ snapshot_element (three_tools ()) }).dump ();
    db_->save_request (*stored);

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"], "passed") << trace.dump ();
    EXPECT_EQ (trace["response"]["mcp"].value ("pages", 0), 2)
    << trace["response"].dump ();
    // Lower bound only, as in the exchange case above.
    EXPECT_GE (rows[0].latency_ms, static_cast<double> (PAGE_DELAY.count ()));
    EXPECT_EQ (mcp.tools_list_cursors (),
    (std::vector<std::optional<std::string>>{ std::nullopt, "cursor-2" }));
}

} // namespace
