#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file request_composer.hpp
 * @brief Engine-side request composition: `{{variable}}` interpolation and
 *        `inherit` auth resolution (issue #226).
 *
 * Until #226 every engine client prepared its requests itself - the renderer
 * and the MCP layer each carried a copy of the variable map, the substitution
 * rules and the collection-chain auth walk. This module is the single
 * implementation both now call, exposed over HTTP as `POST /compose`
 * (routes/compose.cpp): the client hands over an unresolved request (inline,
 * by saved-request id, or both) plus its scope ids, and gets back the
 * execute-ready payload that `POST /execute` / `POST /runs` accept unchanged.
 *
 * Composition is deliberately *pure* - it never sends, never creates a run
 * row, and never runs a script. Interpolation therefore always happens
 * strictly before the pre-request script (decision D1 of #226: today's
 * semantics, not Postman's script-first order), and a payload that skips
 * composition is never interpolated at all, so nothing can be resolved twice
 * (D12).
 *
 * The behavioural contracts (issue #226, "Behaviour that must not change"):
 *  - an unknown plain name keeps its braces, and so does an unknown `$name`
 *    (#186 for the generators, #1009 for the ordinary names)
 *  - a `data.*` name keeps its braces too: it addresses the reserved data
 *    namespace (issue #402), which only a scenario run's iteration can bind
 *  - so does a bare name the caller says a bound row will substitute
 *    (`BoundColumnNames`, issue #1007) - the same deferral for the same
 *    reason, spelled the way Postman's data variables are
 *  - precedence: environment > collection chain (leaf over root) > globals
 *  - only enabled definitions participate; a definition whose `enabled` is
 *    absent counts as enabled (D17), and a non-string stored `value` reads as
 *    "" (D17, enforced by `vayu::json::parse_variables`)
 *  - a user-defined variable named `$guid` beats the generator, and each
 *    generator runs once per `{{...}}` occurrence
 *  - single pass, no recursion: a value containing `{{other}}` stays literal
 *  - the raw stored string is substituted, never the typed value
 *  - `noauth` on a collection terminates the inherit walk, `none` does not
 *  - auth is resolved *before* any OAuth 2.0 cache key is computed (the key
 *    is derived from the composed config downstream, so two environments
 *    whose configs differ only through `{{vars}}` cannot share a token)
 */

#include <functional>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/** Effective variable values for one composition: name -> raw string value. */
using VariableValues = std::map<std::string, std::string>;

/**
 * Build the effective variable map with the app's precedence (highest wins):
 * environment > collection chain (leaf over root) > globals. Only enabled
 * variables participate. @p chain is root-first, so later (leaf) entries
 * overwrite earlier (root) ones.
 */
VariableValues build_variable_values (const vayu::Environment& globals,
const std::vector<vayu::Environment>& chain,
const vayu::Environment& environment);

/** True for a name written as a dynamic variable (`$...`), known or not. */
bool is_dynamic_variable_name (const std::string& name);

/**
 * The reserved prefix for the data namespace: `{{data.column}}` addresses a
 * column of the run's data set, never a variable from any scope.
 */
inline constexpr std::string_view DATA_NAMESPACE_PREFIX = "data.";

/**
 * True for a name inside the reserved `data.*` namespace (issue #402).
 *
 * The namespace sits *outside* the globals/collection/environment tier order
 * rather than above it, which is what dissolves the precedence question: a
 * variable someone happens to name `data.id` and the column `{{data.id}}` are
 * different names, so they cannot collide. Composition therefore leaves such a
 * token written as it stands - it has no value to substitute, because only a
 * scenario run's iteration knows which row is bound
 * (`core::bind_data_row`).
 */
bool is_data_variable_name (const std::string& name);

/**
 * The reserved prefix for the iteration identity: `{{$vu}}` and
 * `{{$iteration}}` address the run that is executing, never a variable from any
 * scope (issue #994).
 */
inline constexpr std::string_view IDENTITY_NAMESPACE_PREFIX = "$";
/// The virtual user this request belongs to, 1-based.
inline constexpr std::string_view IDENTITY_VU_NAME = "$vu";
/// That virtual user's iteration, 0-based.
inline constexpr std::string_view IDENTITY_ITERATION_NAME = "$iteration";

/**
 * True for `$vu` or `$iteration`, the two reserved identity names (issue #994).
 *
 * They are spelled like a dynamic variable and behave like `data.*`: the value
 * is known only to the iteration that is about to send, so composition leaves
 * the token written as it stands and the executor binds it immediately before
 * the send (`core::apply_iteration_template`). Being reserved is what makes them
 * *bindable at all* - a variable someone names `$vu` cannot answer for the
 * identity, exactly as one named `data.id` cannot answer for a column, because
 * a scope that could answer would freeze the value at composition for the whole
 * run.
 *
 * The two names are matched exactly rather than by their `$` prefix: every
 * other `$name` is either a generator from the dynamic table or an unknown that
 * keeps its braces (#186), and both of those must keep answering as they did.
 */
bool is_identity_variable_name (const std::string& name);

/**
 * The bare column names a bound data row will substitute (issue #1007).
 *
 * Postman binds a dataset's columns to bare names - `{{username}}` in a
 * request reads the current row - and an imported collection is written that
 * way, so a Vayu run of it has to answer those names from the row or send a
 * request the file's author never wrote. That is a *precedence* question,
 * which the reserved `data.*` namespace above deliberately dissolves rather
 * than answers, so the two rules coexist: `{{data.id}}` is always the column,
 * and `{{id}}` is the column **only while a row is bound**, at Postman's
 * position for it - above the environment, and above everything below it.
 *
 * Composition holds only the *names*, never a row: a plan is composed once and
 * a row is bound per iteration, so what composition can do about a bound column
 * is exactly what it does about `data.*` - leave the token written as it
 * stands, for `core::apply_iteration_template` to join per row. An empty set is
 * every composition that has no dataset behind it, and costs one `empty()`
 * test per token.
 *
 * Who fills it: the engine itself where it knows the dataset (a scenario
 * plan's steps, a single-request load run, a send carrying one row), and the
 * `dataColumns` field of `POST /compose` for a client that composes ahead of a
 * run of its own.
 */
using BoundColumnNames = std::set<std::string>;

/**
 * True for a name @p bound_columns says a row will substitute, so composition
 * leaves it written as it stands.
 *
 * Never a `data.*` name: that namespace is answered before this one and is
 * spelled with its prefix, so a column named `data.id` in a file reaches the
 * bind as the token `{{data.id}}` either way.
 */
bool is_bound_column_name (const std::string& name, const BoundColumnNames& bound_columns);

/**
 * Scan `{{name}}` occurrences left to right over @p input and replace each
 * through @p resolve, which receives the trimmed name.
 *
 * `nullopt` leaves that occurrence written exactly as it stands; any string -
 * including an empty one - replaces it. Nested braces never match.
 *
 * **A replacement that carries tokens of its own is resolved too** (#1009),
 * through the same @p resolve, to a bound of 8 levels: `baseUrl =
 * "{{protocol}}://{{host}}"` composes as the URL it spells rather than as
 * literal braces. A name already being expanded is a cycle and its token is
 * left written as it stands, so `a = "{{b}}"` with `b = "{{a}}"` terminates.
 * A value holding no `{{` costs one search and nothing else, which is what
 * keeps composition a single pass for everything that is not layered.
 *
 * This is the one scanner: `resolve_template` and the scenario runner's data
 * pass both drive it, so the two cannot disagree about what a token *is*.
 */
std::string substitute_tokens (const std::string& input,
const std::function<std::optional<std::string> (const std::string& name)>& resolve);

/** One string split around the `{{name}}` occurrences a caller kept. */
struct TokenSplit {
    /// `literals.size() == names.size() + 1`, always - a string with no kept
    /// token is one literal, and the join is
    /// `literals[0] + <names[0]> + literals[1] + ... + literals[n]`.
    std::vector<std::string> literals;
    /// The trimmed names, in the order they appear.
    std::vector<std::string> names;
};

/**
 * The same left-to-right scan as `substitute_tokens`, *reported* rather than
 * applied: @p input split into its literal text and the names of the `{{name}}`
 * occurrences @p keep accepts. One pass and no nesting - it reports names, and
 * a name has no value here to hold tokens of its own. A token @p keep rejects stays part of the
 * surrounding literal, written exactly as it stands.
 *
 * Through the same pattern as `substitute_tokens`, so the two cannot disagree
 * about what a token *is* - a splitter with its own regex would be the second
 * copy that lets a token pass one and not the other.
 *
 * This exists for the load path, which cannot re-scan every field of every
 * request per iteration: a field is split once, when the plan is resolved, and
 * only joined per row afterwards (`core::tokenize_bindable_fields`).
 */
[[nodiscard]] TokenSplit split_tokens (const std::string& input,
const std::function<bool (const std::string& name)>& keep);

/**
 * Generate a value for a dynamic variable name (including the `$`), or
 * `nullopt` when the table does not have it - the caller leaves an unknown
 * `{{$typo}}` written as it stands (issue #186's contract).
 */
std::optional<std::string> resolve_dynamic_variable (const std::string& name);

/**
 * The supported dynamic-variable names, in table order. The renderer's
 * `lib/dynamic-variables.ts` must list exactly these names - the shared
 * conformance fixture (`tests/fixtures/variable-resolution-conformance.json`)
 * pins the set on both sides.
 */
const std::vector<std::string>& dynamic_variable_names ();

/**
 * Substitute `{{name}}` occurrences. The reserved `data.*` namespace first
 * (kept verbatim) and @p bound_columns beside it (kept verbatim too, issue
 * #1007), then scopes, then the dynamic-variable table; a name nothing answers
 * - ordinary or `$name` - keeps its braces (#186, #1009), and a value that
 * itself holds tokens is resolved through them under `substitute_tokens`'
 * bound. Nested braces never match.
 *
 * @p bound_columns defaults to empty, which is composition as it was: every
 * caller with no dataset behind it resolves exactly the names it always did.
 */
std::string resolve_template (const std::string& input,
const VariableValues& vars,
const BoundColumnNames& bound_columns = {});

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
 * document it lands in is `core::encode_data_value`'s question. **A null cell
 * never reaches a request through the binder** - `apply_iteration_template` refuses
 * it, for the same reason a missing column is refused - so the empty rendering
 * here is the answer to "what does this value say", not a value the wire ever
 * sees.
 *
 * Lives here rather than in `core/scenario_data.hpp`, where it started, because
 * it is the namespace's own spelling rule and the namespace is declared just
 * above - and because the script sandbox needs it (issue #890) from a layer
 * below core.
 */
[[nodiscard]] std::string render_data_value (const nlohmann::json& value);

/**
 * The row a `{{data.column}}` resolves against, for the one caller that has one.
 *
 * Composition deliberately has none - a plan is resolved once, before any row is
 * bound, which is why `resolve_template` above keeps the namespace written as it
 * stands. `pm.variables.replaceIn` is the exception (issue #890): it runs *per
 * step*, with the iteration's row already in hand, so a token it leaves written
 * is a token it could have resolved and chose not to.
 *
 * @p columns is keyed by column name with the `data.` prefix already stripped,
 * holding the text each cell substitutes (`render_data_value` above - it moved
 * out of `core` with the namespace's spelling rule).
 *
 * @p missing_column reports the first `data.` name the row had no column for, in
 * the shape `resolve_header_template` already uses for its refusal: the resolver
 * cannot decide what that should cost - at bind time it errors the step, and for
 * a script it is a thrown TypeError - so it records the name and lets the caller
 * choose. The returned string is unusable when it is set.
 *
 * **A bare column name resolves here too** (issue #1007), at Postman's
 * precedence: a name the row carries answers from the row *before* the scopes,
 * so `{{username}}` reads this iteration's cell even where an environment
 * variable of that name exists. It is only reported through @p missing_column
 * in its `data.` spelling: a bare name the row does not carry is an ordinary
 * name and falls through to the scopes, which is what keeps a script that runs
 * both with and without a row from throwing on the second.
 */
struct DataRowColumns {
    /// Column name (no `data.` prefix) -> the text it substitutes.
    VariableValues columns;
};

std::string resolve_template_with_data (const std::string& input,
const VariableValues& vars,
const DataRowColumns& row,
std::optional<std::string>& missing_column);

/**
 * Deep-resolve every string *value* inside a JSON value (object keys are left
 * alone), preserving structure. Non-string leaves pass through verbatim.
 *
 * @p bound_columns is `resolve_template`'s, for the same reason: an auth block
 * is where a credential lives, and a credential is the canonical data-driven
 * field (issue #591), so a bound column named there is left for the per-row
 * bind rather than resolved from a same-named variable.
 */
nlohmann::json resolve_json_strings (const nlohmann::json& value,
const VariableValues& vars,
const BoundColumnNames& bound_columns = {});

/**
 * Root-first ancestor chain for a collection (inclusive of the collection
 * itself). Cycle-guarded, so corrupted `parent_id` data terminates instead of
 * looping under the DB mutex. Empty for an unknown or empty id.
 */
std::vector<vayu::db::Collection>
collection_chain (vayu::db::Database& db, const std::string& leaf_id);

/**
 * The auth a descendant's `inherit` resolves to: walk the chain leaf->root and
 * take the first collection with concrete auth. An explicit `noauth` stops the
 * walk ("send nothing" is a different answer from "nobody configured any");
 * `none` is stepped over. Returns the winning auth JSON, or `null` when the
 * walk ends with nothing to send.
 */
nlohmann::json resolve_inherited_auth (const std::vector<vayu::db::Collection>& chain);

/**
 * The `POST /compose` core: turn `{requestId?, request?, collectionId?,
 * environmentId?}` into `{http_status, body}`. On 200 the body is the
 * execute-ready payload `POST /execute` and `POST /runs` accept unchanged;
 * errors use the nested `{"error":{"code","message"}}` shape (issue #173's
 * decided format - this endpoint was born after that decision).
 *
 * Extracted from the route (routes/compose.cpp) so request_composer_test.cpp
 * can drive it against a real database without an in-process HTTP server,
 * matching the suite's other route tests.
 */
std::pair<int, nlohmann::json>
compose_request_core (vayu::db::Database& db, const nlohmann::json& body);

} // namespace vayu::http
