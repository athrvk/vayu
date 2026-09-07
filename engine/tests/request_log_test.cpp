/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/request_log_test.cpp
 * @brief One request line per HTTP call, from one place (issue #1510).
 *
 * Three things a running server can't prove by itself: the exact line format
 * (`format_request_log_line`), which level a status maps to (`log_request`,
 * verified through the file sink's own level floor - the same mechanism
 * `logger_test.cpp`'s `LoggerLevelTest` uses), and that no route file still
 * hand-writes the line the centralised hook now owns (a source scan, since a
 * hand-written duplicate is invisible to any test that only checks the hook
 * fires - `server_bind_test.cpp`'s `EachCallProducesOneCentralRequestLogLine`
 * covers that half).
 */

#include <array>
#include <atomic>
#include <cctype>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "vayu/http/request_log.hpp"
#include "vayu/utils/logger.hpp"

#include "source_scan.hpp"

namespace {

using vayu::http::RequestLogLine;
using vayu::utils::Logger;

// ---------------------------------------------------------------------------
// Format: method, path, status, duration, response bytes - nothing else.
// ---------------------------------------------------------------------------

TEST (RequestLogFormatTest, MatchesTheDocumentedExampleExactly) {
    RequestLogLine line;
    line.method         = "GET";
    line.path           = "/inbox";
    line.status         = 200;
    line.duration_ms    = 1.3;
    line.response_bytes = 412;

    EXPECT_EQ (vayu::http::format_request_log_line (line), "GET /inbox 200 1.3ms 412B");
}

TEST (RequestLogFormatTest, RoundsDurationToOneDecimalPlace) {
    RequestLogLine line;
    line.method         = "POST";
    line.path           = "/runs";
    line.status         = 202;
    line.duration_ms    = 0.049; // rounds down to 0.0, not truncates to 0
    line.response_bytes = 0;

    EXPECT_EQ (vayu::http::format_request_log_line (line), "POST /runs 202 0.0ms 0B");
}

// ---------------------------------------------------------------------------
// Level: 2xx at DEBUG, 3xx/4xx at INFO, 5xx at WARNING - verified through the
// file sink's own configured floor, the way LoggerLevelTest does, since the
// level a line was logged at is otherwise unobservable from outside the
// singleton.
// ---------------------------------------------------------------------------

/// A log directory of its own, since `Logger` is a process-wide singleton -
/// `logger_test.cpp`'s `ScratchLogDir`, copied rather than shared across a
/// header neither file otherwise needs.
class ScratchLogDir {
    public:
    ScratchLogDir () {
        // The counter alone is not unique across processes: ctest runs each
        // test as its own invocation of this binary, so the two
        // `RequestLogLevelTest` cases below both start their counter at 0 and
        // would otherwise collide on the same path under parallel ctest -
        // exactly what happened on Windows before this hashed the test name
        // in too, the way `logger_test.cpp`'s `ScratchLogDir` already does.
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-request-log-level-test-" + std::to_string (counter.fetch_add (1)) + "-" +
        std::to_string (static_cast<unsigned long long> (std::hash<std::string>{}(
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ()))));
        std::filesystem::create_directories (path_);
    }
    ~ScratchLogDir () {
        std::error_code ignored;
        std::filesystem::remove_all (path_, ignored);
    }
    ScratchLogDir (const ScratchLogDir&)            = delete;
    ScratchLogDir& operator= (const ScratchLogDir&) = delete;
    ScratchLogDir (ScratchLogDir&&)                 = delete;
    ScratchLogDir& operator= (ScratchLogDir&&)      = delete;

    const std::filesystem::path& path () const {
        return path_;
    }

    private:
    std::filesystem::path path_;
};

std::string newest_log_contents (const std::filesystem::path& dir) {
    std::filesystem::path newest;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        const std::string name = entry.path ().filename ().string ();
        if (name.starts_with ("vayu_") && name.ends_with (".log") && entry.path () > newest) {
            newest = entry.path ();
        }
    }
    std::ifstream in (newest);
    std::stringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

RequestLogLine line_for (int status) {
    RequestLogLine line;
    line.method         = "GET";
    line.path           = "/test-" + std::to_string (status);
    line.status         = status;
    line.duration_ms    = 1.0;
    line.response_bytes = 10;
    return line;
}

// Between DEBUG and INFO: a 2xx line is filtered, a 4xx line is not - the
// distinction a file level of WARNING (used below) cannot make, since both
// would be filtered there regardless of which one the code actually chose.
TEST (RequestLogLevelTest, TwoXxIsDebugAndFourXxIsInfo) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.path ().string ());
    Logger::instance ().set_max_file_bytes (0);
    Logger::instance ().set_file_level (Logger::Level::INFO);

    vayu::http::log_request (line_for (200));
    vayu::http::log_request (line_for (404));
    Logger::instance ().flush ();

    const std::string written = newest_log_contents (dir.path ());
    EXPECT_EQ (written.find ("/test-200"), std::string::npos) << written;
    EXPECT_NE (written.find ("/test-404"), std::string::npos) << written;
}

// Between INFO and WARNING: a 4xx line is filtered, a 5xx line is not.
TEST (RequestLogLevelTest, FourXxIsInfoAndFiveXxIsWarning) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.path ().string ());
    Logger::instance ().set_max_file_bytes (0);
    Logger::instance ().set_file_level (Logger::Level::WARNING);

    vayu::http::log_request (line_for (404));
    vayu::http::log_request (line_for (500));
    Logger::instance ().flush ();

    const std::string written = newest_log_contents (dir.path ());
    EXPECT_EQ (written.find ("/test-404"), std::string::npos) << written;
    EXPECT_NE (written.find ("/test-500"), std::string::npos) << written;
}

// ---------------------------------------------------------------------------
// Source scan: no route file hand-writes the line the hook now owns.
// ---------------------------------------------------------------------------

constexpr std::array<std::string_view, 2> kLoggers = { "log_info", "log_debug" };
constexpr std::array<std::string_view, 5> kMethods = { "GET", "POST", "PUT",
    "DELETE", "PATCH" };

bool is_identifier_char (char c) {
    return (std::isalnum (static_cast<unsigned char> (c)) != 0) || c == '_';
}

/**
 * Every `log_info ("GET ...` / `log_debug ("POST ...` call in @p code - the
 * exact shape #1510 centralised away into `install_request_logger`. Bounded
 * like `source_scan.hpp`'s `names_call` so a longer name (`log_info_verbose`,
 * hypothetically) cannot false-match, and past any run of spaces so the
 * repository's clang-format ("space before the argument list") does not
 * defeat a literal search.
 */
std::vector<std::string> route_prefixed_calls (const std::string& code) {
    std::vector<std::string> offenders;
    for (const auto logger : kLoggers) {
        for (size_t at = code.find (logger); at != std::string::npos;
        at             = code.find (logger, at + 1)) {
            if (at > 0 && is_identifier_char (code[at - 1])) {
                continue; // part of a longer name
            }
            size_t after = at + logger.size ();
            if (after < code.size () && is_identifier_char (code[after])) {
                continue; // log_info_verbose, not log_info
            }
            while (after < code.size () && code[after] == ' ') {
                ++after;
            }
            if (after >= code.size () || code[after] != '(') {
                continue;
            }
            ++after;
            while (after < code.size () && code[after] == ' ') {
                ++after;
            }
            if (after >= code.size () || code[after] != '"') {
                continue;
            }
            ++after;
            for (const auto method : kMethods) {
                if (code.compare (after, method.size (), method) == 0) {
                    std::string offender (logger);
                    offender += " (\"";
                    offender += method;
                    offenders.push_back (std::move (offender));
                    break;
                }
            }
        }
    }
    return offenders;
}

TEST (RouteRequestLoggingScanTest, NoHandWrittenMethodPathLineRemains) {
    const std::filesystem::path routes_dir =
    std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src" / "http" / "routes";
    ASSERT_TRUE (std::filesystem::is_directory (routes_dir))
    << routes_dir.string () << " is not where the guard looks";

    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto& entry : std::filesystem::directory_iterator (routes_dir)) {
        const auto& path = entry.path ();
        if (!entry.is_regular_file () || path.extension () != ".cpp") {
            continue;
        }
        const std::string code =
        vayu::tests::strip_comments (vayu::tests::read_source (path));
        ASSERT_FALSE (code.empty ()) << path.filename ().string () << " read as empty";
        ++scanned_files;
        scanned_bytes += code.size ();

        for (const auto& call : route_prefixed_calls (code)) {
            offenders.push_back (path.filename ().string () + ": " + call);
        }
    }

    // A scan that read nothing passes forever, so it says what it read.
    ASSERT_GT (scanned_files, 20u) << "the guard found almost no route files";
    ASSERT_GT (scanned_bytes, 50'000u) << "the guard read empty sources";

    std::string joined;
    for (const auto& offender : offenders) {
        if (!joined.empty ()) {
            joined += "\n  ";
        }
        joined += offender;
    }
    EXPECT_TRUE (offenders.empty ())
    << "one request line per call now comes from install_request_logger "
       "(issue #1510) - a hand-written line duplicating method and path is "
       "dead weight, not a second source of truth. Offenders:\n  "
    << joined;
}

/**
 * The matcher still finds the shape it should (the planted positive) and
 * still ignores what merely looks like it: a longer function name, an
 * unrelated message, a warning line (out of this guard's scope - it carries
 * a status and an error the centralised line does not), and a comment.
 * Without this, an over-eager `strip_comments` or a broken boundary check
 * would leave the guard above passing on a tree that had brought every one
 * of the 48 original lines back.
 */
TEST (RouteRequestLoggingScanTest, TheGuardSeesTheShapeAndNotALongerNameOrAPlainMessage) {
    EXPECT_EQ (
    route_prefixed_calls (R"(vayu::utils::log_info ("GET /health - ok");)").size (), 1u);
    EXPECT_EQ (
    route_prefixed_calls (R"(vayu::utils::log_debug ("POST /runs - x");)").size (), 1u);

    EXPECT_TRUE (
    route_prefixed_calls (R"(vayu::utils::log_info ("Returning 3 items");)").empty ());
    EXPECT_TRUE (route_prefixed_calls (R"(vayu::utils::log_warning ("GET /health - refused");)")
    .empty ());
    EXPECT_TRUE (
    route_prefixed_calls (R"(vayu::utils::log_info_verbose ("GET /x");)").empty ());
    EXPECT_TRUE (
    route_prefixed_calls (vayu::tests::strip_comments (
                          "// vayu::utils::log_info (\"GET /never\");\n"))
    .empty ());
}

} // namespace
