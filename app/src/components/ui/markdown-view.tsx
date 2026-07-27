/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Rendered markdown, for description fields.
 *
 * **The content here is not all hand-typed.** Descriptions arrive from imported
 * Postman, Insomnia and OpenAPI files - third-party documents off the internet -
 * and until now Vayu stored that markdown and displayed none of it, which is the
 * only reason it never mattered. Rendering it changes that, so three decisions
 * are load-bearing rather than stylistic:
 *
 * **1. No navigating anchors, ever.** `electron/main.ts` sets
 * `contextIsolation: true` and `nodeIntegration: false`, but the main window has
 * no `will-navigate` handler, no `setWindowOpenHandler` and no CSP - the only
 * `setWindowOpenHandler` in the tree is in `oauth.ts`. A clicked `<a href>`
 * would therefore navigate the whole renderer, and the preload re-runs on the
 * new origin, handing `window.electronAPI` to it. So the `a` renderer below
 * emits a `<button>`: no `href` reaches the DOM, and the click goes to the
 * scheme-validated `openExternalUrl` path, which refuses anything that is not
 * http(s).
 *
 * **2. `react-markdown`, not `marked`.** It builds React elements from an AST
 * rather than an HTML string, so there is no `dangerouslySetInnerHTML` and no
 * sanitizer for anyone to forget. Raw HTML in the source is ignored - that needs
 * `rehype-raw`, which is deliberately not installed.
 *
 * **3. The default `urlTransform` stays.** Overriding it disables
 * react-markdown's own URL sanitising, which has a published advisory against
 * exactly that mistake. `remark-gfm` is on for tables (imported Postman
 * descriptions use them), and it also turns bare URLs into autolinks - the `a`
 * override covers those too, since they arrive as the same node type.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Block-level elements a description has any business containing.
 *
 * An allow-list rather than a deny-list: a deny-list has to be updated every
 * time the markdown spec or a plugin grows a node type, and the failure mode of
 * forgetting is that the new one renders.
 */
const ALLOWED = [
	"p",
	"br",
	"strong",
	"em",
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

export interface MarkdownViewProps {
	children: string;
	className?: string;
}

/** Open in the system browser, never in this window. */
function openExternal(url: string) {
	void window.electronAPI?.openExternalUrl?.(url);
}

export function MarkdownView({ children, className }: MarkdownViewProps) {
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
			code: ({
				children: c,
				className: cls,
			}: {
				children?: React.ReactNode;
				className?: string;
			}) => {
				// react-markdown gives fenced blocks a `language-*` class and inline
				// code none, which is the only way to tell them apart here.
				const isBlock = !!cls?.startsWith("language-");
				return isBlock ? (
					<code className="font-mono text-xs">{c}</code>
				) : (
					<code className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">{c}</code>
				);
			},
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
		<div
			className={cn(
				"text-sm leading-relaxed text-foreground",
				"[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				"[&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_blockquote]:mb-2 [&_pre]:mb-2 [&_table]:mb-2",
				"[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5",
				"[&_blockquote]:border-l-2 [&_blockquote]:border-primary/45 [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground",
				"[&_hr]:my-3 [&_hr]:border-rule",
				className
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
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
		</div>
	);
}

function Heading({ children }: { children?: React.ReactNode }) {
	return <h3 className="mb-1 mt-3 text-md font-semibold text-foreground">{children}</h3>;
}
