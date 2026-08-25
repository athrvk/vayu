/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The version string stays out of the widely-included headers (issue #659).
 *
 * `DEFAULT_USER_AGENT` was `"Vayu/" VAYU_VERSION_STRING` in
 * `core/constants.hpp`, which `types.hpp`, `utils/logger.hpp`, `utils/json.hpp`
 * and `http/client.hpp` all include - so a release bump changed a header in
 * every TU's preprocessed input and every release rebuilt the engine from
 * scratch on all three platforms. sccache could not hit by construction.
 *
 * No behavioural test can see that: the wrong version *works*, it just costs a
 * full rebuild once per release, which nobody attributes to a header. So it is
 * scanned for, and the scan asserts it read something first - a guard reading an
 * empty string passes forever (`CapacityControllerTest` has the same shape).
 *
 * The rule is narrow on purpose: `vayu/version.hpp` may be included by a `.cpp`
 * freely, and by a header only where that header is not itself broadly
 * included. What is forbidden is the transitive hub - `constants.hpp` - naming
 * the version at all.
 */

#include <array>
#include <filesystem>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/core/user_agent.hpp"

namespace {

using vayu::tests::read_source;
using vayu::tests::strip_comments;

/// The headers a version bump must not reach, because nearly every TU does.
/// `constexpr`, so the list is the compiler's and not something built before
/// `main` where an allocation failure cannot be caught (`cert-err58-cpp`).
constexpr std::array<const char*, 6> kHubHeaders = {
    "include/vayu/core/constants.hpp",
    "include/vayu/core/user_agent.hpp",
    "include/vayu/types.hpp",
    "include/vayu/utils/logger.hpp",
    "include/vayu/utils/json.hpp",
    "include/vayu/http/client.hpp",
};

TEST (VersionIsolationTest, TheHubHeadersDoNotNameTheVersion) {
    const std::filesystem::path root{ VAYU_ENGINE_SOURCE_DIR };
    size_t total_bytes = 0;
    std::vector<std::string> offenders;

    for (const auto& relative : kHubHeaders) {
        const auto path = root / relative;
        ASSERT_TRUE (std::filesystem::exists (path))
        << relative << " is not where the guard looks";
        const std::string source = strip_comments (read_source (path));
        ASSERT_FALSE (source.empty ()) << relative << " read as empty";
        total_bytes += source.size ();

        // The include and the macro are separate mistakes with the same cost,
        // so both are named. `VAYU_VERSION` catches the string, the parts and
        // the `Version` struct's initialisers alike.
        if (source.find ("vayu/version.hpp") != std::string::npos ||
        source.find ("VAYU_VERSION") != std::string::npos) {
            offenders.emplace_back (relative);
        }
    }

    ASSERT_GT (total_bytes, 1000u) << "the scan read empty files";
    EXPECT_TRUE (offenders.empty ())
    << "these headers are included by essentially every TU, so naming the "
       "version in them makes a release bump rebuild the whole engine; put the "
       "version-derived value behind a declaration the way "
       "core/user_agent.hpp does. Offenders: "
    << [&] {
           std::string joined;
           for (const auto& name : offenders) {
               joined += (joined.empty () ? "" : ", ") + name;
           }
           return joined;
       }();
}

/**
 * The comment-stripper must not have blinded the scan (the mutation check, as a
 * test): a header that really names the version is still caught, and one that
 * only discusses it is not.
 *
 * Without this, blanking the whole file would pass `TheHubHeadersDoNotNameTheVersion`
 * forever - the same shape as the empty-scan defect the assertions above guard.
 */
TEST (VersionIsolationTest, TheGuardStillSeesTheVersionInCode) {
    const std::string offending =
    "// we deliberately do not use VAYU_VERSION_STRING here\n"
    "#include \"vayu/version.hpp\"\n"
    "const char* a = \"Vayu/\" VAYU_VERSION_STRING;\n";
    const std::string stripped = strip_comments (offending);
    EXPECT_NE (stripped.find ("vayu/version.hpp"), std::string::npos);
    EXPECT_NE (stripped.find ("VAYU_VERSION_STRING"), std::string::npos);

    const std::string prose_only = "/* explains why VAYU_VERSION_STRING and\n"
                                   "   \"vayu/version.hpp\" are absent */\n"
                                   "constexpr int PORT = 9876;\n";
    const std::string prose_stripped = strip_comments (prose_only);
    EXPECT_EQ (prose_stripped.find ("VAYU_VERSION"), std::string::npos);
    EXPECT_EQ (prose_stripped.find ("vayu/version.hpp"), std::string::npos);
    // The code around the comment survives, so the stripper is not just
    // returning an empty string.
    EXPECT_NE (prose_stripped.find ("PORT = 9876"), std::string::npos);
}

/// The declaration is only worth anything if the definition still arrives.
TEST (VersionIsolationTest, TheDefaultUserAgentStillCarriesTheVersion) {
    const std::string agent{ vayu::core::constants::defaults::DEFAULT_USER_AGENT };
    EXPECT_EQ (agent.rfind ("Vayu/", 0), 0u) << "unexpected User-Agent: " << agent;
    EXPECT_GT (agent.size (), std::string ("Vayu/").size ())
    << "the version half of the User-Agent is empty: " << agent;
}

} // namespace
