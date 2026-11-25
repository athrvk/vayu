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
			pooledLatency={d.pooledLatency}
		/>
	);
}

/** The two mode-sensitive hero cards (card #1 and card #2). */
function renderModeCards(d: DashboardDerived) {
	// "Active virtual users" is instantaneous and 0 once the run ends, so a completed run shows the
	// peak reached, keeping the live-only concurrency cards meaningful in the historical view.
	// constant_concurrency's utilisation card prefers the mean on the wire (`avgInFlight`) and uses
	// this only for a run stored before the mean existed.
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
					<ThroughputCard
						throughput={d.throughput}
						meanIterationTime={d.meanIterationTime}
					/>
				</>
			);
		// Capacity discovery climbs toward the user's ceiling, so its hero answers "how far up is
		// it, and has the target given out yet", `ramp_up`'s pair read against the cap rather than
		// a planned curve. Neither concurrency card is reused: `ConcurrencyUtilCard`'s "N of 100
		// active" reads progress toward the ceiling as load held (#2929), and
		// `CurrentConcurrencyCard`'s subtitle states a ramp duration and a ramp lag, which a search
		// has neither of.
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
