/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file spec_coverage_test.cpp
 * @brief Contract coverage (issue #629): the rollup math, the status-pattern
 *        precedence, and the absent-not-zeros rule.
 *
 * The tally's own semantics are pinned here rather than through a run, because
 * the questions that matter - does a `2XX` count as hit by a status the
 * operation's own `200` already answered, is a transport error a response - are
 * decisions this file makes and no executor can change. The wiring that carries
 * them into a run's summary is pinned in scenario_runner_test.cpp and
 * runs_route_test.cpp.
 */

#include "optional_assert.hpp"
#include "vayu/core/spec_coverage.hpp"

#include "vayu/core/constants.hpp"

#include <gtest/gtest.h>

#include <set>
#include <string>
#include <vector>

namespace limits = vayu::core::constants::spec_document;

using vayu::core::build_coverage_payload;
using vayu::core::CoverageTally;
using vayu::core::DeclaredOperation;
using vayu::core::OperationIndex;
using vayu::core::OperationObservation;
using vayu::core::parse_declared_operations;
using vayu::core::validate_operations_index;

namespace {

DeclaredOperation op (const std::string& id,
const std::string& method,
const std::string& path,
std::vector<std::string> responses = { "200" }) {
    DeclaredOperation declared;
    declared.operation_id = id;
    declared.method       = method;
    declared.path         = path;
    declared.responses    = std::move (responses);
    return declared;
}

/// The stored `requests.spec_operation` text for one stamped identity.
std::string stamp (const std::string& id, const std::string& method, const std::string& path) {
    nlohmann::json stamped{ { "method", method }, { "path", path } };
    if (!id.empty ()) {
        stamped["operationId"] = id;
    }
    return stamped.dump ();
}

/// The row for @p path in a coverage payload, whatever order it was sorted into.
nlohmann::json row_for (const nlohmann::json& coverage, const std::string& path) {
    for (const auto& row : coverage["operations"]) {
        if (row["path"] == path) {
            return row;
        }
    }
    return nlohmann::json::object ();
}

} // namespace

// ============================================================================
// The index: what is stored, and what is refused
// ============================================================================

TEST (SpecCoverageIndex, AnAbsentOrUnreadableIndexIsNotMeasuredRatherThanEmpty) {
    EXPECT_FALSE (parse_declared_operations ("").has_value ());
    EXPECT_FALSE (parse_declared_operations ("not json").has_value ());
    EXPECT_FALSE (parse_declared_operations ("{\"operations\": []}").has_value ());
    // An array that *is* empty parses - the document declared nothing, which is
    // a different answer from having no index at all.
    const auto empty_index = parse_declared_operations ("[]");
    ASSERT_HAS_VALUE (empty_index);
    EXPECT_TRUE (empty_index->empty ());
}

TEST (SpecCoverageIndex, OneUnusableRowIsSkippedRatherThanCostingTheWholeIndex) {
    const auto declared = parse_declared_operations (R"([
        {"method": "get", "path": "/pets", "responses": ["200"]},
        {"method": "get"},
        "not an object",
        {"operationId": "createPet", "method": "post", "path": "/pets", "responses": ["201"]}
    ])");
    ASSERT_HAS_VALUE (declared);
    ASSERT_EQ (declared->size (), 2u);
    // Methods are upper-cased on the way in, so a document that wrote `get`
    // matches a request stamped `GET`.
    EXPECT_EQ ((*declared)[0].method, "GET");
    EXPECT_EQ ((*declared)[1].operation_id, "createPet");
}

TEST (SpecCoverageIndex, AMalformedIndexIsRefusedAtTheWriteRatherThanIgnoredLater) {
    EXPECT_TRUE (validate_operations_index (nlohmann::json::parse ("{}")).has_value ());
    EXPECT_TRUE (validate_operations_index (nlohmann::json::parse ("[3]")).has_value ());
    EXPECT_TRUE (
    validate_operations_index (nlohmann::json::parse (R"([{"method": "GET"}])")).has_value ());
    EXPECT_TRUE (validate_operations_index (
    nlohmann::json::parse (R"([{"method": "GET", "path": "/a", "responses": "200"}])"))
    .has_value ());
    EXPECT_TRUE (validate_operations_index (
    nlohmann::json::parse (R"([{"method": "GET", "path": "/a", "responses": [200]}])"))
    .has_value ());
    // `responses` is optional: an operation may genuinely declare none.
    EXPECT_FALSE (validate_operations_index (
    nlohmann::json::parse (R"([{"method": "GET", "path": "/a"}])"))
    .has_value ());
    EXPECT_FALSE (validate_operations_index (
    nlohmann::json::parse (R"([{"operationId": "listPets", "method": "GET", "path": "/a", "responses": ["2XX"]}])"))
    .has_value ());
}

// ============================================================================
// Identity resolution - operationId first, METHOD path second
// ============================================================================

TEST (SpecCoverageIndex, AnOperationIdWinsOverThePathItWasRenamedFrom) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/v2/pets"),
        op ("", "GET", "/health") };
    const OperationIndex index (declared);

    // The document moved the path; the request still carries the old one beside
    // the id, and the id is what identity follows.
    EXPECT_EQ (index.resolve (stamp ("listPets", "GET", "/pets")), 0u);
    // No id on either side - matched by method and path, case-insensitively on
    // the method.
    EXPECT_EQ (index.resolve (stamp ("", "get", "/health")), 1u);
    // An identity the document does not declare resolves to nothing rather than
    // to the nearest row.
    EXPECT_FALSE (index.resolve (stamp ("", "GET", "/unknown")).has_value ());
    EXPECT_FALSE (index.resolve ("").has_value ());
    EXPECT_FALSE (index.resolve ("not json").has_value ());
}

// ============================================================================
// The rollup
// ============================================================================

TEST (SpecCoverage, DeclaredResponsesArePartitionedIntoHitAndMissed) {
    const std::vector<DeclaredOperation> declared{ op (
    "listPets", "GET", "/pets", { "200", "404", "default" }) };
    OperationObservation seen;
    seen.sent           = 3;
    seen.statuses       = { { 200, 2 }, { 500, 1 } };
    const auto coverage = build_coverage_payload (declared, { seen }, 0);

    const auto row = row_for (coverage, "/pets");
    EXPECT_EQ (row["sent"].get<size_t> (), 3u);
    EXPECT_EQ (row["statusesSeen"], nlohmann::json::array ({ 200, 500 }));
    // 500 answers to `default`, which is the least specific pattern and the last
    // one tried - so both it and `200` are hit, and only `404` is missed.
    EXPECT_EQ (row["declaredHit"], nlohmann::json::array ({ "200", "default" }));
    EXPECT_EQ (row["declaredMissed"], nlohmann::json::array ({ "404" }));
    EXPECT_EQ (row["undeclaredSeen"], nlohmann::json::array ());
    EXPECT_EQ (coverage["declaredResponsesTotal"].get<size_t> (), 3u);
    EXPECT_EQ (coverage["declaredResponsesHit"].get<size_t> (), 2u);
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 1u);
}

TEST (SpecCoverage, AStatusHitsTheMostSpecificPatternAndLeavesTheRangeUnhit) {
    // The document declared two distinct responses; a run that only ever
    // produced 200 produced one of them. Counting `2XX` as hit as well would
    // report a promise the run never exercised.
    const std::vector<DeclaredOperation> declared{ op (
    "listPets", "GET", "/pets", { "200", "2XX" }) };
    OperationObservation seen;
    seen.sent           = 1;
    seen.statuses       = { { 200, 1 } };
    const auto coverage = build_coverage_payload (declared, { seen }, 0);

    const auto row = row_for (coverage, "/pets");
    EXPECT_EQ (row["declaredHit"], nlohmann::json::array ({ "200" }));
    EXPECT_EQ (row["declaredMissed"], nlohmann::json::array ({ "2XX" }));

    // 204 answers to no exact pattern, so the range takes it.
    OperationObservation other;
    other.sent        = 1;
    other.statuses    = { { 204, 1 } };
    const auto second = build_coverage_payload (declared, { other }, 0);
    EXPECT_EQ (row_for (second, "/pets")["declaredHit"], nlohmann::json::array ({ "2XX" }));
}

TEST (SpecCoverage, AnUndeclaredStatusIsAFindingRatherThanAMiss) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    OperationObservation seen;
    seen.sent           = 2;
    seen.statuses       = { { 200, 1 }, { 500, 1 } };
    const auto coverage = build_coverage_payload (declared, { seen }, 0);

    const auto row = row_for (coverage, "/pets");
    EXPECT_EQ (row["undeclaredSeen"], nlohmann::json::array ({ 500 }));
    EXPECT_EQ (row["declaredMissed"], nlohmann::json::array ());
    EXPECT_EQ (coverage["undeclaredStatusesSeen"].get<size_t> (), 1u);
}

TEST (SpecCoverage, UncoveredOperationsComeFirstBecauseTheyAreTheFinding) {
    const std::vector<DeclaredOperation> declared{ op ("a", "GET", "/covered"),
        op ("b", "GET", "/never"), op ("c", "GET", "/also-covered") };
    OperationObservation hit;
    hit.sent     = 1;
    hit.statuses = { { 200, 1 } };
    const auto coverage =
    build_coverage_payload (declared, { hit, OperationObservation{}, hit }, 0);

    ASSERT_EQ (coverage["operations"].size (), 3u);
    EXPECT_EQ (coverage["operations"][0]["path"], "/never");
    // Document order survives within each group, so two runs of one contract
    // print their rows the same way.
    EXPECT_EQ (coverage["operations"][1]["path"], "/covered");
    EXPECT_EQ (coverage["operations"][2]["path"], "/also-covered");
    EXPECT_EQ (coverage["operationsTotal"].get<size_t> (), 3u);
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 2u);
}

TEST (SpecCoverage, FindingsThatDidNotHappenAreAbsentRatherThanZero) {
    const std::vector<DeclaredOperation> declared{ op ("a", "GET", "/pets") };
    OperationObservation clean;
    clean.sent          = 1;
    clean.statuses      = { { 200, 1 } };
    const auto coverage = build_coverage_payload (declared, { clean }, 0);

    EXPECT_FALSE (coverage.contains ("transportErrors"));
    EXPECT_FALSE (coverage.contains ("undeclaredOperationRequests"));
    EXPECT_FALSE (row_for (coverage, "/pets").contains ("transportErrors"));
    EXPECT_FALSE (row_for (coverage, "/pets").contains ("statusesTruncated"));
}

TEST (SpecCoverage, TheTruncationCountIsDistinctStatusesHiddenNotEntriesTwoListsDropped) {
    // The two lists are capped separately and `undeclaredSeen` repeats codes
    // from `statusesSeen`, so a code past both caps used to be counted twice and
    // a code the undeclared list still carries counted as hidden (issue #786).
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    OperationObservation seen;
    seen.statuses[200] = 1;
    // 60 undeclared codes above the declared one, so both lists overflow the
    // cap of 50 and their shown halves are different sets.
    for (int status = 400; status < 460; ++status) {
        seen.statuses[status] = 1;
    }
    seen.sent = seen.statuses.size ();

    const auto row = row_for (build_coverage_payload (declared, { seen }, 0), "/pets");
    ASSERT_EQ (row["statusesSeen"].size (), limits::MAX_STATUSES_PER_OPERATION);
    ASSERT_EQ (row["undeclaredSeen"].size (), limits::MAX_STATUSES_PER_OPERATION);

    // What the row shows, counted the way a reader of the payload sees it:
    // either list carrying a code is that code disclosed.
    std::set<int> shown;
    for (const char* list : { "statusesSeen", "undeclaredSeen" }) {
        for (const auto& status : row[list]) {
            shown.insert (status.get<int> ());
        }
    }
    ASSERT_EQ (shown.size (), 51u);
    // 61 observed, 51 named: the shared counter reported 21 for this row, which
    // is entries dropped across the two lists rather than statuses hidden.
    const size_t hidden = row["statusesTruncated"].get<size_t> ();
    EXPECT_EQ (hidden, seen.statuses.size () - shown.size ());
    EXPECT_EQ (hidden, 10u);
}

TEST (SpecCoverage, ACodeOverTheCapInOnlyOneListIsStillCountedOnce) {
    // Every code declared, so `undeclaredSeen` is empty and only the seen list
    // truncates - the ordinary shape, which the subtraction must not change.
    std::vector<std::string> responses;
    responses.reserve (60);
    OperationObservation seen;
    for (int status = 400; status < 460; ++status) {
        responses.push_back (std::to_string (status));
        seen.statuses[status] = 1;
    }
    seen.sent = seen.statuses.size ();
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", responses) };

    const auto row = row_for (build_coverage_payload (declared, { seen }, 0), "/pets");
    EXPECT_EQ (row["undeclaredSeen"], nlohmann::json::array ());
    EXPECT_EQ (row["statusesTruncated"].get<size_t> (), 10u);
}

TEST (SpecCoverage, ADocumentThatDeclaresNothingProducesNoBlockAtAll) {
    // An empty object, which every caller treats as "leave the section out" -
    // rather than a rollup of zero out of zero, which reads as a contract the
    // run failed to cover.
    EXPECT_TRUE (build_coverage_payload ({}, {}, 0).empty ());
}

// ============================================================================
// The tally - what a run actually records
// ============================================================================

TEST (SpecCoverageTally, AnUnboundRunRecordsNothingAndBuildsNothing) {
    CoverageTally tally ({}, { stamp ("a", "GET", "/pets") });
    EXPECT_FALSE (tally.active ());
    tally.record (0, 200);
    EXPECT_TRUE (tally.build ().empty ());
}

TEST (SpecCoverageTally, StepsAreCountedAgainstTheOperationTheyWereStampedWith) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }),
        op ("getPet", "GET", "/pets/{petId}", { "200", "404" }) };
    CoverageTally tally (declared,
    { stamp ("listPets", "GET", "/pets"), stamp ("getPet", "GET", "/pets/{petId}") });
    ASSERT_TRUE (tally.active ());

    tally.record (0, 200);
    tally.record (0, 200);
    tally.record (1, 404);

    const auto coverage = tally.build ();
    EXPECT_EQ (row_for (coverage, "/pets")["sent"].get<size_t> (), 2u);
    EXPECT_EQ (row_for (coverage, "/pets/{petId}")["declaredHit"],
    nlohmann::json::array ({ "404" }));
    EXPECT_EQ (row_for (coverage, "/pets/{petId}")["declaredMissed"],
    nlohmann::json::array ({ "200" }));
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 2u);
}

TEST (SpecCoverageTally, ATransportErrorIsARequestSentAndNotAResponseSeen) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    CoverageTally tally (declared, { stamp ("listPets", "GET", "/pets") });

    tally.record (0, 0);

    const auto coverage = tally.build ();
    const auto row      = row_for (coverage, "/pets");
    // Sent, so the operation counts as covered and the denominator is honest -
    // but nothing answered, so no declared response is hit and `0` never
    // appears as a status the server sent.
    EXPECT_EQ (row["sent"].get<size_t> (), 1u);
    EXPECT_EQ (row["transportErrors"].get<size_t> (), 1u);
    EXPECT_EQ (row["statusesSeen"], nlohmann::json::array ());
    EXPECT_EQ (row["declaredHit"], nlohmann::json::array ());
    EXPECT_EQ (row["declaredMissed"], nlohmann::json::array ({ "200" }));
    EXPECT_EQ (coverage["transportErrors"].get<size_t> (), 1u);
}

TEST (SpecCoverageTally, ARequestOffTheContractIsCountedRatherThanDropped) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    // Step 1 names an operation the document does not declare - a collection
    // that has drifted off its contract, which is what the block exists to
    // notice.
    CoverageTally tally (declared,
    { stamp ("listPets", "GET", "/pets"), stamp ("", "POST", "/legacy") });

    tally.record (0, 200);
    tally.record (1, 200);
    tally.record (1, 500);

    const auto coverage = tally.build ();
    EXPECT_EQ (coverage["undeclaredOperationRequests"].get<size_t> (), 2u);
    EXPECT_EQ (coverage["operationsTotal"].get<size_t> (), 1u);
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 1u);
}

TEST (SpecCoverageTally, ARecordForAStepThatIsNotInThePlanIsIgnored) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    CoverageTally tally (declared, { stamp ("listPets", "GET", "/pets") });

    tally.record (99, 200); // out of range - a bookkeeping mistake, not a crash

    EXPECT_EQ (row_for (tally.build (), "/pets")["sent"].get<size_t> (), 0u);
}

TEST (SpecCoverageTally, TwoStepsNamingOneOperationAggregateOntoOneRow) {
    const std::vector<DeclaredOperation> declared{ op ("listPets", "GET", "/pets", { "200" }) };
    CoverageTally tally (declared,
    { stamp ("listPets", "GET", "/pets"), stamp ("listPets", "GET", "/pets") });

    tally.record (0, 200);
    tally.record (1, 200);

    const auto coverage = tally.build ();
    ASSERT_EQ (coverage["operations"].size (), 1u);
    EXPECT_EQ (coverage["operations"][0]["sent"].get<size_t> (), 2u);
}
