/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Overview's Error classes card (#3828): a run's failed MCP replies by
 * class, and the JSON-RPC codes behind the protocol ones. It is drawn only when
 * the run counted something, and the two ways of having nothing to show are
 * different runs that look alike here: the key absent is a run stored before
 * the engine counted classes, `{}` one that counted and saw no failed reply.
 *
 * Mutation-check: drop `<ErrorClassesCard>` from `OverviewTab.tsx` and the
 * counts case fails; remove the `some(... > 0)` guard in `ErrorClassesCard.tsx`
 * and the `{}` case fails; drop the `!errorClasses` guard and the absent case
 * throws; reorder `ERROR_CLASS_KEYS` and the order case fails; sort the codes
 * as strings and the codes case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { ErrorClassCounts, RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

function makeReport(errorClasses?: ErrorClassCounts): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 50 },
		},
		summary: {
			totalRequests: 200,
			successfulRequests: 170,
			failedRequests: 30,
			errorRate: 15,
			totalDurationSeconds: 3,
			avgRps: 66,
			...(errorClasses === undefined ? {} : { errorClasses }),
		},
		latency: { min: 1, max: 900, avg: 20, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: { "200": 170 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

function renderTab(report: RunReport) {
	return render(
		withQueryClient(
			<OverviewTab
				report={report}
				runId="run_1"
				derived={reportToDerived(report)}
				anomalies={[]}
			/>
		)
	);
}

const cardTitle = () => screen.queryByText("Error classes");

describe("OverviewTab error classes card", () => {
	it("counts the three classes in a fixed order, a class nothing failed in reading 0", () => {
		renderTab(makeReport({ tool: 20, transport: 5 }));

		const card = cardTitle()?.closest("[data-slot=card]") as HTMLElement;
		const labels = within(card)
			.getAllByText(/^(Transport|Protocol|Tool)$/)
			.map((el) => ({
				label: el.textContent,
				count: el.parentElement?.querySelector("p")?.textContent,
			}));

		expect(labels).toEqual([
			{ label: "Transport", count: "5" },
			{ label: "Protocol", count: "0" },
			{ label: "Tool", count: "20" },
		]);
	});

	it("lists the JSON-RPC codes behind the protocol failures, numerically, other last", () => {
		renderTab(
			makeReport({
				protocol: 15,
				protocolCodes: { other: 1, "-32602": 10, "-32000": 4, "-32700": 2 },
			})
		);

		const codes = screen
			.getByText("JSON-RPC error codes")
			.parentElement!.querySelectorAll("li");

		// -32700 sorts below -32602 below -32000, which a string sort would not give.
		expect([...codes].map((li) => li.textContent)).toEqual([
			"-32700 2",
			"-32602 10",
			"-32000 4",
			"other 1",
		]);
	});

	it("omits the codes section when the run counted no protocol code", () => {
		renderTab(makeReport({ tool: 1 }));

		expect(cardTitle()).not.toBeNull();
		expect(screen.queryByText("JSON-RPC error codes")).toBeNull();
	});

	it("is absent for a run stored before the engine counted classes", () => {
		renderTab(makeReport());

		expect(cardTitle()).toBeNull();
	});

	it("is absent for a run that counted classes and saw no failed reply", () => {
		renderTab(makeReport({}));

		expect(cardTitle()).toBeNull();
	});
});
