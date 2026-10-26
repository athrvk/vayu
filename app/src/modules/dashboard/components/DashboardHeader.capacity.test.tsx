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
 * A capacity run's configured count is the search's ceiling, so the header says
 * "up to N" (#2929). Every other mode still states the count as the load.
 *
 * Mutation check: drop the capacity branch in `DashboardHeader`'s config
 * summary and the "up to" case reddens.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardHeader from "./DashboardHeader";

vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: unknown) => unknown) =>
		select({ openTabs: [], activeTabId: null, openTab: vi.fn(), closeTab: vi.fn() }),
	useDashboardStore: (select: (s: unknown) => unknown) => select({ sourceRequestId: null }),
}));

function mount(mode: string) {
	return render(
		<DashboardHeader
			mode="idle"
			isStreaming
			isStopping={false}
			onStop={async () => {}}
			configuration={{ mode, concurrency: 100 }}
		/>
	);
}

describe("DashboardHeader concurrency wording", () => {
	it("calls a capacity run's count a ceiling", () => {
		mount("capacity");
		expect(screen.getByText(/^up to 100 virtual users/)).toBeInTheDocument();
	});

	it("leaves a constant-concurrency run's count as the load", () => {
		mount("constant_concurrency");
		expect(screen.getByText(/^100 virtual users/)).toBeInTheDocument();
		expect(screen.queryByText(/up to/)).toBeNull();
	});
});
