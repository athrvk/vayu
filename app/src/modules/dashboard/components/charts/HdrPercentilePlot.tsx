/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Loading skeleton for the HDR percentile plot. The live plot itself is now
 * `HdrPercentileChart` (uPlot, in ./uplot); this skeleton holds the card's height
 * during a run so it doesn't pop when the final report arrives.
 */

import { HDR_DIMS } from "../../utils/chartGeometry";

const HDR_X_MARKS: Array<{ pct: number; label: string }> = [
	{ pct: 0, label: "0%" },
	{ pct: 50, label: "50%" },
	{ pct: 90, label: "90%" },
	{ pct: 95, label: "95%" },
	{ pct: 99, label: "99%" },
	{ pct: 99.9, label: "99.9%" },
];

/** Log-scale percentile mapping: 0% → 0, 99.99% → 1 (tail dominates). */
function pctToX(pct: number): number {
	const p = Math.min(99.99, Math.max(0, pct));
	if (p === 0) return 0;
	return Math.log10(1 / (1 - p / 100)) / Math.log10(1 / (1 - 99.99 / 100));
}

export function SkeletonHdrPlot({ message }: { message: string }) {
	const { VW, VH, PL, PR, PT, PB } = HDR_DIMS;
	const IW = VW - PL - PR;
	const skelToX = (pct: number) => PL + pctToX(pct) * IW;
	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f, i) => ({
		y: PT + (1 - f) * (VH - PT - PB),
		key: i,
	}));
	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 200, display: "block" }}>
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t) => (
					<line key={t.key} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="9"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{HDR_X_MARKS.map((m, i) => (
					<text key={i} x={skelToX(m.pct)} y={VH - 6}>
						{m.label}
					</text>
				))}
			</g>
			<text
				x={VW / 2}
				y={VH / 2}
				fontSize="11"
				fill="hsl(var(--muted-foreground))"
				textAnchor="middle"
				fontFamily="Space Grotesk, system-ui, sans-serif"
				fontStyle="italic"
			>
				{message}
			</text>
		</svg>
	);
}
