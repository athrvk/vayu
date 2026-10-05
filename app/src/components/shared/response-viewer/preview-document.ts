/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The document the HTML Preview frame renders: the server's markup with a
 * policy and a link treatment placed in front of it.
 *
 * The frame is `sandbox=""` (see `ResponseBody.tsx`), so the opaque origin,
 * the absence of script, forms, popups and top navigation are the sandbox's
 * doing. This adds the two things a sandbox cannot say:
 *
 * - **No network.** A srcdoc document resolves relative URLs against the
 *   renderer's own base URL and an absolute one reaches any host, the engine's
 *   loopback port included, so a preview that fetched its subresources would
 *   send GETs wherever the response told it to. Images, fonts and media load
 *   only from `data:`; stylesheets only inline. A page that leans on a CDN
 *   renders unstyled, which is the price of a preview that contacts nobody.
 * - **Inert links.** `<base target="_top">` sends an ordinary link at the top
 *   window, which the sandbox refuses without `allow-top-navigation`. A link
 *   that names `target="_self"` still navigates inside the frame; the new page
 *   stays sandboxed (no script, opaque origin), it only loses this policy.
 *
 * Both go first in the document: a `<meta>` policy governs only what parses
 * after it, the first `<base>` with a target wins, and several policies
 * intersect, so markup that follows can tighten neither away.
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
