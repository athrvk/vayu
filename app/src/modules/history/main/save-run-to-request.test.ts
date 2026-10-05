/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Writing a run's values back onto its saved request.
 *
 * The exclusions are the whole point of this module, and each is a silent
 * failure if it goes wrong:
 *
 *   auth      only the *mode* survives storage (`sanitize_config_snapshot`), so
 *             writing what the run recorded would replace real credentials with
 *             a bare mode and lock the user out of their own request.
 *   withheld  a credential header's value, and a secret variable's value in the
 *             url, params or body, are stored as `<redacted>` (#1803); writing
 *             that back would overwrite a good value with the placeholder.
 *   scripts   a run stored before script parts has one glued string with nothing
 *             marking where the collection's part ends, so writing it back would
 *             bury the collection's script inside the request permanently - and
 *             the next send would glue it on again and run it twice.
 *
 * Each is asserted here, and each is named to the user as a `kept` row by
 * `buildChangeset` rather than being quietly dropped.
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
			verifySSL: true,
			httpVersion: "http2",
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
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
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

	it("writes httpVersion, following the same `?? live.x` idiom as the redirect settings", () => {
		const live = liveRequest(); // httpVersion: "auto"
		const patch = applyRunToRequest(seedFromRun(run(), live), live); // run recorded "http2"

		expect(patch.httpVersion).toBe("http2");
	});

	it("writes the protocol switches the run used, and lists each as a change (#1765)", () => {
		const live = liveRequest({
			disableCookies: false,
			disabledSystemHeaders: [],
			disableUrlEncoding: false,
		});
		const recorded = run();
		Object.assign(recorded.configSnapshot as Record<string, unknown>, {
			disableCookies: true,
			disabledSystemHeaders: ["user-agent"],
			disableUrlEncoding: true,
		});
		const seed = seedFromRun(recorded, live);

		const patch = applyRunToRequest(seed, live);
		expect(patch.disableCookies).toBe(true);
		expect(patch.disabledSystemHeaders).toEqual(["user-agent"]);
		expect(patch.disableUrlEncoding).toBe(true);

		// The dialog names what a save would change, so a write it does not
		// list is a write the user never agreed to.
		const fields = buildChangeset(seed, live).map((item) => item.field);
		expect(fields).toEqual(
			expect.arrayContaining([
				"Disable cookie jar",
				"Automatic headers left out",
				"Send URL without encoding",
			])
		);
	});

	it("writes the request's own elements, not the collection's", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		// `const t = 1;` / `chainTest();` came from the collection and must not
		// end up inside the request - the next send would run it twice.
		expect(patch.elements).toEqual([
			{
				id: "seed-script-pre",
				kind: "script.pre",
				enabled: true,
				config: { script: "console.log(t);" },
			},
			{
				id: "seed-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', () => {});" },
			},
		]);
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

	describe("a value the engine withheld from the snapshot (#1803)", () => {
		const withheldRun = (snapshot: Record<string, unknown>) =>
			run({ configSnapshot: { ...run().configSnapshot, ...snapshot } } as Partial<Run>);
		const changeset = (r: Run, live: Request) => buildChangeset(seedFromRun(r, live), live);

		it("never writes a withheld header, and keeps the request's own", () => {
			const live = liveRequest({
				headers: [
					{ key: "Authorization", value: "Bearer {{token}}", enabled: true },
					{ key: "X-Old", value: "stale", enabled: true },
				],
			});
			const r = withheldRun({
				headers: { "X-Plain": "visible", Authorization: "<redacted>" },
			});

			const patch = applyRunToRequest(seedFromRun(r, live), live);

			expect(patch.headers).toEqual([
				{ key: "X-Plain", value: "visible", enabled: true },
				{ key: "Authorization", value: "Bearer {{token}}", enabled: true },
			]);
			expect(JSON.stringify(patch)).not.toContain("<redacted>");
		});

		it("does not list the kept header as a change, and names it as kept", () => {
			const live = liveRequest({
				headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }],
			});
			const set = changeset(withheldRun({ headers: { Authorization: "<redacted>" } }), live);

			expect(set.find((i) => i.field === "Headers")).toBeUndefined();
			const kept = set.find((i) => i.field === "Withheld headers");
			expect(kept).toMatchObject({ state: "kept", value: "Authorization" });
			expect(kept!.note).toMatch(/withhold/i);
		});

		it("leaves a withheld url and its params off the patch, with kept rows saying why", () => {
			const live = liveRequest({
				url: "https://api.example.test/users?key={{apiKey}}",
				params: [{ key: "key", value: "{{apiKey}}", enabled: true }],
			});
			const r = withheldRun({ url: "https://api.example.test/users?key=<redacted>" });
			const seed = seedFromRun(r, live);

			const patch = applyRunToRequest(seed, live);
			expect(patch).not.toHaveProperty("url");
			expect(patch).not.toHaveProperty("params");
			expect(patch.method).toBe("POST");

			const set = buildChangeset(seed, live);
			for (const field of ["URL", "Params"]) {
				const row = set.find((i) => i.field === field);
				expect(row?.state).toBe("kept");
				expect(row?.note).toMatch(/withheld/i);
			}
			expect(set.find((i) => i.field === "URL")!.value).toBe(live.url);
		});

		it("leaves only the params off when a path row, not the url, held the marker", () => {
			const live = liveRequest({
				url: "https://api.example.test/users/:id",
				params: [{ key: "id", value: "{{userId}}", enabled: true, in: "path" }],
			});
			const r = withheldRun({
				url: "https://api.example.test/users/:id",
				params: [{ key: "id", value: "<redacted>", enabled: true, in: "path" }],
			});

			const patch = applyRunToRequest(seedFromRun(r, live), live);

			expect(patch.url).toBe("https://api.example.test/users/:id");
			expect(patch).not.toHaveProperty("params");
		});

		it("leaves a withheld body off the patch, as a truncated one is", () => {
			const live = liveRequest({ body: { mode: "json", content: '{"k":"{{secret}}"}' } });
			const r = withheldRun({ body: { mode: "json", content: '{"k":"<redacted>"}' } });
			const seed = seedFromRun(r, live);

			const patch = applyRunToRequest(seed, live);
			expect(patch).not.toHaveProperty("body");
			expect(patch).not.toHaveProperty("bodyType");

			const body = buildChangeset(seed, live).find((i) => i.field === "Body");
			expect(body?.state).toBe("kept");
			expect(body?.note).toMatch(/withheld/i);
		});

		it("leaves form fields off the patch when one holds the marker", () => {
			const live = liveRequest();
			const r = withheldRun({
				body: {
					mode: "x-www-form-urlencoded",
					fields: [{ key: "pw", value: "<redacted>", enabled: true }],
				},
			});

			expect(applyRunToRequest(seedFromRun(r, live), live)).not.toHaveProperty("body");
		});

		it("writes everything normally when nothing was withheld", () => {
			const live = liveRequest();
			const patch = applyRunToRequest(seedFromRun(run(), live), live);

			expect(patch.url).toBe("https://api.example.test/users?page=2");
			expect(patch.params).toEqual([{ key: "page", value: "2", enabled: true }]);
			expect(patch.body).toEqual({ mode: "json", content: '{"a":1}' });
			expect(
				buildChangeset(seedFromRun(run(), live), live).map((i) => i.field)
			).not.toContain("Withheld headers");
		});
	});

	it("writes the body normally when the run was not truncated", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(seedFromRun(run(), live), live);

		expect(patch.body).toEqual({ mode: "json", content: '{"a":1}' });
		expect(patch.bodyType).toBe("json");
	});

	it("round-trips a jsonrpc body, the mode the widened cast added", () => {
		// `bodyFromSeed` widened a cast to admit `jsonrpc` and no test ever ran
		// one through, so the mode was covered by `pnpm type-check` alone - and
		// a cast proves only that the compiler agrees, never that the value
		// arrives. This is the runtime half: give `bodyFromSeed` a mode
		// whitelist that forgets `jsonrpc`, or stop the seed carrying the mode,
		// and the body falls back to `{mode:"none"}` here.
		const live = liveRequest();
		const jsonrpcRun = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/rpc",
				body: {
					mode: "jsonrpc",
					content: '{"jsonrpc":"2.0","method":"getUser","params":[1],"id":1}',
				},
			},
		} as Partial<Run>);

		const patch = applyRunToRequest(seedFromRun(jsonrpcRun, live), live);

		expect(patch.body).toEqual({
			mode: "jsonrpc",
			content: '{"jsonrpc":"2.0","method":"getUser","params":[1],"id":1}',
		});
		expect(patch.bodyType).toBe("jsonrpc");
	});

	it("omits elements entirely for a run that has only the old glued string", () => {
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
		// part cannot be recovered. Leave the field alone rather than guess.
		expect(patch).not.toHaveProperty("elements");
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
		expect(f).toContain("Protocol");
	});

	it("keys a path row as `:name`, apart from a same-named query row (#1764)", () => {
		// The run sent `?id=7` against a request whose `:id` path row held 42.
		const live = liveRequest({
			url: "https://api.example.test/users/:id",
			params: [{ key: "id", value: "42", enabled: true, in: "path" }],
		});
		const snapshot = { ...run().configSnapshot, url: "https://api.example.test/users?id=7" };
		const params = buildChangeset(
			seedFromRun(run({ configSnapshot: snapshot } as Partial<Run>), live),
			live
		).find((i) => i.field === "Params");

		expect(params!.entries).toEqual([
			{ key: "id", kind: "added", value: "7" },
			{ key: ":id", kind: "removed", value: "42" },
		]);
	});

	it("keeps a path value the run left pending rather than blanking the row (#1764)", () => {
		const live = liveRequest({
			url: "https://api.example.test/users/:id",
			params: [{ key: "id", value: "{{fromScript}}", enabled: true, in: "path" }],
		});
		const snapshot = {
			...run().configSnapshot,
			url: "https://api.example.test/users/:id",
			params: [{ key: "id", value: "{{fromScript}}", enabled: true, in: "path" }],
		};
		const seed = seedFromRun(run({ configSnapshot: snapshot } as Partial<Run>), live);

		expect(applyRunToRequest(seed, live).params).toEqual([
			{ key: "id", value: "{{fromScript}}", enabled: true, in: "path" },
		]);
		expect(buildChangeset(seed, live).find((i) => i.field === "Params")).toBeUndefined();
	});

	it("shows a Protocol diff row when the run's requested protocol differs from the request's", () => {
		// live: "auto" (fixture default); run recorded "http2".
		const live = liveRequest();
		const protocol = buildChangeset(seedFromRun(run(), live), live).find(
			(i) => i.field === "Protocol"
		);

		expect(protocol).toBeDefined();
		expect(protocol!.state).toBe("changed");
		expect(protocol!.segments).toEqual([
			{ text: "auto", kind: "del" },
			{ text: "http2", kind: "add" },
		]);
	});

	it("omits the Protocol row when the request already uses the run's protocol", () => {
		const live = liveRequest({ httpVersion: "http2" } as Partial<Request>);
		const f = fields(seedFromRun(run(), live), live);

		expect(f).not.toContain("Protocol");
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

	it("makes elements a changed row when the run's elements differ from the request's", () => {
		// `describeElements` summarises an elements list by kind/name, not by
		// script content - so a change is visible when the composition differs,
		// here an empty live list versus the run's two script elements.
		const live = liveRequest({ elements: [] } as Partial<Request>);
		const row = buildChangeset(seedFromRun(run(), live), live).find(
			(i) => i.field === "Elements"
		);

		expect(row).toBeDefined();
		expect(row!.state).toBe("changed");
		expect(row!.segments).toBeDefined();
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
		// The per-field elements row does not appear for a legacy run.
		expect(set.map((i) => i.field)).not.toContain("Elements");
	});

	/*
	 * A run traced before issue #1229 carries the rows the renderer injected -
	 * the engine adds its defaults at send time now and stores nothing, but the
	 * trace is a record of what went out then, and writing those back would pin
	 * a stale version and one frozen correlation id onto the request.
	 *
	 * The rule is `isLegacyManagedHeader`'s, so it is narrow: a browser
	 * `User-Agent` and a hand-typed `X-Request-ID` are the user's headers and
	 * are saved. Broaden `userEntries` back to a key list and the second half
	 * fails.
	 */
	it("diffs headers per entry, and never the rows a pre-#1229 client injected", () => {
		const stale = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				headers: {
					"X-Plain": "visible",
					"X-Vayu-Version": "0.9.0",
					"X-Request-ID": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
					"User-Agent": "Vayu/0.9.0",
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
		expect(keys).not.toContain("User-Agent");

		const patch = applyRunToRequest(seed, live);
		const written = (patch.headers ?? []).map((h) => h.key.toLowerCase());
		expect(written).not.toContain("x-vayu-version");
		expect(written).not.toContain("x-request-id");
		expect(written).not.toContain("user-agent");
	});

	it("saves a User-Agent and an X-Request-ID the user chose, which are not Vayu's", () => {
		const traced = run({
			configSnapshot: {
				method: "POST",
				url: "https://api.example.test/users?page=2",
				headers: {
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
					"X-Request-ID": "order-42",
				},
			},
		} as Partial<Run>);
		const live = liveRequest();

		const seed = seedFromRun(traced, live);
		const patch = applyRunToRequest(seed, live);
		const written = new Map((patch.headers ?? []).map((h) => [h.key, h.value]));

		expect(written.get("User-Agent")).toBe("Mozilla/5.0 (X11; Linux x86_64)");
		expect(written.get("X-Request-ID")).toBe("order-42");
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
			elements: [
				{
					id: "live-pre",
					kind: "script.pre",
					enabled: true,
					config: { script: "console.log(t);" },
				},
				{
					id: "live-post",
					kind: "script.post",
					enabled: true,
					config: { script: "pm.test('ok', () => {});" },
				},
			],
			followRedirects: false,
			maxRedirects: 3,
			httpVersion: "http2",
			// The run's snapshot predates `verifySSL`, so the seed reads it as
			// verifying - the live request has to match to stay "kept".
			verifySSL: true,
			// Same for Postman's protocol switches (#1765).
			disableCookies: false,
			disabledSystemHeaders: [],
			disableUrlEncoding: false,
			auth: { mode: "bearer", token: "x" },
		} as Partial<Request>);

		const set = buildChangeset(seedFromRun(run(), live), live);
		expect(set.every((i) => i.state === "kept")).toBe(true);
		expect(set.map((i) => i.field)).toEqual(["Auth"]);
	});
});

describe("applyRunToRequest, binary bodies", () => {
	function binaryRun(file: unknown): Run {
		const base = run();
		return run({
			configSnapshot: { ...base.configSnapshot, body: { mode: "binary", file } },
		} as Partial<Run>);
	}

	it("writes the run's file reference back", () => {
		const live = liveRequest();
		const patch = applyRunToRequest(
			seedFromRun(binaryRun({ src: "/data/a.bin", contentType: "image/png" }), live),
			live
		);

		expect(patch.body).toEqual({
			mode: "binary",
			// The run recorded no flag, which the engine reads as not chosen here.
			file: { src: "/data/a.bin", contentType: "image/png", unresolved: true },
		});
		expect(patch.bodyType).toBe("binary");
	});

	it.each([
		[false, false],
		[true, true],
	])("writes a recorded unresolved %s back as %s", (recorded, written) => {
		const live = liveRequest();
		const patch = applyRunToRequest(
			seedFromRun(binaryRun({ src: "/data/a.bin", unresolved: recorded }), live),
			live
		);

		expect(patch.body).toEqual({
			mode: "binary",
			file: { src: "/data/a.bin", unresolved: written },
		});
	});

	it.each([
		[false, false],
		[true, true],
		[undefined, true],
	])("writes a form-data file part recorded with %s back as %s", (recorded, written) => {
		const live = liveRequest();
		const base = run();
		const formRun = run({
			configSnapshot: {
				...base.configSnapshot,
				body: {
					mode: "form-data",
					fields: [
						{
							key: "f",
							value: "",
							enabled: true,
							type: "file",
							src: "/a",
							unresolved: recorded,
						},
					],
				},
			},
		} as Partial<Run>);

		const patch = applyRunToRequest(seedFromRun(formRun, live), live);

		const body = patch.body as unknown as { fields: Record<string, unknown>[] };
		expect(body.fields[0]).toHaveProperty("unresolved", written);
	});

	it("keeps the saved body when the run recorded no path", () => {
		const live = liveRequest({
			body: { mode: "binary", file: { src: "/mine/keep.bin", unresolved: false } },
			bodyType: "binary",
		});
		const seed = seedFromRun(binaryRun({ fileName: "a.bin" }), live);

		const patch = applyRunToRequest(seed, live);
		expect(patch).not.toHaveProperty("body");
		expect(patch).not.toHaveProperty("bodyType");

		const bodyRow = buildChangeset(seed, live).find((item) => item.field === "Body");
		expect(bodyRow?.state).toBe("kept");
		expect(bodyRow?.note).toMatch(/did not record which file/);
	});
});
