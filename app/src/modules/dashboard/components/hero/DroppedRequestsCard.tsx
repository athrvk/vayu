/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/utils";
import { Eyebrow, InfoChip } from "../shared";

/**
 * Replaces the Rate Fidelity hero card when a constant_rps run has dropped
 * requests. A drop means the generator could not submit because its in-flight
 * pool filled up — the server, not the generator, is the bottleneck.
 */
export function DroppedRequestsCard({
	dropped,
	completed,
}: {
	dropped: number;
	completed: number;
}) {
	const scheduled = dropped + completed;
	const pct = scheduled > 0 ? (dropped / scheduled) * 100 : 0;

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Dropped Requests
				<InfoChip
					tip={
						<>
							Requests the generator could not submit because its in-flight pool
							filled up. Root cause is usually slow server responses tying up curl
							handles. Lowering <code>targetRps</code> or raising{" "}
							<code>maxInFlight</code> defers drops in exchange for higher queue wait
							— but the server is still the bottleneck.
						</>
					}
				/>
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color: "hsl(var(--destructive))" }}
				>
					{formatNumber(dropped)}
				</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				of <span className="text-foreground font-semibold">{formatNumber(scheduled)}</span>{" "}
				scheduled · <span className="text-foreground font-semibold">{pct.toFixed(1)}</span>%
			</p>
			<p className="text-[11px] mt-2" style={{ color: "hsl(var(--warning))" }}>
				Server saturating — try lowering target RPS
			</p>
		</div>
	);
}
