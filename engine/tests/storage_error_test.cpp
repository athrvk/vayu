/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/storage_error_test.cpp
 * @brief A storage failure on a resource write is not a 400 (issue #2423).
 *
 * Twelve write handlers caught every `std::exception` and answered 400, so a
 * full disk read as "your request is invalid" and the app, which retries a 5xx
 * and treats a 4xx as a verdict, never retried it. Three things hold the fix:
 * `classify_storage_error` sorts the exception, `send_exception` turns the
 * sorting into a status, and a source scan keeps a handler from going back to
 * the blanket 400.
 *
 * No test here drives a route handler into a real SQLITE_FULL. `Database`
 * exposes no pragma seam (no `max_page_count`) and `db_concurrency_test.cpp`
 * builds no fault injection on purpose, so the handlers are covered by the
 * scan plus the two units they call.
 */

#include <gtest/gtest.h>

#include <sqlite3.h>

#include <algorithm>
#include <cerrno>
#include <filesystem>
#include <iterator>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "source_scan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

namespace {

using vayu::db::StorageFailure;

std::system_error sqlite_failure (int code, const std::string& what = "write") {
    return { std::error_code (code, sqlite_orm::get_sqlite_error_category ()), what };
}

nlohmann::json::parse_error parse_failure () {
    try {
        [[maybe_unused]] const auto document = nlohmann::json::parse ("{");
    } catch (const nlohmann::json::parse_error& error) {
        return error;
    }
    throw std::logic_error ("parsing an unterminated object did not throw");
}

// ==================== classify_storage_error ====================

TEST (StorageErrorClassification, FullIsSqliteFull) {
    const auto found = vayu::db::classify_storage_error (sqlite_failure (SQLITE_FULL));
    ASSERT_HAS_VALUE (found);
    EXPECT_TRUE (found->kind == StorageFailure::Full);
}

TEST (StorageErrorClassification, BusyIsBusyAndLocked) {
    for (const int code : { SQLITE_BUSY, SQLITE_LOCKED }) {
        const auto found = vayu::db::classify_storage_error (sqlite_failure (code));
        ASSERT_HAS_VALUE (found) << code;
        EXPECT_TRUE (found->kind == StorageFailure::Busy) << code;
    }
}

TEST (StorageErrorClassification, EveryOtherSqliteFailureIsOther) {
    for (const int code : { SQLITE_IOERR, SQLITE_READONLY, SQLITE_CANTOPEN,
         SQLITE_CORRUPT, SQLITE_NOTADB, SQLITE_ERROR, SQLITE_CONSTRAINT }) {
        const auto found = vayu::db::classify_storage_error (sqlite_failure (code));
        ASSERT_HAS_VALUE (found) << code;
        EXPECT_TRUE (found->kind == StorageFailure::Other) << code;
    }
}

TEST (StorageErrorClassification, TheMessageSaysWhatSqliteSaidOnce) {
    const std::string generic =
    std::error_code (SQLITE_BUSY, sqlite_orm::get_sqlite_error_category ()).message ();
    const auto doubled =
    vayu::db::classify_storage_error (sqlite_failure (SQLITE_BUSY, generic));
    ASSERT_HAS_VALUE (doubled);
    EXPECT_EQ (doubled->message, generic);

    const auto specific = vayu::db::classify_storage_error (
    sqlite_failure (SQLITE_ERROR, "no such table: runs"));
    ASSERT_HAS_VALUE (specific);
    EXPECT_NE (specific->message.find ("no such table: runs"), std::string::npos);
}

TEST (StorageErrorClassification, AnExceptionThatIsNotSqlitesIsNotStorage) {
    EXPECT_FALSE (
    vayu::db::classify_storage_error (std::runtime_error ("name is required")).has_value ());
    EXPECT_FALSE (vayu::db::classify_storage_error (parse_failure ()).has_value ());
    EXPECT_FALSE (vayu::db::classify_storage_error (
    std::filesystem::filesystem_error ("open", std::make_error_code (std::errc::permission_denied)))
    .has_value ());
}

// errno 13 is EACCES and SQLITE_FULL is 13: the category decides, not the
// number. Dropping the category check turns a permission error into a 507.
TEST (StorageErrorClassification, AnErrnoThatSharesSqlitesNumberIsNotStorage) {
    const std::system_error errno_failure (
    std::error_code (SQLITE_FULL, std::generic_category ()), "create_directories");
    EXPECT_FALSE (vayu::db::classify_storage_error (errno_failure).has_value ());

    const std::system_error busy_number (
    std::error_code (SQLITE_BUSY, std::generic_category ()), "connect");
    EXPECT_FALSE (vayu::db::classify_storage_error (busy_number).has_value ());
}

// ==================== send_exception ====================

nlohmann::json send_and_parse (httplib::Response& res, const std::exception& error) {
    vayu::http::routes::send_exception (res, error);
    return nlohmann::json::parse (res.body);
}

TEST (SendException, ANonStorageExceptionIsTheRequestsFault) {
    httplib::Response res;
    const auto body = send_and_parse (res, std::runtime_error ("name is required"));
    EXPECT_EQ (res.status, 400);
    EXPECT_EQ (body["error"]["code"], "bad_request");
    EXPECT_EQ (body["error"]["message"], "name is required");
    EXPECT_FALSE (res.has_header ("Retry-After"));
}

TEST (SendException, ADeserialisationFailureStaysA400) {
    httplib::Response res;
    const auto body = send_and_parse (res, parse_failure ());
    EXPECT_EQ (res.status, 400);
    EXPECT_EQ (body["error"]["code"], "bad_request");
}

TEST (SendException, AFullDiskIs507WithAnActionableMessage) {
    httplib::Response res;
    const auto body =
    send_and_parse (res, sqlite_failure (SQLITE_FULL, "database or disk is full"));
    EXPECT_EQ (res.status, 507);
    EXPECT_EQ (body["error"]["code"], "insufficient_storage");
    const std::string message = body["error"]["message"];
    EXPECT_NE (message.find ("disk"), std::string::npos);
    EXPECT_NE (message.find ("free up space"), std::string::npos);
    EXPECT_EQ (message.find ("SQLite"), std::string::npos);
    EXPECT_EQ (message.find ("database or disk is full"), std::string::npos);
    EXPECT_FALSE (res.has_header ("Retry-After"));
}

TEST (SendException, ABusyDatabaseIs503AndSaysWhenToRetry) {
    for (const int code : { SQLITE_BUSY, SQLITE_LOCKED }) {
        httplib::Response res;
        const auto body =
        send_and_parse (res, sqlite_failure (code, "database is locked"));
        EXPECT_EQ (res.status, 503) << code;
        EXPECT_EQ (body["error"]["code"], "unavailable") << code;
        EXPECT_EQ (res.get_header_value ("Retry-After"), "1") << code;
        const std::string message = body["error"]["message"];
        EXPECT_EQ (message.find ("locked"), std::string::npos) << code;
    }
}

TEST (SendException, AnyOtherStorageFailureIs500) {
    for (const int code : { SQLITE_IOERR, SQLITE_READONLY, SQLITE_CANTOPEN, SQLITE_CORRUPT }) {
        httplib::Response res;
        const auto body = send_and_parse (res, sqlite_failure (code, "disk I/O error"));
        EXPECT_EQ (res.status, 500) << code;
        EXPECT_EQ (body["error"]["code"], "internal_error") << code;
        EXPECT_FALSE (res.has_header ("Retry-After")) << code;
        const std::string message = body["error"]["message"];
        EXPECT_EQ (message.find ("I/O"), std::string::npos) << code;
    }
}

// ==================== the handlers go through send_exception ====================

/// How many times @p code answers a caught exception with a bare 400, with
/// whitespace ignored so a reflow cannot hide one. Any variable name stands in
/// for `e`.
size_t blanket_400_count (const std::string& code) {
    std::string squeezed;
    std::ranges::copy_if (code, std::back_inserter (squeezed),
    [] (char c) { return c != ' ' && c != '\n' && c != '\t' && c != '\r'; });
    const std::regex blanket (R"(send_error\(res,400,\w+\.what\(\)\))");
    return static_cast<size_t> (
    std::distance (std::sregex_iterator (squeezed.begin (), squeezed.end (), blanket),
    std::sregex_iterator ()));
}

/// The routes that read or compute and write nothing, so a failure inside one
/// cannot be a storage write failing; each answers its exception once.
const std::vector<std::pair<std::string_view, size_t>>& read_only_routes () {
    static const std::vector<std::pair<std::string_view, size_t>> routes{
        { "spec_match.cpp", 1 },
        { "spec_export.cpp", 1 },
        { "spec_diff.cpp", 1 },
        { "spec_describe.cpp", 1 },
        { "postman_export.cpp", 1 },
    };
    return routes;
}

size_t allowed_blanket_400s (const std::string& file_name) {
    for (const auto& [name, count] : read_only_routes ()) {
        if (name == file_name) {
            return count;
        }
    }
    return 0;
}

TEST (SendExceptionGuard, TheMatcherSeesABlanket400AcrossAReflow) {
    EXPECT_EQ (blanket_400_count ("send_error (res, 400, e.what ());"), 1U);
    EXPECT_EQ (blanket_400_count ("send_error (res,\n  400,\n  ex.what ());"), 1U);
    EXPECT_EQ (blanket_400_count ("send_exception (res, e);"), 0U);
    EXPECT_EQ (
    blanket_400_count ("send_error (res, 400, \"name is required\");"), 0U);
}

// A handler that goes back to `send_error (res, 400, e.what ())` answers a full
// disk with a 400 again. The read-only routes above keep theirs.
TEST (SendExceptionGuard, OnlyTheReadOnlyRoutesAnswerACaughtExceptionWith400) {
    const std::filesystem::path routes =
    std::filesystem::path{ VAYU_ENGINE_SOURCE_DIR } / "src" / "http" / "routes";
    size_t scanned = 0;
    for (const auto& entry : std::filesystem::directory_iterator (routes)) {
        if (entry.path ().extension () != ".cpp") {
            continue;
        }
        const std::string source = vayu::tests::read_source (entry.path ());
        ASSERT_FALSE (source.empty ()) << entry.path ();
        ++scanned;
        const std::string name = entry.path ().filename ().string ();
        EXPECT_EQ (blanket_400_count (vayu::tests::strip_comments (source)),
        allowed_blanket_400s (name))
        << name << " answers a caught exception with a bare 400; use send_exception";
    }
    EXPECT_GT (scanned, 0U) << "no route file under " << routes;
    // The allow-list names real files: a rename must not leave it vacuous.
    for (const auto& [name, count] : read_only_routes ()) {
        EXPECT_TRUE (std::filesystem::exists (routes / std::string (name))) << name;
    }
}

} // namespace
