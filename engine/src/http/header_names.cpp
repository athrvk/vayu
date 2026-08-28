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

std::string describe_empty_header_name (const std::string& written) {
    // A name that arrives already empty has no spelling to quote back, and
    // `header "" resolves to an empty name` reads as a resolution that did not
    // happen. Only the subject changes: the rest is the rule, word for word,
    // which is the whole reason every layer reads it from here.
    const std::string subject = written.empty () ?
    std::string ("a header carries no name at all") :
    "header \"" + written + "\" resolves to an empty name";
    return subject +
    " - what would go out is a \": value\" line no name owns, so the request is"
    " refused rather than sent carrying a header the author cannot see";
}

} // namespace vayu::http
