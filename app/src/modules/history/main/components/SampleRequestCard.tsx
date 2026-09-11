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
 * dashboard's live sample list renders the same shell (#76), as a flat
 * `divide-y` strip (`RequestResponseView.tsx`) rather than a boxed card per
 * row - which is what this now matches too, rather than the two drifting into
 * different shapes for the same component. What is left here is what is
 * genuinely history's: a stored run's date formatting and the response
 * section.
 *
 * The response comes from `GET /runs/:id/samples` (issue #174), not from the
 * trace. This card used to read `sample.trace.request.headers` and
 * `sample.trace.response.body` - the design-mode nesting - on a surface that
 * only ever shows load-run rows, which no writer produces. Both branches were
 * dead, so the card rendered nothing but its timing tiles. There is also no
 * per-sample request to show any more: a load run's request is constant across
 * iterations and lives once in `runs.config_snapshot`.
 */

import {
	UnifiedResponseViewer,
	SampledExchange,
	CapturedResponseNotice,
	phasesFromTrace,
} from "@/components/shared/response-viewer";
import type { SampleResult } from "../../types";
import type { RunSample } from "@/types/domain";

interface SampleRequestCardProps {
	sample: SampleResult;
	index: number;
	isExpanded: boolean;
	onToggle: () => void;
	/** The captured exchange for this row, once the samples query has it. */
	captured?: RunSample;
}

export default function SampleRequestCard({
	sample,
	index,
	isExpanded,
	onToggle,
	captured,
}: SampleRequestCardProps) {
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
			// Flat divide-y strip, matching the dashboard's live list
			// (`RequestResponseView.tsx`) rather than a boxed card per row - no
			// per-row radius needed, the same "square on purpose" exception a
			// full-bleed divider strip already gets there. Status rides the
			// `StatusIcon` tint alone now, not a second, redundant colour on
			// the border.
			className="border-b last:border-b-0 transition-colors"
		>
			{/* The captured exchange, when this run stored one for this row.
			    Rendering nothing (not an empty heading) when it did not is
			    deliberate: most samples in a healthy run carry no body, and a
			    "Response" heading over nothing reads as a bug in the engine. */}
			{captured && (
				<div className="space-y-2">
					<CapturedResponseNotice response={captured.response} />
					<UnifiedResponseViewer
						response={{
							body: captured.response.body ?? "",
							headers: captured.response.headers,
							status: sample.statusCode,
						}}
						// Present only when this sample streamed, which is what
						// gates the Events tab (issue #657).
						events={captured.response.events}
						className="max-h-[400px]"
					/>
				</div>
			)}
		</SampledExchange>
	);
}
