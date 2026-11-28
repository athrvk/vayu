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
		{ kind: "tool", key: "find", name: "find" },
	],
	changed: [
		{
			kind: "tool",
			key: "lookup",
			name: "lookup",
			requestId: "req_1",
			fields: ["inputSchema"],
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
		{ kind: "tool", key: "search", name: "search", requestId: "req_5" },
	],
	renameCandidates: [
		{
			kind: "tool",
			key: "find",
			name: "search",
			requestId: "req_5",
			fields: [],
			renamedFrom: "search",
		},
	],
};

const NONE: McpSelection = {
	added: new Set(),
	changed: new Set(),
	removed: new Set(),
	renamed: new Set(),
};

describe("defaultMcpSelection", () => {
	it("ticks every added and every changed row, and no removed one nor possible rename", () => {
		const selection = defaultMcpSelection(MATCH);

		expect([...selection.added]).toEqual([
			"tool:export",
			"resource:file:///a.txt",
			"tool:find",
		]);
		expect([...selection.changed]).toEqual(["req_1", "req_2"]);
		expect(selection.removed.size).toBe(0);
		expect(selection.renamed.size).toBe(0);
	});

	it("is empty for a match that does not differ", () => {
		const same = { ...MATCH, added: [], changed: [], removed: [] };

		expect(isEmptyMcpSelection(defaultMcpSelection(same))).toBe(true);
		expect(isEmptyMcpSelection(defaultMcpSelection(MATCH))).toBe(false);
	});

	it("counts a ticked rename, so Update existing is on when it is the only tick", () => {
		expect(isEmptyMcpSelection({ ...NONE, renamed: new Set(["req_5"]) })).toBe(false);
		expect(isEmptyMcpSelection(NONE)).toBe(true);
	});
});

describe("buildMcpSelect", () => {
	it("names the default ticks and deletes nothing", () => {
		expect(buildMcpSelect(MATCH, defaultMcpSelection(MATCH))).toEqual({
			added: [
				{ kind: "tool", key: "export" },
				{ kind: "resource", key: "file:///a.txt" },
				{ kind: "tool", key: "find" },
			],
			changed: ["req_1", "req_2"],
			removed: [],
			renamed: [],
		});
	});

	it("names exactly the rows ticked, in the diff's order", () => {
		const selection: McpSelection = {
			added: new Set(["resource:file:///a.txt"]),
			changed: new Set(["req_2"]),
			removed: new Set(["req_9", "req_8"]),
			renamed: new Set(),
		};

		expect(buildMcpSelect(MATCH, selection)).toEqual({
			added: [{ kind: "resource", key: "file:///a.txt" }],
			changed: ["req_2"],
			removed: ["req_8", "req_9"],
			renamed: [],
		});
	});

	it("sends a ticked candidate as a rename and neither of its halves, whatever else is ticked", () => {
		const selection: McpSelection = {
			...defaultMcpSelection(MATCH),
			removed: new Set(["req_5", "req_9"]),
			renamed: new Set(["req_5"]),
		};

		expect(buildMcpSelect(MATCH, selection)).toEqual({
			added: [
				{ kind: "tool", key: "export" },
				{ kind: "resource", key: "file:///a.txt" },
			],
			changed: ["req_1", "req_2"],
			removed: ["req_9"],
			renamed: [{ requestId: "req_5", key: "find" }],
		});
	});

	it("sends the added half and no rename for a candidate left unticked", () => {
		const selection: McpSelection = { ...NONE, added: new Set(["tool:find"]) };

		expect(buildMcpSelect(MATCH, selection)).toEqual({
			added: [{ kind: "tool", key: "find" }],
			changed: [],
			removed: [],
			renamed: [],
		});
	});

	it("restores the halves' own ticks when the rename is unticked again", () => {
		const ticked = withTicked(defaultMcpSelection(MATCH).renamed, "req_5", true);
		const selection = { ...defaultMcpSelection(MATCH), renamed: ticked };
		const unticked = { ...selection, renamed: withTicked(ticked, "req_5", false) };

		expect(buildMcpSelect(MATCH, selection).added).not.toContainEqual({
			kind: "tool",
			key: "find",
		});
		expect(buildMcpSelect(MATCH, unticked)).toEqual(
			buildMcpSelect(MATCH, defaultMcpSelection(MATCH))
		);
	});

	it("sends an empty list for a group with nothing ticked", () => {
		expect(buildMcpSelect(MATCH, NONE)).toEqual({
			added: [],
			changed: [],
			removed: [],
			renamed: [],
		});
	});

	it("leaves out a tick that is no row of this match", () => {
		const selection: McpSelection = {
			added: new Set(["tool:gone"]),
			changed: new Set(["req_404"]),
			removed: new Set(["req_1"]),
			renamed: new Set(["req_1"]),
		};

		// `req_1` is a changed row here, not a removed one or a candidate: ticking it as either must
		// not delete or rename it.
		expect(buildMcpSelect(MATCH, selection)).toEqual({
			added: [],
			changed: [],
			removed: [],
			renamed: [],
		});
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
