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
 * The header's status pill says how the run ended (#1932).
 *
 * A failed run reached the pill as "completed" and drew the neutral grey
 * Completed chip. Every ending now has its own word and its own status family;
 * a live run says Running (#3351), and a run that is neither live nor ended
 * draws nothing.
 *
 * The engine's phase (#3568): a live run draining its in-flight requests reads
 * Finishing, names what it waits on and offers Stop waiting; the clock reads
 * elapsed over the plan when the run has one.
 *
 * Mutation check: give `failed` the `bg-muted` tint in `RUN_STATUS` and the
 * family assertion reddens; draw `endedAs` alone in `DashboardHeader` and the
 * Running case reddens; gate Stop on `endedAs === null` instead of `live` and
 * the neither-live-nor-ended case reddens. Drop the `label` override on the pill
 * (or on Stop) and the draining cases redden; ignore `draining` and gate on
 * `waitingOn` alone and the "no phase" case reddens; print elapsed alone and the
 * planned-duration case reddens.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardHeader from "./DashboardHeader";
import type { FinishedKind } from "@/stores/dashboard-store";
import type { DashboardHeaderProps } from "../types";

vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: unknown) => unknown) =>
		select({ openTabs: [], activeTabId: null, openTab: vi.fn(), closeTab: vi.fn() }),
	useDashboardStore: (select: (s: unknown) => unknown) => select({ sourceRequestId: null }),
}));

function mount(
	endedAs: FinishedKind | null,
	live = false,
	outcome?: DashboardHeaderProps["outcome"],
	extra: Partial<DashboardHeaderProps> = {}
) {
	const props: DashboardHeaderProps = {
		live,
		endedAs,
		isStopping: false,
		onStop: async () => {},
		outcome,
		...extra,
	};
	return render(<DashboardHeader {...props} />);
}

const pill = () => document.querySelector("[data-status]");

describe("DashboardHeader status pill", () => {
	it("draws a failed run as Failed in the error family, never the neutral chip", () => {
		mount("failed");

		const el = screen.getByText("Failed").closest("[data-status]");
		expect(el).not.toBeNull();
		expect(el!.className).toContain("text-status-error-text");
		expect(el!.className).toContain("bg-status-error/15");
		expect(el!.className).not.toContain("bg-muted");
		// Nothing left to stop once the run has failed.
		expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
	});

	it.each([
		["completed", "Completed", "text-status-success-text"],
		["stopped", "Stopped", "text-status-stopped-text"],
	] as const)("draws %s as %s in its own family", (mode, label, textClass) => {
		mount(mode);

		const el = screen.getByText(label).closest("[data-status]");
		expect(el!.className).toContain(textClass);
		expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
	});

	it("draws Running while the run is live and keeps the Stop button", () => {
		mount(null, true);

		const el = screen.getByText("Running").closest("[data-status]");
		expect(el!.className).toContain("text-status-running-text");
		expect(el!.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
	});

	it("draws no pill and no Stop for a run that is neither live nor ended", () => {
		mount(null, false);
		expect(pill()).toBeNull();
		expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
	});

	describe("a completed run's verdict (#2130)", () => {
		/** The pill's glyph with its colour classes stripped, so only the shape is compared. */
		function glyphShape(outcome?: DashboardHeaderProps["outcome"]): string {
			const { unmount } = mount("completed", false, outcome);
			const markup = pill()!
				.querySelector("svg")!
				.outerHTML.replace(/class="[^"]*"/g, "");
			unmount();
			return markup;
		}

		it("keeps the success tick for a run that passed", () => {
			expect(glyphShape("passed")).toBe(glyphShape());
		});

		it.each([
			["failed", "text-status-error-text", "bg-status-error/15"],
			["not-judged", "text-muted-foreground", "bg-muted"],
		] as const)(
			"draws %s without the success tick or the success family",
			(outcome, text, tint) => {
				const success = glyphShape("passed");
				mount("completed", false, outcome);

				const el = screen.getByText("Completed").closest("[data-status]")!;
				expect(el.className).toContain(text);
				expect(el.className).toContain(tint);
				expect(el.className).not.toContain("success");
				expect(glyphShape(outcome)).not.toBe(success);
			}
		);

		it("gives a failed verdict and an unjudged one different shapes", () => {
			expect(glyphShape("failed")).not.toBe(glyphShape("not-judged"));
		});

		it("leaves every other ending as it was, whatever verdict it is handed", () => {
			mount("failed", false, "not-judged");

			const el = screen.getByText("Failed").closest("[data-status]")!;
			expect(el.className).toContain("text-status-error-text");
		});
	});

	describe("the engine's phase (#3568)", () => {
		it("draws a draining run as Finishing, waiting on its in-flight requests, with Stop waiting", () => {
			mount(null, true, undefined, { draining: true, waitingOn: 10 });

			const el = screen.getByText("Finishing").closest("[data-status]")!;
			// Still a running run: the status family and the spinner stay.
			expect(el.getAttribute("data-status")).toBe("running");
			expect(el.className).toContain("text-status-running-text");
			expect(screen.queryByText("Running")).toBeNull();
			expect(screen.getByText(/waiting on 10 requests/)).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /^stop waiting$/i })).toBeInTheDocument();
		});

		it("says request, not requests, for one", () => {
			mount(null, true, undefined, { draining: true, waitingOn: 1 });
			expect(screen.getByText(/waiting on 1 request$/)).toBeInTheDocument();
		});

		it("names nothing to wait on when no request is left", () => {
			mount(null, true, undefined, { draining: true, waitingOn: 0 });
			expect(screen.getByText("Finishing")).toBeInTheDocument();
			expect(screen.queryByText(/waiting on/)).toBeNull();
		});

		it("draws a run with no phase as Running, with Stop and no waiting line", () => {
			mount(null, true, undefined, { elapsedDuration: 18_000 });

			expect(screen.getByText("Running")).toBeInTheDocument();
			expect(screen.queryByText("Finishing")).toBeNull();
			expect(screen.queryByText(/waiting on/)).toBeNull();
			expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
		});

		it("draws Running when only the count is present, because the phase says draining", () => {
			mount(null, true, undefined, { draining: false, waitingOn: 5 });

			expect(screen.getByText("Running")).toBeInTheDocument();
			expect(screen.queryByText(/waiting on/)).toBeNull();
			expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
		});

		it("is Stopping… while the stop is in flight, drain or not", () => {
			mount(null, true, undefined, { draining: true, waitingOn: 3, isStopping: true });
			expect(screen.getByRole("button", { name: /stopping/i })).toBeDisabled();
		});

		it("reads elapsed over the planned duration when the run has one", () => {
			mount(null, true, undefined, { elapsedDuration: 18_000, plannedSeconds: 15 });
			expect(screen.getByText(/00:18 \/ 00:15/)).toBeInTheDocument();
			expect(screen.queryByText(/elapsed/)).toBeNull();
		});

		it("reads elapsed alone for a run with no planned duration", () => {
			mount(null, true, undefined, { elapsedDuration: 18_000 });
			expect(screen.getByText(/00:18 elapsed/)).toBeInTheDocument();
			expect(screen.queryByText(/\//)).toBeNull();
		});
	});
});
