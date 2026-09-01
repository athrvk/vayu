/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared Response Viewer Components
 *
 * Centralized response display components used across the application.
 */

// Main exports
export { default as UnifiedResponseViewer } from "./UnifiedResponseViewer";
export { default as ResponseBody } from "./ResponseBody";
// One file, three variants: the collapsible table, the compact slab, and the
// Headers *tab* that stacks two tables with an empty state.
export {
	default as HeadersViewer,
	CompactHeadersViewer,
	ResponseHeadersPanel,
} from "./HeadersViewer";
export type { ResponseHeadersPanelProps } from "./HeadersViewer";
// Says what a captured load-run response is *not* - truncated, dropped for
// budget, or binary. Rendered by both surfaces that show captured samples.
export { CapturedResponseNotice } from "./CapturedResponseNotice";
export type { CapturedResponseNoticeProps } from "./CapturedResponseNotice";
// The Events timeline. Shared because two surfaces show the same list from two
// sources: the request builder's live/restored stream, and a load run's
// captured sample, whose events the engine parses back out of the stored body
// (issue #657). A second copy here would be a second set of truncation
// disclosures to keep honest.
export { default as ResponseEvents } from "./ResponseEvents";
export type { ResponseEventsProps } from "./ResponseEvents";
export { StatusCodeBadge } from "./StatusCodeBadge";
export type { StatusCodeBadgeProps } from "./StatusCodeBadge";
// Whether one response matched the schema its contract declares. Exported now
// that a second surface shows it - the collection run's step list beside the
// response pane's status bar - because a hand-rolled second chip would not
// receive this one's three-state wording (issue #681).
export { ValidationChip } from "./ValidationChip";
export type { ValidationChipProps } from "./ValidationChip";
// What a step's assertions came to, beside the verdict above and on the same
// absent-is-not-zero terms (issue #724). Here rather than in the step list
// because it summarises a *response*, like everything else in this folder, and
// the live and restored halves of a run must not word it two ways.
export { TestsChip } from "./TestsChip";
export type { TestsChipProps } from "./TestsChip";

// Pieces shared by the two response viewers. They are two different shells -
// seven tabs from live context, three from a stored run - so these are the
// parts that were genuinely identical, not an attempt to merge the shells.
export { ResponseStatusBar } from "./ResponseStatusBar";
export { ResponseActions } from "./ResponseActions";
export type { ResponseStatusBarProps } from "./ResponseStatusBar";
export type { ResponseActionsProps } from "./ResponseActions";

// The five network phases, as one descriptor list. Five components render the
// same DNS -> Connect -> TLS -> TTFB -> Download breakdown; adding a phase used
// to mean finding all five, and two of them had already drifted. See
// `timing-phases.ts` for what drifted and why colour lives there.
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

// The sampled-exchange shell - the summary row, the expansion, the error block
// and the timing tiles - rendered by both the dashboard's live sample list and
// the history detail's stored one. See the file header for what the two shells
// had drifted into before they shared this.
export { SampledExchange } from "./SampledExchange";
export type { SampledExchangeProps, ExchangeState } from "./SampledExchange";

// Utilities
export {
	detectBodyType,
	formatBody,
	formatSize,
	// Where the pane stops formatting a body and shows a raw prefix. Exported
	// because the mapping that builds `ResponseState` reads it too: above this
	// size the indented copy it used to build is one nothing will ever render.
	LARGE_BODY_BYTES,
	// The response pane's own latency wording ("34 ms", "5.00 s"). Exported so a
	// surface outside the viewer - the context bar's Recent sends rows - states
	// a latency the way the pane states it, instead of growing a second rule for
	// when milliseconds become seconds.
	formatResponseTime,
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
