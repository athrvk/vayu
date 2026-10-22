/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * uPlot plugins for Vayu - the diagnostic-interactivity layer.
 *
 * The point of the Canvas migration is not prettier lines; it is letting a user
 * *understand the service under test*: read exact values at any instant,
 * correlate metrics at that instant, zoom into the moment of degradation, and
 * see computed insights (the capacity breakpoint, the target rate, the SLO)
 * marked on the axes. These plugins provide those affordances; uPlot's built-ins
 * (drag-zoom, cursor.sync) provide the rest.
 */

import type uPlot from "uplot";
import type { UplotTheme, ColorRole } from "./uplotTheme";
import { layoutChartLabels } from "./labelLayout";

/**
 * A reference marker: a dashed line + label. Vertical markers pin an x value (the
 * W1 capacity breakpoint, ramp phase boundaries); horizontal markers pin a y
 * value on a scale (the configured target RPS, the latency SLO). Color is given
 * as a semantic role and resolved against the live theme when drawn.
 */
export interface Marker {
	orient: "vertical" | "horizontal";
	/** x value for vertical markers; y value for horizontal markers. */
	value: number;
	/** y-scale key for horizontal markers (default "y"). */
	scale?: string;
	label: string;
	role: ColorRole;
	/** Horizontal label side (default "right"); a vertical label sits right of its line, left when that would leave the canvas. */
	align?: "left" | "right";
}

const dpr = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

const ABOVE_RANGE = " (above range)";
const BELOW_RANGE = " (below range)";

/** `label` plus `suffix`, with the label cut short and ellipsised when the pair would not fit `maxWidth`. */
function fitLabel(
	ctx: CanvasRenderingContext2D,
	label: string,
	suffix: string,
	maxWidth: number
): string {
	if (ctx.measureText(label + suffix).width <= maxWidth) return label + suffix;
	let base = label;
	while (base.length > 0 && ctx.measureText(`${base}…${suffix}`).width > maxWidth) {
		base = base.slice(0, -1);
	}
	return `${base}…${suffix}`;
}

/**
 * A horizontal marker at canvas-pixel `cy`. One whose value is off the visible y
 * range is pinned to the plot's top or bottom edge and says which way it is off,
 * because a threshold the data never reaches is itself a finding ("the SLO is
 * far above anything this run did") and dropping it silently reads as no SLO.
 */
function drawHorizontalMarker(
	ctx: CanvasRenderingContext2D,
	bbox: uPlot.BBox,
	m: Marker,
	cy: number
): void {
	const { left, top, width, height } = bbox;
	const above = cy < top;
	const below = cy > top + height;
	const y = Math.min(Math.max(cy, top), top + height);
	ctx.beginPath();
	ctx.moveTo(left, y);
	ctx.lineTo(left + width, y);
	ctx.stroke();

	const inset = 4 * dpr();
	const suffix = above ? ABOVE_RANGE : below ? BELOW_RANGE : "";
	const label = suffix ? fitLabel(ctx, m.label, suffix, width - 2 * inset) : m.label;
	const right = (m.align ?? "right") === "right";
	ctx.textAlign = right ? "right" : "left";
	// A line on the top edge has no room above it, so its label hangs below.
	const labelY = above ? top + 11 * dpr() : y - inset;
	ctx.fillText(label, right ? left + width - inset : left + inset, labelY);
}

/** A label waiting for the layout: where it anchors, which way it extends, and the extent that gives. */
interface PendingLabel {
	text: string;
	color: string;
	/** Anchor x; the text extends right of it when `align` is "left", left of it when "right". */
	anchorX: number;
	align: "left" | "right";
	width: number;
}

/** Rows of labels under the plot's top edge; a third would sit among the series, so a label that fits neither is left to the hover tooltip. */
const LABEL_LANES = 2;

/** Clear space kept between two labels in one lane, in CSS pixels. */
const LABEL_GAP_PX = 6;

/** A vertical rule at `cx`, plus the label to lay out beside it. */
function drawVerticalMarker(
	ctx: CanvasRenderingContext2D,
	bbox: uPlot.BBox,
	m: Marker,
	cx: number,
	color: string
): PendingLabel {
	const { top, height } = bbox;
	ctx.beginPath();
	ctx.moveTo(cx, top);
	ctx.lineTo(cx, top + height);
	ctx.stroke();
	// A marker on the last point sits at the plot's right edge, where the
	// label would run off the canvas: flip it to the line's left.
	const inset = 4 * dpr();
	const width = ctx.measureText(m.label).width;
	const flip = cx + inset + width > ctx.canvas.width;
	return {
		text: m.label,
		color,
		anchorX: flip ? cx - inset : cx + inset,
		align: flip ? "right" : "left",
		width,
	};
}

/** Draw the markers' rules (and horizontal labels) now; the vertical labels come back for the shared layout. */
function drawMarkers(u: uPlot, markers: readonly Marker[], theme: UplotTheme): PendingLabel[] {
	const ctx = u.ctx;
	const { left, width } = u.bbox;
	const labels: PendingLabel[] = [];
	ctx.save();
	ctx.lineWidth = 1.5 * dpr();
	ctx.setLineDash([4 * dpr(), 4 * dpr()]);
	for (const m of markers) {
		const color = theme.color(m.role);
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		if (m.orient === "horizontal") {
			drawHorizontalMarker(ctx, u.bbox, m, u.valToPos(m.value, m.scale ?? "y", true));
			continue;
		}
		const cx = u.valToPos(m.value, "x", true);
		// Unlike a horizontal marker, an x marker off the plot is skipped: the
		// user zoomed past it, and clamping it to an edge would pin a moment
		// to a place it is not.
		if (cx < left || cx > left + width) continue;
		labels.push(drawVerticalMarker(ctx, u.bbox, m, cx, color));
	}
	ctx.restore();
	return labels;
}

/**
 * A shaded x-axis window: the chart's way of saying "this interval was
 * different". Where a {@link Marker} pins one value, an annotation covers the
 * span a condition held for - the run's degradation windows, drawn on the same
 * axis as the metric that degraded.
 *
 * Chart-layer vocabulary on purpose: it carries a span, a colour role and a
 * label, and knows nothing about what made the window interesting. The semantic
 * wrappers map their domain findings onto it.
 */
export interface Annotation {
	/** Window start on the x axis (elapsed seconds). */
	startSeconds: number;
	/** Window end; equal to the start for an instant. */
	endSeconds: number;
	label: string;
	role: ColorRole;
}

/** How far, in CSS pixels, the cursor may be from an annotation and still be hovering it - what makes an instant (zero width) reachable. */
const ANNOTATION_HOVER_PX = 5;

/** Below this width a band would read as a smudge, so it is drawn as a line. */
const MIN_BAND_PX = 2;

/** A label needs room, and a 6px band has none - drawing it anyway overlaps the neighbours. */
const MIN_LABEL_PX = 28;

/** Draw each annotation's band or rule now; the labels come back for the shared layout. */
function drawAnnotations(
	u: uPlot,
	annotations: readonly Annotation[],
	theme: UplotTheme
): PendingLabel[] {
	const ctx = u.ctx;
	const { left, top, width, height } = u.bbox;
	const labels: PendingLabel[] = [];
	for (const a of annotations) {
		const x1 = u.valToPos(a.startSeconds, "x", true);
		const x2 = u.valToPos(a.endSeconds, "x", true);
		// Wholly outside the visible range (the user zoomed past it).
		if (x2 < left || x1 > left + width) continue;
		const clipped1 = Math.max(x1, left);
		const clipped2 = Math.min(x2, left + width);
		const bandWidth = clipped2 - clipped1;
		const color = theme.color(a.role);

		if (bandWidth < MIN_BAND_PX) {
			// An instant (first 5xx) or a window zoomed down to nothing: a
			// dashed rule, matching how a marker pins a moment.
			ctx.save();
			ctx.strokeStyle = color;
			ctx.lineWidth = 1.5 * dpr();
			ctx.setLineDash([4 * dpr(), 4 * dpr()]);
			ctx.beginPath();
			ctx.moveTo(clipped1, top);
			ctx.lineTo(clipped1, top + height);
			ctx.stroke();
			ctx.restore();
		} else {
			ctx.fillStyle = theme.color(a.role, 0.16);
			ctx.fillRect(clipped1, top, bandWidth, height);
		}

		// An empty label has nothing to draw and must not hold a lane.
		if (a.label === "") continue;
		if (bandWidth >= MIN_LABEL_PX || bandWidth < MIN_BAND_PX) {
			labels.push({
				text: a.label,
				color,
				anchorX: clipped1 + 4 * dpr(),
				align: "left",
				width: ctx.measureText(a.label).width,
			});
		}
	}
	return labels;
}

/** Give each label the first free lane and draw it; one with no free lane is left out. */
function drawLabels(u: uPlot, labels: readonly PendingLabel[]): void {
	const ctx = u.ctx;
	const lanes = layoutChartLabels(
		labels.map((l) => ({
			x: l.align === "left" ? l.anchorX : l.anchorX - l.width,
			width: l.width,
		})),
		12 * dpr(),
		LABEL_LANES,
		LABEL_GAP_PX * dpr()
	);
	labels.forEach((label, i) => {
		const slot = lanes[i];
		if (!slot) return;
		ctx.fillStyle = label.color;
		ctx.textAlign = label.align;
		ctx.fillText(label.text, label.anchorX, u.bbox.top + 11 * dpr() + slot.offset);
	});
}

/**
 * The chart's overlay layer: annotation bands, then marker rules, then every
 * vertical label from both lists laid out together so no two overlap (#2696).
 * One `draw` hook, because the layout needs both lists at once. Bands go first
 * (a background wash the markers' dashed rules must stay legible over), and the
 * markers' labels are placed before the annotations' so they win a contested
 * lane. Redrawn each frame, so it survives zoom and pan.
 */
export function overlaysPlugin(
	getMarkers: () => Marker[],
	getAnnotations: () => Annotation[],
	theme: UplotTheme
): uPlot.Plugin {
	return {
		hooks: {
			draw: (u: uPlot) => {
				const ctx = u.ctx;
				ctx.save();
				ctx.font = `${10 * dpr()}px "JetBrains Mono", monospace`;
				const annotationLabels = drawAnnotations(u, getAnnotations(), theme);
				const markerLabels = drawMarkers(u, getMarkers(), theme);
				drawLabels(u, [...markerLabels, ...annotationLabels]);
				ctx.restore();
			},
		},
	};
}

/** The annotations with something to say that sit under the cursor at `left` (CSS px). */
export function annotationsUnderCursor(
	u: uPlot,
	annotations: readonly Annotation[],
	left: number
): Annotation[] {
	return annotations.filter((a) => {
		if (a.label === "") return false;
		const x1 = u.valToPos(a.startSeconds, "x", false);
		const x2 = u.valToPos(a.endSeconds, "x", false);
		return left >= x1 - ANNOTATION_HOVER_PX && left <= x2 + ANNOTATION_HOVER_PX;
	});
}

export type ValueFormatter = (v: number | null | undefined) => string;

/** A tooltip line naming an annotation under the cursor: a swatch in its colour, then its label. */
function annotationRow(label: string, stroke: string): HTMLElement {
	const row = document.createElement("div");
	row.style.cssText = "display:flex;gap:5px;align-items:center";
	const swatch = document.createElement("span");
	swatch.style.cssText = "width:8px;height:8px;flex:none;display:inline-block";
	swatch.style.background = stroke;
	const text = document.createElement("span");
	text.textContent = label;
	row.append(swatch, text);
	return row;
}

/** One legend row of the hover tooltip: swatch and label on the left, value on the right. */
function tooltipRow(label: string, value: string, stroke: string): HTMLElement {
	const row = document.createElement("div");
	row.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between";
	const key = document.createElement("span");
	key.style.cssText = "display:inline-flex;align-items:center;gap:5px";
	const swatch = document.createElement("span");
	swatch.style.cssText = "width:8px;height:2px;display:inline-block";
	swatch.style.background = stroke;
	key.append(swatch, label);
	const val = document.createElement("span");
	val.style.fontWeight = "600";
	val.textContent = value;
	row.append(key, val);
	return row;
}

/**
 * Cursor tooltip - a positioned DOM overlay showing every series' value at the
 * hovered instant. The core "understand the service" affordance: at t=42.1s you
 * see RPS, p50/p95/p99, error-rate and concurrency together, so a p99 spike is
 * read against the concurrency and error columns at the same x. Pairs with
 * uPlot's `cursor.sync` so hovering one chart moves the cursor on all of them.
 */
export function tooltipPlugin(opts: {
	theme: UplotTheme;
	/** Per-series value formatter, keyed by series position (1-based data idx). */
	format?: Record<number, ValueFormatter>;
	skip?: Set<number>;
	xLabel?: (x: number) => string;
	/** Unit line under the time header, for a chart whose values are not self-evident. */
	caption?: string;
	/**
	 * Per-series values to print instead of `u.data`, keyed like `format`. A getter,
	 * because the plugin outlives the data it reads (`setData` does not rebuild it).
	 * A series listed here is a per-band amount, so a zero is not a row.
	 */
	tipValues?: () => Record<number, (number | null)[]>;
	/**
	 * The shaded windows to name when the cursor is over one. A getter for the
	 * same reason as `tipValues`: annotations stream in without a rebuild.
	 */
	annotations?: () => Annotation[];
}): uPlot.Plugin {
	let tip: HTMLDivElement | null = null;
	const fmt = opts.format ?? {};
	const skip = opts.skip ?? new Set<number>();
	const xLabel = opts.xLabel ?? ((x: number) => `${x.toFixed(1)}s`);

	return {
		hooks: {
			init: (u: uPlot) => {
				tip = document.createElement("div");
				tip.className = "vayu-chart-tooltip";
				Object.assign(tip.style, {
					position: "absolute",
					pointerEvents: "none",
					zIndex: "10",
					padding: "6px 8px",
					font: opts.theme.font,
					background: "hsl(var(--card))",
					color: "hsl(var(--card-foreground))",
					border: "1px solid hsl(var(--border))",
					// Tracks the roundedness setting, like the app's own tooltip.
					borderRadius: "var(--radius-md)",
					boxShadow: "0 4px 12px hsl(var(--foreground) / 0.14)",
					transform: "translate(-50%, calc(-100% - 12px))",
					whiteSpace: "nowrap",
					opacity: "0",
					transition: "opacity 0.08s",
				} satisfies Partial<CSSStyleDeclaration>);
				u.over.appendChild(tip);
			},
			setCursor: (u: uPlot) => {
				if (!tip) return;
				const { idx, left, top } = u.cursor;
				if (idx == null || left == null || left < 0 || top == null || top < 0) {
					tip.style.opacity = "0";
					return;
				}
				const xVal = u.data[0][idx];
				const header = document.createElement("div");
				header.style.cssText = "opacity:.7;margin-bottom:2px";
				header.textContent = xLabel(xVal as number);
				const rows: HTMLElement[] = [header];
				if (opts.caption) {
					const caption = document.createElement("div");
					caption.style.cssText = "opacity:.7;margin-bottom:2px";
					caption.textContent = opts.caption;
					rows.push(caption);
				}
				const headRows = rows.length;
				const tipValues = opts.tipValues?.() ?? {};
				// An interval that saw no responses keeps its first band's row, so the
				// readout says "0" rather than showing a header over nothing.
				let firstZeroRow: HTMLElement | null = null;
				for (let s = 1; s < u.series.length; s++) {
					if (skip.has(s)) continue;
					const series = u.series[s];
					if (series.show === false) continue;
					const own = tipValues[s];
					const raw = own ? own[idx] : u.data[s][idx];
					const formatted = (fmt[s] ?? ((v) => (v == null ? "-" : String(v))))(
						raw as number | null
					);
					const stroke =
						typeof series.stroke === "function" ? series.stroke(u, s) : series.stroke;
					const row = tooltipRow(String(series.label ?? ""), formatted, String(stroke));
					if (own && raw === 0) firstZeroRow ??= row;
					else rows.push(row);
				}
				if (rows.length === headRows && firstZeroRow) rows.push(firstZeroRow);
				for (const a of annotationsUnderCursor(u, opts.annotations?.() ?? [], left)) {
					rows.push(annotationRow(a.label, opts.theme.color(a.role)));
				}
				// Built from text, never markup: series labels include script-defined
				// custom-metric names, which an imported collection can fill with HTML.
				tip.replaceChildren(...rows);
				tip.style.left = `${left}px`;
				tip.style.top = `${top}px`;
				tip.style.opacity = "1";
			},
			destroy: () => {
				tip?.remove();
				tip = null;
			},
		},
	};
}
