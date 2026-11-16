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
 * The surface half of the `--rule` contract, for the Settings pick-one tiles
 * (#3499).
 *
 * Every tile grid sits in a `Card`, where `--border` is the card's own colour
 * in dark (`rgb(26,26,26)` on `rgb(26,26,30)`), so an unselected tile on
 * `border-border` had no outline at all. As in `surface-rule.test.tsx` the
 * guard pins the declaration - an ancestor that declares `surface-card` - and
 * the colour class together: `border-rule` under no declared surface falls back
 * to the invisible default, so asserting the class alone proves nothing. The
 * resolved colour is a computed-style question jsdom cannot answer.
 *
 * `FontPicker` draws its tiles through the same `TileItem`, so this holds it
 * too.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardContent } from "@/components/ui/card";
import { TileGroup, TileItem } from "./SettingControls";

/** Exact class tokens, so `border-border-strong` does not read as `border-border`. */
const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function renderTiles(selected: string) {
	return render(
		<Card>
			<CardContent>
				<TileGroup value={selected} onChange={() => {}} label="Theme" columns="grid-cols-2">
					<TileItem value="light" selected={selected === "light"} checkClassName="top-2">
						Light
					</TileItem>
					<TileItem value="dark" selected={selected === "dark"} checkClassName="top-2">
						Dark
					</TileItem>
				</TileGroup>
			</CardContent>
		</Card>
	);
}

describe("a pick-one tile on a Card", () => {
	it("sits under a declared surface", () => {
		renderTiles("light");
		const tile = screen.getByRole("radio", { name: "Dark" });
		expect(tile.closest(".surface-card")).not.toBeNull();
	});

	it("draws its unselected outline on --rule, never on --border", () => {
		renderTiles("light");
		const unselected = tokens(screen.getByRole("radio", { name: "Dark" }));
		expect(unselected).toContain("border-rule");
		expect(unselected).not.toContain("border-border");
	});

	it("keeps the accent border for the selected tile", () => {
		renderTiles("light");
		const selected = tokens(screen.getByRole("radio", { name: "Light" }));
		expect(selected).toContain("border-primary");
		expect(selected).not.toContain("border-rule");
	});
});
