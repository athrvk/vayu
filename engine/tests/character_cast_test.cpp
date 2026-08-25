/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/character_cast_test.cpp
 * @brief `vayu::utils::byte_view` and `vayu::db::column_text` (issue #945), and
 *        the guard that keeps hand-rolled copies of them out of the tree.
 *
 * Two halves, because the defect has two.
 *
 * The behavioural half is what each primitive promises. `byte_view` must hand
 * back the same bytes in the same order and must survive an empty span, which
 * is where a `data()`-plus-`size()` conversion written by hand goes wrong.
 * `column_text` must answer `nullptr` for a SQL NULL and the text otherwise -
 * a wrapper that defaulted NULL to the empty string would erase the one
 * distinction its callers read.
 *
 * The scanning half is for what no behavioural test can reach. Reinterpreting a
 * pointer between character types is defined behaviour ([basic.lval] lets any
 * object be read through `char`, `unsigned char` or `std::byte`), so a
 * hand-rolled copy *works* - it is simply a copy, and a copy of a primitive
 * does not receive the primitive's fixes. Eight of them had accumulated by the
 * time #945's batch 3 counted: six spelling a digest as a `string_view`, and
 * three more spelling a sqlite TEXT column as `const char*`. The CI tidy gate
 * scopes to a pull request's changed lines, so nothing holds the count at zero
 * once these lines stop being new; the scan is what does. Reverting any one of
 * the rewrites fails it.
 */

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>
#include <sqlite3.h>

#include "source_scan.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

namespace vayu {
namespace {

// ---------------------------------------------------------------------------
// byte_view
// ---------------------------------------------------------------------------

TEST (ByteView, PresentsTheSameBytesInTheSameOrder) {
    // Values chosen so a sign-extending or byte-swapping conversion could not
    // pass: 0x00 terminates a C string, 0x80 and 0xFF are negative as `char`.
    const std::array<std::uint8_t, 5> bytes = { 0x00, 0x7F, 0x80, 0xFF, 0x41 };
    const std::string_view view             = utils::byte_view (bytes);

    ASSERT_EQ (view.size (), bytes.size ());
    for (std::size_t i = 0; i < bytes.size (); ++i) {
        EXPECT_EQ (static_cast<std::uint8_t> (view[i]), bytes.at (i)) << "at " << i;
    }
}

TEST (ByteView, CarriesTheWholeDigestPastAnInteriorZeroByte) {
    // The reason the length travels with the pointer. This input is picked for
    // a digest that has an interior `\0` (byte 22 of
    // ba2f...8f99) - a zero is an ordinary digest byte, and a NUL-terminated
    // reading of the same pointer would cut the encoding short there.
    const auto digest = utils::sha256 ("vayu-15");
    ASSERT_NE (std::find (digest.begin (), digest.end (), 0), digest.end ())
    << "the fixture input no longer digests to a value with a zero byte";

    const std::string encoded = utils::hex_encode (utils::byte_view (digest));
    EXPECT_EQ (encoded, "ba2f3c08a44c40eb55c74df28784328123620907190a003929d4b519f4c28f99");
}

TEST (ByteView, AnEmptySpanIsAnEmptyView) {
    const std::array<std::uint8_t, 0> nothing{};
    EXPECT_TRUE (utils::byte_view (nothing).empty ());
}

// ---------------------------------------------------------------------------
// column_text
// ---------------------------------------------------------------------------

/// A scratch database with one row: a TEXT value and a SQL NULL beside it.
class ColumnTextFixture : public ::testing::Test {
    protected:
    void SetUp () override {
        tests::remove_database_files (DB_PATH);
        ASSERT_EQ (sqlite3_open (DB_PATH, &handle_), SQLITE_OK);
        ASSERT_EQ (sqlite3_exec (handle_,
                   "CREATE TABLE t (present TEXT, absent TEXT);"
                   "INSERT INTO t VALUES ('caf\xC3\xA9', NULL);",
                   nullptr, nullptr, nullptr),
        SQLITE_OK);
    }

    void TearDown () override {
        sqlite3_close (handle_);
        tests::remove_database_files (DB_PATH);
    }

    static constexpr const char* DB_PATH = "test_column_text.db";
    sqlite3* handle_                     = nullptr;
};

TEST_F (ColumnTextFixture, ReadsATextColumnAsCharacters) {
    sqlite3_stmt* stmt = nullptr;
    ASSERT_EQ (sqlite3_prepare_v2 (handle_, "SELECT present, absent FROM t", -1, &stmt, nullptr),
    SQLITE_OK);
    ASSERT_EQ (sqlite3_step (stmt), SQLITE_ROW);

    const char* present = db::column_text (stmt, 0);
    ASSERT_NE (present, nullptr);
    // Multi-byte, so a conversion that went through a signed character type and
    // truncated would be visible rather than merely suspected.
    EXPECT_EQ (std::string (present), "caf\xC3\xA9");

    // A SQL NULL stays a null pointer: the caller decides what absent means.
    EXPECT_EQ (db::column_text (stmt, 1), nullptr);

    sqlite3_finalize (stmt);
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * @brief Whether @p code reinterpret_casts a pointer to a character type.
 *
 * Matches `reinterpret_cast<` followed by an optional `const`, then `char`,
 * `signed char` or `unsigned char`, then `*`. Deliberately narrow: the casts
 * this rule is about are the character-type ones, and the tree's other
 * `reinterpret_cast`s (a `sockaddr_in*` off an `addrinfo`, a Windows function
 * pointer off `GetProcAddress`, a `uintptr_t` for a unique path) are answering
 * different questions with no primitive to route through.
 */
bool names_character_reinterpret_cast (const std::string& code) {
    constexpr std::string_view kOpen = "reinterpret_cast<";
    for (std::size_t at = code.find (kOpen); at != std::string::npos;
    at                  = code.find (kOpen, at + 1)) {
        std::string_view rest (code);
        rest.remove_prefix (at + kOpen.size ());

        const auto skip_spaces = [&rest] () {
            while (!rest.empty () &&
            (std::isspace (static_cast<unsigned char> (rest.front ())) != 0)) {
                rest.remove_prefix (1);
            }
        };
        const auto eat = [&rest, &skip_spaces] (std::string_view word) {
            if (rest.substr (0, word.size ()) != word) {
                return false;
            }
            rest.remove_prefix (word.size ());
            skip_spaces ();
            return true;
        };

        skip_spaces ();
        eat ("const");
        // `signed`/`unsigned` are optional; `char` is not.
        if (!eat ("unsigned")) {
            eat ("signed");
        }
        if (!eat ("char")) {
            continue;
        }
        if (!rest.empty () && rest.front () == '*') {
            return true;
        }
    }
    return false;
}

/// The files allowed to spell one, and why. Per file rather than per line: a
/// file on this list is one whose whole job is the conversion (or, for the two
/// at the bottom, one where no primitive can stand in), and a new cast added to
/// any file *not* here is what the guard exists to name.
struct ExemptFile {
    std::string_view file;
    std::string_view reason;
};

/// `cert-err58-cpp` is why this is a `constexpr std::array` of views rather
/// than the `std::vector<std::string>` it reads more naturally as - a
/// namespace-scope container with a throwing constructor is a finding of this
/// same paydown.
constexpr std::array<ExemptFile, 5> kExempt = { {
{ "include/vayu/utils/encoding.hpp", "byte_view, and the base64 decoder's output buffer" },
{ "include/vayu/utils/sodium_init.hpp", "sodium_bytes - byte_view's inverse" },
{ "include/vayu/db/database.hpp", "column_text" },
{ "tests/tls_server.hpp", "OpenSSL's C API takes const unsigned char* directly, with no string_view seam" },
{ "src/runtime/script_engine.cpp", "a JS ArrayBuffer's bytes arrive as uint8_t* from QuickJS, not as a span" },
} };

bool is_exempt (std::string_view file) {
    return std::any_of (kExempt.begin (), kExempt.end (),
    [&] (const ExemptFile& entry) { return entry.file == file; });
}

TEST (CharacterCasts, TheEngineSourcesGoThroughThePrimitives) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    std::size_t scanned_files = 0;
    std::size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto* directory : { "src", "include", "tests" }) {
        const auto tree = root / directory;
        ASSERT_TRUE (std::filesystem::is_directory (tree))
        << tree.string () << " is not where the guard looks";

        for (const auto& entry : std::filesystem::recursive_directory_iterator (tree)) {
            const auto& path            = entry.path ();
            const std::string extension = path.extension ().string ();
            if (!entry.is_regular_file () || (extension != ".cpp" && extension != ".hpp")) {
                continue;
            }
            const std::string relative =
            std::filesystem::relative (path, root).generic_string ();
            // This file's own planted positives live in string literals, which
            // `strip_comments` does not blank.
            if (relative == "tests/character_cast_test.cpp") {
                continue;
            }

            const std::string code = tests::strip_comments (tests::read_source (path));
            ASSERT_FALSE (code.empty ()) << relative << " read as empty";
            ++scanned_files;
            scanned_bytes += code.size ();

            if (!is_exempt (relative) && names_character_reinterpret_cast (code)) {
                offenders.push_back (relative);
            }
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 200u) << "the guard found almost no sources";
    ASSERT_GT (scanned_bytes, 100'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "a character-type reinterpret_cast written here is a copy of a "
       "primitive, and a copy does not receive the primitive's fixes. Use "
       "vayu::utils::byte_view for bytes-as-text, vayu::db::column_text for a "
       "sqlite TEXT column, or add the file to kExempt with its reason. "
       "Offenders:\n  "
    << joined;
}

TEST (CharacterCasts, TheGuardSeesACharacterCastAndNotTheOthers) {
    // The planted positives. Without these, a broken matcher would leave the
    // guard above passing on a tree that had brought every copy back.
    EXPECT_TRUE (names_character_reinterpret_cast (
    "reinterpret_cast<const char*> (digest.data ())"));
    EXPECT_TRUE (names_character_reinterpret_cast (
    "reinterpret_cast<unsigned char*> (out.data ())"));
    EXPECT_TRUE (names_character_reinterpret_cast (
    "reinterpret_cast<const unsigned char*> (s.data ())"));
    EXPECT_TRUE (
    names_character_reinterpret_cast ("reinterpret_cast<char*>(p)"));

    // And the casts this rule is not about.
    EXPECT_FALSE (names_character_reinterpret_cast (
    "reinterpret_cast<sockaddr_in6*> (best->ai_addr)"));
    EXPECT_FALSE (
    names_character_reinterpret_cast ("reinterpret_cast<uintptr_t> (this)"));
    EXPECT_FALSE (names_character_reinterpret_cast (
    "reinterpret_cast<RtlVerifyVersionInfoFn> (address)"));
    EXPECT_FALSE (
    names_character_reinterpret_cast ("static_cast<const char*> (p)"));
    // `char_traits` starts with `char` and is not a character type.
    EXPECT_FALSE (
    names_character_reinterpret_cast ("reinterpret_cast<char_traits*> (p)"));

    // And the stripper really does blank prose, which is what keeps the
    // exemption list to files that spell one in code.
    EXPECT_FALSE (names_character_reinterpret_cast (tests::strip_comments (
    "// never write reinterpret_cast<const char*> (p) here\n")));
    EXPECT_TRUE (names_character_reinterpret_cast (tests::strip_comments (
    "/* see below */ reinterpret_cast<const char*> (p);\n")));
}

} // namespace
} // namespace vayu
