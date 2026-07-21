/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * uPlot plugins for Vayu — the diagnostic-interactivity layer.
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
	/** Horizontal label side (default "right"); vertical always insets from the line. */
	align?: "left" | "right";
}

const dpr = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

/** Draw reference markers each frame (survives zoom/pan) via the `draw` hook. */
export function markersPlugin(getMarkers: () => Marker[], theme: UplotTheme): uPlot.Plugin {
	return {
		hooks: {
			draw: (u: uPlot) => {
				const ctx = u.ctx;
				const { left, top, width, height } = u.bbox;
				ctx.save();
				ctx.lineWidth = 1.5 * dpr();
				ctx.setLineDash([4 * dpr(), 4 * dpr()]);
				ctx.font = `${10 * dpr()}px "JetBrains Mono", monospace`;
				for (const m of getMarkers()) {
					const color = theme.color(m.role);
					ctx.strokeStyle = color;
					ctx.fillStyle = color;
					if (m.orient === "vertical") {
						const cx = u.valToPos(m.value, "x", true);
						if (cx < left || cx > left + width) continue;
						ctx.beginPath();
						ctx.moveTo(cx, top);
						ctx.lineTo(cx, top + height);
						ctx.stroke();
						ctx.textAlign = "left";
						ctx.fillText(m.label, cx + 4 * dpr(), top + 11 * dpr());
					} else {
						const cy = u.valToPos(m.value, m.scale ?? "y", true);
						if (cy < top || cy > top + height) continue;
						ctx.beginPath();
						ctx.moveTo(left, cy);
						ctx.lineTo(left + width, cy);
						ctx.stroke();
						const right = (m.align ?? "right") === "right";
						ctx.textAlign = right ? "right" : "left";
						ctx.fillText(
							m.label,
							right ? left + width - 4 * dpr() : left + 4 * dpr(),
							cy - 4 * dpr()
						);
					}
				}
				ctx.restore();
			},
		},
	};
}

export type ValueFormatter = (v: number | null | undefined) => string;

/**
 * Cursor tooltip — a positioned DOM overlay showing every series' value at the
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
				const rows: string[] = [
					`<div style="opacity:.7;margin-bottom:2px">${xLabel(xVal as number)}</div>`,
				];
				for (let s = 1; s < u.series.length; s++) {
					if (skip.has(s)) continue;
					const series = u.series[s];
					if (series.show === false) continue;
					const raw = u.data[s][idx];
					const formatted = (fmt[s] ?? ((v) => (v == null ? "—" : String(v))))(
						raw as number | null
					);
					const stroke =
						typeof series.stroke === "function" ? series.stroke(u, s) : series.stroke;
					rows.push(
						`<div style="display:flex;gap:8px;align-items:center;justify-content:space-between">` +
							`<span style="display:inline-flex;align-items:center;gap:5px">` +
							`<span style="width:8px;height:2px;background:${String(stroke)};display:inline-block"></span>` +
							`${series.label ?? ""}</span>` +
							`<span style="font-weight:600">${formatted}</span></div>`
					);
				}
				tip.innerHTML = rows.join("");
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
