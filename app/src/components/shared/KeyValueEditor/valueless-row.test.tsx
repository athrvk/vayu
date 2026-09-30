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
 * A query row's `valueless` marker (issue #1772) writes it as a bare `key`.
 * A value typed into the row is a value, so `handleUpdate` (index.tsx) drops
 * the marker on a value edit, and clearing that value again leaves `""`,
 * which writes `key=`. A key edit or a toggle leaves the marker alone.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { KeyValueItem } from "@/types";
import KeyValueEditor from "./index";

const valuelessRow = (): KeyValueItem => ({
	id: "r1",
	key: "flag",
	value: "",
	enabled: true,
	valueless: true,
});

describe("a valueless query row", () => {
	it("becomes an ordinary row once a value is typed", () => {
		// Mutation check: without the `delete updated.valueless` in
		// `handleUpdate`, the row keeps its marker and this reds.
		const onChange = vi.fn();
		const { getAllByPlaceholderText } = render(
			<KeyValueEditor items={[valuelessRow()]} onChange={onChange} />
		);

		fireEvent.change(getAllByPlaceholderText("Value")[0], { target: { value: "1" } });

		const [updated] = onChange.mock.calls[0][0] as KeyValueItem[];
		expect(updated.value).toBe("1");
		expect(updated.valueless).toBeUndefined();
	});

	it("keeps its marker through a key edit and a toggle", () => {
		const onChange = vi.fn();
		const { getAllByPlaceholderText, container } = render(
			<KeyValueEditor items={[valuelessRow()]} onChange={onChange} />
		);

		fireEvent.change(getAllByPlaceholderText("Key")[0], { target: { value: "flags" } });
		fireEvent.click(container.querySelector('input[type="checkbox"]')!);

		const [renamed] = onChange.mock.calls[0][0] as KeyValueItem[];
		const [toggled] = onChange.mock.calls[1][0] as KeyValueItem[];
		expect(renamed.valueless).toBe(true);
		expect(toggled.valueless).toBe(true);
	});
});
