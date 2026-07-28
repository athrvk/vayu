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

	it("clamps an emptied field to the floor rather than storing a NaN", () => {
		// `parseInt("")` is NaN, and a NaN ceiling makes every range in the load
		// dialog nonsense - the field would show `max=""` and stop bounding.
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "" } });
		expect(ceilings().concurrency).toBe(LOAD_TEST_CEILING_BOUNDS.concurrency.MIN);
	});

	it("never lets a ceiling drop below one - the engine rejects a zero", () => {
		render(<LoadTestingPanel />);
		fireEvent.change(connectionsField(), { target: { value: "0" } });
		expect(ceilings().concurrency).toBeGreaterThanOrEqual(1);
	});

	it("offers a reset only once something is off the default, and it restores every field", () => {
		const { rerender } = render(<LoadTestingPanel />);
		expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();

		fireEvent.change(connectionsField(), { target: { value: "5000" } });
		fireEvent.change(screen.getByLabelText(/max duration/i), { target: { value: "120" } });
		rerender(<LoadTestingPanel />);

		fireEvent.click(screen.getByRole("button", { name: /reset/i }));
		expect(ceilings()).toEqual(DEFAULT_LOAD_TEST_CEILINGS);
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
