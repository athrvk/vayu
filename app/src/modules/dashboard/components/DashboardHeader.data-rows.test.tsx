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
 * The header says how many rows a data-driven run bound (#1940).
 *
 * The rows are never stored, so the count is the only record that a file drove
 * the run. It was read by a component nothing mounted, so no run ever showed it.
 *
 * Since #2051 the count also names the file the rows came from. The name is a
 * display name only; a hash alone never draws anything.
 *
 * Mutation check: drop the row-count push from `DashboardHeader`'s config
 * summary and the "12 rows" and "1 row" cases redden; drop the `from <name>`
 * branch and the named-file case reddens.
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

function mount(configuration: DashboardHeaderProps["configuration"]) {
	return render(
		<DashboardHeader
			mode="completed"
			isStreaming={false}
			isStopping={false}
			onStop={async () => {}}
			configuration={configuration}
		/>
	);
}

const MODE = { mode: "constant_concurrency", concurrency: 5 };

describe("DashboardHeader data row count", () => {
	it("shows the count beside the rest of the config", () => {
		mount({ ...MODE, dataRowCount: 12 });

		expect(screen.getByText(/ · 12 rows$/)).toBeInTheDocument();
	});

	it("uses the singular for one row", () => {
		mount({ ...MODE, dataRowCount: 1 });

		expect(screen.getByText(/ · 1 row$/)).toBeInTheDocument();
	});

	it("names the file the rows came from", () => {
		mount({ ...MODE, dataRowCount: 2, dataFileName: "users.csv" });

		expect(screen.getByText(/ · 2 rows from users\.csv$/)).toBeInTheDocument();
	});

	// Mutation check: print `fileName` bare again and this fails (#2540).
	it("says when the file's numbers were read as numbers", () => {
		mount({ ...MODE, dataRowCount: 2, dataFileName: "plans.csv", dataFileCastNumbers: true });

		expect(
			screen.getByText(/ · 2 rows from plans\.csv \(numbers read as numbers\)$/)
		).toBeInTheDocument();
	});

	it("keeps the bare count for a run that recorded no file name", () => {
		mount({ ...MODE, dataRowCount: 2, dataFileHash: "a".repeat(64) });

		expect(screen.getByText(/ · 2 rows$/)).toBeInTheDocument();
		expect(screen.queryByText(/from/)).toBeNull();
	});

	it("never prints the hash", () => {
		const hash = "a".repeat(64);
		mount({ ...MODE, dataRowCount: 2, dataFileName: "users.csv", dataFileHash: hash });

		expect(screen.queryByText(new RegExp(hash))).toBeNull();
	});

	it.each([
		["absent", undefined],
		["zero", 0],
	])("draws no count when it is %s", (_label, dataRowCount) => {
		mount({ ...MODE, dataRowCount });

		expect(screen.queryByText(/\brows?\b/)).toBeNull();
	});
});
