#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"

namespace vayu::core {

/**
 * The `workers` setting's effective value: the configured count when it is
 * non-zero, otherwise the detected core count - the same auto-detect rule
 * `execute_load_test` resolves independently for the event loop. `/health`
 * calls this so it reports what a run would actually use rather than the
 * unconditional core count it used to.
 */
int resolve_worker_count (vayu::db::Database& db);

} // namespace vayu::core
