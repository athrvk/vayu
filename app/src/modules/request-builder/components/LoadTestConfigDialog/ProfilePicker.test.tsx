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
 * The picker narrowed to a subset, as the collection run uses it for the three
 * modes a scenario accepts. The full list is covered where the request dialog
 * renders it (`LoadTestConfigDialog.test.tsx`).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ProfilePicker } from "./ProfilePicker";
import { LOAD_TEST_MODES, loadTestModeLabel } from "@/constants/load-test-modes";
import type { LoadTestMode } from "@/types";

const SUBSET: LoadTestMode[] = ["constant_concurrency", "iterations", "ramp_up"];

function renderSubset(value: LoadTestMode, onChange = vi.fn()) {
	render(
		<ProfilePicker
			value={value}
			onChange={onChange}
			modes={SUBSET}
			copy={{ iterations: { label: "Fixed passes", description: "Walk it N times." } }}
		/>
	);
	const group = screen.getByRole("radiogroup", { name: /load profile/i });
	return { group, radios: within(group).getAllByRole("radio"), onChange };
}

describe("ProfilePicker with a subset of modes", () => {
	it("offers exactly those cards and none of the others", () => {
		const { radios } = renderSubset("constant_concurrency");
		expect(radios).toHaveLength(3);
		expect(screen.queryByRole("radio", { name: /constant rps/i })).toBeNull();
		expect(screen.queryByRole("radio", { name: /capacity/i })).toBeNull();
	});

	it("marks only the chosen card checked and gives the group one tab stop", () => {
		const { radios } = renderSubset("ramp_up");
		expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
			"false",
			"false",
			"true",
		]);
		expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toEqual([radios[2]]);
	});

	it("wraps forward from the last card to the first of the subset", () => {
		const first = renderSubset("ramp_up");
		first.radios[2].focus();
		fireEvent.keyDown(first.group, { key: "ArrowRight" });
		expect(first.onChange).toHaveBeenCalledWith("constant_concurrency");
	});

	it("wraps backwards from the first card to the last of the subset", () => {
		const { group, radios, onChange } = renderSubset("constant_concurrency");
		radios[0].focus();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(onChange).toHaveBeenCalledWith("ramp_up");
		// The gap the full list would have stepped through is skipped.
		expect(onChange).not.toHaveBeenCalledWith("capacity");
	});

	it("rewords a card from `copy` without touching the shared mode names", () => {
		const { radios } = renderSubset("iterations");
		expect(radios[1].textContent).toContain("Fixed passes");
		expect(radios[1].textContent).toContain("Walk it N times.");
		expect(radios[0].textContent).toContain("Constant Virtual Users");
		expect(loadTestModeLabel("iterations")).toBe("Fixed request count");
	});
});

describe("ProfilePicker without a subset", () => {
	it("offers every mode", () => {
		render(<ProfilePicker value="constant_rps" onChange={vi.fn()} />);
		expect(screen.getAllByRole("radio")).toHaveLength(LOAD_TEST_MODES.length);
	});
});
