/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ConfigEntry } from "@/types";

const mutate = vi.fn();
let configEntries: ConfigEntry[] | undefined;

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: configEntries ? { entries: configEntries } : undefined }),
	useUpdateConfigMutation: () => ({ mutate }),
}));

import { useLiveChartWindow } from "./useLiveChartWindow";
import { useDashboardStore } from "@/stores";

function entry(value: string): ConfigEntry {
	return {
		key: "liveReplayWindowMs",
		value,
		type: "integer",
		label: "Live Chart Window (ms)",
		description: "",
		category: "observability",
		default: "300000",
		updatedAt: 0,
	};
}

beforeEach(() => {
	mutate.mockClear();
	configEntries = undefined;
	useDashboardStore.getState().setLiveWindowSeconds(300);
});

describe("useLiveChartWindow", () => {
	it("reads the window from engine config, not localStorage", () => {
		localStorage.setItem("vayu-live-chart-window", "1m");
		configEntries = [entry("1800000")];

		const { result } = renderHook(() => useLiveChartWindow());

		// The stale localStorage value from before this setting moved engine-side
		// must not win - it is not read at all any more.
		expect(result.current.window).toBe("30m");
		expect(useDashboardStore.getState().liveWindowSeconds).toBe(1800);
	});

	it("holds the default until the config query resolves", () => {
		configEntries = undefined;
		const { result } = renderHook(() => useLiveChartWindow());

		expect(result.current.window).toBe("5m");
		// Bounded, not null - an unbounded store during the load gap would let a
		// run started at launch accumulate without a time trim.
		expect(useDashboardStore.getState().liveWindowSeconds).toBe(300);
	});

	it("maps the engine's 0 to full run", () => {
		configEntries = [entry("0")];
		const { result } = renderHook(() => useLiveChartWindow());

		expect(result.current.window).toBe("full");
		expect(useDashboardStore.getState().liveWindowSeconds).toBeNull();
	});

	it("writes the picked window back to engine config as milliseconds", () => {
		configEntries = [entry("300000")];
		const { result } = renderHook(() => useLiveChartWindow());

		act(() => result.current.setWindow("15m"));

		expect(mutate).toHaveBeenCalledWith({ entries: { liveReplayWindowMs: "900000" } });
	});

	it("writes 0 for full run rather than dropping the key", () => {
		configEntries = [entry("300000")];
		const { result } = renderHook(() => useLiveChartWindow());

		act(() => result.current.setWindow("full"));

		expect(mutate).toHaveBeenCalledWith({ entries: { liveReplayWindowMs: "0" } });
	});

	// The mutation round-trips to the engine and back through the query cache;
	// the charts should re-trim on the click, not a request later.
	it("applies the new window to the store before the mutation resolves", () => {
		configEntries = [entry("300000")];
		const { result } = renderHook(() => useLiveChartWindow());

		act(() => result.current.setWindow("1m"));

		expect(useDashboardStore.getState().liveWindowSeconds).toBe(60);
	});
});
