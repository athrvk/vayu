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
 * An unselected tile's 2px outline sits on a card, not the canvas (#3499).
 *
 * `--border` is tuned for the canvas and is the same colour as `--card` in dark,
 * so the tile's edge was absent there. `border-rule` inherits the `--rule` the
 * enclosing surface declares, and `Card` declares `surface-card`; the class
 * alone proves nothing without that declaration above it, so both halves are
 * asserted (the convention of the other `*.surface-rule.test.tsx` files).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Card, CardContent } from "@/components/ui/card";
import { TileGroup, TileItem } from "./SettingControls";

function renderTiles(selected: string) {
	return render(
		<Card>
			<CardContent>
				<TileGroup
					value={selected}
					onChange={() => {}}
					label="Pick one"
					columns="grid-cols-2"
				>
					{["a", "b"].map((value) => (
						<TileItem
							key={value}
							value={value}
							selected={value === selected}
							checkClassName="top-1"
						>
							{value}
						</TileItem>
					))}
				</TileGroup>
			</CardContent>
		</Card>
	);
}

const classesOf = (el: HTMLElement) => el.className.split(/\s+/);

describe("an unselected TileItem on a card", () => {
	it("rules its edge with border-rule, never the canvas-tuned border token", () => {
		const { getAllByRole } = renderTiles("a");
		const [selectedTile, unselectedTile] = getAllByRole("radio");

		const unselected = classesOf(unselectedTile);
		expect(unselected).toContain("border-rule");
		expect(unselected).not.toContain("border-border");

		const selected = classesOf(selectedTile);
		expect(selected).toContain("border-primary");
		expect(selected).not.toContain("border-rule");
	});

	it("sits under a declared surface, which is what gives border-rule its value", () => {
		const { getAllByRole } = renderTiles("a");
		const tile = getAllByRole("radio")[1];

		const surface = tile.closest(".surface-card");
		expect(surface, "TileItem should be inside a surface-card").not.toBeNull();
	});
});
