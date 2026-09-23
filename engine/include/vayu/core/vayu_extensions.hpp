#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/vayu_extensions.hpp
 * @brief The `x-vayu-request` / `x-vayu-collection` vendor extensions: what a
 *        Vayu export carries that OpenAPI has no member for, and the one
 *        reading of it an import makes.
 *
 * OpenAPI describes an API; a collection also holds how one client sends to
 * it - folder nesting, every header row as typed, a GraphQL body, the redirect
 * policy, a collection's variables. The standard members of an exported
 * document still say everything they can (so another tool reads a proper
 * document), and these two keys carry the rest, so that exporting a
 * collection and importing the file gives back what the UI showed:
 *
 * - `x-vayu-request` on an operation: the request's own `name`, `url`,
 *   `params`, `headers`, `body`, `auth`, `settings`, the `folder` path it is
 *   filed under, and its saved `examples` verbatim.
 * - `x-vayu-collection` at the document root: the collection's `variables`,
 *   `auth` and `dataSchema`, every folder (`path`, `description`, `variables`, `auth`,
 *   `elements`), and the `requests` no operation could hold (no path, or a
 *   second request on a method and path another already claimed).
 *
 * The earlier, narrower keys stay (`x-vayu-enabled`, `x-vayu-elements`,
 * `x-vayu-mock`): documents written before these existed still import.
 *
 * **Secrets never leave.** A token, password, API-key value, client secret or
 * a variable marked secret is written as `""` - unless its whole value is one
 * `{{variable}}` reference, which names a secret without being one. Every
 * value blanked is counted, so the export says how many there were.
 *
 * **An import trusts none of it.** A document can be edited by hand, so every
 * piece is checked here before it replaces what the standard members already
 * produced; a piece that fails is dropped and counted as
 * `vayu_extension_invalid`, and the request keeps the standard reading - never
 * an import refused over a vendor key.
 */

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <string_view>

namespace vayu::core::vayu_ext {

using Json = nlohmann::ordered_json;

/// The operation-level key.
constexpr std::string_view REQUEST_KEY = "x-vayu-request";
/// The document-root key.
constexpr std::string_view COLLECTION_KEY = "x-vayu-collection";
/// The tally kind a piece that fails its check is counted under.
constexpr std::string_view INVALID_KIND = "vayu_extension_invalid";

// --- Export ------------------------------------------------------------------

/**
 * A stored auth object with every secret blanked, `mode` and every other field
 * kept (`config` included, an OAuth 2.0 config's own secrets blanked the same
 * way). Adds one to @p omitted per value blanked.
 */
[[nodiscard]] Json redact_auth (const Json& auth, int& omitted);

/// A stored variables object with every `secret: true` value blanked.
[[nodiscard]] Json redact_variables (const Json& variables, int& omitted);

/**
 * A stored body as another machine can use it: a file part keeps its name,
 * type and declared file name, never the local path (`src`) it was read from,
 * which is one machine's filesystem and can carry a user name.
 */
[[nodiscard]] Json portable_body (const Json& body);

// --- Import ------------------------------------------------------------------

/**
 * Params / Headers rows the write routes accept (`key`, `value`, `enabled`,
 * and the optional `description` / `source`), or nothing when @p value is not
 * such an array. Unknown members are left behind rather than refused.
 */
[[nodiscard]] std::optional<Json> rows_of (const Json& value);

/// A request body in one of Vayu's own modes, or nothing.
[[nodiscard]] std::optional<Json> body_of (const Json& value);

/// An auth object naming one of Vayu's modes, or nothing. @p collection
/// refuses `inherit`, which a collection or folder cannot be.
[[nodiscard]] std::optional<Json> auth_of (const Json& value, bool collection);

/// A variables object (`name -> {value, enabled, secret?, type?}`), or nothing.
[[nodiscard]] std::optional<Json> variables_of (const Json& value);

/**
 * `settings` as the request fields it stands for (`followRedirects`,
 * `maxRedirects`, `httpVersion`, `verifySSL`, `stream`), or nothing when any
 * member present has the wrong type or value.
 */
[[nodiscard]] std::optional<Json> settings_of (const Json& value);

/// Saved examples as `POST /import/apply` takes them, or nothing.
[[nodiscard]] std::optional<Json> examples_of (const Json& value);

/// A collection's data contract (`columns`, `declaredAt`, `fileName`) inside
/// the bounds the collection route enforces, or nothing.
[[nodiscard]] std::optional<Json> data_schema_of (const Json& value);

/// A folder path - a non-empty array of non-empty strings - or nothing.
[[nodiscard]] std::optional<Json> folder_path_of (const Json& value);

} // namespace vayu::core::vayu_ext
