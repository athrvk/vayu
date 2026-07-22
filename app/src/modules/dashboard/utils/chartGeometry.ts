/**
 * chartGeometry.ts - safe SVG y-scale helpers for dashboard charts.
 *
 * Guards against the NaN SVG coordinate bug that occurs when maxVal=0
 * (e.g. short runs with all-zero latency) causes division by zero in the
 * `1 - v/yMax` projection formula.
 */

/**
 * Shared SVG geometry for the full-width time-series charts (Throughput,
 * Latency, Percentiles, and the ramp_up Response-time-vs-concurrency scatter).
 * All of these MUST stay dimensionally identical so the dashboard rows line up
 * (Plan 4 code-quality gate #4: no chart geometry constants in component files).
 */
export const TIME_SERIES_DIMS = { VW: 1080, VH: 240, PL: 56, PR: 12, PT: 16, PB: 28 } as const;

/**
 * Shared SVG geometry for the HDR percentile plot and its live skeleton - they
 * must stay dimensionally identical so the card doesn't shift height when the
 * final report arrives.
 */
export const HDR_DIMS = { VW: 600, VH: 200, PL: 48, PR: 8, PT: 22, PB: 22 } as const;

export interface NiceYMaxOpts {
	/** Minimum allowed yMax before headroom is applied. Defaults to 1. */
	floor?: number;
	/** Multiplier applied after floor to add visual headroom. Defaults to 1.08. */
	headroom?: number;
}

/**
 * Compute a y-axis maximum from an array of values, guaranteed finite and > 0.
 *
 * @param values - Raw data values (may be empty or all-zero).
 * @param opts   - Optional floor and headroom overrides.
 * @returns      - A finite positive number safe to use as a divisor in projectY.
 */
export function niceYMax(values: number[], opts?: NiceYMaxOpts): number {
	const floor = opts?.floor ?? 1;
	const headroom = opts?.headroom ?? 1.08;
	const maxVal = values.length > 0 ? Math.max(...values) : 0;
	return Math.max(maxVal, floor) * headroom;
}

/**
 * Project a data value onto the SVG y-axis.
 *
 * Maps v=0 → top+innerH (chart bottom) and v=yMax → top (chart top).
 * Returns the fallback (top+innerH, i.e. chart bottom) for any degenerate
 * input: yMax <= 0, v is NaN, or v is ±Infinity.
 *
 * @param v      - Data value to project.
 * @param yMax   - Y-axis maximum (must be > 0; use niceYMax to guarantee this).
 * @param top    - Top padding (PT) in SVG units.
 * @param innerH - Inner chart height (IH) in SVG units.
 * @returns      - Finite SVG y-coordinate.
 */
export function projectY(v: number, yMax: number, top: number, innerH: number): number {
	if (yMax <= 0 || !Number.isFinite(v)) {
		return top + innerH;
	}
	return top + (1 - v / yMax) * innerH;
}
