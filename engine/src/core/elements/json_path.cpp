/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "json_path.hpp"

#include <algorithm>
#include <cctype>
#include <format>
#include <functional>
#include <unordered_map>
#include <utility>

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

void eval_member (const nlohmann::ordered_json& node,
const JsonPathStep& step,
std::vector<const nlohmann::ordered_json*>& out) {
    if (!node.is_object ()) {
        return;
    }
    if (auto it = node.find (step.name); it != node.end ()) {
        out.push_back (&*it);
    }
}

void eval_index (const nlohmann::ordered_json& node,
const JsonPathStep& step,
std::vector<const nlohmann::ordered_json*>& out) {
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

void eval_index_any (const nlohmann::ordered_json& node,
std::vector<const nlohmann::ordered_json*>& out) {
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

void eval_recursive_walk (const nlohmann::ordered_json& node,
const std::string& name,
std::vector<const nlohmann::ordered_json*>& out) {
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

void eval_step (const nlohmann::ordered_json& node,
const JsonPathStep& step,
std::vector<const nlohmann::ordered_json*>& out) {
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

std::vector<const nlohmann::ordered_json*> evaluate_json_path (
const nlohmann::ordered_json& root,
const std::vector<JsonPathStep>& steps) {
    std::vector<const nlohmann::ordered_json*> current{ &root };
    for (const auto& step : steps) {
        std::vector<const nlohmann::ordered_json*> next;
        for (const auto* node : current) {
            eval_step (*node, step, next);
        }
        current = std::move (next);
    }
    return current;
}

namespace {

using OrderedJson = nlohmann::ordered_json;

/// Builds an `OrderedJson` from the parser's events with an explicit stack,
/// one frame per open container, so nothing here recurses. An object frame
/// indexes its keys once it outgrows a short scan, which is what lets a member
/// be placed without `ordered_map::emplace`'s scan of every member before it.
class OrderedTreeBuilder final : public nlohmann::json_sax<OrderedJson> {
    public:
    explicit OrderedTreeBuilder (size_t max_depth) : max_depth_ (max_depth) {
    }

    bool null () override {
        return place_leaf (nullptr);
    }
    bool boolean (bool val) override {
        return place_leaf (val);
    }
    bool number_integer (number_integer_t val) override {
        return place_leaf (val);
    }
    bool number_unsigned (number_unsigned_t val) override {
        return place_leaf (val);
    }
    bool number_float (number_float_t val, const string_t& /*raw*/) override {
        return place_leaf (val);
    }
    bool string (string_t& val) override {
        return place_leaf (std::move (val));
    }
    bool binary (binary_t& val) override {
        return place_leaf (OrderedJson::binary (std::move (val)));
    }
    // The element-count hints are always "unknown" for JSON text.
    bool start_object (size_t /*elements*/) override {
        return open (OrderedJson::object ());
    }
    bool start_array (size_t /*elements*/) override {
        return open (OrderedJson::array ());
    }
    bool key (string_t& val) override {
        frames_.back ().key = std::move (val);
        return true;
    }
    bool end_object () override {
        return close ();
    }
    bool end_array () override {
        return close ();
    }
    bool parse_error (size_t /*position*/,
    const std::string& /*last_token*/,
    const nlohmann::detail::exception& /*ex*/) override {
        return false;
    }

    [[nodiscard]] OrderedJson take_root () {
        return std::move (root_);
    }

    private:
    using Members = OrderedJson::object_t::Container;

    /// Below this many members a scan beats hashing every key of the small
    /// objects most bodies are made of; past it the scan would be the O(n^2).
    static constexpr size_t SCANNED_MEMBERS = 16;

    struct Frame {
        OrderedJson container;
        /// Key -> index into `container`'s members, once an object has
        /// `SCANNED_MEMBERS`; empty before that and for an array.
        std::unordered_map<std::string, size_t> member_index;
        /// The key the next value is placed under; objects only.
        std::string key;
    };

    /// A value is placed at depth `frames_.size ()`.
    [[nodiscard]] bool too_deep () const {
        return frames_.size () > max_depth_;
    }

    bool place_leaf (OrderedJson value) {
        return !too_deep () && place (std::move (value));
    }

    bool open (OrderedJson container) {
        if (too_deep ()) {
            return false;
        }
        frames_.push_back (Frame{ std::move (container), {}, {} });
        return true;
    }

    bool close () {
        OrderedJson done = std::move (frames_.back ().container);
        frames_.pop_back ();
        return place (std::move (done));
    }

    bool place (OrderedJson value) {
        if (frames_.empty ()) {
            root_ = std::move (value);
            return true;
        }
        Frame& top = frames_.back ();
        if (top.container.is_array ()) {
            top.container.get_ref<OrderedJson::array_t&> ().push_back (std::move (value));
            return true;
        }
        // The vector underneath: `ordered_map` hides `operator[] (size_t)`
        // and its `emplace` is the unbounded scan this class exists to avoid.
        auto& members =
        static_cast<Members&> (top.container.get_ref<OrderedJson::object_t&> ());
        const size_t slot = member_slot (top, members);
        if (slot == members.size ()) {
            members.emplace_back (std::move (top.key), std::move (value));
        } else {
            members.at (slot).second = std::move (value);
        }
        return true;
    }

    /// Where `top.key` already sits in @p members, or `members.size ()`.
    static size_t member_slot (Frame& top, const Members& members) {
        if (top.member_index.empty () && members.size () < SCANNED_MEMBERS) {
            const auto found =
            std::ranges::find (members, top.key, &Members::value_type::first);
            return static_cast<size_t> (found - members.begin ());
        }
        if (top.member_index.empty ()) {
            for (size_t i = 0; i < members.size (); ++i) {
                top.member_index.emplace (members.at (i).first, i);
            }
        }
        return top.member_index.try_emplace (top.key, members.size ()).first->second;
    }

    size_t max_depth_;
    std::vector<Frame> frames_;
    OrderedJson root_;
};

} // namespace

std::optional<nlohmann::ordered_json>
parse_ordered_json (std::string_view text, size_t max_depth) {
    OrderedTreeBuilder builder (max_depth);
    if (!nlohmann::ordered_json::sax_parse (text, &builder)) {
        return std::nullopt;
    }
    // In place: a json converts to anything, `std::optional` included.
    return std::optional<nlohmann::ordered_json>{ std::in_place, builder.take_root () };
}

} // namespace vayu::core::detail
