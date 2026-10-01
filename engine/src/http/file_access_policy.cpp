/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/file_access_policy.hpp"

#include <system_error>

#include "vayu/db/database.hpp"

namespace vayu::http {

namespace fs = std::filesystem;

namespace {

/// `p` with a trailing separator removed, so `/a/b/` and `/a/b` iterate to
/// the same components (the first ends in an empty one).
fs::path without_trailing_separator (fs::path p) {
    if (p.has_relative_path () && !p.has_filename ()) {
        p = p.parent_path ();
    }
    return p;
}

} // namespace

std::string canonical_root_path (const std::string& path) {
    std::error_code ec;
    const fs::path resolved = fs::weakly_canonical (fs::path (path), ec);
    if (ec || resolved.empty ()) {
        return {};
    }
    return without_trailing_separator (resolved).string ();
}

FileAccessPolicy::FileAccessPolicy (const std::vector<std::string>& roots) {
    roots_.reserve (roots.size ());
    for (const auto& root : roots) {
        const std::string canonical = canonical_root_path (root);
        roots_.emplace_back (canonical.empty () ? fs::path (root).lexically_normal () :
                                                  fs::path (canonical));
    }
}

FileAccessPolicy FileAccessPolicy::from_database (vayu::db::Database& db) {
    std::vector<std::string> paths;
    for (const auto& row : db.get_file_roots ()) {
        paths.push_back (row.path);
    }
    return FileAccessPolicy (paths);
}

bool FileAccessPolicy::contains (const fs::path& root, const fs::path& candidate) {
    const fs::path base = without_trailing_separator (root);
    auto r              = base.begin ();
    auto c              = candidate.begin ();
    for (; r != base.end (); ++r, ++c) {
        if (c == candidate.end () || *r != *c) {
            return false;
        }
    }
    return true;
}

bool FileAccessPolicy::allows (const std::string& path) const {
    if (roots_.empty () || path.empty ()) {
        return false;
    }
    // `canonical`, not `weakly_canonical`: every component must exist so every
    // symlink on the way is followed, which is what refuses a link inside a
    // root that points outside it.
    std::error_code ec;
    const fs::path resolved = fs::canonical (fs::path (path), ec);
    if (ec) {
        return false;
    }
    for (const auto& root : roots_) {
        if (contains (root, resolved)) {
            return true;
        }
    }
    return false;
}

} // namespace vayu::http
