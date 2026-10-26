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
 * "Clear run history" confirms through the app's own dialog.
 *
 * It used to call `window.confirm`. The native dialog ignores the theme, the
 * accent scheme and the roundedness setting - three things this very panel
 * exists to let the user choose - and, being modal to the renderer, it also
 * parks the JS thread while it is open. Every other destructive action in Vayu
 * already routes through `DeleteConfirmDialog`, which additionally focuses
 * Cancel first so a reflexive Enter does not wipe the history.
 *
 * Asserted through behaviour rather than by scanning for the string: the test
 * spies on `window.confirm` and requires it to stay untouched, which also fails
 * if a future edit reintroduces it anywhere in this flow.
 *
 * The clear is one `DELETE /runs` call (#2429), and the engine keeps what
 * retention keeps: a pinned baseline and a run still in flight. So the dialog
 * counts only what will go, names what is kept, and the tabs that close are the
 * ids the engine reports, not every run the list happened to hold.
 *
 * What is kept is read when the button is pressed, from `limit=1` counts
 * (#2979): `listRuns` below answers the way the engine's filters do, over the
 * `runs` fixture, and returns no more than a page's worth of rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as renderBare, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import GeneralPanel from "./GeneralPanel";

/**
 * The app mounts one `TooltipProvider` at its root (`main.tsx`), so a panel
 * rendered bare is in a state the app is never in - and since #1690 a gated
 * control inside one carries a real tooltip, which throws without it. Every
 * render in this file goes through the provider, the way the app does.
 */
function render(ui: ReactElement, options?: Parameters<typeof renderBare>[1]) {
	return renderBare(ui, { wrapper: TooltipProvider, ...options });
}

const clearRuns = vi.fn(() =>
	Promise.resolve({ deleted: 0, keptPinned: 0, deletedIds: [] as string[] })
);
const deleteRun = vi.fn();
const invalidateRuns = vi.fn();

type Row = { id: string; status: string; baseline?: boolean };
const plain: Row[] = [
	{ id: "r1", status: "completed" },
	{ id: "r2", status: "failed" },
];
let runs: Row[] = plain;

/** `GET /runs` over the fixture: the filters the panel uses, and `total` ahead of the rows. */
const listRuns = vi.fn(
	(params: { limit?: number; baseline?: boolean; status?: string }): Promise<unknown> => {
		const matching = runs.filter(
			(r) =>
				(params.baseline === undefined || Boolean(r.baseline) === params.baseline) &&
				(params.status === undefined || r.status === params.status)
		);
		const data = matching.slice(0, params.limit);
		return Promise.resolve({
			data,
			pagination: {
				total: matching.length,
				limit: params.limit,
				offset: 0,
				hasMore: matching.length > data.length,
				returned: data.length,
			},
		});
	}
);

vi.mock("@/queries/runs", () => ({
	useRunsCountQuery: () => ({ data: runs.length }),
	useInvalidateRuns: () => invalidateRuns,
}));

vi.mock("@/services", () => ({
	apiService: {
		clearRuns: () => clearRuns(),
		deleteRun: (id: string) => deleteRun(id),
		listRuns: (params: Parameters<typeof listRuns>[0]) => listRuns(params),
	},
}));

// The real zustand stores (toast, client settings) are left in place - they are
// cheap and behave, and stubbing them would only widen what this test asserts.

// UpdatesCard talks to the Electron updater bridge and CookiesCard to the
// engine's cookie jar; neither is the subject here. CookiesCard has its own tests.
vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

let confirmSpy: ReturnType<typeof vi.spyOn>;

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

function openTabs(...ids: string[]) {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	for (const entityId of ids) useTabsStore.getState().openTab({ type: "run", entityId });
}

const openTabIds = () => useTabsStore.getState().openTabs.map((t) => t.entityId);

beforeEach(() => {
	runs = plain;
	clearRuns.mockClear();
	deleteRun.mockClear();
	listRuns.mockClear();
	invalidateRuns.mockClear();
	useToastStore.setState({ toasts: [] });
	confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
	confirmSpy.mockRestore();
});

async function openDialog() {
	fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));
	return await screen.findByRole("dialog");
}

describe("GeneralPanel - clear run history", () => {
	it("confirms in-app, never reaches for window.confirm, and clears in one call", async () => {
		clearRuns.mockResolvedValue({ deleted: 2, keptPinned: 0, deletedIds: ["r1", "r2"] });
		render(<GeneralPanel />);

		await openDialog();
		expect(screen.getByText(/clear run history\?/i)).toBeTruthy();
		expect(confirmSpy).not.toHaveBeenCalled();
		// Nothing is deleted merely by asking.
		expect(clearRuns).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /^clear history$/i }));

		await waitFor(() => expect(clearRuns).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(toastMessages()).toEqual(["Run history cleared"]));
		// The per-run loop is gone: the engine's pass is what spares a baseline.
		expect(deleteRun).not.toHaveBeenCalled();
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(invalidateRuns).toHaveBeenCalled();
	});

	it("names the pinned baseline it keeps and counts only what goes", async () => {
		runs = [
			{ id: "r1", status: "completed" },
			{ id: "r2", status: "completed", baseline: true },
		];
		render(<GeneralPanel />);

		const dialog = await openDialog();

		expect(dialog).toHaveTextContent(
			"One stored run and its metrics are removed permanently. One pinned baseline is kept. This can't be undone."
		);
		expect(dialog).not.toHaveTextContent(/all \d+ stored runs/i);
	});

	it("closes the tabs of the ids the engine deleted and keeps the rest", async () => {
		runs = [
			{ id: "r1", status: "completed" },
			{ id: "r2", status: "completed", baseline: true },
		];
		clearRuns.mockResolvedValue({ deleted: 1, keptPinned: 1, deletedIds: ["r1"] });
		openTabs("r1", "r2");

		render(<GeneralPanel />);
		await openDialog();
		fireEvent.click(screen.getByRole("button", { name: /^clear history$/i }));

		await waitFor(() => expect(openTabIds()).toEqual(["r2"]));
	});

	it.each([
		[1, "The one stored run and its metrics are removed permanently. This can't be undone."],
		[2, "All 2 stored runs and their metrics are removed permanently. This can't be undone."],
	])("agrees the verb with a count of %i", async (count, sentence) => {
		runs = plain.slice(0, count);
		render(<GeneralPanel />);

		expect(await openDialog()).toHaveTextContent(sentence);
	});

	it("agrees the pinned count's verb, and says what it kept in plural", async () => {
		runs = [
			{ id: "r1", status: "completed" },
			{ id: "r2", status: "completed" },
			{ id: "r3", status: "completed", baseline: true },
			{ id: "r4", status: "failed", baseline: true },
		];
		render(<GeneralPanel />);

		expect(await openDialog()).toHaveTextContent(
			"2 stored runs and their metrics are removed permanently. 2 pinned baselines are kept. This can't be undone."
		);
	});

	it("does not claim every run goes while one is still in progress", async () => {
		runs = [
			{ id: "r1", status: "completed" },
			{ id: "r2", status: "running" },
		];
		render(<GeneralPanel />);

		const dialog = await openDialog();

		expect(dialog).toHaveTextContent(
			"One stored run and its metrics are removed permanently. One run still in progress is kept."
		);
		expect(dialog).not.toHaveTextContent(/\ball\b/i);
	});

	it("says why nothing is cleared, and opens no dialog, when only kept runs are stored", async () => {
		runs = [
			{ id: "r1", status: "completed", baseline: true },
			{ id: "r2", status: "running" },
		];
		render(<GeneralPanel />);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));

		await waitFor(() =>
			expect(toastMessages()).toEqual([
				"Only pinned baselines and runs in progress are stored",
			])
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(clearRuns).not.toHaveBeenCalled();
		// The stored count on screen is re-read, in case it was what went stale.
		expect(invalidateRuns).toHaveBeenCalled();
	});

	it("keeps a pinned run that is also running out of the in-flight count", async () => {
		runs = [
			{ id: "r1", status: "completed" },
			{ id: "r2", status: "running", baseline: true },
		];
		render(<GeneralPanel />);

		expect(await openDialog()).toHaveTextContent(
			"One stored run and its metrics are removed permanently. One pinned baseline is kept. This can't be undone."
		);
	});

	it("disables the button, with the reason, when nothing is stored", async () => {
		runs = [];
		render(<GeneralPanel />);

		const button = screen.getByRole("button", { name: /clear run history/i });
		expect(button).toBeDisabled();

		const hint = document.querySelector<HTMLElement>('[data-slot="disabled-hint"]');
		expect(hint, "the disabled button carries no reason").not.toBeNull();
		hint!.focus();
		fireEvent.focus(hint!);
		await waitFor(() =>
			expect(screen.getAllByText("No stored runs to clear").length).toBeGreaterThan(0)
		);
		expect(listRuns).not.toHaveBeenCalled();
		expect(clearRuns).not.toHaveBeenCalled();
	});

	it("shows the failure and opens no dialog when the plan cannot be read", async () => {
		listRuns.mockRejectedValueOnce(new Error("engine unreachable"));
		render(<GeneralPanel />);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));

		await waitFor(() =>
			expect(toastMessages()).toEqual(["Couldn't read the run history - engine unreachable"])
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(clearRuns).not.toHaveBeenCalled();
		// Not stuck: the button is live again.
		expect(screen.getByRole("button", { name: /clear run history/i })).toBeEnabled();
	});

	it("deletes nothing when the dialog is cancelled", async () => {
		render(<GeneralPanel />);

		await openDialog();
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		await waitFor(() => expect(screen.queryByText(/clear run history\?/i)).toBeNull());
		expect(clearRuns).not.toHaveBeenCalled();
		expect(deleteRun).not.toHaveBeenCalled();
	});

	it("shows the failure and keeps every tab when the call is rejected", async () => {
		clearRuns.mockRejectedValue(new Error("engine unreachable"));
		openTabs("r1", "r2");

		render(<GeneralPanel />);
		await openDialog();
		fireEvent.click(screen.getByRole("button", { name: /^clear history$/i }));

		await waitFor(() =>
			expect(toastMessages()).toEqual(["Couldn't clear the run history - engine unreachable"])
		);
		expect(openTabIds()).toEqual(["r1", "r2"]);
		// Batches the engine committed before failing are real, so the list is re-read.
		expect(invalidateRuns).toHaveBeenCalled();
	});
});
