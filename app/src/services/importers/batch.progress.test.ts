/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a batch says about itself while it runs (issue #882).
 *
 * A folder of 13 specs is 13 bundles and 13 engine round trips, and the dialog
 * showed the untouched dropzone for all of it. The counts here are the ones the
 * bar is drawn from, and each is a **real total** - the documents handed over,
 * and the subset of them that will actually be parsed. Nothing here reports a
 * count it invented.
 *
 * The other property, and the easier one to break: the waves stay parallel.
 * Serializing them to get a tidier counter would trade a folder import's wall
 * time for a nicer-looking number, so `parsing` is asserted to reach `total`
 * without the calls having been made one at a time.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectBatch, reparseBatch, type BatchIntake, type BatchProgress } from "./batch";

/** In flight at once, at its peak - the parallelism guard below reads it. */
const concurrency = { peak: 0, live: 0 };

vi.mock("@/services/api", async () => {
	const { ApiError } = await import("@/services/http-client");
	return {
		apiService: {
			readDocument: async (text: string) => JSON.parse(text),
			parseImport: async (payload: { content: string }) => {
				concurrency.live += 1;
				concurrency.peak = Math.max(concurrency.peak, concurrency.live);
				// A tick of real latency, so a serialized implementation cannot
				// finish all of them inside one microtask and pass by accident.
				await new Promise((r) => setTimeout(r, 5));
				concurrency.live -= 1;
				const document = JSON.parse(payload.content) as Record<string, unknown>;
				const info = document.info as { schema?: string } | undefined;
				if (!info?.schema?.includes("v2.1.0")) {
					throw new ApiError(400, "BAD_REQUEST", "Unrecognised format");
				}
				return {
					collections: [
						{
							name: "Imported",
							description: "",
							variables: {},
							auth: { mode: "none" as const },
							preRequestScript: "",
							postRequestScript: "",
							children: [],
							requests: [],
						},
					],
					environments: [],
					globals: {},
					meta: {
						format: "Postman Collection v2.1",
						requestCount: 0,
						folderCount: 0,
						environmentCount: 0,
						globalCount: 0,
						exampleCount: 0,
						skipped: [],
						nonExecutableAuth: 0,
						unattachedFileParts: 0,
					},
				};
			},
		},
	};
});

const OPTS = { importEnvironments: true, importScripts: true };
const postman = readFileSync(join(__dirname, "__fixtures__", "postman-v21.json"), "utf8");

function intake(): BatchIntake {
	return {
		maxBytes: 5_000_000,
		fetchUrl: async () => {
			throw new Error("no network in this test");
		},
	};
}

/** `n` picked files, all the same valid document. */
function documents(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		fileName: `spec-${i}.json`,
		relativePath: `spec-${i}.json`,
		text: postman,
	}));
}

/** Ticks of one stage, in the order they were reported. */
function ticksOf(seen: BatchProgress[], stage: BatchProgress["stage"]) {
	return seen.filter((p) => p.stage === stage);
}

describe("detectBatch progress", () => {
	it("counts every picked document through the bundling stage", async () => {
		const seen: BatchProgress[] = [];

		await detectBatch(documents(4), OPTS, intake(), (p) => seen.push(p));

		const bundling = ticksOf(seen, "bundling");
		// Opens at zero, so the bar exists before the first file finishes -
		// otherwise a slow first document leaves the dialog blank exactly when it
		// most needs to say something.
		expect(bundling[0]).toEqual({ stage: "bundling", done: 0, total: 4 });
		expect(bundling[bundling.length - 1]).toEqual({ stage: "bundling", done: 4, total: 4 });
		expect(bundling.map((p) => p.done)).toEqual([0, 1, 2, 3, 4]);
	});

	it("counts the documents it will actually parse, not the ones picked", async () => {
		const seen: BatchProgress[] = [];
		// One of the three cannot be read, so it is never parsed. Counting it
		// would leave the bar stuck one short of its own total, for good.
		await detectBatch(
			[
				...documents(2),
				{
					fileName: "gone.json",
					relativePath: "gone.json",
					text: "",
					readError: "Could not read file",
				},
			],
			OPTS,
			intake(),
			(p) => seen.push(p)
		);

		const parsing = ticksOf(seen, "parsing");
		expect(parsing[0].total).toBe(2);
		expect(parsing[parsing.length - 1]).toEqual({ stage: "parsing", done: 2, total: 2 });
	});

	it("bundles and parses before it counts, not one file at a time", async () => {
		concurrency.peak = 0;
		concurrency.live = 0;

		await detectBatch(documents(5), OPTS, intake(), () => {});

		// The counter is a report on the wave, not a queue that runs it.
		expect(concurrency.peak).toBeGreaterThan(1);
	});

	it("says nothing when the caller wants nothing", async () => {
		// No callback is the URL and Paste tabs' case, and the whole batch layer
		// has to work without one.
		const entries = await detectBatch(documents(2), OPTS, intake());
		expect(entries).toHaveLength(2);
	});
});

describe("reparseBatch progress", () => {
	it("counts the entries a toggle re-parses", async () => {
		const entries = await detectBatch(documents(3), OPTS, intake());
		const seen: BatchProgress[] = [];

		await reparseBatch(entries, OPTS, (p) => seen.push(p));

		// An option toggle re-parses every file - three more engine round trips -
		// so it is the same wait as the first parse and gets the same counter.
		const parsing = ticksOf(seen, "parsing");
		expect(parsing[0]).toEqual({ stage: "parsing", done: 0, total: 3 });
		expect(parsing[parsing.length - 1]).toEqual({ stage: "parsing", done: 3, total: 3 });
	});
});
