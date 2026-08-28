/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/header_names.hpp"

namespace vayu::http {

std::string describe_header_name_collision (const HeaderNameCollision& collision) {
    return "header \"" + collision.written + "\" and header \"" +
    collision.other + "\" resolve to one name (\"" + collision.produced +
    "\", compared without case)"
    " - one of the two would be dropped, so the request is refused rather than"
    " sent with a header missing";
}

} // namespace vayu::http
