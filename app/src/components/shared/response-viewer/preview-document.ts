/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The document the HTML Preview frame renders: the server's markup with a policy and link treatment
 * in front. The frame is `sandbox=""` (`ResponseBody.tsx`), so the opaque origin and the absence of
 * script, forms, popups and top navigation are the sandbox's; this adds what a sandbox cannot say:
 *
 * - **No network.** A srcdoc document resolves relative URLs against the renderer's base and
 *   absolute ones reach any host, the engine's loopback port included, so a fetching preview would
 *   send GETs wherever the response said. Images, fonts and media load only from `data:`,
 *   stylesheets only inline; a CDN-reliant page renders unstyled, the price of contacting nobody.
 * - **Inert links.** `<base target="_top">` aims an ordinary link at the top window, which the
 *   sandbox refuses without `allow-top-navigation`. A `target="_self"` link still navigates in the
 *   frame; the new page stays sandboxed (no script, opaque origin) and only loses this policy.
 *
 * Both go first: a `<meta>` policy governs only what parses after it, the first targeted `<base>`
 * wins, and policies intersect, so later markup cannot loosen either. The preview's one policy
 * (#1780), in the document, not an iframe `csp` attribute: under `sandbox=""` a `<meta>` policy is
 * enforced without `allow-same-origin`, and the renderer's own policy, inherited by a srcdoc frame,
 * intersects with it.
 */

export const PREVIEW_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"img-src data:",
	"font-src data:",
	"media-src data:",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

const PREVIEW_HEAD =
	`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
	`<base target="_top">` +
	"<style>a { cursor: not-allowed !important; }" +
	" a:hover { text-decoration: none !important; opacity: 0.7; }</style>";

/** A leading doctype stays first, or the page would render in quirks mode. */
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

export function buildPreviewDocument(html: string): string {
	const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
	return doctype + PREVIEW_HEAD + html.slice(doctype.length);
}
