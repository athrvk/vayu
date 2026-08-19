/**
 * @file tests/operation_match_test.cpp
 * @brief Matching requests to a document's operations (issue #638's rule, moved
 *        engine-side by #761).
 *
 * The stakes are why this is exercised at the shape level and not only through
 * the route: a wrong identity is worse than no identity, because the sync
 * (#627) applies changes *by* it - a request matched to the wrong operation
 * would later be rewritten from the wrong schema.
 *
 * These cases are the ones `app/src/services/openapi/operation-match.test.ts`
 * held before the rule moved, plus the brace shapes a hand-written scanner can
 * get wrong where two regex passes could not.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/operation_match.hpp"

namespace {

using nlohmann::json;
using vayu::core::match_operations;
using vayu::core::MatchableOperation;
using vayu::core::MatchableRequest;
using vayu::core::operation_shape_key;
using vayu::core::request_path_shape;
using vayu::core::spec_path_shape;
using vayu::core::split_request_url;

/**
 * The table both languages read.
 *
 * The renderer still reduces these same shapes for the spec diff and the export
 * skeleton, so two implementations of one rule exist until those move too - and
 * a rule that decides which request is which operation cannot be allowed to
 * mean two things. Same arrangement as the variable-resolution fixture: one
 * file, two suites, a divergence fails one of them.
 */
json load_shape_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "operation-shape-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

/** A fixture field that may be `null`, as `std::optional`. */
std::optional<std::string> optional_string (const json& value) {
    return value.is_null () ? std::nullopt :
                              std::optional<std::string> (value.get<std::string> ());
}

MatchableRequest
request (const std::string& id, const std::string& method, const std::string& url) {
    return { id, method, url };
}

MatchableOperation op (const std::string& method,
const std::string& path,
const std::string& operation_id = "") {
    return { operation_id, method, path };
}

/** The ids of the requests that matched, in the order the matcher paired them. */
std::vector<std::string> matched_ids (const vayu::core::MatchResult& result,
const std::vector<MatchableRequest>& requests) {
    std::vector<std::string> ids;
    for (const auto& pair : result.matched) {
        ids.push_back (requests[pair.request].id);
    }
    return ids;
}

/** The `operationId`s the matched requests were paired with, in the same order. */
std::vector<std::string> matched_operations (const vayu::core::MatchResult& result,
const std::vector<MatchableOperation>& operations) {
    std::vector<std::string> ids;
    for (const auto& pair : result.matched) {
        ids.push_back (operations[pair.operation].operation_id);
    }
    return ids;
}

std::vector<std::string> unmatched_request_ids (const vayu::core::MatchResult& result,
const std::vector<MatchableRequest>& requests) {
    std::vector<std::string> ids;
    for (const size_t index : result.unmatched_requests) {
        ids.push_back (requests[index].id);
    }
    return ids;
}

std::vector<std::string> unmatched_operation_ids (const vayu::core::MatchResult& result,
const std::vector<MatchableOperation>& operations) {
    std::vector<std::string> ids;
    for (const size_t index : result.unmatched_operations) {
        ids.push_back (operations[index].operation_id);
    }
    return ids;
}

TEST (RequestPathShape, DropsTheOriginHoweverTheRequestStatesIt) {
    // The three shapes a URL arrives in: the import's `{{baseUrl}}`, a written
    // absolute URL, and a schemeless host.
    EXPECT_EQ (request_path_shape ("{{baseUrl}}/pets"), "/pets");
    EXPECT_EQ (request_path_shape ("https://api.example.com/pets"), "/pets");
    EXPECT_EQ (request_path_shape ("api.example.com/pets"), "/pets");
}

TEST (RequestPathShape, DropsTheQueryAndTheFragment) {
    EXPECT_EQ (request_path_shape ("{{baseUrl}}/pets?limit=10#top"), "/pets");
}

TEST (RequestPathShape, FlattensBothTemplateSyntaxesToTheSamePlaceholder) {
    EXPECT_EQ (request_path_shape ("{{baseUrl}}/pets/{{petId}}/toys"), "/pets/{}/toys");
    EXPECT_EQ (spec_path_shape ("/pets/{petId}/toys"), "/pets/{}/toys");
    // A renamed path parameter is the same endpoint, so the names must not
    // enter the comparison.
    EXPECT_EQ (spec_path_shape ("/pets/{id}/toys"), spec_path_shape ("/pets/{petId}/toys"));
}

TEST (RequestPathShape, ReadsAnUnclosedBraceAsTextRatherThanAPlaceholder) {
    // The scanner checks the `{{name}}` form first at each position, so a `{{`
    // that never closes is not swallowed - the app's two regex passes left the
    // same characters behind, and a request whose URL contains a stray brace
    // must not quietly become a different endpoint.
    EXPECT_EQ (spec_path_shape ("/pets/{petId"), "/pets/{petId");
    EXPECT_EQ (spec_path_shape ("/pets/{{a}"), "/pets/{{}");
    EXPECT_EQ (spec_path_shape ("/pets/{{{a}}}"), "/pets/{{}}");
}

TEST (RequestPathShape, TreatsATrailingSlashAsTheSamePathAndKeepsTheRoot) {
    EXPECT_EQ (request_path_shape ("{{baseUrl}}/pets/"), "/pets");
    EXPECT_EQ (request_path_shape ("{{baseUrl}}/"), "/");
}

TEST (RequestPathShape, StatesNoPathForAUrlThatIsOnlyAnOrigin) {
    // Defaulting to "/" here would match such a request against the document's
    // root operation - a match nobody asked for.
    EXPECT_FALSE (request_path_shape ("{{baseUrl}}").has_value ());
    EXPECT_FALSE (request_path_shape ("").has_value ());
    EXPECT_FALSE (request_path_shape ("https://api.example.com").has_value ());
}

TEST (OperationShapeConformance, EveryFixtureCasePasses) {
    const json fixture = load_shape_fixture ();
    ASSERT_FALSE (fixture["requestUrls"].empty ())
    << "an empty table would pass while proving nothing";
    ASSERT_FALSE (fixture["specPaths"].empty ());
    ASSERT_FALSE (fixture["shapeKeys"].empty ());

    for (const auto& one : fixture["requestUrls"]) {
        const auto url   = one["url"].get<std::string> ();
        const auto parts = split_request_url (url);
        EXPECT_EQ (parts.origin, optional_string (one["origin"]))
        << one["name"];
        EXPECT_EQ (parts.path, optional_string (one["path"])) << one["name"];
        EXPECT_EQ (request_path_shape (url), optional_string (one["shape"]))
        << one["name"];
    }
    for (const auto& one : fixture["specPaths"]) {
        EXPECT_EQ (spec_path_shape (one["path"].get<std::string> ()),
        one["shape"].get<std::string> ())
        << one["path"];
    }
    for (const auto& one : fixture["shapeKeys"]) {
        EXPECT_EQ (operation_shape_key (one["method"].get<std::string> (),
                   one["pathShape"].get<std::string> ()),
        one["key"].get<std::string> ());
    }
}

TEST (MatchOperations, PairsARequestWithItsOperationAndReportsBothLeftovers) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets"),
        request ("r2", "GET", "{{baseUrl}}/pets/{{petId}}"),
        request ("r3", "GET", "{{baseUrl}}/health") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets"),
        op ("GET", "/pets/{petId}", "getPet"), op ("POST", "/pets", "createPet") };

    const auto result = match_operations (requests, operations);

    EXPECT_EQ (matched_ids (result, requests), (std::vector<std::string>{ "r1", "r2" }));
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "listPets", "getPet" }));
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r3" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "createPet" }));
}

TEST (MatchOperations, DoesNotMatchAcrossMethods) {
    const std::vector<MatchableRequest> requests{ request (
    "r1", "DELETE", "{{baseUrl}}/pets/{{petId}}") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };

    const auto result = match_operations (requests, operations);

    EXPECT_TRUE (result.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1" }));
}

TEST (MatchOperations, MatchesRegardlessOfHowEitherSideSpellsTheMethod) {
    // A stored request may hold a lower-case method and a document may declare
    // one; the identity is the same operation either way.
    const std::vector<MatchableRequest> requests{ request ("r1", "get", "{{baseUrl}}/pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets") };

    EXPECT_EQ (matched_ids (match_operations (requests, operations), requests),
    (std::vector<std::string>{ "r1" }));
}

TEST (MatchOperations, RefusesAnAmbiguousShapeRatherThanPickingOne) {
    // Two requests reduce to `GET /pets/{}`. Either could be the operation and
    // nothing here can tell which, so neither is stamped and both are reported.
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets/{{petId}}"),
        request ("r2", "GET", "{{baseUrl}}/pets/{{id}}") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };

    const auto result = match_operations (requests, operations);

    EXPECT_TRUE (result.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1", "r2" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "getPet" }));
}

TEST (MatchOperations, MatchesARequestThatHasTheIdWrittenIn) {
    // The hand-built case: nobody types `{{petId}}` into a collection they
    // built by hand, and without this pass binding such a collection would
    // match nothing at all.
    const std::vector<MatchableRequest> requests{ request (
    "r1", "GET", "https://api.example.com/pets/42") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };

    const auto result = match_operations (requests, operations);

    EXPECT_EQ (matched_ids (result, requests), (std::vector<std::string>{ "r1" }));
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "getPet" }));
}

TEST (MatchOperations, PrefersTheLiteralPathOverTheTemplateThatCouldAlsoHaveFilledIt) {
    // OpenAPI's own precedence: `/pets/mine` is that operation, not an instance
    // of `/pets/{petId}`.
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets/mine") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet"),
        op ("GET", "/pets/mine", "myPets") };

    const auto result = match_operations (requests, operations);

    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "myPets" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "getPet" }));
}

TEST (MatchOperations, LeavesAConcreteRequestAloneWhenTwoTemplatesCouldClaimIt) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets/42") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet"),
        op ("GET", "/pets/{id}", "getPetAlias") };

    const auto result = match_operations (requests, operations);

    EXPECT_TRUE (result.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1" }));
}

TEST (MatchOperations, LeavesAnOperationAloneWhenTwoConcreteRequestsCouldFillIt) {
    // The mirror of the case above, and the direction the app's own test set
    // did not state: the uniqueness rule holds on both sides, so two requests
    // that are both instances of one template leave it unclaimed rather than
    // racing for it in input order.
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets/42"),
        request ("r2", "GET", "{{baseUrl}}/pets/43") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };

    const auto result = match_operations (requests, operations);

    EXPECT_TRUE (result.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1", "r2" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "getPet" }));
}

TEST (MatchOperations, NeverLetsAPlaceholderSwallowAPathSeparator) {
    const std::vector<MatchableRequest> requests{ request (
    "r1", "GET", "{{baseUrl}}/pets/42/toys") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };

    EXPECT_TRUE (match_operations (requests, operations).matched.empty ());
}

TEST (MatchOperations, LeavesARequestThatStatesNoPathUnmatched) {
    // `{{baseUrl}}` alone is in no bucket, so it can neither claim the root
    // operation nor make the operation beside it look ambiguous.
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}"),
        request ("r2", "GET", "{{baseUrl}}/pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/", "root"),
        op ("GET", "/pets", "listPets") };

    const auto result = match_operations (requests, operations);

    EXPECT_EQ (matched_ids (result, requests), (std::vector<std::string>{ "r2" }));
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "root" }));
}

TEST (MatchOperations, MatchesNothingWhenThereIsNothingToMatch) {
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets") };
    EXPECT_EQ (match_operations ({}, operations).unmatched_operations.size (), 1u);

    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets") };
    EXPECT_TRUE (match_operations (requests, {}).matched.empty ());
    EXPECT_EQ (match_operations (requests, {}).unmatched_requests.size (), 1u);
}

} // namespace
