#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/verbosity_restorer.hpp
 * @brief Puts the console verbosity back, so a test that raises it cannot
 *        leak the level into the next one.
 */

#include "vayu/utils/logger.hpp"

namespace vayu::tests {

class VerbosityRestorer {
    public:
    VerbosityRestorer ()
    : saved_ (vayu::utils::Logger::instance ().get_verbosity ()) {
    }
    ~VerbosityRestorer () {
        vayu::utils::Logger::instance ().set_verbosity (saved_);
    }
    VerbosityRestorer (const VerbosityRestorer&)            = delete;
    VerbosityRestorer& operator= (const VerbosityRestorer&) = delete;
    VerbosityRestorer (VerbosityRestorer&&)                 = delete;
    VerbosityRestorer& operator= (VerbosityRestorer&&)      = delete;

    private:
    int saved_;
};

} // namespace vayu::tests
