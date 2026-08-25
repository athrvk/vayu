/**
 * @file tests/main.cpp
 * @brief Google Test main entry point
 */

#include <exception>
#include <filesystem>
#include <iostream>
#include <system_error>

#include <gtest/gtest.h>

#include "temp_database.hpp"
#include "vayu/http/client.hpp"

namespace {

/// The suite plus the scratch-directory bracket around it, so that `main` below
/// is a catch and nothing else. gtest already catches what a *test* throws; what
/// reaches here is the setup around them - `global_init`, or
/// `enter_process_scratch_dir` on a full disk - and an escape from `main` ends
/// the process through `std::terminate`, which ctest reports as a crash with no
/// reason attached rather than as a run that failed and said why.
int run_all_tests (int argc, char** argv) {
    // Initialize curl globally for all tests
    vayu::http::global_init ();

    testing::InitGoogleTest (&argc, argv);

    // Give this process a private working directory so the relative `test_*.db`
    // paths fixtures open resolve somewhere no sibling process shares - what
    // makes `ctest -j` safe. See temp_database.hpp for why per-process is
    // per-test here.
    //
    // Isolating is the default, so a hand-run `ctest -j` is safe wherever it
    // happens; `VAYU_TEST_NO_SCRATCH_ISOLATION` opts out and no preset sets it.
    // Windows presets used to, because they ran serially: a plain `-j4` there
    // measured over 30 min against a ~6 min serial run, where the same `-j4`
    // cut ubuntu from 3-5 min to 1m12s. What costs on Windows is concurrent
    // SQLite commits, not the directories, so the database tests now share a
    // CTest RESOURCE_LOCK there and the rest of the suite runs `-j4` beside
    // them (#805 phase 5, `engine/CMakeLists.txt`).
    const bool isolate = !vayu::tests::scratch_isolation_disabled ();
    const std::filesystem::path scratch =
    isolate ? vayu::tests::enter_process_scratch_dir () : std::filesystem::path{};

    const int result = RUN_ALL_TESTS ();

    // Leave nothing behind: fixtures remove their database files in teardown, so
    // this normally clears an empty directory; remove_all also covers a test
    // that failed before its own cleanup ran. Step out of it first - a directory
    // cannot be removed while it is the working directory on every platform.
    if (isolate) {
        std::error_code ec;
        std::filesystem::current_path (scratch.parent_path (), ec);
        std::filesystem::remove_all (scratch, ec);
    }

    vayu::http::global_cleanup ();

    return result;
}

} // namespace

int main (int argc, char** argv) {
    try {
        return run_all_tests (argc, argv);
    } catch (const std::exception& e) {
        std::cerr << "vayu_tests: " << e.what () << "\n";
        return 1;
    } catch (...) {
        std::cerr << "vayu_tests: unknown error\n";
        return 1;
    }
}
