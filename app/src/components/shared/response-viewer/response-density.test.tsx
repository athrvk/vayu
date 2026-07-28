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
 * The response pane's bands and its tables, which were each a step out.
 *
 * **The toolbar.** `px-4 py-2` around `h-7` segments is 44px, hung directly
 * under a 24px tab strip - 83% taller than the band it belongs to.
 * `ResponseActions` carries a comment saying its icons are `h-6` *precisely* so
 * they share that 24px row; the toolbar never got the same treatment. It is
 * `h-8` with no vertical padding now: the same construction, one step up.
 *
 * **The segmented control** was three `<Button variant="ghost">` in a `bg-muted`
 * div, each repeating the same eight-class active string. Its track carried no
 * radius, so it stayed square at every Roundedness setting - the defect
 * `boxed-surfaces.test.tsx` exists to catch, in a control that test never
 * reached. It is `ToggleGroup` now.
 *
 * **The tables.** Headers and Cookies both rendered at `text-sm` with `py-2` -
 * ~36px rows - while every other surface in the pane is 12px or 11px. The one
 * tab where vertical space converts directly into information was the loosest
 * thing in the pane.
 *
 * Heights are asserted through class names rather than `getBoundingClientRect`,
 * because jsdom does no layout - every box measures 0. What is checkable is
 * that the band names a height and does not add padding around it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import ResponseBody from "./ResponseBody";
import HeadersViewer from "./HeadersViewer";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const JSON_BODY = '{"a":1}';

function toolbar() {
	const { container } = render(
		<ResponseBody body={JSON_BODY} headers={{ "content-type": "application/json" }} />
	);
	const bar = container.querySelector<HTMLElement>(".border-b");
	expect(bar, "the body toolbar").not.toBeNull();
	return bar!;
}

describe("the body toolbar's band", () => {
	it("names a height instead of padding its way to one", () => {
		const bar = toolbar();
		expect(bar.className).toMatch(/\bh-8\b/);
	});

	it("adds no vertical padding, which is what made it 44px", () => {
		// `py-2` around an `h-7` control is the original defect, restated.
		const bar = toolbar();
		expect(bar.className).not.toMatch(/\bpy-\d/);
		expect(bar.className).toMatch(/\bpx-4\b/);
	});

	it("paints no background of its own, so it stays part of the pane", () => {
		/*
		 * Two wrong answers before this one. `bg-muted/20` was an arbitrary alpha
		 * that declared no `--rule` for the control sitting on it; replacing it
		 * with `surface-sunken` fixed that and over-corrected, because a full
		 * `--muted` fill turns this row into a heavy grey band between a
		 * card-coloured tab strip and a card-coloured editor - a separate block
		 * wedged between them rather than part of the pane.
		 *
		 * The rule never needed a fill. This row is inside the pane, which
		 * declares `surface-card`, so `border-rule` already resolves against a
		 * card - the same way the tab strip above gets its edge, also with no
		 * background. The band is its rule and its height, not a colour.
		 */
		const bar = toolbar();
		expect(bar.className).toMatch(/\bborder-rule\b/);
		expect(bar.className).not.toMatch(/\bsurface-/);
		expect(bar.className).not.toMatch(/\bbg-/);
	});
});

describe("the view-mode segmented control", () => {
	const group = () => {
		render(<ResponseBody body={JSON_BODY} headers={{ "content-type": "application/json" }} />);
		// Radix's single-select ToggleGroup is a `radiogroup`, not a `group` - one
		// choice out of several is a radio set, which is also why arrow keys move
		// between segments rather than tabbing.
		return screen.getByRole("radiogroup", { name: /body view mode/i });
	};

	it("is the shared primitive, not three ghost buttons", () => {
		expect(group().getAttribute("data-slot")).toBe("toggle-group");
	});

	it("carries a radius, so it is not pinned square for a Rounded user", () => {
		// No radius class at all is the quiet way to opt out of `--radius`, and a
		// source scan cannot tell it from a surface that is square on purpose.
		expect(group().className).toMatch(/\brounded-md\b/);
	});

	it("draws no track - no fill and no outline around the segments", () => {
		// The tinted active segment is the whole affordance.
		const cls = group().className;
		expect(cls).not.toMatch(/\bborder\b/);
		expect(cls).not.toMatch(/\bbg-/);
	});

	it("marks the active segment by attribute, not by a swapped class", () => {
		/*
		 * The class list has to be identical either way, so activating a segment
		 * cannot shift layout. The old version swapped an eight-class string per
		 * segment and repeated it three times.
		 */
		const items = Array.from(
			group().querySelectorAll<HTMLElement>('[data-slot="toggle-group-item"]')
		);
		expect(items.length).toBeGreaterThan(1);
		expect(new Set(items.map((i) => i.className)).size).toBe(1);
		expect(items.filter((i) => i.getAttribute("data-state") === "on")).toHaveLength(1);
	});
});

describe("the header table's density", () => {
	const table = () => {
		const { container } = render(
			<HeadersViewer headers={{ "content-type": "application/json" }} variant="response" />
		);
		const t = container.querySelector<HTMLElement>('[data-slot="table"]');
		expect(t, "the headers table").not.toBeNull();
		return t!;
	};

	it("is the shared primitive", () => {
		expect(table().tagName).toBe("TABLE");
	});

	it("renders at the pane's text size, not one step larger", () => {
		// `text-sm` here was a ~36px row in a tab that exists to list twenty of
		// them, while the tab strip above it is `text-xs`.
		expect(table().className).toMatch(/\btext-xs\b/);
		expect(table().className).not.toMatch(/\btext-sm\b/);
	});

	it("tightens the cells to match", () => {
		const cell = table().querySelector<HTMLElement>('[data-slot="table-cell"]');
		expect(cell).not.toBeNull();
		expect(cell!.className).toMatch(/\bpy-1\.5\b/);
		expect(cell!.className).not.toMatch(/\bpy-2\b/);
	});

	it("rules its rows through the surface, not a border token", () => {
		// `--border` on a card is the same colour as the card in dark.
		const row = table().querySelector<HTMLElement>('[data-slot="table-row"]');
		expect(row!.className).toMatch(/\bborder-rule\b/);
		expect(row!.className).not.toMatch(/\bborder-border(-strong)?\b/);
	});
});

describe("what colour a header key is", () => {
	/*
	 * None. Response keys were `text-status-success-text` and request keys
	 * `text-status-running-text` - green and blue drawn from the *status*
	 * vocabulary for a name that has no status. The cost is specific: the status
	 * bar and status-code badge sit directly above this table, and that is where
	 * green and red have to carry meaning.
	 */
	const keyCell = (variant: "request" | "response") => {
		const { container } = render(
			<HeadersViewer headers={{ "content-type": "application/json" }} variant={variant} />
		);
		const cell = container.querySelector<HTMLElement>('[data-slot="table-cell"]');
		expect(cell).not.toBeNull();
		return cell!;
	};

	it.each(["request", "response"] as const)("spends no status token on a %s key", (variant) => {
		// `String.raw`: this assertion was written through a generating script and
		// the `\b` arrived as a literal backspace byte, so the regex matched
		// nothing and the test passed against its own mutation. Third time that
		// trap has bitten here, and it never announces itself.
		expect(keyCell(variant).className).not.toMatch(new RegExp(String.raw`\btext-status-`));
	});

	it("gives both variants the same treatment, since the section already says which", () => {
		expect(keyCell("request").className).toBe(keyCell("response").className);
	});
});

/**
 * Copy and download act on the *body*, so they live with the body.
 *
 * They sat on the tab row, where they read as applying to whatever tab you were
 * standing on - but `content` was always `response.body`, so on Headers, Timing
 * or Raw they copied something other than what was on screen. Moving them into
 * the body toolbar also gave the tab strip back the ~64px they occupied, which
 * is what let all seven tabs render without the strip scrolling.
 */
describe("where the copy and download actions live", () => {
	it("renders whatever the host puts in the toolbar's actions slot", () => {
		const { container } = render(
			<ResponseBody
				body={JSON_BODY}
				headers={{ "content-type": "application/json" }}
				actions={<button type="button">Copy</button>}
			/>
		);
		const bar = container.querySelector<HTMLElement>(".border-b");
		expect(bar, "the body toolbar").not.toBeNull();
		expect(within(bar!).getByRole("button", { name: "Copy" })).toBeInTheDocument();
	});

	it("renders none when the host supplies none, so the history viewer is unchanged", () => {
		// `UnifiedResponseViewer` mounts this same component with nothing to put
		// there - a hardcoded `ResponseActions` would have appeared for it too.
		const { container } = render(
			<ResponseBody body={JSON_BODY} headers={{ "content-type": "application/json" }} />
		);
		const bar = container.querySelector<HTMLElement>(".border-b");
		expect(within(bar!).queryByRole("button", { name: /copy|download/i })).toBeNull();
	});
});
