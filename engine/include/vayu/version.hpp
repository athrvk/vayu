#pragma once

/**
 * @file version.hpp
 * @brief Vayu Engine version information
 */

#define VAYU_VERSION_MAJOR 0
#define VAYU_VERSION_MINOR 1
#define VAYU_VERSION_PATCH 0

#define VAYU_VERSION_STRING "0.1.0"

namespace vayu {

struct Version {
    static constexpr int major = VAYU_VERSION_MAJOR;
    static constexpr int minor = VAYU_VERSION_MINOR;
    static constexpr int patch = VAYU_VERSION_PATCH;
    static constexpr const char* string = VAYU_VERSION_STRING;
};

}  // namespace vayu
