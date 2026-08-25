/**
 * @file tests/invariant_test.cpp
 * @brief `vayu::utils::invariant_value` (issue #943) - reading an optional whose
 *        engagement a rule in another function guarantees.
 *
 * The two behaviours worth locking are the two reasons it exists: an engaged
 * optional is read without a copy the caller did not ask for, and a broken rule
 * throws *naming the rule* rather than reading an empty optional. A message
 * that did not carry the invariant would leave whoever hits it with a stack
 * trace and no rule to go and check.
 */

#include <gtest/gtest.h>

#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

#include "vayu/utils/invariant.hpp"

namespace vayu::utils {
namespace {

TEST (InvariantValue, ReadsAnEngagedOptionalInPlace) {
    const std::optional<std::string> value = "kept";
    const std::string& read = invariant_value (value, "always set by its producer");
    EXPECT_EQ (read, "kept");
    // A reference to the stored string, not a copy of it: the callers read
    // rows and route tables, and a copy per read would be silent cost.
    EXPECT_EQ (&read, &*value);
}

TEST (InvariantValue, MovesOutOfATemporaryRatherThanDanglingIntoIt) {
    // The lookup-return shape: the optional dies at the end of the full
    // expression, so this overload has to hand back a value.
    std::string moved = invariant_value (
    std::optional<std::string> ("from a lookup"), "the row a validated id names");
    EXPECT_EQ (moved, "from a lookup");
}

TEST (InvariantValue, ABrokenInvariantThrowsNamingTheRule) {
    const std::optional<int> empty;
    try {
        (void)invariant_value (empty, "a decided run carries its summary");
        FAIL () << "an empty optional must not read as a value";
    } catch (const std::logic_error& e) {
        // The rule itself, not just "bad optional access" - the message is the
        // whole reason this is a helper rather than a `.value()` call.
        EXPECT_NE (
        std::string (e.what ()).find ("a decided run carries its summary"), std::string::npos)
        << e.what ();
    }

    EXPECT_THROW ((void)invariant_value (std::optional<int> (), "the same, on a temporary"),
    std::logic_error);
}

} // namespace
} // namespace vayu::utils
