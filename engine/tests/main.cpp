/**
 * @file tests/main.cpp
 * @brief Google Test main entry point
 */

#include <filesystem>
#include <system_error>

#include <gtest/gtest.h>

#include "temp_database.hpp"
#include "vayu/http/client.hpp"

int main (int argc, char** argv) {
    // Initialize curl globally for all tests
    vayu::http::global_init ();

    testing::InitGoogleTest (&argc, argv);

    // Give this process a private working directory so the relative `test_*.db`
    // paths fixtures open resolve somewhere no sibling process shares - what
    // makes `ctest -j` safe. See temp_database.hpp for why per-process is
    // per-test here.
    //
    // Isolating is the default, so a hand-run `ctest -j` is safe wherever it
    // happens; `VAYU_TEST_NO_SCRATCH_ISOLATION` opts out, and the Windows test
    // presets set it because they run serially. Measured on CI, the Windows
    // ctest leg goes from ~6 min serial to over 30 min at `-j4` - the tests
    // that open a database each pay seconds, the ones that do not are
    // untouched - while the same `-j4` cuts ubuntu from 3-5 min to 1m12s and
    // macOS from ~4 min to 1m50s.
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
