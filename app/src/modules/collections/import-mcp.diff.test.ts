/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `existingMcpImports` (#3842): the comparison is a courtesy beside the import, so it answers
 * "nothing" on any failure, and tells a cancel (silent) from a failure (logged).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { existingMcpImports } from "./import-mcp";
import { apiService } from "@/services/api";
import { logError } from "@/errors/error-logger";
import type { ImportMcpDiffMatch, ImportMcpRequest } from "@/types";

vi.mock("@/errors/error-logger", () => ({ logError: vi.fn() }));

const REQUEST: ImportMcpRequest = { url: "https://mcp.example.com/mcp" };

const MATCH: ImportMcpDiffMatch = {
	collectionId: "col_1",
	name: "Acme tools",
	identical: true,
	added: [],
	removed: [],
	changed: [],
	renameCandidates: [],
};

beforeEach(() => {
	vi.restoreAllMocks();
	vi.mocked(logError).mockClear();
});

describe("existingMcpImports", () => {
	it("returns the matches the engine found, asking with the request and the signal", async () => {
		const diff = vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches: [MATCH] });
		const signal = new AbortController().signal;

		await expect(existingMcpImports(REQUEST, signal)).resolves.toEqual([MATCH]);

		expect(diff).toHaveBeenCalledWith(REQUEST, { signal });
	});

	it("answers none, and logs the failure, when the comparison fails", async () => {
		const failure = new Error("The server did not answer");
		vi.spyOn(apiService, "importMcpDiff").mockRejectedValue(failure);

		await expect(existingMcpImports(REQUEST, new AbortController().signal)).resolves.toEqual(
			[]
		);

		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError).toHaveBeenCalledWith(failure, "low", expect.any(Object));
	});

	it("answers none, and logs nothing, when the cancel is what ended it", async () => {
		const controller = new AbortController();
		vi.spyOn(apiService, "importMcpDiff").mockImplementation(async () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		});

		await expect(existingMcpImports(REQUEST, controller.signal)).resolves.toEqual([]);

		expect(logError).not.toHaveBeenCalled();
	});
});
