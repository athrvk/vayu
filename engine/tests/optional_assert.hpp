#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/optional_assert.hpp
 * @brief `ASSERT_HAS_VALUE` - the engaged-optional assertion that
 *        `bugprone-unchecked-optional-access` can follow (issue #980).
 *
 * `ASSERT_TRUE (opt.has_value ())` guards the reads after it perfectly well at
 * run time: the macro returns from the test body when it fails, so nothing
 * below it executes on an empty optional. The check cannot see that. gtest
 * routes the condition through an `::testing::AssertionResult`, and the
 * dataflow model behind the check follows `has_value ()` only into a branch
 * condition - so every read guarded that way is reported as unchecked, which
 * is where 561 of `engine/tests`' findings came from (#980).
 *
 * The three spellings that look like they would fix it do not. Measured on
 * clang-tidy 19.1.1 - the version floor `engine/.clang-tidy` sets - each of
 * `ASSERT_TRUE (opt.has_value ()) << "why"`, `ASSERT_NE (opt, std::nullopt)`
 * and `.value ()` still reports the read below it. (`.value ()` throws rather
 * than reading an empty optional, so it is not *unsafe*; it is simply not a
 * guard the check accepts, and `utils/invariant.hpp` says the same.)
 *
 * What the model does follow is a plain `if` whose failing branch cannot fall
 * through - which `FAIL ()` is, because it expands to a `return`. This macro
 * is that `if`, written once so a test body stays one line per assertion. The
 * guard stays gtest's: the failure is reported at the call site, names the
 * expression, and stops the test body the way a fatal assertion must.
 *
 * Reach for it wherever a test reads an optional it has just asserted engaged.
 * It is not a way past the check. An optional the code under test may
 * legitimately leave empty is still *tested* - `EXPECT_FALSE (opt.has_value
 * ())`, or an `if` over both outcomes - and a read with no guard at all is the
 * defect the check exists to find, not a site for this.
 */

#include <gtest/gtest.h>

/**
 * @brief Fail the current test unless @p optional_expression holds a value,
 *        and leave the reads after it visible to the optional check as guarded.
 *
 * Streams like any gtest assertion:
 * `ASSERT_HAS_VALUE (row) << "after the second write";`.
 *
 * @p optional_expression is evaluated once, so the guarded reads below must
 * name the same expression - and, per `engine/CLAUDE.md`, should name a
 * *binding* rather than re-derive a subscript or a call, since two spellings of
 * one value are two expressions to the check and to the next reader alike.
 *
 * `GTEST_AMBIGUOUS_ELSE_BLOCKER_` is gtest's own guard against
 * `if (x) ASSERT_HAS_VALUE (o); else ...` binding that `else` to this macro's
 * `if`; it is used here rather than copied so this assertion keeps whatever
 * gtest's does. The empty then-branch is `{}` rather than gtest's `;` because
 * `bugprone-suspicious-semicolon` reads the latter as a mistake.
 */
#define ASSERT_HAS_VALUE(optional_expression) \
    GTEST_AMBIGUOUS_ELSE_BLOCKER_             \
    if ((optional_expression).has_value ()) { \
    } else                                    \
        FAIL () << "expected " #optional_expression " to hold a value. "
