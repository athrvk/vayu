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
 * The run header keeps its name readable at a narrow pane or a 200% scale
 * (#3494).
 *
 * The name, the status pill, the timestamp and two labelled buttons shared one
 * non-wrapping row, so the name was the only thing that could give: it
 * truncated to a few characters while the pill's label wrapped. jsdom has no
 * layout, so this holds the classes that make it behave - a floor under the
 * name and wrapping at both levels - and cannot prove a pixel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import HistoryDetail from "./HistoryDetail";
import { useTabsStore } from "@/stores";
import type { Run } from "@/types";

const runQuery = { data: undefined as Run | undefined, isLoading: false, error: null };

vi.mock("@/queries", () => ({
	useRunQuery: () => runQuery,
	useRunReportQuery: () => ({ data: {}, isLoading: false, error: null, refetch: vi.fn() }),
	isRunNotFound: () => false,
	useCollectionsQuery: () => ({ data: [] }),
}));

vi.mock("./LoadTestDetail", () => ({ default: () => null }));
vi.mock("./DesignRunView", () => ({ default: () => null }));
vi.mock("./ScenarioRunView", () => ({ default: () => null }));
vi.mock("./components/RunExportMenu", () => ({ default: () => null }));

beforeEach(() => {
	cleanup();
	runQuery.data = {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_001_000,
		configSnapshot: { url: "https://api.example.test/x", method: "GET", requestName: "Get x" },
	} as Run;
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run_1" }],
		activeTabId: "t1",
	});
});

const classesOf = (el: Element | null | undefined) => (el?.className ?? "").split(/\s+/);

describe("the run identity header", () => {
	it("floors the name's group and wraps the buttons under it before the name is squeezed", () => {
		render(<HistoryDetail />);
		const title = screen.getByRole("heading", { level: 1 });
		const group = title.parentElement;
		const row = group?.parentElement;
		expect(classesOf(group)).toContain("min-w-[12rem]");
		expect(classesOf(row)).toContain("flex-wrap");
	});

	it("wraps the pill and the timestamp under the name rather than beside a clipped one", () => {
		render(<HistoryDetail />);
		const title = screen.getByRole("heading", { level: 1 });
		expect(classesOf(title.parentElement)).toContain("flex-wrap");
		expect(classesOf(title)).toContain("truncate");
	});

	it("keeps the pill and the timestamp on one line each", () => {
		render(<HistoryDetail />);
		const pill = document.querySelector('[data-status="completed"]');
		expect(classesOf(pill)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
		const time = screen.getByRole("heading", { level: 1 }).parentElement?.querySelector("time");
		expect(classesOf(time)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
	});
});
