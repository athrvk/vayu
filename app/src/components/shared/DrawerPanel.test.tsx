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
 * The drawer's header band - the left half of the second chrome row.
 *
 * The tab strip sits over the content area with the drawer beside it, so the
 * panel's header and the strip meet at the resize handle and read as one band
 * across the window. That only holds while both take their height from
 * `--tabstrip-height`: an `h-10` here (what this was, back when the strip was
 * up in the title bar and the two never met) puts an 8px step in the rule.
 *
 * Rendered rather than source-scanned - the class list goes through `cn()`, and
 * a scan cannot see what tailwind-merge does to it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DrawerPanel } from "./DrawerPanel";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..");

/** The four drawer views, and the file each one's panel is declared in. */
const VIEWS = {
	collections: join(src, "modules", "collections", "CollectionTree.tsx"),
	history: join(src, "modules", "history", "sidebar", "HistoryList.tsx"),
	variables: join(src, "modules", "variables", "sidebar", "VariablesCategoryTree.tsx"),
	settings: join(src, "modules", "settings", "sidebar", "SettingsCategoryTree.tsx"),
} as const;

describe("drawer header band", () => {
	afterEach(cleanup);

	it("sizes the header to the band token, not to a literal", () => {
		render(
			<DrawerPanel title="Collections">
				<div />
			</DrawerPanel>
		);
		const header = screen.getByRole("heading", { name: "Collections" }).parentElement!;
		expect(header.className).toContain("h-[var(--tabstrip-height)]");
		// The rule that continues across the resize handle into the tab strip.
		expect(header.className).toContain("border-b");
	});

	it("keeps the tools slot beside the title, and optional", () => {
		const { rerender } = render(
			<DrawerPanel title="History" actions={<button>Pin</button>}>
				<div />
			</DrawerPanel>
		);
		expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
		rerender(
			<DrawerPanel title="History">
				<div />
			</DrawerPanel>
		);
		// Titled always, tooled sometimes: a view with no tools must not lose the
		// band, or switching views moves the content's vertical start again.
		expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
	});

	it("is what every drawer view renders its own header through", () => {
		// Source-scanned deliberately: the alternative is mounting four trees that
		// each fetch, and the claim here is only "no view hand-rolls a header",
		// which is a fact about the imports. Each file is checked non-empty first
		// - a scan of nothing satisfies every assertion made of it.
		for (const [view, path] of Object.entries(VIEWS)) {
			const source = readFileSync(path, "utf8");
			expect(source.length, `${view} source`).toBeGreaterThan(500);
			expect(source, `${view} must render a DrawerPanel`).toContain("<DrawerPanel");
			expect(source, `${view} must title its band`).toMatch(
				/<DrawerPanel[\s\S]{0,200}title=/
			);
		}
	});
});
