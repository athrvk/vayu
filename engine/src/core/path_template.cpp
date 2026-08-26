/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/path_template.hpp"

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
    const std::string name = trimmed (std::string_view (path).substr (i + 2, close - i - 2));
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
    const bool doubled =
    close != std::string::npos && close + 1 < path.size () && path[close + 1] == '}';
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

} // namespace vayu::core
