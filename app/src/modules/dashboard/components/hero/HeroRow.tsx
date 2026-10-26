/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeroRow - the mode-adaptive Row 1. Two cards swap per mode; the Error Rate
 * card is universal, and the throughput-led modes add a latency card. This is
 * the single place that maps mode → hero cards (consume
 * {@link DashboardDerived}; never re-derive from raw metrics).
 */

import type { DashboardDerived } from "../../types";
import { RateFidelityCard } from "./RateFidelityCard";
import { ThroughputTwinCard } from "./ThroughputTwinCard";
import { ErrorRateCard } from "./ErrorRateCard";
import { DroppedRequestsCard } from "./DroppedRequestsCard";
import { AchievedThroughputCard } from "./AchievedThroughputCard";
import { ConcurrencyUtilCard } from "./ConcurrencyUtilCard";
import { CapacitySearchCard } from "./CapacitySearchCard";
import { ProgressCard } from "./ProgressCard";
import { ThroughputCard } from "./ThroughputCard";
import { CurrentConcurrencyCard } from "./CurrentConcurrencyCard";
import { CapacitySaturationCard, SaturationCard } from "./SaturationCard";
import { LatencyPercentilesCard } from "./LatencyPercentilesCard";

export function HeroRow({ d }: { d: DashboardDerived }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
			{renderModeCards(d)}
			{hasThroughputHero(d.mode) && <LatencyCard d={d} />}
			<ErrorRateCard
				totalRequests={d.totalRequests}
				failedRequests={d.failedRequests}
				httpErrors={d.httpErrors}
				noResponse={d.noResponse}
				statusCodes={d.statusCodes}
			/>
		</div>
	);
}

/**
 * The modes whose hero leads with throughput. ramp_up and capacity put their
 * p99 in the stats row (`P99AtPeakStat`), so they take no latency card here.
 */
function hasThroughputHero(mode: DashboardDerived["mode"]): boolean {
	return mode !== "ramp_up" && mode !== "capacity";
}

function LatencyCard({ d }: { d: DashboardDerived }) {
	return (
		<LatencyPercentilesCard
			p95={d.p95Latency}
			p99={d.p99Latency}
			meanLatency={d.meanLatency}
			medianLatency={d.medianLatency}
		/>
	);
}

/** The two mode-sensitive hero cards (card #1 and card #2). */
function renderModeCards(d: DashboardDerived) {
	// "Active virtual users" is an instantaneous metric - it's 0 once the run
	// ends. On completed runs show the peak reached instead, so the live-only
	// concurrency cards stay meaningful in the historical view. The utilisation
	// card in constant_concurrency prefers the mean on the wire (`avgInFlight`)
	// and uses this only for a run stored before the mean existed.
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
						meanInFlight={d.avgInFlight}
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
		// Capacity discovery climbs toward the ceiling the user set, so the
		// question its hero answers is "how far up is it, and has the target
		// given out yet" - the same pair `ramp_up` asks, read against the cap
		// rather than against a planned curve. `ConcurrencyUtilCard` is not
		// reused either: its "N of 100 active" reads progress toward the ceiling
		// as load held (#2929). `CurrentConcurrencyCard` is
		// deliberately not reused here: its subtitle states a ramp duration and
		// a ramp lag, and a search has neither.
		case "capacity":
			return (
				<>
					<CapacitySearchCard
						live={d.liveCapacity}
						capacity={d.capacity}
						ceiling={d.configuredConcurrency}
					/>
					<CapacitySaturationCard
						capacity={d.capacity}
						isCompleted={d.isCompleted}
						breakpoint={d.breakpoint}
						failedRequests={d.failedRequests}
					/>
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
						isCompleted={d.isCompleted}
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
							skipped={d.skippedRequests}
							stalledMs={d.stalledMs}
						/>
					) : (
						<RateFidelityCard
							targetRps={d.targetRps}
							actualRps={d.actualRps}
							achievement={d.rateAchievementPct}
							stoppedAt={d.stoppedAt}
						/>
					)}
					<ThroughputTwinCard
						sendRate={d.sendRate}
						throughput={d.receivedRate ?? d.throughput}
						receivedWindow={d.receivedWindow}
						status={d.dispatchStatus}
						avgQueueWaitMs={d.avgQueueWaitMs}
						medianLatency={d.medianLatency}
					/>
				</>
			);
	}
}
