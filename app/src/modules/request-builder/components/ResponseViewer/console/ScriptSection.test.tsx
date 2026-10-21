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
 * A script error is a blocking `Callout` (#2317).
 *
 * The hand-written box mixed `--destructive` and `--status-error` tokens in one
 * block; the three-token rule keeps `--status-*` for lifecycle state.
 *
 * Mutation check: restore the hand-written box and the `border-destructive/40`
 * and no-`status-` assertions fail.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScriptError } from "./ScriptSection";
import { SCRIPT_SECTIONS } from "./script-sections";

describe("ScriptError", () => {
	it.each(["pre", "test"] as const)("draws the %s error as a blocking Callout", (which) => {
		const { container } = render(
			<ScriptError which={which} message="ReferenceError: foo is not defined" />
		);

		const box = container.firstElementChild;
		expect(box).toHaveClass("border-destructive/40", "bg-destructive/10");
		expect(box?.querySelector("svg")).not.toBeNull();
		expect(screen.getByText(SCRIPT_SECTIONS[which].errorLabel)).toBeInTheDocument();
		expect(screen.getByText("ReferenceError: foo is not defined").tagName).toBe("PRE");
	});

	it("carries no --status-error token anywhere in the block", () => {
		const { container } = render(<ScriptError which="pre" message="boom" />);

		expect(container.innerHTML).not.toContain("status-error");
	});
});
