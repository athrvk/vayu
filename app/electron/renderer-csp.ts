/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Content-Security-Policy of the renderer document - the second layer
 * behind the window's own settings, so that markup reaching the DOM by mistake
 * is text rather than code with the renderer's privileges (#1780).
 *
 * Delivered one way: `vite-plugins/csp-meta.ts` stamps it into the built
 * `index.html` as a `<meta>`. The policy hashes that document's inline script,
 * a fact of the build, so it travels inside the document it describes rather
 * than in a header the app scheme's handler (`app-protocol.ts`) would have to
 * re-derive; and `engine-origin.ts` owns the session's single
 * `onHeadersReceived` listener (Electron keeps one per event per session).
 *
 * The packaged document is `vayu-app://app/index.html` (#2380), so every
 * `'self'` below names that one origin. Under the old `file:` load Chromium
 * matched `'self'` by scheme, which admitted any local file.
 *
 * Pure on purpose: the Vite config imports it, and it must not pull in Electron.
 */

import { createHash } from "node:crypto";
import { ENGINE_CANDIDATE_ORIGINS } from "./engine-endpoint.js";

/** The CSP source token for one inline script body, exactly as written in the file. */
export function inlineScriptHash(scriptBody: string): string {
	return `'sha256-${createHash("sha256").update(scriptBody, "utf8").digest("base64")}'`;
}

/** The text of every inline `<script>` (those with no `src`) in an HTML document. */
export function inlineScriptBodies(html: string): string[] {
	const bodies: string[] = [];
	for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
		bodies.push(match[1]);
	}
	return bodies;
}

/** The policy for the app document, allowing exactly the inline scripts given. */
export function buildRendererCsp(inlineScripts: readonly string[]): string {
	const scriptSrc = ["'self'", ...inlineScripts.map(inlineScriptHash)].join(" ");
	return [
		"default-src 'self'",
		`script-src ${scriptSrc}`,
		// Monaco and the charts set inline styles at runtime; styles cannot run code.
		"style-src 'self' 'unsafe-inline'",
		// Every candidate, named: the port is chosen at runtime and this is a
		// build-time <meta> (#2118). Never `127.0.0.1:*`, which would reach the
		// MCP port and every other local service.
		`connect-src 'self' ${ENGINE_CANDIDATE_ORIGINS.join(" ")}`,
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		// Monaco's editor workers are blob URLs.
		"worker-src 'self' blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		// `default-src` does not cover form submission; the navigation guard
		// refuses the result too, and this is the layer in front of it.
		"form-action 'none'",
	].join("; ");
}
