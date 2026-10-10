/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "json_path.hpp"

#include <cctype>
#include <format>
#include <functional>

#include "vayu/utils/parse.hpp"

namespace vayu::core::detail {

namespace {

/// Parses a `.name` or `..name` segment starting at `path[i]` (already known
/// to be `.`), advancing `i` past it. `nullopt` on an empty name.
std::optional<JsonPathStep> parse_member_step (std::string_view path, size_t& i) {
    const bool recursive = i + 1 < path.size () && path[i + 1] == '.';
    i += recursive ? 2 : 1;
    const size_t start = i;
    while (i < path.size () && path[i] != '.' && path[i] != '[') {
        ++i;
    }
    if (i == start) {
        return std::nullopt;
    }
    return JsonPathStep{ recursive ? JsonPathStep::Kind::Recursive : JsonPathStep::Kind::Member,
        std::string (path.substr (start, i - start)), 0 };
}

/// Parses a `['name']` or `["name"]` segment starting at `path[i]` (already
/// known to be `[` followed by a quote), advancing `i` past the closing `]`.
/// The name runs to the next matching quote, so it may hold `.`, `[` and `]`
/// but has no escape for the quote character itself. `nullopt` on an empty
/// name, an unterminated quote or anything between the quote and the `]`.
std::optional<JsonPathStep> parse_quoted_member_step (std::string_view path, size_t& i) {
    const char quote        = path[i + 1];
    const size_t name_start = i + 2;
    const size_t name_end   = path.find (quote, name_start);
    if (name_end == std::string_view::npos || name_end == name_start) {
        return std::nullopt;
    }
    if (name_end + 1 >= path.size () || path[name_end + 1] != ']') {
        return std::nullopt;
    }
    i = name_end + 2;
    return JsonPathStep{ JsonPathStep::Kind::Member,
        std::string (path.substr (name_start, name_end - name_start)), 0 };
}

/// Parses a `[n]`, `[*]` or quoted-member segment starting at `path[i]`
/// (already known to be `[`), advancing `i` past the closing `]`. `nullopt` on
/// no closing bracket or an inner text that is none of the three.
std::optional<JsonPathStep> parse_bracket_step (std::string_view path, size_t& i) {
    if (i + 1 < path.size () && (path[i + 1] == '\'' || path[i + 1] == '"')) {
        return parse_quoted_member_step (path, i);
    }
    const size_t close = path.find (']', i);
    if (close == std::string_view::npos) {
        return std::nullopt;
    }
    const std::string_view inner = path.substr (i + 1, close - i - 1);
    i                            = close + 1;
    if (inner == "*") {
        return JsonPathStep{ JsonPathStep::Kind::IndexAny, "", 0 };
    }
    const auto index = vayu::utils::parse_number<long> (inner);
    if (!index) {
        return std::nullopt;
    }
    return JsonPathStep{ JsonPathStep::Kind::Index, "", *index };
}

} // namespace

std::optional<std::string> json_path_problem (const nlohmann::json& holder,
std::string_view key,
std::string_view label) {
    const auto it = holder.find (key);
    if (it == holder.end () || !it->is_string ()) {
        return std::nullopt; // Absent or mistyped: the schema's error is the one to report.
    }
    if (parse_json_path (it->get_ref<const std::string&> ())) {
        return std::nullopt;
    }
    return std::format (
    "'{}' is not a supported JSONPath - it must start with $ and use .name, "
    "['name'], [n], [*] or ..name (filters are not supported)",
    label);
}

std::optional<std::vector<JsonPathStep>> parse_json_path (std::string_view path) {
    if (path.empty () || path[0] != '$') {
        return std::nullopt;
    }
    std::vector<JsonPathStep> steps;
    size_t i = 1;
    while (i < path.size ()) {
        std::optional<JsonPathStep> step;
        if (path[i] == '.') {
            step = parse_member_step (path, i);
        } else if (path[i] == '[') {
            step = parse_bracket_step (path, i);
        } // else: a filter or anything else this subset does not cover.
        if (!step) {
            return std::nullopt;
        }
        steps.push_back (std::move (*step));
    }
    return steps;
}

namespace {

void eval_member (const nlohmann::json& node,
const JsonPathStep& step,
std::vector<const nlohmann::json*>& out) {
    if (!node.is_object ()) {
        return;
    }
    if (auto it = node.find (step.name); it != node.end ()) {
        out.push_back (&*it);
    }
}

void eval_index (const nlohmann::json& node,
const JsonPathStep& step,
std::vector<const nlohmann::json*>& out) {
    if (!node.is_array ()) {
        return;
    }
    long idx = step.index;
    if (idx < 0) {
        idx += static_cast<long> (node.size ());
    }
    if (idx >= 0 && static_cast<size_t> (idx) < node.size ()) {
        out.push_back (&node[static_cast<size_t> (idx)]);
    }
}

void eval_index_any (const nlohmann::json& node, std::vector<const nlohmann::json*>& out) {
    if (node.is_array ()) {
        for (const auto& element : node) {
            out.push_back (&element);
        }
    } else if (node.is_object ()) {
        for (const auto& [key, value] : node.items ()) {
            (void)key;
            out.push_back (&value);
        }
    }
}

void eval_recursive_walk (const nlohmann::json& node,
const std::string& name,
std::vector<const nlohmann::json*>& out) {
    if (node.is_object ()) {
        for (const auto& [key, value] : node.items ()) {
            if (key == name) {
                out.push_back (&value);
            }
            eval_recursive_walk (value, name, out);
        }
    } else if (node.is_array ()) {
        for (const auto& value : node) {
            eval_recursive_walk (value, name, out);
        }
    }
}

void eval_step (const nlohmann::json& node,
const JsonPathStep& step,
std::vector<const nlohmann::json*>& out) {
    switch (step.kind) {
    case JsonPathStep::Kind::Member: eval_member (node, step, out); break;
    case JsonPathStep::Kind::Index: eval_index (node, step, out); break;
    case JsonPathStep::Kind::IndexAny: eval_index_any (node, out); break;
    case JsonPathStep::Kind::Recursive:
        eval_recursive_walk (node, step.name, out);
        break;
    }
}

} // namespace

std::vector<const nlohmann::json*> evaluate_json_path (const nlohmann::json& root,
const std::vector<JsonPathStep>& steps) {
    std::vector<const nlohmann::json*> current{ &root };
    for (const auto& step : steps) {
        std::vector<const nlohmann::json*> next;
        for (const auto* node : current) {
            eval_step (*node, step, next);
        }
        current = std::move (next);
    }
    return current;
}

} // namespace vayu::core::detail
