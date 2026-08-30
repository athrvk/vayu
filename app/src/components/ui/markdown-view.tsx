/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Rendered markdown, for description fields.
 *
 * The prose styling lives here; the pipeline that turns markdown into elements -
 * react-markdown, remark-gfm, rehype-raw, rehype-sanitize, and the four
 * load-bearing security decisions behind them - lives in `markdown-renderer.tsx`
 * and is loaded on first render rather than at startup (#1146). This component
 * is the only importer of that module, and the boundary is the whole reason it
 * is a separate file: `MarkdownView` reaches the entry chunk through the `ui`
 * barrel, so an eager parser chain here is a parser chain in every cold start,
 * for a description panel most sessions never open.
 */

import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

const MarkdownRenderer = lazy(() => import("./markdown-renderer"));

export interface MarkdownViewProps {
	children: string;
	className?: string;
}

export function MarkdownView({ children, className }: MarkdownViewProps) {
	return (
		<div
			className={cn(
				"text-sm leading-relaxed text-foreground",
				"[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				"[&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_blockquote]:mb-2 [&_pre]:mb-2 [&_table]:mb-2",
				"[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5",
				"[&_blockquote]:border-l-2 [&_blockquote]:border-primary/45 [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground",
				"[&_hr]:my-3 [&_hr]:border-rule",
				// Code inside a `pre` is a block, and the `pre` already paints the box
				// - so the pill the `code` renderer applies is flattened here rather
				// than decided from a class the sanitiser strips.
				"[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0",
				className
			)}
		>
			{/*
			 * No skeleton: the chunk is on disk beside the app, so the wait is a
			 * frame or two, and a description is a paragraph inside a panel that
			 * has already drawn. A placeholder appearing and vanishing that fast is
			 * a flash, which is what the empty box avoids - the surrounding layout
			 * does not move either way.
			 */}
			<Suspense fallback={null}>
				<MarkdownRenderer>{children}</MarkdownRenderer>
			</Suspense>
		</div>
	);
}
