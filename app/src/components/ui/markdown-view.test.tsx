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
 * Rendering markdown is the point; not navigating is the requirement.
 *
 * Descriptions are not all hand-typed. They arrive from imported Postman,
 * Insomnia and OpenAPI files - third-party documents off the internet - and
 * Vayu stored that markdown and rendered none of it, which is the only reason
 * it had never mattered.
 *
 * The main window has no `will-navigate` handler, no `setWindowOpenHandler` and
 * no CSP (the only `setWindowOpenHandler` in the tree is in `oauth.ts`). A
 * clicked `<a href>` would navigate the whole renderer, and the preload re-runs
 * on the new origin, handing `window.electronAPI` to it. So the requirement is
 * not "sanitise the href" - it is that no `href` reaches the DOM at all.
 *
 * These assert that in the ways it could regress: a plain link, a bare URL that
 * `remark-gfm` autolinks behind your back, a `javascript:` URL, and raw HTML in
 * the source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownView } from "./markdown-view";

const openExternalUrl = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Only the one method this file exercises. Cast rather than build the whole
	// 30-method surface: a stub of the rest would be noise nothing reads.
	vi.stubGlobal("electronAPI", { openExternalUrl } as unknown as Window["electronAPI"]);
});

describe("it renders markdown at all", () => {
	it("renders emphasis, code and lists rather than printing the syntax", () => {
		const { container } = render(
			<MarkdownView>{"**bold** and `code`\n\n- one\n- two"}</MarkdownView>
		);
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("code")?.textContent).toBe("code");
		expect(container.querySelectorAll("li")).toHaveLength(2);
		// The whole defect, in one assertion: the asterisks used to be on screen.
		expect(container.textContent).not.toContain("**bold**");
	});

	it("renders GFM tables, which imported Postman descriptions use", () => {
		const { container } = render(
			<MarkdownView>{"| a | b |\n| - | - |\n| 1 | 2 |"}</MarkdownView>
		);
		expect(container.querySelector("table")).toBeTruthy();
		expect(container.querySelectorAll("td")).toHaveLength(2);
	});

	it("gives a table its own scroller so the panel never scrolls sideways", () => {
		const { container } = render(
			<MarkdownView>{"| a | b |\n| - | - |\n| 1 | 2 |"}</MarkdownView>
		);
		expect(container.querySelector("table")?.parentElement?.className).toContain(
			"overflow-x-auto"
		);
	});
});

describe("links cannot navigate this window", () => {
	it("emits no anchor for a normal link", () => {
		const { container } = render(
			<MarkdownView>{"[docs](https://example.test/x)"}</MarkdownView>
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("[href]")).toBeNull();
		expect(screen.getByRole("button", { name: "docs" })).toBeInTheDocument();
	});

	it("emits no anchor for a bare URL that remark-gfm autolinks", () => {
		// The one that regresses silently: nobody wrote a link, GFM made one.
		const { container } = render(
			<MarkdownView>{"see https://example.test/x now"}</MarkdownView>
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("[href]")).toBeNull();
	});

	it("opens through the scheme-validated main-process path instead", () => {
		render(<MarkdownView>{"[docs](https://example.test/x)"}</MarkdownView>);
		fireEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/x");
	});

	it("drops a javascript: URL before it can be opened", () => {
		// react-markdown's default urlTransform strips this. It is asserted here
		// because the documented way to break it is to override `urlTransform`,
		// which has a published advisory against it - so this fails if anyone does.
		render(<MarkdownView>{"[x](javascript:alert(1))"}</MarkdownView>);
		const link = screen.queryByRole("button", { name: "x" });
		if (link) fireEvent.click(link);
		expect(openExternalUrl).not.toHaveBeenCalledWith(expect.stringContaining("javascript:"));
	});

	it("shows the destination without following it", () => {
		render(<MarkdownView>{"[docs](https://example.test/x)"}</MarkdownView>);
		expect(screen.getByRole("button", { name: "docs" })).toHaveAttribute(
			"title",
			"https://example.test/x"
		);
	});
});

describe("raw HTML in the source is not markup", () => {
	it("does not execute an img onerror payload", () => {
		// `rehype-raw` is deliberately not installed, so this is inert text.
		const { container } = render(
			<MarkdownView>{'<img src=x onerror="alert(1)">'}</MarkdownView>
		);
		expect(container.querySelector("img")).toBeNull();
	});

	it("does not turn a raw anchor into a link", () => {
		const { container } = render(
			<MarkdownView>{'<a href="https://evil.test">click</a>'}</MarkdownView>
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("[href]")).toBeNull();
	});

	it("does not render a script tag", () => {
		const { container } = render(<MarkdownView>{"<script>alert(1)</script>"}</MarkdownView>);
		expect(container.querySelector("script")).toBeNull();
	});
});
