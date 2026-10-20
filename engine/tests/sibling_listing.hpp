#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>
#include <vector>

#include "vayu/db/database.hpp"
#include "vayu/db/sibling_order.hpp"

namespace vayu::tests {

/**
 * A collection's children as the sidebar lists them: its sub-folders and its
 * requests merged in sibling order (`vayu/db/sibling_order.hpp`, #2535), each
 * written `folder:<name>` or `request:<name>` so a failed comparison reads
 * like the tree it describes.
 */
inline std::vector<std::string>
listed_children (vayu::db::Database& db, const std::string& parent_id) {
    const std::vector<vayu::db::Collection> collections = db.get_collections ();
    std::vector<const vayu::db::Collection*> folders;
    for (const auto& collection : collections) {
        if (collection.parent_id == parent_id) {
            folders.push_back (&collection);
        }
    }
    const std::vector<vayu::db::Request> requests =
    db.get_requests_in_collection (parent_id);
    std::vector<std::string> listed;
    for (const auto& slot : vayu::db::merge_siblings (folders, requests)) {
        listed.push_back (slot.kind == vayu::db::SiblingKind::Folder ?
        "folder:" + folders.at (slot.index)->name :
        "request:" + requests.at (slot.index).name);
    }
    return listed;
}

/// The id of the sub-folder of @p parent_id named @p name, or `""`.
inline std::string child_folder_id (vayu::db::Database& db,
const std::string& parent_id,
const std::string& name) {
    for (const auto& collection : db.get_collections ()) {
        if (collection.parent_id == parent_id && collection.name == name) {
            return collection.id;
        }
    }
    return {};
}

} // namespace vayu::tests
