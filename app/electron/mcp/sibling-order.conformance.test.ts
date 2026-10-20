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
 * its batch over it and the scenario pre-flight walks a subtree with it, so a
 * drift here is a move that lands among the wrong slots or a refusal naming a
 * step the run would not have reached first. Both readings replay the fixtures
 * the engine's own suite and the renderer's already replay.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { mergeSiblings } from "./tools/sibling-order.js";
import { scenarioStepRows } from "./tools/scenario-runs.js";

const [treeOrderPath] = ENGINE_READING_GUARDS.mcpTreeOrder.paths.map(fromRepoRoot);
const [runOrderPath] = ENGINE_READING_GUARDS.mcpRecursiveRunOrder.paths.map(fromRepoRoot);

interface TreeOrderCase {
	name: string;
	rows: Array<{ id: string; kind: "folder" | "request"; order: number; createdAt: number }>;
	expected: string[];
}

interface RunOrderCase {
	name: string;
	rootId: string;
	collections: Array<{ id: string; parentId: string | null; order: number; createdAt: number }>;
	requests: Array<{ id: string; collectionId: string; order: number; createdAt: number }>;
	expected: string[];
}

const treeOrder = JSON.parse(readFileSync(treeOrderPath, "utf8")) as { cases: TreeOrderCase[] };
const runOrder = JSON.parse(readFileSync(runOrderPath, "utf8")) as { cases: RunOrderCase[] };

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

describe("recursive-run-order fixture through the scenario pre-flight walk", () => {
	test("scanned a non-empty fixture", () => {
		expect(runOrder.cases.length).toBeGreaterThanOrEqual(9);
		for (const c of runOrder.cases) expect(c.expected.length).toBeGreaterThan(0);
	});

	/**
	 * The client answers as the engine does - `GET /collections` whole,
	 * `GET /requests?collectionId=` per collection - but with each list reversed,
	 * so a walk that leaned on the engine's per-kind list order instead of
	 * merging would be caught here too.
	 */
	function fixtureClient(c: RunOrderCase) {
		return {
			listCollections: vi.fn().mockResolvedValue([...c.collections].reverse()),
			listRequests: vi
				.fn()
				.mockImplementation((id: string) =>
					Promise.resolve(c.requests.filter((r) => r.collectionId === id).reverse())
				),
		};
	}

	test.each(runOrder.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
		const steps = await scenarioStepRows(fixtureClient(c), c.rootId, true);
		expect(steps.map((step) => step.id)).toEqual(c.expected);
	});
});
