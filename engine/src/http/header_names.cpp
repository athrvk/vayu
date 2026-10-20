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

namespace {

/// The length of the `{{token}}` that starts @p text, or 0 when none does. The
/// same shape as `token_pattern` in `request_composer.cpp`: one or more
/// characters that are not braces, between `{{` and `}}`.
std::size_t token_span_length (std::string_view text) {
    constexpr std::string_view OPEN  = "{{";
    constexpr std::string_view CLOSE = "}}";
    if (!text.starts_with (OPEN)) {
        return 0;
    }
    const auto inner_end = text.find_first_of ("{}", OPEN.size ());
    if (inner_end == OPEN.size () || inner_end == std::string_view::npos ||
    !text.substr (inner_end).starts_with (CLOSE)) {
        return 0;
    }
    return inner_end + CLOSE.size ();
}

/// @p name with each `{{token}}` standing in as one token character, so what
/// is left to judge is the text the author wrote around the variables.
std::string with_tokens_as_placeholders (std::string_view name) {
    std::string out;
    out.reserve (name.size ());
    for (std::size_t at = 0; at < name.size ();) {
        const auto span = token_span_length (name.substr (at));
        out += span == 0 ? name[at] : 'x';
        at += span == 0 ? 1 : span;
    }
    return out;
}

} // namespace

std::optional<std::string> invalid_header_name_refusal (std::string_view name) {
    // A `{{token}}` nothing has answered is sent as written (issue #1009), so
    // it is not what is judged: the text around it is. A `{{` that closes no
    // token is ordinary text, and `{` is not a token character.
    const auto reason = invalid_header_token (with_tokens_as_placeholders (name), name);
    if (!reason) {
        return std::nullopt;
    }
    return "header " + *reason +
    " - spaces and tabs around a name are trimmed, but a name with anything "
    "else"
    " in it is refused rather than rewritten into a header nobody wrote";
}

} // namespace vayu::http
