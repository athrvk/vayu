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
 * An import notice is a follow-up about a file that imported, not an error
 * (#2291): it is drawn as a warning or a note and never announced as an alert.
 *
 * Mutation check: render the `action` tier through `FieldError` again and the
 * alert count and the class assertions both fail.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NoticeList } from "./NoticeList";
import type { ImportNotice } from "./import-notices";

const notices: ImportNotice[] = [
	{ tier: "action", text: "1 request body not imported" },
	{ tier: "note", text: "Collections grouped by URL path" },
];

describe("NoticeList", () => {
	it("announces neither tier as an alert", () => {
		render(<NoticeList notices={notices} />);
		expect(screen.getByText("1 request body not imported")).toBeInTheDocument();
		expect(screen.getByText("Collections grouped by URL path")).toBeInTheDocument();
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("draws an action as a warning and a note as muted", () => {
		render(<NoticeList notices={notices} />);
		const action = screen.getByText("1 request body not imported");
		expect(action.className).toContain("text-warning-text");
		expect(action.className).not.toContain("text-destructive-text");
		expect(screen.getByText("Collections grouped by URL path").className).toContain(
			"text-muted-foreground"
		);
	});

	it("hides each line's glyph from assistive technology", () => {
		render(<NoticeList notices={notices} />);
		const glyphs = document.querySelectorAll("svg");
		expect(glyphs).toHaveLength(2);
		for (const glyph of glyphs) expect(glyph).toHaveAttribute("aria-hidden", "true");
	});

	it("renders nothing for no notices", () => {
		const { container } = render(<NoticeList notices={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a span host when asked, for use inside a label", () => {
		const { container } = render(<NoticeList notices={notices} as="span" />);
		expect(container.firstElementChild?.tagName).toBe("SPAN");
	});

	describe("a notice with a link", () => {
		const linked: ImportNotice[] = [
			{
				tier: "action",
				text: "Sign in: script uses APIs Vayu does not run yet",
				link: { label: "See what Vayu supports", key: "pmApiCompatibility" },
			},
			...notices,
		];

		afterEach(() => vi.unstubAllGlobals());

		it("opens its keyed docs link from a button inside the line", () => {
			const openAppLink = vi.fn();
			vi.stubGlobal("electronAPI", { openAppLink });
			render(<NoticeList notices={linked} />);

			const button = screen.getByRole("button", { name: "See what Vayu supports" });
			expect(button.closest('[role="status"]')).not.toBeNull();
			expect(screen.getAllByRole("button")).toHaveLength(1);
			fireEvent.click(button);
			expect(openAppLink).toHaveBeenCalledExactlyOnceWith("pmApiCompatibility");
		});

		it("keeps the line's text and warning colour beside the link", () => {
			render(<NoticeList notices={linked} />);
			const line = screen.getByRole("button").closest("span.flex");
			expect(line?.textContent).toContain("Sign in: script uses APIs Vayu does not run yet");
			expect(line?.className).toContain("text-warning-text");
		});

		// A batch ledger row is a <label> around its checkbox: the link must not
		// toggle the file in or out of the import.
		it("does not toggle the checkbox of a ledger row that hosts it", () => {
			vi.stubGlobal("electronAPI", { openAppLink: vi.fn() });
			render(
				<label>
					<input type="checkbox" defaultChecked aria-label="Row" />
					<NoticeList notices={linked} as="span" />
				</label>
			);
			fireEvent.click(screen.getByRole("button", { name: "See what Vayu supports" }));
			expect(screen.getByRole("checkbox", { name: "Row" })).toBeChecked();
		});

		it("does not throw where there is no bridge to open it", () => {
			render(<NoticeList notices={linked} />);
			expect(() => fireEvent.click(screen.getByRole("button"))).not.toThrow();
		});
	});
});
