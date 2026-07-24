/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Writing a run's values back onto its saved request.
 *
 * The two exclusions are the whole point of this module, and both are silent
 * failures if they go wrong:
 *
 *   auth     only the *mode* survives storage (`sanitize_config_snapshot`), so
 *            writing what the run recorded would replace real credentials with
 *            a bare mode and lock the user out of their own request.
 *   scripts  a run stored before script parts has one glued string with nothing
 *            marking where the collection's part ends, so writing it back would
 *            bury the collection's script inside the request permanently - and
 *            the next send would glue it on again and run it twice.
 *
 * Both are asserted here, and both are named to the user by
 * `excludedFromSave` rather than being quietly dropped.
 */

import { describe, it, expect } from "vitest";
import { buildChangeset, applyRunToRequest, diffSegments } from "./save-run-to-request";
import { seedFromRun } from "./design-run-seed";
import type { Run, Request } from "@/types";

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
				{ origin: "collection", id: "col_1", name: "API", script: "const t = 1;" },
				{ origin: "request", id: "req_1", script: "console.log(t);" },
			],
			postRequestScripts: [
				{ origin: "collection", id: "col_1", name: "API", script: "chainTest();" },
				{ origin: "request", id: "req_1", script: "pm.test('ok', () => {});" },
			],
			followRedirects: false,
			maxRedirects: 3,
			requestId: "req_1",
		},
		...overrides,
	} as Run;
}

/** A run whose stored request body the engine truncated (over maxTraceBodyBytes). */
function truncatedRun(): Run {
	return run({
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: {
				request: {
					method: "POST",
					url: "https://api.example.test/users?page=2",
					headers: { "X-Plain": "visible" },
					body: "SLICE",
					bodyTruncated: true,
					bodyBytes: 5_242_880,
				},
				response: { headers: {}, body: "{}" },
			},
		},
	});
}

/** The saved request as it reads today - deliberately different from the run. */
function liveRequest(overrides: Partial<Request> = {}): Request {
	return {
		id: "req_1",
		collectionId: "col_1",
		name: "Create user",
		description: "",
		method: "GET",
		url: "https://api.example.test/users",
		params: [],
		headers: [{ key: "X-Old", value: "stale", enabled: true }],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "bearer", token: "REAL-TOKEN-KEEP-ME" },
		preRequestScript: "old();",
		postRequestScript: "oldTest();",
		followRedirects: true,
		maxRedirects: 10,
		order: 0,
		createdAt: "",
		updatedAt: "",
		...overrides,
	} as Request;
}

describe("applyRunToRequest", () => {
	it("writes method, url, params, headers, body and the redirect settings", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		expect(patch.id).toBe("req_1");
		expect(patch.method).toBe("POST");
		expect(patch.url).toBe("https://api.example.test/users?page=2");
		expect(patch.params).toEqual([{ key: "page", value: "2", enabled: true }]);
		expect(patch.headers).toEqual([{ key: "X-Plain", value: "visible", enabled: true }]);
		expect(patch.body).toEqual({ mode: "json", content: '{"a":1}' });
		expect(patch.bodyType).toBe("json");
		expect(patch.followRedirects).toBe(false);
		expect(patch.maxRedirects).toBe(3);
	});

	it("writes the request's own script part, not the collection's", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		// `const t = 1;` came from the collection and must not end up inside the
		// request - the next send would run it twice.
		expect(patch.preRequestScript).toBe("console.log(t);");
		expect(patch.postRequestScript).toBe("pm.test('ok', () => {});");
	});

	it("never writes auth, even though the run recorded a mode", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		// Storage keeps only `{mode}`. Writing that would discard the token the
		// live request holds, which is the one thing that cannot be recovered.
		expect(patch).not.toHaveProperty("auth");
		expect(Object.keys(patch)).not.toContain("auth");
	});

	it("never writes a truncated request body back to the saved request", () => {
		// The lock: the engine caps a stored trace body at maxTraceBodyBytes, so a
		// truncated run holds only a slice. Writing that slice onto the saved
		// request would silently corrupt it, so the body must be left off the
		// patch entirely - the same treatment auth gets. Reverting the guard in
		// applyRunToRequest makes this fail.
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(truncatedRun(), live), live);

		expect(patch).not.toHaveProperty("body");
		expect(patch).not.toHaveProperty("bodyType");
		// The rest of the request still saves.
		expect(patch.method).toBe("POST");
		expect(patch.url).toBe("https://api.example.test/users?page=2");
	});

	it("writes the body normally when the run was not truncated", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		expect(patch.body).toEqual({ mode: "json", content: '{"a":1}' });
		expect(patch.bodyType).toBe("json");
	});

	it("omits scripts entirely for a run that has only the old glued string", () => {
		const legacy = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				preRequestScript: "collectionPart\n\nrequestPart",
				postRequestScript: "collectionTest\n\nrequestTest",
			},
		} as Partial<Run>);
		const live = liveRequest();

		const patch = applyRunToRequest(seedFromRun(legacy, live), live);

		// Nothing marks the boundary in the glued string, so the request's own
		// part cannot be recovered. Leave both fields alone rather than guess.
		expect(patch).not.toHaveProperty("preRequestScript");
		expect(patch).not.toHaveProperty("postRequestScript");
		// The rest still saves.
		expect(patch.method).toBe("POST");
	});
});

describe("diffSegments", () => {
	it("keeps the shared prefix and shows only the tail that changed", () => {
		expect(
			diffSegments(
				"https://api.example.test/users/{{id}}",
				"https://api.example.test/users/5"
			)
		).toEqual([
			{ text: "https://api.example.test/users/", kind: "same" },
			{ text: "{{id}}", kind: "del" },
			{ text: "5", kind: "add" },
		]);
	});

	it("keeps a shared prefix and suffix around a middle edit", () => {
		expect(diffSegments('pm.set("t", Date.now())', 'pm.set("t", 1)')).toEqual([
			{ text: 'pm.set("t", ', kind: "same" },
			{ text: "Date.now()", kind: "del" },
			{ text: "1", kind: "add" },
			{ text: ")", kind: "same" },
		]);
	});

	it("is a single same segment when nothing changed", () => {
		expect(diffSegments("abc", "abc")).toEqual([{ text: "abc", kind: "same" }]);
	});
});

describe("buildChangeset", () => {
	const fields = (seed: ReturnType<typeof seedFromRun>, live: Request) =>
		buildChangeset(seed, live).map((i) => i.field);

	it("lists every field the save touches, as one uniform list", () => {
		const live = liveRequest();
		const f = fields(seedFromRun(run(), live), live);

		expect(f).toContain("Method");
		expect(f).toContain("URL");
		expect(f).toContain("Headers");
		expect(f).toContain("Body");
		expect(f).toContain("Follow redirects");
		expect(f).toContain("Max redirects");
	});

	it("always includes Auth as a kept row - no separate unchanged section", () => {
		const live = liveRequest();
		const auth = buildChangeset(seedFromRun(run(), live), live).find((i) => i.field === "Auth");

		expect(auth).toBeDefined();
		expect(auth!.state).toBe("kept");
		// The reason travels with the row, not a demoted list.
		expect(auth!.note).toMatch(/credential|mode/i);
	});

	it("shows auth mode drift when the request's mode differs from the run's", () => {
		// run recorded bearer (fixture), request now uses none.
		const live = liveRequest({ auth: { mode: "none" } } as Partial<Request>);
		const auth = buildChangeset(seedFromRun(run(), live), live).find((i) => i.field === "Auth");

		expect(auth!.detail).toMatch(/differs/);
		expect(auth!.driftFrom).toBe("none");
		expect(auth!.driftTo).toBe("bearer");
	});

	it("collapses auth to the plain mode when it matches", () => {
		const live = liveRequest({ auth: { mode: "bearer", token: "x" } } as Partial<Request>);
		const auth = buildChangeset(seedFromRun(run(), live), live).find((i) => i.field === "Auth");

		expect(auth!.detail).toBe("kept");
		expect(auth!.value).toBe("bearer");
		expect(auth!.driftFrom).toBeUndefined();
	});

	it("does not treat an inherit request as auth drift", () => {
		// A request set to `inherit` is resolved to a concrete mode at send time,
		// so the run records that resolved result, never `inherit`. Comparing the
		// two is apples to oranges, so show `inherit` kept, with no drift - even
		// though the fixture run recorded `bearer`.
		const live = liveRequest({ auth: { mode: "inherit" } } as Partial<Request>);
		const auth = buildChangeset(seedFromRun(run(), live), live).find((i) => i.field === "Auth");

		expect(auth!.detail).toBe("kept");
		expect(auth!.value).toBe("inherit");
		expect(auth!.driftFrom).toBeUndefined();
	});

	it("makes scripts a changed row with a diff, for a modern run", () => {
		const live = liveRequest();
		const pre = buildChangeset(seedFromRun(run(), live), live).find(
			(i) => i.field === "Pre-request script"
		);

		expect(pre!.state).toBe("changed");
		expect(pre!.collapsible).toBe(true);
		expect(pre!.segments).toBeDefined();
	});

	it("makes scripts a single kept row for a legacy run", () => {
		const legacy = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				preRequestScript: "collectionPart\n\nrequestPart",
			},
		} as Partial<Run>);
		const live = liveRequest();
		const set = buildChangeset(seedFromRun(legacy, live), live);

		const scripts = set.find((i) => i.field === "Scripts");
		expect(scripts?.state).toBe("kept");
		// The per-field script rows do not appear for a legacy run.
		expect(set.map((i) => i.field)).not.toContain("Pre-request script");
	});

	it("diffs headers per entry, and never the app's own system headers", () => {
		const stale = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				headers: {
					"X-Plain": "visible",
					"X-Vayu-Version": "0.9.0",
					"X-Request-ID": "old-uuid",
				},
			},
		} as Partial<Run>);
		const live = liveRequest(); // headers: [X-Old: stale]

		const seed = seedFromRun(stale, live);
		const headers = buildChangeset(seed, live).find((i) => i.field === "Headers");

		const keys = (headers?.entries ?? []).map((e) => e.key);
		expect(keys).toContain("X-Plain");
		expect(keys).toContain("X-Old");
		expect(keys).not.toContain("X-Vayu-Version");
		expect(keys).not.toContain("X-Request-ID");

		const patch = applyRunToRequest(seed, live);
		const written = (patch.headers ?? []).map((h) => h.key.toLowerCase());
		expect(written).not.toContain("x-vayu-version");
		expect(written).not.toContain("x-request-id");
	});

	it("shows Body as a kept row with a reason when the run was truncated", () => {
		const live = liveRequest();
		const body = buildChangeset(seedFromRun(truncatedRun(), live), live).find(
			(i) => i.field === "Body"
		);

		expect(body).toBeDefined();
		expect(body!.state).toBe("kept");
		expect(body!.note).toMatch(/truncat|too large|incomplete/i);
	});

	it("shows only the kept rows when the request already matches the run", () => {
		// Everything equal, so nothing is writable; Auth (kept) is still shown.
		const live = liveRequest({
			method: "POST",
			url: "https://api.example.test/users?page=2",
			params: [{ key: "page", value: "2", enabled: true }],
			headers: [{ key: "X-Plain", value: "visible", enabled: true }],
			body: { mode: "json", content: '{"a":1}' },
			bodyType: "json",
			preRequestScript: "console.log(t);",
			postRequestScript: "pm.test('ok', () => {});",
			followRedirects: false,
			maxRedirects: 3,
			auth: { mode: "bearer", token: "x" },
		} as Partial<Request>);

		const set = buildChangeset(seedFromRun(run(), live), live);
		expect(set.every((i) => i.state === "kept")).toBe(true);
		expect(set.map((i) => i.field)).toEqual(["Auth"]);
	});
});
