/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	dispatchTool,
	INLINE_FILE_REFUSAL,
	INSECURE_TLS_REFUSAL,
	REQUEST_SETTINGS_KEYS,
	TOOLS,
} from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { resolveRemedyTokens } from "../remedy.js";
import { fakeClient, ctxWith, firstText, callArgs, schemaOf } from "../tools.testkit.js";

/**
 * The whole point of #378, as one sequence: an agent sets up a collection, files
 * a request in it, corrects the request, and cleans both up - without a human
 * touching the UI. Each step feeds the next the id the engine assigned, which is
 * what the create-only surface could not do.
 */
describe("an agent can round-trip its own work", () => {
	test("create a collection, fill it, correct it, delete both", async () => {
		const created = { id: "col_new", name: "Checkout API", parentId: "" };
		const client = fakeClient({
			createCollection: vi.fn().mockResolvedValue(created),
			createRequest: vi.fn().mockResolvedValue({
				id: "req_new",
				name: "POST /orders",
				collectionId: created.id,
			}),
			getRequest: vi
				.fn()
				.mockResolvedValue({ id: "req_new", name: "POST /orders", method: "POST" }),
			listCollections: vi.fn().mockResolvedValue([created]),
			listRequests: vi.fn().mockResolvedValue([]),
		});
		const ctx = ctxWith(client, { allowWrites: true });

		const collection = await dispatchTool("create_collection", { name: "Checkout API" }, ctx);
		expect(collection.isError).toBeFalsy();
		const collectionId = (JSON.parse(firstText(collection)) as { id: string }).id;

		const request = await dispatchTool(
			"create_request",
			{ collectionId, name: "POST /orders", url: "https://api.example.com/orders" },
			ctx
		);
		expect(request.isError).toBeFalsy();
		const requestId = (JSON.parse(firstText(request)) as { id: string }).id;

		const corrected = await dispatchTool(
			"update_request",
			{ requestId, url: "https://api.example.com/v2/orders" },
			ctx
		);
		expect(corrected.isError).toBeFalsy();
		expect((client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(requestId);

		const removedRequest = await dispatchTool(
			"delete_request",
			{ requestId, confirmed: true },
			ctx
		);
		expect(removedRequest.isError).toBeFalsy();
		expect(client.deleteRequest).toHaveBeenCalledWith(requestId, undefined);

		const removedCollection = await dispatchTool(
			"delete_collection",
			{ collectionId, confirmed: true },
			ctx
		);
		expect(removedCollection.isError).toBeFalsy();
		expect(client.deleteCollection).toHaveBeenCalledWith(collectionId, undefined);
	});
});

describe("document CRUD parity", () => {
	describe("saved-request auth and settings", () => {
		const auth = { mode: "bearer", token: "{{apiToken}}" };

		test("create_request stores auth and the five Settings fields", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Get users",
					url: "https://api.example.com/users",
					auth,
					followRedirects: false,
					maxRedirects: 3,
					timeout: 1500,
					httpVersion: "http2",
					stream: true,
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.createRequest)[0]).toMatchObject({
				auth,
				followRedirects: false,
				maxRedirects: 3,
				timeout: 1500,
				httpVersion: "http2",
				stream: true,
			});
		});

		test("a create that names none of them sends none of them", async () => {
			// The engine's own defaults are the answer for a caller that said
			// nothing; a filler here would store a policy nobody chose.
			const client = fakeClient();
			await dispatchTool(
				"create_request",
				{ collectionId: "col_1", name: "Get users", url: "https://api.example.com/users" },
				ctxWith(client, { allowWrites: true })
			);
			const payload = callArgs(client.createRequest)[0] as Record<string, unknown>;
			for (const key of [
				"auth",
				"followRedirects",
				"maxRedirects",
				"timeout",
				"httpVersion",
				"stream",
			]) {
				expect(Object.keys(payload), key).not.toContain(key);
			}
		});

		test("update_request patches only the settings it names", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1", maxRedirects: 0 },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// Exactly one key: `PUT /requests/:id` merge-patches, so a defaulted
			// `followRedirects: true` beside it would silently rewrite a policy
			// the user set in the app.
			expect(callArgs(client.updateRequest)[1]).toEqual({ maxRedirects: 0 });
		});

		test("update_request replaces the auth block whole", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", auth: { mode: "none" } },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ auth: { mode: "none" } });
		});

		test("the stored auth input is the run tools' schema, refusals included", () => {
			const run = schemaOf("run_request", "auth");
			const created = schemaOf("create_request", "auth");
			const updated = schemaOf("update_request", "auth");
			const collection = schemaOf("update_collection", "auth");
			const cases: unknown[] = [
				undefined,
				{ mode: "bearer", token: "t" },
				{ mode: "oauth2", clientId: "id", clientSecret: "s" },
				// The refusals: a block with no mode, a bare string, a number, an
				// array. One shared schema means one answer to each.
				{ token: "t" },
				"bearer",
				7,
				[],
			];
			for (const value of cases) {
				const expected = run.safeParse(value).success;
				expect(created.safeParse(value).success, JSON.stringify(value)).toBe(expected);
				expect(updated.safeParse(value).success, JSON.stringify(value)).toBe(expected);
				expect(collection.safeParse(value).success, JSON.stringify(value)).toBe(expected);
			}
			// The four differ only in wording, which is what makes them one schema
			// with four descriptions rather than four schemas.
			expect(run.safeParse({ token: "t" }).success).toBe(false);
			expect(run.safeParse({ mode: "bearer", token: "t" }).success).toBe(true);
		});
	});

	/**
	 * Certificate verification (#795). The stored field was written by the engine
	 * and the app and by no MCP tool, so an agent could neither save a request
	 * against a self-signed host nor restate what `list_requests` showed it. What
	 * these hold is the pair of answers that closes it: the stored field is
	 * writable under the merge-patch rule, and a *per-call* downgrade is refused.
	 */
	describe("certificate verification", () => {
		const allow = { allowlist: ["api.example.com"] };

		test("create_request stores verification off when the caller asks for it", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Internal health",
					url: "https://internal.example.test/health",
					verifySSL: false,
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.createRequest)[0]).toMatchObject({ verifySSL: false });
		});

		test("update_request patches verifySSL alone", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", verifySSL: false },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ verifySSL: false });
		});

		test("an update that does not name it leaves the stored value alone", async () => {
			// The one field where the merge-patch rule is a security rule: a
			// defaulted `true` here would silently re-enable a check the user
			// turned off, and the request would then fail against the host it was
			// written for.
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", name: "Internal health", httpVersion: "http2" },
				ctxWith(client, { allowWrites: true })
			);
			const payload = callArgs(client.updateRequest)[1] as Record<string, unknown>;
			expect(Object.keys(payload)).not.toContain("verifySSL");
		});

		test("every declared setting is a setting the payload builder reads", () => {
			// The wiring rule, not a restatement of the list: a field added to
			// `requestSettingsInput` and not to `REQUEST_SETTINGS_KEYS` parses
			// happily and reaches the engine never - this repo's most repeated
			// defect. Driven through both verbs because both spread the schema.
			for (const key of REQUEST_SETTINGS_KEYS) {
				expect(schemaOf("create_request", key), key).toBeDefined();
				expect(schemaOf("update_request", key), key).toBeDefined();
			}
		});

		test.each([
			["followRedirects", false],
			["maxRedirects", 3],
			["timeout", 1500],
			["httpVersion", "http2"],
			["stream", true],
			["streamTextPath", "$.delta.text"],
			["streamFirstContentMarker", "content_block_delta"],
			["verifySSL", false],
		] as const)("update_request forwards %s on its own", async (key, value) => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", [key]: value },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ [key]: value });
		});

		test("update_request sends an explicit null to reset the timeout, and refuses a value outside 1-86400000", async () => {
			// `null` is the reset (issue #2937): the engine reads an absent key as
			// "keep", so the argument has to reach the payload as `null`, not drop out.
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", timeout: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ timeout: null });

			const schema = schemaOf("update_request", "timeout");
			for (const refused of [0, -5, 86_400_001, 1.5, "30s"]) {
				expect(schema.safeParse(refused).success, String(refused)).toBe(false);
			}
			for (const accepted of [1, 86_400_000, null, undefined]) {
				expect(schema.safeParse(accepted).success, String(accepted)).toBe(true);
			}
			expect(schemaOf("create_request", "timeout").safeParse(null).success).toBe(true);
		});

		// Mutation check: take "streamTextPath" out of REQUEST_SETTINGS_KEYS and
		// neither verb sends it.
		test("streamTextPath is forwarded by create_request, and null reaches update_request to clear it", async () => {
			const created = fakeClient();
			await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Chat",
					url: "https://api.example.com/chat",
					stream: true,
					streamTextPath: "$.choices[0].delta.content",
				},
				ctxWith(created, { allowWrites: true })
			);
			expect(callArgs(created.createRequest)[0]).toMatchObject({
				stream: true,
				streamTextPath: "$.choices[0].delta.content",
			});

			const cleared = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", streamTextPath: null },
				ctxWith(cleared, { allowWrites: true })
			);
			expect(callArgs(cleared.updateRequest)[1]).toEqual({ streamTextPath: null });
			expect(schemaOf("update_request", "streamTextPath").safeParse(7).success).toBe(false);
		});

		// Mutation check: take "streamFirstContentMarker" out of
		// REQUEST_SETTINGS_KEYS and neither verb sends it.
		test("streamFirstContentMarker is forwarded by create_request, and null reaches update_request to clear it", async () => {
			const marker = '"delta":{"content":"';
			const created = fakeClient();
			await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Chat",
					url: "https://api.example.com/chat",
					stream: true,
					streamFirstContentMarker: marker,
				},
				ctxWith(created, { allowWrites: true })
			);
			expect(callArgs(created.createRequest)[0]).toMatchObject({
				stream: true,
				streamFirstContentMarker: marker,
			});

			const cleared = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", streamFirstContentMarker: null },
				ctxWith(cleared, { allowWrites: true })
			);
			expect(callArgs(cleared.updateRequest)[1]).toEqual({ streamFirstContentMarker: null });
			expect(
				schemaOf("update_request", "streamFirstContentMarker").safeParse(7).success
			).toBe(false);
		});

		test("the marker is stated once, on create_request, and update_request points there", () => {
			expect(schemaOf("create_request", "streamFirstContentMarker").description).toContain(
				"content_block_delta"
			);
			expect(schemaOf("update_request", "streamFirstContentMarker").description).toBe(
				"As on `create_request`; null clears it."
			);
		});

		test("update_request's no-field refusal lists the marker among the fields it takes", async () => {
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1" },
				ctxWith(fakeClient(), { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("streamFirstContentMarker");
		});

		test("the path is stated once, on create_request, and update_request points there", () => {
			const stated = schemaOf("create_request", "streamTextPath").description ?? "";
			expect(stated).toContain("$.choices[0].delta.content");
			expect(stated).toContain("$.delta.text");
			expect(schemaOf("update_request", "streamTextPath").description).toBe(
				"As on `create_request`; null clears it."
			);
		});

		test("run_request refuses a per-call downgrade before anything is sent", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: false },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(resolveRemedyTokens(INSECURE_TLS_REFUSAL, "app"));
			// Refused *before* composition, so nothing was even resolved - a
			// refusal after the exchange would be a request already sent.
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
			// The refusal names both supported routes, which is the whole point of
			// answering here rather than dropping an unknown argument.
			expect(firstText(res)).toContain("update_request");
			expect(firstText(res)).toContain("Network & connectivity");
		});

		test("run_request accepts the safe default and forwards nothing for it", async () => {
			// `true` is what the composed payload already carries, so an agent
			// restating it is not argued with - and not echoed into the request
			// overlay either, where it would be a second source for one value.
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			const composed = callArgs(client.composeRequest)[0] as {
				request: Record<string, unknown>;
			};
			expect(Object.keys(composed.request)).not.toContain("verifySSL");
			const executed = callArgs(client.executeRequest)[0] as Record<string, unknown>;
			expect(Object.keys(executed)).not.toContain("verifySSL");
		});

		test("the load and collection runners take no TLS argument at all", () => {
			// One answer, not three: the stored field is the only way a Vayu run
			// skips a certificate check, so no execute/load tool may grow an
			// argument that bypasses the record the app shows.
			for (const name of ["start_load_run", "run_collection", "run_collection_smoke"]) {
				const tool = TOOLS.find((t) => t.name === name);
				expect(tool, name).toBeDefined();
				expect(Object.keys(tool!.inputSchema), name).not.toContain("verifySSL");
			}
		});
	});
});

describe("dispatchTool", () => {
	test("create_request stores a form body as fields", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "New",
				url: "https://api.example.com/x",
				method: "POST",
				body: "a=1&b=2",
				bodyType: "x-www-form-urlencoded",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			body: {
				mode: "x-www-form-urlencoded",
				fields: [
					{ key: "a", value: "1", enabled: true },
					{ key: "b", value: "2", enabled: true },
				],
			},
			bodyType: "x-www-form-urlencoded",
		});
	});
});

/**
 * A `binary` body names a file on the user's machine. An agent may store one,
 * but never choose it: the engine sends it only once a person picks it in the
 * editor or it sits under an allowed folder, and decides that from its own
 * records, so the stored reference carries no trust member at all (#2356). An
 * agent may never *send* a file inline - the refusal points it at running the
 * saved request by id. `dispatchTool` hands handlers the raw arguments (no
 * schema parse), so an agent's own `unresolved: false` really does reach
 * `shapeBody` here.
 */
describe("binary file bodies", () => {
	const WRITE = { allowWrites: true };

	test("create_request stores a binary body without the agent's trust claim", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Upload",
				url: "https://api.example.com/upload",
				method: "PUT",
				bodyType: "binary",
				file: { src: "/data/a.png", contentType: "image/png", unresolved: false },
			},
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/data/a.png", contentType: "image/png" },
		});
		expect(payload.body.file).not.toHaveProperty("unresolved");
		expect(payload.bodyType).toBe("binary");
	});

	test("a lone `file` implies the binary mode", async () => {
		const client = fakeClient();
		await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "U", url: "https://x.test", file: { src: "/d/a.bin" } },
			ctxWith(client, WRITE)
		);
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/d/a.bin" },
		});
		expect(payload.bodyType).toBe("binary");
	});

	test("update_request replaces the body with a file reference", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_1",
				bodyType: "binary",
				file: { src: "/d/a.bin", fileName: "a.bin" },
			},
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/d/a.bin", fileName: "a.bin" },
		});
		expect(payload.bodyType).toBe("binary");
	});

	test.each([
		["binary with a body string", { bodyType: "binary", body: "x", file: { src: "/d/a" } }],
		["binary with no file", { bodyType: "binary" }],
		["binary with an empty path", { bodyType: "binary", file: { src: " " } }],
		["a file on another mode", { bodyType: "json", body: "{}", file: { src: "/d/a" } }],
	])("create_request refuses %s and writes nothing", async (_label, body) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "U", url: "https://x.test", ...body },
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBe(true);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	test.each([
		["bodyType binary", { bodyType: "binary", file: { src: "/etc/passwd" } }],
		["a bare file", { file: { src: "/etc/passwd" } }],
	])("run_request refuses an inline file body (%s) before composing", async (_label, body) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/upload", method: "PUT", ...body },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "app"));
		expect(firstText(res)).toContain("saved request by id");
		expect(client.composeRequest).not.toHaveBeenCalled();
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("start_load_run refuses an inline file body, even over a saved request", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				bodyType: "binary",
				file: { src: "/etc/passwd" },
				mode: "iterations",
				iterations: 1,
				concurrency: 1,
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "app"));
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("every body-taking tool declares `file`, and none calls file parts unsupported wholesale", () => {
		const schemaOf = (name: string) =>
			TOOLS.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>;
		expect(schemaOf("create_request").file).toBeDefined();
		expect(schemaOf("update_request").file).toBeDefined();
		// The ad-hoc senders declare it too, only so it passes the SDK's schema
		// parse and reaches the handler's refusal, which names the route that
		// does send a file.
		for (const name of ["run_request", "start_load_run"]) {
			const parsed = argumentsSchema(schemaOf(name) as Record<string, z.ZodType>).parse({
				url: "https://x.test",
				file: { src: "/d/a" },
			});
			expect(parsed.file, name).toEqual({ src: "/d/a" });
		}
		const descriptions = TOOLS.flatMap((tool) => {
			const schema = tool.inputSchema as Record<string, { description?: string }>;
			return schema?.bodyType?.description ? [schema.bodyType.description] : [];
		});
		expect(descriptions).toHaveLength(4);
		for (const description of descriptions) {
			expect(description).toContain("binary");
			expect(description).not.toContain("File parts are not supported");
		}
	});
});
