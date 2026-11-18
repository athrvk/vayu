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
 * The surface half of the `--rule` contract, for the bottom panel (#3635); the
 * contract is `components/shared/response-viewer/surface-rule.test.tsx`'s.
 *
 * The panel sits on `bg-panel`, the root surface, where `border-rule` falls
 * back to the colour that reads (`--border`, tuned for canvas and panel). So the
 * panel declares no `surface-*` of its own - and what it must never do is paint
 * a card or a muted fill without declaring the matching surface, which would
 * leave every divider inside it on a default that is invisible there. Asserting
 * `border-rule` is present would prove nothing; the declaration is what is
 * pinned. This renders the real tab content, so whatever the tab adds is held
 * to the same rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { render as renderWithTooltips } from "@/test/render-with-tooltips";
import { useLayoutStore } from "@/stores";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import { fakeLogsBridge, logRecord } from "@/modules/logs/logs-bridge.testkit";
import { useLogsStore } from "@/modules/logs/logs-store";
import { BottomPanel } from "./BottomPanel";

vi.mock("@/queries", () => ({ useConfigQuery: () => ({ data: undefined }) }));

beforeEach(() => {
	useLayoutStore.setState({ bottomPanelOpen: true, bottomPanelTab: "logs" });
});

function panelAndDescendants(): HTMLElement[] {
	render(<BottomPanel />);
	return everythingInPanel();
}

function everythingInPanel(): HTMLElement[] {
	const root = screen.getByRole("region", { name: BOTTOM_PANEL_LABEL });
	return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
}

function undeclared(elements: HTMLElement[]): string[] {
	return elements
		.filter(
			(el) =>
				(/\bbg-card\b/.test(el.className) && !/\bsurface-card\b/.test(el.className)) ||
				(/\bbg-muted\b/.test(el.className) && !/\bsurface-sunken\b/.test(el.className))
		)
		.map((el) => el.className);
}

describe("the bottom panel's surface", () => {
	it("sits on the root panel surface, which declares none of the --rule surfaces", () => {
		const [root] = panelAndDescendants();
		expect(root.className).toMatch(/\bbg-panel\b/);
		expect(root.className).not.toMatch(/\bsurface-(card|sunken)\b/);
	});

	it("scans a non-empty tree", () => {
		// A guard over an empty list reads as coverage and passes forever.
		expect(panelAndDescendants().length).toBeGreaterThan(3);
	});

	it("paints no card or muted fill without the surface class that declares its rule", () => {
		expect(undeclared(panelAndDescendants())).toEqual([]);
	});
});

describe("the bottom panel's surface with the Logs tab's lines drawn", () => {
	const bridge = fakeLogsBridge();

	beforeEach(() => {
		bridge.answer({ records: [logRecord(1), { unparsed: true, raw: "raw line" }] });
		vi.stubGlobal("electronAPI", { logs: bridge.logs });
	});

	afterEach(() => {
		useLogsStore.getState().stop();
		vi.unstubAllGlobals();
	});

	it("declares the surface of the block an opened row draws", async () => {
		renderWithTooltips(<BottomPanel />);
		await waitFor(() => expect(useLogsStore.getState().records).toHaveLength(2));
		fireEvent.click(await screen.findByRole("button", { name: /line 1/ }));

		const everything = everythingInPanel();
		// The opened row's JSON block is on a sunken surface; a guard that found no
		// such block would be reading a tab that drew none of its own surfaces.
		expect(everything.some((el) => /\bsurface-sunken\b/.test(el.className))).toBe(true);
		expect(undeclared(everything)).toEqual([]);
	});
});
