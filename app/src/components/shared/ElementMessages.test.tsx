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
 * What an inline script element said under load (#3127): the error it threw,
 * each failing test, its console lines, and the count a full list turned away.
 * The callers (`RequestElementsSummary`, `ScenarioStepsTab`) prove the wiring;
 * this file holds the rendering rules.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ElementMessages } from "./ElementMessages";
import { LEVEL_TONE } from "./console-level";
import type { ConsoleLevel, RunScenarioStepElementTally } from "@/types/domain";

const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error"];

function renderMessages(element: Partial<RunScenarioStepElementTally>) {
	return render(<ElementMessages element={element} />);
}

describe("ElementMessages", () => {
	it("says nothing for a row without any of the four fields", () => {
		// A row from an engine before #3127, or a script that threw and logged nothing.
		const { container } = renderMessages({});
		expect(container.firstChild).toBeNull();
	});

	it("says nothing for empty lists and zero counts", () => {
		const { container } = renderMessages({
			messages: [],
			console: [],
			messagesDropped: 0,
			consoleDropped: 0,
		});
		expect(container.firstChild).toBeNull();
	});

	it("shows a thrown error and a failing test, each labelled with its kind", () => {
		renderMessages({
			messages: [
				{ kind: "error", text: "Error: boom" },
				{ kind: "test", text: "status is 201: expected 200 to equal 201" },
			],
		});

		const boom = screen.getByText("Error: boom");
		const failing = screen.getByText("status is 201: expected 200 to equal 201");
		expect(boom).toHaveClass("text-status-error-text");
		expect(failing).toHaveClass("text-status-error-text");
		expect(screen.getByText("error")).toBeInTheDocument();
		expect(screen.getByText("test")).toBeInTheDocument();
	});

	it.each(LEVELS)("draws a %s console line in that level's tone", (level) => {
		renderMessages({ console: [{ level, text: `said ${level}` }] });

		const line = screen.getByText(`said ${level}`);
		expect(line).toHaveClass(LEVEL_TONE[level].text);
		const gutter = line.previousElementSibling;
		expect(gutter).toHaveClass(LEVEL_TONE[level].label);
		expect(gutter?.textContent).toBe(LEVEL_TONE[level].gutter);
	});

	it("keeps the warn and error tones apart from the plain ones", () => {
		// The point of the table: a warning is not drawn like a log line.
		renderMessages({
			console: [
				{ level: "log", text: "plain" },
				{ level: "warn", text: "careful" },
			],
		});

		expect(screen.getByText("plain")).not.toHaveClass("text-status-warning-text");
		expect(screen.getByText("careful")).toHaveClass("text-status-warning-text");
	});

	it("hides the empty gutter of a log line from assistive technology", () => {
		renderMessages({ console: [{ level: "log", text: "plain" }] });

		expect(screen.getByText("plain").previousElementSibling).toHaveAttribute(
			"aria-hidden",
			"true"
		);
	});

	it("keeps the line's text when the level is one the app does not know", () => {
		renderMessages({
			console: [{ level: "trace" as ConsoleLevel, text: "from a newer engine" }],
		});

		expect(screen.getByText("from a newer engine")).toBeInTheDocument();
	});

	describe("the dropped counts", () => {
		it("says how many messages a full list turned away", () => {
			renderMessages({
				messages: [{ kind: "error", text: "Error: boom" }],
				messagesDropped: 1_204,
			});
			expect(
				screen.getByText("1,204 more message occurrences not shown")
			).toBeInTheDocument();
		});

		it("counts occurrences, so one extra error thrown 480 times is not 480 messages", () => {
			renderMessages({
				messages: [{ kind: "error", text: "Error: boom" }],
				messagesDropped: 480,
			});
			expect(screen.getByText("480 more message occurrences not shown")).toBeInTheDocument();
			expect(screen.queryByText(/more messages/)).toBeNull();
		});

		it("says how many console lines a full list turned away, in the singular for one", () => {
			renderMessages({
				console: [{ level: "log", text: "hello" }],
				consoleDropped: 1,
			});
			expect(
				screen.getByText("1 more console line occurrence not shown")
			).toBeInTheDocument();
		});

		it("keeps the two counts apart", () => {
			renderMessages({
				messages: [{ kind: "test", text: "a: b" }],
				messagesDropped: 3,
				console: [{ level: "log", text: "hello" }],
				consoleDropped: 40,
			});
			expect(screen.getByText("3 more message occurrences not shown")).toBeInTheDocument();
			expect(
				screen.getByText("40 more console line occurrences not shown")
			).toBeInTheDocument();
		});

		it("makes no claim of a cut when a list is whole", () => {
			renderMessages({
				messages: [{ kind: "error", text: "Error: boom" }],
				console: [{ level: "log", text: "hello" }],
			});
			expect(screen.queryByText(/not shown/)).toBeNull();
		});
	});
});
