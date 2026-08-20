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

std::string normalize_path_templates (const std::string& path) {
    std::string out;
    out.reserve (path.size ());
    for (std::size_t i = 0; i < path.size ();) {
        if (path.compare (i, 2, "{{") == 0) {
            const auto close = path.find ("}}", i + 2);
            if (close != std::string::npos) {
                const std::string name = trimmed (std::string_view (path).substr (i + 2, close - i - 2));
                const bool ok = !name.empty () &&
                std::all_of (name.begin (), name.end (), is_simple_var_char);
                if (ok) {
                    // `_.x` is Insomnia's spelling of the same variable.
                    const std::string bare = name.rfind ("_.", 0) == 0 ? name.substr (2) : name;
                    out += "{{" + bare + "}}";
                    i = close + 2;
                    continue;
                }
            }
            out += path.substr (i, 2);
            i += 2;
            continue;
        }
        if (path[i] == '{') {
            const auto close = path.find ('}', i + 1);
            const bool doubled = close != std::string::npos && close + 1 < path.size () &&
            path[close + 1] == '}';
            if (close != std::string::npos && close > i + 1 && !doubled) {
                const std::string_view name (path.data () + i + 1, close - i - 1);
                if (std::all_of (name.begin (), name.end (), is_path_template_char)) {
                    out += "{{" + std::string (name) + "}}";
                    i = close + 1;
                    continue;
                }
            }
        }
        out += path[i];
        ++i;
    }
    return out;
}

} // namespace vayu::core
