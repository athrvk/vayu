/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeadersViewer Component
 *
 * Displays HTTP headers in a collapsible table format.
 * Used for both request and response headers.
 *
 * The row rules are `border-border-strong`. This table renders inside the
 * response pane's `bg-card`, where `--border` is the same colour as the card in
 * dark - and the rows were `border-border/50` on top of that, measuring **1.002**.
 * Visible in light at 1.138, absent in dark. `--border-strong` gives 1.553 light
 * / 1.278 dark.
 *
 * The rows are not held a step lighter than the header: at this surface a step
 * lighter lands back at invisible. See `docs/design-system.md`, "a divider inside
 * a card".
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { HeadersViewerProps } from "./types";

export default function HeadersViewer({
	headers,
	title,
	defaultOpen = true,
	variant = "response",
	className,
}: HeadersViewerProps) {
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const entries = Object.entries(headers);

	if (entries.length === 0) {
		return null;
	}

	// Header names are body text on `bg-card`, so they need 4.5. The raw palette
	// values these used were 2.22 (green-500) and 3.76 (blue-500) in light mode -
	// and being raw palette, they were theme-blind, so the light failure could
	// not be fixed without breaking dark. The `-text` tokens are per-theme and
	// measure 5.68/8.80 and 5.98/6.76.
	const colorClass =
		variant === "response" ? "text-status-success-text" : "text-status-running-text";

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
			<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
				<div className="flex items-center justify-center w-5 h-5 rounded-md bg-muted group-hover:bg-muted/80 transition-colors">
					{isOpen ? (
						<ChevronDown className="w-4 h-4 text-muted-foreground" />
					) : (
						<ChevronRight className="w-4 h-4 text-muted-foreground" />
					)}
				</div>
				<h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
					{title || (variant === "response" ? "Response Headers" : "Request Headers")}
				</h3>
				<Badge variant="outline" className="ml-auto text-xs">
					{entries.length}
				</Badge>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border-strong">
							<th className="text-left py-2 px-3 font-medium text-muted-foreground">
								Name
							</th>
							<th className="text-left py-2 px-3 font-medium text-muted-foreground">
								Value
							</th>
						</tr>
					</thead>
					<tbody>
						{entries.map(([name, value]) => (
							<tr
								key={name}
								className="border-b border-border-strong hover:bg-muted/50"
							>
								<td className={cn("py-2 px-3 font-mono", colorClass)}>{name}</td>
								<td className="py-2 px-3 font-mono break-all">{value}</td>
							</tr>
						))}
					</tbody>
				</table>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * Compact headers display for smaller views
 */
export function CompactHeadersViewer({
	headers,
	title,
	className,
}: {
	headers: Record<string, string>;
	title?: string;
	className?: string;
}) {
	const entries = Object.entries(headers);

	if (entries.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{title && (
				<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">
					{title}
				</h4>
			)}
			<div className="bg-muted p-3 rounded-md space-y-1">
				{entries.map(([key, value]) => (
					// `border-foreground/15`, not a border token. These rows sit on a
					// full `bg-muted` slab, and no border token is visible there in
					// both themes - `--border-strong` is the *weaker* of the two in
					// dark, because `--muted` sits between them. An alpha of
					// `--foreground` flips with the theme: 1.36 light / 1.58 dark.
					<div
						key={key}
						className="flex gap-2 py-1 border-b border-foreground/15 last:border-0"
					>
						<span className="text-xs font-medium text-primary shrink-0">{key}:</span>
						<span className="text-xs text-foreground break-all">{value}</span>
					</div>
				))}
			</div>
		</div>
	);
}
