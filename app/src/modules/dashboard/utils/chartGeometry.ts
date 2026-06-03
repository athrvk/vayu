/**
 * chartGeometry.ts — safe SVG y-scale helpers for dashboard charts.
 *
 * Guards against the NaN SVG coordinate bug that occurs when maxVal=0
 * (e.g. short runs with all-zero latency) causes division by zero in the
 * `1 - v/yMax` projection formula.
 */

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
