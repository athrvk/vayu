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
 * `app-icon-menus.test.tsx` uses, and for the same reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PALETTE_CHORD } from "@/constants/shortcuts";
import { chordKeys } from "@/lib/platform";

const env = vi.hoisted(() => ({ list: [] as { id: string; name: string }[] }));

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: env.list }),
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
async function renderFor(platform: string | null, activeEnvironmentId: string | null = null) {
	stubPlatform(platform);
	vi.resetModules();
	// The row now holds tooltip-bearing controls (the navigation buttons), which
	// rely on the app-level provider `main.tsx` supplies. It is imported from the
	// same fresh graph as the bar: after `resetModules` a statically imported one
	// is a different Radix instance, and the tooltip context would not match.
	const [{ default: TitleBar }, { useLayoutStore, useSessionStore }, { TooltipProvider }] =
		await Promise.all([import("./TitleBar"), import("@/stores"), import("@/components/ui")]);
	useLayoutStore.setState({ paletteOpen: false });
	useSessionStore.setState({ activeEnvironmentId });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<TitleBar />
				</TooltipProvider>
			</QueryClientProvider>
		),
		useLayoutStore,
	};
}

const searchBar = () => screen.getByRole("button", { name: /search everything/i });
const envSwitcher = () => screen.getByRole("button", { name: /^environment:/i });

beforeEach(() => {
	cleanup();
	env.list = [];
});
afterEach(() => vi.resetModules());

describe("title-row search bar", () => {
	it("shows a search bar carrying the palette's own chord", async () => {
		await renderFor("linux");
		expect(searchBar()).toHaveTextContent("Search");
		// The rendered caps, not the constant: a bar showing "⌘P" while the
		// handler matches ⌘K is precisely what shortcuts.ts was written to stop.
		const caps = Array.from(searchBar().querySelectorAll('[data-slot="kbd"]')).map(
			(cap) => cap.textContent
		);
		expect(caps).toEqual(chordKeys(PALETTE_CHORD));
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

describe("title-row environment switcher", () => {
	it("is named by the environment it shows, so speaking the visible name reaches it", async () => {
		env.list = [{ id: "env_1", name: "Staging" }];
		await renderFor("linux", "env_1");
		// Resolves by the visible name: an `aria-label` over it would replace the
		// name and leave "Staging" matching nothing (WCAG 2.5.3).
		const button = screen.getByRole("button", { name: /Staging/ });
		expect(button).toBe(envSwitcher());
		expect(button).not.toHaveAttribute("aria-label");
		// `\s*`, not a literal space: jsdom's name computation drops the space a
		// browser adds between a flex container's blockified children.
		expect(button).toHaveAccessibleName(/^Environment:\s*Staging$/);
	});

	it("says there is no environment when none is active", async () => {
		env.list = [{ id: "env_1", name: "Staging" }];
		await renderFor("linux", null);
		expect(envSwitcher()).toHaveAccessibleName(/^Environment:\s*No environment$/);
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
			envSwitcher(),
			screen.getByRole("button", { name: /minimize/i }),
			screen.getByRole("button", { name: /close/i }),
		];
		// A loop over an empty list passes every assertion inside it.
		expect(controls).toHaveLength(4);
		for (const el of controls) {
			expect(effectiveRegion(el), `${el.textContent} is inside the drag region`).toBe(
				"no-drag"
			);
		}
	});

	/**
	 * The test above passes against the defect it is paired with: it reads
	 * `effectiveRegion`, which a *cluster* opting out satisfies, so a wrapper
	 * marked `no-drag` in its entirety looks identical to a control that opted
	 * out on itself. The difference is everything the wrapper covers and the
	 * control does not - here the whole third `1fr` column, i.e. the row's slack
	 * right of the search bar, which is what the window is dragged by.
	 *
	 * So this asserts the wrapper's own inherited value instead, and the button's
	 * own declaration rather than an inherited one.
	 */
	it("keeps the slack around the env switcher draggable, opting out only the control", async () => {
		// Every platform: the right column holds the switcher alone on Windows and
		// macOS and the HTML window buttons too on Linux, and the slack has to
		// drag on all three.
		for (const platform of ["win32", "darwin", "linux"]) {
			await renderFor(platform);
			const envButton = envSwitcher();
			// `DropdownMenuTrigger asChild` renders the button in place, so its DOM
			// parent is the row's right-hand wrapper, not a Radix-inserted node.
			const wrapper = envButton.parentElement;
			expect(wrapper, `no right-hand wrapper on ${platform}`).not.toBeNull();
			expect(effectiveRegion(wrapper), `right column is dead on ${platform}`).toBe("drag");
			expect(appRegion(envButton), `env switcher not clickable on ${platform}`).toBe(
				"no-drag"
			);
			cleanup();
		}
	});
});
