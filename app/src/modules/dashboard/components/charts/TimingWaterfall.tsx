/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { type ReactNode } from "react";
import type { RunReport } from "@/types";
import { InfoChip } from "../shared";

/**
 * Timing waterfall - from report.timingBreakdown. Always renders 5 rows so the
 * card height stays constant; during live (no report yet) values show "-" and
 * bars are empty.
 */
export function TimingWaterfall({ report }: { report: RunReport | null }) {
	const tb = report?.timingBreakdown;
	const hasData = !!tb;

	const stages: Array<{ k: string; v: number | undefined; color: string; tip: ReactNode }> = [
		{
			k: "DNS",
			v: tb?.avgDnsMs,
			color: "hsl(var(--chart-2))",
			tip: "Hostname → IP resolution. Usually a few ms once cached; >50ms suggests slow DNS or a fresh lookup per request.",
		},
		{
			k: "Connect",
			v: tb?.avgConnectMs,
			color: "hsl(var(--chart-4))",
			tip: "TCP three-way handshake. Zero on connection reuse (HTTP keep-alive / HTTP/2).",
		},
		{
			k: "TLS",
			v: tb?.avgTlsMs,
			color: "hsl(var(--chart-5))",
			tip: "SSL/TLS handshake (HTTPS only). Zero for plain HTTP and on resumed connections.",
		},
		{
			k: "TTFB",
			v: tb?.avgFirstByteMs,
			color: "hsl(var(--primary))",
			tip: "Time to first byte. Server processing time + propagation. This is where slow endpoints reveal themselves - if TTFB dominates, the bottleneck is the server, not the network.",
		},
		{
			k: "Download",
			v: tb?.avgDownloadMs,
			color: "hsl(var(--success))",
			tip: "Response body transfer time. Big for large payloads or slow links; near-zero for small JSON responses.",
		},
	];

	const total = stages.reduce((s, x) => s + (x.v ?? 0), 0);
	const widthFor = (v: number | undefined) =>
		hasData && total > 0 ? `${((v ?? 0) / total) * 100}%` : "0%";

	return (
		<>
			{stages.map((s) => (
				<div key={s.k} className="grid grid-cols-[68px_1fr_70px] items-center gap-2.5 py-1">
					<span className="text-[11px] text-muted-foreground">
						{s.k}
						<InfoChip tip={s.tip} />
					</span>
					<div className="h-2 rounded-sm bg-accent overflow-hidden">
						<span
							className="block h-full transition-[width] duration-300"
							style={{ width: widthFor(s.v), background: s.color }}
						/>
					</div>
					<span className="text-right font-mono tabular-nums text-[11px] font-medium">
						{hasData && s.v !== undefined ? (
							<>
								<span className="text-foreground">{s.v.toFixed(0)}</span>
								<span className="text-subtle-foreground ml-0.5">ms</span>
							</>
						) : (
							<span className="text-subtle-foreground">-</span>
						)}
					</span>
				</div>
			))}
			<div className="mt-2.5 pt-2.5 border-t border-dashed border-border flex justify-between text-[11px] text-muted-foreground">
				<span>Avg total</span>
				<span className="font-mono font-semibold">
					{hasData ? (
						<span className="text-foreground">{total.toFixed(0)} ms</span>
					) : (
						<span className="text-subtle-foreground">- ms</span>
					)}
				</span>
			</div>
		</>
	);
}
