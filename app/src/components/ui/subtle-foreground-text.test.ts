/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `text-subtle-foreground` is reserved for units, dash placeholders and
 * decorative icons (#2302, `docs/design-system.md` "Foreground Scale").
 *
 * The tier measures 2.69:1 light and 2.89:1 dark, deliberately below AA, so a
 * label, an axis tick or a group heading on it is unreadable by construction.
 * Which of a file's uses is a unit and which is a label is the component's
 * knowledge, not a regex's - so the guard is a ledger: every file allowed to
 * use the class is named here with how many uses it is allowed. A new use, or a
 * file not listed, fails and has to be argued for in this list, which is the
 * moment someone asks whether the text is a unit or something the user reads.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CLASS = /text-subtle-foreground/g;

/** Source-relative path (forward slashes) to the number of permitted uses. */
const ALLOWED: Record<string, number> = {
	// Unit suffixes after a number, and "-" placeholders for a missing figure.
	"modules/dashboard/components/charts/PhasePercentiles.tsx": 1,
	"modules/dashboard/components/charts/TimingWaterfall.tsx": 3,
	"modules/dashboard/components/stats/ModeStatsRow.tsx": 1,
	"modules/history/main/components/PhaseAveragesCard.tsx": 1,
	"modules/request-builder/components/ResponseViewer/ResponseTimingTab.tsx": 2,
	"components/shared/response-viewer/TimingPhaseTiles.tsx": 1,
	// Decorative icons.
	"components/shared/AuthFields/AuthFields.tsx": 1,
	"components/shared/KeyValueEditor/KeyValueRow.tsx": 2,
	"components/shared/TimeValue/TimeMarker.tsx": 1,
};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
	});
}

function usesIn(file: string): number {
	return stripComments(readFileSync(file, "utf8")).match(CLASS)?.length ?? 0;
}

const files = walk(srcRoot);
const found = new Map(
	files
		.map((f) => [relative(srcRoot, f).split(sep).join("/"), usesIn(f)] as const)
		.filter(([, count]) => count > 0)
);

describe("text-subtle-foreground stays on units, dashes and decorative icons", () => {
	it("scanned a non-empty tree and found the allowlisted uses", () => {
		// A guard that reads nothing passes forever.
		expect(files.length).toBeGreaterThan(100);
		const allowedTotal = Object.values(ALLOWED).reduce((a, b) => a + b, 0);
		const foundTotal = [...found.values()].reduce((a, b) => a + b, 0);
		expect(foundTotal).toBeGreaterThanOrEqual(allowedTotal);
	});

	it("no file outside the ledger uses it", () => {
		const unlisted = [...found.keys()].filter((f) => !(f in ALLOWED));
		expect(unlisted).toEqual([]);
	});

	it("no listed file uses it more often than permitted", () => {
		const over = Object.entries(ALLOWED)
			.filter(([f, max]) => (found.get(f) ?? 0) > max)
			.map(([f, max]) => `${f}: ${found.get(f)} > ${max}`);
		expect(over).toEqual([]);
	});

	it("every ledger entry still uses it, so the list cannot go stale", () => {
		const stale = Object.keys(ALLOWED).filter((f) => !found.has(f));
		expect(stale).toEqual([]);
	});
});
