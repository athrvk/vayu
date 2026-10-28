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
 * The shape table.
 *
 * It was a cross-language conformance fixture while the renderer reduced these
 * same shapes for the spec diff - one file, two suites, a divergence failing one
 * of them - and it is kept as this side's own table now that #854 moved the diff
 * and deleted `services/openapi/operation-match.ts` with it. The cases are the
 * value: each one is a way two paths do or do not describe the same endpoint,
 * and they are worth no less for having one reader.
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
    ids.reserve (result.matched.size ());
    for (const auto& pair : result.matched) {
        ids.push_back (requests[pair.request].id);
    }
    return ids;
}

/** The `operationId`s the matched requests were paired with, in the same order. */
std::vector<std::string> matched_operations (const vayu::core::MatchResult& result,
const std::vector<MatchableOperation>& operations) {
    std::vector<std::string> ids;
    ids.reserve (result.matched.size ());
    for (const auto& pair : result.matched) {
        ids.push_back (operations[pair.operation].operation_id);
    }
    return ids;
}

std::vector<std::string> unmatched_request_ids (const vayu::core::MatchResult& result,
const std::vector<MatchableRequest>& requests) {
    std::vector<std::string> ids;
    ids.reserve (result.unmatched_requests.size ());
    for (const size_t index : result.unmatched_requests) {
        ids.push_back (requests[index].id);
    }
    return ids;
}

std::vector<std::string> unmatched_operation_ids (const vayu::core::MatchResult& result,
const std::vector<MatchableOperation>& operations) {
    std::vector<std::string> ids;
    ids.reserve (result.unmatched_operations.size ());
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

/// A request stored with Postman's `:petId` (issue #1764) is the operation
/// `/pets/{petId}`, exactly as one stored with `{{petId}}` is.
TEST (MatchOperations, MatchesAColonPathVariableToItsTemplatedOperation) {
    const std::vector<MatchableRequest> requests{ request (
    "r1", "GET", "{{baseUrl}}/pets/:petId") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets/{petId}", "getPet") };
    const auto result = match_operations (requests, operations);
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "getPet" }));
}

/// An Express-style spec path (`/users/:id`, invalid OpenAPI the importer keeps
/// verbatim) still matches the request drafted from it, which keeps `:id`.
/// Mutation check: drop the flattening from `spec_path_shape` and it matches
/// nothing.
TEST (MatchOperations, MatchesAColonSpecPathToTheRequestDraftedFromIt) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/users/:id") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/users/:id", "getUser") };
    const auto result = match_operations (requests, operations);
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "getUser" }));
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

/// Issue #3030: a literal URL carries the server's base path the document
/// leaves out of `paths`. Mutation check: skip the third pass and neither
/// request matches.
TEST (MatchOperations, MatchesALiteralUrlUnderTheServerBasePath) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "https://h/v1/pets"),
        request ("r2", "GET", "https://h/v1/pets/42") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets"),
        op ("GET", "/pets/{petId}", "getPet") };

    EXPECT_TRUE (match_operations (requests, operations).matched.empty ())
    << "without a base path the two sides share no shape";

    const auto result = match_operations (requests, operations, { "/v1" });
    EXPECT_EQ (matched_ids (result, requests), (std::vector<std::string>{ "r1", "r2" }));
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "listPets", "getPet" }));
}

/// A templated server (`/{version}`) stands for any one segment, and a trailing
/// slash on the base path is no different base path.
TEST (MatchOperations, ReadsATemplatedOrSlashTerminatedBasePath) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "https://h/v2/pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets") };

    EXPECT_EQ (matched_operations (
               match_operations (requests, operations, { "/{version}" }), operations),
    (std::vector<std::string>{ "listPets" }));
    EXPECT_EQ (matched_operations (
               match_operations (requests, operations, { "/v2/" }), operations),
    (std::vector<std::string>{ "listPets" }));
}

/// The first two passes win: a document declaring the full path claims the
/// request before any base path is stripped. Mutation check: run the third
/// pass first and `r1` pairs with `listPets`.
TEST (MatchOperations, PrefersTheDeclaredFullPathOverTheStrippedOne) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "https://h/v1/pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets"),
        op ("GET", "/v1/pets", "legacyListPets") };

    const auto result = match_operations (requests, operations, { "/v1" });

    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "legacyListPets" }));
    EXPECT_EQ (unmatched_operation_ids (result, operations),
    (std::vector<std::string>{ "listPets" }));
}

/// Whole segments only: `/v1` is a prefix of neither `/v10/pets` nor
/// `/v1pets`. A request that is exactly the base path is the root operation.
/// Mutation check: strip the base path as a string prefix (restoring the
/// leading `/`) and `r3` pairs with `listPets`.
TEST (MatchOperations, StripsABasePathOnlyAtASegmentBoundary) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "https://h/v10/pets"),
        request ("r2", "GET", "https://h/v1"), request ("r3", "GET", "https://h/v1pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets"),
        op ("GET", "/", "root") };

    const auto result = match_operations (requests, operations, { "/v1" });

    EXPECT_EQ (matched_ids (result, requests), (std::vector<std::string>{ "r2" }));
    EXPECT_EQ (matched_operations (result, operations),
    (std::vector<std::string>{ "root" }));
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1", "r3" }));
}

/// The ambiguity rule judges the candidates of every base path together.
/// Mutation check: let the first base path that strips a request win and both
/// cases pair something.
TEST (MatchOperations, RefusesAPairingTwoBasePathsMakeAmbiguous) {
    // One request, two candidates: `/api` leaves `/v1/pets`, `/api/v1` leaves
    // `/pets`, and the document declares both.
    const std::vector<MatchableRequest> nested{ request ("r1", "GET", "https://h/api/v1/pets") };
    const std::vector<MatchableOperation> both{ op ("GET", "/v1/pets", "versioned"),
        op ("GET", "/pets", "listPets") };
    const auto one_request = match_operations (nested, both, { "/api", "/api/v1" });
    EXPECT_TRUE (one_request.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (one_request, nested),
    (std::vector<std::string>{ "r1" }));

    // One operation, two claimants: each request sits under a different server.
    const std::vector<MatchableRequest> two_servers{ request ("r1", "GET", "https://h/v1/pets"),
        request ("r2", "GET", "https://h/v2/pets") };
    const std::vector<MatchableOperation> list{ op ("GET", "/pets", "listPets") };
    const auto one_operation = match_operations (two_servers, list, { "/v1", "/v2" });
    EXPECT_TRUE (one_operation.matched.empty ());
    EXPECT_EQ (unmatched_operation_ids (one_operation, list),
    (std::vector<std::string>{ "listPets" }));
}

/// A base path that names nothing to strip changes nothing: the root, an empty
/// one, and a relative one.
TEST (MatchOperations, IgnoresABasePathThatNamesNothingToStrip) {
    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "https://h/v1/pets") };
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets", "listPets") };

    const auto result = match_operations (requests, operations, { "/", "", "v1", "//" });

    EXPECT_TRUE (result.matched.empty ());
    EXPECT_EQ (unmatched_request_ids (result, requests),
    (std::vector<std::string>{ "r1" }));
}

TEST (MatchOperations, MatchesNothingWhenThereIsNothingToMatch) {
    const std::vector<MatchableOperation> operations{ op ("GET", "/pets") };
    EXPECT_EQ (match_operations ({}, operations).unmatched_operations.size (), 1u);

    const std::vector<MatchableRequest> requests{ request ("r1", "GET", "{{baseUrl}}/pets") };
    EXPECT_TRUE (match_operations (requests, {}).matched.empty ());
    EXPECT_EQ (match_operations (requests, {}).unmatched_requests.size (), 1u);
}

} // namespace
