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
import { diffRunAgainstRequest, applyRunToRequest, excludedFromSave } from "./save-run-to-request";
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

describe("diffRunAgainstRequest", () => {
	it("lists only the fields that actually changed", () => {
		const live = liveRequest();
		const fields = diffRunAgainstRequest(seedFromRun(run(), live), live).map((d) => d.field);

		expect(fields).toContain("Method");
		expect(fields).toContain("URL");
		expect(fields).toContain("Headers");
		expect(fields).toContain("Body");
		expect(fields).toContain("Follow redirects");
		expect(fields).toContain("Max redirects");
	});

	it("says nothing about a field the run and the request agree on", () => {
		// Same everything: saving would be a no-op, and the dialog should say so
		// rather than listing seven rows of identical values.
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
		});

		expect(diffRunAgainstRequest(seedFromRun(run(), live), live)).toEqual([]);
	});

	it("reports the before and after of a change", () => {
		const live = liveRequest();
		const method = diffRunAgainstRequest(seedFromRun(run(), live), live).find(
			(d) => d.field === "Method"
		);

		expect(method).toBeDefined();
		expect(method!.from).toBe("GET");
		expect(method!.to).toBe("POST");
	});
});

describe("excludedFromSave", () => {
	it("names auth as unchanged, so the exclusion is visible rather than silent", () => {
		const live = liveRequest();
		const excluded = excludedFromSave(seedFromRun(run(), live));

		expect(excluded.map((e) => e.field)).toContain("Auth");
		// A reason, not just a label - the user should know why.
		expect(excluded.find((e) => e.field === "Auth")!.reason).toMatch(/credential/i);
	});

	it("also names scripts for a legacy run, so it writes visibly fewer fields", () => {
		const legacy = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				preRequestScript: "collectionPart\n\nrequestPart",
			},
		} as Partial<Run>);
		const live = liveRequest();

		const modern = excludedFromSave(seedFromRun(run(), live)).map((e) => e.field);
		const old = excludedFromSave(seedFromRun(legacy, live)).map((e) => e.field);

		expect(modern).not.toContain("Scripts");
		expect(old).toContain("Scripts");
		// The visible difference between an old run and a new one.
		expect(old.length).toBeGreaterThan(modern.length);
	});
});
