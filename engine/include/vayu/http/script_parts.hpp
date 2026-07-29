// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace vayu::http {

/**
 * Read a script from a run payload.
 *
 * Two forms are accepted. `list_key` is a list of parts, each recording the
 * collection or request it came from; the engine joins them. `legacy_key` is
 * the older single pre-joined string, kept because the engine is a standalone
 * binary with a documented HTTP API. The list wins when both are sent; they are
 * never merged.
 *
 * Parts are joined with "\n\n" and the result is run as ONE script, so a
 * `const` declared in a collection's part is visible to the request's part. Do
 * not run the parts separately, and do not change the separator: a syntax error
 * reports a line number counted from the start of the joined text.
 *
 * Parts that are empty or only whitespace are dropped. The renderer used to
 * keep them and MCP used to drop them; this is now the single rule.
 */
std::string read_script (const nlohmann::json& json, const char* list_key, const char* legacy_key);

/**
 * Read the pre-request script from an execution payload.
 *
 * Accepted under `preRequestScripts` (list) or `preRequestScript` (string).
 *
 * Only `POST /execute` runs one - `POST /runs` has no pre-request hook - so a
 * load payload carrying the field is not an error, it simply has nowhere to run
 * it. That asymmetry is the engine's, not a client's.
 */
std::string read_pre_request_script (const nlohmann::json& json);

/**
 * Read the post-request (test) script from an execution payload.
 *
 * **One script, several names.** It is stored as `postRequestScript`, `POST
 * /execute` grew up calling it `postRequestScript`/`postRequestScripts`, and
 * `POST /runs` calls it `tests`. They mean the same thing, so both endpoints
 * read all of them through here and a payload composed for one endpoint can be
 * sent to the other unchanged. Before this, a `tests` key reached `/execute`
 * and a `postRequestScripts` key reached `/runs` and both were silently
 * dropped - each endpoint only knew its own spelling.
 *
 * The names are tried in a fixed order (`postRequestScripts`,
 * `postRequestScript`, then `tests` in either form) and the **first that yields
 * a non-blank script wins**; they are never merged. Add a new spelling to the
 * table in the .cpp, not to a call site - a name known in one route and not the
 * other is exactly the defect this replaced.
 */
std::string read_post_request_script (const nlohmann::json& json);

} // namespace vayu::http
