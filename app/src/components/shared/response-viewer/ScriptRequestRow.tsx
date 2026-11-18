/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One `pm.sendRequest` a script made (#3633): a summary row that expands into
 * the exchange. The Console draws it in its summary line's place, and the
 * Setup / teardown card under a lifecycle row.
 *
 * Composed from the per-concern primitives rather than `UnifiedResponseViewer`:
 * that viewer shows a request's body only when there is no response, never the
 * sent header lines, and pins its panels at 500px, where a script request
 * wants both bodies, both header lists and the timing in one short stack.
 *
 * The record is masked by the engine where it is built, so every value is
 * drawn as written: a `<redacted>` header is the engine's word, not ours.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button, Card, Collapsible, CollapsibleContent, Eyebrow } from "@/components/ui";
import { formatBytes, formatLatency } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { responseHeadFromTrace } from "@/modules/request-builder/utils/restore-response";
import type { ResponseBytes } from "@/modules/request-builder/utils/response-bytes";
import type { RedirectHop, ScriptRequestRecord } from "@/types/domain";

import { Callout } from "../Callout";
import { MethodBadge } from "../MethodBadge";
import { TruncatedText } from "../TruncatedText";
import { CompactHeadersViewer } from "./HeadersViewer";
import ResponseBody from "./ResponseBody";
import { StatusCodeBadge } from "./StatusCodeBadge";
import TimingPhaseTiles from "./TimingPhaseTiles";
import { phasesFromTrace } from "./timing-phases";

/** `error_type` and `error_message` as one line; empty when the call did not fail. */
function scriptRequestError(record: ScriptRequestRecord): string {
	return [record.error_type, record.error_message].filter(Boolean).join(": ");
}

export interface ScriptRequestRowProps {
	record: ScriptRequestRecord;
	className?: string;
}

export function ScriptRequestRow({ record, className }: ScriptRequestRowProps) {
	const [open, setOpen] = useState(false);
	const Chevron = open ? ChevronDown : ChevronRight;
	const method = record.request.method || "GET";
	const url = record.request.url || "";
	const error = scriptRequestError(record);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)}>
			<Button
				type="button"
				variant="listRow"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="min-w-0 gap-2 rounded-md px-1 py-0.5 font-mono text-xs font-normal hover:bg-accent"
			>
				<Chevron aria-hidden="true" className="size-icon-sm text-muted-foreground" />
				<MethodBadge method={method} />
				<TruncatedText className="min-w-0 flex-1 text-foreground">{url}</TruncatedText>
				<StatusCodeBadge status={record.status} statusText={record.statusText} />
				{error && (
					<TruncatedText className="max-w-[40%] min-w-0 text-destructive-text">
						{record.error_type || error}
					</TruncatedText>
				)}
				<span className="shrink-0 tabular-nums text-muted-foreground">
					{formatLatency(record.totalMs)}
				</span>
			</Button>
			<CollapsibleContent className="mt-1 mb-2">
				<ScriptRequestDetail record={record} url={url} error={error} />
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * The expansion. A `Card` of its own, so it declares the surface its rules
 * read on: it nests inside the Console's sunken slab as well as inside a card.
 */
function ScriptRequestDetail({
	record,
	url,
	error,
}: {
	record: ScriptRequestRecord;
	url: string;
	error: string;
}) {
	const { request } = record;
	const requestHeaders = request.sentHeaders || request.headers || {};
	// Memoized: a base64 body decodes to fresh bytes on every call, and an
	// image preview keyed on them would make a new object URL per render.
	const response = useMemo(
		() => (record.response ? responseHeadFromTrace(record.response) : undefined),
		[record.response]
	);
	const phases = phasesFromTrace(record);

	return (
		<Card pad="sm" className="space-y-3 font-sans shadow-none">
			<p className="font-mono text-xs break-all text-foreground">{url}</p>
			{error && (
				<Callout severity="blocking">
					<span className="font-mono break-all">{error}</span>
				</Callout>
			)}

			<CompactHeadersViewer
				headers={requestHeaders}
				headerLines={request.sentHeaderLines}
				title="Request headers"
			/>
			{request.body ? (
				<BodySection
					title="Request body"
					body={request.body}
					headers={requestHeaders}
					truncatedFrom={request.bodyTruncated ? request.bodyBytes : undefined}
				/>
			) : null}

			{response && (
				<>
					<RedirectHops hops={response.redirects} />
					<CompactHeadersViewer
						headers={response.headers}
						headerLines={response.headerLines}
						title="Response headers"
					/>
					{(response.bodyRaw || response.rawBytes) && (
						<BodySection
							title="Response body"
							body={response.body}
							bodyRaw={response.bodyRaw}
							rawBytes={response.rawBytes}
							headers={response.headers}
							truncatedFrom={response.bodyTruncated ? response.bodyBytes : undefined}
						/>
					)}
				</>
			)}

			{phases.length > 0 && (
				<div className="space-y-1">
					<Eyebrow>Timing</Eyebrow>
					<TimingPhaseTiles phases={phases} />
				</div>
			)}
		</Card>
	);
}

/**
 * A body in a fixed band: `ResponseBody`'s editor fills its parent, and this
 * stack has no height of its own to give it.
 */
function BodySection({
	title,
	truncatedFrom,
	...body
}: {
	title: string;
	body: string;
	bodyRaw?: string;
	rawBytes?: ResponseBytes;
	headers: Record<string, string>;
	/** The body's true size when storage kept only a prefix. */
	truncatedFrom?: number;
}) {
	return (
		<div className="space-y-1">
			<Eyebrow>{title}</Eyebrow>
			{truncatedFrom !== undefined && (
				<p className="text-xs text-muted-foreground">
					Truncated for storage. The full body was {formatBytes(truncatedFrom)}.
				</p>
			)}
			<div className="h-48 overflow-hidden rounded-md border border-rule">
				<ResponseBody {...body} showModeToggle={false} />
			</div>
		</div>
	);
}

/** Each hop followed before the answer, with the header lines it carried. */
function RedirectHops({ hops }: { hops: RedirectHop[] | undefined }) {
	if (!hops?.length) return null;
	return (
		<div className="space-y-2">
			<Eyebrow>Redirects</Eyebrow>
			{hops.map((hop, i) => (
				<div key={i} className="space-y-1">
					<div className="flex min-w-0 items-center gap-2 text-xs">
						<StatusCodeBadge status={hop.status} statusText={hop.statusText} />
						<TruncatedText className="min-w-0 font-mono">{hop.url || ""}</TruncatedText>
					</div>
					<CompactHeadersViewer headers={{}} headerLines={hop.headerLines} />
				</div>
			))}
		</div>
	);
}
