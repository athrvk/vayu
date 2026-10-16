import { describe, expect, it } from "vitest";
import { importToastMessage } from "./import-report";
import type { ImportReport } from "@/stores";

function report(overrides: Partial<ImportReport> = {}): ImportReport {
	return {
		title: "Pet Store",
		fileName: null,
		notices: [],
		fileNeeds: { folders: [], bodiesWithoutFile: 0 },
		counts: { requests: 60, folders: 4, environments: 0, globals: 0 },
		rootIds: ["col_1"],
		...overrides,
	};
}

describe("importToastMessage", () => {
	it("names the collection with the counts it arrived with", () => {
		expect(importToastMessage([report()])).toBe(
			'Imported "Pet Store" - 60 requests, 4 folders.'
		);
	});

	it("uses the singular and leaves out what the file did not carry", () => {
		const one = report({ counts: { requests: 1, folders: 0, environments: 0, globals: 0 } });
		expect(importToastMessage([one])).toBe('Imported "Pet Store" - 1 request.');
	});

	it("counts an environment-only file by what it holds", () => {
		const env = report({
			title: "Staging",
			counts: { requests: 0, folders: 0, environments: 1, globals: 0 },
			rootIds: [],
		});
		expect(importToastMessage([env])).toBe('Imported "Staging" - 1 environment.');
	});

	it("counts every action line and file need as one thing to finish", () => {
		const lossy = report({
			notices: [
				{ tier: "action", text: "a" },
				{ tier: "action", text: "b" },
				{ tier: "note", text: "c" },
			],
			fileNeeds: { folders: [{ folder: "/f", count: 1 }], bodiesWithoutFile: 2 },
		});
		expect(importToastMessage([lossy])).toBe(
			'Imported "Pet Store" - 60 requests, 4 folders; 4 things to finish.'
		);
	});

	it("sums the things to finish across a batch", () => {
		const lossy = report({ notices: [{ tier: "action", text: "a" }] });
		expect(importToastMessage([lossy, report(), report()])).toBe(
			"Imported 3 files; 1 thing to finish."
		);
	});

	it("joins what became of the active environment to the same sentence", () => {
		const lossy = report({ notices: [{ tier: "action", text: "a" }] });
		expect(importToastMessage([lossy], { kind: "activated", name: "Staging" })).toBe(
			'Imported "Pet Store" - 60 requests, 4 folders; 1 thing to finish; "Staging" is now the active environment.'
		);
	});

	it("is unchanged when the import touched no environment", () => {
		expect(importToastMessage([report()], undefined)).toBe(importToastMessage([report()]));
	});
});
