#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file version.hpp
 * @brief Vayu Engine version information
 */

// Macros, not an enum: build.py's version bump rewrites these exact
// `#define` lines by regex, and VAYU_VERSION_STRING must stay a macro for
// the string literal pasting in user_agent.cpp - the parts stay in the same
// spelling beside it.
// NOLINTBEGIN(modernize-macro-to-enum)
#define VAYU_VERSION_MAJOR 0
#define VAYU_VERSION_MINOR 26
#define VAYU_VERSION_PATCH 0
// NOLINTEND(modernize-macro-to-enum)

#define VAYU_VERSION_STRING "0.26.0"

namespace vayu {

struct Version {
    static constexpr int major          = VAYU_VERSION_MAJOR;
    static constexpr int minor          = VAYU_VERSION_MINOR;
    static constexpr int patch          = VAYU_VERSION_PATCH;
    static constexpr const char* string = VAYU_VERSION_STRING;
};

} // namespace vayu
