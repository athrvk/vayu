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
 * A cell that is **null** is the same failure again, one type down: the token
 * says the value comes from the file and the file says there is none, so the
 * bind errors rather than writing nothing where a value belonged (issue #593).
 *
 * ## A value is written for the document it lands in
 *
 * Substitution is textual, so a value carrying a `"` used to end the JSON
 * string it was dropped into and put a malformed body on the wire, silently
 * (issue #593). A token inside a string literal of a JSON body therefore binds
 * **escaped**: the cell's text stays what it was, and the document stays
 * readable. A token placed *outside* a string literal - `{"n":{{data.n}}}` -
 * still binds verbatim, which is what makes typed placement work.
 *
 * Nothing else is escaped: a URL, a header, a form field and a text body take
 * the rendered value byte for byte, because none of them is a document with a
 * quoting rule of its own.
 *
 * ## Split once, joined per row
 *
 * A step is tokenised when the plan is resolved (`tokenize_data_fields`) and
 * only *joined* afterwards (`apply_data_template`). Design mode could afford to
 * re-scan every field per iteration; the load-mode executor cannot, because it
 * binds a row per iteration per virtual user (issue #449). Both modes drive the
 * same template rather than one keeping a scanner of its own, so a step binds
 * identically however it is executed.
 *
 * ## Credentials are bound before they are encoded
 *
 * A credentials file driving basic auth is the canonical data-driven run, and
 * the fields above cannot serve it: `apply_auth` collapses a username and a
 * password into one base64 `Authorization` value, so a `{{data.user}}` resolved
 * into the plan is already unreadable by the time anything scans the built
 * request - it went out as base64 of the literal token text, silently (issue
 * #591). `tokenize_auth_fields` therefore splits the *typed* credentials
 * instead, and a step that carries one binds them and applies its auth per
 * iteration rather than at plan time.
 */

#include <cstddef>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/http/auth_resolver.hpp"
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
 * How one token's rendered value is written into the text around it.
 *
 * Decided at split time, per token, because the surrounding literals are what
 * answer it and they do not change per row - the join must not re-derive this
 * for every iteration of every virtual user.
 */
enum class DataValueEncoding : std::uint8_t {
    /// The rendered text, byte for byte. Every field but a JSON document.
    Verbatim,
    /// Escaped as JSON string content (`"`, `\` and the control characters),
    /// for a token sitting inside a string literal of a JSON body.
    JsonString,
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
    /// One per entry of `columns`, in the same order.
    std::vector<DataValueEncoding> encodings;
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
 *
 * The body's **mode** is read here as well as its text: it is what decides
 * whether the body is a JSON document, and so whether a token inside a string
 * literal binds escaped. A template is therefore only valid for a request whose
 * body mode is the one it was split from.
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
 * Split @p auth's credential strings around their `{{data.column}}` tokens.
 *
 * The same splitter the request walk drives, over `walk_auth_credentials`
 * instead of `walk_bindable_fields` - one field list per walk, and the join
 * below drives the identical walk, so neither can address a credential the
 * other does not.
 *
 * Every credential binds **verbatim**: a token, a username and an api key are
 * plain text, not a document with a quoting rule, and what escaping they need
 * (base64 for basic auth, percent-encoding for an api key in the query) is
 * `apply_auth`'s to add *after* the bind - which is the whole point of binding
 * before the auth is applied.
 *
 * Empty for the ordinary step, whose credentials carry no token and whose auth
 * is therefore resolved into the plan once, as it always was.
 */
[[nodiscard]] StepDataTemplate tokenize_auth_fields (const vayu::http::Auth& auth);

/**
 * Join @p tmpl's credentials against @p row, in place on @p auth.
 *
 * @p auth must be the parsed auth @p tmpl was split from, for the same reason
 * `apply_data_template` needs the request it was split from: a credential is
 * addressed by its position in the walk.
 */
[[nodiscard]] DataBindResult apply_auth_data_template (vayu::http::Auth& auth,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index);

/**
 * The first `{{data.column}}` in any string of @p value, recursively, written
 * back with its braces - or `nullopt` when it carries none.
 *
 * For a block that has no bind to offer at all and must therefore refuse rather
 * than defer: an OAuth 2.0 config, whose token is acquired once when the plan
 * is resolved. Object *keys* are not scanned - a column name where a config key
 * belongs is not a placement anyone means.
 */
[[nodiscard]] std::optional<std::string> first_data_token_in (const nlohmann::json& value);

/**
 * Render one row value as the text a `{{data.column}}` token substitutes.
 *
 * A string is its own text - the CSV/TSV path produces only strings, so this is
 * the ordinary case and it is byte-exact. A JSON or JSONL file may carry any
 * type: numbers and booleans render as JSON writes them (`7`, `true`), `null`
 * renders empty, and an object or array renders as compact JSON so a nested
 * value can still be dropped into a body.
 *
 * The rendering is what a value *reads* as; whether it is then escaped for the
 * document it lands in is the encoding above. **A null cell never reaches a
 * request through the binder** - `apply_data_template` refuses it, for the same
 * reason a missing column is refused - so the empty rendering here is the
 * answer to "what does this value say", not a value the wire ever sees.
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
