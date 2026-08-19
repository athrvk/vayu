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

/**
 * Raw HTML is rendered now, and these are the two halves of that trade.
 *
 * Stripe's official OpenAPI document writes every operation description as
 * HTML, so the tags used to sit on screen as literal text. `rehype-raw` parses
 * them and `rehype-sanitize` prunes the result immediately - and it is the
 * hostile block below, not a comment, that holds the plugins in that order:
 * sanitising before the raw HTML is parsed leaves every payload here intact.
 */
describe("the benign HTML subset renders", () => {
	it("renders a paragraph, emphasis and code from raw HTML", () => {
		const { container } = render(
			<MarkdownView>
				{"<p>Retrieves the <strong>account</strong>, <em>maybe</em> <code>id</code>.</p>"}
			</MarkdownView>
		);
		expect(container.querySelector("p")).toBeTruthy();
		expect(container.querySelector("strong")?.textContent).toBe("account");
		expect(container.querySelector("em")?.textContent).toBe("maybe");
		expect(container.querySelector("code")?.textContent).toBe("id");
		// The defect itself: the markup used to be the text.
		expect(container.textContent).not.toContain("<strong>");
	});

	it("renders b and i, which HTML descriptions use where markdown would not", () => {
		const { container } = render(
			<MarkdownView>{"<b>bold</b> and <i>italic</i>"}</MarkdownView>
		);
		expect(container.querySelector("b")?.textContent).toBe("bold");
		expect(container.querySelector("i")?.textContent).toBe("italic");
	});

	it("renders an HTML list and an HTML table", () => {
		const { container } = render(
			<MarkdownView>
				{
					"<ul><li>one</li><li>two</li></ul><table><tbody><tr><td>a</td></tr></tbody></table>"
				}
			</MarkdownView>
		);
		expect(container.querySelectorAll("li")).toHaveLength(2);
		expect(container.querySelector("table")).toBeTruthy();
		expect(container.querySelector("td")?.textContent).toBe("a");
	});

	it("renders an HTML anchor as the same non-navigating button a markdown link gets", () => {
		const { container } = render(
			<MarkdownView>
				{'<a href="https://example.test/x" target="_blank" rel="noreferrer">docs</a>'}
			</MarkdownView>
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("[href]")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "docs" }));
		expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/x");
	});

	it("paints code inside a pre as a block rather than as an inline pill", () => {
		// The `language-*` class this used to be decided from does not survive the
		// sanitiser, so the rule moved into the container. Read the class, not the
		// layout: jsdom has none.
		const { container } = render(<MarkdownView>{"```\nx = 1\n```"}</MarkdownView>);
		expect(container.querySelector("pre code")).toBeTruthy();
		expect(container.firstElementChild?.className).toContain("[&_pre_code]:bg-transparent");
	});
});

describe("hostile HTML stays inert", () => {
	it("drops a script tag and its contents, rather than unwrapping the source onto the screen", () => {
		const { container } = render(
			<MarkdownView>{"<script>alert(1)</script>after"}</MarkdownView>
		);
		expect(container.querySelector("script")).toBeNull();
		// Unwrapping instead of stripping would leave `alert(1)` as visible prose.
		expect(container.textContent).not.toContain("alert(1)");
		expect(container.textContent).toContain("after");
	});

	it("drops a style tag and its contents", () => {
		const { container } = render(
			<MarkdownView>{"<style>body{display:none}</style>text"}</MarkdownView>
		);
		expect(container.querySelector("style")).toBeNull();
		expect(container.textContent).not.toContain("display:none");
	});

	it("does not render an img, so an onerror payload has nothing to fire on", () => {
		const { container } = render(
			<MarkdownView>{'<img src=x onerror="alert(1)">'}</MarkdownView>
		);
		expect(container.querySelector("img")).toBeNull();
	});

	it("does not render an iframe", () => {
		const { container } = render(
			<MarkdownView>{'<iframe src="https://evil.test"></iframe>'}</MarkdownView>
		);
		expect(container.querySelector("iframe")).toBeNull();
	});

	it("keeps a javascript: URL out of the DOM and out of openExternalUrl", () => {
		const { container } = render(
			<MarkdownView>{'<a href="javascript:alert(1)">click</a>'}</MarkdownView>
		);
		expect(container.querySelector("[href]")).toBeNull();
		const link = screen.queryByRole("button", { name: "click" });
		if (link) fireEvent.click(link);
		expect(openExternalUrl).not.toHaveBeenCalled();
	});

	it("does not offer a link whose scheme this window could never act on", () => {
		// `defaultSchema` passes `mailto`, `irc`, `ircs` and `xmpp` on an href; the
		// schema here passes http(s) only, because the click goes to
		// `openExternalUrl` and the main process refuses everything else. Keeping
		// the href would put a destination in the tooltip and then do nothing with
		// it - a button that lies about being clickable.
		render(<MarkdownView>{'<a href="mailto:x@y.test">mail</a>'}</MarkdownView>);
		const button = screen.getByRole("button", { name: "mail" });
		expect(button).not.toHaveAttribute("title");
		fireEvent.click(button);
		expect(openExternalUrl).not.toHaveBeenCalled();
	});

	it("strips inline style and on* handlers from an element it does render", () => {
		const { container } = render(
			<MarkdownView>
				{'<p style="position:fixed" onclick="alert(1)" onmouseover="alert(2)">hi</p>'}
			</MarkdownView>
		);
		const p = container.querySelector("p");
		expect(p?.textContent).toBe("hi");
		expect(p?.getAttribute("style")).toBeNull();
		expect(p?.getAttribute("onclick")).toBeNull();
		expect(p?.getAttribute("onmouseover")).toBeNull();
	});

	it("strips class, so a description cannot paint a sheet over the window", () => {
		// The cheapest attack on a renderer that keeps `class` is not a script:
		// this app's own utilities are enough to cover the UI with an invisible
		// overlay. Nothing a description carries may name them.
		const { container } = render(
			<MarkdownView>{'<p class="fixed inset-0 z-50 bg-black">hi</p>'}</MarkdownView>
		);
		const p = container.querySelector("p");
		expect(p?.textContent).toBe("hi");
		expect(p?.getAttribute("class")).toBeNull();
	});

	it("keeps no attribute the sanitiser's own default schema would have allowed", () => {
		// The schema here is narrower than `defaultSchema`, whose `*` list passes
		// `title`, `id`, `dir`, `align` and thirty more on every element. Nothing
		// below reads any of them, so nothing keeps them - and deleting the
		// narrowing, falling back to those defaults, is what this reddens on.
		const { container } = render(
			<MarkdownView>{'<p id="x" title="t" dir="rtl">hi</p>'}</MarkdownView>
		);
		const p = container.querySelector("p");
		expect(p?.textContent).toBe("hi");
		expect(p?.getAttributeNames()).toEqual([]);
	});

	it("renders malformed markup as text without crashing", () => {
		const { container } = render(
			<MarkdownView>{"<p><strong>unclosed <div><span>x</p>"}</MarkdownView>
		);
		expect(container.textContent).toContain("unclosed");
		expect(container.textContent).toContain("x");
	});
});
