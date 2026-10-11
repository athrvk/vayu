/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Textarea } from "./textarea";

function classes(el: HTMLElement): string[] {
	return el.className.split(/\s+/);
}

describe("Textarea chrome", () => {
	it("paints no fill of its own, so it reads the surface it sits on", () => {
		render(<Textarea aria-label="f" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("bg-transparent");
		expect(list).not.toContain("bg-background");
	});

	it("draws the same 1px focus ring as Input, with no offset gap", () => {
		render(<Textarea aria-label="f" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("focus-visible:ring-1");
		expect(list).toContain("focus-visible:ring-ring");
		expect(list).not.toContain("focus-visible:ring-2");
		expect(list).not.toContain("focus-visible:ring-offset-2");
		expect(list).not.toContain("ring-offset-background");
	});

	it("lets a caller class override the fill", () => {
		render(<Textarea aria-label="f" className="bg-card" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("bg-card");
		expect(list).not.toContain("bg-transparent");
	});
});
