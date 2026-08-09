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
 * earlier, and is refused one step earlier too: plan resolution scans the
 * composed steps through `find_data_token` and returns a `400` rather than
 * starting a run whose every iteration would send the literal token (issue
 * #415).
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

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
 * Substitute every `{{data.column}}` in @p request against @p row, in place.
 *
 * Covers exactly what composition covered: the URL, header names and values,
 * the raw body, and both halves of every form field. @p row_index names the
 * row in an error, because with `iterations` above the row count the bound row
 * is not the iteration number.
 *
 * On failure @p request is left partially substituted and must not be sent -
 * the caller ends the step. Repairing it would mean a second copy of the
 * composed request per step per iteration for a path that never reaches the
 * wire.
 */
[[nodiscard]] DataBindResult
bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index);

/**
 * The first `{{data.column}}` token still standing in a composed @p request,
 * written back with its braces (`{{data.id}}`), or `nullopt` for a request that
 * carries none (issue #415).
 *
 * This is what lets plan resolution refuse a run whose steps carry data tokens
 * and whose payload has no `data` set: nothing would bind them, so they would
 * reach the wire written as they stand.
 *
 * It walks **exactly** the fields `bind_data_row` substitutes, because it is
 * that walk driven against no row at all. A separate scanner would be a second
 * copy of the field list, and a field only one of the two covered would be a
 * token that passes the scan and still goes out literal. The request is copied
 * for it - the walk rewrites in place - which is affordable because plan
 * resolution runs once per run, before the first send, over a plan already
 * bounded by `maxScenarioSteps`.
 */
[[nodiscard]] std::optional<std::string> find_data_token (const vayu::Request& request);

} // namespace vayu::core
