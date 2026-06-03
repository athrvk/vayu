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
 *
 * NOTE (Plan 4 fan-out): the per-mode branches for constant_concurrency,
 * iterations, and ramp_up are filled in by task A1. Until then every mode
 * renders the constant_rps layout, preserving today's behaviour exactly.
 */

import type { DashboardDerived } from "../../types";
import { RateFidelityCard } from "./RateFidelityCard";
import { ThroughputTwinCard } from "./ThroughputTwinCard";
import { ErrorRateCard } from "./ErrorRateCard";
import { DroppedRequestsCard } from "./DroppedRequestsCard";

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
	// A1 adds: constant_concurrency → Achieved Throughput + Concurrency Util;
	//          iterations → Progress + Throughput;
	//          ramp_up → Current Concurrency + Saturation.
	// constant_rps (and the fallback for all modes until A1 lands):
	return (
		<>
			{d.showDropped ? (
				<DroppedRequestsCard dropped={d.droppedRequests} completed={d.totalRequests} />
			) : (
				<RateFidelityCard targetRps={d.targetRps} actualRps={d.actualRps} />
			)}
			<ThroughputTwinCard sendRate={d.sendRate} throughput={d.throughput} />
		</>
	);
}
