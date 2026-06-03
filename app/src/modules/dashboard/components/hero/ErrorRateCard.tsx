/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { InfoChip } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell } from "./HeroCardShell";

/** Status-code buckets: stack-bar fill + legend entry share one definition. */
interface StatusSegment {
	key: "s2" | "s4" | "s5" | "err";
	label: string;
	bg: string; // Tailwind bg-* class for the stack bar
	color: string; // CSS color for the legend swatch
	infoTip?: React.ReactNode;
}
const STATUS_SEGMENTS: readonly StatusSegment[] = [
	{ key: "s2", label: "2xx", bg: "bg-success", color: "hsl(var(--success))" },
	{ key: "s4", label: "4xx", bg: "bg-warning", color: "hsl(var(--warning))" },
	{ key: "s5", label: "5xx", bg: "bg-destructive", color: "hsl(var(--destructive))" },
	{
		key: "err",
		label: "err",
		bg: "bg-subtle-foreground",
		color: "hsl(var(--subtle-foreground))",
		infoTip: TOOLTIPS.errorRateTransport,
	},
];

/**
 * Universal hero card #3 — transport-layer error rate + status-code stack.
 * Bespoke body (gap-2 value row with a right-aligned count + stack + legend).
 */
export function ErrorRateCard({
	totalRequests,
	failedRequests,
	statusCodes,
}: {
	totalRequests: number;
	failedRequests: number;
	statusCodes: Record<string, number>;
}) {
	const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;
	const valueColor = errorRate === 0 ? "hsl(var(--success))" : "hsl(var(--destructive))";

	// Bucket status codes by class
	const buckets = useMemo(() => {
		const out: Record<StatusSegment["key"], number> = { s2: 0, s4: 0, s5: 0, err: 0 };
		for (const [codeStr, count] of Object.entries(statusCodes ?? {})) {
			const code = Number(codeStr);
			if (code >= 200 && code < 300) out.s2 += count;
			else if (code >= 400 && code < 500) out.s4 += count;
			else if (code >= 500 && code < 600) out.s5 += count;
			else out.err += count; // 0 / unknown — transport errors
		}
		const total = out.s2 + out.s4 + out.s5 + out.err;
		return { ...out, total };
	}, [statusCodes]);

	const widthFor = (n: number) => (buckets.total > 0 ? `${(n / buckets.total) * 100}%` : "0%");

	return (
		<HeroCardShell label="Error Rate" tip={TOOLTIPS.errorRate}>
			<div className="flex items-baseline gap-2 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color: valueColor }}
				>
					{errorRate.toFixed(1)}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
				<span className="ml-auto text-[11px] font-mono text-subtle-foreground">
					{formatNumber(failedRequests)} / {formatNumber(totalRequests)}
				</span>
			</div>
			{/* Always render the stack + legend so the card height doesn't jump
			    when the final report arrives. During live the bar is empty;
			    after completion it fills with the real distribution. */}
			<div className="flex h-2 mt-2 rounded-sm border border-border bg-accent overflow-hidden">
				{STATUS_SEGMENTS.map((s) => (
					<span
						key={s.key}
						className={cn("block h-full transition-[width] duration-300", s.bg)}
						style={{ width: widthFor(buckets[s.key]) }}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-3 mt-2 text-[11px] font-mono text-muted-foreground">
				{STATUS_SEGMENTS.map((s) => (
					<StatusLegend
						key={s.key}
						color={s.color}
						label={s.label}
						count={buckets[s.key]}
						infoTip={s.infoTip}
					/>
				))}
			</div>
		</HeroCardShell>
	);
}

function StatusLegend({
	color,
	label,
	count,
	infoTip,
}: {
	color: string;
	label: string;
	count: number;
	infoTip?: React.ReactNode;
}) {
	const dim = count === 0;
	return (
		<span className={cn(dim && "text-subtle-foreground")}>
			<span
				className="inline-block w-2 h-2 rounded-sm mr-1.5 align-[1px]"
				style={{ background: color }}
			/>
			{label} {count}
			{infoTip && <InfoChip tip={infoTip} />}
		</span>
	);
}
