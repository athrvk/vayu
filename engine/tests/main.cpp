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
    const std::filesystem::path scratch = vayu::tests::enter_process_scratch_dir ();

    const int result = RUN_ALL_TESTS ();

    // Leave nothing behind: fixtures remove their database files in teardown, so
    // this normally clears an empty directory; remove_all also covers a test
    // that failed before its own cleanup ran. Step out of it first - a directory
    // cannot be removed while it is the working directory on every platform.
    std::error_code ec;
    std::filesystem::current_path (scratch.parent_path (), ec);
    std::filesystem::remove_all (scratch, ec);

    vayu::http::global_cleanup ();

    return result;
}
