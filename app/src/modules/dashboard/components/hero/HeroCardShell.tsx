/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared hero-card primitives (B6 simplify). Every hero card is the same card
 * chrome + eyebrow header with an InfoChip; most also have a single 34px value
 * row, and two carry a fidelity gauge. These extract that
 * common shape so the per-mode cards stay tiny and consistent. Cards with
 * bespoke bodies (ErrorRate's status stack, ThroughputTwin's 2-col grid,
 * Saturation's text headline) still use HeroCardShell and supply their own
 * children.
 */

import { type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { InfoChip, Eyebrow } from "../shared";

/** Card chrome + eyebrow + InfoChip; body is supplied as children. */
export function HeroCardShell({
	label,
	tip,
	children,
}: {
	label: ReactNode;
	tip: ReactNode;
	children: ReactNode;
}) {
	return (
		<Card pad="md" className="flex flex-col gap-1.5">
			<Eyebrow>
				{label}
				<InfoChip tip={tip} />
			</Eyebrow>
			{children}
		</Card>
	);
}

/**
 * The 34px headline value row. Pass `color` for a tier-colored value (omits
 * the default `text-foreground`); omit it for the standard foreground value.
 */
export function HeroValue({
	value,
	unit,
	color,
}: {
	value: ReactNode;
	unit?: ReactNode;
	color?: string;
}) {
	return (
		<div className="flex items-baseline gap-1 mt-0.5">
			<span
				className={cn(
					"text-hero font-bold leading-none font-mono tabular-nums transition-colors duration-150",
					!color && "text-foreground"
				)}
				style={color ? { color } : undefined}
			>
				{value}
			</span>
			{unit && <span className="text-xs text-muted-foreground">{unit}</span>}
		</div>
	);
}

/**
 * A fidelity gauge: the fill against a 100% target marker (Rate Fidelity /
 * Virtual user utilisation). Not a progress bar, and `aria-hidden`: the line
 * above it states the same percentage in words, and the run's progress is
 * `ProgressCard`'s `Progress`.
 */
export function MiniBar({ pct, color }: { pct: number; color: string }) {
	return (
		<div className="relative mt-2 h-1 rounded-sm bg-accent overflow-hidden" aria-hidden="true">
			<div
				// `transition-[width,background-color]`: both the fill's width and
				// its tier colour change live while a load test runs, and neither
				// had a transition - the bar jumped to its new length and its new
				// colour popped on the same tick.
				className="absolute inset-y-0 left-0 transition-[width,background-color] duration-150"
				style={{ width: `${pct}%`, background: color }}
			/>
			<span
				className="absolute top-[-3px] bottom-[-3px] w-px bg-primary"
				style={{ left: "100%" }}
			/>
		</div>
	);
}
