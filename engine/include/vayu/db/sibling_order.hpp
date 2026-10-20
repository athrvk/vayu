#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <tuple>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::db {

/**
 * The children of a collection are its sub-folders and its requests together,
 * in one `order` space (#2535). This header is the engine's one copy of how
 * the two kinds sort against each other; `compareTreeOrder` in
 * `app/src/types/domain.ts` is the renderer's, and
 * `tests/fixtures/tree-order-conformance.json` pins the two together.
 */

/// Which table a sibling is a row of. Declared in rank order: on an `order`
/// tie a sub-folder sorts before a request.
enum class SiblingKind : std::uint8_t { Folder, Request };

/// What one sibling is sorted by, in comparison order.
struct SiblingKey {
    int order          = 0;
    SiblingKind kind   = SiblingKind::Folder;
    int64_t created_at = 0;
    std::string_view id;
};

[[nodiscard]] inline SiblingKey sibling_key (const Collection& folder) {
    return { folder.order, SiblingKind::Folder, folder.created_at, folder.id };
}

[[nodiscard]] inline SiblingKey sibling_key (const Request& request) {
    return { request.order, SiblingKind::Request, request.created_at, request.id };
}

/**
 * Whether @p a sorts before @p b: `order`, then kind (folders first), then
 * `created_at`, then `id` byte-wise. Within one kind this is the
 * `(order, created_at, id)` that `Database::get_collections` and
 * `get_requests_in_collection` sort by, so either list read alone is already
 * in sibling order.
 */
[[nodiscard]] inline bool sibling_before (const SiblingKey& a, const SiblingKey& b) {
    return std::tie (a.order, a.kind, a.created_at, a.id) <
    std::tie (b.order, b.kind, b.created_at, b.id);
}

/// One entry of a merged sibling list: the kind, and the entry's index in the
/// input list of that kind.
struct SiblingSlot {
    SiblingKind kind  = SiblingKind::Folder;
    std::size_t index = 0;
};

/**
 * One parent's sub-folders and requests as a single list in sibling order.
 * Answers indices rather than copies, so a caller holding its own rows can
 * move them out; the inputs may arrive in any order.
 */
[[nodiscard]] inline std::vector<SiblingSlot> merge_siblings (
const std::vector<const Collection*>& folders,
const std::vector<Request>& requests) {
    std::vector<SiblingSlot> slots;
    slots.reserve (folders.size () + requests.size ());
    for (std::size_t i = 0; i < folders.size (); ++i) {
        slots.push_back ({ SiblingKind::Folder, i });
    }
    for (std::size_t i = 0; i < requests.size (); ++i) {
        slots.push_back ({ SiblingKind::Request, i });
    }
    const auto key_of = [&] (const SiblingSlot& slot) {
        return slot.kind == SiblingKind::Folder ?
        sibling_key (*folders.at (slot.index)) :
        sibling_key (requests.at (slot.index));
    };
    std::sort (slots.begin (), slots.end (),
    [&] (const SiblingSlot& a, const SiblingSlot& b) {
        return sibling_before (key_of (a), key_of (b));
    });
    return slots;
}

} // namespace vayu::db
