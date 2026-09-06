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
 * Issue #1503: a load run that sent every request with an unresolved
 * `{{token}}`, or skipped a pre-request script, still finishes and still
 * reads green everywhere else in the report. Mutation check: drop the
 * `warnings.length === 0` guard and the "says nothing" case fails; drop the
 * component from OverviewTab and its own rendering test fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunWarnings } from "./RunWarnings";

describe("RunWarnings", () => {
	it("says nothing when the report has no warnings", () => {
		const { container } = render(<RunWarnings warnings={undefined} />);
		expect(container.firstChild).toBeNull();
	});

	it("says nothing when the warnings array is empty", () => {
		const { container } = render(<RunWarnings warnings={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("names the unresolved variables and the affected request count", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "unresolved_tokens",
						message: "2 requests sent with unresolved variables: token",
						count: 2,
						names: ["token"],
					},
				]}
			/>
		);
		expect(screen.getByText("Unresolved variables were sent")).toBeTruthy();
		expect(screen.getByText(/2 requests sent with unresolved variables: token/)).toBeTruthy();
	});

	it("reports a skipped pre-request script", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "pre_request_script_skipped",
						message: "1 step carries a pre-request script that does not run under load",
						steps: 1,
					},
				]}
			/>
		);
		expect(screen.getByText("Pre-request script will not run")).toBeTruthy();
	});

	it("renders one callout per warning when a run carries both", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "unresolved_tokens",
						message: "1 request sent with an unresolved variable: token",
						count: 1,
						names: ["token"],
					},
					{
						code: "pre_request_script_skipped",
						message: "1 step carries a pre-request script that does not run under load",
						steps: 1,
					},
				]}
			/>
		);
		expect(screen.getByText("Unresolved variables were sent")).toBeTruthy();
		expect(screen.getByText("Pre-request script will not run")).toBeTruthy();
	});
});
