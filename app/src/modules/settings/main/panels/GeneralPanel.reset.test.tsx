/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Reset to defaults" confirms through the app's own dialog.
 *
 * It was the last `window.confirm` in the app. The native box ignores the theme,
 * the accent and the roundedness that this panel exists to configure, and blocks
 * the renderer thread while it is open — visibly wrong sitting on top of the
 * settings screen whose whole job is those three things.
 *
 * It could not use `DeleteConfirmDialog` before, because that hardcoded a red
 * "Delete" button. A reset is irreversible but destroys nothing, so it takes the
 * new `confirmLabel` and a non-destructive variant. The red button belongs to
 * Clear run history, which sits a few centimetres above it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GeneralPanel from "./GeneralPanel";

vi.mock("@/queries/runs", () => ({
	useRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: vi.fn() },
}));

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => confirmSpy.mockRestore());

const openReset = () => fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i }));

describe("Reset app settings", () => {
	it("never calls window.confirm", () => {
		render(<GeneralPanel />);
		openReset();
		expect(confirmSpy).not.toHaveBeenCalled();
	});

	it("opens the in-app dialog instead", () => {
		render(<GeneralPanel />);
		openReset();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByText(/Reset app settings\?/i)).toBeInTheDocument();
	});

	it("labels the action Reset, not Delete", () => {
		// The whole reason `confirmLabel` exists. "Delete" would name the wrong
		// operation, on a panel that also offers a real deletion.
		render(<GeneralPanel />);
		openReset();
		expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
	});

	it("focuses Cancel, so a reflexive Enter does not reset", () => {
		render(<GeneralPanel />);
		openReset();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
	});

	it("closes on Cancel without resetting", () => {
		render(<GeneralPanel />);
		openReset();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
