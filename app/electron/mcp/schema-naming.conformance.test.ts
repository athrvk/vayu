/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file schema-naming.conformance.test.ts
 * @brief The argument names every tool schema uses stay uniform (#2446).
 *
 * Two rules, over each tool's top-level `inputSchema` keys:
 *
 * - **No bare `id`.** An agent that has seen `requestId`, `runId` and
 *   `environmentId` reads a bare `id` as "the id of something else" and guesses.
 *   The id a tool takes is named for what it identifies.
 * - **A `limit` comes with an `offset`.** A page size with no way to read the
 *   next page silently truncates an answer.
 *
 * An exception is listed with its reason, and one that stops being true fails
 * too, so the lists cannot rot into a second place to forget.
 *
 * Mutation check: rename `entryId` back to `id` on a tool outside the list
 * below (or remove `restore_trash_entry` from it) and the bare-id case names
 * the tool; drop `offset` from `get_mock_activity` and the limit case names it.
 */

import { describe, expect, test } from "vitest";
import { TOOLS } from "./tools.js";

/**
 * The deprecated `id` aliases of #2446: the renamed tools still answer the
 * old argument so a client holding the old schema keeps working. #2962 retires
 * them and empties this list.
 */
const DEPRECATED_ID_ALIASES: ReadonlySet<string> = new Set([
	"restore_trash_entry",
	"purge_trash_entry",
	"move_item",
]);

/** Tools with a `limit` and no `offset`, each with why a page position has nothing to count from. */
const LIMIT_WITHOUT_OFFSET: Readonly<Record<string, string>> = {
	get_live_metrics:
		"answers the tail of a live ring buffer, newest ticks last: a position from the start moves as the run ticks, so `limit` bounds the snapshot and nothing pages it",
};

const inputKeys = (tool: (typeof TOOLS)[number]) => Object.keys(tool.inputSchema);

describe("tool argument names", () => {
	test("scans the registry, and some tools declare a limit", () => {
		expect(TOOLS.length).toBeGreaterThan(0);
		expect(TOOLS.filter((tool) => inputKeys(tool).includes("limit")).length).toBeGreaterThan(0);
	});

	test("no tool takes a bare `id` outside the deprecated aliases", () => {
		const bare = TOOLS.filter(
			(tool) => inputKeys(tool).includes("id") && !DEPRECATED_ID_ALIASES.has(tool.name)
		).map((tool) => tool.name);
		expect(bare).toEqual([]);
	});

	test("every deprecated alias is a tool that still takes `id`", () => {
		for (const name of DEPRECATED_ID_ALIASES) {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(inputKeys(tool!), name).toContain("id");
		}
	});

	test("a tool that takes a `limit` takes an `offset`, or is excepted with a reason", () => {
		const unpaged = TOOLS.filter(
			(tool) =>
				inputKeys(tool).includes("limit") &&
				!inputKeys(tool).includes("offset") &&
				!(tool.name in LIMIT_WITHOUT_OFFSET)
		).map((tool) => tool.name);
		expect(unpaged).toEqual([]);
	});

	test("every limit exception is a tool that still has a `limit` and no `offset`", () => {
		for (const name of Object.keys(LIMIT_WITHOUT_OFFSET)) {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(inputKeys(tool!), name).toContain("limit");
			expect(inputKeys(tool!), name).not.toContain("offset");
		}
	});
});
