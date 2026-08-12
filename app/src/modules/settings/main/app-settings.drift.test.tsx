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
 * The app-settings catalogue and the panels have to agree on two things, and
 * both used to be able to drift:
 *
 * - **Where a result lands.** `anchor` is the `data-setting-anchor` the panel
 *   puts on the block; rename a card, move a row into another panel, delete a
 *   setting, and search keeps offering a result that lands on nothing.
 * - **What it is called.** The catalogue used to hand-write a second copy of the
 *   heading, so rewording a card on screen left search offering the old name.
 *   The panels now render `appSetting("<anchor>").label`, and this file checks
 *   that they really do - a heading typed back into a panel as a literal is the
 *   regression, and it is the one a reviewer reads straight past.
 *
 * Rendered rather than source-scanned, because both the anchor and the label
 * arrive through props (the `NumberSettingRow` and `ToggleRow` rows do) and no
 * scan of a panel file would see them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_SETTINGS } from "./app-settings";
import { APP_SETTINGS_PANELS } from "./app-panels";

// The panels reach outside Settings for three things, none of them the subject:
// the engine's run store, its cookie jar, and the Electron updater bridge.
vi.mock("@/queries/runs", () => ({
	useAllRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));
vi.mock("@/queries", () => ({
	useCookiesQuery: () => ({ data: [], isLoading: false, error: null }),
	useClearCookiesMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useEnvironmentsQuery: () => ({ data: [], isLoading: false, error: null }),
	useConfigQuery: () => ({ data: { entries: [] }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

beforeEach(cleanup);

function renderPanel(Component: React.ComponentType) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Component />
		</QueryClientProvider>
	);
}

/**
 * What the block calls itself on screen.
 *
 * A settings block heading is one of four shapes and the block cannot say which
 * it is, so they are tried in the order a reader's eye takes them: a row that
 * *is* the setting names itself (`data-setting-row`, written from the same prop
 * the row prints), then a card's title, then a sub-block's eyebrow, then a row
 * nested inside the block. Order matters - a card holds rows, so the card's own
 * title has to win over the first row inside it.
 *
 * Compared exactly rather than by substring: "Theme Modes" contains "Theme
 * Mode", and a guard that accepts that is not a guard.
 */
function blockHeading(block: Element): string | null {
	const own = block.getAttribute("data-setting-row");
	if (own !== null) return own;
	const titled = block.querySelector('[data-slot="card-title"], [data-slot="eyebrow"]');
	if (titled) return titled.textContent?.trim() ?? "";
	const row = block.querySelector("[data-setting-row]");
	return row === null ? null : (row.getAttribute("data-setting-row") ?? "");
}

describe("the app settings catalogue", () => {
	it("describes something - the guard is worthless against an empty list", () => {
		expect(APP_SETTINGS.length).toBeGreaterThan(20);
	});

	it("gives every setting a unique anchor", () => {
		// Two settings sharing an anchor means one of them can never be revealed:
		// `querySelector` stops at the first.
		const anchors = APP_SETTINGS.map((s) => s.anchor);
		expect(new Set(anchors).size).toBe(anchors.length);
	});

	it("names a panel that exists for every setting", () => {
		const panels = new Set(APP_SETTINGS_PANELS.map((p) => p.id));
		for (const setting of APP_SETTINGS) {
			expect(panels.has(setting.panel)).toBe(true);
		}
	});

	it.each(APP_SETTINGS_PANELS.map((p) => [p.id, p] as const))(
		"renders every anchor the catalogue declares for %s",
		(id, panel) => {
			const declared = APP_SETTINGS.filter((s) => s.panel === id);
			// Every panel holds settings; a panel with none declared is a whole
			// screen missing from search, which is the bug this file guards.
			expect(declared.length).toBeGreaterThan(0);

			const { container } = renderPanel(panel.Component);
			const rendered = new Set(
				[...container.querySelectorAll("[data-setting-anchor]")].map((el) =>
					el.getAttribute("data-setting-anchor")
				)
			);

			for (const setting of declared) {
				expect(
					rendered.has(setting.anchor),
					`${panel.label} declares "${setting.anchor}" (${setting.label}) but renders no such data-setting-anchor`
				).toBe(true);
			}
		}
	);

	it.each(APP_SETTINGS_PANELS.map((p) => [p.id, p] as const))(
		"prints the catalogue's label as the heading of every block in %s",
		(id, panel) => {
			const declared = APP_SETTINGS.filter((s) => s.panel === id);
			const { container } = renderPanel(panel.Component);

			let checked = 0;
			for (const setting of declared) {
				const block = container.querySelector(`[data-setting-anchor="${setting.anchor}"]`);
				// The anchor test above owns the missing-block failure; skipping
				// here keeps one defect from failing two tests with two stories.
				if (block === null) continue;

				const heading = blockHeading(block);
				expect(
					heading,
					`${panel.label}: the block for "${setting.anchor}" prints no heading a search result could be checked against - it needs a CardTitle, an Eyebrow or a named row`
				).not.toBeNull();
				expect(
					heading,
					`${panel.label}: search offers "${setting.label}" for "${setting.anchor}" but the block is headed "${heading}" - the panel should render appSetting("${setting.anchor}").label`
				).toBe(setting.label);
				checked += 1;
			}

			// Guards the guard: a resolver that quietly found nothing would pass
			// every assertion above by never running one.
			expect(checked).toBe(declared.length);
		}
	);
});
