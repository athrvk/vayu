/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SampleRequestCard Component
 *
 * A single stored sampled request, expandable. The row, the expansion chrome,
 * the error block and the timing tiles are the shared `SampledExchange` - the
 * dashboard's live sample list renders the same shell (#76). What is left here
 * is what is genuinely history's: the outcome-tinted card border, a stored
 * run's date formatting, and the two sections this side shows (request headers,
 * then the response through `UnifiedResponseViewer`).
 */

import { cn } from "@/lib/utils";
import {
	UnifiedResponseViewer,
	HeadersViewer,
	SampledExchange,
	phasesFromTrace,
} from "@/components/shared/response-viewer";
import type { SampleResult } from "../../types";

interface SampleRequestCardProps {
	sample: SampleResult;
	index: number;
	isExpanded: boolean;
	onToggle: () => void;
}

export default function SampleRequestCard({
	sample,
	index,
	isExpanded,
	onToggle,
}: SampleRequestCardProps) {
	const isError = !!sample.error || sample.statusCode === 0;
	const isSuccess = sample.statusCode >= 200 && sample.statusCode < 300;

	// A stored sample is dating a run, not placing a moment inside one, so this
	// side wants the day where the dashboard's live row wants milliseconds.
	const timestamp = new Date(sample.timestamp).toLocaleString();

	// Gating on the phases themselves, not on `sample.trace`. The two used to be
	// decided separately - the wrapper rendered whenever a trace existed, while
	// the breakdown inside it returned null unless DNS, connect or TLS was
	// present - so a trace carrying only TTFB and download printed a "Timing
	// Breakdown" heading with nothing under it. `SampledExchange` gates on the
	// list, so the heading cannot outlive its content.
	const phases = phasesFromTrace(sample.trace);

	return (
		<SampledExchange
			label={index + 1}
			statusCode={sample.statusCode}
			latencyMs={sample.latencyMs}
			timestamp={timestamp}
			error={sample.error}
			phases={phases}
			isExpanded={isExpanded}
			onToggle={onToggle}
			className={cn(
				"border transition-colors",
				isError && "border-destructive/30",
				// status-success, matching the CheckCircle2 this border frames.
				isSuccess && "border-status-success/20"
			)}
		>
			{/* Request Headers - the shared collapsible table, not a raw JSON
			    dump. It sat directly above a UnifiedResponseViewer that already
			    renders headers properly; the two treatments no longer differ. */}
			{sample.trace?.request?.headers && (
				<HeadersViewer headers={sample.trace.request.headers} variant="request" />
			)}

			{/* Response using UnifiedResponseViewer */}
			{(sample.trace?.response?.body || sample.trace?.response?.headers) && (
				<UnifiedResponseViewer
					response={{
						body:
							typeof sample.trace.response.body === "string"
								? sample.trace.response.body
								: sample.trace.response.body == null
									? ""
									: JSON.stringify(sample.trace.response.body, null, 2),
						headers: sample.trace.response.headers || {},
						status: sample.statusCode,
					}}
					className="max-h-[400px]"
				/>
			)}
		</SampledExchange>
	);
}
