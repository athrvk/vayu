/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Monaco surface this app actually configures and hands around.
 *
 * `monaco-editor`'s package root is the full barrel: the editor core, all ~85
 * Monarch grammars, all four language services, and an LSP client. Importing
 * it made the build emit two web workers - `css.worker` and `html.worker`,
 * 1.7MB together - that `monaco-setup`'s `getWorker` never constructs, plus
 * grammars for languages nothing here can put in a model (#1147). So
 * `monaco-setup` composes the entry itself, and what it exports is the
 * barrel's namespace minus three members no call site reads:
 *
 * - `css` and `html` - the CSS and HTML *language services* (validation,
 *   completion, formatting, colour decorators), which are what pull those two
 *   workers. Their Monarch grammars are still loaded, so a `text/html` or
 *   `text/css` response body is still syntax-highlighted; what a body loses is
 *   language-service extras the read-only viewer never offered.
 * - `lsp` - the `monaco-lsp-client` re-export, unused here.
 *
 * Written as an `Omit` of the package's own type rather than as a hand-written
 * shape so that the composed object in `monaco-setup.ts` is checked against
 * monaco's real API: a version that moves `typescript` or `json` fails to
 * compile there rather than going missing at runtime. That is not a hypothetical
 * - 0.56 reorganised the entry points under an `exports` map and this type is
 * what pinned the composed object to the barrel through it (#1342).
 *
 * `createWebWorker` used to be omitted here too, as a barrel-only export
 * nothing calls. 0.56's barrel no longer exports it at all, so naming it would
 * be omitting a key that is not there.
 */
import type * as Monaco from "monaco-editor";

export type MonacoApi = Omit<typeof Monaco, "css" | "html" | "lsp">;
