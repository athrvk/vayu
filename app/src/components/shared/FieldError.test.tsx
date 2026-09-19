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
 * The field-level error message (issue #1688).
 *
 * Rendered, not scanned: the size lands through `cn()`, the announcement is an
 * attribute Radix-free markup only has once it exists, and "renders nothing for
 * no message" is a behaviour rather than a class.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AlertTriangle } from "lucide-react";
import { FieldError } from "./FieldError";

describe("FieldError", () => {
	afterEach(cleanup);

	it("announces itself, because it appears after a keystroke", () => {
		render(<FieldError>Port must be a number</FieldError>);
		const el = screen.getByRole("alert");
		expect(el).toHaveTextContent("Port must be a number");
		expect(el.tagName).toBe("P");
	});

	it("carries one size, not whichever the call site had", () => {
		// The three converted presentations were text-sm, text-xs and the 11px
		// step (`text-label` since #1692); a 1px difference between two messages on one screen says
		// nothing a reader can act on.
		render(<FieldError>Too long</FieldError>);
		const el = screen.getByRole("alert");
		expect(el.className).toContain("text-xs");
		expect(el.className).toContain("text-destructive-text");
		expect(el.className).not.toContain("text-sm");
		expect(el.className).not.toContain("text-label");
	});

	it("takes the id a control's aria-describedby points at", () => {
		render(<FieldError id="port-error">Out of range</FieldError>);
		expect(screen.getByRole("alert").id).toBe("port-error");
	});

	it("renders nothing at all for no message", () => {
		// So a call site is `<FieldError>{error}</FieldError>` rather than
		// `{error && <FieldError>}` - the same reason TabCount swallows a zero.
		const { container } = render(<FieldError>{undefined}</FieldError>);
		expect(container).toBeEmptyDOMElement();
		cleanup();
		const empty = render(<FieldError>{""}</FieldError>);
		expect(empty.container).toBeEmptyDOMElement();
	});

	it("renders a span where a <p> would be invalid markup", () => {
		// Inside a <label> or another <span>, a <p> is reparented by the browser,
		// which moves the message out of the row it belongs to.
		// A `<span>` parent rather than the `<label>` the import dialog actually
		// uses: the two have the same phrasing-only content model, and a label with
		// no control in it fails `jsx-a11y/label-has-associated-control`.
		render(
			<span>
				Row
				<FieldError as="span">No such row</FieldError>
			</span>
		);
		const el = screen.getByRole("alert");
		expect(el.tagName).toBe("SPAN");
		expect(el.className).toContain("flex");
	});

	it("takes an optional leading glyph", () => {
		const { container } = render(
			<FieldError icon={AlertTriangle}>Nothing to import from this file.</FieldError>
		);
		const svg = container.querySelector("svg");
		expect(svg, "no glyph rendered").not.toBeNull();
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		cleanup();
		const plain = render(<FieldError>Nothing to import from this file.</FieldError>);
		expect(plain.container.querySelector("svg")).toBeNull();
	});
});
