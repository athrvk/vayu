/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Main exports
export { default as UnifiedResponseViewer } from "./UnifiedResponseViewer";
export { default as ResponseBody } from "./ResponseBody";
// The MCP tool result above the raw reply, mounted only in the request builder's Body tab, where
// the request's mode says the reply is MCP (#3841).
export { default as McpResultView } from "./McpResultView";
export type { McpResultViewProps } from "./McpResultView";
// Three variants: the collapsible table, the compact slab, and the Headers *tab* stacking two
// tables with an empty state.
export {
	default as HeadersViewer,
	CompactHeadersViewer,
	HeaderValue,
	ResponseHeadersPanel,
} from "./HeadersViewer";
export type { ResponseHeadersPanelProps } from "./HeadersViewer";
// What a captured load-run response is *not* (truncated, dropped for budget, binary), for both
// surfaces showing captured samples.
export { CapturedResponseNotice } from "./CapturedResponseNotice";
export type { CapturedResponseNoticeProps } from "./CapturedResponseNotice";
// The Events timeline, shared as two surfaces show it from two sources: the request builder's
// live/restored stream, and a load run's captured sample, whose events the engine parses out of the
// stored body (#657). A second copy would be a second set of truncation disclosures to keep honest.
export { default as ResponseEvents } from "./ResponseEvents";
export type { ResponseEventsProps } from "./ResponseEvents";
export { StatusCodeBadge } from "./StatusCodeBadge";
export type { StatusCodeBadgeProps } from "./StatusCodeBadge";
// Whether a response matched its contract's schema, exported for the collection run's step list
// beside the status bar, as a second chip would miss the three-state wording (#681).
export { ValidationChip } from "./ValidationChip";
export type { ValidationChipProps } from "./ValidationChip";
// A step's assertions, beside the verdict on its absent-is-not-zero terms (#724); here, not in the
// step list, as it summarises a *response*, and a run's live and restored halves must word it
// alike.
export { TestsChip } from "./TestsChip";
export type { TestsChipProps } from "./TestsChip";

// The "Large response" callout of the two panes capping a body at `LARGE_BODY_BYTES`: the Body tab
// here and the request builder's Raw tab.
export { LargeBodyNotice } from "./LargeBodyNotice";
export type { LargeBodyNoticeProps } from "./LargeBodyNotice";

// Pieces shared by the two response viewers, two different shells (eight tabs from live context,
// two to four from a stored sample): the parts genuinely identical, not a merge of the shells.
export { ResponseStatusBar } from "./ResponseStatusBar";
// The bar's "HTTP/1.1, not HTTP/2" line, for a viewer without a bar: a collection run's step card
// (#3262).
export { HttpVersionDowngradeNote } from "./HttpVersionDowngradeNote";
export type { HttpVersionDowngradeNoteProps } from "./HttpVersionDowngradeNote";
export { ResponseActions } from "./ResponseActions";
export type { ResponseStatusBarProps } from "./ResponseStatusBar";
export type { ResponseActionsProps } from "./ResponseActions";

// The five network phases as one descriptor list, as five components render the DNS -> Connect ->
// TLS -> TTFB -> Download breakdown; `timing-phases.ts` says why colour lives there.
export { PHASE_TIPS } from "./phase-tips";
export {
	TIMING_PHASES,
	phaseColor,
	phasesFromTrace,
	phasesFromAverages,
	hasPhaseAverages,
	phasesFromPercentiles,
	tailRatio,
} from "./timing-phases";
export type {
	TimingPhase,
	TimingPhaseKey,
	TimingPhaseSource,
	TimingAverageSource,
	TimingPhasePercentileKey,
	TimingPhasePercentiles,
	TimingPercentileSource,
	ResolvedTimingPhase,
	ResolvedPhasePercentiles,
	MaybeResolvedTimingPhase,
} from "./timing-phases";
export { default as TimingPhaseTiles } from "./TimingPhaseTiles";
export type { TimingPhaseTilesProps } from "./TimingPhaseTiles";

// The sampled-exchange shell (summary row, expansion, error block, timing tiles) the history
// detail's stored samples render.
export { SampledExchange } from "./SampledExchange";
export type { SampledExchangeProps, ExchangeState } from "./SampledExchange";

// Utilities
export {
	detectBodyType,
	formatBody,
	// Where the pane stops formatting and shows a raw prefix. Exported as the `ResponseState`
	// mapping reads it too (above it, no indented copy will ever render), and the Raw tab for its
	// own prefix.
	LARGE_BODY_BYTES,
	// The pane's latency wording ("34 ms", "5.00 s"), exported so the context bar's Recent sends
	// rows state a latency as the pane does, not by a second rule for when ms become seconds.
	formatResponseTime,
	// Milliseconds between two epoch stamps, absent when either is unknown, for the Timing tab's
	// first event beside the Events rows (#3775).
	elapsedBetween,
	getMonacoLanguage,
	buildRawRequest,
	buildRawResponse,
} from "./utils";

// Types
export type {
	BodyType,
	ViewMode,
	ResponseData,
	RequestData,
	ResponseBodyProps,
	HeadersViewerProps,
	UnifiedResponseViewerProps,
} from "./types";
