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
 * Issue #1716: `handleRemove`, `handleUpdate`, `handlePickFile` and
 * `handleToggleKind` listed `items` in their `useCallback` deps. Every
 * keystroke writes a fresh `items` array back through `onChange`, so every one
 * of those callbacks got a new identity on every keystroke, and every
 * `KeyValueRow` - `memo`-wrapped - failed its shallow prop compare and
 * re-rendered, whether or not that row's own item had changed.
 *
 * `KeyValueRow` is wrapped here in a second, identically-shallow `memo` whose
 * body counts renders per row id before delegating to the real component -
 * not a `Profiler`, because a `Profiler` around the row list fires on every
 * commit regardless of which memoized child actually re-executed its render
 * function, which is exactly the distinction this test needs.
 */

import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { memo, createElement, type ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type KeyValueRowType from "./KeyValueRow";
import type { KeyValueItem } from "@/types";
import KeyValueEditor from "./index";

const renderCounts: Record<string, number> = {};

vi.mock("./KeyValueRow", async (importOriginal) => {
	const mod = await importOriginal<{ default: typeof KeyValueRowType }>();
	const Counting = memo((props: ComponentProps<typeof KeyValueRowType>) => {
		renderCounts[props.item.id] = (renderCounts[props.item.id] ?? 0) + 1;
		return createElement(mod.default, props);
	});
	return { default: Counting };
});

const ITEMS: KeyValueItem[] = [
	{ id: "r1", key: "k1", value: "v1", enabled: true },
	{ id: "r2", key: "k2", value: "v2", enabled: true },
	{ id: "r3", key: "k3", value: "v3", enabled: true },
	{ id: "r4", key: "k4", value: "v4", enabled: true },
	{ id: "r5", key: "k5", value: "v5", enabled: true },
];

function Harness() {
	const [items, setItems] = useState<KeyValueItem[]>(ITEMS);
	return (
		<TooltipProvider>
			<KeyValueEditor items={items} onChange={setItems} />
		</TooltipProvider>
	);
}

describe("row re-renders under a keystroke", () => {
	it("re-renders only the row being typed in, not its siblings", () => {
		render(<Harness />);
		for (const id of ["r1", "r2", "r3", "r4", "r5"]) renderCounts[id] = 0;

		const valueInputs = screen.getAllByPlaceholderText("Value");
		fireEvent.change(valueInputs[2], { target: { value: "v3!" } }); // row r3

		expect(renderCounts.r3).toBeGreaterThan(0);
		expect(renderCounts.r1).toBe(0);
		expect(renderCounts.r2).toBe(0);
		expect(renderCounts.r4).toBe(0);
		expect(renderCounts.r5).toBe(0);
	});
});
