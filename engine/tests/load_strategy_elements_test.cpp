/**
 * @file tests/load_strategy_elements_test.cpp
 * @brief Load strategies: validation of a run's request-elements override, the retired script
 * fields, the elements a run applies per submission, and think timers.
 *
 * The `LoadStrategyTest` fixture is in `load_strategy_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "basic_auth_pair.hpp"
#include "echo_server.hpp"
#include "load_start_stamp.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

#include "load_strategy_fixture.hpp"

using vayu::tests::load_strategy::LoadStrategyTest;
using vayu::tests::load_strategy::TEST_DB_PATH;

// ============================================================================
// A single-request run's own `requestElements` (issue #1594)
// ============================================================================

// Validation: the `POST /runs` payload gate, mirroring
// `LifecycleElementsRunOverrideValidationTest` (elements_setup_teardown_test.cpp)
// for the sibling key #1573 added.

TEST (RequestElementsRunOverrideValidationTest, AbsentIsFine) {
    const nlohmann::json config = nlohmann::json::object ();
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

TEST (RequestElementsRunOverrideValidationTest, NullIsFine) {
    const nlohmann::json config{ { "requestElements", nullptr } };
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

TEST (RequestElementsRunOverrideValidationTest, MustBeAnArray) {
    const nlohmann::json config{ { "requestElements", nlohmann::json::object () } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("must be an array"), std::string::npos) << *reason;
}

// Unlike `lifecycleElements`, this key restricts no kind of its own - the
// whole refusal comes from the shared `Registry::validate`, so an unknown
// kind has to be refused here rather than compiled into a null element.
TEST (RequestElementsRunOverrideValidationTest, RefusesAnUnknownKind) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" },
    { "kind", "assert.nothing" }, { "config", nlohmann::json::object () } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("assert.nothing"), std::string::npos) << *reason;
}

// The config half of the same delegation: `assert.status` declares
// `additionalProperties: false` over `in` / `range`, so a caller reaching for
// a key that kind does not have is told at the payload gate rather than at
// the first submission, where the run is already going.
TEST (RequestElementsRunOverrideValidationTest, RefusesAConfigItsKindsSchemaRejects) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" },
    { "kind", "assert.status" }, { "config", { { "expected", 200 } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    // The refusal names the kind's label ("Assert status code",
    // `make_assert_status_kind`), not its wire kind.
    EXPECT_NE (reason->find ("Assert status code"), std::string::npos) << *reason;
}

TEST (RequestElementsRunOverrideValidationTest, AcceptsAScriptPreAndAnAssertStatus) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array (
    { nlohmann::json{ { "id", "el_1" }, { "kind", "script.pre" },
      { "config", { { "script", "pm.request.headers['X-A'] = '1';" } } } },
    nlohmann::json{ { "id", "el_2" }, { "kind", "assert.status" },
    { "config", { { "in", nlohmann::json::array ({ 200 }) } } } } }) } };
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

// `config.inline` is the per-element opt-in `RunContext::script_element_runs_inline`
// reads (issue #1495, documented in docs/engine/elements.md), so the payload
// gate has to accept it - a `script.*` schema that refused it would leave the
// marking unreachable through every validated write path there is.
TEST (RequestElementsRunOverrideValidationTest, AcceptsAScriptElementMarkedInline) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "script.post" },
    { "config", { { "script", "pm.test('ok', function () {});" }, { "inline", true } } } } }) } };
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

// A `control.*` kind, `timer.pacing` and `timer.throughput` all validate
// against `ElementOwner::Request` (nothing marks them collection-only), so
// without this check they would be silently accepted and then either no-op
// or misbehave on this run shape - `control.once`, for one, treats a null
// `controller_state` as "there is no later" and runs on every submission
// instead of the first. Refused by name instead, naming the kind that has no
// home here.
TEST (RequestElementsRunOverrideValidationTest, RefusesAControllerKind) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" },
    { "kind", "control.once" }, { "config", nlohmann::json::object () } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    // The refusal names the kind's human-readable label, not its wire kind -
    // "Once only" is what `make_control_once_kind` sets as `label`.
    EXPECT_NE (reason->find ("Once only"), std::string::npos) << *reason;
    EXPECT_NE (reason->find ("scenario"), std::string::npos) << *reason;
}

TEST (RequestElementsRunOverrideValidationTest, RefusesTimerPacingAndThroughput) {
    const std::vector<std::pair<std::string, nlohmann::json>> cases{
        { "timer.pacing", { { "everyMs", 1000 } } },
        { "timer.throughput", { { "targetPerMinute", 60 } } },
    };
    // The label each kind sets (`make_timer_pacing_kind` / `make_timer_throughput_kind`),
    // since the refusal names that rather than the wire kind string.
    const std::unordered_map<std::string, std::string> labels{
        { "timer.pacing", "Pacing" },
        { "timer.throughput", "Throughput" },
    };
    for (const auto& [kind, valid_config] : cases) {
        const nlohmann::json config{ { "requestElements",
        nlohmann::json::array ({ nlohmann::json{
        { "id", "el_1" }, { "kind", kind }, { "config", valid_config } } }) } };
        auto reason = vayu::core::validate_request_elements_run_override (config);
        ASSERT_HAS_VALUE (reason) << kind;
        EXPECT_NE (reason->find (labels.at (kind)), std::string::npos) << *reason;
    }
}

// A composed chain can carry a scenario-only element the user switched off
// (#3050). The pipeline skips a disabled element before its `apply` runs, so
// nothing can misbehave and the run is not refused. Mutation check: drop the
// `enabled` guard in `refuse_scenario_only_element` and this reddens.
TEST (RequestElementsRunOverrideValidationTest, AcceptsADisabledScenarioOnlyKind) {
    const std::vector<std::pair<std::string, nlohmann::json>> cases{
        { "timer.pacing", { { "everyMs", 1000 } } },
        { "control.once", nlohmann::json::object () },
    };
    for (const auto& [kind, valid_config] : cases) {
        const nlohmann::json config{ { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" },
        { "kind", kind }, { "enabled", false }, { "config", valid_config } } }) } };
        auto reason = vayu::core::validate_request_elements_run_override (config);
        EXPECT_FALSE (reason.has_value ()) << kind << ": " << reason.value_or ("");
    }
}

// Disabled skips the kind refusal only: `Registry::validate` still judges the
// entry, so a malformed config is caught now and not when it is switched on.
TEST (RequestElementsRunOverrideValidationTest, StillValidatesADisabledEntryConfig) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "assert.status" },
    { "enabled", false }, { "config", { { "expected", 200 } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Assert status code"), std::string::npos) << *reason;
}

TEST (RequestElementsRunOverrideValidationTest, RefusesAnEnabledEntryNamingItsLabelAndOrigin) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "assert.status" },
                             { "config", { { "in", nlohmann::json::array ({ 200 }) } } } },
    nlohmann::json{ { "id", "el_2" }, { "kind", "timer.pacing" },
    { "enabled", true }, { "config", { { "everyMs", 1000 } } },
    { "origin",
    { { "kind", "collection" }, { "scope", "folder" }, { "id", "col_9" },
    { "name", "Nightly" } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Pacing"), std::string::npos) << *reason;
    EXPECT_NE (reason->find ("from the collection 'Nightly'"), std::string::npos) << *reason;
    EXPECT_NE (reason->find ("scenario"), std::string::npos) << *reason;
    // The list is a merge of inherited and own entries, so a position names
    // nothing the user can find.
    EXPECT_EQ (reason->find ("Step "), std::string::npos) << *reason;
}

TEST (RequestElementsRunOverrideValidationTest, NamesTheRequestOrACollectionByOrigin) {
    const std::vector<std::pair<nlohmann::json, std::string>> cases{
        { { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" } }, "set on this request" },
        { { { "kind", "collection" }, { "scope", "collection" },
          { "id", "col_1" }, { "name", "Orders" } },
        "from the collection 'Orders'" },
        // A client-stamped origin without `scope` falls back to `kind`,
        // as `compile_elements` reads it.
        { { { "kind", "collection" }, { "id", "col_1" } }, "from a collection" },
        // A folder is a collection to the user, named or not.
        { { { "kind", "collection" }, { "scope", "folder" }, { "id", "col_2" } }, "from a collection" },
    };
    for (const auto& [origin, expected] : cases) {
        const nlohmann::json config{ { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "timer.pacing" },
        { "config", { { "everyMs", 1000 } } }, { "origin", origin } } }) } };
        auto reason = vayu::core::validate_request_elements_run_override (config);
        ASSERT_HAS_VALUE (reason) << origin.dump ();
        EXPECT_NE (reason->find (expected), std::string::npos) << *reason;
    }
}

// A payload written by hand carries no origin, so the entry is named by its id.
TEST (RequestElementsRunOverrideValidationTest, FallsBackToTheIdWithoutAnOrigin) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "my_pacing" },
    { "kind", "timer.pacing" }, { "config", { { "everyMs", 1000 } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Pacing"), std::string::npos) << *reason;
    EXPECT_NE (reason->find ("element 'my_pacing'"), std::string::npos) << *reason;
    EXPECT_EQ (reason->find ("Step "), std::string::npos) << *reason;
}

// The companion to the two refusals above: every phase-0 kind - the ones
// this run shape's own hooks actually dispatch - stays accepted.
TEST (RequestElementsRunOverrideValidationTest, AcceptsEveryPhaseZeroExtractAndAssertKind) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "extract.json" },
                             { "config", { { "path", "$.a" }, { "variable", "a" } } } },
    nlohmann::json{ { "id", "el_2" }, { "kind", "assert.contains" },
    { "config", { { "field", "body" }, { "text", "ok" } } } } }) } };
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

// `extract.header` reads only the response headers and writes a variable, both
// bound on this path (#3070). Mutation check: drop "extract.header" from
// `REQUEST_ELEMENTS_SUPPORTED_KINDS` and this reddens on the scenario-only
// refusal.
TEST (RequestElementsRunOverrideValidationTest, AcceptsAnExtractHeaderElement) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_header" }, { "kind", "extract.header" },
    { "config", { { "header", "X-Request-Id" }, { "variable", "requestId" } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// A schema assertion reads only the response body and records a test, both
// bound on this path (#3806). Mutation check: drop "assert.jsonschema" from
// `REQUEST_ELEMENTS_SUPPORTED_KINDS` and this reddens on the scenario-only
// refusal.
TEST (RequestElementsRunOverrideValidationTest, AcceptsAnAssertJsonSchemaElement) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_schema" }, { "kind", "assert.jsonschema" },
    { "config", { { "schema", { { "type", "object" } } } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// A snapshot assertion reads only the response body and records a test, both
// bound on this path (#3807). Mutation check: drop "assert.snapshot" from
// `REQUEST_ELEMENTS_SUPPORTED_KINDS` and this reddens on the scenario-only
// refusal.
TEST (RequestElementsRunOverrideValidationTest, AcceptsAnAssertSnapshotElement) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_snapshot" }, { "kind", "assert.snapshot" },
    { "config", { { "baseline", nlohmann::json::array ({ { { "name", "a" } } }) } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// The same `stamp_default_element_ids` default `lifecycleElements` gets:
// `Registry::validate` refuses an id-less entry outright, and a caller that
// names no id must get one rather than a 400 asking it to invent one.
// Mutation check: drop the `stamp_default_element_ids` call in
// `validate_request_elements_run_override` and this reddens on
// `Registry::validate`'s own "Item 1 is missing an id" refusal.
TEST (RequestElementsRunOverrideValidationTest, AcceptsAnEntryWithNoId) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "kind", "assert.status" },
    { "config", { { "in", nlohmann::json::array ({ 200 }) } } } } }) } };
    EXPECT_FALSE (vayu::core::validate_request_elements_run_override (config).has_value ());
}

namespace {

/// An enabled `assert.status` as `compose_elements` emits it: @p id declared
/// at the level @p origin_kind / @p origin_scope / @p origin_id names.
nlohmann::json composed_status_assert (const std::string& id,
const std::string& origin_kind,
const std::string& origin_scope,
const std::string& origin_id) {
    return nlohmann::json{ { "id", id }, { "kind", "assert.status" },
        { "config", { { "in", nlohmann::json::array ({ 200 }) } } },
        { "origin", { { "kind", origin_kind }, { "scope", origin_scope }, { "id", origin_id } } } };
}

} // namespace

// Ids are unique within one level's list, so a duplicated collection, or a
// folder repeated down a chain, repeats them across levels (#3101). Mutation
// check: validate the whole array in one `Registry::validate` call and this
// reddens on "has the same id".
TEST (RequestElementsRunOverrideValidationTest, AcceptsTheSameIdAtDifferentLevels) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ composed_status_assert ("el_1", "collection", "collection", "col_1"),
    composed_status_assert ("el_1", "collection", "folder", "col_2"),
    composed_status_assert ("el_1", "request", "request", "req_1") }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// A hand-written entry carries no origin and is the request's own level, apart
// from every stamped one.
TEST (RequestElementsRunOverrideValidationTest, AnEntryWithoutAnOriginIsALevelOfItsOwn) {
    nlohmann::json bare = composed_status_assert ("el_1", "request", "request", "req_1");
    bare.erase ("origin");
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array (
    { composed_status_assert ("el_1", "collection", "collection", "col_1"), bare }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// The level is the origin's kind, scope and id together: a folder and a
// collection that happened to share an id are still two levels.
TEST (RequestElementsRunOverrideValidationTest, ALevelIsKeyedOnKindScopeAndId) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ composed_status_assert ("el_1", "collection", "collection", "same"),
    composed_status_assert ("el_1", "collection", "folder", "same") }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

// The per-level split loosens where an id may repeat, not whether it may:
// two entries of one level sharing an id is still refused, and `Item N`
// counts within that level, not across the merged list.
TEST (RequestElementsRunOverrideValidationTest, RefusesTheSameIdWithinOneLevel) {
    const nlohmann::json config{ { "requestElements",
    nlohmann::json::array ({ composed_status_assert ("other", "collection", "collection", "col_1"),
    composed_status_assert ("el_1", "request", "request", "req_1"),
    composed_status_assert ("el_1", "request", "request", "req_1") }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Item 2 has the same id ('el_1')"), std::string::npos)
    << *reason;
}

// Judging per level must not widen what a request may carry: a collection-only
// kind is still refused wherever it sits, as the renderer's filter (#3070)
// assumes.
TEST (RequestElementsRunOverrideValidationTest, StillRefusesACollectionOnlyKindInACollectionLevel) {
    nlohmann::json setup =
    composed_status_assert ("el_1", "collection", "collection", "col_1");
    setup["kind"]   = "script.setup";
    setup["config"] = { { "script", "pm.environment.set('a', '1');" } };
    const nlohmann::json config{ { "requestElements", nlohmann::json::array ({ setup }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("can only be added to a collection"), std::string::npos)
    << *reason;
}

// The wire-shape rule the issue settles: a scenario's steps already carry
// their own resolved elements off the plan, so the two must not both claim
// what a step runs.
TEST (RequestElementsRunOverrideValidationTest, RefusedBesideAScenarioBlock) {
    const nlohmann::json config{ { "scenario",
                                 nlohmann::json{ { "source", "collection" },
                                 { "collectionId", "col_1" } } },
        { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_1" }, { "kind", "assert.status" },
        { "config", { { "in", nlohmann::json::array ({ 200 }) } } } } }) } };
    auto reason = vayu::core::validate_request_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("single-request run"), std::string::npos) << *reason;
}

// `refuse_legacy_script_fields` (routes.hpp) is the other half of the same
// gate - `POST /runs` runs it in front of both run shapes now that
// `requestElements` is the single-request path's only script slot. The route
// tests reach it through three of its five spellings on the resource routes;
// these read the rule itself, which is the only place the plural forms and
// the explicit-null case are stated.

TEST (LegacyScriptFieldRefusalTest, RefusesEveryRetiredSpellingCarryingAScript) {
    for (const char* key : { "preRequestScript", "preRequestScripts",
         "postRequestScript", "postRequestScripts", "tests" }) {
        const nlohmann::json json{ { key, "pm.test('ok', () => {});" } };
        auto reason = vayu::http::routes::refuse_legacy_script_fields (json);
        ASSERT_HAS_VALUE (reason) << key;
        EXPECT_NE (reason->find (key), std::string::npos) << *reason;
        EXPECT_NE (reason->find ("elements"), std::string::npos) << *reason;
    }
}

// An explicit `null` is what a client sends for "this request has no script",
// which is a payload the cut-over must keep accepting - refusing it would
// break every caller that spells absence rather than omitting the key.
TEST (LegacyScriptFieldRefusalTest, AcceptsAnExplicitNullForEveryRetiredSpelling) {
    for (const char* key : { "preRequestScript", "preRequestScripts",
         "postRequestScript", "postRequestScripts", "tests" }) {
        const nlohmann::json json{ { key, nullptr } };
        EXPECT_FALSE (vayu::http::routes::refuse_legacy_script_fields (json).has_value ())
        << key;
    }
}

TEST (LegacyScriptFieldRefusalTest, AcceptsAPayloadCarryingNoneOfThem) {
    const nlohmann::json json{ { "mode", "iterations" }, { "iterations", 1 },
        { "requestElements", nlohmann::json::array () } };
    EXPECT_FALSE (vayu::http::routes::refuse_legacy_script_fields (json).has_value ());
}

namespace {

/// A single-request load run driven the way `POST /runs` drives one, through
/// the route's own read of the payload's rows and auth plan and
/// `RunManager::start_run` against a real database - the row, the wait for a
/// terminal status, and the parsed summary every case below reads its answer
/// out of. A non-void helper cannot use `ASSERT_*`, so a run that never
/// finished or stored nothing fails the caller and answers an empty object.
nlohmann::json run_single_request_summary (vayu::db::Database& db,
const std::string& run_id,
const nlohmann::json& config) {
    vayu::core::ScenarioLimits limits;
    limits.max_data_rows  = vayu::core::constants::scenario::MAX_DATA_ROWS;
    limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
    auto read =
    vayu::http::routes::read_load_data_set (config, limits, /*is_scenario=*/false);
    if (!read.ok) {
        ADD_FAILURE () << "the route refused the payload: " << read.error;
        return nlohmann::json::object ();
    }

    vayu::db::Run row;
    row.id              = run_id;
    row.type            = vayu::RunType::Load;
    row.status          = vayu::RunStatus::Pending;
    row.config_snapshot = "{}";
    row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    row.end_time = 0;
    db.create_run (row);

    vayu::core::RunManager run_manager;
    if (!run_manager.start_run (run_id, config, db, nullptr,
        std::move (read.set), std::move (read.auth))) {
        ADD_FAILURE () << "start_run refused the payload";
        return nlohmann::json::object ();
    }

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (30);
    while (std::chrono::steady_clock::now () < deadline) {
        const auto stored = db.get_run (run_id);
        if (stored && stored->status != vayu::RunStatus::Running &&
        stored->status != vayu::RunStatus::Pending) {
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    run_manager.shutdown (std::chrono::milliseconds (15000));

    const auto stored = db.get_run (run_id);
    if (!stored || stored->summary.empty ()) {
        ADD_FAILURE () << "the run stored no summary";
        return nlohmann::json::object ();
    }
    return nlohmann::json::parse (stored->summary);
}

/// The `summary["elements"]` entry for @p element_id, or a null json when the
/// run reported none for it.
nlohmann::json element_entry (const nlohmann::json& summary, const std::string& element_id) {
    if (!summary.contains ("elements")) {
        return {};
    }
    for (const auto& entry : summary["elements"]) {
        const auto id = entry.find ("id");
        if (id != entry.end () && *id == element_id) {
            return entry;
        }
    }
    return {};
}

/// The single-request payload every case below starts from, with
/// @p elements attached as its `requestElements`.
nlohmann::json request_elements_payload (const std::string& url,
size_t iterations,
size_t concurrency,
const nlohmann::json& elements) {
    return { { "mode", "iterations" }, { "iterations", iterations },
        { "concurrency", concurrency }, { "url", url }, { "method", "GET" },
        { "timeout", 5000 }, { "requestElements", elements } };
}

} // namespace

// The headline: a declarative `step.after` kind runs on every submission of a
// single-request run and its verdict reaches the stored report. Mutation
// check: drop the `run_request_elements_after_submission` call from
// `submit_to_loop`'s completion lambda (load_strategy.cpp) and this reddens -
// `summary["elements"]` disappears entirely, because nothing ever tallied.
TEST_F (LoadStrategyTest, AnAssertStatusElementTalliesOnePassPerIteration) {
    const size_t ITERATIONS = 4;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-assert-pass",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_status" }, { "kind", "assert.status" },
    { "config", { { "in", nlohmann::json::array ({ 200 }) } } } } })));

    const auto entry = element_entry (summary, "el_status");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["kind"], "assert.status");
    EXPECT_EQ (entry["passed"], ITERATIONS);
    EXPECT_EQ (entry["failed"], 0u);
}

// The mirror. `/fast` answers 200, so an element expecting anything else
// fails on every submission - which is what separates "the element ran" from
// "the element ran and its verdict was read", the shape a tally that always
// reported a pass would still satisfy above.
TEST_F (LoadStrategyTest, AnAssertStatusElementTalliesOneFailurePerIteration) {
    const size_t ITERATIONS = 4;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-assert-fail",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_status" }, { "kind", "assert.status" },
    { "config", { { "in", nlohmann::json::array ({ 500 }) } } } } })));

    const auto entry = element_entry (summary, "el_status");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["failed"], ITERATIONS);
    EXPECT_EQ (entry["passed"], 0u);
}

// A body that is not JSON fails `assert.jsonpath` on every submission and
// leaves an optional `extract.json` skipped (#3041). Mutation check: restore
// the `skipped` branch in `AssertJsonPathElement` and `failed` reads 0.
TEST_F (LoadStrategyTest, AnUnreadableBodyFailsAJsonAssertionOnEverySubmission) {
    const size_t ITERATIONS = 4;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-unreadable-body",
    request_elements_payload (mock_server->html_url (), ITERATIONS, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_assert" }, { "kind", "assert.jsonpath" },
                             { "config", { { "path", "$.ok" }, { "exists", true } } } },
    nlohmann::json{ { "id", "el_extract" }, { "kind", "extract.json" },
    { "config", { { "path", "$.token" }, { "variable", "token" } } } } })));

    const auto assertion = element_entry (summary, "el_assert");
    ASSERT_FALSE (assertion.is_null ()) << summary.dump ();
    EXPECT_EQ (assertion["failed"], ITERATIONS);
    EXPECT_EQ (assertion["passed"], 0u);

    const auto extractor = element_entry (summary, "el_extract");
    ASSERT_FALSE (extractor.is_null ()) << summary.dump ();
    EXPECT_EQ (extractor["failed"], 0u) << "an optional extractor never fails";
}

// `extract.header` runs on every submission of a single-request run (#3070):
// a header the response carries is found whatever its case, and one it lacks
// tallies `missing`, its own bucket since #3100. The whitelist itself is held by
// `AcceptsAnExtractHeaderElement`; this drives the run past it.
TEST_F (LoadStrategyTest, AnExtractHeaderElementReadsAResponseHeaderOnEverySubmission) {
    const size_t ITERATIONS = 3;
    vayu::db::Database db (TEST_DB_PATH);

    const nlohmann::json found_element = { { "id", "el_found" }, { "kind", "extract.header" },
        { "config", { { "header", "content-type" }, { "variable", "contentType" } } } };
    const nlohmann::json missing_element = { { "id", "el_missing" },
        { "kind", "extract.header" },
        { "config", { { "header", "X-Absent" }, { "variable", "absent" } } } };
    const auto elements = nlohmann::json::array ({ found_element, missing_element });

    const auto summary = run_single_request_summary (db, "run-elements-extract-header",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 1, elements));

    const auto found = element_entry (summary, "el_found");
    ASSERT_FALSE (found.is_null ()) << summary.dump ();
    EXPECT_EQ (found["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (found["failed"], 0u) << summary.dump ();

    const auto missing = element_entry (summary, "el_missing");
    ASSERT_FALSE (missing.is_null ()) << summary.dump ();
    EXPECT_EQ (missing["missing"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (missing["skipped"], 0u) << summary.dump ();
    EXPECT_EQ (missing["passed"], 0u) << summary.dump ();
}

// An inline `script.pre` mutates the request the submission actually sends,
// not a copy that is then thrown away - asserted off the listener, because a
// header written onto the wrong copy still reaches `pm.request` and would
// satisfy any assertion made inside the script itself.
TEST_F (LoadStrategyTest, AnInlineScriptPreElementsHeaderEditReachesTheWire) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-inline-pre",
    request_elements_payload (echo.url (), 2, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "pm.request.headers['X-Signed'] = 'yes';" }, { "inline", true } } } } })));

    EXPECT_EQ (echo.header ("X-Signed"), "yes") << summary.dump ();
}

namespace {

/// What an inline script reads about its own submission, as one string:
/// `vu/iteration/row/bare-column|replaceIn(vu/iteration/data.user)`. The row
/// half is guarded so an unbound row reads `no-row` rather than throwing,
/// which keeps a failure's message about the value that was wrong.
constexpr const char* SEEN_IDENTITY_JS =
"(pm.info.vu + '/' + pm.info.iteration + '/' +"
" (pm.iterationData ? pm.iterationData.get('user') : 'no-row') + '/' +"
" pm.variables.get('user') + '|' +"
" pm.variables.replaceIn('{{$vu}}/{{$iteration}}/{{data.user}}'))";

/// Two rows over four iterations, so the cursor wraps and every submission
/// has its own iteration: iteration `i` binds row `i % 2`.
nlohmann::json two_user_rows () {
    return nlohmann::json::array ({ { { "user", "ada" } }, { { "user", "bob" } } });
}

} // namespace

// #3124: an inline `script.pre` on a single-request load run reads the
// iteration, the virtual user and the row its own submission was bound with,
// through every accessor - `pm.info`, `pm.iterationData`, the bare column on
// `pm.variables` and `replaceIn`. Read off the wire, one header per
// submission. Mutation check: drop `bind_submission_identity` from
// `run_request_elements_step_before` and every header reads
// `undefined/undefined/no-row/undefined|1/0/{{data.user}}`.
TEST_F (LoadStrategyTest, AnInlineScriptPreReadsTheRowIterationAndUserOfItsSubmission) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config    = request_elements_payload (echo.url (), 4, 2,
    nlohmann::json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    std::string ("pm.request.headers['X-Seen'] = ") + SEEN_IDENTITY_JS + ";",
    /*inline_script=*/true) }));
    config["data"] = two_user_rows ();

    const auto summary =
    run_single_request_summary (db, "run-inline-pre-identity", config);

    auto seen = echo.header_per_request ("X-Seen");
    std::sort (seen.begin (), seen.end ());
    EXPECT_EQ (seen,
    (std::vector<std::string>{ "1/0/ada/ada|1/0/ada", "1/1/bob/bob|1/1/bob",
    "1/2/ada/ada|1/2/ada", "1/3/bob/bob|1/3/bob" }))
    << summary.dump ();
}

namespace {

/// What an inline script reads about the saved request it runs for, as one
/// string; `typeof` keeps an unset field a readable word.
constexpr const char* SEEN_REQUEST_JS =
"(typeof pm.info.requestId === 'undefined' ? 'no-id' : pm.info.requestId) + "
"'/' +"
" (typeof pm.info.requestName === 'undefined' ? 'no-name' : "
"pm.info.requestName)";

/// An inline `script.pre` that puts what `SEEN_REQUEST_JS` read on the wire.
nlohmann::json pre_request_identity_elements () {
    return nlohmann::json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    std::string ("pm.request.headers['X-Seen'] = ") + SEEN_REQUEST_JS + ";",
    /*inline_script=*/true) });
}

} // namespace

// #3460: an inline `script.pre` reads the request the run was started from as
// `pm.info.requestId` / `requestName`, the way the deferred replay and a Send
// do. Mutation check: drop the two `request_id` / `request_name` binds from
// `bind_submission_identity` and every header reads `no-id/no-name`.
TEST_F (LoadStrategyTest, AnInlineScriptPreReadsTheRequestIdAndNameOfItsRun) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config =
    request_elements_payload (echo.url (), 2, 1, pre_request_identity_elements ());
    config["requestId"]   = "req_orders";
    config["requestName"] = "Place order";

    const auto summary =
    run_single_request_summary (db, "run-inline-pre-request-identity", config);

    EXPECT_EQ (echo.header_per_request ("X-Seen"),
    (std::vector<std::string>{ "req_orders/Place order", "req_orders/Place order" }))
    << summary.dump ();
}

// The name falls back to the linked row's when the payload carries only the
// id, as it does for the replay (`read_run_script_identity`). Mutation check:
// as above.
TEST_F (LoadStrategyTest, AnInlineScriptPreReadsTheLinkedRowsNameWhenThePayloadHasOnlyTheId) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    vayu::db::Collection collection;
    collection.id   = "col_orders";
    collection.name = "Orders";
    db.create_collection (collection);
    vayu::db::Request saved;
    saved.id            = "req_orders";
    saved.collection_id = collection.id;
    saved.name          = "Place order";
    saved.method        = vayu::HttpMethod::GET;
    saved.url           = echo.url ();
    saved.created_at    = 1;
    saved.updated_at    = 1;
    db.save_request (saved);

    auto config =
    request_elements_payload (echo.url (), 1, 1, pre_request_identity_elements ());
    config["requestId"] = saved.id;

    const auto summary =
    run_single_request_summary (db, "run-inline-pre-request-fallback", config);

    EXPECT_EQ (echo.header_per_request ("X-Seen"),
    (std::vector<std::string>{ "req_orders/Place order" }))
    << summary.dump ();
}

// A run started from no saved request leaves both undefined rather than empty
// strings, which is what keeps a script's `if (pm.info.requestId)` honest.
TEST_F (LoadStrategyTest, AnInlineScriptPreReadsNoRequestIdentityOnARunWithoutOne) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-inline-pre-no-request",
    request_elements_payload (echo.url (), 1, 1, pre_request_identity_elements ()));

    EXPECT_EQ (echo.header_per_request ("X-Seen"),
    (std::vector<std::string>{ "no-id/no-name" }))
    << summary.dump ();
}

// The completion side: an inline `script.post` reads the same identity.
// Mutation check: drop the two binds and the element tallies `failed`.
TEST_F (LoadStrategyTest, AnInlineScriptPostReadsTheRequestIdAndNameOfItsRun) {
    const size_t ITERATIONS = 2;
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const std::string script =
    std::string ("pm.test('names its request', function () { pm.expect (") +
    SEEN_REQUEST_JS + ").to.equal ('req_orders/Place order'); });";
    auto config         = request_elements_payload (echo.url (), ITERATIONS, 1,
    nlohmann::json::array ({ vayu::tests::script_element_json (
    "el_post", "script.post", script, /*inline_script=*/true) }));
    config["requestId"] = "req_orders";
    config["requestName"] = "Place order";

    const auto summary =
    run_single_request_summary (db, "run-inline-post-request-identity", config);

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (entry["failed"], 0u) << summary.dump ();
}

// The same on the completion side: an inline `script.post` reads what the
// request it ran beside was bound with, which that request carries in
// `X-Bound` through the binder's own `{{$vu}}`, `{{$iteration}}` and
// `{{data.user}}`. Mutation check: drop `bind_submission_identity` from
// `run_request_elements_after_submission` and this test and the shared-request one below fail.
TEST_F (LoadStrategyTest, AnInlineScriptPostReadsTheRowIterationAndUserOfTheRequestItRanBeside) {
    const size_t ITERATIONS = 4;
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const std::string script = std::string ("pm.test('beside', function () {") + " pm.expect(" +
    SEEN_IDENTITY_JS + ").to.equal(pm.request.headers.get('X-Bound'));" + " });";
    auto config       = request_elements_payload (echo.url (), ITERATIONS, 2,
    nlohmann::json::array ({ vayu::tests::script_element_json (
    "el_post", "script.post", script, /*inline_script=*/true) }));
    config["data"]    = two_user_rows ();
    config["headers"] = { { "X-Bound",
    "{{$vu}}/{{$iteration}}/{{data.user}}/{{data.user}}|"
    "{{$vu}}/{{$iteration}}/{{data.user}}" } };

    const auto summary =
    run_single_request_summary (db, "run-inline-post-identity", config);

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (entry["failed"], 0u) << summary.dump ();
}

// A run sent without rows still tells an inline script which submission it
// is, and leaves `pm.iterationData` absent rather than an empty row - the
// distinction the deferred replay keeps (`load_data_test.cpp`). Mutation
// check: drop `bind_submission_identity` from
// `run_request_elements_step_before` and every header reads
// `undefined/undefined/undefined|1/0`.
TEST_F (LoadStrategyTest, WithoutRowsAnInlineScriptPreStillReadsItsIterationAndUser) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-inline-pre-no-rows",
    request_elements_payload (echo.url (), 3, 1,
    nlohmann::json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.request.headers['X-Seen'] ="
    " typeof pm.iterationData + '/' + pm.info.vu + '/' + pm.info.iteration +"
    " '|' + pm.variables.replaceIn('{{$vu}}/{{$iteration}}');",
    /*inline_script=*/true) })));

    auto seen = echo.header_per_request ("X-Seen");
    std::sort (seen.begin (), seen.end ());
    EXPECT_EQ (seen,
    (std::vector<std::string>{ "undefined/1/0|1/0", "undefined/1/1|1/1", "undefined/1/2|1/2" }))
    << summary.dump ();
}

// The submission that sends the shared request - no rows, no template, no
// `step.before` kind - still hands its identity to an inline `script.post`.
// Mutation check: drop `bind_submission_identity` from
// `run_request_elements_after_submission` and this test and the one above fail.
TEST_F (LoadStrategyTest, AnInlineScriptPostOnTheSharedRequestReadsItsIterationAndUser) {
    const size_t ITERATIONS = 3;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-inline-post-shared",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 1,
    nlohmann::json::array ({ vayu::tests::script_element_json ("el_post", "script.post",
    "pm.test('identity', function () {"
    "  pm.expect(typeof pm.iterationData).to.equal('undefined');"
    "  pm.expect(pm.info.vu).to.equal(1);"
    "  pm.expect(pm.info.iteration).to.be.within(0, 2);"
    "  pm.expect(pm.variables.replaceIn('{{$iteration}}'))"
    "    .to.equal(String(pm.info.iteration));"
    "});",
    /*inline_script=*/true) })));

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (entry["failed"], 0u) << summary.dump ();
}

// Issue #2473 on the single-request path: a basic password an inline
// `script.pre` sets reaches the wire, applied after the submission's residual
// pass rather than encoded around the token when the run's request was built.
// Mutation check: leave `LoadAuthPlan::after_scripts` false in
// `read_load_data_set` and the wire carries `user:{{password}}`.
TEST_F (LoadStrategyTest, AnInlineScriptPreSetsAPasswordThatReachesTheWireThroughLateAuth) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config    = request_elements_payload (echo.url (), 2, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "pm.environment.set('password', 's3cret');" }, { "inline", true } } } } }));
    config["auth"] = { { "mode", "basic" }, { "username", "user" },
        { "password", "{{password}}" } };

    const auto summary = run_single_request_summary (db, "run-late-auth", config);

    EXPECT_EQ (vayu::tests::basic_pair_of (echo.header ("Authorization")), "user:s3cret")
    << summary.dump ();
}

// #3131 on the single-request path: an inline `script.pre` that assigns
// `pm.request.auth` replaces the run's own credential on every submission,
// through the write-back every run kind shares.
TEST_F (LoadStrategyTest, AnInlineScriptPreAssignedAuthReplacesTheRunsOwn) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config    = request_elements_payload (echo.url (), 2, 1,
    nlohmann::json::array ({ vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.request.auth = { type: 'basic', basic: { username: 'ada', password: 'pw' } };",
    /*inline_script=*/true) }));
    config["auth"] = { { "mode", "bearer" }, { "token", "run-token" } };

    const auto summary = run_single_request_summary (db, "run-script-auth", config);

    const auto sent = echo.header_per_request ("Authorization");
    ASSERT_EQ (sent.size (), 2u) << summary.dump ();
    for (const auto& authorization : sent) {
        EXPECT_EQ (vayu::tests::basic_pair_of (authorization), "ada:pw")
        << summary.dump ();
    }
}

// Mixed credentials on the same path: the submission's row answers one half at
// the bind and the script the other after it.
TEST_F (LoadStrategyTest, ARowAndAScriptEachAnswerHalfOfABasicPairThroughLateAuth) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config    = request_elements_payload (echo.url (), 1, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "pm.environment.set('password', 's3cret');" }, { "inline", true } } } } }));
    config["auth"] = { { "mode", "basic" }, { "username", "{{data.user}}" },
        { "password", "{{password}}" } };
    config["data"] = nlohmann::json::array ({ { { "user", "ada" } } });

    const auto summary = run_single_request_summary (db, "run-late-auth-mixed", config);

    EXPECT_EQ (vayu::tests::basic_pair_of (echo.header ("Authorization")), "ada:s3cret")
    << summary.dump ();
}

// The same element left unmarked runs nowhere: `script.pre` has no deferred
// replay to fall back to (only `script.post` does), so an un-inlined one is
// skipped - not deferred (#2144) - and its edit never reaches the wire. This
// is the contrast that makes the `allInline` case below an assertion about
// the override rather than about scripts running at all.
TEST_F (LoadStrategyTest, AnUnmarkedScriptPreElementIsSkippedRatherThanRun) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-deferred-pre",
    request_elements_payload (echo.url (), 2, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "pm.request.headers['X-Signed'] = 'yes';" } } } } })));

    EXPECT_FALSE (echo.has_header ("X-Signed")) << summary.dump ();
    const auto entry = element_entry (summary, "el_pre");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["skipped"], 2u) << summary.dump ();
    EXPECT_EQ (entry["deferred"], 0u) << summary.dump ();
}

// A disabled element is the other skip that is not a deferral (#2144). A
// `script.post` is the kind chosen because its enabled, un-inlined twin below
// is the one that tallies `deferred`: the pipeline must answer "disabled"
// before it ever asks the load path's deferral hook.
TEST_F (LoadStrategyTest, ADisabledScriptPostElementTalliesSkippedNotDeferred) {
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-disabled-post",
    request_elements_payload (mock_server->fast_url (), 3, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_post" },
    { "kind", "script.post" }, { "enabled", false },
    { "config", { { "script", "pm.test('runs', function () {});" } } } } })));

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["skipped"], 3u) << summary.dump ();
    EXPECT_EQ (entry["deferred"], 0u) << summary.dump ();
    EXPECT_FALSE (summary.contains ("tests"))
    << "a disabled script.post must not be replayed (#2167): " << summary.dump ();
}

// `elements.scripts: "allInline"` (issue #1495's run-level override, read by
// `RunContext::script_element_runs_inline`) forces the element above to run
// after all, off the run payload's own `elements` object rather than any
// marking inside `requestElements`.
TEST_F (LoadStrategyTest, TheAllInlineScriptsOverrideForcesAnUnmarkedScriptPreInline) {
    vayu::tests::EchoServer echo;
    vayu::db::Database db (TEST_DB_PATH);

    auto config        = request_elements_payload (echo.url (), 2, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "pm.request.headers['X-Signed'] = 'yes';" } } } } }));
    config["elements"] = { { "scripts", "allInline" } };

    const auto summary =
    run_single_request_summary (db, "run-elements-all-inline", config);

    EXPECT_EQ (echo.header ("X-Signed"), "yes") << summary.dump ();
}

// An unmarked `script.post` is left to the run's completion replay, exactly
// where a `tests` string used to go: deferred on every submission (#2144),
// and counted once per sampled response by `validate_scripts` under
// `summary["tests"]`.
TEST_F (LoadStrategyTest, AnUnmarkedScriptPostElementDefersToTheCompletionReplay) {
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-deferred-post",
    request_elements_payload (mock_server->fast_url (), 3, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_post" }, { "kind", "script.post" },
    { "config",
    { { "script",
    "pm.test('status', function () { "
    "pm.expect(pm.response.code).to.equal(200); });" } } } } })));

    ASSERT_TRUE (summary.contains ("tests")) << summary.dump ();
    EXPECT_GT (summary["tests"]["passed"].get<size_t> (), 0u) << summary.dump ();
    EXPECT_EQ (summary["tests"]["failed"], 0u) << summary.dump ();

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["deferred"], 3u)
    << "the pipeline hook must leave it to the replay: " << summary.dump ();
    EXPECT_EQ (entry["skipped"], 0u) << summary.dump ();
    EXPECT_EQ (entry["passed"], 0u);
}

// The same element marked `inline` runs per submission instead - and must not
// then run a second time on the deferred replay. `compile_step_elements`
// prevents that by folding only an *un-inlined* `script.post` into
// `RunContext::test_scripts`, which is what the absent `tests` node below
// reads: fold an inline one in too and this run would report both an
// `elements` tally and a `tests` tally for one script.
TEST_F (LoadStrategyTest, AnInlineScriptPostElementRunsPerSubmissionAndIsNotReplayed) {
    const size_t ITERATIONS = 3;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-inline-post",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_post" }, { "kind", "script.post" },
    { "config",
    { { "script",
      "pm.test('status', function () { "
      "pm.expect(pm.response.code).to.equal(200); });" },
    { "inline", true } } } } })));

    const auto entry = element_entry (summary, "el_post");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (entry["skipped"], 0u) << summary.dump ();
    EXPECT_EQ (entry["deferred"], 0u) << summary.dump ();
    EXPECT_FALSE (summary.contains ("tests"))
    << "an inline script.post must not be replayed deferred as well: "
    << summary.dump ();
}

// #3127: a single-request run's element row says why its inline scripts
// failed and what they logged, the same `ElementOutcomeCounts` rule a
// scenario step's row follows, and from the pre-request side as well as the
// post-request one, each entry with how many iterations produced it. Mutation
// check: drop the `outcome_messages` assignment from `run_step_script`
// (script_kinds.cpp) and neither row carries a list.
TEST_F (LoadStrategyTest, AnInlineScriptsThrowAndConsoleReachItsElementRow) {
    const size_t ITERATIONS = 4;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-script-messages",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, 2,
    nlohmann::json::array (
    { nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
      { "config", { { "script", "console.warn('signing');" }, { "inline", true } } } },
    nlohmann::json{ { "id", "el_post" }, { "kind", "script.post" },
    { "config",
    { { "script", "console.log('saw ' + pm.response.code); throw new Error('boom');" },
    { "inline", true } } } } })));

    const auto pre = element_entry (summary, "el_pre");
    ASSERT_FALSE (pre.is_null ()) << summary.dump ();
    EXPECT_EQ (pre.value ("console", nlohmann::json ()),
    (nlohmann::json::array (
    { { { "level", "warn" }, { "text", "signing" }, { "count", ITERATIONS } } })))
    << pre.dump ();
    EXPECT_FALSE (pre.contains ("messages"))
    << "a clean script said nothing wrong";

    const auto post = element_entry (summary, "el_post");
    ASSERT_FALSE (post.is_null ()) << summary.dump ();
    EXPECT_EQ (post.at ("error").get<size_t> (), ITERATIONS) << post.dump ();
    EXPECT_EQ (post.value ("console", nlohmann::json ()),
    (nlohmann::json::array (
    { { { "level", "log" }, { "text", "saw 200" }, { "count", ITERATIONS } } })))
    << post.dump ();
    const auto messages = post.value ("messages", nlohmann::json::array ());
    ASSERT_EQ (messages.size (), 1u) << post.dump ();
    EXPECT_EQ (messages[0].at ("kind").get<std::string> (), "error");
    EXPECT_NE (messages[0].at ("text").get<std::string> ().find ("boom"), std::string::npos)
    << post.dump ();
    EXPECT_EQ (messages[0].at ("count").get<size_t> (), ITERATIONS) << post.dump ();
}

// A load run's inline script keeps its `pm.sendRequest` summary line on its
// element row; that it builds no record is held by
// `ScriptRequestRecording.OnlyADesignSendAndASequentialRunTurnItOn`, as
// nothing in a load report could show one (#3633).
TEST_F (LoadStrategyTest, AnInlineScriptsSendRequestKeepsItsLineOnItsElementRow) {
    vayu::db::Database db (TEST_DB_PATH);

    auto config = request_elements_payload (mock_server->fast_url (), 2, 1,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config",
    { { "script", "pm.sendRequest('" + mock_server->fast_url () + "', function () {});" },
    { "inline", true } } } } }));
    config["allowScriptRequests"] = true;
    const auto summary = run_single_request_summary (db, "run-elements-send-line", config);

    const auto pre = element_entry (summary, "el_pre");
    ASSERT_FALSE (pre.is_null ()) << summary.dump ();
    EXPECT_FALSE (pre.contains ("messages")) << pre.dump ();
    const auto console = pre.value ("console", nlohmann::json::array ());
    ASSERT_FALSE (console.empty ()) << pre.dump ();
    for (const auto& line : console) {
        EXPECT_TRUE (
        line.value ("text", "").starts_with ("pm.sendRequest GET " + mock_server->fast_url () + " -> 200 ("))
        << pre.dump ();
    }
}

// `timer.think` holds a completed submission's concurrency slot for its wait
// without blocking the event-loop worker that completed it
// (`RunContext::reserve_think_wait`, counted back by `in_flight`). With N
// slots and M iterations the run cannot finish faster than the (M/N - 1)
// waits that separate the batches - a lower bound with slack, the way the
// concurrency tests above bound their own timings, not an exact figure.
TEST_F (LoadStrategyTest, AThinkTimerHoldsTheRunBackByItsWait) {
    const size_t ITERATIONS  = 6;
    const size_t CONCURRENCY = 2;
    const int WAIT_MS        = 250;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-elements-think",
    request_elements_payload (mock_server->fast_url (), ITERATIONS, CONCURRENCY,
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_think" },
    { "kind", "timer.think" }, { "config", { { "ms", WAIT_MS } } } } })));

    // Two waits' worth, minus generous slack: /fast itself costs about a
    // millisecond per submission, so anything near this figure can only be
    // the timer. The batch count is an integer division on purpose - it is
    // how many full N-wide batches the M submissions fall into.
    const size_t BATCHES = ITERATIONS / CONCURRENCY;
    const double floor_s =
    (static_cast<double> (BATCHES) - 1.0) * (WAIT_MS / 1000.0) * 0.75;
    ASSERT_TRUE (summary.contains ("test_duration")) << summary.dump ();
    EXPECT_GE (summary["test_duration"].get<double> (), floor_s) << summary.dump ();

    const auto entry = element_entry (summary, "el_think");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], ITERATIONS) << summary.dump ();
}

namespace {

constexpr int64_t MINUTE_THINK_MS = 60000;

/// A single-request run in @p mode against @p url for one second, carrying
/// one `timer.think` of a minute, which outlives the run.
nlohmann::json minute_think_payload (const std::string& url, nlohmann::json mode) {
    nlohmann::json config = std::move (mode);
    config["duration"]    = "1s";
    config["url"]         = url;
    config["method"]      = "GET";
    config["timeout"]     = 5000;
    config["requestElements"] =
    nlohmann::json::array ({ nlohmann::json{ { "id", "el_think" },
    { "kind", "timer.think" }, { "config", { { "ms", MINUTE_THINK_MS } } } } });
    return config;
}

/// The `summary["warnings"]` entry carrying @p code, or a null json.
nlohmann::json warning_entry (const nlohmann::json& summary, std::string_view code) {
    for (const auto& warning : summary.value ("warnings", nlohmann::json::array ())) {
        if (warning.value ("code", "") == code) {
            return warning;
        }
    }
    return {};
}

} // namespace

// #3541: a think timer on a constant-rate run is skipped and reserves nothing.
// Fifty arrivals at 50/s against /fast under a cap of twenty: a minute's
// reservation per completion fills the cap after twenty, so the broken run
// drops thirty and peaks at twenty; the healthy run's requests hold a slot
// for about a millisecond, so it drops none and peaks at what a catch-up
// burst stacks (at most 100 ms of arrivals, five). Mutation check: drop the
// skip predicate from the `step.between` dispatch in load_strategy.cpp and the
// drop, peak and tally expectations fail; drop the warning from
// `build_run_warnings` and the warning expectation fails.
TEST_F (LoadStrategyTest, AThinkTimerOnAConstantRateRunIsSkippedAndReservesNothing) {
    constexpr size_t MAX_IN_FLIGHT = 20;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-think-open-loop",
    minute_think_payload (mock_server->fast_url (),
    { { "mode", "constant_rps" }, { "rps", 50 }, { "maxInFlight", MAX_IN_FLIGHT } }));

    EXPECT_EQ (summary.value ("dropped_requests", size_t{ 1 }), 0u) << summary.dump ();
    EXPECT_LT (summary.value ("peak_concurrency", MAX_IN_FLIGHT), MAX_IN_FLIGHT)
    << summary.dump ();

    const auto entry = element_entry (summary, "el_think");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    const auto completed = summary.value ("total_requests", size_t{ 0 });
    EXPECT_GT (completed, 0u) << summary.dump ();
    EXPECT_EQ (entry["skipped"], completed) << summary.dump ();
    EXPECT_EQ (entry["passed"], 0u) << summary.dump ();

    const auto warning = warning_entry (summary, "think_timer_skipped_open_loop");
    ASSERT_FALSE (warning.is_null ()) << summary.dump ();
    EXPECT_EQ (warning.value ("message", ""), vayu::core::RunContext::OPEN_LOOP_TIMER_SKIP_REASON);
    EXPECT_EQ (warning["timers"], 1u);
}

// The closed loop keeps the reservation #3541 takes off the open one. Two
// users at constant_concurrency against /fast with a minute's think: each
// slot stays held past the run's end once its first request settles, so the
// run sends exactly two (without the reservation, hundreds) and says nothing
// about a skipped timer.
TEST_F (LoadStrategyTest, AThinkTimerOnAConstantConcurrencyRunStillHoldsItsSlot) {
    constexpr size_t CONCURRENCY = 2;
    vayu::db::Database db (TEST_DB_PATH);

    const auto summary = run_single_request_summary (db, "run-think-closed-loop",
    minute_think_payload (mock_server->fast_url (),
    { { "mode", "constant_concurrency" }, { "concurrency", CONCURRENCY } }));

    EXPECT_EQ (summary.value ("requests_sent", size_t{ 0 }), CONCURRENCY)
    << summary.dump ();
    const auto entry = element_entry (summary, "el_think");
    ASSERT_FALSE (entry.is_null ()) << summary.dump ();
    EXPECT_EQ (entry["passed"], CONCURRENCY) << summary.dump ();
    EXPECT_EQ (entry["skipped"], 0u) << summary.dump ();
    EXPECT_TRUE (warning_entry (summary, "think_timer_skipped_open_loop").is_null ())
    << summary.dump ();
}

// The live frame's `backpressure` and the stored tick's are one number (#1921):
// both read `RunContext::in_flight ()`, which counts a slot a `timer.think`
// wait still holds. Driven through `collect_metrics` with the counters set by
// hand, so the reservations are the only difference between that definition
// and `requestsSent - totalRequests`, and the wait outlives the test.
TEST_F (LoadStrategyTest, ThinkReservationsCountInTheLiveAndStoredBackpressureAlike) {
    const size_t SENT        = 3;
    const size_t THINKING    = 2;
    const int64_t WAIT_MS    = 60000;
    const std::string run_id = "run-think-backpressure";
    vayu::db::Database db (TEST_DB_PATH);

    auto context =
    std::make_shared<vayu::core::RunContext> (run_id, nlohmann::json::object ());
    context->requests_sent = SENT;
    for (size_t i = 0; i < THINKING; ++i) {
        context->reserve_think_wait (WAIT_MS);
    }
    ASSERT_EQ (context->in_flight (), SENT + THINKING);

    context->is_running = true;
    vayu::tests::stamp_load_start (*context);
    std::thread metrics (
    [context, &db] () { vayu::core::collect_metrics (context, &db); });

    // The stored tick is gated at 1 Hz; wait for the first one to land.
    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (5);
    while (db.count_metric_ticks (run_id) == 0 && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
    }
    context->is_running = false;
    metrics.join ();

    const auto stored = db.get_metric_ticks_since (run_id, 0);
    ASSERT_FALSE (stored.empty ())
    << "no tick was persisted within the deadline";
    const auto stored_tick = nlohmann::json::parse (stored.front ().payload);
    EXPECT_EQ (stored_tick["backpressure"].get<size_t> (), SENT + THINKING);

    // The live frame published at the same tick shares its wall-clock stamp.
    const auto batch = context->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    bool matched                         = false;
    constexpr std::string_view DATA_LINE = "\ndata: ";
    for (const auto& frame : batch.payloads) {
        const auto data_at = frame.find (DATA_LINE);
        ASSERT_NE (data_at, std::string::npos) << frame;
        const auto live =
        nlohmann::json::parse (frame.substr (data_at + DATA_LINE.size ()));
        if (live["timestamp"] != stored_tick["timestamp"]) {
            continue;
        }
        matched = true;
        EXPECT_EQ (live["backpressure"], stored_tick["backpressure"]) << frame;
    }
    EXPECT_TRUE (matched)
    << "no live frame carried the stored tick's timestamp";

    const auto published = context->latest_live_tick ();
    ASSERT_HAS_VALUE (published);
    EXPECT_EQ (published->in_flight, SENT + THINKING);
}
