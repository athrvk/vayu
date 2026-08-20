/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/spec_diff_test.cpp
 * @brief The sync comparison (issue #654, moved engine-side by #854).
 *
 * A port of the renderer's `spec-diff.test.ts`, case for case, because the
 * cases are the behaviour: each one is a judgement an apply acts on rather than
 * a detail of a report.
 *
 *  - **A moved operation is followed, not lost.** Renaming a path under a stable
 *    `operationId` (or the reverse) must not read as "delete this request and
 *    make a new one" - that is data loss dressed as a sync.
 *  - **Changed means "no longer what the document produces"**, measured against
 *    the drafts the same reader builds an import from.
 *  - **The user-touched flag is three-way.** A two-way comparison cannot tell an
 *    edit apart from a spec change, and the apply would then quietly revert it.
 *  - **Nothing outside the contract is touched**: a request carrying no
 *    operation is counted and left alone.
 *
 * The requests are built *from* the bound document's own drafts - what an import
 * of it produced - so a difference these tests see is a difference a user would
 * really have.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_diff.hpp"

using vayu::core::ComparableRequest;
using vayu::core::SpecDiff;
using vayu::core::SpecField;
using vayu::core::SpecRequestDraft;

namespace {

/**
 * A 3.0 document with the given `paths` object, as bytes a store would hold.
 *
 * The cases below write their documents as JSON **text** rather than as nested
 * `json{{...}}` initializers, the way `spec_sync_route_test.cpp` and the rest of
 * the spec suites do. That is not only style: this file's twenty-odd documents
 * as brace initializers cost MSVC more heap than it has, and the leg died with
 * `C1060: compiler is out of heap space` rather than with anything about the
 * code.
 */
std::string document (std::string_view paths) {
    return std::string (R"({"openapi":"3.0.0","info":{"title":"Pets API"},)"
    R"("servers":[{"url":"https://api.example.com"}],"paths":)") +
    std::string (paths) + "}";
}

/** A JSON request body declaring one string property. */
std::string json_body (std::string_view properties) {
    return std::string (R"("requestBody":{"content":{"application/json":)"
    R"({"schema":{"type":"object","properties":{)") +
    std::string (properties) + "}}}}}";
}

std::vector<SpecRequestDraft> drafts_of (const std::string& text) {
    const auto read = vayu::core::read_document (text);
    EXPECT_TRUE (read.ok ()) << read.error;
    return vayu::core::spec_request_drafts_of (read.root);
}

/** One operation of a document, by `operationId`. */
const SpecRequestDraft& draft_of (const std::vector<SpecRequestDraft>& drafts,
const std::string& operation_id) {
    const auto found = std::find_if (drafts.begin (), drafts.end (),
    [&] (const SpecRequestDraft& entry) { return entry.operation.operation_id == operation_id; });
    EXPECT_NE (found, drafts.end ()) << "no operation " << operation_id << " in this fixture";
    return *found;
}

/** The request an import of that draft created, before anybody edited it. */
ComparableRequest request_from (const std::string& id, const SpecRequestDraft& entry) {
    ComparableRequest request;
    request.id          = id;
    request.name        = entry.draft.name;
    request.description = entry.draft.description;
    request.method      = entry.draft.method;
    request.url         = entry.draft.url;
    request.params      = entry.draft.params;
    request.headers     = entry.draft.headers;
    request.body        = entry.draft.body;
    request.operation   = entry.operation;
    return request;
}

/** The compared field names of one changed request, sorted for comparison. */
std::vector<std::string> field_names (const vayu::core::ChangedRequest& changed) {
    std::vector<std::string> names;
    for (const auto& field : changed.fields) {
        names.emplace_back (vayu::core::spec_field_name (field.field));
    }
    std::sort (names.begin (), names.end ());
    return names;
}

const vayu::core::SpecFieldDiff* field_named (const vayu::core::ChangedRequest& changed,
SpecField field) {
    const auto found = std::find_if (changed.fields.begin (), changed.fields.end (),
    [&] (const vayu::core::SpecFieldDiff& entry) { return entry.field == field; });
    return found == changed.fields.end () ? nullptr : &*found;
}

/** The `createPet` operation, which several cases carry unchanged. */
const std::string CREATE_PET =
R"("post":{"operationId":"createPet","summary":"Create a pet",)" +
json_body (R"("name":{"type":"string"})") + "}";

/** The bound document every case below compares against. */
const std::string BOUND = document (
R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"},)" + CREATE_PET +
R"(},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet"}}})");

class SpecDiffTest : public ::testing::Test {
    protected:
    void SetUp () override {
        bound_ = drafts_of (BOUND);
    }

    /** The whole collection as an import of `BOUND` left it. */
    [[nodiscard]] std::vector<ComparableRequest> bound_collection () const {
        std::vector<ComparableRequest> requests;
        for (size_t i = 0; i < bound_.size (); ++i) {
            requests.push_back (request_from ("req_" + std::to_string (i), bound_[i]));
        }
        return requests;
    }

    [[nodiscard]] SpecDiff diff_against (const std::string& fetched_text,
    const std::vector<ComparableRequest>& requests) const {
        fetched_ = drafts_of (fetched_text);
        return vayu::core::diff_spec (fetched_, &bound_, requests);
    }

    /** The operation the changed request at @p index was followed to. */
    [[nodiscard]] const vayu::core::DeclaredOperation& operation_of (const SpecDiff& diff,
    size_t index) const {
        return fetched_[diff.changed[index].draft].operation;
    }

    [[nodiscard]] const vayu::core::ChangedRequest* changed_with_id (const SpecDiff& diff,
    const std::string& operation_id) const {
        for (const auto& item : diff.changed) {
            if (fetched_[item.draft].operation.operation_id == operation_id) {
                return &item;
            }
        }
        return nullptr;
    }

    std::vector<SpecRequestDraft> bound_;
    mutable std::vector<SpecRequestDraft> fetched_;
};

// ---------------------------------------------------------------------------
// A document that declares one operationId twice (issue #715)
// ---------------------------------------------------------------------------

/*
 * Invalid OpenAPI and ordinary in generated documents. The reader keeps a
 * repeated id on its first declaration only, so what the comparison has to
 * survive is the shape an import *before* that fix left behind: two requests
 * claiming one id, plus a document whose id names an operation that contradicts
 * what the second request says it is.
 */
class DuplicateOperationIdTest : public ::testing::Test {
    protected:
    void SetUp () override {
        entries_ = drafts_of (DUP);
    }

    static const std::string DUP;

    /** Both requests, the second still carrying the id the first also claims. */
    [[nodiscard]] std::vector<ComparableRequest> collection () const {
        auto a = request_from ("req_a", entries_[0]);
        auto b = request_from ("req_b", entries_[1]);
        // What an import before the fix stamped on the second declaration.
        b.operation = vayu::core::DeclaredOperation{ "list", "POST", "/b", {} };
        return { a, b };
    }

    [[nodiscard]] SpecDiff diff_dup (const std::string& fetched_text,
    const std::vector<ComparableRequest>& requests) const {
        fetched_ = drafts_of (fetched_text);
        return vayu::core::diff_spec (fetched_, &entries_, requests);
    }

    std::vector<SpecRequestDraft> entries_;
    mutable std::vector<SpecRequestDraft> fetched_;
};

const std::string DuplicateOperationIdTest::DUP = document (
R"({"/a":{"get":{"operationId":"list","summary":"List A"}},)"
R"("/b":{"post":{"operationId":"list","summary":"Create B"}}})");

TEST_F (DuplicateOperationIdTest, LeavesTheSecondRequestOnItsOwnOperationWhenTheFirstChanges) {
    const std::string tweaked = document (
    R"({"/a":{"get":{"operationId":"list","summary":"List A","description":"Now documented"}},)"
    R"("/b":{"post":{"operationId":"list","summary":"Create B"}}})");

    const SpecDiff diff = diff_dup (tweaked, collection ());

    // The id two requests claim identifies neither, so each is followed by its
    // own endpoint. Following the id instead pairs `req_b` with `GET /a` and
    // reports its name, url and body as changed.
    ASSERT_EQ (diff.changed.size (), 2u);
    const auto& b = diff.changed[1];
    EXPECT_EQ (b.matched_by, vayu::core::IdentityMatch::Path);
    EXPECT_EQ (fetched_[b.draft].operation.method, "POST");
    EXPECT_EQ (fetched_[b.draft].operation.path, "/b");
    EXPECT_TRUE (b.fields.empty ());
    EXPECT_EQ (field_names (diff.changed[0]), std::vector<std::string>{ "description" });
    EXPECT_TRUE (diff.added.empty ());
    EXPECT_TRUE (diff.removed.empty ());
}

TEST_F (DuplicateOperationIdTest, PrefersTheRequestsOwnEndpointOverAnIdNamingADifferentOne) {
    // One claimant, so the id is not ambiguous among the requests - what refuses
    // it here is the entry it names having a different method and path from the
    // stamp, while the document still declares the stamp's own.
    auto orphan      = request_from ("req_b", entries_[1]);
    orphan.operation = vayu::core::DeclaredOperation{ "list", "POST", "/b", {} };

    const SpecDiff diff = diff_dup (DUP, { orphan });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_EQ (diff.changed[0].matched_by, vayu::core::IdentityMatch::Path);
    EXPECT_EQ (fetched_[diff.changed[0].draft].operation.path, "/b");
    EXPECT_TRUE (diff.changed[0].fields.empty ());
    EXPECT_TRUE (diff.removed.empty ());
    // Nothing claims `GET /a` now, which is an addition to offer and not a
    // request to overwrite.
    ASSERT_EQ (diff.added.size (), 1u);
    EXPECT_EQ (fetched_[diff.added[0]].operation.path, "/a");
}

TEST_F (DuplicateOperationIdTest, ReportsAMovedEndpointAsGoneRatherThanFollowingTheSharedId) {
    const std::string moved = document (
    R"({"/a":{"get":{"operationId":"list","summary":"List A"}},)"
    R"("/b2":{"post":{"operationId":"list","summary":"Create B"}}})");

    const SpecDiff diff = diff_dup (moved, collection ());

    ASSERT_EQ (diff.removed.size (), 1u);
    EXPECT_EQ (diff.removed[0], 1u); // req_b
    ASSERT_EQ (diff.added.size (), 1u);
    EXPECT_EQ (fetched_[diff.added[0]].operation.path, "/b2");
    EXPECT_TRUE (diff.changed.empty ());
    EXPECT_EQ (diff.unchanged, 1u);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

TEST_F (SpecDiffTest, ReportsNothingChangedWhenTheDocumentIsTheSame) {
    const SpecDiff diff = diff_against (BOUND, bound_collection ());

    EXPECT_TRUE (diff.changed.empty ());
    EXPECT_TRUE (diff.added.empty ());
    EXPECT_TRUE (diff.removed.empty ());
    EXPECT_EQ (diff.unchanged, 3u);
}

TEST_F (SpecDiffTest, PutsAnUnclaimedOperationInAddedAndAGoneOperationsRequestInRemoved) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"}},)"
    R"("/owners":{"get":{"operationId":"listOwners","summary":"List owners"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());

    ASSERT_EQ (diff.added.size (), 1u);
    EXPECT_EQ (fetched_[diff.added[0]].operation.operation_id, "listOwners");
    EXPECT_EQ (diff.removed.size (), 2u);
    EXPECT_EQ (diff.unchanged, 1u);
}

TEST_F (SpecDiffTest, CountsARequestThatCarriesNoOperationInsteadOfTreatingItAsRemoved) {
    auto requests     = bound_collection ();
    auto hand_written = requests[0];
    hand_written.id   = "req_hand";
    hand_written.operation.reset ();
    requests.push_back (hand_written);

    const SpecDiff diff = diff_against (BOUND, requests);

    EXPECT_EQ (diff.unmapped, 1u);
    EXPECT_TRUE (diff.removed.empty ());
    EXPECT_EQ (diff.unchanged, 3u);
}

TEST_F (SpecDiffTest, FollowsAnOperationIdWhosePathMovedRatherThanReportingADeleteAndAnAdd) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"},)" + CREATE_PET +
    R"(},"/animals/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());

    EXPECT_TRUE (diff.removed.empty ());
    EXPECT_TRUE (diff.added.empty ());
    const auto* moved = changed_with_id (diff, "getPet");
    ASSERT_NE (moved, nullptr);
    EXPECT_EQ (moved->matched_by, vayu::core::IdentityMatch::OperationId);
    EXPECT_TRUE (moved->renamed);
    EXPECT_EQ (moved->bound_operation.path, "/pets/{petId}");
    const auto names = field_names (*moved);
    EXPECT_NE (std::find (names.begin (), names.end (), "url"), names.end ());
}

TEST_F (SpecDiffTest, FollowsAPathWhoseOperationIdMovedAndReportsARenameWithNoFieldChange) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"},)" + CREATE_PET +
    R"(},"/pets/{petId}":{"get":{"operationId":"readPet","summary":"Get a pet"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());

    const auto* moved = changed_with_id (diff, "readPet");
    ASSERT_NE (moved, nullptr);
    EXPECT_EQ (moved->matched_by, vayu::core::IdentityMatch::Path);
    EXPECT_TRUE (moved->renamed);
    // Nothing an import writes differs - only the identity the request records,
    // which is why a pure rename is still in the changed bucket.
    EXPECT_TRUE (moved->fields.empty ());
    EXPECT_TRUE (diff.added.empty ());
    EXPECT_TRUE (diff.removed.empty ());
}

TEST_F (SpecDiffTest, DisclosesAnOperationWhoseIdAndPathBothMovedAsARemovalAndAnAddition) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"},)" + CREATE_PET +
    R"(},"/animals/{animalId}":{"get":{"operationId":"readAnimal","summary":"Get an animal"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());

    ASSERT_EQ (diff.removed.size (), 1u);
    EXPECT_EQ (diff.removed[0], 2u); // the request bound to getPet
    ASSERT_EQ (diff.added.size (), 1u);
    EXPECT_EQ (fetched_[diff.added[0]].operation.operation_id, "readAnimal");
    EXPECT_TRUE (diff.changed.empty ());
}

TEST_F (SpecDiffTest, TreatsARenamedPathParameterAsTheSameEndpoint) {
    // Neither side declares an operationId, so only the path can carry the
    // identity - and `{petId}` -> `{id}` is the same position on the server,
    // which is the rule the matcher already binds by.
    const std::vector<SpecRequestDraft> bound =
    drafts_of (document (R"({"/pets/{petId}":{"get":{"summary":"Get a pet"}}})"));
    const std::vector<SpecRequestDraft> fetched =
    drafts_of (document (R"({"/pets/{id}":{"get":{"summary":"Get a pet"}}})"));

    const SpecDiff diff =
    vayu::core::diff_spec (fetched, &bound, { request_from ("req_0", bound[0]) });

    EXPECT_TRUE (diff.removed.empty ());
    EXPECT_TRUE (diff.added.empty ());
    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_TRUE (diff.changed[0].renamed);
}

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

TEST_F (SpecDiffTest, NamesEveryFieldTheDocumentMovedWithTheValueItWouldWrite) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List all the pets",)"
    R"("parameters":[{"name":"limit","in":"query","required":true,"example":"10"}]},)" +
    CREATE_PET +
    R"(},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());
    const auto* listed  = changed_with_id (diff, "listPets");

    ASSERT_NE (listed, nullptr);
    EXPECT_EQ (field_names (*listed),
    (std::vector<std::string>{ "name", "params", "url" }));
    EXPECT_NE (field_named (*listed, SpecField::Url)->next.find ("limit=10"), std::string::npos);
    EXPECT_EQ (field_named (*listed, SpecField::Name)->next, "List all the pets");
    EXPECT_TRUE (std::none_of (listed->fields.begin (), listed->fields.end (),
    [] (const auto& field) { return field.user_touched; }));
    EXPECT_EQ (diff.unchanged, 2u);
}

TEST_F (SpecDiffTest, ReportsTheBodyAChangedSchemaNowProduces) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"},)"
    R"("post":{"operationId":"createPet","summary":"Create a pet",)" +
    json_body (R"("name":{"type":"string"},"tag":{"type":"string"})") +
    R"(}},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet"}}})");

    const SpecDiff diff = diff_against (next, bound_collection ());
    const auto* created = changed_with_id (diff, "createPet");

    ASSERT_NE (created, nullptr);
    EXPECT_EQ (field_names (*created), std::vector<std::string>{ "body" });
    EXPECT_NE (created->fields[0].next.find ("tag"), std::string::npos);
}

TEST_F (SpecDiffTest, FlagsAFieldTheUserEditedAwayFromTheBoundDocumentsValue) {
    auto edited = request_from ("req_0", draft_of (bound_, "listPets"));
    edited.url  = "{{baseUrl}}/pets?limit=5";
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
    R"("parameters":[{"name":"limit","in":"query","required":true,"example":"50"}]}}})");

    const SpecDiff diff = diff_against (next, { edited });

    ASSERT_EQ (diff.changed.size (), 1u);
    const auto* url = field_named (diff.changed[0], SpecField::Url);
    ASSERT_NE (url, nullptr);
    EXPECT_TRUE (url->user_touched);
    EXPECT_NE (url->current.find ("limit=5"), std::string::npos);
    EXPECT_NE (url->next.find ("limit=50"), std::string::npos);
}

TEST_F (SpecDiffTest, DoesNotFlagAFieldOnlyTheDocumentMoved) {
    // The mutation check for the three-way rule: compare the request against the
    // *new* document instead of the bound one and this flags, which would have
    // the apply refuse to write a change nobody had touched.
    const auto untouched   = request_from ("req_0", draft_of (bound_, "listPets"));
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
    R"("parameters":[{"name":"limit","in":"query","required":true,"example":"50"}]}}})");

    const SpecDiff diff = diff_against (next, { untouched });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_FALSE (diff.changed[0].fields.empty ());
    EXPECT_TRUE (std::none_of (diff.changed[0].fields.begin (), diff.changed[0].fields.end (),
    [] (const auto& field) { return field.user_touched; }));
}

TEST_F (SpecDiffTest, MakesNoClaimAboutWhoEditedWhatWhenTheBoundDocumentCannotBeRead) {
    auto edited = request_from ("req_0", draft_of (bound_, "listPets"));
    edited.name = "My list call";
    const std::vector<SpecRequestDraft> fetched = drafts_of (
    document (R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets"}}})"));

    const SpecDiff diff = vayu::core::diff_spec (fetched, nullptr, { edited });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_TRUE (diff.changed[0].previous_unknown);
    EXPECT_EQ (field_names (diff.changed[0]), std::vector<std::string>{ "name" });
    EXPECT_FALSE (diff.changed[0].fields[0].user_touched);
}

TEST_F (SpecDiffTest, ReportsARequestTheUserEditedAsDivergenceFlaggedAsTheirs) {
    // The document did not move; this request no longer matches it because
    // somebody renamed it. It is still a difference an apply must know about -
    // and the flag is what stops the apply from putting the summary back.
    auto renamed_by_user = request_from ("req_2", draft_of (bound_, "getPet"));
    renamed_by_user.name = "Fetch one pet";

    const SpecDiff diff = diff_against (BOUND, { renamed_by_user });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_EQ (field_names (diff.changed[0]), std::vector<std::string>{ "name" });
    EXPECT_TRUE (diff.changed[0].fields[0].user_touched);
    EXPECT_FALSE (diff.changed[0].renamed);
}

/**
 * Response examples are deliberately not compared (issue #654).
 *
 * The draft carries them - an apply writes them - so the comparison reading the
 * fields it compares off that same draft is exactly where they could leak in.
 * A document whose only change is a documented response reports **unchanged**,
 * and adding `examples` to the compared set reddens this.
 */
TEST_F (SpecDiffTest, DoesNotCompareTheResponsesADocumentDocuments) {
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
    R"("responses":{"200":{"description":"Every pet",)"
    R"("content":{"application/json":{"schema":{"type":"string"}}}}}}}})");

    const std::vector<SpecRequestDraft> fetched = drafts_of (next);
    ASSERT_EQ (fetched.size (), 1u);
    // The example is there to be applied - it is only the comparison that
    // ignores it.
    ASSERT_EQ (fetched[0].draft.examples.size (), 1u);
    EXPECT_EQ (fetched[0].draft.examples[0].name, "200 - Every pet");

    const SpecDiff diff =
    vayu::core::diff_spec (fetched, &bound_, { request_from ("req_0", draft_of (bound_, "listPets")) });

    EXPECT_TRUE (diff.changed.empty ());
    EXPECT_EQ (diff.unchanged, 1u);
}

/**
 * A long value is cut for *display* and never for comparison.
 *
 * The two are separate strings on purpose: a comparison over the truncated one
 * would report two descriptions differing in their 500th character as the same,
 * which is a change the sync would then never offer.
 */
TEST_F (SpecDiffTest, TruncatesADisplayedValueWithoutTruncatingTheComparedOne) {
    const std::string long_a (400, 'a');
    const std::string next = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets","description":")" +
    long_a + R"("}}})");

    const SpecDiff diff =
    diff_against (next, { request_from ("req_0", draft_of (bound_, "listPets")) });

    ASSERT_EQ (diff.changed.size (), 1u);
    const auto* description = field_named (diff.changed[0], SpecField::Description);
    ASSERT_NE (description, nullptr);
    // 120 characters plus a one-character ellipsis, which is three bytes.
    EXPECT_EQ (description->next.size (), 123u);
    EXPECT_EQ (description->next.substr (120), "\xE2\x80\xA6");

    // And a second document differing from the first only past the cut is still
    // a change: the compared value is the whole string.
    const std::string longer = document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets","description":")" +
    long_a + R"(b"}}})");
    const std::vector<SpecRequestDraft> a = drafts_of (next);
    const std::vector<SpecRequestDraft> b = drafts_of (longer);
    auto request       = request_from ("req_0", a[0]);
    const SpecDiff two = vayu::core::diff_spec (b, &a, { request });
    ASSERT_EQ (two.changed.size (), 1u);
    EXPECT_NE (field_named (two.changed[0], SpecField::Description), nullptr);
}

/**
 * A stub parameter the user enabled by hand survives a sync (issue #677 item 1).
 *
 * Issues #622/#658 import an optional, value-less parameter **disabled** - the
 * row is what the endpoint accepts, not what this request should send. A person
 * who ticks it on has stated the intent the import declined to guess, and the
 * comparison is what keeps a sync from ticking it back off: the `[off]` marker
 * in the row rendering is the only thing that makes the flip visible at all, and
 * the three-way flag is what calls it the user's.
 */
class StubParameterTest : public ::testing::Test {
    protected:
    void SetUp () override {
        stub_ = drafts_of (STUB);
    }

    static const std::string STUB;

    /** The imported request with `verbose` ticked on, as the Params table leaves it. */
    [[nodiscard]] ComparableRequest verbose_enabled () const {
        auto request = request_from ("req_0", stub_[0]);
        for (auto& row : request.params) {
            row.enabled = true;
        }
        // The URL the table rewrites from the rows, since the URL is what goes on
        // the wire (issue #590).
        request.url = "{{baseUrl}}/pets?verbose=";
        return request;
    }

    std::vector<SpecRequestDraft> stub_;
};

const std::string StubParameterTest::STUB = document (
R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
R"("parameters":[{"name":"verbose","in":"query"}]}}})");

TEST_F (StubParameterTest, ImportsDisabledWhichIsWhatLeavesAnythingToSurvive) {
    ASSERT_EQ (stub_[0].draft.params.size (), 1u);
    EXPECT_EQ (stub_[0].draft.params[0].key, "verbose");
    EXPECT_FALSE (stub_[0].draft.params[0].enabled);
    // And off the URL, so the row is listed without being sent.
    EXPECT_EQ (stub_[0].draft.url.find ("verbose"), std::string::npos);
}

TEST_F (StubParameterTest, ReportsTheFlipAsTheUsersAgainstADocumentThatDidNotMove) {
    // Both halves of the flip are seen, and both are the user's - the document is
    // byte-identical, so there is nothing else they could be. Remove the `[off]`
    // marker from the row rendering and `params` drops out of this list, which is
    // the whole failure: the field then reads as matching the document.
    const SpecDiff diff = vayu::core::diff_spec (stub_, &stub_, { verbose_enabled () });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_EQ (field_names (diff.changed[0]), (std::vector<std::string>{ "params", "url" }));
    EXPECT_TRUE (std::all_of (diff.changed[0].fields.begin (), diff.changed[0].fields.end (),
    [] (const auto& field) { return field.user_touched; }));
}

TEST_F (StubParameterTest, StillCallsTheFlipTheUsersWhenTheDocumentMovesTheParameterListToo) {
    /*
     * The case the marker is load-bearing for. The document adds a second
     * parameter, so `params` differs from it either way and is reported either
     * way - what the marker decides is whether the flip is *also* a difference
     * from the bound document, and therefore the user's. Without it the field
     * reads as untouched, gets ticked by default, and the sync writes the
     * document's list over the row somebody enabled.
     */
    const std::vector<SpecRequestDraft> moved = drafts_of (document (
    R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets","parameters":[)"
    R"({"name":"verbose","in":"query"},)"
    R"({"name":"limit","in":"query","required":true,"example":"10"}]}}})"));

    const SpecDiff diff = vayu::core::diff_spec (moved, &stub_, { verbose_enabled () });

    ASSERT_EQ (diff.changed.size (), 1u);
    const auto* params = field_named (diff.changed[0], SpecField::Params);
    ASSERT_NE (params, nullptr);
    EXPECT_TRUE (params->user_touched);
}

// ---------------------------------------------------------------------------
// method (issue #717)
// ---------------------------------------------------------------------------

/*
 * `method` is a compared field. It was the one field an import writes that the
 * comparison did not read, while the apply wrote it on every update anyway - so
 * a user's edit was reverted by a change to any other field, with no row, no
 * flag and no tick to show it happening.
 */
TEST_F (SpecDiffTest, ReportsTheUsersMethodEditAsTheirsSoAnApplyCannotTakeItBackSilently) {
    // Mutation check: drop `Method` from `FIELDS` and the field list is
    // `["description"]` - the exact blindness that let the apply revert a HEAD
    // back to a GET.
    auto edited_to_head   = request_from ("req_0", draft_of (bound_, "listPets"));
    edited_to_head.method = "HEAD";

    const SpecDiff diff = diff_against (
    document (R"({"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
    R"("description":"Paged."},)" + CREATE_PET +
    R"(},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet"}}})"),
    { edited_to_head });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_EQ (field_names (diff.changed[0]),
    (std::vector<std::string>{ "description", "method" }));
    const auto* method = field_named (diff.changed[0], SpecField::Method);
    EXPECT_TRUE (method->user_touched);
    EXPECT_EQ (method->current, "HEAD");
    EXPECT_EQ (method->next, "GET");
    // The document's own change is not confused with the user's.
    EXPECT_FALSE (field_named (diff.changed[0], SpecField::Description)->user_touched);
}

TEST_F (SpecDiffTest, ReportsAMethodTheDocumentItselfMovedAsTheDocuments) {
    // Same operationId, different verb: the request is still followed (the id
    // leads), and the verb it should now send is offered like any other field.
    const std::string moved =
    document (R"({"/pets":{"post":{"operationId":"listPets","summary":"List pets"}}})");

    const SpecDiff diff =
    diff_against (moved, { request_from ("req_0", draft_of (bound_, "listPets")) });

    ASSERT_EQ (diff.changed.size (), 1u);
    EXPECT_EQ (diff.changed[0].matched_by, vayu::core::IdentityMatch::OperationId);
    const auto* method = field_named (diff.changed[0], SpecField::Method);
    ASSERT_NE (method, nullptr);
    EXPECT_FALSE (method->user_touched);
    EXPECT_EQ (method->current, "GET");
    EXPECT_EQ (method->next, "POST");
}

TEST_F (SpecDiffTest, LeavesARequestAloneWhenTheDocumentAgreesWithTheVerbItHolds) {
    // The other direction of the same field: comparing `method` must not make
    // every unchanged request report one.
    const SpecDiff diff =
    diff_against (BOUND, { request_from ("req_0", draft_of (bound_, "listPets")) });

    EXPECT_TRUE (diff.changed.empty ());
    EXPECT_EQ (diff.unchanged, 1u);
}

} // namespace
