/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeroRow — the mode-adaptive Row 1. Two cards swap per mode; the Error Rate
 * card is universal. This is the single place that maps mode → hero cards
 * (consume {@link DashboardDerived}; never re-derive from raw metrics).
 */

import type { DashboardDerived } from "../../types";
import { RateFidelityCard } from "./RateFidelityCard";
import { ThroughputTwinCard } from "./ThroughputTwinCard";
import { ErrorRateCard } from "./ErrorRateCard";
import { DroppedRequestsCard } from "./DroppedRequestsCard";
import { AchievedThroughputCard } from "./AchievedThroughputCard";
import { ConcurrencyUtilCard } from "./ConcurrencyUtilCard";
import { ProgressCard } from "./ProgressCard";
import { ThroughputCard } from "./ThroughputCard";
import { CurrentConcurrencyCard } from "./CurrentConcurrencyCard";
import { SaturationCard } from "./SaturationCard";

export function HeroRow({ d }: { d: DashboardDerived }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
			{renderModeCards(d)}
			<ErrorRateCard
				totalRequests={d.totalRequests}
				failedRequests={d.failedRequests}
				statusCodes={d.statusCodes}
			/>
		</div>
	);
}

/** The two mode-sensitive hero cards (card #1 and card #2). */
function renderModeCards(d: DashboardDerived) {
	// "Current concurrency" is an instantaneous metric — it's 0 once the run
	// ends. On completed runs show the peak reached instead, so the live-only
	// concurrency cards stay meaningful in the historical view.
	const activeConcurrency = d.isCompleted ? d.peakConcurrency : d.currentConcurrency;
	switch (d.mode) {
		case "constant_concurrency":
			return (
				<>
					<AchievedThroughputCard
						throughput={d.throughput}
						configuredConcurrency={d.configuredConcurrency}
					/>
					<ConcurrencyUtilCard
						currentConcurrency={activeConcurrency}
						configuredConcurrency={d.configuredConcurrency}
					/>
				</>
			);
		case "iterations":
			return (
				<>
					<ProgressCard
						requestsSent={d.requestsSent}
						requestsExpected={d.requestsExpected}
						currentRps={d.currentRps}
					/>
					<ThroughputCard throughput={d.throughput} meanLatency={d.meanLatency} />
				</>
			);
		case "ramp_up":
			return (
				<>
					<CurrentConcurrencyCard
						currentConcurrency={activeConcurrency}
						targetConcurrency={d.targetConcurrency}
						rampUpDurationSeconds={d.rampUpDurationSeconds}
						rampDeviationPct={d.rampDeviationPct}
					/>
					<SaturationCard breakpoint={d.breakpoint} failedRequests={d.failedRequests} />
				</>
			);
		case "constant_rps":
		default:
			return (
				<>
					{d.showDropped ? (
						<DroppedRequestsCard
							dropped={d.droppedRequests}
							completed={d.totalRequests}
						/>
					) : (
						<RateFidelityCard targetRps={d.targetRps} actualRps={d.actualRps} />
					)}
					<ThroughputTwinCard
						sendRate={d.sendRate}
						throughput={d.throughput}
						avgQueueWaitMs={d.avgQueueWaitMs}
					/>
				</>
			);
	}
}
