/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `POST /import/apply` names the item that broke, and this is the last hop of
 * that contract (issue #173): the name the user recognises, not the temp id the
 * engine speaks in.
 */

import { describe, it, expect } from "vitest";
import { ApiError } from "@/services/http-client";
import { importFailureMessage } from "./failure-message";
import type { ImportResult } from "./types";

function result(): ImportResult {
	return {
		collections: [
			{
				tempId: "c1",
				name: "Payments API",
				description: "",
				variables: {},
				auth: { mode: "none" },
				preRequestScript: "",
				postRequestScript: "",
				children: [
					{
						tempId: "c2",
						name: "Refunds",
						description: "",
						variables: {},
						auth: { mode: "none" },
						preRequestScript: "",
						postRequestScript: "",
						children: [],
						requests: [
							{
								tempId: "r9",
								name: "Create refund",
								description: "",
								method: "POST",
								url: "https://x/refunds",
								params: [],
								headers: [],
								body: { mode: "none" },
								auth: { mode: "inherit" },
								preRequestScript: "",
								postRequestScript: "",
							},
						],
					},
				],
				requests: [],
			},
		],
		environments: [{ tempId: "e1", name: "Staging", description: "", variables: {} }],
		globals: {},
		meta: {
			format: "postman-v21",
			requestCount: 1,
			folderCount: 2,
			environmentCount: 1,
			globalCount: 0,
			skipped: [],
			nonExecutableAuth: 0,
		},
	};
}

function importError(body: unknown): ApiError {
	return new ApiError(400, "bad_request", "Missing required field: method", body);
}

describe("importFailureMessage", () => {
	it("names the failing item by the name shown in the preview", () => {
		const error = importError({
			error: { code: "bad_request", message: "Missing required field: method", item: "r9" },
		});

		expect(importFailureMessage(error, result())).toBe(
			'Missing required field: method (item: "Create refund")'
		);
	});

	it("finds an item nested inside a child collection, and an environment", () => {
		const nested = importError({ error: { item: "c2" } });
		const environment = importError({ error: { item: "e1" } });

		expect(importFailureMessage(nested, result())).toContain('"Refunds"');
		expect(importFailureMessage(environment, result())).toContain('"Staging"');
	});

	// A pre-#173 engine put the temp id at the top level; the app and the sidecar
	// are not updated together, so that reading has to keep working.
	it("reads the legacy top-level item field", () => {
		const error = importError({ error: "Duplicate tempId 'c1'", item: "c1" });

		expect(importFailureMessage(error, result())).toContain('"Payments API"');
	});

	it("falls back to the temp id when the parsed result no longer has that item", () => {
		const error = importError({ error: { item: "r404" } });

		expect(importFailureMessage(error, result())).toBe(
			"Missing required field: method (item: r404)"
		);
	});

	it("leaves a whole-payload failure (no item) as the engine's message", () => {
		const error = new ApiError(400, "bad_request", "Body must be a JSON object", {
			error: { code: "bad_request", message: "Body must be a JSON object" },
		});

		expect(importFailureMessage(error, result())).toBe("Body must be a JSON object");
	});

	it("handles a plain Error and an empty message without inventing detail", () => {
		expect(importFailureMessage(new Error("Network error: failed"), result())).toBe(
			"Network error: failed"
		);
		expect(importFailureMessage(new Error(""), result())).toBe("Import failed");
		expect(importFailureMessage(undefined, null)).toBe("Import failed");
	});
});
