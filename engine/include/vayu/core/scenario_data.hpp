#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/scenario_data.hpp
 * @brief Bind a data row into a composed request through the reserved
 *        `{{data.column}}` namespace (issue #402).
 *
 * `pm.iterationData` (#356) gave *scripts* the row. It cannot make the row
 * influence the request itself, because a scenario plan is composed once,
 * before the first send, and a script that reads a row after the request was
 * built is reading it too late to change where it goes. `{{data.column}}` is
 * the other half: the token survives composition (`http::is_data_variable_name`
 * keeps it written as it stands) and this module substitutes it per iteration,
 * against that iteration's row.
 *
 * **The namespace is reserved, not another tier.** `{{data.id}}` and `{{id}}`
 * are different names, so a data set can never shadow - or be shadowed by - a
 * global, collection or environment variable. That is what makes the feature
 * safe to add to collections people already have.
 *
 * A column the row does not carry is an **error, not an empty string**: the
 * whole point of the token is that the value came from the file, and sending a
 * request with a silently blank field is the failure mode this namespace
 * exists to remove. The runner turns that into an errored step, before the
 * request is sent.
 *
 * A run started with **no data set at all** is the same failure one step
 * earlier, and is refused one step earlier too: plan resolution tokenises the
 * composed steps and returns a `400` rather than starting a run whose every
 * iteration would send the literal token (issue #415).
 *
 * ## Split once, joined per row
 *
 * A step is tokenised when the plan is resolved (`tokenize_data_fields`) and
 * only *joined* afterwards (`apply_data_template`). Design mode could afford to
 * re-scan every field per iteration; the load-mode executor cannot, because it
 * binds a row per iteration per virtual user (issue #449). Both modes drive the
 * same template rather than one keeping a scanner of its own, so a step binds
 * identically however it is executed.
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::core {

/** Whether a row bound cleanly, and what was wrong when it did not. */
struct DataBindResult {
    bool ok = false;
    /// Caller-facing sentence naming the token, the row and the row's columns.
    /// Reaches `results.error` and the app's step list, so it has to be enough
    /// to fix the request without opening the file.
    std::string error;
};

/** One bindable field, split once around the `{{data.column}}` it carries. */
struct DataFieldTemplate {
    /// Which string this is, counted in `walk_bindable_fields` order. Both the
    /// split and the join drive that one walk, so neither can address a field
    /// the other does not - the same reason the scan and the bind shared it.
    size_t field = 0;
    /// `literals.size() == columns.size() + 1`; see `http::TokenSplit`.
    std::vector<std::string> literals;
    /// The column names, with the `data.` prefix already stripped.
    std::vector<std::string> columns;
};

/**
 * A step's bindable fields, tokenised once.
 *
 * **Empty for a step carrying no `{{data.*}}` token at all**, and that
 * emptiness is what a token-free plan is charged per iteration: the executor
 * skips the join outright rather than walking fields that cannot change.
 */
struct StepDataTemplate {
    /// Only the fields that carry at least one token, in walk order.
    std::vector<DataFieldTemplate> fields;

    [[nodiscard]] bool empty () const noexcept {
        return fields.empty ();
    }

    /**
     * The first `{{data.column}}` token in walk order, written back with its
     * braces (`{{data.id}}`), or `nullopt` for a step that carries none.
     *
     * This is what lets plan resolution refuse a run whose steps carry data
     * tokens and whose payload has no `data` set (issue #415): nothing would
     * bind them, so they would reach the wire written as they stand.
     */
    [[nodiscard]] std::optional<std::string> first_token () const;
};

/**
 * Split every bindable field of @p request around its `{{data.column}}` tokens.
 *
 * Run once per step, when the plan is resolved. The request is copied for it -
 * the shared walk rewrites in place and nothing is actually rewritten here -
 * which is affordable exactly because resolution happens once per run, over a
 * plan already bounded by `maxScenarioSteps`.
 */
[[nodiscard]] StepDataTemplate tokenize_data_fields (const vayu::Request& request);

/**
 * Join @p tmpl's fields against @p row, in place on @p request.
 *
 * @p tmpl must have been built from a request of the same shape (in practice:
 * from the plan step @p request was copied from), because a field is addressed
 * by its position in the walk.
 *
 * On failure @p request is left partially bound and must not be sent - the
 * caller ends the step. Repairing it would mean a second copy of the composed
 * request per step per iteration for a path that never reaches the wire.
 */
[[nodiscard]] DataBindResult apply_data_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index);

/**
 * Render one row value as the text a `{{data.column}}` token substitutes.
 *
 * A string is its own text - the CSV/TSV path produces only strings, so this is
 * the ordinary case and it is byte-exact. A JSON or JSONL file may carry any
 * type: numbers and booleans render as JSON writes them (`7`, `true`), `null`
 * renders empty, and an object or array renders as compact JSON so a nested
 * value can still be dropped into a body.
 */
[[nodiscard]] std::string render_data_value (const nlohmann::json& value);

/**
 * Substitute every `{{data.column}}` in @p request against @p row, in place -
 * tokenising it first, for a caller that holds no template.
 *
 * Covers exactly what composition covered: the URL, header names and values,
 * the raw body, and both halves of every form field. @p row_index names the
 * row in an error, because with `iterations` above the row count the bound row
 * is not the iteration number.
 *
 * A caller binding the *same* request repeatedly - every load-mode iteration of
 * every virtual user - must hold the template instead and call
 * `apply_data_template`, which is the whole point of splitting once.
 */
[[nodiscard]] DataBindResult
bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index);

} // namespace vayu::core
