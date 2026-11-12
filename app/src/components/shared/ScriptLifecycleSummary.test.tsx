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
 *
 * Issue #3455: a setup that fails now reaches the report with its reason, its
 * console lines and its failing tests, so the row says all three.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScriptLifecycleSummary } from "./ScriptLifecycleSummary";
import type { LifecycleElementOutcome } from "@/types/domain";

function outcome(overrides: Partial<LifecycleElementOutcome> = {}): LifecycleElementOutcome {
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
		expect(screen.getByText("Ran")).toBeTruthy();
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

	describe("a script the run's Stop cancelled (#3371)", () => {
		const STOPPED = "the run was stopped before this script's pm.sendRequest answered";

		it.each([
			["setup", "script.setup"],
			["teardown", "script.teardown"],
		] as const)(
			"shows a skipped %s in the muted tone, with its message and no footnote",
			(phase, kind) => {
				render(
					<ScriptLifecycleSummary
						lifecycle={{
							[phase]: [outcome({ kind, outcome: "skipped", message: STOPPED })],
						}}
					/>
				);
				const message = screen.getByText(STOPPED);
				expect(message.className).toContain("text-muted-foreground");
				expect(message.className).not.toContain("text-destructive-text");
				expect(screen.queryByText(/does not change the run's status/)).toBeNull();
			}
		);

		it("falls back to Skipped when the engine sent no message", () => {
			render(
				<ScriptLifecycleSummary lifecycle={{ setup: [outcome({ outcome: "skipped" })] }} />
			);
			const label = screen.getByText("Skipped");
			expect(label.className).toContain("text-muted-foreground");
		});

		it("keeps the footnote when a skipped row sits beside a real failure", () => {
			render(
				<ScriptLifecycleSummary
					lifecycle={{
						setup: [outcome({ outcome: "skipped", message: STOPPED })],
						teardown: [
							outcome({ kind: "script.teardown", outcome: "error", message: "boom" }),
						],
					}}
				/>
			);
			expect(screen.getByText(STOPPED).className).toContain("text-muted-foreground");
			expect(screen.getByText("boom").className).toContain("text-destructive-text");
			expect(screen.getByText(/does not change the run's status/)).toBeTruthy();
		});
	});

	describe("a failed setup that refused the run (#3455)", () => {
		const failedSetup = outcome({
			outcome: "failed",
			message: "setup assertion failed: token missing",
			messages: [{ kind: "test", text: "token present: expected a value" }],
			console: [{ level: "warn", text: "token endpoint answered 500" }],
		});

		it("shows the reason, the console line, the failing test and the footnote", () => {
			render(<ScriptLifecycleSummary lifecycle={{ setup: [failedSetup] }} />);
			const reason = screen.getByText("setup assertion failed: token missing");
			expect(reason.className).toContain("text-destructive-text");
			expect(screen.getByText("token endpoint answered 500")).toBeTruthy();
			expect(screen.getByText("token present: expected a value")).toBeTruthy();
			expect(
				screen.getByText(/a failed setup already kept it from sending anything/)
			).toBeTruthy();
		});

		it.each(["", "   "])("falls back to the tone label for a message of %j", (message) => {
			render(
				<ScriptLifecycleSummary
					lifecycle={{ setup: [outcome({ outcome: "failed", message })] }}
				/>
			);
			expect(screen.getByText("Failed").className).toContain("text-destructive-text");
		});
	});

	it("shows a passing row's console lines under it", () => {
		render(
			<ScriptLifecycleSummary
				lifecycle={{
					setup: [
						outcome({ console: [{ level: "log", text: "seeded 3 users", count: 2 }] }),
					],
				}}
			/>
		);
		expect(screen.getByText("Ran")).toBeTruthy();
		expect(screen.getByText("seeded 3 users")).toBeTruthy();
	});

	it("keeps each row's lines with its own row", () => {
		render(
			<ScriptLifecycleSummary
				lifecycle={{
					setup: [outcome({ console: [{ level: "log", text: "from setup" }] })],
					teardown: [outcome({ kind: "script.teardown" })],
				}}
			/>
		);
		const rows = screen.getAllByRole("listitem");
		const setupRow = rows.find((li) => li.textContent?.startsWith("Setup"));
		expect(setupRow?.textContent).toContain("from setup");
		const teardownRow = rows.find((li) => li.textContent?.startsWith("Teardown"));
		expect(teardownRow?.textContent).not.toContain("from setup");
	});
});
