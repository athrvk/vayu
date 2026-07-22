/**
 * @vitest-environment jsdom
 */
/**
 * Characterization snapshots for the hero cards. Lock exact SVG/DOM output
 * BEFORE the B6 HeroCardShell extraction; the refactor must keep every snapshot
 * byte-identical (catches chrome drift, spacing changes, dropped bars/chips).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
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
import type { Breakpoint } from "../../utils/computeBreakpoint";

const crossed: Breakpoint = { crossed: true, concurrency: 45, timeSeconds: 6, p99Ms: 227 };
const notCrossed: Breakpoint = {
	crossed: false,
	concurrency: null,
	timeSeconds: null,
	p99Ms: null,
};

const snap = (ui: React.ReactElement) => {
	const { container } = render(ui);
	expect(container.innerHTML).toMatchSnapshot();
};

describe("hero cards (characterization)", () => {
	it("RateFidelityCard", () => snap(<RateFidelityCard targetRps={100} actualRps={96} />));
	it("ThroughputTwinCard (no queue chip)", () =>
		snap(<ThroughputTwinCard sendRate={96} throughput={96} avgQueueWaitMs={0} />));
	it("ThroughputTwinCard (queue chip)", () =>
		snap(<ThroughputTwinCard sendRate={120} throughput={80} avgQueueWaitMs={12} />));
	it("ErrorRateCard", () =>
		snap(
			<ErrorRateCard
				totalRequests={600}
				failedRequests={3}
				statusCodes={{ "200": 595, "404": 2, "500": 1, "0": 2 }}
			/>
		));
	it("DroppedRequestsCard", () => snap(<DroppedRequestsCard dropped={120} completed={880} />));
	it("AchievedThroughputCard", () =>
		snap(<AchievedThroughputCard throughput={3940} configuredConcurrency={50} />));
	it("ConcurrencyUtilCard", () =>
		snap(<ConcurrencyUtilCard currentConcurrency={47} configuredConcurrency={50} />));
	it("ProgressCard", () =>
		snap(<ProgressCard requestsSent={1500} requestsExpected={4000} currentRps={500} />));
	it("ThroughputCard", () => snap(<ThroughputCard throughput={1284} meanLatency={204} />));
	it("CurrentConcurrencyCard", () =>
		snap(
			<CurrentConcurrencyCard
				currentConcurrency={897}
				targetConcurrency={50}
				rampUpDurationSeconds={8}
				rampDeviationPct={1066}
			/>
		));
	it("SaturationCard (degrading)", () =>
		snap(<SaturationCard breakpoint={crossed} failedRequests={0} />));
	it("SaturationCard (healthy)", () =>
		snap(<SaturationCard breakpoint={notCrossed} failedRequests={0} />));
});
