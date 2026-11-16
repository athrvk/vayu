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
 * A history row's Delete button says what it does on keyboard focus (#3498).
 * It carried only an `aria-label`; the app's Tooltip opens on focus, which is
 * what the row's hover-revealed buttons need now that focus reveals them.
 */

import { describe, it } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { expectTooltipOnFocus } from "@/test/tooltip-focus.testkit";
import type { Run } from "@/types";
import RunItem from "./RunItem";

const START = 1_750_000_000_000;

const RUN = {
	id: "run_1",
	type: "design",
	status: "completed",
	startTime: START,
	endTime: START + 3000,
	requestId: "req_1",
	environmentId: null,
	summary: { url: "https://api.example.test/checkout", method: "POST" },
} as Run;

describe("RunItem delete button", () => {
	it("opens its tooltip on focus", async () => {
		render(<RunItem run={RUN} onSelect={() => {}} onDelete={() => {}} isDeleting={false} />);
		await expectTooltipOnFocus(
			screen.getByRole("button", { name: "Delete run" }),
			"Delete run"
		);
	});
});
