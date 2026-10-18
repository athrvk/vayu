#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file file_access_policy.hpp
 * @brief Which files a request body may be read from.
 *
 * The trust rule is one sentence: Vayu sends a file you picked, or any file
 * under a folder you allowed in Settings. This type holds both halves - the
 * allowed folders (`file_roots`) and the picked files (`file_grants`, #2356) -
 * and `file_ref.hpp` applies it to every reference no human chose
 * (`FileRef::unresolved`).
 *
 * Containment is decided on **canonical** paths, compared component by
 * component: `canonical` resolves every symlink, so a link inside a root that
 * points outside it is outside, and `/data/fixtures-old` is not under
 * `/data/fixtures` the way a string prefix test would say it is. A grant is the
 * canonical path recorded when the file was picked and is matched exactly, so a
 * symlink re-pointed after the pick resolves elsewhere and is refused.
 */

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace vayu::db {
class Database;
}

namespace vayu::http {

class FileAccessPolicy {
    public:
    /// Nothing is allowed: no request-body file is sent.
    FileAccessPolicy () = default;

    /// The folders in @p roots, each canonicalised once here, and the picked
    /// files in @p grants, taken as stored: already canonical, and never
    /// re-resolved, because resolving a grant again would follow a link planted
    /// at its path since the pick. A root that no longer exists is kept in its
    /// lexical form and simply matches nothing a send could open.
    explicit FileAccessPolicy (const std::vector<std::string>& roots,
    const std::vector<std::string>& grants = {});

    /// The stored `file_roots` and `file_grants`, read once - per design send,
    /// or once per run.
    [[nodiscard]] static FileAccessPolicy from_database (vayu::db::Database& db);

    /// True when @p path resolves (symlinks followed) to a location inside one
    /// of the roots, or to exactly a granted file. A path that cannot be
    /// canonicalised - it does not exist, or a component is unreadable - is not
    /// allowed.
    [[nodiscard]] bool allows (const std::string& path) const;

    /// Component-wise containment of two already-canonical paths: @p candidate
    /// is @p root itself or lies below it.
    [[nodiscard]] static bool contains (const std::filesystem::path& root,
    const std::filesystem::path& candidate);

    [[nodiscard]] const std::vector<std::filesystem::path>& roots () const {
        return roots_;
    }

    private:
    std::vector<std::filesystem::path> roots_;
    std::unordered_set<std::string> grants_;
};

/**
 * @brief The canonical spelling `file_roots` stores for @p path.
 *
 * `weakly_canonical` (symlinks resolved, `.` and `..` folded) with no trailing
 * separator, so two spellings of one folder are one row. Empty when the path
 * cannot be resolved at all.
 */
[[nodiscard]] std::string canonical_root_path (const std::string& path);

/**
 * @brief The canonical spelling `file_grants` stores for @p path, or nothing
 * when @p path may not be granted.
 *
 * Grantable is an absolute path, holding no `{{` (a template names no file
 * until composition, and a grant is for a file, never a pattern), that
 * resolves through every symlink to an existing regular file - a directory, a
 * device or a pipe is never one.
 */
[[nodiscard]] std::optional<std::string> grantable_file_path (const std::string& path);

/**
 * @brief Why the canonical folder @p canonical may not be allowed, or nothing.
 *
 * A filesystem or drive root (`/`, `C:\`), the home folder @p home and any
 * folder that contains it (`/home`, `C:\Users`) would each allow nearly every
 * file a request could name, which undoes the per-file choice the trust rule
 * exists to keep; a folder inside the home folder is fine. An empty @p home
 * skips that half. Pure string work over both
 * separators, so every platform's spellings are testable on any host:
 * `std::filesystem` reads `C:\` as a relative name off Windows.
 */
[[nodiscard]] std::optional<std::string>
refused_root_reason (std::string_view canonical, std::string_view home);

} // namespace vayu::http
