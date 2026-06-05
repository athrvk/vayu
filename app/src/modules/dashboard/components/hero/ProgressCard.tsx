/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/utils";
import { TOOLTIPS } from "../tooltips";
import { computeEta } from "../../utils/computeEta";
import { HeroCardShell, HeroValue, MiniBar } from "./HeroCardShell";

/**
 * iterations hero card #1 — progress through the configured iteration count.
 * The bar fills as requests complete; ETA is projected from current throughput.
 */
export function ProgressCard({
	requestsSent,
	requestsExpected,
	currentRps,
}: {
	requestsSent: number;
	requestsExpected: number;
	currentRps: number;
}) {
	const pct =
		requestsExpected > 0 ? Math.min(100, (requestsSent / requestsExpected) * 100) : undefined;
	const eta = computeEta({ requestsExpected, requestsSent, currentRps });

	return (
		<HeroCardShell label="Progress" tip={TOOLTIPS.progress}>
			<HeroValue value={pct !== undefined ? pct.toFixed(0) : "—"} unit="%" />
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{formatNumber(requestsSent)}</span>{" "}
				/{" "}
				<span className="text-foreground font-semibold">
					{formatNumber(requestsExpected)}
				</span>{" "}
				complete · ETA{" "}
				<span className="text-foreground font-semibold">
					{eta !== null ? eta.toFixed(0) : "—"}
				</span>
				s
			</p>
			{pct !== undefined && <MiniBar pct={pct} color="hsl(var(--primary))" />}
		</HeroCardShell>
	);
}
