/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Plugin } from "vite";
import { buildRendererCsp, inlineScriptBodies } from "../electron/renderer-csp";

/**
 * Stamp the renderer's Content-Security-Policy into the built `index.html` as a
 * `<meta>` (#1780). A packaged app loads the document from `file://`, where no
 * response header exists to carry it.
 *
 * Build only: the dev server injects its own inline React-refresh preamble,
 * which a hash-only policy would block. The policy hashes whatever inline
 * scripts the built document holds, so editing the pre-paint script in
 * `index.html` never needs a second edit here.
 */
export function cspMeta(): Plugin {
	return {
		name: "vayu:csp-meta",
		apply: "build",
		transformIndexHtml: {
			order: "post",
			handler(html) {
				const policy = buildRendererCsp(inlineScriptBodies(html));
				const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
				return html.replace("<head>", `<head>\n\t\t${meta}`);
			},
		},
	};
}
