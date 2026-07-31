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
 *        `inherit` auth resolution (issue #226, backlog A1).
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

#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
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
 * Substitute `{{name}}` occurrences in one pass. Scopes first, then the
 * dynamic-variable table; an ordinary unknown name becomes "", an unknown
 * `$name` keeps its braces. Nested braces never match and replacements are
 * never rescanned.
 */
std::string resolve_template (const std::string& input, const VariableValues& vars);

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
