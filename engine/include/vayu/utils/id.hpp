#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>

namespace vayu::utils {

/**
 * @brief Generate a collision-resistant record ID: prefix + a random UUIDv4.
 *
 * The suffix is a canonical RFC 4122 version-4 UUID - lowercase 8-4-4-4-12 hex
 * with the version (4) and variant (10xx) bits set - drawn from a thread_local
 * std::mt19937_64. Random rather than time-based: two creations in the same
 * millisecond would share a prefix + now_ms() ID and, because persistence
 * upserts (storage.replace()), the second would silently merge into the first
 * with no error. A random UUID makes that collision effectively impossible and
 * makes engine IDs byte-shape-identical to the app import path's prefix +
 * crypto.randomUUID() IDs.
 *
 * @param prefix Preserved verbatim (e.g. "run_", "col_"); "" yields a bare
 *        UUID.
 */
std::string generate_id (const char* prefix);

} // namespace vayu::utils
