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

/**
 * One token's substitution, shared by every field below.
 *
 * Failure is recorded rather than thrown: the caller is a per-step path in a
 * run worker, and the first bad token is the one worth naming - later ones are
 * consequences of the same missing column.
 */
class RowBinder {
    public:
    RowBinder (const nlohmann::json& row, size_t row_index)
    : row_ (row), row_index_ (row_index) {
    }

    void apply (std::string& field) {
        if (!result_.ok) {
            return; // already failed; leave the rest untouched
        }
        field = vayu::http::substitute_tokens (
        field, [this] (const std::string& name) -> std::optional<std::string> {
            if (!vayu::http::is_data_variable_name (name)) {
                return std::nullopt; // not ours - composition already had its turn
            }
            const std::string column =
            name.substr (vayu::http::DATA_NAMESPACE_PREFIX.size ());
            auto cell = row_.find (column);
            if (cell == row_.end ()) {
                if (result_.ok) {
                    result_.ok    = false;
                    result_.error = "{{" + name +
                    "}} names a column data row " + std::to_string (row_index_) +
                    " does not have (columns: " + describe_columns (row_) + ")";
                }
                return std::nullopt;
            }
            return render_data_value (*cell);
        });
    }

    [[nodiscard]] DataBindResult result () const {
        return result_;
    }

    private:
    const nlohmann::json& row_;
    size_t row_index_ = 0;
    DataBindResult result_{ true, {} };
};

} // namespace

std::string render_data_value (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_null ()) {
        return {};
    }
    return value.dump ();
}

DataBindResult bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index) {
    RowBinder binder (row, row_index);

    binder.apply (request.url);

    // Header *names* are substituted too, because composition substitutes them:
    // the payload carries headers as `[{key, value}]`, and `resolve_json_strings`
    // resolves every string value in that array, key included. A map cannot have
    // its keys rewritten in place, so this rebuilds it.
    if (!request.headers.empty ()) {
        vayu::Headers rebound;
        for (const auto& [name, value] : request.headers) {
            std::string bound_name  = name;
            std::string bound_value = value;
            binder.apply (bound_name);
            binder.apply (bound_value);
            rebound.emplace (std::move (bound_name), std::move (bound_value));
        }
        request.headers = std::move (rebound);
    }

    binder.apply (request.body.content);
    for (auto& field : request.body.fields) {
        binder.apply (field.key);
        binder.apply (field.value);
    }

    return binder.result ();
}

} // namespace vayu::core
