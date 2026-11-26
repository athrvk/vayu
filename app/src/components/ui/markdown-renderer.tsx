/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The markdown pipeline: react-markdown and the remark/rehype chain, its own chunk because the
 * parsers were ~300KB of the entry chunk for a panel most sessions never open (#1146).
 * `MarkdownView` is the lazy boundary and the only importer; import nothing from here directly.
 *
 * **The content is not all hand-typed**: descriptions arrive from imported Postman, Insomnia and
 * OpenAPI files off the internet. Four decisions are load-bearing:
 *
 * **1. No navigating anchors, ever.** A clicked `<a href>` navigates the renderer, and the preload
 * reruns on the new origin, handing it `window.electronAPI`. So the `a` renderer emits a
 * `<button>`: no `href` reaches the DOM, and the click goes to the scheme-validated
 * `openExternalUrl`, which refuses all but http(s). Not the only layer (#822): beside
 * `contextIsolation: true` and `nodeIntegration: false`, `electron/main.ts` installs
 * `electron/window-navigation.ts`, refusing a navigation off the app's document and denying
 * `window.open`, and the document carries a CSP (`electron/renderer-csp.ts`). Keep this anyway: a
 * refused navigation is a link that silently does nothing, where the button reaches the user's
 * browser.
 *
 * **2. `react-markdown`, not `marked`.** It builds React elements from an AST, not an HTML string,
 * so there is no `dangerouslySetInnerHTML` and no sanitizer to forget.
 *
 * **3. Raw HTML is rendered and sanitized in the same pipeline.** Vendor documents write HTML
 * descriptions (Stripe's OpenAPI writes every operation's as `<p>...</p>`), which is spec-legal, as
 * CommonMark admits inline HTML, and inert HTML put the tags on screen as text. `rehype-raw` parses
 * it and **`rehype-sanitize` immediately prunes the result** against the allow-list below. The
 * order is load-bearing: sanitizing first sanitizes a tree the payload is not in, and every hostile
 * case renders. `markdown-view.test.tsx`'s hostile tests go red if the two swap. Sanitizing prunes
 * hast *nodes*, so decision 2 holds; `allowedElements` is a second gate on the same list, after the
 * plugins.
 *
 * **4. The default `urlTransform` stays.** Overriding it disables react-markdown's URL sanitising,
 * the mistake a published advisory names. `remark-gfm` is on for tables (imported Postman
 * descriptions use them) and also autolinks bare URLs, which the `a` override covers as the same
 * node type.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { type Options as SanitizeSchema } from "rehype-sanitize";
import { openExternal } from "@/lib/open-external";

/**
 * Elements a description has any business containing. An allow-list: a deny-list must grow with
 * every new node type, and forgetting lets the new one render. `b` and `i` are here because raw
 * HTML is parsed: a hand-written or generated description uses them where markdown yields `strong`
 * and `em`, and dropping them would unwrap a vendor's emphasis.
 */
const ALLOWED = [
	"p",
	"br",
	"strong",
	"b",
	"em",
	"i",
	"del",
	"code",
	"pre",
	"a",
	"ul",
	"ol",
	"li",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
];

/**
 * What survives sanitisation, derived from `ALLOWED` so the two gates cannot disagree. `href` on an
 * anchor is the only attribute anything reads, so the only one kept. **`class` is never kept**: an
 * internet description has no business naming the app's stylesheet, and the cheapest attack is not
 * a script but `<p class="fixed inset-0 z-50">`, an invisible sheet over the window. `protocols` is
 * narrower than the default (which passes `irc`, `ircs`, `mailto`, `xmpp`): a link here only
 * reaches `openExternalUrl`, which refuses all but http(s), so another scheme would be a button
 * lying about being clickable. Unspecified keys fall back to `defaultSchema` (`hast-util-sanitize`
 * merges shallowly), so GitHub's clobber prefix and the table parts' ancestor map stay in force.
 */
const SANITIZE_SCHEMA: SanitizeSchema = {
	tagNames: ALLOWED,
	attributes: { a: ["href"] },
	protocols: { href: ["http", "https"] },
	/*
	 * An element outside `tagNames` is *unwrapped* (it goes, its children stay), right for prose in
	 * a `<div>` and wrong for non-prose: an unwrapped `<style>` puts its CSS on screen. The default
	 * schema strips `script` for that reason; `style` needs saying.
	 */
	strip: ["script", "style"],
};

export default function MarkdownRenderer({ children }: { children: string }) {
	const components = useMemo(
		() => ({
			/*
			 * A link is a button, not an anchor (see the header): it looks and reads like a link
			 * and cannot navigate this window. The destination is its `title`, inspectable before a
			 * click, as an anchor's status bar would give.
			 */
			a: ({ href, children: label }: { href?: string; children?: React.ReactNode }) => (
				<button
					type="button"
					title={href}
					onClick={(e) => {
						/*
						 * The render often sits inside a click-to-edit block (`MarkdownEditor`),
						 * where the same click would follow the link and open the source; a test
						 * holds it.
						 */
						e.stopPropagation();
						if (href) void openExternal(href);
					}}
					className="text-primary-text underline underline-offset-2 transition-opacity hover:opacity-80 font-[inherit] text-[inherit]"
				>
					{label}
				</button>
			),
			// Headings in a description mark sections in a small panel, not page titles: all at the
			// title step, told apart by weight, not six sizes nobody chose.
			h1: Heading,
			h2: Heading,
			h3: Heading,
			h4: Heading,
			h5: Heading,
			h6: Heading,
			/*
			 * Inline code only, told apart by position: the `language-*` class react-markdown puts
			 * on a fence does not survive sanitisation and never exists on a vendor's raw
			 * `<pre><code>`. This paints the pill, and `MarkdownView`'s container flattens it for
			 * any `code` inside a `pre`.
			 */
			code: ({ children: c }: { children?: React.ReactNode }) => (
				<code className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">{c}</code>
			),
			pre: ({ children: c }: { children?: React.ReactNode }) => (
				<pre className="overflow-x-auto rounded-md bg-muted p-2.5 text-xs">{c}</pre>
			),
			table: ({ children: c }: { children?: React.ReactNode }) => (
				// Its own scroller, so a wide imported table does not scroll the panel sideways.
				<div className="overflow-x-auto">
					<table className="w-full border-collapse text-xs">{c}</table>
				</div>
			),
			th: ({ children: c }: { children?: React.ReactNode }) => (
				<th className="border border-rule px-2 py-1 text-left font-semibold">{c}</th>
			),
			td: ({ children: c }: { children?: React.ReactNode }) => (
				<td className="border border-rule px-2 py-1 align-top">{c}</td>
			),
		}),
		[]
	);

	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			// Raw first, then sanitise: reversed, the sanitiser runs on a tree the raw HTML is not
			// yet parsed into, both plugins installed and no protection.
			rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]}
			allowedElements={ALLOWED}
			unwrapDisallowed
			// `components` replaces anchors with non-navigating buttons: omitted, the security
			// property is silently gone, so a test renders a link and asserts no `href` reaches the
			// DOM.
			components={components}
		>
			{children}
		</ReactMarkdown>
	);
}

function Heading({ children }: { children?: React.ReactNode }) {
	return <h3 className="mb-1 mt-3 text-md font-semibold text-foreground">{children}</h3>;
}
