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
 * The panel's whole job is to move a ceiling without ever letting it out of
 * the range the engine will accept - a settings screen that could produce a
 * rejected (and, before the engine's own validation, a crashing) run would be
 * worse than no screen. So the assertions are about what reaches the store,
 * not about the markup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import LoadTestingPanel from "./LoadTestingPanel";
import { useClientSettingsStore } from "@/stores";
import { DEFAULT_LOAD_TEST_CEILINGS, LOAD_TEST_CEILING_BOUNDS } from "@/constants/load-test";

const ceilings = () => useClientSettingsStore.getState().loadTestCeilings;
const connectionsField = () => screen.getByLabelText(/max connections/i) as HTMLInputElement;

beforeEach(() => {
	cleanup();
	useClientSettingsStore.getState().setLoadTestCeilings(DEFAULT_LOAD_TEST_CEILINGS);
});

describe("LoadTestingPanel", () => {
	it("shows the shipped ceilings", () => {
		render(<LoadTestingPanel />);
		expect(connectionsField().value).toBe(String(DEFAULT_LOAD_TEST_CEILINGS.concurrency));
	});

	it("raises a ceiling the user types", () => {
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "5000" } });
		expect(ceilings().concurrency).toBe(5000);
	});

	it("clamps a value above the engine's guard instead of storing it", () => {
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "999999" } });
		expect(ceilings().concurrency).toBe(LOAD_TEST_CEILING_BOUNDS.concurrency.MAX);
	});

	it("keeps an emptied field out of the store instead of clamping it to the floor", () => {
		/*
		 * `parseInt("")` is NaN, and a NaN ceiling makes every range in the load
		 * dialog nonsense. This used to be handled by letting the store clamp the
		 * NaN to the floor - so clearing the field to retype it yanked the
		 * ceiling to 1 mid-edit. The shared NumberSettingRow holds an
		 * unparseable draft instead: the field shows what was typed and the
		 * stored ceiling does not move until it is a number again.
		 */
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "" } });
		expect(connectionsField().value).toBe("");
		expect(ceilings().concurrency).toBe(DEFAULT_LOAD_TEST_CEILINGS.concurrency);

		fireEvent.change(connectionsField(), { target: { value: "5000" } });
		expect(ceilings().concurrency).toBe(5000);
	});

	it("never lets a ceiling drop below one - the engine rejects a zero", () => {
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "0" } });
		expect(ceilings().concurrency).toBeGreaterThanOrEqual(1);
	});

	it("offers a reset only once something is off the default, and it restores every field", () => {
		const { rerender } = render(<LoadTestingPanel />);
		expect(screen.queryByRole("button", { name: "Reset all" })).not.toBeInTheDocument();
		// Nor the per-row resets, which appear beside a row's Default line.
		expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();

		fireEvent.change(connectionsField(), { target: { value: "5000" } });
		fireEvent.change(screen.getByLabelText(/max duration/i), { target: { value: "120" } });
		rerender(<LoadTestingPanel />);

		expect(screen.getAllByRole("button", { name: "Reset" })).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
		expect(ceilings()).toEqual(DEFAULT_LOAD_TEST_CEILINGS);
	});

	it("resets one ceiling from its own row, leaving the others alone", () => {
		const { rerender } = render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "5000" } });
		fireEvent.change(screen.getByLabelText(/max duration/i), { target: { value: "120" } });
		rerender(<LoadTestingPanel />);

		const connectionsRow = connectionsField().closest("[data-setting-row]");
		const rowReset = connectionsRow?.querySelector("button");
		fireEvent.click(rowReset as HTMLButtonElement);

		expect(ceilings().concurrency).toBe(DEFAULT_LOAD_TEST_CEILINGS.concurrency);
		expect(ceilings().durationSeconds).toBe(120);
	});

	it("names every ceiling it renders, so each input is reachable by its label", () => {
		// The labels are what the load dialog's fields are called; a rename on
		// one side without the other is the thing that makes this screen unclear.
		render(<LoadTestingPanel />);
		for (const label of [
			/max connections/i,
			/max target rate/i,
			/max duration/i,
			/max requests/i,
		]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}
	});
});
