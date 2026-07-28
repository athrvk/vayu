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
 * Reads as prose, edits as text.
 *
 * The rule is **focus**, not dirtiness. Those two disagree in both directions -
 * a clean focused field, a dirty blurred one - and focus is the one the user is
 * expressing: you are editing because you clicked in. Dirtiness survives only as
 * `keepSourceOpen`, for a caller whose save failed, so unsaved text is never
 * hidden behind a render of what is stored.
 *
 * The interaction that has to keep working is the one where the two features
 * meet: links inside the render are buttons (see markdown-view), and clicking
 * one must open it *without* also dropping the reader into the source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "./tooltip";
import { MarkdownEditor } from "./markdown-editor";

const openExternalUrl = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Only the one method this file exercises. Cast rather than build the whole
	// 30-method surface: a stub of the rest would be noise nothing reads.
	vi.stubGlobal("electronAPI", { openExternalUrl } as unknown as Window["electronAPI"]);
});

function renderEditor(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
	const onChange = vi.fn();
	const onCommit = vi.fn();
	const utils = render(
		<TooltipProvider>
			<MarkdownEditor
				value={"**bold** text\n\n[docs](https://example.test/x)"}
				onChange={onChange}
				onCommit={onCommit}
				{...props}
			/>
		</TooltipProvider>
	);
	return { ...utils, onChange, onCommit };
}

const source = () => screen.queryByRole("textbox");

describe("rendered until you click in", () => {
	it("starts rendered", () => {
		const { container } = renderEditor();
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(source()).not.toBeInTheDocument();
	});

	it("shows the source when the rendered block is clicked", () => {
		const { container } = renderEditor();
		fireEvent.click(container.querySelector('[role="button"]')!);
		expect(source()).toBeInTheDocument();
	});

	it("is reachable from the keyboard, not only by mouse", () => {
		const { container } = renderEditor();
		const block = container.querySelector('[role="button"]') as HTMLElement;
		expect(block).toHaveAttribute("tabindex", "0");
		fireEvent.keyDown(block, { key: "Enter" });
		expect(source()).toBeInTheDocument();
	});

	it("puts the caret at the end, which is the honest place for it", () => {
		// Mapping a rendered offset back to a source offset needs a real WYSIWYG
		// editor; a caret that lands somewhere plausible and wrong is worse than
		// one that lands somewhere predictable.
		const { container } = renderEditor({ value: "hello" });
		fireEvent.click(container.querySelector('[role="button"]')!);
		const ta = source() as HTMLTextAreaElement;
		expect(ta.selectionStart).toBe(5);
	});

	it("renders again on blur, and tells the caller to persist", () => {
		const { container, onCommit } = renderEditor();
		fireEvent.click(container.querySelector('[role="button"]')!);
		fireEvent.blur(source()!);
		expect(source()).not.toBeInTheDocument();
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("reports edits as they are typed", () => {
		const { container, onChange } = renderEditor();
		fireEvent.click(container.querySelector('[role="button"]')!);
		fireEvent.change(source()!, { target: { value: "# new" } });
		expect(onChange).toHaveBeenCalledWith("# new");
	});
});

describe("following a link does not start an edit", () => {
	it("opens the link", () => {
		renderEditor();
		fireEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/x");
	});

	it("leaves the block rendered", () => {
		// The click bubbles to the block, which would otherwise swap in the source
		// under the reader who was only following a link.
		renderEditor();
		fireEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(source()).not.toBeInTheDocument();
	});
});

describe("the source pin", () => {
	it("holds the markdown open across a blur", () => {
		// Without it there is no way to look at your own markdown while reading,
		// and people who write markdown want that.
		renderEditor();
		fireEvent.click(screen.getByLabelText(/show markdown source/i));
		expect(source()).toBeInTheDocument();
		fireEvent.blur(source()!);
		expect(source()).toBeInTheDocument();
	});

	it("goes back to rendered when unpinned", () => {
		renderEditor();
		fireEvent.click(screen.getByLabelText(/show markdown source/i));
		fireEvent.click(screen.getByLabelText(/show rendered/i));
		expect(source()).not.toBeInTheDocument();
	});
});

describe("the empty and unsaved cases", () => {
	it("invites rather than showing a blank box", () => {
		renderEditor({ value: "", emptyHint: "Add a description…" });
		expect(screen.getByText("Add a description…")).toBeInTheDocument();
	});

	it("treats whitespace as empty", () => {
		renderEditor({ value: "   \n  ", emptyHint: "Add a description…" });
		expect(screen.getByText("Add a description…")).toBeInTheDocument();
	});

	it("keeps the source open when the caller says the save failed", () => {
		// Rendering stored text over unsaved edits would hide the thing that
		// needs attention.
		renderEditor({ keepSourceOpen: true });
		expect(source()).toBeInTheDocument();
		fireEvent.blur(source()!);
		expect(source()).toBeInTheDocument();
	});
});
