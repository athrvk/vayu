/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format-number";
import { formatErrorPercent } from "../../utils/format";
import { InfoChip } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell } from "./HeroCardShell";

/** Status-code buckets: stack-bar fill + legend entry share one definition. */
interface StatusSegment {
	key: "ok" | "s4" | "s5" | "none";
	label: string;
	bg: string; // Tailwind bg-* class for the stack bar
	color: string; // CSS color for the legend swatch
	infoTip?: React.ReactNode;
}
const STATUS_SEGMENTS: readonly StatusSegment[] = [
	{ key: "ok", label: "2xx/3xx", bg: "bg-success", color: "hsl(var(--success))" },
	{ key: "s4", label: "4xx", bg: "bg-warning", color: "hsl(var(--warning))" },
	{ key: "s5", label: "5xx", bg: "bg-destructive", color: "hsl(var(--destructive))" },
	{
		key: "none",
		label: "No response",
		bg: "bg-subtle-foreground",
		color: "hsl(var(--subtle-foreground))",
		infoTip: TOOLTIPS.errorRateNoResponse,
	},
];

/**
 * The bucket a status code draws in. The engine counts 200-399 as success
 * (3xx included) and status 0 as no response; anything else it counts as an
 * HTTP error, so a code outside the 4xx and 5xx classes lands with 5xx rather
 * than being dropped from the bar.
 */
function bucketFor(code: number): StatusSegment["key"] {
	if (code === 0) return "none";
	if (code >= 200 && code < 400) return "ok";
	if (code >= 400 && code < 500) return "s4";
	return "s5";
}

/**
 * Universal hero card #3 - error rate + status-code stack. An error is a
 * response outside 2xx/3xx or no response at all (issue #2124); the legend
 * splits the count into "HTTP errors" and "No response". Bespoke body (gap-2
 * value row with a right-aligned count + stack + legend).
 */
export function ErrorRateCard({
	totalRequests,
	failedRequests,
	httpErrors,
	noResponse,
	statusCodes,
}: {
	totalRequests: number;
	failedRequests: number;
	httpErrors: number;
	noResponse: number;
	statusCodes: Record<string, number>;
}) {
	const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;
	// A rate under 0.1% takes a second decimal so it does not print as 0.0, and
	// the colour follows the printed digits: red means errors happened, and the
	// number beside it must say so (a request cancelled by Stop is in neither).
	const digits = formatErrorPercent(errorRate, errorRate > 0 && errorRate < 0.1 ? 2 : 1);
	// -text variants: this is the card's large number. The STATUS entries above
	// keep the fill tokens - those paint legend swatches, not text.
	const valueColor = errorRate > 0 ? "hsl(var(--destructive-text))" : "hsl(var(--success-text))";

	// Bucket status codes by class
	const buckets = useMemo(() => {
		const out: Record<StatusSegment["key"], number> = { ok: 0, s4: 0, s5: 0, none: 0 };
		for (const [codeStr, count] of Object.entries(statusCodes ?? {})) {
			out[bucketFor(Number(codeStr))] += count;
		}
		const total = out.ok + out.s4 + out.s5 + out.none;
		return { ...out, total };
	}, [statusCodes]);

	const widthFor = (n: number) => (buckets.total > 0 ? `${(n / buckets.total) * 100}%` : "0%");

	return (
		<HeroCardShell label="Error rate" tip={TOOLTIPS.errorRate}>
			<div className="flex items-baseline gap-2 mt-0.5">
				<span
					className="text-hero font-bold leading-none font-mono tabular-nums transition-colors duration-150"
					style={{ color: valueColor }}
				>
					{digits}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
				<span className="ml-auto text-label font-mono text-muted-foreground">
					{formatNumber(failedRequests)} / {formatNumber(totalRequests)}
				</span>
			</div>
			{/* Always render the stack + legend so the card height doesn't jump
			    when the final report arrives. The bar fills from the live tick's
			    status map and is replaced by the report's distribution at the end. */}
			<div className="flex h-2 mt-2 rounded-sm bg-accent overflow-hidden">
				{STATUS_SEGMENTS.map((s) => (
					<span
						key={s.key}
						className={cn("block h-full transition-[width] duration-300", s.bg)}
						style={{ width: widthFor(buckets[s.key]) }}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-3 mt-2 text-label font-mono text-muted-foreground">
				{STATUS_SEGMENTS.map((s) => (
					<StatusLegend
						key={s.key}
						color={s.color}
						label={s.label}
						count={s.key === "none" ? noResponse : buckets[s.key]}
						infoTip={s.infoTip}
					/>
				))}
			</div>
			<p className="text-label font-mono text-muted-foreground">
				HTTP errors {formatNumber(httpErrors)}
			</p>
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
		<span className={cn(dim && "text-muted-foreground")}>
			<span
				className="inline-block w-2 h-2 rounded-sm mr-1.5 align-[1px]"
				style={{ background: color }}
			/>
			{label} {count}
			{infoTip && <InfoChip tip={infoTip} />}
		</span>
	);
}
