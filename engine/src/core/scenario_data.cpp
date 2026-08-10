/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_data.hpp"

#include <optional>
#include <utility>

#include "vayu/http/request_composer.hpp"

namespace vayu::core {

namespace {

/// The row's keys, in payload order, for the "columns: ..." half of an error.
std::string describe_columns (const nlohmann::json& row) {
    std::string out;
    for (const auto& [key, value] : row.items ()) {
        (void)value;
        if (!out.empty ()) {
            out += ", ";
        }
        out += key;
    }
    return out.empty () ? "none" : out;
}

/// `{{data.<column>}}` - the token as it was written, for an error to name.
std::string token_for (const std::string& column) {
    return "{{" + std::string (vayu::http::DATA_NAMESPACE_PREFIX) + column + "}}";
}

/**
 * The one list of strings a data row binds: URL, header names and values, raw
 * body, and both halves of every form field.
 *
 * Splitting and joining both drive it, so neither can cover a field the other
 * does not - a field only the splitter walked would be a token nobody joins,
 * and one only the joiner walked would be addressed by an index the splitter
 * never handed out.
 *
 * Header *names* are substituted too, because composition substitutes them: the
 * payload carries headers as `[{key, value}]`, and `resolve_json_strings`
 * resolves every string value in that array, key included. A map cannot have
 * its keys rewritten in place, so this rebuilds it.
 */
template <typename Visit>
void walk_bindable_fields (vayu::Request& request, Visit&& visit) {
    visit (request.url);

    if (!request.headers.empty ()) {
        vayu::Headers rebound;
        for (const auto& [name, value] : request.headers) {
            std::string bound_name  = name;
            std::string bound_value = value;
            visit (bound_name);
            visit (bound_value);
            rebound.emplace (std::move (bound_name), std::move (bound_value));
        }
        request.headers = std::move (rebound);
    }

    visit (request.body.content);
    for (auto& field : request.body.fields) {
        visit (field.key);
        visit (field.value);
    }
}

/**
 * Split each visited field around its `{{data.*}}` tokens, keeping only the
 * fields that carry one.
 */
class FieldSplitter {
    public:
    void operator() (std::string& field) {
        const size_t position = next_field_++;
        if (field.empty ()) {
            return;
        }
        auto split = vayu::http::split_tokens (field, vayu::http::is_data_variable_name);
        if (split.names.empty ()) {
            return;
        }
        DataFieldTemplate entry;
        entry.field    = position;
        entry.literals = std::move (split.literals);
        entry.columns.reserve (split.names.size ());
        for (const auto& name : split.names) {
            entry.columns.push_back (
            name.substr (vayu::http::DATA_NAMESPACE_PREFIX.size ()));
        }
        template_.fields.push_back (std::move (entry));
    }

    [[nodiscard]] StepDataTemplate take () {
        return std::move (template_);
    }

    private:
    StepDataTemplate template_;
    size_t next_field_ = 0;
};

/**
 * Join the templated fields of one step against one row.
 *
 * Failure is recorded rather than thrown: the caller is a per-step path in a
 * run worker, and the first bad token is the one worth naming - later ones are
 * consequences of the same missing column.
 */
class TemplateJoiner {
    public:
    TemplateJoiner (const StepDataTemplate& tmpl, const nlohmann::json& row, size_t row_index)
    : template_ (tmpl), row_ (row), row_index_ (row_index) {
    }

    void operator() (std::string& field) {
        const size_t position = next_field_++;
        // The templates are in ascending walk order, so one cursor finds them
        // all without searching - every field between two of them is untouched.
        if (!result_.ok || cursor_ >= template_.fields.size ()) {
            return;
        }
        const DataFieldTemplate& entry = template_.fields[cursor_];
        if (entry.field != position) {
            return;
        }
        ++cursor_;

        std::string out = entry.literals[0];
        for (size_t i = 0; i < entry.columns.size (); ++i) {
            const auto cell = row_.find (entry.columns[i]);
            if (cell == row_.end ()) {
                result_.ok    = false;
                result_.error = token_for (entry.columns[i]) +
                " names a column data row " + std::to_string (row_index_) +
                " does not have (columns: " + describe_columns (row_) + ")";
                return;
            }
            out += render_data_value (*cell);
            out += entry.literals[i + 1];
        }
        field = std::move (out);
    }

    [[nodiscard]] DataBindResult result () const {
        return result_;
    }

    private:
    const StepDataTemplate& template_;
    const nlohmann::json& row_;
    size_t row_index_  = 0;
    size_t next_field_ = 0;
    size_t cursor_     = 0;
    DataBindResult result_{ true, {} };
};

} // namespace

std::optional<std::string> StepDataTemplate::first_token () const {
    if (fields.empty () || fields.front ().columns.empty ()) {
        return std::nullopt;
    }
    return token_for (fields.front ().columns.front ());
}

std::string render_data_value (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_null ()) {
        return {};
    }
    return value.dump ();
}

StepDataTemplate tokenize_data_fields (const vayu::Request& request) {
    // Copied because the walk rewrites in place; nothing is actually rewritten
    // here, since a split substitutes no token. Sharing the walk is what the
    // copy buys - see the header for why a second field list would be the wrong
    // trade.
    vayu::Request scratch = request;
    FieldSplitter splitter;
    walk_bindable_fields (
    scratch, [&splitter] (std::string& field) { splitter (field); });
    return splitter.take ();
}

DataBindResult apply_data_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index) {
    if (tmpl.empty ()) {
        return DataBindResult{ true, {} };
    }
    TemplateJoiner joiner (tmpl, row, row_index);
    walk_bindable_fields (
    request, [&joiner] (std::string& field) { joiner (field); });
    return joiner.result ();
}

DataBindResult bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index) {
    return apply_data_template (request, tokenize_data_fields (request), row, row_index);
}

} // namespace vayu::core
