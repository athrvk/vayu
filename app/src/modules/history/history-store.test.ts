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
 * the engine and re-applied here, the client is applied here alone (#1817). The
 * outcome has both halves too (#3547): a row's stored verdict, or the one
 * `rowOutcome` derives for a row without one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Run } from "@/types";
import { filterRuns, mcpClientNames, useHistoryStore } from "./history-store";

function run(id: string, over: Partial<Run> = {}): Run {
	return { id, type: "design", status: "completed", startTime: 1, endTime: 2, ...over } as Run;
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
	filterOutcome: "all",
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

describe("the outcome filter's state", () => {
	it("starts at every outcome, round-trips one, and resetFilters clears it", () => {
		expect(useHistoryStore.getState().filterOutcome).toBe("all");
		useHistoryStore.getState().setFilterOutcome("not_judged");
		expect(useHistoryStore.getState().filterOutcome).toBe("not_judged");
		useHistoryStore.getState().resetFilters();
		expect(useHistoryStore.getState().filterOutcome).toBe("all");
	});
});

describe("filterRuns by outcome", () => {
	const load = (id: string, over: Partial<Run>, startTime: number) =>
		run(id, { type: "load", startTime, ...over } as Partial<Run>);

	const storedFailed = load("stored-failed", { outcome: "failed" }, 9);
	const storedPassed = load("stored-passed", { outcome: "passed" }, 8);
	const storedNotJudged = load("stored-not-judged", { outcome: "not_judged" }, 7);
	// Stored before the column: no outcome, so the summary is all there is.
	const derivedFailed = load(
		"derived-failed",
		{ resultSummary: { rps: 1, verdict: "failed" } },
		6
	);
	const derivedPassed = load(
		"derived-passed",
		{ resultSummary: { rps: 1, errorRate: 0, verdict: "passed" } },
		5
	);
	const judgedNothing = run("design", { startTime: 4 });
	const rows = [
		storedFailed,
		storedPassed,
		storedNotJudged,
		derivedFailed,
		derivedPassed,
		judgedNothing,
	];

	it("shows every run, judged or not, when the filter is all", () => {
		expect(filterRuns(rows, base)).toHaveLength(rows.length);
	});

	it("keeps the rows that wear the verdict, stored or derived", () => {
		expect(ids(filterRuns(rows, { ...base, filterOutcome: "failed" }))).toEqual([
			"stored-failed",
			"derived-failed",
		]);
		expect(ids(filterRuns(rows, { ...base, filterOutcome: "passed" }))).toEqual([
			"stored-passed",
			"derived-passed",
		]);
		expect(ids(filterRuns(rows, { ...base, filterOutcome: "not_judged" }))).toEqual([
			"stored-not-judged",
		]);
	});

	it("reads the stored outcome over a summary that says otherwise", () => {
		const disagreeing = load(
			"d",
			{ outcome: "passed", resultSummary: { verdict: "failed" } },
			1
		);
		expect(ids(filterRuns([disagreeing], { ...base, filterOutcome: "passed" }))).toEqual(["d"]);
		expect(filterRuns([disagreeing], { ...base, filterOutcome: "failed" })).toEqual([]);
	});

	it("matches no verdict for a row that has none", () => {
		for (const filterOutcome of ["failed", "not_judged", "passed"] as const) {
			expect(filterRuns([judgedNothing], { ...base, filterOutcome })).toEqual([]);
		}
	});
});
