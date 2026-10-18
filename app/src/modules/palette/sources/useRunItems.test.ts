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
 * A palette run row names its kind with `RUN_TYPE_NAME`, the same words the
 * History row and Recent runs print (docs/ux-writing.md). The palette used to
 * keep a table of its own and call a send a "request".
 *
 * Mutation check: bring back a second kind table in `useRunItems` (`load: "load
 * test"`, `design: "request"`) and the title and subtitle cases fail.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import type { Run } from "@/types";
import { RUN_SEARCH_DEBOUNCE_MS, useRunItems } from "./useRunItems";

let runs: Run[] = [];

vi.mock("@/queries", () => ({
	useRunSearchQuery: () => ({
		data: { data: runs, pagination: { total: runs.length } },
		isError: false,
	}),
	useCollectionsQuery: () => ({ data: [] }),
}));

function bareRun(type: Run["type"], status: Run["status"] = "completed"): Run {
	return { id: `run_${type}`, type, status, startTime: Date.now() - 60_000 } as Run;
}

function rows(type: Run["type"], status?: Run["status"]) {
	runs = [bareRun(type, status)];
	vi.useFakeTimers();
	const { result } = renderHook(() => useRunItems("checkout"));
	act(() => {
		vi.advanceTimersByTime(RUN_SEARCH_DEBOUNCE_MS);
	});
	return result.current;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the palette's run rows", () => {
	it.each(["design", "scenario", "load"] as const)(
		"name a bare %s run by RUN_TYPE_NAME, in the title and the subtitle",
		(type) => {
			const [row] = rows(type);
			const name = RUN_TYPE_NAME[type];

			expect(row.title).toBe(name);
			expect(row.subtitle?.startsWith(`${name} · Completed · `)).toBe(true);
			for (const text of [row.title, row.subtitle ?? ""]) {
				expect(text).not.toMatch(/request|scenario|collection(?! run)/i);
			}
		}
	);

	it("spells the status as the status map does, not as the wire value", () => {
		const [row] = rows("load", "stopped");

		expect(row.subtitle).toContain(" · Stopped · ");
	});
});
