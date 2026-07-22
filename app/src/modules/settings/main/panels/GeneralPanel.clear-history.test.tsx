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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GeneralPanel from "./GeneralPanel";

const deleteRun = vi.fn((_id: string) => Promise.resolve());
const invalidateRuns = vi.fn();

const runs = [
	{ id: "r1", status: "completed" },
	{ id: "r2", status: "failed" },
];

vi.mock("@/queries/runs", () => ({
	useRunsQuery: () => ({ data: runs }),
	useInvalidateRuns: () => invalidateRuns,
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: (id: string) => deleteRun(id) },
}));

// The real zustand stores (toast, client settings) are left in place - they are
// cheap and behave, and stubbing them would only widen what this test asserts.

// UpdatesCard talks to the Electron updater bridge, which isn't the subject here.
vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	deleteRun.mockClear();
	invalidateRuns.mockClear();
	confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
	confirmSpy.mockRestore();
});

describe("GeneralPanel - clear run history", () => {
	it("confirms in-app and never reaches for window.confirm", async () => {
		render(<GeneralPanel />);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));

		// The in-app dialog, not the OS one.
		expect(await screen.findByText(/clear run history\?/i)).toBeTruthy();
		expect(confirmSpy).not.toHaveBeenCalled();
		// Nothing is deleted merely by asking.
		expect(deleteRun).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() => expect(deleteRun).toHaveBeenCalledTimes(runs.length));
		expect(confirmSpy).not.toHaveBeenCalled();
	});

	it("deletes nothing when the dialog is cancelled", async () => {
		render(<GeneralPanel />);

		fireEvent.click(screen.getByRole("button", { name: /clear run history/i }));
		fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

		await waitFor(() => expect(screen.queryByText(/clear run history\?/i)).toBeNull());
		expect(deleteRun).not.toHaveBeenCalled();
	});
});
