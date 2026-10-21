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
 * `rowExtra` (#2571) opens one more column for a caller's control. It is
 * opt-in: a table that passes none keeps the track, header band and cells it
 * had, which is every table but the OAuth 2.0 token and refresh lists.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { KeyValueEditorProps, KeyValueItem, KeyValueRowExtraContext } from "@/types";
import KeyValueEditor from "./index";
import {
	KEY_VALUE_GRID,
	KEY_VALUE_GRID_WITH_EXTRA,
	KEY_VALUE_GRID_WITH_FILES,
	KEY_VALUE_GRID_WITH_FILES_AND_EXTRA,
	keyValueGrid,
} from "./grid";

const ITEMS: KeyValueItem[] = [
	{ id: "r1", key: "audience", value: "api", enabled: true },
	{ id: "r2", key: "", value: "", enabled: true },
];

const render_ = vi.fn<NonNullable<KeyValueEditorProps["rowExtra"]>["render"]>(
	(item, { replaceItem, disabled }) => (
		<button
			type="button"
			disabled={disabled}
			onClick={() => replaceItem({ ...item, value: "replaced" })}
		>
			{`extra ${item.key}`}
		</button>
	)
);
const ROW_EXTRA = { header: "Send in", render: render_ };

function mount(props: Partial<KeyValueEditorProps> = {}, onChange = vi.fn()) {
	const view = render(
		<TooltipProvider>
			<KeyValueEditor items={ITEMS} onChange={onChange} {...props} />
		</TooltipProvider>
	);
	return { onChange, view };
}

const header = (view: ReturnType<typeof mount>["view"]) =>
	view.container.querySelector<HTMLElement>(".grid") as HTMLElement;

describe("the key/value grid track", () => {
	it("is the form-data track only when files are offered, and grows only for an extra", () => {
		expect(keyValueGrid(false)).toBe(KEY_VALUE_GRID);
		expect(keyValueGrid(true)).toBe(KEY_VALUE_GRID_WITH_FILES);
		expect(keyValueGrid(false, true)).toBe(KEY_VALUE_GRID_WITH_EXTRA);
		expect(keyValueGrid(true, true)).toBe(KEY_VALUE_GRID_WITH_FILES_AND_EXTRA);
	});
});

describe("KeyValueEditor without rowExtra", () => {
	it("keeps the original track on the header band and every row", () => {
		const { view } = mount();

		const grids = [...view.container.querySelectorAll<HTMLElement>(".grid")];
		expect(grids).toHaveLength(1 + ITEMS.length);
		for (const grid of grids) {
			expect(grid.className).toContain(KEY_VALUE_GRID);
			expect(grid.className).not.toContain("7rem");
		}
	});

	it("keeps the header band at its five cells", () => {
		const { view } = mount();
		expect(header(view).children).toHaveLength(5);
		expect(screen.queryByText("Send in")).toBeNull();
	});
});

describe("KeyValueEditor with rowExtra", () => {
	it("gives the header band and every row the wider track", () => {
		const { view } = mount({ rowExtra: ROW_EXTRA });

		const grids = [...view.container.querySelectorAll<HTMLElement>(".grid")];
		for (const grid of grids) expect(grid.className).toContain(KEY_VALUE_GRID_WITH_EXTRA);
		expect(header(view).children).toHaveLength(6);
		expect(screen.getByText("Send in")).toBeTruthy();
	});

	it("renders the control on a row with content and not on the trailing spare row", () => {
		mount({ rowExtra: ROW_EXTRA });

		expect(screen.getAllByRole("button", { name: /^extra/ })).toHaveLength(1);
		expect(screen.getByRole("button", { name: "extra audience" })).toBeTruthy();
	});

	it("writes the replaced row back under the same id, with the blank row kept", () => {
		const { onChange } = mount({ rowExtra: ROW_EXTRA });

		fireEvent.click(screen.getByRole("button", { name: "extra audience" }));

		const written = onChange.mock.lastCall?.[0] as KeyValueItem[];
		expect(written).toHaveLength(2);
		expect(written[0]).toEqual({ id: "r1", key: "audience", value: "replaced", enabled: true });
		expect(written[1]).toBe(ITEMS[1]);
	});

	it("refuses a replacement the table would refuse as an edit", () => {
		// A control that ignores `disabled`: the table's own gate is what holds.
		const stubborn = {
			header: "Send in",
			render: (item: KeyValueItem, { replaceItem }: KeyValueRowExtraContext) => (
				<button type="button" onClick={() => replaceItem({ ...item, value: "replaced" })}>
					{`extra ${item.key}`}
				</button>
			),
		};
		const { onChange } = mount({ rowExtra: stubborn, canEdit: () => false });

		fireEvent.click(screen.getByRole("button", { name: "extra audience" }));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("is disabled on a switched-off row", () => {
		mount({ rowExtra: ROW_EXTRA, items: [{ ...ITEMS[0], enabled: false }] });
		expect(screen.getByRole("button", { name: "extra audience" })).toBeDisabled();
	});

	it("is disabled in a read-only table", () => {
		mount({ rowExtra: ROW_EXTRA, readOnly: true });
		expect(screen.getByRole("button", { name: "extra audience" })).toBeDisabled();
	});
});
