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
 * Settings, General counts the stored runs without downloading them (#2979).
 *
 * The card used to fetch every run, 500 a page, to print "N stored runs" and to
 * work out what Clear would keep. Opening the panel with a long history is now
 * one `limit=1` request whose `pagination.total` is the count; the pinned and
 * in-flight counts Clear's dialog needs are read when Clear is pressed.
 *
 * Runs through the real query layer with only `apiService` stubbed, so a panel
 * that reached for a hook that fetches the history again would show here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import GeneralPanel from "./GeneralPanel";

const STORED = 2000;
const PINNED = 3;
const RUNNING = 2;
const PENDING = 1;

const listRuns = vi.fn();
const clearRuns = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRuns: (...a: unknown[]) => listRuns(...a),
		clearRuns: () => clearRuns(),
	},
}));

vi.mock("@/services", async () => {
	const { apiService } = await import("@/services/api");
	return { apiService, ApiError: class extends Error {} };
});

vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

type Params = { limit?: number; baseline?: boolean; status?: string };

/**
 * What the engine answers: one row however many match, and the match count as
 * `total`. The row is deliberately not the count, so a panel that read the rows
 * would print 1 where the history holds 2,000.
 */
function envelope(total: number, params: Params) {
	const returned = Math.min(total, params.limit ?? 50);
	return {
		data: Array.from({ length: returned }, (_, i) => ({
			id: `r${i}`,
			type: "load",
			status: "completed",
			startTime: 1,
			endTime: 2,
		})),
		pagination: {
			total,
			limit: params.limit ?? 50,
			offset: 0,
			hasMore: total > returned,
			returned,
		},
	};
}

function totalFor({ baseline, status }: Params): number {
	if (baseline === true) return PINNED;
	if (status === "running") return RUNNING;
	if (status === "pending") return PENDING;
	return STORED;
}

function render(ui: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderBare(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
		wrapper: TooltipProvider,
	});
}

beforeEach(() => {
	listRuns
		.mockReset()
		.mockImplementation((params: Params) =>
			Promise.resolve(envelope(totalFor(params), params))
		);
	clearRuns.mockReset().mockResolvedValue({ deleted: 0, keptPinned: 0, deletedIds: [] });
});

describe("GeneralPanel - stored run count", () => {
	it("opens with one single-row request and prints the total it reports", async () => {
		render(<GeneralPanel />);

		expect(await screen.findByText("2000 stored runs.")).toBeTruthy();
		expect(listRuns).toHaveBeenCalledTimes(1);
		expect(listRuns).toHaveBeenCalledWith({ limit: 1 });
	});

	it("reads what Clear keeps only once Clear is pressed, then clears in one call", async () => {
		render(<GeneralPanel />);
		await screen.findByText("2000 stored runs.");
		expect(listRuns).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));
		const dialog = await screen.findByRole("dialog");

		// 2000 stored - 3 pinned - (2 running + 1 pending) = 1994 go.
		expect(dialog).toHaveTextContent(
			"1994 stored runs and their metrics are removed permanently. 3 pinned baselines are kept. 3 runs still in progress are kept. This can't be undone."
		);
		const asked = listRuns.mock.calls.map(([params]) => params);
		expect(asked).toHaveLength(5);
		expect(asked.every((params: Params) => params.limit === 1)).toBe(true);
		expect(asked).toContainEqual({ limit: 1, baseline: true });
		expect(asked).toContainEqual({ limit: 1, baseline: false, status: "running" });
		expect(asked).toContainEqual({ limit: 1, baseline: false, status: "pending" });
		expect(clearRuns).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /^clear history$/i }));
		await waitFor(() => expect(clearRuns).toHaveBeenCalledTimes(1));
	});
});
