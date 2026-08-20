/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Re-reading a bound document (issue #654).
 *
 * The three things that decide whether a comparison is even honest: it reads
 * from the origin the binding recorded, it bundles what comes back the same way
 * the import that stored it did, and it refuses - out loud - when there is no
 * origin to read from. A silent failure here reports a changed contract as
 * unchanged, which is the one answer this feature must never give.
 */

import { describe, it, expect, vi } from "vitest";
import { NoSpecSourceError, refetchSpec } from "./spec-refetch";

/**
 * Reading a document into a tree is the engine's (issue #877) - the renderer
 * holds no reader at all. Every document below is JSON; what a document's bytes
 * *are* is pinned engine-side by `import_parse_test.cpp`, and what this file is
 * about is which origin was read and what came back.
 */
vi.mock("@/services/api", () => ({
	apiService: { readDocument: async (text: string) => JSON.parse(text) },
}));

const ROOT = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Pets API" },
	paths: {
		"/pets": {
			get: {
				operationId: "listPets",
				responses: {
					"200": {
						description: "ok",
						content: {
							"application/json": { schema: { $ref: "./pet.yaml#/Pet" } },
						},
					},
				},
			},
		},
	},
});

const PET = JSON.stringify({ Pet: { type: "object", properties: { id: { type: "string" } } } });

const bytes = (text: string) => new TextEncoder().encode(text);

const io = (over: Partial<Parameters<typeof refetchSpec>[1]> = {}) => ({
	maxBytes: 10 * 1024 * 1024,
	fetchUrl: vi.fn(async () => ROOT),
	...over,
});

describe("refetchSpec", () => {
	it("re-fetches a URL-sourced document and bundles what it references", async () => {
		const fetchUrl = vi.fn(async (url: string) => (url.endsWith("pet.yaml") ? PET : ROOT));

		const result = await refetchSpec(
			{ sourceUrl: "https://api.example.com/openapi.json" },
			io({ fetchUrl })
		);

		expect(fetchUrl).toHaveBeenCalledWith("https://api.example.com/openapi.json");
		expect(fetchUrl).toHaveBeenCalledWith("https://api.example.com/pet.yaml");
		expect(result.unresolvedRefs).toBe(0);
		// Bundled, not verbatim: the stored document is the bundled one, so a
		// comparison against the raw fetch would report a change on every check.
		expect(result.text).toContain("x-vayu-bundled");
	});

	it("re-reads a file-sourced document through the same gate its siblings use", async () => {
		const readSpecFile = vi.fn(async (_specPath: string, refPath: string) => ({
			bytes: bytes(refPath.endsWith("pet.yaml") ? PET : ROOT),
		}));

		const result = await refetchSpec(
			{ file: { path: "/home/dev/api/openapi.json", fileName: "openapi.json" } },
			io({ readSpecFile })
		);

		// The document names itself as the file beside itself - one gated channel,
		// with the resolution still happening in the main process.
		expect(readSpecFile).toHaveBeenCalledWith("/home/dev/api/openapi.json", "openapi.json");
		// Normalized by the bundler before it reaches the channel - `./pet.yaml`
		// and `pet.yaml` are one target, fetched once.
		expect(readSpecFile).toHaveBeenCalledWith("/home/dev/api/openapi.json", "pet.yaml");
		expect(result.text).toContain("x-vayu-bundled");
	});

	it("prefers the URL when a document has both, because only the URL is portable", async () => {
		const fetchUrl = vi.fn(async () => ROOT);
		const readSpecFile = vi.fn(async () => ({ bytes: bytes(ROOT) }));

		await refetchSpec(
			{
				sourceUrl: "https://api.example.com/openapi.json",
				file: { path: "/home/dev/api/openapi.json", fileName: "openapi.json" },
			},
			io({ fetchUrl, readSpecFile })
		);

		expect(fetchUrl).toHaveBeenCalledWith("https://api.example.com/openapi.json");
		expect(readSpecFile).not.toHaveBeenCalled();
	});

	it("refuses with something to do about it when there is no origin at all", async () => {
		await expect(refetchSpec({ sourceUrl: null }, io())).rejects.toBeInstanceOf(
			NoSpecSourceError
		);
		await expect(refetchSpec({ sourceUrl: null }, io())).rejects.toThrow(/Bind it again/);
	});

	it("says a file cannot be re-read outside the desktop app rather than reporting no source", async () => {
		// The two cases need different words: one is "pick it again", the other is
		// "this build cannot open files", and a user in a browser given the first
		// would re-pick a file that still cannot be read.
		await expect(
			refetchSpec(
				{ file: { path: "/home/dev/api/openapi.json", fileName: "openapi.json" } },
				io()
			)
		).rejects.toThrow(/desktop app/);
	});

	it("lets the engine's own failure through", async () => {
		const fetchUrl = vi.fn(async () => {
			throw new Error("Fetch failed: 404 Not Found");
		});

		await expect(
			refetchSpec({ sourceUrl: "https://api.example.com/openapi.json" }, io({ fetchUrl }))
		).rejects.toThrow("Fetch failed: 404 Not Found");
	});

	it("counts a reference it could not follow instead of dropping it silently", async () => {
		const fetchUrl = vi.fn(async (url: string) => {
			if (url.endsWith("pet.yaml")) throw new Error("unreachable");
			return ROOT;
		});

		const result = await refetchSpec(
			{ sourceUrl: "https://api.example.com/openapi.json" },
			io({ fetchUrl })
		);

		expect(result.unresolvedRefs).toBe(1);
	});
});
