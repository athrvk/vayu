/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The batch layer (issue #666).
 *
 * The property every one of these holds down is the same: **a document the user
 * handed over produces a row**. The flow this replaced kept `files[0]` and said
 * nothing about the rest, so "unrecognised", "unreadable" and "already part of
 * another spec" all have to be visible answers - the only unacceptable answer is
 * no row at all.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applicableEntries,
	detectBatch,
	isImportableFileName,
	reparseBatch,
	type BatchIntake,
} from "./batch";

const OPTS = { importEnvironments: true, importScripts: true };

function fixture(...parts: string[]): string {
	return readFileSync(join(__dirname, "__fixtures__", ...parts), "utf8");
}

const postman = fixture("postman-v21.json");
const insomnia = fixture("insomnia-v4.json");
const environment = fixture("postman-environment.json");

/** No intake at all: nothing to fetch, nothing on disk. */
function intake(over: Partial<BatchIntake> = {}): BatchIntake {
	return {
		maxBytes: 5_000_000,
		fetchUrl: async () => {
			throw new Error("no network in this test");
		},
		...over,
	};
}

describe("detectBatch - every picked file gets a row", () => {
	it("parses each file independently, mixed formats and all", async () => {
		const entries = await detectBatch(
			[
				{ fileName: "a.json", relativePath: "a.json", text: postman },
				{ fileName: "b.json", relativePath: "b.json", text: insomnia },
				{ fileName: "c.json", relativePath: "c.json", text: environment },
			],
			OPTS,
			intake()
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.result?.meta.format)).toEqual([
			"Postman Collection v2.1",
			"Insomnia Export v4",
			"Postman Environment",
		]);
		expect(entries.every((e) => e.included)).toBe(true);
	});

	it("reports an unrecognised file as its own row and leaves the batch alone", async () => {
		const entries = await detectBatch(
			[
				{ fileName: "good.json", relativePath: "good.json", text: postman },
				{ fileName: "junk.json", relativePath: "junk.json", text: '{"x":1}' },
			],
			OPTS,
			intake()
		);

		expect(entries[1]?.error).toBe("Unrecognised format");
		// Errors are visible but never selected: an import the user did not ask for
		// is the other half of the honest-refusal rule.
		expect(entries[1]?.included).toBe(false);
		expect(entries[0]?.result).toBeTruthy();
		expect(applicableEntries(entries).map((e) => e.fileName)).toEqual(["good.json"]);
	});

	it("gives a file that could not be read a row carrying that reason", async () => {
		const entries = await detectBatch(
			[
				{ fileName: "gone.json", relativePath: "gone.json", text: "", readError: "Poof" },
				{ fileName: "good.json", relativePath: "good.json", text: postman },
			],
			OPTS,
			intake()
		);

		expect(entries[0]?.error).toBe("Poof");
		expect(entries[1]?.result).toBeTruthy();
	});

	it("keeps a file with nothing in it out of the apply, without calling it an error", async () => {
		const entries = await detectBatch(
			[{ fileName: "env.json", relativePath: "env.json", text: environment }],
			{ importEnvironments: false, importScripts: true },
			intake()
		);

		expect(entries[0]?.error).toBeNull();
		expect(applicableEntries(entries)).toEqual([]);
	});
});

/**
 * The rider the issue names: a folder pick supplies the sibling files, which is
 * exactly what the external-`$ref` bundler needs - so it must never go back to
 * disk for a document the user already handed over.
 */
describe("detectBatch - siblings come from the batch", () => {
	const multifile = [
		{
			fileName: "openapi.json",
			relativePath: "spec/openapi.json",
			text: fixture("openapi-v3-multifile", "spec", "openapi.json"),
		},
		{
			fileName: "pet.json",
			relativePath: "spec/schemas/pet.json",
			text: fixture("openapi-v3-multifile", "spec", "schemas", "pet.json"),
		},
		{
			fileName: "error.json",
			relativePath: "shared/error.json",
			text: fixture("openapi-v3-multifile", "shared", "error.json"),
		},
	];

	it("resolves both refs with no disk access at all", async () => {
		const readSibling = vi.fn(async () => {
			throw new Error("the batch should have answered this");
		});

		const entries = await detectBatch(multifile, OPTS, intake({ readSibling }));

		// The mutation check: drop the in-batch lookup and this call happens - or,
		// with no `readSibling` supplied at all, the refs land in the skip tally.
		expect(readSibling).not.toHaveBeenCalled();
		expect(entries[0]?.unresolvedRefs).toBe(0);
		expect(entries[0]?.raw).toContain("x-vayu-bundled");
	});

	it("resolves them even with no IPC available - the text never left the picker", async () => {
		const entries = await detectBatch(multifile, OPTS, intake());

		expect(entries[0]?.unresolvedRefs).toBe(0);
		expect(entries[0]?.result?.meta.skipped).toEqual([]);
	});

	it("lists a referenced file as part of the spec that named it, and never imports it twice", async () => {
		const entries = await detectBatch(multifile, OPTS, intake());

		expect(entries[1]?.bundledInto).toBe("openapi.json");
		expect(entries[2]?.bundledInto).toBe("openapi.json");
		// A bare schema map is not a spec: without the mark it would have been an
		// "Unrecognised format" row, which is a false accusation against a file
		// that imported perfectly - as part of the document that referenced it.
		expect(entries[1]?.error).toBeNull();
		expect(applicableEntries(entries).map((e) => e.fileName)).toEqual(["openapi.json"]);
	});

	it("still reports a ref to a file that is in neither the batch nor on disk", async () => {
		const entries = await detectBatch(
			[
				{
					fileName: "openapi.json",
					relativePath: "spec/openapi.json",
					text: multifile[0]!.text,
				},
			],
			OPTS,
			intake()
		);

		// Per ref, not per file: the document names `pet.json` twice and
		// `error.json` once, and each is an operation that imported short.
		expect(entries[0]?.unresolvedRefs).toBe(3);
		expect(entries[0]?.result?.meta.skipped).toContainEqual({
			kind: "external_ref",
			count: 3,
		});
	});
});

describe("reparseBatch", () => {
	it("re-applies the options to every entry from the text already bundled", async () => {
		const entries = await detectBatch(
			[
				{ fileName: "a.json", relativePath: "a.json", text: postman },
				{ fileName: "env.json", relativePath: "env.json", text: environment },
			],
			OPTS,
			intake()
		);

		const off = reparseBatch(entries, { importEnvironments: false, importScripts: true });

		expect(off[1]?.result?.environments).toEqual([]);
		expect(applicableEntries(off).map((e) => e.fileName)).toEqual(["a.json"]);
		// And back, because a toggle is not a re-detect.
		expect(applicableEntries(reparseBatch(off, OPTS)).map((e) => e.fileName)).toEqual([
			"a.json",
			"env.json",
		]);
	});

	it("keeps a file the user unchecked unchecked", async () => {
		const entries = await detectBatch(
			[{ fileName: "a.json", relativePath: "a.json", text: postman }],
			OPTS,
			intake()
		);
		const unchecked = entries.map((e) => ({ ...e, included: false }));

		expect(reparseBatch(unchecked, OPTS)[0]?.included).toBe(false);
	});

	it("restates the unresolved refs a re-parse cannot rediscover", async () => {
		const entries = await detectBatch(
			[
				{
					fileName: "openapi.json",
					relativePath: "spec/openapi.json",
					text: fixture("openapi-v3-multifile", "spec", "openapi.json"),
				},
			],
			OPTS,
			intake()
		);

		// The count belongs to the document, not to the parse: nothing in the
		// bundled text says a ref went unresolved, so a re-parse that did not
		// restate it would quietly un-report a loss the user was already told about.
		expect(reparseBatch(entries, OPTS)[0]?.result?.meta.skipped).toContainEqual({
			kind: "external_ref",
			count: 3,
		});
	});
});

describe("detectBatch - a document the engine could not store", () => {
	/**
	 * Issue #719: the refusal has to land here, on the entry, because that is what
	 * keeps it out of `applicableEntries` - and so out of `POST /import/apply`,
	 * where it used to arrive as a 400 that rolled back a transaction the user had
	 * already confirmed from a healthy-looking preview.
	 */
	it("refuses an over-cap spec as a row with no result, so nothing is applied", async () => {
		const oversized = fixture("openapi-v3.json").padEnd(4096);
		const entries = await detectBatch(
			[{ fileName: "big.json", relativePath: "big.json", text: oversized }],
			OPTS,
			intake({ maxBytes: 2048 })
		);

		expect(entries).toHaveLength(1);
		expect(entries[0].result).toBeNull();
		expect(entries[0].error).toMatch(/over the 2048.*maxSpecDocumentBytes/s);
		expect(applicableEntries(entries)).toEqual([]);
	});

	it("leaves a smaller spec in the same batch importable", async () => {
		const entries = await detectBatch(
			[
				{ fileName: "big.json", relativePath: "big.json", text: postman.padEnd(4096) },
				{ fileName: "ok.json", relativePath: "ok.json", text: fixture("openapi-v3.json") },
			],
			OPTS,
			intake({ maxBytes: 2048 })
		);

		// The Postman file is over the same number and imports anyway: the cap is
		// the spec-document cap, and a collection is not stored as one.
		expect(entries.map((e) => e.result?.meta.format)).toEqual([
			"Postman Collection v2.1",
			"OpenAPI 3.0",
		]);
	});
});

describe("isImportableFileName", () => {
	it("takes the spec extensions and nothing else", () => {
		expect(["a.json", "b.yaml", "c.yml", "D.JSON"].every(isImportableFileName)).toBe(true);
		expect(["logo.png", "README.md", "openapi", ".json.bak"].some(isImportableFileName)).toBe(
			false
		);
	});
});
