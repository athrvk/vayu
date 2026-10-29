#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/spec_diff.hpp
 * @brief What a re-fetched OpenAPI document changed about the collection bound
 *        to it (issue #654, moved engine-side by #854).
 *
 * Binding recorded which operation each request is; this answers the question
 * that identity exists for - **has the contract moved, and where**. Three
 * buckets: operations no request claims (`added`), requests whose operation the
 * document no longer declares (`removed`), and requests whose operation is still
 * declared but no longer produces what the collection holds (`changed`). An
 * operation nobody claims because a person deleted its request is `declined`
 * instead of `added` (#3031).
 *
 * **Nothing here writes.** The comparison is a pure function of two documents
 * and the requests, so every judgement it makes - which operation is which, what
 * counts as changed, what the user has edited - is provable in a test that
 * cannot touch a row. Applying it is `POST /specs/sync` (issue #655).
 *
 * **Why the engine owns it** (#761's phase B): the Sync section was the last
 * part of the spec feature an agent could not reach, because the comparison
 * lived in the renderer. Moving it needed the engine to be able to say what
 * requests a document would build (#853's reader, #865's drafts), which is what
 * `SpecRequestDraft` is - and with those here, this is the ordinary port its
 * four rules describe.
 *
 * ### The four rules, each of which the renderer copy learned the hard way
 *
 * - **The user-touched flag is three-way.** A field is flagged when what the
 *   request holds is neither what the new document produces nor what the *bound*
 *   one did - the only evidence that a person put it there. A two-way comparison
 *   cannot tell an edit apart from a spec change, and the apply would then
 *   quietly revert one.
 * - **An `operationId` is only followed while it means one thing** (issue #715).
 *   An id two requests claim identifies neither; an id whose entry contradicts
 *   the endpoint the request records loses to an exact match on that endpoint.
 * - **`method` is a compared, tickable field** (issue #717), not something an
 *   apply writes unconditionally - it is what the request *sends*, and writing
 *   it for the user reverted a deliberate `GET` -> `HEAD` invisibly.
 * - **Response examples are deliberately not compared.** The rule that governs
 *   them (`origin="import"` is replaced, `origin="user"` survives) only means
 *   anything at apply time, so comparing them here would cost a read for a
 *   report nothing acts on.
 *
 * **Identity, and renames.** An operation is followed by its `operationId`
 * first and by method + path shape second, so the two ways a document commonly
 * moves an operation both stay one operation: a path edited under a stable
 * `operationId` follows the id, an `operationId` edited under a stable path
 * follows the path. Both changed at once is a `removed` and an `added`, stated
 * as such - there is nothing left to follow, and guessing is how a sync
 * overwrites the wrong request. The path side is compared through
 * `core::spec_path_shape`, the same flattening the matcher binds with, so a
 * renamed path *parameter* (`{petId}` -> `{id}`) is the same endpoint here too.
 */

#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_coverage.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core {

/**
 * The fields an OpenAPI import writes, and therefore the only ones a sync has
 * any claim on.
 *
 * A request's auth and scripts are absent on purpose: an import sets each
 * operation's auth from its own `security` (issue #1444) and leaves both
 * scripts empty, and a sync never revisits either field afterward, so a
 * difference there is always the user's and never the document's.
 */
enum class SpecField : std::uint8_t {
    Name,
    Description,
    Method,
    Url,
    Params,
    Headers,
    Body
};

/// The wire spelling of @p field - what a tick names and what an apply reads.
[[nodiscard]] std::string_view spec_field_name (SpecField field);

/** One field of one request that no longer matches the document. */
struct SpecFieldDiff {
    SpecField field = SpecField::Name;
    /// What the request holds today, rendered for display.
    std::string current;
    /// What the re-fetched document produces, rendered for display.
    std::string next;
    /**
     * The request's value is neither the new document's nor the bound one's -
     * somebody edited it. False whenever `ChangedRequest::previous_unknown` is
     * set: with no bound value to compare against, "the user did this" is not a
     * claim this can make.
     */
    bool user_touched = false;
};

/** How a request was followed from its recorded identity into the new document. */
enum class IdentityMatch : std::uint8_t { OperationId, Path };

/**
 * A stored request, as the comparison reads it.
 *
 * The spec-derived half of a request and nothing else, in the same shape a
 * draft carries it, which is what lets one function speak for both sides - the
 * alternative being two renderings that can disagree about whether a field
 * moved.
 */
struct ComparableRequest {
    std::string id;
    std::string name;
    std::string description;
    /// Upper-case, as the request stores it.
    std::string method;
    /// The URL as written, `{{baseUrl}}` and all - never a resolved one.
    std::string url;
    std::vector<DraftField> params;
    std::vector<DraftField> headers;
    DraftBody body;
    /**
     * The identity the request carries (`requests.spec_operation`), absent for
     * a request that carries none. `responses` is unused here - a stamp records
     * which operation a request is, never what it declares.
     */
    std::optional<DeclaredOperation> operation;
};

/** One request whose operation the document still declares, and what moved. */
struct ChangedRequest {
    /// Index into the requests that were offered.
    size_t request = 0;
    /**
     * Index into the fetched drafts - the request an import of the new document
     * would build, and the values behind every `SpecFieldDiff::next`.
     *
     * An index rather than a copy, like `MatchResult`'s: applying a change has
     * to write *values* and the rendered `next` is truncated for display, so the
     * apply reads them from the same draft the comparison was made against.
     */
    size_t draft = 0;
    /// The identity the request carries today.
    DeclaredOperation bound_operation;
    IdentityMatch matched_by = IdentityMatch::Path;
    /// The document moved the identity itself - the other half of it changed.
    bool renamed = false;
    /**
     * The bound document does not declare this operation (or could not be read),
     * so what the user edited cannot be told apart from what the document
     * changed. Stated rather than guessed at.
     */
    bool previous_unknown = false;
    /// Every field that no longer matches, in display order. May be empty for a
    /// pure rename.
    std::vector<SpecFieldDiff> fields;
};

/**
 * Indices into the two lists that were offered, never copies: the caller holds
 * both and knows how it wants to name them, and an index cannot drift from the
 * row it came from.
 */
struct SpecDiff {
    /// Drafts no request claims. These become requests at apply time, not here.
    std::vector<size_t> added;
    /**
     * Drafts no request claims that a person declined by deleting the request
     * for them (#3031): an operation is here or in `added`, never both. A draft
     * a live request claims is in neither, whatever was declined, because a
     * request carrying the identity is a stronger statement than a record of
     * one that was deleted.
     */
    std::vector<size_t> declined;
    /// Requests whose recorded operation the new document no longer declares.
    std::vector<size_t> removed;
    std::vector<ChangedRequest> changed;
    /// Requests whose operation is unchanged in every compared field.
    size_t unchanged = 0;
    /**
     * Requests carrying no operation identity at all. Not part of the comparison
     * - the contract never described them - but counted, because a sync that
     * silently ignores half a collection is a sync nobody can read.
     */
    size_t unmapped = 0;
};

/**
 * What a safe apply writes for one changed request.
 *
 * `apply` and `fields` are two answers rather than one because they are two
 * questions: a request whose only movement is the identity is applied with no
 * field ticked at all, which is a real selection and not an absence.
 */
struct SafeChangedApply {
    /// A safe apply updates this request at all.
    bool apply = false;
    /// The fields it writes. Empty for a pure rename, and for a request it skips.
    std::vector<SpecField> fields;
};

/**
 * Which of a {@link SpecDiff} a sync writes when nobody has ticked anything -
 * the policy behind `POST /specs/sync`'s `"safe"` and the marks
 * `POST /specs/diff` reports (issue #871).
 *
 * Each member is **parallel to the bucket it names**, so a reader marks the
 * entry it is already holding and no reader has to decide anything a second
 * time. That is the whole point of the type: the rules below used to live in
 * the renderer alone (`spec-apply.ts`, `defaultSelection`), which put every
 * apply out of reach of anything that is not the Spec tab, and any copy of them
 * elsewhere would be a second opinion about which of a user's fields a sync may
 * overwrite.
 */
struct SafeSpecApply {
    /// Parallel to `SpecDiff::added` - true where a safe apply creates the operation.
    std::vector<bool> create;
    /**
     * Parallel to `SpecDiff::declined`, and **false throughout** (#3031).
     *
     * Somebody deleted the request for each of these, so re-creating one is a
     * decision only that person can take back - by restoring the request, or
     * by ticking the operation. A member for the reason `remove` is one.
     */
    std::vector<bool> recreate;
    /**
     * Parallel to `SpecDiff::removed`, and **false throughout**.
     *
     * Deleting is opt-in: a request whose operation the document no longer
     * declares may be one somebody still wants. It is a member rather than an
     * absence so that a reader marking the removed bucket reads the rule here
     * instead of writing `false` itself.
     */
    std::vector<bool> remove;
    /// Parallel to `SpecDiff::changed`.
    std::vector<SafeChangedApply> update;
};

/**
 * @brief What a sync writes out of @p diff when the caller states no ticks.
 *
 * Three rules, and the two that matter are the ones whose silent failure costs
 * a person their work:
 *
 * - **A field somebody edited is never written.** `SpecFieldDiff::user_touched`
 *   marks a value that is neither the document's old one nor its new one, which
 *   is the signature of a hand edit; those fields are left out.
 * - **A request the comparison could not make three-way is left alone whole.**
 *   With `previous_unknown` there is no bound value to compare against, so every
 *   field is potentially somebody's edit and none of them can be told apart.
 * - **Nothing is deleted**, and nothing somebody deleted is re-created.
 *
 * A changed request with nothing safe to write and no moved identity is not
 * applied: an update that writes nothing is a row in a transaction for no
 * reason.
 */
[[nodiscard]] SafeSpecApply safe_spec_apply (const SpecDiff& diff);

/**
 * @brief Compare a collection's requests against the document they would be
 *        imported from now.
 *
 * @param fetched the re-fetched document as drafts.
 * @param bound the document the collection is bound to, as drafts, or `nullptr`
 *        when it could not be read at all - which turns every field comparison
 *        two-way and sets `previous_unknown` on each changed request.
 * @param requests every request beneath the bound collection.
 * @param declined the identities deletes declined under the bound collection
 *        (#3031). Each is followed into @p fetched by the rule a request's own
 *        identity is, so a declined operation the document renamed is still
 *        the declined one.
 */
[[nodiscard]] SpecDiff diff_spec (const std::vector<SpecRequestDraft>& fetched,
const std::vector<SpecRequestDraft>* bound,
const std::vector<ComparableRequest>& requests,
const std::vector<DeclaredOperation>& declined);

/**
 * @brief Which of @p declined a sync that creates @p created takes back
 *        (#3031), as indices into @p declined.
 *
 * Ticking a declined operation is the person changing their mind, so the
 * record goes with the create that answers it. Both sides are followed into
 * @p fetched - the document being stored - by the rule `diff_spec` follows
 * them with, and a record is taken back when it names the same operation a
 * created identity does: the record the diff listed an entry under is the one
 * ticking that entry clears, renames included.
 */
[[nodiscard]] std::vector<size_t> declines_taken_back (
const std::vector<SpecRequestDraft>& fetched,
const std::vector<DeclaredOperation>& declined,
const std::vector<DeclaredOperation>& created);

} // namespace vayu::core
