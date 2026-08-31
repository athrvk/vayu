/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The markdown pipeline itself - react-markdown plus the remark/rehype chain.
 *
 * Split out of `markdown-view.tsx` so that chain is its own chunk: descriptions
 * are a panel most sessions never open, and the parsers were ~300KB of the
 * entry chunk parsed before the window could appear (#1146). `MarkdownView` is
 * the lazy boundary in front of it and the only importer; nothing else should
 * import this module directly.
 *
 * **The content here is not all hand-typed.** Descriptions arrive from imported
 * Postman, Insomnia and OpenAPI files - third-party documents off the internet -
 * and until now Vayu stored that markdown and displayed none of it, which is the
 * only reason it never mattered. Rendering it changes that, so four decisions
 * are load-bearing rather than stylistic:
 *
 * **1. No navigating anchors, ever.** A clicked `<a href>` navigates the whole
 * renderer, and the preload re-runs on the new origin, handing
 * `window.electronAPI` to it. So the `a` renderer below emits a `<button>`: no
 * `href` reaches the DOM, and the click goes to the scheme-validated
 * `openExternalUrl` path, which refuses anything that is not http(s).
 *
 * This is no longer the only layer. #822 put the refusal underneath it that this
 * note used to say was missing: beside `contextIsolation: true` and
 * `nodeIntegration: false`, `electron/main.ts` now installs
 * `electron/window-navigation.ts` on the main window, which refuses a navigation
 * that is not the app's own document and denies `window.open`. There is still no
 * CSP. Keep this override anyway - a refused navigation is a link that silently
 * does nothing, where a button reaches the user's browser, which is what they
 * meant.
 *
 * **2. `react-markdown`, not `marked`.** It builds React elements from an AST
 * rather than an HTML string, so there is no `dangerouslySetInnerHTML` and no
 * sanitizer for anyone to forget.
 *
 * **3. Raw HTML is rendered, and it is sanitized in the same pipeline.** This
 * decision changed, and the reason is worth keeping. `rehype-raw` used to be
 * deliberately absent, which made raw HTML inert - correct while nothing shipped
 * HTML descriptions. Stripe's official OpenAPI document writes *every* operation
 * description as HTML (`<p>Retrieves the details of an account.</p>`), which is
 * spec-legal - OpenAPI `description` fields are CommonMark, and CommonMark
 * admits inline HTML - so the tags were on screen as literal text. `rehype-raw`
 * now parses them and **`rehype-sanitize` immediately prunes the result**
 * against the allow-list below.
 *
 * That order is load-bearing, not stylistic: sanitizing before the raw HTML is
 * parsed sanitizes a tree the payload is not in yet, and every hostile case
 * below would render. The hostile tests in `markdown-view.test.tsx` are what
 * hold the order - swap the two plugins and they go red.
 *
 * Sanitizing prunes hast *nodes*; react-markdown still emits React elements
 * from the pruned tree, so decision 2's real property - no HTML string, no
 * `dangerouslySetInnerHTML` - is unchanged. `allowedElements` below is a second
 * gate over the same list, applied after the plugins.
 *
 * **4. The default `urlTransform` stays.** Overriding it disables
 * react-markdown's own URL sanitising, which has a published advisory against
 * exactly that mistake. `remark-gfm` is on for tables (imported Postman
 * descriptions use them), and it also turns bare URLs into autolinks - the `a`
 * override covers those too, since they arrive as the same node type.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { type Options as SanitizeSchema } from "rehype-sanitize";

/**
 * Elements a description has any business containing.
 *
 * An allow-list rather than a deny-list: a deny-list has to be updated every
 * time the markdown spec or a plugin grows a node type, and the failure mode of
 * forgetting is that the new one renders.
 *
 * `b` and `i` earn their place now that raw HTML is parsed: they are what a
 * hand-written or generator-emitted description uses where markdown would have
 * produced the `strong` and `em` already here, and dropping them would unwrap
 * emphasis a vendor did write.
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
 * What survives sanitisation. Derived from `ALLOWED` rather than re-typed, so
 * the two gates cannot drift into disagreeing about the same question.
 *
 * `href` on an anchor is the only attribute anything below reads, so it is the
 * only one kept. **`class` in particular is never kept**: a description off the
 * internet has no business naming this app's stylesheet, and the cheapest
 * attack on a renderer that keeps it is not a script but
 * `<p class="fixed inset-0 z-50">` - an invisible sheet over the whole window.
 *
 * `protocols` is narrower than the default (which also passes `irc`, `ircs`,
 * `mailto` and `xmpp`) because a link here can do exactly one thing: go to
 * `openExternalUrl`, which refuses any scheme but http(s). An `href` that
 * survives sanitisation only to be refused at the other end is a button that
 * lies about being clickable.
 *
 * Every key left unspecified falls back to `defaultSchema` - `hast-util-sanitize`
 * merges shallowly (`{...defaultSchema, ...options}`) - so GitHub's clobber
 * prefix and the required-ancestor map for table parts stay in force instead of
 * being restated here and drifting.
 */
const SANITIZE_SCHEMA: SanitizeSchema = {
	tagNames: ALLOWED,
	attributes: { a: ["href"] },
	protocols: { href: ["http", "https"] },
	/*
	 * An element outside `tagNames` is *unwrapped* by default: it goes, its
	 * children stay. That is right for prose in a `<div>` or a `<span>` and
	 * wrong where the content is not prose - an unwrapped `<style>` puts its CSS
	 * on screen as words. The default schema strips `script` for that reason;
	 * `style` needs saying.
	 */
	strip: ["script", "style"],
};

/** Open in the system browser, never in this window. */
function openExternal(url: string) {
	void window.electronAPI?.openExternalUrl?.(url);
}

export default function MarkdownRenderer({ children }: { children: string }) {
	const components = useMemo(
		() => ({
			/*
			 * A link is a button, not an anchor - see the note at the top. It still
			 * looks and reads like a link; it simply cannot navigate this window.
			 * The destination goes in `title` so it is inspectable before clicking,
			 * which a real anchor would have given via the status bar.
			 */
			a: ({ href, children: label }: { href?: string; children?: React.ReactNode }) => (
				<button
					type="button"
					title={href}
					onClick={(e) => {
						/*
						 * The render is often itself inside a click-to-edit block
						 * (`MarkdownEditor`), and without this the same click both
						 * follows the link and drops the reader into the source. That
						 * is not hypothetical - it is what happened until a test
						 * caught it.
						 */
						e.stopPropagation();
						if (href) openExternal(href);
					}}
					className="text-primary-text underline underline-offset-2 hover:opacity-80 font-[inherit] text-[inherit]"
				>
					{label}
				</button>
			),
			// Headings in a description are section markers inside a small panel,
			// not page titles - they all render at the title step, distinguished by
			// weight rather than by six sizes nobody chose.
			h1: Heading,
			h2: Heading,
			h3: Heading,
			h4: Heading,
			h5: Heading,
			h6: Heading,
			/*
			 * Inline code, and only inline code. A fenced block used to be told apart
			 * by the `language-*` class react-markdown puts on it - which no longer
			 * survives sanitisation, and never existed on a raw `<pre><code>` a vendor
			 * pasted in, so that one was already painted as a pill inside its own box.
			 * Position answers it for both: this paints the pill, and the container
			 * in `MarkdownView` flattens it back out for any `code` sitting inside a
			 * `pre`.
			 */
			code: ({ children: c }: { children?: React.ReactNode }) => (
				<code className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">{c}</code>
			),
			pre: ({ children: c }: { children?: React.ReactNode }) => (
				<pre className="overflow-x-auto rounded-md bg-muted p-2.5 text-xs">{c}</pre>
			),
			table: ({ children: c }: { children?: React.ReactNode }) => (
				// Its own scroller: a wide table from an imported collection must not
				// make the whole panel scroll sideways.
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
			// Raw first, sanitise immediately after. Reversing these two sanitises
			// a tree the raw HTML has not been parsed into yet, which is the one
			// way to have both plugins installed and no protection at all.
			rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]}
			allowedElements={ALLOWED}
			unwrapDisallowed
			// `components` is what replaces anchors with non-navigating buttons.
			// Omitting it is not a styling regression - it is the security
			// property silently gone, which is why a test renders a link and
			// asserts no `href` reaches the DOM.
			components={components}
		>
			{children}
		</ReactMarkdown>
	);
}

function Heading({ children }: { children?: React.ReactNode }) {
	return <h3 className="mb-1 mt-3 text-md font-semibold text-foreground">{children}</h3>;
}
