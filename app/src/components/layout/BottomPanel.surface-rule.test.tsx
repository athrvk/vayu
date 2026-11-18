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

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useLayoutStore } from "@/stores";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import { BottomPanel } from "./BottomPanel";

beforeEach(() => {
	useLayoutStore.setState({ bottomPanelOpen: true, bottomPanelTab: "logs" });
});

function panelAndDescendants(): HTMLElement[] {
	render(<BottomPanel />);
	const root = screen.getByRole("region", { name: BOTTOM_PANEL_LABEL });
	return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
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
		const bare = panelAndDescendants().filter(
			(el) =>
				(/\bbg-card\b/.test(el.className) && !/\bsurface-card\b/.test(el.className)) ||
				(/\bbg-muted\b/.test(el.className) && !/\bsurface-sunken\b/.test(el.className))
		);
		expect(bare.map((el) => el.className)).toEqual([]);
	});
});
