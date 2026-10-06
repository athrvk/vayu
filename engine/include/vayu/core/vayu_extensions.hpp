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
#include <vector>

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
 * kept. The named credentials (`token`, `password`, an API key's `value`) are
 * blanked by name; a `config` bag - an OAuth 2.0 config, or the data-only AWS,
 * digest, NTLM, Hawk, OAuth 1.0, EdgeGrid and JWT modes - is blanked by
 * allowlist instead: every member not known to describe the auth rather than
 * carry a credential is emptied, so a name this file never heard of
 * (Insomnia's `secretAccessKey`) does not leave. Adds one to @p omitted per
 * value blanked.
 */
[[nodiscard]] Json redact_auth (const Json& auth, int& omitted);

/**
 * A Postman `auth` block as a file wrote it - v2.1's attribute arrays
 * (`{"type": "bearer", "bearer": [{"key": "token", "value": ...}]}`) or v2.0's
 * detail objects - with every secret value blanked in place, by the same rules
 * and the same `{{variable}}` exemption `redact_auth` uses (the allowlist for
 * the config-bag types, the credential names for the rest). Used for the
 * `postman` source a Postman import keeps on a stored auth, and for a stored
 * example's recorded request (`originalRequest.auth`). Adds one to @p omitted
 * per value blanked.
 */
void redact_postman_auth (Json& source, int& omitted);

/// A stored variables object with every `secret: true` value blanked.
[[nodiscard]] Json redact_variables (const Json& variables, int& omitted);

/**
 * The header names an API-key auth sends its key under: `{mode: "apikey",
 * key: "X-Tenant-Token", in: "header"}` names `X-Tenant-Token`, which no static
 * list can know. Empty for every other mode, and for an API key placed in the
 * query. @p auth is the auth in force for the request (an `inherit` already
 * resolved), as the caller's `redact_auth` input is.
 */
[[nodiscard]] std::vector<std::string> apikey_header_names (const Json& auth);

/// The query-parameter name an API-key auth placed `in: "query"` sends its
/// key under; empty otherwise. The counterpart of @ref apikey_header_names.
[[nodiscard]] std::vector<std::string> apikey_param_names (const Json& auth);

/**
 * A header table (`[{key, value, enabled}, ...]`) with each credential's value
 * blanked in place: the row and its key stay, so the export still says which
 * header was sent. A value is a credential when its name is a sensitive header
 * (`utils::is_secret_header_name`, the set the logger redacts) or one of
 * @p extra_header_names (@ref apikey_header_names), whether the row is enabled
 * or not. An empty value and a value that is exactly one `{{variable}}`
 * reference are kept. Adds one to @p omitted per value blanked; anything but
 * an array of objects is left alone.
 */
void blank_credential_rows (Json& rows,
const std::vector<std::string>& extra_header_names,
int& omitted);

/**
 * A Params table with each credential's value blanked in place, by the same
 * keep-the-row rule as @ref blank_credential_rows. The name set is narrower
 * than a header's: a query parameter is data far more often than a header is,
 * so the generic `code` (`?code=US`) is not a credential here, and `key`
 * (a cache key, a sort key) is not either. @p extra_param_names adds what an
 * API-key auth placed in the query names (@ref apikey_param_names).
 */
void blank_credential_param_rows (Json& rows,
const std::vector<std::string>& extra_param_names,
int& omitted);

/**
 * A `[{key, value, ...}, ...]` list of cookies (a Postman saved response's
 * `cookie[]`) with every cookie's value blanked in place, whatever its name:
 * a cookie name does not say whether the value is a session. The name and the
 * other members stay. An empty value and a value that is exactly one
 * `{{variable}}` reference are kept. Adds one to @p omitted per value blanked;
 * anything but an array of objects is left alone.
 */
void blank_cookie_values (Json& cookies, int& omitted);

/**
 * A URL with its credentials blanked and everything else kept: the password
 * of `user:pass@host` is dropped (the user name stays), and the value of a
 * query parameter whose name @ref blank_credential_param_rows treats as a
 * credential is emptied (`?api_key=S&page=2` becomes `?api_key=&page=2`).
 * Unlike `utils::strip_url_secrets`, which keeps scheme, host and path for a
 * log line, this loses no query data an import would need. A `{{variable}}`
 * reference stays wherever it stands alone. Adds one to @p omitted per value
 * dropped.
 */
[[nodiscard]] std::string redact_url_credentials (std::string_view url,
const std::vector<std::string>& extra_param_names,
int& omitted);

/**
 * A stored body as another machine can use it: a file part, or a binary body's
 * `file`, keeps its type, declared file name and content type, never the local
 * path (`src`) it was read from - one machine's filesystem, which can carry a
 * user name - nor `unresolved`, which describes that path.
 */
[[nodiscard]] Json portable_body (const Json& body);

// --- Import ------------------------------------------------------------------

/**
 * Params / Headers rows the write routes accept (`key`, `value`, `enabled`,
 * and the optional `description` / `source`), or nothing when @p value is not
 * such an array. Unknown members are left behind rather than refused.
 */
[[nodiscard]] std::optional<Json> rows_of (const Json& value);

/**
 * Params rows: @ref rows_of plus a row's `in` (`"path"` marks a `:name` path
 * variable, issue #1764) and the `type` a Postman path variable carries, so
 * an `x-vayu-request` re-import keeps a path row a path row, and a query
 * row's `valueless: true`, which writes it as a bare `key`.
 */
[[nodiscard]] std::optional<Json> param_rows_of (const Json& value);

/// A request body in one of Vayu's own modes, or nothing. A file path it
/// carries (a form file part's or a binary body's `src`, which a hand-edited
/// document may hold) is kept and marked `unresolved`: no one chose it here.
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
