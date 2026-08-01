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
 * `console.error` has to look different from `console.log`.
 *
 * It did not, anywhere in the stack: QuickJS bound all four methods to one C
 * function that recorded no level, so four different calls arrived as four
 * identical strings and the panel had nothing to draw with. The engine carries
 * the level now, and this is the half that spends it.
 *
 * Rendered rather than source-scanned, because the tone arrives through a table
 * lookup - a scan for `text-status-error-text` would pass on the table's mere
 * existence, with nothing reading it.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScriptLogs } from "./ScriptSection";
import type { ParsedLog } from "./parse-logs";

const line = (level: ParsedLog["level"], message: string): ParsedLog => ({
	source: "test",
	level,
	message,
});

/** The `<pre>` holding a message, which is what carries the text tone. */
function messageEl(text: string) {
	return screen.getByText(text);
}

describe("a console line is drawn by its level", () => {
	it("gives warn and error their status tokens, and nothing else", () => {
		render(
			<ScriptLogs
				which="test"
				logs={[line("log", "plain"), line("warn", "careful"), line("error", "broken")]}
			/>
		);

		expect(messageEl("careful").className).toContain("text-status-warning-text");
		expect(messageEl("broken").className).toContain("text-status-error-text");

		// The three-token rule: `-text` when the colour *is* the text. A bare
		// `--status-error` here would be the most common colour bug in this repo.
		expect(messageEl("broken").className).not.toMatch(/text-status-error(?!-text)/);
		expect(messageEl("plain").className).toContain("text-foreground");
	});

	it("separates info from log by its label, not by a fourth colour", () => {
		render(<ScriptLogs which="test" logs={[line("log", "plain"), line("info", "noted")]} />);

		// Chrome draws info as log, and a fourth saturated tone would compete with
		// the section colour. The label is the difference, and it is a real one.
		expect(messageEl("noted").className).toContain("text-foreground");
		expect(screen.getByText("info")).toBeInTheDocument();
	});

	it("leaves the gutter blank for an ordinary log, but still reserves it", () => {
		const { container } = render(<ScriptLogs which="test" logs={[line("log", "plain")]} />);

		expect(screen.queryByText("log")).toBeNull();
		// Reserved, so a slab mixing levels does not have ragged message starts.
		const gutter = container.querySelector("span[aria-hidden='true']");
		expect(gutter?.className).toContain("w-9");
		expect(gutter?.textContent).toBe("");
	});

	it("labels warn and error in their own tone", () => {
		render(
			<ScriptLogs which="test" logs={[line("warn", "careful"), line("error", "broken")]} />
		);

		expect(screen.getByText("warn").className).toContain("text-status-warning-text");
		expect(screen.getByText("error").className).toContain("text-status-error-text");
	});
});
