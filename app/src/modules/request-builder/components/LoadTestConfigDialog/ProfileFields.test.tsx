/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProfileFields } from "./ProfileFields";
import { SCENARIO_PROFILE_DEFAULTS } from "./scenarioProfile";
import { LOAD_TEST_LIMITS } from "@/constants/load-test";

const fixed = { ...SCENARIO_PROFILE_DEFAULTS, mode: "iterations" } as const;

const renderFields = (iterationsLabel?: string) =>
	render(
		<ProfileFields
			profile={fixed}
			onChange={vi.fn()}
			limits={LOAD_TEST_LIMITS}
			isStreamingRequest={false}
			iterationsLabel={iterationsLabel}
		/>
	);

const renderMode = (mode: "ramp_up" | "capacity" | "constant_concurrency") =>
	render(
		<ProfileFields
			profile={{ ...SCENARIO_PROFILE_DEFAULTS, mode }}
			onChange={vi.fn()}
			limits={LOAD_TEST_LIMITS}
			isStreamingRequest={false}
		/>
	);

describe("ProfileFields' ramp duration hint", () => {
	const hint =
		"One climb up, then hold. For a staircase or a limit search use Capacity Discovery.";

	it("says the ramp is one climb and names the mode that steps", () => {
		renderMode("ramp_up");
		const field = screen.getByRole("spinbutton", { name: "Ramp duration" });
		expect(screen.getByText(hint)).toBeTruthy();
		expect(field.getAttribute("aria-describedby")).toBe(
			screen.getByText(hint).getAttribute("id")
		);
	});

	it.each(["constant_concurrency", "capacity"] as const)("is absent in %s mode", (mode) => {
		renderMode(mode);
		expect(screen.queryByText(hint)).toBeNull();
	});
});

describe("ProfileFields' fixed-count label", () => {
	it("counts requests by default", () => {
		renderFields();
		expect(screen.getByRole("spinbutton", { name: "Requests" })).toBeTruthy();
	});

	it("takes the caller's wording", () => {
		renderFields("Passes through the sequence");
		expect(
			screen.getByRole("spinbutton", { name: "Passes through the sequence" })
		).toBeTruthy();
		expect(screen.queryByRole("spinbutton", { name: "Requests" })).toBeNull();
	});
});
