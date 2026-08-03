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
export { StatusCodeBadge } from "./StatusCodeBadge";
export type { StatusCodeBadgeProps } from "./StatusCodeBadge";

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
export { TIMING_PHASES, phaseColor, phasesFromTrace, phasesFromAverages } from "./timing-phases";
export type {
	TimingPhase,
	TimingPhaseKey,
	TimingPhaseSource,
	TimingAverageSource,
	ResolvedTimingPhase,
	MaybeResolvedTimingPhase,
} from "./timing-phases";
export { default as TimingPhaseTiles } from "./TimingPhaseTiles";
export type { TimingPhaseTilesProps } from "./TimingPhaseTiles";

// The sampled-exchange shell - the summary row, the expansion, the error block
// and the timing tiles - rendered by both the dashboard's live sample list and
// the history detail's stored one. See the file header for what the two shells
// had drifted into before they shared this.
export { SampledExchange } from "./SampledExchange";
export type { SampledExchangeProps } from "./SampledExchange";

// Utilities
export {
	detectBodyType,
	formatBody,
	formatSize,
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
