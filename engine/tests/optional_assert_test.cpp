/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/optional_assert_test.cpp
 * @brief What `ASSERT_HAS_VALUE` promises a test that uses it (issue #980).
 *
 * The property that made the macro necessary - that
 * `bugprone-unchecked-optional-access` accepts the guard it writes - is a lint
 * result and cannot be asserted from inside the suite; `optional_assert.hpp`
 * records how it was measured. What a running test *can* pin is the half a
 * caller depends on: that an empty optional stops the test body fatally, that
 * the failure names the expression it was given, and that a caller's own
 * message survives. Those are what a future rewrite of the macro would break
 * silently.
 */

#include <optional>
#include <string>

#include <gtest/gtest-spi.h>
#include <gtest/gtest.h>

#include "optional_assert.hpp"

namespace {

// Free functions rather than locals: `EXPECT_FATAL_FAILURE` runs its statement
// in a class of its own, which cannot reach the enclosing test body's variables.

std::optional<std::string> empty_row () {
    return std::nullopt;
}

std::optional<std::string> filled_row () {
    return std::string ("row");
}

} // namespace

TEST (OptionalAssert, LetsTheTestReadTheValueItAsserted) {
    const std::optional<std::string> row = filled_row ();
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (*row, "row");
}

TEST (OptionalAssert, AnEmptyOptionalIsAFatalFailureNamingTheExpression) {
    EXPECT_FATAL_FAILURE (
    ASSERT_HAS_VALUE (empty_row ()), "expected empty_row () to hold a value");
}

TEST (OptionalAssert, TheCallersOwnMessageReachesTheFailure) {
    EXPECT_FATAL_FAILURE (
    ASSERT_HAS_VALUE (empty_row ()) << "after the second write", "after the second write");
}

TEST (OptionalAssert, AnEngagedOptionalRaisesNothing) {
    EXPECT_NONFATAL_FAILURE (
    {
        ASSERT_HAS_VALUE (filled_row ());
        ADD_FAILURE () << "the body continued";
    },
    "the body continued");
}
