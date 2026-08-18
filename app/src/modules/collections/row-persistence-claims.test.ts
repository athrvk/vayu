/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Its rows are never saved anywhere" was true of the file and the contract and
 * false of every cell that reached a request (issue #731): a collection run
 * stores each step's exchange - URL, headers as sent, both bodies - and the
 * `Authorization` header among them is built out of the row's own values.
 *
 * Four surfaces made the absolute claim, in three vocabularies, and a reader
 * only had to believe one of them. This is the guard against any of them coming
 * back - the precedent `config_route_test.cpp` set for a replaced label
 * substring. It scans text, so it cannot check that what replaced each claim is
 * *true*; the rendered disclosure is pinned by `StoredExchangeWarning.test.tsx`
 * and `ScenarioRunView.test.tsx`, and the prose still needs a human.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Every surface that told a user what happens to their data rows. */
const SURFACES = {
	"docs/app/data-driven-runs.md": join(repoRoot, "docs", "app", "data-driven-runs.md"),
	"docs/app/COMPONENTS.md": join(repoRoot, "docs", "app", "COMPONENTS.md"),
	"DataTab.tsx": join(
		repoRoot,
		"app",
		"src",
		"modules",
		"collections",
		"CollectionDetail",
		"DataTab.tsx"
	),
	"DataFilePicker.tsx": join(
		repoRoot,
		"app",
		"src",
		"modules",
		"collections",
		"DataFilePicker.tsx"
	),
	"electron/mcp/tools.ts": join(repoRoot, "app", "electron", "mcp", "tools.ts"),
} as const;

/**
 * The exact wordings that were wrong, each with the surface it was on. Written
 * out rather than matched by a loose pattern: "the row set is never persisted"
 * is the corrected claim and has to keep passing.
 */
const RETIRED: ReadonlyArray<{ claim: RegExp; where: keyof typeof SURFACES }> = [
	{ claim: /rows are never saved anywhere/i, where: "DataTab.tsx" },
	{ claim: /rows stay on this machine and are never saved/i, where: "DataFilePicker.tsx" },
	{ claim: /Rows are never persisted/i, where: "electron/mcp/tools.ts" },
	{ claim: /Rows are never persisted on either side/i, where: "docs/app/data-driven-runs.md" },
	{ claim: /## Nothing is stored/, where: "docs/app/data-driven-runs.md" },
	{ claim: /nothing persists them, here or engine-side/i, where: "docs/app/COMPONENTS.md" },
];

const text = new Map<string, string>(
	Object.entries(SURFACES).map(([name, path]) => [name, readFileSync(path, "utf8")])
);

/**
 * The same surfaces with whitespace collapsed, which is how a claim is read:
 * every one of these lives in wrapped prose - JSX that prettier re-wraps, a
 * template literal, a Markdown paragraph - so a line-sensitive pattern would
 * stop matching on a reflow that changed no words, and this guard would go
 * quiet without anyone touching a claim.
 */
const flowed = new Map<string, string>(
	[...text].map(([name, body]) => [name, body.replace(/\s+/g, " ")])
);

describe("what the app claims about data rows", () => {
	it("scanned every surface, and none of them was empty", () => {
		// A scan of an unread file passes for weeks. Every claim below is only
		// as good as this assertion.
		expect(text.size).toBe(Object.keys(SURFACES).length);
		for (const [name, body] of text) {
			expect(body.length, name).toBeGreaterThan(500);
		}
	});

	it("no surface says a run's rows are never stored", () => {
		const found = RETIRED.filter(({ claim, where }) => claim.test(flowed.get(where)!)).map(
			({ claim, where }) => `${where}: ${claim}`
		);
		expect(found).toEqual([]);
	});

	it("the docs page says where a bound cell does live", () => {
		const doc = flowed.get("docs/app/data-driven-runs.md")!;
		expect(doc).toMatch(/## What is stored/);
		// The two halves of the honest claim: the set is not kept, the bound
		// value is - and the retention setting that expires it.
		expect(doc).toMatch(/binds into a request is stored with that request/i);
		expect(doc).toMatch(/maxRunsRetained/);
	});

	it("the Data tab banner says the same thing the docs page does", () => {
		const banner = flowed.get("DataTab.tsx")!;
		expect(banner).toMatch(/never a cell of it/i);
		expect(banner).toMatch(/a run stores it in the step it was sent with/i);
	});
});
