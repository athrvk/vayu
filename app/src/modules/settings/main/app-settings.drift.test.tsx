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
 * The app-settings catalogue is a second copy of what the panels render, which
 * is exactly the arrangement that drifts: rename a card, move a row into
 * another panel, delete a setting, and search keeps offering a result that
 * lands on nothing - the failure the catalogue exists to fix, wearing a
 * different hat.
 *
 * So the catalogue is not trusted, it is checked: every panel is rendered and
 * every anchor it declares has to be on screen, in that panel. Rendered rather
 * than source-scanned, because an anchor can arrive through a prop (the
 * NumberSettingRow rows do) and no scan of a panel file would see it.
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
});
