/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One notice treatment, replacing several hand-rolled ones.
 *
 * The load-test dialog had five; the MCP settings panel repeated two of the
 * same variants again, with `border-warning/30` in one place and `/40` in
 * another. What matters here is that severity actually changes the treatment -
 * a shared component that renders every severity identically would be the same
 * problem with fewer files.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Callout } from "./Callout";
import { SEVERITY_ORDER } from "./callout-severity";

describe("Callout", () => {
	it("renders the title and body as one sentence", () => {
		render(
			<Callout severity="warning" title="Enabled but not listening">
				the port may be in use.
			</Callout>
		);
		expect(screen.getByText(/Enabled but not listening/)).toBeInTheDocument();
		expect(screen.getByText(/the port may be in use/)).toBeInTheDocument();
	});

	it("gives each severity its own treatment", () => {
		const seen = new Set<string>();
		for (const severity of SEVERITY_ORDER) {
			const { container, unmount } = render(<Callout severity={severity}>x</Callout>);
			const cls = container.firstElementChild?.className ?? "";
			expect(cls, severity).not.toBe("");
			seen.add(cls);
			unmount();
		}
		// Three severities, three distinct treatments - otherwise the prop is
		// decoration and a blocker looks like a hint.
		expect(seen.size).toBe(SEVERITY_ORDER.length);
	});

	it("puts blocking on destructive tokens, not warning ones", () => {
		// It is the tier that disables an action, so it has to outrank a warning
		// sitting next to it in the same stack.
		const { container } = render(<Callout severity="blocking">x</Callout>);
		expect(container.firstElementChild?.className).toContain("destructive");
	});

	it("renders an action alongside the message", () => {
		render(
			<Callout severity="warning" action={<button>Retry</button>}>
				body
			</Callout>
		);
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it("hides its icon from assistive tech - severity is carried by the words", () => {
		const { container } = render(<Callout severity="warning">body</Callout>);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("orders severities so a blocker sorts above advice", () => {
		expect([...SEVERITY_ORDER]).toEqual(["blocking", "warning", "info"]);
	});
});
