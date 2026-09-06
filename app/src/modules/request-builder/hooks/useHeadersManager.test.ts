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
 * Opening the Headers tab's Bulk edit and switching straight back to Table,
 * with no typing, used to call `onUpdate` anyway - re-enabling every disabled
 * row and trimming every value through the round trip (issue #1480).
 *
 * `handleBulkEdit` is the one place that decision is made, so this pins it
 * directly rather than through the panel and its `BulkEditor` toggle.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { KeyValueItem } from "@/types";
import { useHeadersManager } from "./useHeadersManager";
import { formatHeadersToText } from "../utils/headers-format";

const headers: KeyValueItem[] = [
	{ id: "1", key: "Accept", value: "*/*", enabled: true },
	{ id: "2", key: "Authorization", value: "Bearer abc", enabled: false },
];

describe("useHeadersManager.handleBulkEdit", () => {
	it("does not call onUpdate when the committed text describes the same rows", () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() => useHeadersManager({ headers, onUpdate }));

		result.current.handleBulkEdit(formatHeadersToText(headers));

		expect(onUpdate).not.toHaveBeenCalled();
	});

	// Mutation check: removing the `isNoOpHeadersEdit` guard makes this pass
	// too (onUpdate is still called), which is exactly the bug - so the test
	// above is the one that must fail without the guard, and does.
	it("calls onUpdate when a row actually changed", () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() => useHeadersManager({ headers, onUpdate }));

		const edited = formatHeadersToText(headers).replace("// Authorization", "Authorization");
		result.current.handleBulkEdit(edited);

		expect(onUpdate).toHaveBeenCalledTimes(1);
		const [updated] = onUpdate.mock.calls[0] as [KeyValueItem[]];
		expect(updated.find((h) => h.key === "Authorization")?.enabled).toBe(true);
	});
});
