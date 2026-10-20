/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the MCP server's sibling order on the engine's (#2535).
 *
 * `tools/sibling-order.ts` is the third copy of the comparator, beside the
 * engine's `sibling_order.hpp` and the renderer's `compareTreeOrder`, because the
 * main process cannot compile a file from `src/` (see
 * `variable-origins.conformance.test.ts` for the boundary). `move_item` plans
 * its batch over it, so a drift here is a move that lands among the wrong
 * slots. It replays the fixture the engine's own suite and the renderer's
 * already replay.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { mergeSiblings } from "./tools/sibling-order.js";

const [treeOrderPath] = ENGINE_READING_GUARDS.mcpTreeOrder.paths.map(fromRepoRoot);

interface TreeOrderCase {
	name: string;
	rows: Array<{ id: string; kind: "folder" | "request"; order: number; createdAt: number }>;
	expected: string[];
}

const treeOrder = JSON.parse(readFileSync(treeOrderPath, "utf8")) as { cases: TreeOrderCase[] };

describe("tree-order fixture through mergeSiblings", () => {
	test("scanned a non-empty fixture with cross-kind cases", () => {
		expect(treeOrder.cases.length).toBeGreaterThanOrEqual(12);
		expect(
			treeOrder.cases.filter((c) => new Set(c.rows.map((row) => row.kind)).size > 1).length
		).toBeGreaterThanOrEqual(5);
	});

	test.each(treeOrder.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		// The engine's two lists, as the fixture's `folder` and `request` rows.
		const folders = c.rows.filter((row) => row.kind === "folder");
		const requests = c.rows.filter((row) => row.kind === "request");
		expect(mergeSiblings(folders, requests).map((row) => row.id)).toEqual(c.expected);
		expect(
			mergeSiblings([...folders].reverse(), [...requests].reverse()).map((row) => row.id)
		).toEqual(c.expected);
	});
});
