/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The ticks of an MCP re-import diff and the `select` they make (#3994): what starts ticked, and
 * that the body names exactly the rows ticked, in the diff's order.
 */

import { describe, it, expect } from "vitest";

import {
	addedRowId,
	buildMcpSelect,
	defaultMcpSelection,
	isEmptyMcpSelection,
	withTicked,
	type McpSelection,
} from "./mcp-reimport-selection";
import type { ImportMcpDiffMatch } from "@/types";

const MATCH: ImportMcpDiffMatch = {
	collectionId: "col_1",
	name: "Acme tools",
	identical: false,
	added: [
		{ kind: "tool", key: "export", name: "export" },
		{ kind: "resource", key: "file:///a.txt", name: "a.txt" },
	],
	changed: [
		{
			kind: "tool",
			key: "find",
			name: "search",
			requestId: "req_1",
			fields: [],
			renamedFrom: "search",
		},
		{
			kind: "prompt",
			key: "greet",
			name: "greet",
			requestId: "req_2",
			fields: ["description"],
		},
	],
	removed: [
		{ kind: "tool", key: "old", name: "old", requestId: "req_8" },
		{ kind: "resource", key: "file:///b.txt", name: "b.txt", requestId: "req_9" },
	],
};

describe("defaultMcpSelection", () => {
	it("ticks every added and every changed row, and no removed one", () => {
		const selection = defaultMcpSelection(MATCH);

		expect([...selection.added]).toEqual(["tool:export", "resource:file:///a.txt"]);
		expect([...selection.changed]).toEqual(["req_1", "req_2"]);
		expect(selection.removed.size).toBe(0);
	});

	it("is empty for a match that does not differ", () => {
		const same = { ...MATCH, added: [], changed: [], removed: [] };

		expect(isEmptyMcpSelection(defaultMcpSelection(same))).toBe(true);
		expect(isEmptyMcpSelection(defaultMcpSelection(MATCH))).toBe(false);
	});
});

describe("buildMcpSelect", () => {
	it("names the default ticks and deletes nothing", () => {
		expect(buildMcpSelect(MATCH, defaultMcpSelection(MATCH))).toEqual({
			added: [
				{ kind: "tool", key: "export" },
				{ kind: "resource", key: "file:///a.txt" },
			],
			changed: ["req_1", "req_2"],
			removed: [],
		});
	});

	it("names exactly the rows ticked, in the diff's order", () => {
		const selection: McpSelection = {
			added: new Set(["resource:file:///a.txt"]),
			changed: new Set(["req_2"]),
			removed: new Set(["req_9", "req_8"]),
		};

		expect(buildMcpSelect(MATCH, selection)).toEqual({
			added: [{ kind: "resource", key: "file:///a.txt" }],
			changed: ["req_2"],
			removed: ["req_8", "req_9"],
		});
	});

	it("sends an empty list for a group with nothing ticked", () => {
		const none: McpSelection = { added: new Set(), changed: new Set(), removed: new Set() };

		expect(buildMcpSelect(MATCH, none)).toEqual({ added: [], changed: [], removed: [] });
	});

	it("leaves out a tick that is no row of this match", () => {
		const selection: McpSelection = {
			added: new Set(["tool:gone"]),
			changed: new Set(["req_404"]),
			removed: new Set(["req_1"]),
		};

		// `req_1` is a changed row here, not a removed one: ticking it as removed must not delete it.
		expect(buildMcpSelect(MATCH, selection)).toEqual({ added: [], changed: [], removed: [] });
	});
});

describe("addedRowId and withTicked", () => {
	it("tells a tool from a resource of the same key", () => {
		expect(addedRowId({ kind: "tool", key: "x", name: "x" })).not.toBe(
			addedRowId({ kind: "prompt", key: "x", name: "x" })
		);
	});

	it("returns a new set and leaves the one it was given", () => {
		const before = new Set(["a"]);

		const on = withTicked(before, "b", true);
		const off = withTicked(on, "a", false);

		expect([...before]).toEqual(["a"]);
		expect([...on]).toEqual(["a", "b"]);
		expect([...off]).toEqual(["b"]);
	});
});
