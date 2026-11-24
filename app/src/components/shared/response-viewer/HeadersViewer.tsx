/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The headers family: `HeadersViewer` is the collapsible table for request and response headers;
 * `CompactHeadersViewer` the same content on a sunken slab, for panes without room for a table;
 * `ResponseHeadersPanel` the Headers *tab*, request collapsed above response open. The rules are
 * `border-rule`, coloured by the enclosing surface: in the response pane's `surface-card` they
 * resolve to 1.304 light / 1.278 dark, and the compact variant's rows on `surface-sunken` to 1.356
 * / 1.343 (`border-border/50` on a card measured 1.002 in dark, the card's own colour). The rows
 * are not a step lighter than the header: here a step lighter is invisible.
 */

import { useState, type ReactNode } from "react";
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
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";
import { resolveHeaderLines } from "@/lib/header-lines";
import type { HeaderLine } from "@/types/domain";
import { proseTimeRuns } from "@/lib/monaco-time-tokens";
import { EmptyState } from "../EmptyState";
import { TimeValue } from "../TimeValue";
import { TruncatedText } from "../TruncatedText";
import type { HeadersViewerProps } from "./types";
import type { HeaderLine as WireHeaderLine } from "./wire-headers";

/**
 * A header value with each time in it carrying the time card (#1786), the text otherwise as
 * received. Runs, not the whole value, as a `Set-Cookie` holds its `Expires=` among other
 * attributes; they are the Raw tab's runs (`proseTimeRuns`), so table and raw exchange mark the
 * same times. Exported for the Cookies tab, which shows each `Set-Cookie` attribute alone and needs
 * the same `Expires=` handling.
 */
export function HeaderValue({ value }: { value: string }) {
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const run of proseTimeRuns(value)) {
		const start = run.startColumn - 1;
		parts.push(value.slice(cursor, start));
		parts.push(<TimeValue key={start} value={run.text} style="raw" />);
		cursor = run.endColumn - 1;
	}
	parts.push(value.slice(cursor));
	return <>{parts}</>;
}

/**
 * A header name is one token and never wraps ("Content-" over "Type" reads as two names, #3495);
 * past this many characters (the longest registered names are about 35) it ellipses with the full
 * name on hover, so a pathological name cannot take the value's column.
 */
const HEADER_NAME_MAX = "max-w-[40ch]";

function isWireLines(headers: HeadersViewerProps["headers"]): headers is readonly WireHeaderLine[] {
	return Array.isArray(headers);
}

/** The rows to list: wire lines as given, a map through the lines as received. */
function viewerLines(
	headers: HeadersViewerProps["headers"],
	headerLines: HeaderLine[] | undefined
): HeaderLine[] {
	if (isWireLines(headers)) return headers.map(([name, value]) => ({ name, value }));
	return resolveHeaderLines(headers, headerLines);
}

export default function HeadersViewer({
	headers,
	headerLines,
	title,
	defaultOpen = true,
	variant = "response",
	className,
}: HeadersViewerProps) {
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const lines = viewerLines(headers, headerLines);

	if (lines.length === 0) {
		return null;
	}

	/*
	 * Header keys carry no colour. Green and blue keys spent the *status* vocabulary on names that
	 * are neither succeeding nor running, right under the status bar and code badge where green and
	 * red must mean something; painting every response header green teaches the eye to ignore it.
	 * The section a table sits under already says request or response. Key and value split as in
	 * devtools: the value is the payload on `--foreground`, the key the lookup label a tier back.
	 */

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
			<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
				<div className="flex items-center justify-center w-5 h-5 rounded-md bg-muted group-hover:bg-muted/80 transition-colors">
					{isOpen ? (
						<ChevronDown className="size-icon-sm text-muted-foreground" />
					) : (
						<ChevronRight className="size-icon-sm text-muted-foreground" />
					)}
				</div>
				<Heading outside="h3" className={EYEBROW_CLASS}>
					{title || (variant === "response" ? "Response headers" : "Request headers")}
				</Heading>
				<Badge variant="outline" className="ml-auto text-xs">
					{lines.length}
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
						{/* Index-composite: a repeated name is two rows with one name. */}
						{lines.map(({ name, value }, i) => (
							<TableRow key={`${i}:${name}`}>
								<TableCell className="font-mono whitespace-nowrap text-muted-foreground">
									<TruncatedText className={HEADER_NAME_MAX}>
										{name}
									</TruncatedText>
								</TableCell>
								<TableCell className="font-mono break-all text-foreground">
									<HeaderValue value={value} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** The headers on a sunken slab, for panes without room for the table. */
export function CompactHeadersViewer({
	headers,
	headerLines,
	title,
	className,
}: {
	headers: Record<string, string>;
	headerLines?: HeaderLine[];
	title?: string;
	className?: string;
}) {
	const lines = resolveHeaderLines(headers, headerLines);

	if (lines.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{/* The level is the host's: an inbox capture, a run's step or sample. */}
			{title && (
				<Heading outside="h4" className={cn(EYEBROW_CLASS, "mb-2")}>
					{title}
				</Heading>
			)}
			<div className="surface-sunken p-3 rounded-md space-y-1">
				{lines.map(({ name, value }, i) => (
					// The table's `border-rule`, resolving differently as `surface-sunken`
					// re-declares it. The slab is `--muted`, where no border token works in both
					// themes (`--border-strong` is the *weaker* in dark, `--muted` sitting between,
					// and the pair inverts in light), so the surface supplies a `--foreground`
					// alpha that flips with the theme: 1.356 light / 1.343 dark.
					<div
						key={`${i}:${name}`}
						className="flex gap-2 py-1 border-b border-rule last:border-0"
					>
						<TruncatedText
							className={cn(
								"text-xs font-medium text-muted-foreground shrink-0",
								HEADER_NAME_MAX
							)}
						>
							{`${name}:`}
						</TruncatedText>
						<span className="text-xs text-foreground break-all">
							<HeaderValue value={value} />
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

export interface ResponseHeadersPanelProps {
	/** Headers that were sent. Collapsed by default - usually not the question. */
	requestHeaders?: Record<string, string>;
	/**
	 * The request's lines as sent (`ResponseState.requestHeaderLines`, #2466), a repeated name a
	 * row each in its typed spelling; listed instead of the folding `requestHeaders` whenever there
	 * is no wire frame.
	 */
	requestHeaderLines?: HeaderLine[];
	/**
	 * The request as it went out, line by line (`ResponseState.wireRequestHeaders`), listed instead
	 * of the other two when present, as the sent record lacks the transport's own lines.
	 */
	wireRequestHeaders?: readonly WireHeaderLine[];
	/** Headers that came back. Open by default. */
	responseHeaders?: Record<string, string>;
	/** The response's lines as received (issue #2460); `responseHeaders` when absent. */
	responseHeaderLines?: HeaderLine[];
}

/**
 * The Headers tab: request headers collapsed, response open. The props are normalised to two header
 * maps, neither nested in a response object. **Only the request builder's tab renders it**: the
 * stored viewer's Headers tab is a pair of `CompactHeadersViewer`s since going compact-only (#75,
 * #76), a deliberate difference, as a table needs width the compact pane lacks. The request section
 * is one list: the request as it went out (`wireRequestHeaders`, #2464) when recorded, else its own
 * lines (`requestHeaderLines`, #2466), and only for an older answer the folded sent record, so a
 * failed send or an older row still lists every header the request carried. A display, never an
 * input. The empty-state fallback is this panel's own: `HeadersViewer` renders `null` with no
 * entries, which would leave a header-less response as an unexplained blank pane.
 */
export function ResponseHeadersPanel({
	requestHeaders,
	requestHeaderLines,
	wireRequestHeaders,
	responseHeaders,
	responseHeaderLines,
}: ResponseHeadersPanelProps) {
	const response = responseHeaders ?? {};
	const responseLineCount = resolveHeaderLines(response, responseHeaderLines).length;
	// `HeadersViewer` reads `headerLines` only for a map, so the wire list needs no special case:
	// it is the request when present, and the lines front the folded map otherwise.
	const request = wireRequestHeaders?.length ? wireRequestHeaders : (requestHeaders ?? {});

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			<HeadersViewer
				headers={request}
				headerLines={requestHeaderLines}
				variant="request"
				defaultOpen={false}
			/>

			<HeadersViewer
				headers={response}
				headerLines={responseHeaderLines}
				variant="response"
				defaultOpen={true}
			/>

			{responseLineCount === 0 && (
				<EmptyState variant="inline" title="No headers in response" />
			)}
		</div>
	);
}
