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
 * `handleUpdate` (index.tsx) clears a row's `source` marker (issue #1481) only
 * on a retyped key or value - disabling the row must not, or a hand-disabled
 * auto-written Content-Type would look user-owned on the next reload. Nothing
 * exercised that guard through the actual component: `content-type.test.tsx`
 * strips `source` by hand on its fixtures rather than driving an edit through
 * `KeyValueEditor`, so a regression in the field check on line 93 would pass
 * every existing test in the tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { KeyValueItem } from "@/types";
import KeyValueEditor from "./index";

function markedRow(overrides: Partial<KeyValueItem> = {}): KeyValueItem {
	return {
		id: "r1",
		key: "Content-Type",
		value: "application/json",
		enabled: true,
		source: "body-mode",
		...overrides,
	};
}

describe("a row's auto-write source marker", () => {
	it("is cleared once the user retypes the value", () => {
		const onChange = vi.fn();
		const { getByPlaceholderText } = render(
			<KeyValueEditor items={[markedRow()]} onChange={onChange} />
		);

		fireEvent.change(getByPlaceholderText("Value"), {
			target: { value: "application/graphql" },
		});

		const [updated] = onChange.mock.calls[0][0] as KeyValueItem[];
		expect(updated.source).toBeUndefined();
	});

	it("survives the row being disabled", () => {
		const onChange = vi.fn();
		const { container } = render(<KeyValueEditor items={[markedRow()]} onChange={onChange} />);

		fireEvent.click(container.querySelector('input[type="checkbox"]')!);

		const [updated] = onChange.mock.calls[0][0] as KeyValueItem[];
		expect(updated.enabled).toBe(false);
		expect(updated.source).toBe("body-mode");
	});
});
