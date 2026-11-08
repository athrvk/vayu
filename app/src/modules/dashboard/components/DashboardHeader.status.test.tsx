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
 * Mutation check: give `failed` the `bg-muted` tint in `RUN_STATUS` and the
 * family assertion reddens; draw `endedAs` alone in `DashboardHeader` and the
 * Running case reddens; gate Stop on `endedAs === null` instead of `live` and
 * the neither-live-nor-ended case reddens.
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
	outcome?: DashboardHeaderProps["outcome"]
) {
	const props: DashboardHeaderProps = {
		live,
		endedAs,
		isStopping: false,
		onStop: async () => {},
		outcome,
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
});
