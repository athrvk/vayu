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
 * "Reset to defaults" confirms through the app's own dialog.
 *
 * It was the last `window.confirm` in the app. The native box ignores the theme,
 * the accent and the roundedness that this panel exists to configure, and blocks
 * the renderer thread while it is open - visibly wrong sitting on top of the
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
	useAllRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: vi.fn() },
}));

// UpdatesCard and CookiesCard each talk to something outside this panel - the
// Electron updater bridge and the engine's cookie jar - and neither is the
// subject here. CookiesCard has its own tests.
vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

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

/**
 * The copy has to name everything `resetAll` clears.
 *
 * It used to say "appearance, editor and dashboard preferences", but the reset
 * removes `STORAGE_KEYS.CLIENT_SETTINGS` wholesale - so notification
 * preferences, the auto-save setting and the load-test ceilings went with it,
 * unannounced. Undersold scope on an irreversible action is the defect; a
 * partial reset would be its own surprise, so the text is what moved.
 *
 * Each term below is checked against both the card and the confirm dialog,
 * because a user can read either one before committing.
 */
describe("Reset app settings copy", () => {
	const CLEARED = [
		"appearance",
		"editor",
		"dashboard",
		"notifications",
		"auto-save",
		"load-test limits",
	];

	const text = (el: Element | null) => el?.textContent?.toLowerCase() ?? "";

	it("the card names every category the reset clears", () => {
		render(<GeneralPanel />);
		const card = screen.getByText(/^Reset app settings$/).closest("div[data-slot='card']");
		const copy = text(card);
		expect(copy.length).toBeGreaterThan(0);
		for (const term of CLEARED) expect(copy).toContain(term);
	});

	it("the confirm dialog names them too, and says the app reloads", () => {
		render(<GeneralPanel />);
		openReset();
		const copy = text(screen.getByRole("dialog"));
		expect(copy.length).toBeGreaterThan(0);
		for (const term of CLEARED) expect(copy).toContain(term);
		// `resetAll` ends in window.location.reload(); losing the tab you are on
		// is worth stating before the click, not after.
		expect(copy).toContain("reloads");
	});

	it("still promises what the reset does not touch", () => {
		render(<GeneralPanel />);
		openReset();
		const copy = text(screen.getByRole("dialog"));
		// SETTINGS_STORAGE_KEYS holds no workspace or engine-side key, so these
		// three survive - the reassurance is load-bearing, not filler.
		for (const kept of ["collections", "requests", "run history"]) {
			expect(copy).toContain(kept);
		}
	});
});
