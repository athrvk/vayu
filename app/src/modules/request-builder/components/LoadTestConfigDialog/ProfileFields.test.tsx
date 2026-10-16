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
