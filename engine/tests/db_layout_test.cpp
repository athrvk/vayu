/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/db_layout_test.cpp
 * @brief The two shape rules issue #1614's split depends on: nothing outside
 *        `src/db/` reaches into `database_impl.hpp`, and `database.cpp`
 *        itself holds only construction, open, close, locking and
 *        transactions - every other `Database::` member moved to the family
 *        file `database.hpp`'s section comments now name.
 *
 * Both are invisible to a passing build: a stray include of the internal
 * header compiles fine right up until two translation units disagree about
 * `Database::Impl`'s layout, and a member left behind in `database.cpp`
 * compiles fine forever. Neither is something `ctest`'s pass count would
 * ever catch, which is exactly the shape of rule a source scan is for.
 */

#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"

namespace vayu::db {
namespace {

TEST (DbLayout, OnlyDbIncludesDatabaseImplHeader) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    const auto tree = root / "src";
    ASSERT_TRUE (std::filesystem::is_directory (tree))
    << tree.string () << " is not where the guard looks";

    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto& entry : std::filesystem::recursive_directory_iterator (tree)) {
        const auto& path            = entry.path ();
        const std::string extension = path.extension ().string ();
        if (!entry.is_regular_file () || (extension != ".cpp" && extension != ".hpp")) {
            continue;
        }
        const std::string relative =
        std::filesystem::relative (path, root).generic_string ();

        const std::string code = tests::strip_comments (tests::read_source (path));
        ASSERT_FALSE (code.empty ()) << relative << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();

        if (relative == "src/db/database_impl.hpp") {
            continue; // The header does not include itself.
        }
        if (!tests::names_identifier (code, "database_impl.hpp")) {
            continue;
        }
        if (relative.starts_with ("src/db/")) {
            continue; // Every unit under src/db/ is allowed to include it.
        }
        offenders.push_back (relative);
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 100u) << "the guard found almost no sources";
    ASSERT_GT (scanned_bytes, 100'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "database_impl.hpp is never installed and carries no ABI promise - "
       "only engine/src/db/*.cpp may include it. Offenders:\n  "
    << joined;
}

/// The planted positive: a file outside src/db/ that names the header is
/// exactly what the guard above must catch, so this pins the matcher rather
/// than trusting an always-empty offenders list.
TEST (DbLayout, TheGuardSeesTheHeaderName) {
    EXPECT_TRUE (tests::names_identifier ("#include \"database_impl.hpp\"\n", "database_impl.hpp"));
    EXPECT_FALSE (tests::names_identifier ("#include \"database.hpp\"\n", "database_impl.hpp"));
}

/// Every `Database::` member `database.cpp` may still define, per the
/// landing plan in issue #1614: construction, destruction, the path
/// accessor, the composite lock, the DB-mutex-owning absence check the
/// constructor's own recovery branch reaches through `get_collection`, and
/// the transaction-retry helper. Everything else moved to a family file.
constexpr std::array<std::string_view, 5> kAllowedInDatabaseCpp = {
    "path", "with_lock", "owner_is_absent_locked", "retry_on_busy",
    "Database", // constructor and destructor: `Database::Database` / `Database::~Database`
};

bool is_allowed (std::string_view name) {
    for (const auto& allowed : kAllowedInDatabaseCpp) {
        if (allowed == name) {
            return true;
        }
    }
    return false;
}

TEST (DbLayout, DatabaseCppDefinesOnlyConstructionLockingAndTransactions) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    const auto file        = root / "src" / "db" / "database.cpp";
    const std::string code = tests::strip_comments (tests::read_source (file));
    ASSERT_FALSE (code.empty ()) << file.string () << " read as empty";
    ASSERT_GT (code.size (), 500u)
    << "the guard read an unexpectedly small file";

    std::vector<std::string> offenders;
    const std::string_view needle = "Database::";
    for (size_t at = code.find (needle); at != std::string::npos;
    at             = code.find (needle, at + 1)) {
        size_t name_start = at + needle.size ();
        // `Database::~Database` and `Database::BackupSlot::BackupSlot` share
        // the same "Database::" prefix; skip the destructor's `~` so the name
        // extracted below is the bare identifier every other case yields, and
        // skip any second-level "Database::" (there are none left in this
        // file, but the loop must not misread one if a future edit adds a
        // nested-class definition here).
        bool is_dtor     = name_start < code.size () && code[name_start] == '~';
        size_t scan_from = is_dtor ? name_start + 1 : name_start;
        size_t name_end  = scan_from;
        while (name_end < code.size () &&
        ((std::isalnum (static_cast<unsigned char> (code[name_end])) != 0) ||
        code[name_end] == '_')) {
            ++name_end;
        }
        const std::string name = code.substr (scan_from, name_end - scan_from);
        if (name.empty ()) {
            continue;
        }
        // Only a definition (name immediately followed, past whitespace, by
        // "(") counts - a comment or doc-comment mentioning "Database::x" in
        // prose was already stripped above, but a qualified *call* like
        // `Database::path ()` read from inside another member would not be;
        // none occurs in this file, and the assertion below is the proof.
        size_t after_name = name_end;
        while (after_name < code.size () && code[after_name] == ' ') {
            ++after_name;
        }
        if (after_name >= code.size () || code[after_name] != '(') {
            continue;
        }
        if (!is_allowed (name)) {
            offenders.push_back (name);
        }
    }

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += ", ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "database.cpp defines a Database:: member outside construction, "
       "locking and transactions - move it to the family file "
       "database.hpp's section comment names. Offenders: "
    << joined;
}

} // namespace
} // namespace vayu::db
