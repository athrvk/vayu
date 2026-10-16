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
 * What the header says where a request's URL would be (#2270).
 *
 * A collection load run has no URL, so its band was an empty gap between the
 * status pill and the config summary. It now names the collection and how many
 * steps one pass has; the run's comment sits under it, labelled "Comment".
 *
 * Layout (that the comment stacks inside the 52px band, that long names
 * truncate) is not unit-testable: jsdom has no layout.
 *
 * Mutation check: drop the `collectionName` branch and the name cases redden;
 * render it ahead of the URL and the URL-wins case reddens; drop the
 * `RunComment` line and the comment cases redden.
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
			mode="running"
			isStreaming
			isStopping={false}
			onStop={async () => {}}
			{...patch}
		/>
	);
}

describe("DashboardHeader target", () => {
	it("names the collection and its step count when the run has no URL", () => {
		mount({ collectionName: "Checkout", stepCount: 12 });

		const target = screen.getByText(/Checkout/);
		expect(target.textContent).toBe("Checkout · 12 steps");
	});

	it("says one step in the singular", () => {
		mount({ collectionName: "Checkout", stepCount: 1 });

		expect(screen.getByText(/Checkout/).textContent).toBe("Checkout · 1 step");
	});

	it("names the collection alone while the step count is unknown", () => {
		mount({ collectionName: "Checkout" });

		expect(screen.getByText("Checkout").textContent).toBe("Checkout");
		expect(screen.queryByText(/step/)).toBeNull();
	});

	it("shows the URL, not the collection, when the run has one", () => {
		mount({ requestUrl: "https://api.test/ping", collectionName: "Checkout", stepCount: 3 });

		expect(screen.getByText("https://api.test/ping")).toBeTruthy();
		expect(screen.queryByText(/Checkout/)).toBeNull();
	});

	it("draws nothing in that place for a run with neither", () => {
		const { container } = mount({});

		expect(screen.queryByText(/step/)).toBeNull();
		expect(container.querySelector(".font-mono")).toBeNull();
	});
});

describe("DashboardHeader comment", () => {
	it("labels the run's comment as Comment", () => {
		mount({ requestUrl: "https://api.test/ping", comment: "after the cache fix" });

		const line = screen.getByText("after the cache fix").closest("p");
		expect(line?.textContent).toBe("Comment after the cache fix");
	});

	it("keeps the full text one hover away when the line truncates", () => {
		mount({ comment: "after the cache fix" });

		expect(screen.getByText("after the cache fix").closest("p")?.getAttribute("title")).toBe(
			"after the cache fix"
		);
	});

	it.each([undefined, ""])("draws no label for %j", (comment) => {
		mount({ comment });

		expect(screen.queryByText("Comment")).toBeNull();
	});
});
