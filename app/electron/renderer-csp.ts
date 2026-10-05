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
 * One builder serves both deliveries: the main process sets it as a response
 * header, and `vite-plugins/csp-meta.ts` stamps it into the built `index.html`
 * as a `<meta>`, which is the only one that applies to a packaged `file://`
 * load. Both hash the same inline script, so they cannot disagree.
 *
 * Pure on purpose: the Vite config imports it, and it must not pull in Electron.
 */

import { createHash } from "node:crypto";
import { ENGINE_HOST, ENGINE_PORT } from "./constants.js";

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
		`connect-src 'self' http://${ENGINE_HOST}:${ENGINE_PORT}`,
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		// Monaco's editor workers are blob URLs.
		"worker-src 'self' blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
	].join("; ");
}
