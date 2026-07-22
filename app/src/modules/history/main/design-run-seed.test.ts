/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Starting values for a design run opened as a detached copy.
 *
 * Three sources, each for what only it has. `configSnapshot` is the payload
 * that was sent. `result.trace` is what went out after auth was applied. The
 * live request is the only place credentials exist, because
 * `sanitize_config_snapshot` strips them before saving.
 */

import { describe, it, expect } from "vitest";
import { seedFromRun } from "./design-run-seed";
import type { Run, Request } from "@/types";
import { DEFAULT_FOLLOW_REDIRECTS, DEFAULT_MAX_REDIRECTS } from "@/constants/request";

function run(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
		requestId: "req_1",
		environmentId: null,
		configSnapshot: {
			method: "POST",
			url: "https://api.example.test/users?page=2",
			headers: { "X-Plain": "visible" },
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "bearer" },
			preRequestScripts: [
				{
					origin: "collection",
					id: "col_1",
					name: "API",
					script: "const t = 1;",
				},
				{ origin: "request", id: "req_1", script: "console.log(t);" },
			],
			followRedirects: false,
			maxRedirects: 3,
			requestId: "req_1",
		},
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: {
				request: {
					method: "POST",
					url: "https://api.example.test/users?page=2",
					headers: { "X-Plain": "visible", Authorization: "Bearer SECRET" },
					body: '{"a":1}',
				},
				response: { headers: {}, body: "{}" },
			},
		},
		...overrides,
	} as Run;
}

const liveRequest = {
	id: "req_1",
	collectionId: "col_1",
	auth: { mode: "bearer", token: "FRESH-TOKEN" },
} as unknown as Request;

describe("seedFromRun", () => {
	it("takes method, url and the structured body from the snapshot", () => {
		const { request } = seedFromRun(run(), liveRequest);

		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://api.example.test/users?page=2");
		expect(request.bodyMode).toBe("json");
		expect(request.body).toBe('{"a":1}');
	});

	it("parses params out of the url", () => {
		const { request } = seedFromRun(run(), liveRequest);

		expect(request.params?.some((p) => p.key === "page" && p.value === "2")).toBe(true);
	});

	it("has no id, which is what stops anything being saved", () => {
		// useSaveManager stops early on a null entityId, and the response store
		// is keyed by id so nothing is written to it either.
		const { request } = seedFromRun(run(), liveRequest);

		expect(request.id).toBeNull();
		expect(request.collectionId).toBeNull();
	});

	it("keeps the redirect settings the run used", () => {
		const { request } = seedFromRun(run(), liveRequest);

		expect(request.followRedirects).toBe(false);
		expect(request.maxRedirects).toBe(3);
	});

	it("falls back to the app's own redirect defaults when the run predates those fields", () => {
		// A run recorded before followRedirects/maxRedirects were captured has
		// neither field in its snapshot. The fallback must match what
		// createDefaultRequestState() (and the engine) actually default to, not
		// a value re-derived here - referenced by name so this cannot drift from
		// the source of truth the same way the fallback itself once did.
		const legacy = run({
			configSnapshot: {
				method: "GET",
				url: "https://x.test/",
			},
		} as Partial<Run>);

		const { request } = seedFromRun(legacy, liveRequest);

		expect(request.followRedirects).toBe(DEFAULT_FOLLOW_REDIRECTS);
		expect(request.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS);
	});

	describe("when the request still exists", () => {
		it("takes headers from the snapshot, so no credential is in them", () => {
			const { request } = seedFromRun(run(), liveRequest);

			const keys = request.headers?.map((h) => h.key) ?? [];
			expect(keys).toContain("X-Plain");
			expect(keys).not.toContain("Authorization");
		});

		it("takes auth from the live request, the only place it exists", () => {
			const { request } = seedFromRun(run(), liveRequest);

			expect(request.authType).toBe("bearer");
			expect(request.authConfig?.token).toBe("FRESH-TOKEN");
		});
	});

	describe("when the request is gone", () => {
		it("takes headers from the trace, including the Authorization that went out", () => {
			const { request } = seedFromRun(run(), null);

			const auth = request.headers?.find((h) => h.key === "Authorization");
			expect(auth?.value).toBe("Bearer SECRET");
		});

		it("sets authType to none, because auth is already inside those headers", () => {
			const { request } = seedFromRun(run(), null);

			expect(request.authType).toBe("none");
		});
	});

	describe("scripts", () => {
		it("gives the script tab only the request's own part", () => {
			const { request } = seedFromRun(run(), liveRequest);

			expect(request.preRequestScript).toBe("console.log(t);");
		});

		it("returns the collection parts separately, to show read-only", () => {
			const { collectionPreScripts } = seedFromRun(run(), liveRequest);

			expect(collectionPreScripts).toEqual([
				{
					origin: "collection",
					id: "col_1",
					name: "API",
					script: "const t = 1;",
				},
			]);
		});

		it("keeps the pre and post collection parts apart", () => {
			// `ScriptPart` says where a part came from, not when it runs. Merged
			// into one list they cannot be told apart again - and replaying that
			// list as `preRequestScripts` would run the collection's assertions
			// before the request instead of after it.
			const both = run({
				configSnapshot: {
					method: "GET",
					url: "https://x.test/",
					preRequestScripts: [
						{ origin: "collection", id: "col_1", name: "API", script: "pre();" },
						{ origin: "request", id: "req_1", script: "ownPre();" },
					],
					postRequestScripts: [
						{ origin: "collection", id: "col_1", name: "API", script: "post();" },
						{ origin: "request", id: "req_1", script: "ownPost();" },
					],
				},
			} as Partial<Run>);

			const seed = seedFromRun(both, liveRequest);

			expect(seed.collectionPreScripts.map((p) => p.script)).toEqual(["pre();"]);
			expect(seed.collectionPostScripts.map((p) => p.script)).toEqual(["post();"]);
		});

		it("returns a run stored before script parts as a legacy string", () => {
			// Nothing marks the boundaries in the old glued string, so it cannot
			// be split. Show it whole, and let Save leave scripts alone.
			const legacy = run({
				configSnapshot: {
					method: "GET",
					url: "https://x.test/",
					preRequestScript: "collectionPart\n\nrequestPart",
				},
			} as Partial<Run>);

			const seed = seedFromRun(legacy, liveRequest);

			expect(seed.legacyPreScript).toBe("collectionPart\n\nrequestPart");
			expect(seed.collectionPreScripts).toEqual([]);
			expect(seed.collectionPostScripts).toEqual([]);
			expect(seed.request.preRequestScript).toBe("");
		});
	});
});
