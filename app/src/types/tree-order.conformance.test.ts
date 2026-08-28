/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: `compareTreeOrder` against the same fixture the
 * engine's `tree_order_test.cpp` drives through `Database::get_collections` and
 * `get_requests_in_collection` (issue #360).
 *
 * The sidebar sorts client-side and a scenario run reads the engine's SQL
 * order. When those two rules disagreed, "run this folder" executed in an order
 * the user had never seen - and neither side had a test that could notice,
 * because each was self-consistent. One table, two readers, no copy to drift.
 *
 * Read from the engine tree on purpose, the same way
 * `variable-resolution.conformance.test.ts` does.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { compareTreeOrder, type OrderedTreeRow } from "./domain";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.treeOrder.paths.map(fromRepoRoot);

interface ConformanceCase {
	name: string;
	rows: Array<{ id: string; order: number; createdAt: number }>;
	expected: string[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	description: string;
	cases: ConformanceCase[];
};

/**
 * The renderer holds `createdAt` as the ISO string its transformers produce
 * from the engine's epoch-millisecond column, so the fixture is fed in through
 * that same conversion rather than compared in a shape the app never has.
 */
function toRow(row: ConformanceCase["rows"][number]): OrderedTreeRow {
	return { id: row.id, order: row.order, createdAt: new Date(row.createdAt).toISOString() };
}

describe("tree-order conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.cases.length).toBeGreaterThanOrEqual(12);
		for (const c of fixture.cases) {
			expect(c.rows.length).toBeGreaterThan(1);
			expect(c.expected).toHaveLength(c.rows.length);
		}
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const sorted = c.rows.map(toRow).sort(compareTreeOrder);
		expect(sorted.map((r) => r.id)).toEqual(c.expected);
	});

	it("sorts the same regardless of the input order", () => {
		for (const c of fixture.cases) {
			const reversed = [...c.rows].reverse().map(toRow).sort(compareTreeOrder);
			expect(reversed.map((r) => r.id)).toEqual(c.expected);
		}
	});
});

describe("compareTreeOrder edge cases the fixture cannot express", () => {
	it("treats a missing order as 0 and a missing createdAt as the epoch", () => {
		const rows: OrderedTreeRow[] = [
			{ id: "b", createdAt: new Date(1_700_000_000_000).toISOString() },
			{ id: "a" },
		];
		expect(rows.sort(compareTreeOrder).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("returns 0 for two rows that agree on every key", () => {
		const row: OrderedTreeRow = { id: "same", order: 1, createdAt: "2026-01-01T00:00:00.000Z" };
		expect(compareTreeOrder(row, { ...row })).toBe(0);
	});
});
