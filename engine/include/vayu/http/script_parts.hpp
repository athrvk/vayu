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

} // namespace vayu::http
