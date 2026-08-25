/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/reentrant_test.cpp
 * @brief `vayu::utils::format_local_time`, `format_utc_time` and
 *        `errno_message` (issue #945), and the guard that keeps the calls they
 *        replaced out of `src`.
 *
 * Two halves, because the defect has two.
 *
 * The behavioural half is the one that reproduces: threads formatting
 * different instants at once each get their own answer. Against the code this
 * replaced - `std::put_time (std::localtime (&t), fmt)`, which formats out of
 * one `std::tm` the whole process shares - it fails within a few iterations,
 * and the engine writes a log line from every worker thread it has.
 *
 * The scanning half is for what a behavioural test cannot reach. `strerror`
 * shares a buffer only for the codes a platform has no message for, `getenv`
 * is unsafe only against a write that the engine happens never to make, and
 * `exit` in the force-shutdown signal handler needs a second Ctrl-C during a
 * live run to bite - so none reproduces here, and all three are still the
 * wrong call to reach for. What is testable is that `src` and `include` do not
 * name them, which is also what keeps the family at zero once the CI gate has
 * stopped looking at these lines (it scopes to a pull request's changed
 * lines). Reverting any one of the fixes fails the scan.
 */

#include <algorithm>
#include <array>
#include <cerrno>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/utils/reentrant.hpp"

namespace vayu::utils {
namespace {

constexpr const char* kStamp = "%Y-%m-%d %H:%M:%S";

/// A spread of instants a day apart, so two of them agree on no field.
std::vector<std::time_t> spread_of_instants (size_t count) {
    std::vector<std::time_t> instants;
    instants.reserve (count);
    for (size_t i = 0; i < count; ++i) {
        // 2001-09-09T01:46:40Z onwards, one day and one second apart.
        instants.push_back (static_cast<std::time_t> (1'000'000'000 + (i * 86'401)));
    }
    return instants;
}

TEST (FormatLocalTime, RendersTheInstantInTheLocalZone) {
    const std::time_t instant = 1'000'000'000;
    const std::string stamped = format_local_time (instant, kStamp);

    // Read back through std::get_time and std::mktime, which interprets the
    // broken-down fields as local time: the round trip only closes if the
    // rendering was local too. Nothing here re-derives the answer from the
    // call under test, which is what would make this tautological.
    std::tm parsed{};
    std::istringstream in (stamped);
    in >> std::get_time (&parsed, kStamp);
    ASSERT_FALSE (in.fail ()) << "did not render as " << kStamp << ": " << stamped;
    parsed.tm_isdst = -1;
    EXPECT_EQ (std::mktime (&parsed), instant) << stamped;
}

TEST (FormatLocalTime, DistinctInstantsRenderDistinctly) {
    const auto instants = spread_of_instants (4);
    std::vector<std::string> stamped;
    stamped.reserve (instants.size ());
    for (const std::time_t instant : instants) {
        stamped.push_back (format_local_time (instant, kStamp));
    }
    for (size_t i = 1; i < stamped.size (); ++i) {
        EXPECT_NE (stamped[i], stamped[0]) << stamped[i];
    }
}

TEST (FormatLocalTime, ConcurrentCallersEachGetTheirOwnInstant) {
    // The mutation check. With the shared-`std::tm` spelling this replaced,
    // one thread's fields are overwritten by another's between the lookup and
    // the format, and a stamp comes back describing the wrong instant.
    constexpr size_t kThreads    = 8;
    constexpr size_t kIterations = 400;

    const auto instants = spread_of_instants (kThreads);
    std::vector<std::string> expected;
    expected.reserve (kThreads);
    for (const std::time_t instant : instants) {
        expected.push_back (format_local_time (instant, kStamp));
    }

    std::vector<std::string> mismatches (kThreads);
    std::vector<std::thread> workers;
    workers.reserve (kThreads);
    for (size_t i = 0; i < kThreads; ++i) {
        workers.emplace_back ([&, i] {
            for (size_t iteration = 0; iteration < kIterations; ++iteration) {
                const std::string stamped = format_local_time (instants[i], kStamp);
                if (stamped != expected[i] && mismatches[i].empty ()) {
                    mismatches[i] = stamped;
                }
            }
        });
    }
    for (auto& worker : workers) {
        worker.join ();
    }

    for (size_t i = 0; i < kThreads; ++i) {
        EXPECT_TRUE (mismatches[i].empty ())
        << "thread " << i << " expected " << expected[i] << " and read "
        << mismatches[i];
    }
}

TEST (FormatLocalTime, AnUnrepresentableInstantRendersAsNothing) {
    // The zero-initialised std::tm formats as a confident 1899-12-31, so a
    // conversion that failed has to come back empty rather than plausible.
    // 64-bit time_t reaches years the zone tables do not cover; a platform that
    // does convert this one is not wrong, so the assertion is that whichever
    // happens, the answer is honest.
    constexpr std::time_t far_future = std::numeric_limits<std::time_t>::max ();
    const std::string stamped        = format_local_time (far_future, kStamp);
    if (!stamped.empty ()) {
        EXPECT_NE (stamped.rfind ("1899", 0), 0u) << stamped;
        EXPECT_NE (stamped.rfind ("1900", 0), 0u) << stamped;
    }
}

TEST (FormatUtcTime, RendersTheInstantInUtcAndNotTheLocalZone) {
    // 2001-09-09T01:46:40Z - the epoch second every calendar agrees on, and one
    // whose fields are all distinct, so a formatter reading the wrong ones
    // could not pass by coincidence. Spelled in full rather than through
    // `%F`/`%T`, since those are what the caller does not use.
    constexpr std::time_t instant = 1'000'000'000;
    EXPECT_EQ (format_utc_time (instant, "%Y-%m-%dT%H:%M:%S"), "2001-09-09T01:46:40");

    // The two functions differ by the zone, which is the whole reason there are
    // two. `TZ` is not set here, so on a UTC test host they agree - the
    // assertion is on the pair being the same *shape*, which is what a caller
    // swapping one for the other would break.
    const std::string local = format_local_time (instant, "%Y-%m-%dT%H:%M:%S");
    ASSERT_FALSE (local.empty ());
    EXPECT_EQ (local.size (), std::string ("2001-09-09T01:46:40").size ());
}

TEST (FormatUtcTime, AnUnrepresentableInstantRendersAsNothing) {
    // The epoch converts on every platform, which is what stops the second half
    // being vacuous.
    EXPECT_EQ (format_utc_time (0, "%Y"), "1970");

    // `time_t::max()` is out of range wherever `time_t` is 64-bit and the
    // broken-down year is an `int`, and a platform that converts it anyway is
    // not wrong - so what is asserted is that whichever happens, the answer is
    // honest. A formatter that ignored the conversion's verdict would render
    // the zero-initialised 1900 as a fact; this one renders nothing at all.
    // glibc makes that worth checking rather than obvious: it fills the fields
    // before discovering the overflow, so there is no untouched state to detect
    // afterwards - the return is the only thing carrying the verdict.
    const std::string extreme =
    format_utc_time (std::numeric_limits<std::time_t>::max (), "%Y");
    if (!extreme.empty ()) {
        EXPECT_NE (extreme, "1900") << extreme;
    }
}

TEST (ErrnoMessage, NamesTheCodeItIsGiven) {
    const std::string missing = errno_message (ENOENT);
    const std::string denied  = errno_message (EACCES);

    EXPECT_FALSE (missing.empty ());
    EXPECT_FALSE (denied.empty ());
    // Two codes, two messages: the wrapper looks the code up rather than
    // answering with one string, which a `return {}` would also pass without.
    EXPECT_NE (missing, denied);
}

TEST (ErrnoMessage, AnswersForACodeNoPlatformHasAMessageFor) {
    // The form-part validator hands over whatever `fopen` set, so a code this
    // platform does not know must still read as something rather than as an
    // empty parenthesis in a user-facing error.
    EXPECT_FALSE (errno_message (98'765).empty ());
}

/// Every C call `concurrency-mt-unsafe` reports that this engine makes or has
/// made. The environment writers are here even though `src` has never had one:
/// a `setenv` anywhere in the engine is what would make the one exempted
/// `getenv` below unsafe, so the guard is what keeps its reason true.
/// `exit` earns its place for a second reason: `daemon.cpp`'s force-shutdown
/// branch runs inside a signal handler, where `exit` runs every static
/// destructor while the worker threads are still using what they destroy.
/// `_Exit` is the spelling that stops now, and does not match this name.
constexpr std::array<std::string_view, 10> kUnsafeCalls = { "localtime", "strerror",
    "getenv", "setenv", "putenv", "gmtime", "asctime", "ctime", "rand", "exit" };

/// One file, one call: `cert-err58-cpp` is why these are `constexpr` arrays of
/// views rather than the `std::vector<std::string>` they read more naturally
/// as - a namespace-scope container with a throwing constructor is a finding of
/// this same paydown.
struct ExemptSite {
    std::string_view file;
    std::string_view call;
};

/// The single site where one of them stays, silenced at the line with its
/// reason: reading `CURL_CA_BUNDLE` has no reentrant spelling to move to. Per
/// (file, call) rather than per file, so exempting the read does not also
/// exempt a write nobody noticed being added beside it.
constexpr std::array<ExemptSite, 1> kExempt = {
    { { "src/http/transport_policy.cpp", "getenv" } }
};

bool is_exempt (std::string_view file, std::string_view call) {
    return std::any_of (kExempt.begin (), kExempt.end (), [&] (const ExemptSite& site) {
        return site.file == file && site.call == call;
    });
}

TEST (MtUnsafeCalls, TheEngineSourcesDoNotNameThem) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    size_t scanned_files = 0;
    size_t scanned_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto* directory : { "src", "include" }) {
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

            const std::string code = tests::strip_comments (tests::read_source (path));
            ASSERT_FALSE (code.empty ()) << relative << " read as empty";
            ++scanned_files;
            scanned_bytes += code.size ();

            for (const std::string_view call : kUnsafeCalls) {
                if (is_exempt (relative, call) || !tests::names_call (code, call)) {
                    continue;
                }
                std::string offender = relative;
                offender += " calls ";
                offender += call;
                offenders.push_back (std::move (offender));
            }
        }
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
    << "these calls answer out of storage the whole process shares, so under "
       "load one thread reads another's timestamp or error message. Use "
       "vayu/utils/reentrant.hpp, or silence the check at the site with the "
       "reason and add the file to kExempt. Offenders:\n  "
    << joined;
}

/**
 * The matcher still finds a call it should (the planted positive), and still
 * ignores the longer names that contain these ones. Without this, an
 * over-eager `strip_comments` or a broken boundary check would leave the guard
 * above passing on a tree that had brought every one of them back.
 */
TEST (MtUnsafeCalls, TheGuardSeesACallAndNotALongerName) {
    EXPECT_TRUE (tests::names_call ("auto* t = std::localtime (&now);", "localtime"));
    EXPECT_TRUE (tests::names_call ("message = strerror(code);", "strerror"));

    EXPECT_FALSE (tests::names_call ("localtime_r (&now, &out);", "localtime"));
    EXPECT_FALSE (tests::names_call ("curl_easy_strerror (result)", "strerror"));
    EXPECT_FALSE (tests::names_call ("int localtime = 0;", "localtime"));

    // And the stripper really does blank prose, which is the whole reason the
    // exemption list is as short as it is.
    EXPECT_FALSE (tests::names_call (
    tests::strip_comments ("// never call std::localtime (&t) here\n"), "localtime"));
    EXPECT_TRUE (tests::names_call (
    tests::strip_comments ("/* see below */ std::localtime (&t);\n"), "localtime"));
}

} // namespace
} // namespace vayu::utils
