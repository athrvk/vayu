/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * uPlot plugins for Vayu — the diagnostic-interactivity layer.
 *
 * SPIKE (N3): the point of moving to uPlot is NOT prettier lines — it's letting
 * a user *understand the service under test*. That means reading exact values at
 * any instant, correlating metrics at the same instant, zooming into the moment
 * of degradation, and seeing computed insights (the capacity breakpoint) marked
 * on the axis. These plugins provide those affordances; uPlot's built-ins
 * (drag-zoom, cursor.sync) provide the rest.
 */

import type uPlot from "uplot";
import type { UplotTheme } from "./uplotTheme";

/** One vertical marker on the time axis (e.g. the SLO breakpoint, ramp phases). */
export interface Annotation {
	/** x value (elapsed seconds) at which to draw the marker. */
	x: number;
	label: string;
	color: string;
}

/**
 * Draw vertical annotation lines with labels — ties a chart to a computed
 * insight. The obvious first use is the W1 capacity breakpoint: "p99 crossed the
 * SLO here, at concurrency N". Static markers, redrawn each frame via the `draw`
 * hook so they survive zoom/pan.
 */
export function annotationsPlugin(getAnnotations: () => Annotation[]): uPlot.Plugin {
	return {
		hooks: {
			draw: (u: uPlot) => {
				const { ctx } = u;
				const annos = getAnnotations();
				const top = u.bbox.top;
				const height = u.bbox.height;
				ctx.save();
				for (const a of annos) {
					const cx = u.valToPos(a.x, "x", true);
					if (cx < u.bbox.left || cx > u.bbox.left + u.bbox.width) continue;
					ctx.strokeStyle = a.color;
					ctx.lineWidth = 1.5 * devicePixelRatio;
					ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
					ctx.beginPath();
					ctx.moveTo(cx, top);
					ctx.lineTo(cx, top + height);
					ctx.stroke();
					ctx.setLineDash([]);
					ctx.fillStyle = a.color;
					ctx.font = `${10 * devicePixelRatio}px "JetBrains Mono", monospace`;
					ctx.textAlign = "left";
					ctx.fillText(a.label, cx + 4 * devicePixelRatio, top + 11 * devicePixelRatio);
				}
				ctx.restore();
			},
		},
	};
}

/** Formats a value for the tooltip; falls back to a dash for gaps/nulls. */
export type ValueFormatter = (v: number | null | undefined) => string;

/**
 * Cursor tooltip — a positioned DOM overlay showing every series' value at the
 * hovered instant. This is the core "understand the service" affordance: at
 * t=42.1s you see RPS, p50/p95/p99, error-rate and concurrency together, so a
 * p99 spike can be read against the concurrency and error columns at the same x.
 *
 * Pairs with uPlot's `cursor.sync` (same sync key across charts) so hovering one
 * chart moves the cursor on all of them — cross-metric correlation for free.
 */
export function tooltipPlugin(opts: {
	theme: UplotTheme;
	/** Per-series value formatter, indexed by series position (1-based data idx). */
	format?: Record<number, ValueFormatter>;
	xLabel?: (x: number) => string;
}): uPlot.Plugin {
	let tip: HTMLDivElement | null = null;
	const fmt = opts.format ?? {};
	const xLabel = opts.xLabel ?? ((x: number) => `${x.toFixed(1)}s`);

	return {
		hooks: {
			init: (u: uPlot) => {
				tip = document.createElement("div");
				Object.assign(tip.style, {
					position: "absolute",
					pointerEvents: "none",
					zIndex: "10",
					padding: "6px 8px",
					font: opts.theme.font,
					background: "hsl(var(--card))",
					color: "hsl(var(--card-foreground))",
					border: "1px solid hsl(var(--border))",
					borderRadius: "6px",
					boxShadow: "0 4px 12px hsl(var(--foreground) / 0.12)",
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
