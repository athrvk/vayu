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
 * The title row: what it holds now, and what still has to drag the window.
 *
 * The row lost the tab strip and gained the search bar. Two things follow that
 * a rendered test can hold:
 *
 * - **The bar advertises the chord the palette listens for.** `shortcuts.ts`
 *   exists so a control cannot claim a combination nothing handles; the bar
 *   reads `PALETTE_CHORD`, the same constant `CommandPalette` matches on, and
 *   clicking it opens the palette through the store rather than through a
 *   second search implementation of its own.
 * - **The row drags and its controls do not.** A `-webkit-app-region: drag`
 *   area ignores pointer events entirely, so a control that forgets to opt out
 *   is not merely awkward - it is dead. That invariant used to be asserted in
 *   `TabStrip.overflow.test.tsx`, because the strip was the row's big
 *   interactive child; it moved here with the geometry.
 *
 * The platform flags are module-level constants read at import time, so the
 * platform is stubbed *before* the import - the same dynamic-import shape
 * `app-icon-system-menu.test.tsx` uses, and for the same reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PALETTE_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: [] }),
}));

/**
 * `-webkit-app-region` is not on CSSStyleDeclaration in TypeScript's DOM lib,
 * and jsdom keeps it as a style property without serialising it into the style
 * attribute - so it is read as a property, never matched as markup.
 */
const appRegion = (el: HTMLElement) =>
	(el.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion;

/**
 * What the compositor would use for an element: its own declaration, or the
 * nearest ancestor's. A control is safe if *either* it opts out or the cluster
 * around it did - asserting only the element itself would fail the correct
 * markup.
 */
function effectiveRegion(el: HTMLElement | null): string | undefined {
	for (let node = el; node; node = node.parentElement) {
		const region = appRegion(node);
		if (region) return region;
	}
	return undefined;
}

function stubPlatform(platform: string | null) {
	Object.defineProperty(window, "electronAPI", {
		value:
			platform === null
				? undefined
				: {
						platform,
						windowIsMaximized: () => Promise.resolve(false),
						onWindowMaximized: () => () => {},
						windowMinimize: () => {},
						windowMaximize: () => {},
						windowClose: () => {},
					},
		writable: true,
		configurable: true,
	});
}

/**
 * Fresh module graph, so the platform flags are recomputed against the stub.
 *
 * The store comes back with it: `resetModules` gives the re-imported TitleBar a
 * *new* `@/stores` instance, so a store imported at the top of this file is not
 * the one the rendered bar writes to - it would sit at `false` for ever while
 * the click worked perfectly.
 */
async function renderFor(platform: string | null) {
	stubPlatform(platform);
	vi.resetModules();
	const [{ default: TitleBar }, { useLayoutStore }] = await Promise.all([
		import("./TitleBar"),
		import("@/stores"),
	]);
	useLayoutStore.setState({ paletteOpen: false });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={client}>
				<TitleBar />
			</QueryClientProvider>
		),
		useLayoutStore,
	};
}

const searchBar = () => screen.getByRole("button", { name: /search everything/i });

beforeEach(cleanup);
afterEach(() => vi.resetModules());

describe("title-row search bar", () => {
	it("shows a search bar carrying the palette's own chord", async () => {
		await renderFor("linux");
		expect(searchBar()).toHaveTextContent("Search");
		// The rendered hint, not the constant: a bar showing "⌘P" while the
		// handler matches ⌘K is precisely what shortcuts.ts was written to stop.
		expect(searchBar()).toHaveTextContent(formatChord(PALETTE_CHORD));
	});

	it("opens the palette when clicked, and does not search on its own", async () => {
		const { useLayoutStore } = await renderFor("linux");
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
		fireEvent.click(searchBar());
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
		// It is a trigger. A real input here would be a second query state and a
		// second ranked list to keep in step with the palette's.
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("centres the bar on the window rather than on the space left over", async () => {
		await renderFor("linux");
		// Equal side columns are the only way to centre on the window when the
		// two clusters are different widths - with flex spacers the bar drifts by
		// half the difference, and drifts again whenever the environment name
		// changes length.
		expect(screen.getByRole("banner").className).toContain("grid-cols-[1fr_auto_1fr]");
	});

	it("is present on every platform that draws the row", async () => {
		// Not "on this machine": the row's contents differ per platform (traffic
		// lights, native overlay, HTML buttons) and the bar must survive all three.
		for (const platform of ["darwin", "win32", "linux"]) {
			await renderFor(platform);
			expect(searchBar(), `missing on ${platform}`).toBeInTheDocument();
			cleanup();
		}
	});

	it("draws nothing at all outside Electron, where there is no chrome to draw", async () => {
		const { container } = await renderFor(null);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("title-row drag regions", () => {
	it("drags by the row and not by its controls", async () => {
		// Linux, because it is the platform that draws its own window buttons in
		// HTML - the largest opted-out cluster, and the one a regression would
		// make unclickable rather than merely awkward.
		await renderFor("linux");
		expect(appRegion(screen.getByRole("banner"))).toBe("drag");

		const controls = [
			searchBar(),
			screen.getByRole("button", { name: /switch environment/i }),
			screen.getByRole("button", { name: /minimize/i }),
			screen.getByRole("button", { name: /close/i }),
		];
		// A loop over an empty list passes every assertion inside it.
		expect(controls).toHaveLength(4);
		for (const el of controls) {
			expect(
				effectiveRegion(el),
				`${el.getAttribute("aria-label")} is inside the drag region`
			).toBe("no-drag");
		}
	});
});
