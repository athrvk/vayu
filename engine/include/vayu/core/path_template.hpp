#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/path_template.hpp
 * @brief The one engine-side copy of `normalizeVars`, in both of the shapes the
 *        renderer calls it in.
 *
 * It lived inside `http/routes/mock_server.cpp` while the mock server was its
 * only reader, and moved here when a second one arrived: the request drafts an
 * import would build (`core/openapi_drafts` under issue #865) write their URL
 * through exactly this rewrite, which is *why* the mock server can route them.
 * Two copies of it would be two answers to "what does `{petId}` become", and
 * the failure that produces - an imported request the mock silently cannot
 * route - is invisible until a 404 nobody can explain.
 *
 * Pinned to the app's copy by `tests/fixtures/path-template-conformance.json`,
 * read by `mock_server_routes_test.cpp` and by the app's
 * `path-template.conformance.test.ts`.
 */

#include <string>

namespace vayu::core {

/**
 * @brief Tighten the `{{ }}` spellings in @p text, and nothing else -
 *        `normalizeVars(text)` with `pathTemplates` off.
 *
 * `{{ x }}` and `{{ _.x }}` become `{{x}}`. A **single** brace is left exactly
 * as written, which is the whole difference from
 * @ref normalize_path_templates: Postman and Insomnia template with `{{x}}`
 * alone, so `fields=friends{name}` and a path segment `/tags/{beta}` are
 * literal text there, and rewriting them would invent a variable reference
 * that resolves to nothing at execution.
 *
 * Every value an import carries out of those two formats goes through this -
 * a URL, a header value, a variable, an auth secret (issue #877).
 */
[[nodiscard]] std::string normalize_template_vars (const std::string& text);

/**
 * @brief Rewrite every template spelling in @p path to `{{name}}`.
 *
 * `{{ x }}` and `{{ _.x }}` tighten to `{{x}}`, a single-brace `{x}` becomes
 * `{{x}}`, and anything that fits neither shape (a Nunjucks filter, `{a|b}`) is
 * left verbatim rather than guessed at - a rewrite that changes what gets sent
 * has to be certain of what it is looking at.
 *
 * Path only: the `:param` spelling Postman writes is the mock server's own
 * concern, since no OpenAPI document contains one.
 */
[[nodiscard]] std::string normalize_path_templates (const std::string& path);

} // namespace vayu::core
