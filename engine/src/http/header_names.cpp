/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/header_names.hpp"

#include "vayu/http/default_headers.hpp"

namespace vayu::http {

std::optional<HeaderNameCollision> record_produced_name (HeaderNameOrigins& origins,
const std::string& produced,
const std::string& written) {
    const auto [taken, was_free] = origins.emplace (produced, written);
    if (was_free || CaseInsensitiveLess::equal (taken->second, written)) {
        return std::nullopt;
    }
    return HeaderNameCollision{ written, taken->second, taken->first };
}

std::string describe_header_name_collision (const HeaderNameCollision& collision) {
    return "header \"" + collision.written + "\" and header \"" +
    collision.other + "\" resolve to one name (\"" + collision.produced +
    "\", compared without case)"
    " - the request would carry that header twice where its rows show two"
    " different names, so it is refused rather than sent as nobody wrote it";
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

std::string_view trim_optional_whitespace (std::string_view text) {
    const auto first = text.find_first_not_of (OPTIONAL_WHITESPACE);
    if (first == std::string_view::npos) {
        return {};
    }
    return text.substr (first, text.find_last_not_of (OPTIONAL_WHITESPACE) - first + 1);
}

std::optional<std::string> invalid_header_name_refusal (std::string_view name) {
    // `{` is not a token character, but a name still holding a `{{token}}` is
    // one nothing answered, and an unanswered token is sent as written (issue
    // #1009), not refused.
    if (name.find ("{{") != std::string_view::npos) {
        return std::nullopt;
    }
    const auto reason = invalid_header_token (name);
    if (!reason) {
        return std::nullopt;
    }
    return "header " + *reason +
    " - spaces and tabs around a name are trimmed, but a name with anything "
    "else"
    " in it is refused rather than rewritten into a header nobody wrote";
}

} // namespace vayu::http
