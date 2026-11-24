/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Rendered markdown for description fields. The prose styling lives here; the pipeline
 * (react-markdown, remark-gfm, rehype-raw, rehype-sanitize and the four security decisions) is
 * `markdown-renderer.tsx`, loaded on first render, not at startup (#1146). This is its only
 * importer and the reason for the split: `MarkdownView` reaches the entry chunk through the `ui`
 * barrel, so an eager parser chain here would load on every cold start.
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
				// Code in a `pre` is a block the `pre` already boxes, so the `code` renderer's pill
				// is flattened here, not decided from a class the sanitiser strips.
				"[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0",
				className
			)}
		>
			{/*
			 * No skeleton: the chunk is on disk, so the wait is a frame or two, inside a panel
			 * already drawn; a placeholder appearing and vanishing that fast is a flash. The layout
			 * does not move either way.
			 */}
			<Suspense fallback={null}>
				<MarkdownRenderer>{children}</MarkdownRenderer>
			</Suspense>
		</div>
	);
}
