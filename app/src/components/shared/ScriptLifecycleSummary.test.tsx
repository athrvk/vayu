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
 * Issue #1499: `script.setup` / `script.teardown` ran once each, at the run's
 * own boundary. Mutation check: drop the emptiness guard and the "says
 * nothing" cases fail; drop the component from OverviewTab / ScenarioRunView
 * and its own rendering test still passes but the report silently loses the
 * row - which is why both call sites are covered by their own suites too.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScriptLifecycleSummary } from "./ScriptLifecycleSummary";
import type { ElementOutcome } from "@/types/domain";

function outcome(overrides: Partial<ElementOutcome> = {}): ElementOutcome {
	return { id: "el_1", kind: "script.setup", outcome: "ok", ...overrides };
}

describe("ScriptLifecycleSummary", () => {
	it("says nothing when the report has no lifecycle section", () => {
		const { container } = render(<ScriptLifecycleSummary lifecycle={undefined} />);
		expect(container.firstChild).toBeNull();
	});

	it("says nothing when both setup and teardown are empty", () => {
		const { container } = render(<ScriptLifecycleSummary lifecycle={{}} />);
		expect(container.firstChild).toBeNull();
	});

	it("shows a successful setup as having run", () => {
		render(<ScriptLifecycleSummary lifecycle={{ setup: [outcome()] }} />);
		expect(screen.getByText("Setup")).toBeTruthy();
		expect(screen.getByText("Ran successfully")).toBeTruthy();
	});

	it("shows a failed teardown's message without touching the run's status", () => {
		render(
			<ScriptLifecycleSummary
				lifecycle={{
					teardown: [
						outcome({ kind: "script.teardown", outcome: "error", message: "boom" }),
					],
				}}
			/>
		);
		expect(screen.getByText("Teardown")).toBeTruthy();
		expect(screen.getByText("boom")).toBeTruthy();
		expect(screen.getByText(/does not change the run's status/)).toBeTruthy();
	});

	it("renders both setup and teardown when a collection declares both", () => {
		render(
			<ScriptLifecycleSummary
				lifecycle={{
					setup: [outcome()],
					teardown: [outcome({ id: "el_2", kind: "script.teardown" })],
				}}
			/>
		);
		expect(screen.getByText("Setup")).toBeTruthy();
		expect(screen.getByText("Teardown")).toBeTruthy();
	});
});
