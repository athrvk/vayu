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
 * A tab row's subtitle is what tells it apart from a namesake (#3323).
 *
 * Mutation check: subtitle from `d.title` alone again and the two same-named
 * request tabs read the same, failing the first case.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useTabItems } from "./useTabItems";
import type { TabDescriptor } from "@/components/layout/tab-descriptors";

const focusTab = vi.fn();

const openTabs = [
	{ id: "t1", type: "request", entityId: "r1" },
	{ id: "t2", type: "request", entityId: "r2" },
	{ id: "t3", type: "run", entityId: "run1" },
	{ id: "t4", type: "settings", entityId: null },
];

const descriptors: Pick<TabDescriptor, "label" | "title" | "path">[] = [
	{ label: "Get user", title: "GET Get user", path: "Users / Get user" },
	{ label: "Get user", title: "GET Get user", path: "Admin / Get user" },
	{ label: "/login", title: "Send: POST /login" },
	{ label: "Settings", title: "Settings" },
];

vi.mock("@/stores", () => ({
	useTabsStore: (selector: (state: unknown) => unknown) =>
		selector({ openTabs, focusTab, tabFocusedAt: {} }),
}));

vi.mock("@/components/layout/tab-descriptors", () => ({
	useTabDescriptors: () => descriptors,
}));

describe("useTabItems subtitles", () => {
	it("tells two same-named request tabs apart by their collection path", () => {
		const { result } = renderHook(() => useTabItems());

		expect(result.current[0].title).toBe(result.current[1].title);
		expect(result.current[0].subtitle).toBe("Users / Get user");
		expect(result.current[1].subtitle).toBe("Admin / Get user");
	});

	it("keeps the descriptor title for a tab that has no path, and none when it repeats the label", () => {
		const { result } = renderHook(() => useTabItems());

		expect(result.current[2].subtitle).toBe("Send: POST /login");
		expect(result.current[3].subtitle).toBeUndefined();
	});

	it("names the request a request tab opens, so Recents can list it once", () => {
		const { result } = renderHook(() => useTabItems());

		expect(result.current.map((item) => item.entityKey)).toEqual([
			"request:r1",
			"request:r2",
			undefined,
			undefined,
		]);
	});
});
