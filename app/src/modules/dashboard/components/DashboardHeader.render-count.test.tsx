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
 * The header draws elapsed time as MM:SS, so sub-second ticks must not re-render
 * it (#1714): a 10 Hz run would otherwise execute it at tick cadence.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardHeader from "./DashboardHeader";
import type { DashboardHeaderProps } from "../types";

// The header reads the dashboard store once per execution of its body, so that
// selector's calls count its renders; the real store would hide them.
const bodyRuns = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: unknown) => unknown) =>
		select({ openTabs: [], activeTabId: null, openTab: vi.fn(), closeTab: vi.fn() }),
	useDashboardStore: (select: (s: unknown) => unknown) => {
		bodyRuns.n++;
		return select({ sourceRequestId: null });
	},
}));

const onStop = async () => {};
const configuration = { mode: "constant_rps", targetRps: 10 };
const base: DashboardHeaderProps = {
	runId: "run-1",
	mode: "running",
	isStreaming: true,
	isStopping: false,
	onStop,
	requestUrl: "https://example.test",
	requestMethod: "GET",
	elapsedDuration: 1200,
	configuration,
};

function mount() {
	const view = render(<DashboardHeader {...base} />);
	return {
		rerender: (patch: Partial<DashboardHeaderProps>) =>
			view.rerender(<DashboardHeader {...base} {...patch} />),
		count: () => bodyRuns.n,
	};
}

describe("DashboardHeader render count", () => {
	it("does not re-render on sub-second elapsed ticks", () => {
		const h = mount();
		const before = h.count();
		h.rerender({ elapsedDuration: 1300 });
		h.rerender({ elapsedDuration: 1999 });
		expect(h.count()).toBe(before);
	});

	it("re-renders and shows the new second when the displayed second changes", () => {
		const h = mount();
		const before = h.count();
		h.rerender({ elapsedDuration: 2100 });
		expect(h.count()).toBe(before + 1);
		expect(screen.getByText(/00:02 elapsed/)).toBeTruthy();
	});

	it("re-renders when any other prop changes", () => {
		const h = mount();
		const before = h.count();
		h.rerender({ mode: "completed", isStreaming: false });
		expect(h.count()).toBe(before + 1);
	});
});
