/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatPercent, formatSeconds } from "@/lib/format-number";
import { TOOLTIPS } from "../tooltips";
import { computeEta } from "../../utils/computeEta";
import { Progress } from "@/components/ui/progress";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * iterations hero card #1 - progress through the configured iteration count.
 * The bar fills as requests are sent, not as responses return; ETA is
 * projected from current throughput.
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
			<HeroValue value={pct !== undefined ? formatPercent(pct) : "-"} unit="%" />
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{formatNumber(requestsSent)}</span>{" "}
				/{" "}
				<span className="text-foreground font-semibold">
					{formatNumber(requestsExpected)}
				</span>{" "}
				sent · ETA{" "}
				<span className="text-foreground font-semibold">
					{eta !== null ? formatSeconds(eta) : "-"}
				</span>
			</p>
			{/* `h-1` to sit level with the fidelity gauges beside it in the hero row. */}
			{pct !== undefined && (
				<Progress value={pct / 100} label="Run progress" className="mt-2 h-1" />
			)}
		</HeroCardShell>
	);
}
