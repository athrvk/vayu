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
 * Completed chip. Every settled mode now has its own word and its own status
 * family; idle, and a run that is neither streaming nor settled, draw nothing.
 *
 * Mutation check: map `failed` back to the completed treatment in
 * `DashboardHeader`'s `pillStatus` and the failed case reddens; give `failed` the
 * `bg-muted` tint in `RUN_STATUS` and the family assertion reddens.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardHeader from "./DashboardHeader";
import type { DashboardHeaderProps, DashboardMode } from "../types";

vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: unknown) => unknown) =>
		select({ openTabs: [], activeTabId: null, openTab: vi.fn(), closeTab: vi.fn() }),
	useDashboardStore: (select: (s: unknown) => unknown) => select({ sourceRequestId: null }),
}));

function mount(mode: DashboardMode, isStreaming = false) {
	const props: DashboardHeaderProps = {
		runId: "run-1",
		mode,
		isStreaming,
		isStopping: false,
		onStop: async () => {},
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

	it("draws Running while streaming and keeps the Stop button", () => {
		mount("running", true);

		const el = screen.getByText("Running").closest("[data-status]");
		expect(el!.className).toContain("text-status-running-text");
		expect(el!.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
		expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
	});

	it("draws no pill for idle, or for a running mode that is not streaming", () => {
		const { unmount } = mount("idle");
		expect(pill()).toBeNull();
		unmount();

		mount("running", false);
		expect(pill()).toBeNull();
	});
});
