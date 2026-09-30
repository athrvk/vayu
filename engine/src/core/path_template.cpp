/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/path_template.hpp"

#include "vayu/utils/ascii_case.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <string_view>

namespace vayu::core {

namespace {

/// The characters the app's `SIMPLE_VAR` accepts inside `{{ }}` (`[\w.$-]`).
bool is_simple_var_char (char ch) {
    const auto c = static_cast<unsigned char> (ch);
    return std::isalnum (c) != 0 || ch == '_' || ch == '.' || ch == '$' || ch == '-';
}

/// The characters the app's `PATH_TEMPLATE` accepts inside `{ }` (`[\w$-]`) -
/// no dot, deliberately: `{a.b}` is not a path parameter in OpenAPI.
bool is_path_template_char (char ch) {
    const auto c = static_cast<unsigned char> (ch);
    return std::isalnum (c) != 0 || ch == '_' || ch == '$' || ch == '-';
}

std::string trimmed (std::string_view value) {
    const auto begin = value.find_first_not_of (" \t");
    if (begin == std::string_view::npos) {
        return {};
    }
    const auto end = value.find_last_not_of (" \t");
    return std::string (value.substr (begin, end - begin + 1));
}

} // namespace

namespace {

/**
 * Both spellings, in one pass, with @p path_templates deciding whether a
 * single brace is one of them.
 *
 * The renderer runs two sequential regex passes and only the second is
 * conditional; a single pass produces the same answer because the `{{` branch
 * is tried first, so a `{{x}}` this pass wrote is never re-read as a `{x}`.
 */
/**
 * A `{{name}}` at @p i, rewritten to its bare form.
 *
 * @return where the pass continues, or nothing when this is not a variable -
 *         in which case the caller copies the braces through unchanged.
 */
std::optional<std::size_t>
read_double_brace (const std::string& path, std::size_t i, std::string& out) {
    const auto close = path.find ("}}", i + 2);
    if (close == std::string::npos) {
        return std::nullopt;
    }
    const std::string name =
    trimmed (std::string_view (path).substr (i + 2, close - i - 2));
    if (name.empty () || !std::all_of (name.begin (), name.end (), is_simple_var_char)) {
        return std::nullopt;
    }
    // `_.x` is Insomnia's spelling of the same variable.
    const std::string bare = name.rfind ("_.", 0) == 0 ? name.substr (2) : name;
    out += "{{" + bare + "}}";
    return close + 2;
}

/**
 * A single-brace `{name}` path template at @p i, rewritten as `{{name}}`.
 *
 * @return where the pass continues, or nothing when the brace is not one -
 *         a `{}`, a `{x}}`, or a name with characters a path segment cannot
 *         carry.
 */
std::optional<std::size_t>
read_path_template (const std::string& path, std::size_t i, std::string& out) {
    const auto close   = path.find ('}', i + 1);
    const bool doubled = close != std::string::npos &&
    close + 1 < path.size () && path[close + 1] == '}';
    if (close == std::string::npos || close <= i + 1 || doubled) {
        return std::nullopt;
    }
    const std::string_view name = std::string_view (path).substr (i + 1, close - i - 1);
    if (!std::all_of (name.begin (), name.end (), is_path_template_char)) {
        return std::nullopt;
    }
    out += "{{" + std::string (name) + "}}";
    return close + 1;
}

std::string normalize (const std::string& path, bool path_templates) {
    std::string out;
    out.reserve (path.size ());
    for (std::size_t i = 0; i < path.size ();) {
        if (path.compare (i, 2, "{{") == 0) {
            if (auto next = read_double_brace (path, i, out)) {
                i = *next;
                continue;
            }
            out += path.substr (i, 2);
            i += 2;
            continue;
        }
        if (path_templates && path[i] == '{') {
            if (auto next = read_path_template (path, i, out)) {
                i = *next;
                continue;
            }
        }
        out += path[i];
        ++i;
    }
    return out;
}

} // namespace

std::string normalize_template_vars (const std::string& text) {
    return normalize (text, /*path_templates=*/false);
}

std::string normalize_path_templates (const std::string& path) {
    return normalize (path, /*path_templates=*/true);
}

namespace {

/**
 * The end of the `{{...}}` token starting at @p at in @p text, or `npos` when
 * none starts there - `postman-url-encoder`'s `/{{[^{}]*}}/`, which is what
 * keeps a separator inside a variable name from splitting the URL.
 */
std::size_t token_end (std::string_view text, std::size_t at) {
    if (text.compare (at, 2, "{{") != 0) {
        return std::string_view::npos;
    }
    for (std::size_t scan = at + 2; scan < text.size (); ++scan) {
        if (text[scan] == '{') {
            return std::string_view::npos;
        }
        if (text[scan] == '}') {
            return text.compare (scan, 2, "}}") == 0 ? scan + 2 : std::string_view::npos;
        }
    }
    return std::string_view::npos;
}

/// @p text with every `{{...}}` token's characters replaced by `_`, the same
/// length - so offsets into it are offsets into @p text, and a separator
/// inside a token is no longer one.
std::string mask_tokens (std::string_view text) {
    std::string out (text);
    for (std::size_t at = 0; at < out.size ();) {
        const std::size_t end = token_end (text, at);
        if (end == std::string_view::npos) {
            ++at;
            continue;
        }
        std::fill (out.begin () + static_cast<std::ptrdiff_t> (at),
        out.begin () + static_cast<std::ptrdiff_t> (end), '_');
        at = end;
    }
    return out;
}

} // namespace

std::vector<PathVariableSegment> path_variable_segments (std::string_view url) {
    std::vector<PathVariableSegment> out;
    const std::string masked = mask_tokens (url);
    const std::string_view view (masked);

    // Leading whitespace is not part of the URL (`trimLeft`).
    std::size_t begin = view.find_first_not_of (" \t\r\n\f\v");
    if (begin == std::string_view::npos) {
        return out;
    }
    // Fragment first, then query, each from its first occurrence.
    std::size_t end = std::min (view.find ('#', begin), view.size ());
    end             = std::min (view.find ('?', begin), end);

    const auto is_slash = [&] (std::size_t at) {
        return view[at] == '/' || view[at] == '\\';
    };
    if (const std::size_t scheme = view.find ("://", begin);
    scheme != std::string_view::npos && scheme + 3 <= end) {
        std::size_t after = scheme + 3;
        while (after < end && is_slash (after)) {
            ++after;
        }
        // `file:///path` keeps one slash: the path starts at it.
        const std::string_view protocol = view.substr (begin, scheme - begin);
        if (after > scheme + 3 && vayu::utils::ascii_lower_equal (protocol, "file")) {
            --after;
        }
        begin = after;
    }
    std::size_t cursor = begin;
    while (cursor < end && !is_slash (cursor)) {
        ++cursor;
    }
    // Everything before the first slash is the authority; no slash, no path.
    while (cursor < end) {
        const std::size_t start = cursor + 1;
        std::size_t stop        = start;
        while (stop < end && !is_slash (stop)) {
            ++stop;
        }
        if (start < stop && url[start] == ':') {
            const std::string_view segment = url.substr (start, stop - start);
            const std::size_t dot          = segment.find ('.', 1);
            const std::size_t name_end =
            dot == std::string_view::npos ? segment.size () : dot;
            if (name_end > 1) {
                out.push_back (
                { start, name_end, std::string (segment.substr (1, name_end - 1)) });
            }
        }
        cursor = stop;
    }
    return out;
}

bool holds_template_token (std::string_view text) {
    for (std::size_t at = text.find ("{{"); at != std::string_view::npos;
    at                  = text.find ("{{", at + 1)) {
        if (token_end (text, at) != std::string_view::npos) {
            return true;
        }
    }
    return false;
}

bool is_path_variable_row (const nlohmann::json& row) {
    if (!row.is_object ()) {
        return false;
    }
    const auto in = row.find ("in");
    return in != row.end () && in->is_string () &&
    in->get_ref<const std::string&> () == "path";
}

const nlohmann::json*
find_path_variable_row (const nlohmann::json& rows, std::string_view name) {
    if (!rows.is_array ()) {
        return nullptr;
    }
    for (auto row = rows.rbegin (); row != rows.rend (); ++row) {
        if (!is_path_variable_row (*row)) {
            continue;
        }
        const auto key = row->find ("key");
        if (key == row->end () || !key->is_string () ||
        key->get_ref<const std::string&> () != name) {
            continue;
        }
        // Absent or non-boolean `enabled` is enabled (D17).
        const auto enabled = row->find ("enabled");
        if (enabled != row->end () && enabled->is_boolean () && !enabled->get<bool> ()) {
            continue;
        }
        return &*row;
    }
    return nullptr;
}

namespace {

/**
 * Whether @p byte is in `postman-url-encoder`'s `PATH_ENCODE_SET` (3.0.8,
 * `encoder/encode-set.js`): the C0 controls and every byte above `~` (so each
 * byte of a UTF-8 sequence), then the fragment set's space `"` `<` `>` and
 * backtick, then the path set's own `#` `?` `{` `}`. Nothing else - `/`, `%`,
 * `@`, `:`, a backslash and the rest of the reserved set go out as written.
 */
bool in_postman_path_encode_set (unsigned char byte) {
    if (byte < 0x20 || byte > 0x7E) {
        return true;
    }
    switch (byte) {
    case ' ':
    case '"':
    case '#':
    case '<':
    case '>':
    case '?':
    case '`':
    case '{':
    case '}': return true;
    default: return false;
    }
}

void append_encoded (std::string& out, std::string_view text) {
    static constexpr std::string_view hex = "0123456789ABCDEF";
    for (const char ch : text) {
        const auto byte = static_cast<unsigned char> (ch);
        if (!in_postman_path_encode_set (byte)) {
            out += ch;
            continue;
        }
        out += '%';
        out += hex[byte >> 4U];
        out += hex[byte & 0x0FU];
    }
}

} // namespace

std::string encode_path_variable_value (std::string_view value) {
    std::string out;
    std::size_t plain = 0;
    for (std::size_t at = 0; at < value.size ();) {
        const std::size_t end = token_end (value, at);
        if (end == std::string_view::npos) {
            ++at;
            continue;
        }
        append_encoded (out, value.substr (plain, at - plain));
        out += value.substr (at, end - at);
        plain = at = end;
    }
    append_encoded (out, value.substr (plain));
    return out;
}

std::vector<vayu::PendingPathVariable> pending_path_variables_of (const nlohmann::json& rows) {
    std::vector<vayu::PendingPathVariable> out;
    if (!rows.is_array ()) {
        return out;
    }
    for (const auto& row : rows) {
        if (!is_path_variable_row (row)) {
            continue;
        }
        const auto key = row.find ("key");
        if (key == row.end () || !key->is_string ()) {
            continue;
        }
        const std::string& name = key->get_ref<const std::string&> ();
        if (std::any_of (out.begin (), out.end (), [&] (const vayu::PendingPathVariable& seen) {
                return seen.key == name;
            })) {
            continue;
        }
        const nlohmann::json* answering = find_path_variable_row (rows, name);
        if (answering == nullptr) {
            continue;
        }
        const auto value = answering->find ("value");
        out.push_back ({ name,
        value != answering->end () && value->is_string () ? value->get<std::string> () :
                                                            std::string () });
    }
    return out;
}

void settle_path_variables (vayu::Request& request, PathSettle which) {
    if (request.path_variables.empty ()) {
        return;
    }
    nlohmann::json rows = nlohmann::json::array ();
    std::vector<vayu::PendingPathVariable> waiting;
    for (auto& variable : request.path_variables) {
        if (which == PathSettle::Answered && holds_template_token (variable.value)) {
            waiting.push_back (std::move (variable));
            continue;
        }
        rows.push_back ({ { "key", std::move (variable.key) },
        { "value", std::move (variable.value) }, { "in", "path" } });
    }
    request.path_variables = std::move (waiting);
    if (!rows.empty ()) {
        request.url = substitute_path_variables (
        request.url, rows, [] (const std::string& value) { return value; });
    }
}

} // namespace vayu::core
