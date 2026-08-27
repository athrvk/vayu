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
 *  - unknown plain name resolves to ""; unknown `$name` keeps its braces
 *  - a `data.*` name keeps its braces too: it addresses the reserved data
 *    namespace (issue #402), which only a scenario run's iteration can bind
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
 * only joined per row afterwards (`core::tokenize_data_fields`).
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
 * (kept verbatim), then scopes, then the dynamic-variable table; a name
 * nothing answers - ordinary or `$name` - keeps its braces (#186, #1009), and
 * a value that itself holds tokens is resolved through them under
 * `substitute_tokens`' bound. Nested braces never match.
 */
std::string resolve_template (const std::string& input, const VariableValues& vars);

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
 * never reaches a request through the binder** - `apply_data_template` refuses
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
 */
nlohmann::json resolve_json_strings (const nlohmann::json& value, const VariableValues& vars);

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
