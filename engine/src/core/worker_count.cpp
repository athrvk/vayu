/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/worker_count.hpp"

#include <thread>

namespace vayu::core {

int resolve_worker_count (vayu::db::Database& db) {
    int configured = db.get_config_int ("workers", 0); // 0 = auto-detect
    return configured != 0 ? configured :
                             static_cast<int> (std::thread::hardware_concurrency ());
}

} // namespace vayu::core
