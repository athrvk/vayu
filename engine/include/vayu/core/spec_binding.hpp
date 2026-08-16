/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <functional>
#include <optional>
#include <string>

/**
 * @file spec_binding.hpp
 * @brief Completing a collection's `openapi` binding (issue #709).
 *
 * A binding is `{specId, specHash, syncedAt}`: the document *and the version of
 * it* the collection was bound to. Every reader that measures a run against a
 * contract - coverage (#629), response-schema validation (#628) - requires the
 * hash to agree with the stored document, so a binding that names a document
 * and no version of it silently disables both, forever, on the path that
 * produces nearly every binding: import.
 *
 * The cure is that no write path stores a half-binding. A client sends the
 * `specId`, which is the only half it can know; the engine fills in the hash
 * from the document it just stored or already holds - the same division
 * `spec_documents.hash` itself draws, where the hash is computed engine-side
 * and refused when sent. This is that one rule, in one place, because three
 * callers apply it: the two collection write cores, `POST /import/apply`, and
 * the startup pass that repairs bindings written before the rule existed.
 */

namespace vayu::core {

/** What a stamp writes onto a binding: the document's version, and when. */
struct SpecStamp {
    /// The stored document's engine-computed hash.
    std::string hash;
    /**
     * The moment this collection is being bound to that version.
     *
     * Supplied by the caller rather than derived here, because the honest
     * answer differs by path: a write is happening *now*, while the startup
     * backfill is recording a binding that was made when the document was
     * fetched - stamping those months-old rows with `now` would tell the user
     * they synced today.
     */
    int64_t synced_at;
};

/**
 * The binding text @p openapi with its missing halves filled in, or
 * `std::nullopt` when there is nothing to change.
 *
 * @param openapi the stored `collections.openapi` text.
 * @param stamp_of resolves a `specId` to the document's stamp, or `nullopt`
 *        when the caller does not know that document. An unknown document is
 *        left alone rather than treated as an error: whether a binding may name
 *        it at all is `reject_unbindable_spec`'s question, asked under the same
 *        lock as the write, and answering it twice in two voices is how the two
 *        would come to disagree.
 *
 * Nothing to change covers: an unbound collection (`{}`), a blob that does not
 * parse as an object (every other reader of this column reads that as unbound),
 * a binding naming no spec (the write cores reject that outright), and a
 * binding that already carries both halves - a re-stamp would move `syncedAt`
 * on a collection nobody synced.
 */
[[nodiscard]] std::optional<std::string> stamp_spec_binding (const std::string& openapi,
const std::function<std::optional<SpecStamp> (const std::string& spec_id)>& stamp_of);

} // namespace vayu::core
