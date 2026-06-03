/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared hero-card primitives (B6 simplify). Every hero card is the same card
 * chrome + eyebrow header with an InfoChip; most also have a single 34px value
 * row, and three carry a fidelity-style progress bar. These extract that
 * common shape so the per-mode cards stay tiny and consistent. Cards with
 * bespoke bodies (ErrorRate's status stack, ThroughputTwin's 2-col grid,
 * Saturation's text headline) still use HeroCardShell and supply their own
 * children.
 */

import { type ReactNode } from "react";
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
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				{label}
				<InfoChip tip={tip} />
			</Eyebrow>
			{children}
		</div>
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
					"text-[34px] font-bold leading-none font-mono tabular-nums",
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
 * Fidelity-style progress bar. `showTarget` draws the 100% target marker line
 * (Rate Fidelity / Concurrency Utilisation); Progress omits it.
 */
export function MiniBar({
	pct,
	color,
	showTarget = false,
}: {
	pct: number;
	color: string;
	showTarget?: boolean;
}) {
	return (
		<div className="relative mt-2 h-1 rounded-sm border border-border bg-accent overflow-hidden">
			<div
				className="absolute inset-y-0 left-0"
				style={{ width: `${pct}%`, background: color }}
			/>
			{showTarget && (
				<span
					className="absolute top-[-3px] bottom-[-3px] w-px bg-primary"
					style={{ left: "100%" }}
				/>
			)}
		</div>
	);
}
