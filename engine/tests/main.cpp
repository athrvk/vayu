/**
 * @file tests/main.cpp
 * @brief Google Test main entry point
 */

#include <gtest/gtest.h>
#include "vayu/http/client.hpp"

int main(int argc, char **argv)
{
    // Initialize curl globally for all tests
    vayu::http::global_init();

    testing::InitGoogleTest(&argc, argv);
    int result = RUN_ALL_TESTS();

    vayu::http::global_cleanup();

    return result;
}
