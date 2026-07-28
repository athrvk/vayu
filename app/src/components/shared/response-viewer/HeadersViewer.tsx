/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The headers family - three variants, one file.
 *
 * `HeadersViewer` is the collapsible table, used for request and response
 * headers alike. `CompactHeadersViewer` is the same content on a sunken slab,
 * for panes with no room for a table. `ResponseHeadersPanel` is the Headers
 * *tab* - request collapsed above response open - and lived in its own file
 * until #76 folded it in here, which is where the other two already were.
 *
 * Displays HTTP headers in a collapsible table format.
 * Used for both request and response headers.
 *
 * The rules are `border-rule`, so their colour comes from whichever surface
 * encloses this table rather than from a token picked here. Rendered in the
 * response pane that is a `surface-card`, they resolve to 1.304 light / 1.278
 * dark; the compact variant below sits on a `surface-sunken` and its rows
 * resolve to 1.356 / 1.343 without saying anything different.
 *
 * They were `border-border/50` on a card: 1.138 in light, **1.002** in dark -
 * the same colour as the card. Obvious in light, entirely absent in dark, which
 * is how it was reported.
 *
 * The rows are not held a step lighter than the header: at this surface a step
 * lighter lands back at invisible.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	Badge,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	EYEBROW_CLASS,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
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
	/*
	 * Header keys carry no colour.
	 *
	 * They used to: response keys were `text-status-success-text` and request
	 * keys `text-status-running-text` - the *status* vocabulary, green and blue,
	 * spent on a name that is neither succeeding nor running. In this pane
	 * especially that is a real cost, because the status bar and the status-code
	 * badge sit directly above and are where green and red have to mean
	 * something. Painting every response header green teaches the eye to ignore
	 * it there.
	 *
	 * The request/response split is already carried by the section each table
	 * sits under, so the hue was decoration paid for out of the semantic budget.
	 * Key and value are told apart the way a devtools panel does it - the value
	 * is the payload and takes `--foreground`, the key is the lookup label and
	 * sits one tier back.
	 */

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
			<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
				<div className="flex items-center justify-center w-5 h-5 rounded-md bg-muted group-hover:bg-muted/80 transition-colors">
					{isOpen ? (
						<ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
					) : (
						<ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
					)}
				</div>
				<h3 className={EYEBROW_CLASS}>
					{title || (variant === "response" ? "Response Headers" : "Request Headers")}
				</h3>
				<Badge variant="outline" className="ml-auto text-xs">
					{entries.length}
				</Badge>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Value</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.map(([name, value]) => (
							<TableRow key={name}>
								<TableCell className="font-mono text-muted-foreground">
									{name}
								</TableCell>
								<TableCell className="font-mono break-all text-foreground">
									{value}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
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
			{title && <h4 className={cn(EYEBROW_CLASS, "mb-2")}>{title}</h4>}
			<div className="surface-sunken p-3 rounded-md space-y-1">
				{entries.map(([key, value]) => (
					// Same `border-rule` as the table above, resolving differently
					// because `surface-sunken` re-declares it. That slab is `--muted`,
					// the one surface where no border token works in both themes:
					// `--border-strong` is the *weaker* of the two in dark, since
					// `--muted` sits between them, and the pair inverts in light. The
					// surface class supplies an alpha of `--foreground` instead, which
					// flips with the theme - 1.356 light / 1.343 dark.
					<div key={key} className="flex gap-2 py-1 border-b border-rule last:border-0">
						<span className="text-xs font-medium text-muted-foreground shrink-0">
							{key}:
						</span>
						<span className="text-xs text-foreground break-all">{value}</span>
					</div>
				))}
			</div>
		</div>
	);
}

export interface ResponseHeadersPanelProps {
	/** Headers that were sent. Collapsed by default - usually not the question. */
	requestHeaders?: Record<string, string>;
	/** Headers that came back. Open by default. */
	responseHeaders?: Record<string, string>;
}

/**
 * The Headers tab: request headers collapsed, response headers open.
 *
 * `ResponseHeadersTab` in the request builder and an inline block in
 * `UnifiedResponseViewer` were the same panel, reached through differently
 * shaped data - one read `response.requestHeaders`, the other a separate
 * `effectiveRequest`. The prop shape is the normalised one: two header maps,
 * neither of which the caller has to nest inside a response object.
 *
 * **Only the request builder's tab renders this today.** The stored viewer's
 * Headers tab went back to a pair of `CompactHeadersViewer`s when it became
 * compact-only (#75), so the "two callers" this was extracted for is now one -
 * which is why #76 called folding it in here hygiene rather than deduplication.
 * The two treatments are a deliberate difference, not drift: a table needs
 * width the compact pane does not have.
 *
 * The empty-state fallback is the one piece of behaviour that is this panel's
 * own. `HeadersViewer` renders `null` with no entries, so without it a response
 * carrying no headers showed a blank pane with nothing explaining why - which is
 * exactly what the history copy did before the extraction.
 */
export function ResponseHeadersPanel({
	requestHeaders,
	responseHeaders,
}: ResponseHeadersPanelProps) {
	const response = responseHeaders ?? {};
	const hasRequestHeaders = requestHeaders && Object.keys(requestHeaders).length > 0;

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{hasRequestHeaders && (
				<HeadersViewer headers={requestHeaders} variant="request" defaultOpen={false} />
			)}

			<HeadersViewer headers={response} variant="response" defaultOpen={true} />

			{Object.keys(response).length === 0 && (
				<EmptyState variant="inline" title="No headers in response" />
			)}
		</div>
	);
}
