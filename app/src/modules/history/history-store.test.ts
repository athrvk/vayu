/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The history filters' state (the store) and their sieve (`filterRuns`).
 *
 * The origin filter has the two halves `pinnedOnly` has: the kind is asked of
 * the engine and re-applied here, the client is applied here alone (#1817).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Run } from "@/types";
import { filterRuns, mcpClientNames, useHistoryStore } from "./history-store";

function run(id: string, over: Partial<Run> = {}): Run {
	return { id, type: "design", status: "completed", startTime: 1, endTime: 2, ...over };
}

const app = run("app", { origin: { kind: "app", client: null } });
const other = run("other", { origin: { kind: "other", client: null } });
const legacy = run("legacy");
const cursor = run("cursor", { origin: { kind: "mcp", client: "cursor-vscode" }, startTime: 5 });
const claude = run("claude", { origin: { kind: "mcp", client: "windsurf-client" }, startTime: 4 });
const claudeAgain = run("claude2", {
	origin: { kind: "mcp", client: "Windsurf" },
	startTime: 3,
});
const unnamed = run("unnamed", { origin: { kind: "mcp", client: null }, startTime: 2 });
const all = [app, other, legacy, cursor, claude, claudeAgain, unnamed];

const base = {
	filterType: "all",
	filterStatus: "all",
	pinnedOnly: false,
	filterOrigin: "all",
	filterClient: null,
	sortBy: "newest",
} as const;

const ids = (runs: Run[]) => runs.map((r) => r.id);

beforeEach(() => useHistoryStore.getState().resetFilters());

describe("the origin filter's state", () => {
	it("starts at every origin and every client", () => {
		const s = useHistoryStore.getState();
		expect(s.filterOrigin).toBe("all");
		expect(s.filterClient).toBeNull();
	});

	it("round-trips a kind and a client, and resetFilters clears both", () => {
		const s = useHistoryStore.getState();
		s.setFilterOrigin("mcp");
		s.setFilterClient("Cursor");
		expect(useHistoryStore.getState().filterOrigin).toBe("mcp");
		expect(useHistoryStore.getState().filterClient).toBe("Cursor");

		s.resetFilters();
		expect(useHistoryStore.getState().filterOrigin).toBe("all");
		expect(useHistoryStore.getState().filterClient).toBeNull();
	});

	it("drops the client when the kind changes, since it belonged to the old kind", () => {
		const s = useHistoryStore.getState();
		s.setFilterOrigin("mcp");
		s.setFilterClient("Cursor");
		s.setFilterOrigin("app");
		expect(useHistoryStore.getState().filterClient).toBeNull();
	});
});

describe("filterRuns by origin", () => {
	it("shows every run, origin or none, when the filter is all", () => {
		expect(filterRuns(all, base)).toHaveLength(all.length);
	});

	it("keeps only the kind asked for", () => {
		expect(ids(filterRuns(all, { ...base, filterOrigin: "mcp" }))).toEqual([
			"cursor",
			"claude",
			"claude2",
			"unnamed",
		]);
		expect(ids(filterRuns(all, { ...base, filterOrigin: "app" }))).toEqual(["app"]);
	});

	it("narrows agents to one client by display name, folding spellings of one product", () => {
		const claudeOnly = filterRuns(all, {
			...base,
			filterOrigin: "mcp",
			filterClient: "Windsurf",
		});
		expect(ids(claudeOnly)).toEqual(["claude", "claude2"]);

		const noName = filterRuns(all, {
			...base,
			filterOrigin: "mcp",
			filterClient: "MCP client",
		});
		expect(ids(noName)).toEqual(["unnamed"]);
	});
});

describe("mcpClientNames", () => {
	it("lists one sorted display name per client, from agent runs only", () => {
		expect(mcpClientNames(all, null)).toEqual(["Cursor", "MCP client", "Windsurf"]);
	});

	it("keeps a selected client listed after its runs left the loaded pages", () => {
		expect(mcpClientNames([app], "Cursor")).toEqual(["Cursor"]);
	});

	it("is empty when no agent ran anything", () => {
		expect(mcpClientNames([app, other, legacy], null)).toEqual([]);
	});
});
