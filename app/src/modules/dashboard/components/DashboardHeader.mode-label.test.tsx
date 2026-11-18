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
 * The header's config line names the run's mode with the kind of run it is
 * (#3570): a collection run's iterations mode counts passes, a single request's
 * counts requests. Mutation check: drop the kind from the `loadTestModeLabel`
 * call and the collection case reads "Fixed request count".
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardHeader from "./DashboardHeader";
import type { DashboardHeaderProps } from "../types";

vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: unknown) => unknown) =>
		select({ openTabs: [], activeTabId: null, openTab: vi.fn(), closeTab: vi.fn() }),
	useDashboardStore: (select: (s: unknown) => unknown) => select({ sourceRequestId: null }),
}));

function mount(patch: Partial<DashboardHeaderProps>) {
	return render(
		<DashboardHeader
			live
			endedAs={null}
			isStopping={false}
			onStop={async () => {}}
			configuration={{ mode: "iterations", concurrency: 10 }}
			{...patch}
		/>
	);
}

describe("DashboardHeader mode label", () => {
	it("reads Fixed passes for a collection run", () => {
		mount({ collectionName: "Checkout", stepCount: 3 });

		expect(screen.getByText(/Fixed passes/)).toBeTruthy();
		expect(screen.queryByText(/Fixed request count/)).toBeNull();
	});

	it("keeps Fixed request count for a single request", () => {
		mount({ requestUrl: "https://api.test/ping" });

		expect(screen.getByText(/Fixed request count/)).toBeTruthy();
		expect(screen.queryByText(/Fixed passes/)).toBeNull();
	});
});
