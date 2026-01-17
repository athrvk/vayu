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

#define VAYU_VERSION_MAJOR 0
#define VAYU_VERSION_MINOR 1
#define VAYU_VERSION_PATCH 1

#define VAYU_VERSION_STRING "0.1.1"

namespace vayu {

struct Version {
    static constexpr int major = VAYU_VERSION_MAJOR;
    static constexpr int minor = VAYU_VERSION_MINOR;
    static constexpr int patch = VAYU_VERSION_PATCH;
    static constexpr const char* string = VAYU_VERSION_STRING;
};

}  // namespace vayu
