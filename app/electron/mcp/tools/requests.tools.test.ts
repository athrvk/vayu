/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS } from "../tools.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { withholdRowSecrets } from "../withhold.js";
import { fakeClient, ctxWith, firstText, engineErrorBody } from "../tools.testkit.js";

describe("data-write tools", () => {
	test("create_request is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "New", url: "https://api.example.com" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	test("create_request builds the payload (headers/body) when writes are enabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "New",
				url: "https://api.example.com/x",
				method: "POST",
				headers: { "X-A": "1" },
				body: '{"a":1}',
				bodyType: "json",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			collectionId: "c1",
			name: "New",
			method: "POST",
			url: "https://api.example.com/x",
			headers: [{ key: "X-A", value: "1", enabled: true }],
			// Canonical body shape keys off `mode` (round-trips with the app).
			body: { mode: "json", content: '{"a":1}' },
		});
		// The engine assigns ids and answers a create carrying one with a 400
		// (#97). toMatchObject above ignores extra keys, so the absence has to be
		// asserted outright - including an `id: undefined` that would serialize
		// to `"id": null` and be rejected just the same.
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	/*
	 * Stored pre/post-request scripts through the CRUD tools (#419). An agent
	 * could already *run* a script ad hoc through `run_request` but could not
	 * persist one onto the request it had just created, so scripts travelled in
	 * the description for a human to paste into the Pre-request or Tests tab.
	 *
	 * These are the whole contract: written verbatim on create, patched one at a
	 * time on update, and cleared by an explicit empty string - which works only
	 * because the engine's merge-patch tells absent and `""` apart. Drop the
	 * field mapping and every one of them reddens.
	 */
	test("create_request stores the pre-request and test scripts as elements", async () => {
		const client = fakeClient();
		const pre = "pm.request.headers.add({ key: 'X-Sig', value: pm.variables.get('sig') });";
		const post = "pm.test('ok', () => pm.response.to.have.status(200));";
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Signed",
				url: "https://api.example.com/x",
				preRequestScript: pre,
				postRequestScript: post,
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The MCP argument is still named per-phase, but the wire field is
		// `elements` (issue #1514) - the engine refuses the old keys with a 400.
		// No `id` is sent: `apply_elements_field` stamps an `el_` one on.
		expect(payload).toMatchObject({
			elements: [
				{ kind: "script.pre", enabled: true, config: { script: pre } },
				{ kind: "script.post", enabled: true, config: { script: post } },
			],
		});
		expect(Object.keys(payload as object)).not.toContain("preRequestScript");
		expect(Object.keys(payload as object)).not.toContain("postRequestScript");
	});

	test("create_request sends no elements key when the caller named none", async () => {
		// The engine defaults an absent field to empty on a create; sending `[]`
		// anyway would make the payload claim the agent asked for an empty list.
		const client = fakeClient();
		await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "Plain", url: "https://api.example.com/x" },
			ctxWith(client, { allowWrites: true })
		);
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(Object.keys(payload as object)).not.toContain("preRequestScript");
		expect(Object.keys(payload as object)).not.toContain("postRequestScript");
		expect(Object.keys(payload as object)).not.toContain("elements");
	});

	test("create_request refuses both `elements` and script sugar on the same call", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Signed",
				url: "https://api.example.com/x",
				elements: [{ kind: "assert.status", config: { in: [200] } }],
				postRequestScript: "pm.test('ok', () => {})",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not both/);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	/**
	 * A stored request whose `elements` hold both scripts plus an element this
	 * tool surface cannot address - the case a naive "write a fresh one-element
	 * array" translation silently destroys.
	 */
	function storedWithElements() {
		return {
			id: "req_1",
			name: "Get users",
			elements: [
				{ id: "el_pre", kind: "script.pre", enabled: true, config: { script: "pre();" } },
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{
					id: "el_post",
					kind: "script.post",
					enabled: true,
					config: { script: "post();" },
				},
			],
		};
	}

	test("update_request patches one script and keeps the other stored", async () => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue(storedWithElements()),
		});
		const post = "pm.test('created', () => pm.response.to.have.status(201));";
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", postRequestScript: post },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// `PUT /requests/:id` replaces `elements` wholesale, so adding a script
		// without a fetch would drop the request's other stored elements.
		expect(client.getRequest).toHaveBeenCalledWith("req_1", undefined);
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		/*
		 * `PUT /requests/:id` replaces the whole `elements` list, so the write has
		 * to carry back everything it did not mean to change: the untouched
		 * pre-request script, the assertion element MCP has no argument for
		 * (#1517), and the post script under its *existing* id. Absent keeps - a
		 * `preRequestScript: ""` filler would blank a signing script the caller
		 * never mentioned. Also proves a script alone satisfies the empty-patch
		 * refusal, which counts the payload's keys.
		 */
		expect(payload).toEqual({
			elements: [
				{ id: "el_pre", kind: "script.pre", enabled: true, config: { script: "pre();" } },
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{ id: "el_post", kind: "script.post", enabled: true, config: { script: post } },
			],
		});
	});

	test("update_request clears a script when passed an empty string", async () => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue(storedWithElements()),
		});
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", preRequestScript: "" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// `""` is a value the merge-patch honours, not an omission - the
		// difference between "leave my script alone" and "delete it".
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		// `""` is a value, not an omission - the difference between "leave my
		// script alone" and "delete it". Clearing drops the element outright
		// rather than leaving an enabled one whose script runs nothing, and takes
		// nothing else with it.
		expect(payload).toEqual({
			elements: [
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{
					id: "el_post",
					kind: "script.post",
					enabled: true,
					config: { script: "post();" },
				},
			],
		});
	});

	test("update_request sending `elements` directly needs no fetch", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", elements: [{ kind: "assert.status", config: { in: [200] } }] },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRequest).not.toHaveBeenCalled();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({
			elements: [{ kind: "assert.status", config: { in: [200] } }],
		});
	});

	test("update_request refuses both `elements` and script sugar on the same call", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_1",
				elements: [{ kind: "assert.status", config: { in: [200] } }],
				preRequestScript: "pm.request.headers.add('x-run', '1')",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not both/);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request reads nothing when no script is named", async () => {
		// The read-merge-write is the script path's alone: a rename must not pay
		// for a GET, and #1436's merge-patch rule still governs every other field.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRequest).not.toHaveBeenCalled();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ name: "Renamed" });
	});

	// Mutation check: call `updateRequest` without `ifMatch` in the merged write.
	test("update_request's script edit is written under the version it read", async () => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue({ ...storedWithElements(), updatedAt: 5 }),
		});
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", preRequestScript: "pre2();" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, , , ifMatch] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(ifMatch).toBe('W/"5"');
	});

	test("update_request's script edit re-reads once on a 412, then reports a conflict", async () => {
		const moved = () =>
			new EngineRequestError(
				"precondition failed",
				412,
				engineErrorBody("precondition_failed", "The record changed after it was read")
			);
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue({ ...storedWithElements(), updatedAt: 5 }),
			updateRequest: vi.fn().mockRejectedValueOnce(moved()).mockRejectedValueOnce(moved()),
		});
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", preRequestScript: "pre2();" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/^Nothing was written: request "req_1" was changed/);
		expect(client.getRequest).toHaveBeenCalledTimes(2);
		expect(client.updateRequest).toHaveBeenCalledTimes(2);
	});

	describe("a URL written back while secrets are withheld (#3549)", () => {
		const storedUrl = () =>
			fakeClient({
				getRequest: vi.fn().mockResolvedValue({
					id: "req_1",
					name: "Get users",
					url: "https://u:PW@h/x?api_key=S&page=2",
					elements: [],
					updatedAt: 7,
				}),
			});
		const writtenOf = (client: EngineClient) =>
			(client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];

		// Mutation check: write `payload.url` as given in the merge and the
		// stored password and key are gone from the PUT.
		test("keeps the password and the key the read emptied, and says so", async () => {
			const client = storedUrl();
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1", url: "https://u@h/x?api_key=&page=3" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			const [, payload, , ifMatch] = writtenOf(client);
			expect(payload).toEqual({ url: "https://u:PW@h/x?api_key=S&page=3" });
			expect(ifMatch).toBe('W/"7"');
			const notes = res.content.map((c) => c.text).join("\n");
			expect(notes).toContain(
				"api_key kept its stored value; remove the parameter to drop it."
			);
			expect(notes).toContain("The URL's userinfo password kept its stored value");
		});

		test("a removed parameter is removed", async () => {
			const client = storedUrl();
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1", url: "https://u@h/x?page=3" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(writtenOf(client)[1]).toEqual({ url: "https://u:PW@h/x?page=3" });
			expect(res.content.map((c) => c.text).join("\n")).not.toContain("api_key kept");
		});

		test("with reveal on, the URL is written as given and nothing is read", async () => {
			const client = storedUrl();
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1", url: "https://u@h/x?api_key=&page=3" },
				ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.getRequest).not.toHaveBeenCalled();
			expect(writtenOf(client)[1]).toEqual({ url: "https://u@h/x?api_key=&page=3" });
			expect(res.content).toHaveLength(1);
		});
	});

	describe("a write that moves the request to another origin (#3564, #3654)", () => {
		const storedRow = {
			id: "req_1",
			name: "Get users",
			url: "https://u:PW@bank.example/x?api_key=S&page=2",
			headers: [
				{ key: "Authorization", value: "Bearer s3cret", enabled: true },
				{ key: "X-Trace", value: "1", enabled: true },
			],
			updatedAt: 7,
		};
		/** The stored request with no header or auth credential: only the URL's slots follow a host change. */
		const urlOnlyRow = { ...storedRow, headers: [storedRow.headers[1]] };
		const bearerAuth = { mode: "bearer", token: "tok-secret" };
		const readHeaders = [
			{ key: "Authorization", enabled: true, valueWithheld: true },
			{ key: "X-Trace", value: "1", enabled: true },
		];
		const moved = "https://evil.example/x";
		const update = (
			args: Record<string, unknown>,
			options: { reveal?: boolean; row?: Record<string, unknown> } = {}
		) => {
			const client = fakeClient({
				getRequest: vi.fn().mockResolvedValue(structuredClone(options.row ?? storedRow)),
			});
			return dispatchTool(
				"update_request",
				{ requestId: "req_1", ...args },
				ctxWith(client, {
					allowWrites: true,
					revealSecretsToAgents: options.reveal ?? false,
				})
			).then((res) => ({
				res,
				payload: (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
				notes: res.content.map((c) => c.text).join("\n"),
			}));
		};
		/** The answer is a refusal of class "input" and nothing reached the engine. */
		const expectRefused = (answer: Awaited<ReturnType<typeof update>>) => {
			expect(answer.res.isError).toBe(true);
			expect(answer.res.structuredContent).toMatchObject({ error: { class: "input" } });
			expect(answer.payload).toBeUndefined();
		};

		// Mutation check: drop the origin comparison (`originChanged` always false)
		// and the password and key go to the new host.
		test("a changed host does not inherit the password or the key, and the answer names them", async () => {
			const { res, payload, notes } = await update(
				{ url: "https://u@evil.example/x?api_key=&page=2" },
				{ row: urlOnlyRow }
			);
			expect(res.isError).toBeFalsy();
			expect(payload).toEqual({ url: "https://u@evil.example/x?api_key=&page=2" });
			expect(notes).toContain(
				"The URL's userinfo password was not carried because the host changed; give it a value or remove it."
			);
			expect(notes).toContain(
				"api_key was not carried because the host changed; give it a value or remove it."
			);
			expect(notes).not.toContain("kept its stored value");
		});

		// Mutation check: skip `refuseStoredCredentialsToNewOrigin` in `writeRequestEdits`
		// and the PUT carries the Authorization row to the new host.
		describe("a stored credential header row", () => {
			test("a URL-only write to another host is refused, naming the row and the way out", async () => {
				const answer = await update({ url: moved });
				expectRefused(answer);
				expect(answer.notes).toContain('"Authorization" header row');
				expect(answer.notes).toContain('"mode": "none"');
				expect(answer.notes).not.toContain('auth" stored');
				expect(answer.notes).not.toContain("s3cret");
			});

			test("a row written back withheld is not a rewrite", async () => {
				expectRefused(await update({ url: moved, headers: readHeaders }));
			});

			test("a changed port or scheme is a changed origin for a header row too", async () => {
				for (const url of ["https://bank.example:8443/x", "http://bank.example/x"]) {
					const answer = await update({ url, headers: readHeaders });
					expect(answer.res.isError, url).toBe(true);
					expect(answer.payload, url).toBeUndefined();
				}
			});

			test("a disabled stored row follows the request too", async () => {
				const row = {
					...storedRow,
					headers: [{ key: "Authorization", value: "Bearer s3cret", enabled: false }],
				};
				const answer = await update({ url: moved }, { row });
				expectRefused(answer);
				expect(answer.notes).toContain('"Authorization" header row');
			});

			test("a repeated name is judged by occurrence: the second row kept is refused", async () => {
				const row = {
					...storedRow,
					headers: [
						{ key: "Set-Cookie", value: "a=1", enabled: true },
						{ key: "Set-Cookie", value: "b=2", enabled: true },
					],
				};
				const answer = await update(
					{
						url: moved,
						headers: [
							{ key: "Set-Cookie", value: "c=3" },
							{ key: "Set-Cookie", valueWithheld: true },
						],
					},
					{ row }
				);
				expectRefused(answer);
				expect(answer.notes).toContain('"Set-Cookie" header row');
			});

			test("a repeated name with the second row left out writes the first only", async () => {
				const row = {
					...storedRow,
					headers: [
						{ key: "Set-Cookie", value: "a=1", enabled: true },
						{ key: "Set-Cookie", value: "b=2", enabled: true },
					],
				};
				const { res, payload } = await update(
					{ url: moved, headers: [{ key: "Set-Cookie", value: "c=3" }] },
					{ row }
				);
				expect(res.isError).toBeFalsy();
				expect(payload.headers).toEqual([
					{ key: "Set-Cookie", value: "c=3", enabled: true },
				]);
			});

			test("a call that gives every credential row a value of its own writes", async () => {
				const { res, payload, notes } = await update({
					url: moved,
					headers: [{ key: "Authorization", value: "Bearer NEW" }, readHeaders[1]],
				});
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({
					url: moved,
					headers: [
						{ key: "Authorization", value: "Bearer NEW", enabled: true },
						{ key: "X-Trace", value: "1", enabled: true },
					],
				});
				expect(notes).not.toContain("was not carried");
			});

			test("a call that leaves the row out clears it", async () => {
				const { res, payload } = await update({
					url: moved,
					headers: [{ key: "X-Trace", value: "1" }],
				});
				expect(res.isError).toBeFalsy();
				expect(payload.headers).toEqual([{ key: "X-Trace", value: "1", enabled: true }]);
			});

			test("a kept row that stands for no credential is carried to the new host", async () => {
				const { res, payload } = await update({
					url: moved,
					headers: [
						{ key: "Authorization", value: "Bearer NEW" },
						{ key: "X-Trace", valueWithheld: true },
					],
				});
				expect(res.isError).toBeFalsy();
				expect(payload.headers).toEqual([
					{ key: "Authorization", value: "Bearer NEW", enabled: true },
					{ key: "X-Trace", value: "1", enabled: true },
				]);
			});

			test("a withheld row with nothing stored behind it is still refused", async () => {
				expectRefused(
					await update(
						{ url: moved, headers: [{ key: "X-Api-Key", valueWithheld: true }] },
						{ row: urlOnlyRow }
					)
				);
			});
		});

		describe("a stored auth block", () => {
			const authRow = { ...urlOnlyRow, auth: bearerAuth };

			test("a URL-only write to another host is refused, naming the mode", async () => {
				const answer = await update({ url: moved }, { row: authRow });
				expectRefused(answer);
				expect(answer.notes).toContain('the "bearer" auth');
				expect(answer.notes).not.toContain("header row");
				expect(answer.notes).not.toContain("tok-secret");
			});

			test("one refusal names the rows and the mode together", async () => {
				const answer = await update(
					{ url: moved },
					{ row: { ...storedRow, auth: bearerAuth } }
				);
				expectRefused(answer);
				expect(answer.notes).toContain('"Authorization" header row');
				expect(answer.notes).toContain('the "bearer" auth');
			});

			test("an auth the call replaces writes", async () => {
				const auth = { mode: "bearer", token: "{{newToken}}" };
				const { res, payload } = await update({ url: moved, auth }, { row: authRow });
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({ url: moved, auth });
			});

			test("auth cleared with mode none writes", async () => {
				const { res, payload } = await update(
					{ url: moved, auth: { mode: "none" } },
					{ row: authRow }
				);
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({ url: moved, auth: { mode: "none" } });
			});

			test("an auth the call replaces does not rewrite a credential header row", async () => {
				expectRefused(await update({ url: moved, auth: { mode: "none" } }));
			});

			test.each([
				["none", { mode: "none" }],
				["inherit", { mode: "inherit" }],
				["a bearer token that is a variable", { mode: "bearer", token: "{{apiToken}}" }],
			])("a stored auth of %s holds no credential to follow", async (_name, auth) => {
				const { res, payload } = await update(
					{ url: moved },
					{ row: { ...urlOnlyRow, auth } }
				);
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({ url: moved });
			});

			test("both rewritten in one call writes", async () => {
				const { res, payload } = await update(
					{
						url: moved,
						headers: [{ key: "Authorization", value: "Bearer NEW" }],
						auth: { mode: "none" },
					},
					{ row: { ...storedRow, auth: bearerAuth } }
				);
				expect(res.isError).toBeFalsy();
				expect(payload.auth).toEqual({ mode: "none" });
				expect(payload.headers).toEqual([
					{ key: "Authorization", value: "Bearer NEW", enabled: true },
				]);
			});
		});

		describe("a write the rule does not judge", () => {
			test("a same-origin edit keeps the password, the key, the row and the auth", async () => {
				const { res, payload, notes } = await update(
					{ url: "https://u@BANK.example:443/y?api_key=&page=3" },
					{ row: { ...storedRow, auth: bearerAuth } }
				);
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({
					url: "https://u:PW@BANK.example:443/y?api_key=S&page=3",
				});
				expect(notes).toContain("api_key kept its stored value");
				expect(notes).not.toContain("was not carried");
			});

			test("a same-origin edit with a withheld row keeps its stored value", async () => {
				const { payload } = await update({
					url: "https://u@BANK.example:443/y?api_key=&page=3",
					headers: readHeaders,
				});
				expect(payload).toEqual({
					url: "https://u:PW@BANK.example:443/y?api_key=S&page=3",
					headers: storedRow.headers,
				});
			});

			test("a headers-only write has no URL to move and keeps the row", async () => {
				const { payload, notes } = await update({ headers: readHeaders });
				expect(payload).toEqual({ headers: storedRow.headers });
				expect(notes).not.toContain("was not carried");
			});

			test("an auth-only write has no URL to move", async () => {
				const { res, payload } = await update(
					{ auth: { mode: "none" } },
					{ row: { ...storedRow, auth: bearerAuth } }
				);
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({ auth: { mode: "none" } });
			});

			test("with reveal on the URL is written as given and a withheld row keeps its value", async () => {
				const { payload, notes } = await update(
					{ url: moved, headers: readHeaders },
					{ reveal: true }
				);
				expect(payload).toEqual({ url: moved, headers: storedRow.headers });
				expect(notes).not.toContain("was not carried");
			});

			test("with reveal on a URL-only write to another host is not refused", async () => {
				const { res, payload } = await update(
					{ url: moved },
					{ reveal: true, row: { ...storedRow, auth: bearerAuth } }
				);
				expect(res.isError).toBeFalsy();
				expect(payload).toEqual({ url: moved });
			});
		});
	});

	describe("header rows written back while secrets are withheld (#3550)", () => {
		const storedHeaders = [
			{ key: "Authorization", value: "Bearer s3cret", enabled: true },
			{ key: "X-Trace", value: "1", enabled: true },
			{ key: "X-Off", value: "off", enabled: false },
			{ key: "Set-Cookie", value: "a=1", enabled: true },
			{ key: "Set-Cookie", value: "b=2", enabled: true },
		];
		const storedRow = { id: "req_1", name: "Get users", headers: storedHeaders, updatedAt: 7 };
		const storedClient = () =>
			fakeClient({ getRequest: vi.fn().mockResolvedValue(structuredClone(storedRow)) });
		/** The rows `get_request` hands an agent while reveal is off. */
		const readRows = () =>
			(withholdRowSecrets(structuredClone(storedRow)) as { headers: object[] }).headers;
		const written = (client: EngineClient) =>
			(client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		const update = (client: EngineClient, headers: unknown, reveal = false) =>
			dispatchTool(
				"update_request",
				{ requestId: "req_1", headers },
				ctxWith(client, { allowWrites: true, revealSecretsToAgents: reveal })
			);

		// Mutation check: return a withheld row as given in
		// `restoreWithheldHeaderRows` and the PUT loses the Authorization and
		// Set-Cookie values.
		test("the rows as read, one value changed, keep every stored value, flag, repeat and the order", async () => {
			const rows = readRows();
			expect(rows[0]).toEqual({ key: "Authorization", enabled: true, valueWithheld: true });
			rows[1] = { ...rows[1], value: "2" };
			rows.push({ key: "X-New", value: "y" });
			const client = storedClient();
			const res = await update(client, rows);
			expect(res.isError).toBeFalsy();
			const [, payload, , ifMatch] = written(client);
			expect(payload).toEqual({
				headers: [
					{ key: "Authorization", value: "Bearer s3cret", enabled: true },
					{ key: "X-Trace", value: "2", enabled: true },
					{ key: "X-Off", value: "off", enabled: false },
					{ key: "Set-Cookie", value: "a=1", enabled: true },
					{ key: "Set-Cookie", value: "b=2", enabled: true },
					{ key: "X-New", value: "y", enabled: true },
				],
			});
			expect(ifMatch).toBe('W/"7"');
			expect(res.content).toHaveLength(1);
		});

		test("a withheld row keeps the stored row of its name and occurrence, whatever the spelling", async () => {
			const client = storedClient();
			await update(client, [
				{ key: "set-cookie", value: "new=1" },
				{ key: "SET-COOKIE", valueWithheld: true },
			]);
			expect(written(client)[1].headers).toEqual([
				{ key: "set-cookie", value: "new=1", enabled: true },
				{ key: "SET-COOKIE", value: "b=2", enabled: true },
			]);
		});

		describe("rows carrying description, source and type", () => {
			// The Content-Type row the app's Body panel writes, a described credential
			// row and a Postman import's typed row: the members `get_request` passes
			// through beside key, value and enabled.
			const richHeaders = [
				{
					key: "Authorization",
					value: "Bearer s3cret",
					enabled: true,
					description: "token",
				},
				{
					key: "Content-Type",
					value: "application/json",
					enabled: true,
					source: "body-mode",
					description: "set by the Body tab",
				},
				{ key: "X-Imported", value: "1", enabled: false, type: "any" },
			];
			const richClient = () =>
				fakeClient({
					getRequest: vi
						.fn()
						.mockResolvedValue({ ...structuredClone(storedRow), headers: richHeaders }),
				});
			const richRead = () =>
				(
					withholdRowSecrets({ ...structuredClone(storedRow), headers: richHeaders }) as {
						headers: object[];
					}
				).headers;

			// Mutation check: drop `source: z.string().optional()` from
			// `storedHeadersInput` and the rows as read are refused as an unrecognised key.
			test("both tools' headers schema accepts the rows exactly as read, and still refuses an undeclared member", () => {
				const read = richRead();
				expect(read[0]).toEqual({
					key: "Authorization",
					enabled: true,
					description: "token",
					valueWithheld: true,
				});
				for (const name of ["create_request", "update_request"]) {
					const schema = TOOLS.find((t) => t.name === name)!.inputSchema
						.headers as z.ZodType;
					expect(schema.safeParse(read).success, `${name} rows as read`).toBe(true);
					expect(
						schema.safeParse([{ ...richHeaders[1], note: "x" }]).success,
						`${name} undeclared member`
					).toBe(false);
				}
			});

			// Mutation check: build the row from `{key, value, enabled}` alone in
			// `readHeaderRow` or `restoreWithheldHeaderRows` and the PUT drops
			// `source`, `description` or `type`.
			test("the rows as read are written back whole, source and description kept, the withheld value restored", async () => {
				const client = richClient();
				const res = await update(client, richRead());
				expect(res.isError).toBeFalsy();
				expect(written(client)[1]).toEqual({ headers: richHeaders });
				expect(res.content).toHaveLength(1);
			});

			test("a row written with a value forwards its extra members too", async () => {
				const client = richClient();
				await update(client, [
					{ ...richHeaders[1], value: "application/xml" },
					{
						key: "X-Imported",
						value: "2",
						enabled: false,
						type: "any",
						source: "legacy-default",
					},
				]);
				expect(written(client)[1].headers).toEqual([
					{ ...richHeaders[1], value: "application/xml" },
					{
						key: "X-Imported",
						value: "2",
						enabled: false,
						type: "any",
						source: "legacy-default",
					},
				]);
			});

			test("create_request forwards the extra members of a row it stores", async () => {
				const client = fakeClient();
				await dispatchTool(
					"create_request",
					{
						collectionId: "col_1",
						name: "x",
						url: "https://h",
						headers: [richHeaders[1]],
					},
					ctxWith(client, { allowWrites: true })
				);
				const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
				expect(payload.headers).toEqual([richHeaders[1]]);
			});

			test("a member that is not a string is refused as input before anything is written", async () => {
				const client = richClient();
				const res = await update(client, [
					{ key: "Content-Type", value: "a/b", source: true },
				]);
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
				expect(firstText(res)).toContain('has a "source" that is not a string');
				expect(client.updateRequest).not.toHaveBeenCalled();
			});
		});

		// Mutation check: drop the throw for an unmatched withheld row in
		// `restoreWithheldHeaderRows` and the write goes out.
		test.each([
			["a name nothing stores", [{ key: "X-Api-Key", valueWithheld: true }], "X-Api-Key"],
			[
				"one occurrence more than is stored",
				[0, 1, 2].map(() => ({ key: "Set-Cookie", valueWithheld: true })),
				'only 2 "Set-Cookie" headers are stored',
			],
		])(
			"a withheld row matching %s is refused as input, naming it",
			async (_label, rows, named) => {
				const client = storedClient();
				const res = await update(client, rows);
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
				expect(firstText(res)).toContain(named);
				expect(client.updateRequest).not.toHaveBeenCalled();
			}
		);

		// Mutation check: leave the dropped-header caveat out of
		// `mergeRequestEdits` and the note is gone.
		test("a map write still replaces the list, and names the unread rows it dropped", async () => {
			const client = storedClient();
			const res = await update(client, { "X-Trace": "2", "Set-Cookie": "c=3" });
			expect(res.isError).toBeFalsy();
			expect(written(client)[1]).toEqual({
				headers: [
					{ key: "X-Trace", value: "2", enabled: true },
					{ key: "Set-Cookie", value: "c=3", enabled: true },
				],
			});
			expect(res.content).toHaveLength(2);
			const caveat = res.content[1].text;
			expect(caveat).toContain('"Authorization", "Set-Cookie" headers');
			// Not the `{key, valueWithheld: true}` shorthand: with `enabled` left out it
			// would write a stored disabled row back enabled.
			expect(caveat).toContain("exactly as read");
			expect(caveat).toContain("`enabled`");
			expect(caveat).not.toContain("{key, valueWithheld: true}");
		});

		// Mutation check: pass `undefined` for the stored auth in
		// `mergeRequestEdits` and the API-key header is not named.
		test("a map write names the header the stored API-key auth names", async () => {
			const client = fakeClient({
				getRequest: vi.fn().mockResolvedValue({
					...structuredClone(storedRow),
					headers: [{ key: "X-Custom-Key", value: "k1", enabled: true }],
					auth: { mode: "apikey", key: "X-Custom-Key" },
				}),
			});
			const res = await update(client, { "X-Trace": "2" });
			expect(res.isError).toBeFalsy();
			expect(res.content[1].text).toContain('"X-Custom-Key" header');
		});

		test("rows that keep every unread row carry no caveat", async () => {
			const client = storedClient();
			const res = await update(client, readRows());
			expect(res.isError).toBeFalsy();
			expect(written(client)[1].headers).toEqual(storedHeaders);
			expect(res.content).toHaveLength(1);
		});

		test("with reveal on, a map write reads nothing and notes nothing", async () => {
			const client = storedClient();
			const res = await update(client, { "X-Trace": "2" }, true);
			expect(res.isError).toBeFalsy();
			expect(client.getRequest).not.toHaveBeenCalled();
			expect(written(client)[1]).toEqual({
				headers: [{ key: "X-Trace", value: "2", enabled: true }],
			});
			expect(res.content).toHaveLength(1);
		});

		test("with reveal on, a withheld row written back still keeps its stored value", async () => {
			const client = storedClient();
			const res = await update(client, [{ key: "Authorization", valueWithheld: true }], true);
			expect(res.isError).toBeFalsy();
			expect(written(client)[1].headers).toEqual([storedHeaders[0]]);
		});

		// Mutation check: drop the `!reveal` guard on the caveat in
		// `mergeRequestEdits` and the dropped Set-Cookie rows are named as unread.
		test('with reveal on, rows that drop stored credential rows carry no "cannot read" caveat', async () => {
			const client = storedClient();
			const res = await update(client, [{ key: "Authorization", valueWithheld: true }], true);
			expect(res.isError).toBeFalsy();
			expect(res.content).toHaveLength(1);
			expect(JSON.stringify(res.content)).not.toContain("cannot read");
		});

		// Mutation check: read `create_request`'s headers with `readHeaderRows`
		// alone and the withheld row is sent with no value.
		test("create_request refuses a withheld row, since nothing is stored to keep", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "x",
					url: "https://h",
					headers: [{ key: "Authorization", valueWithheld: true }],
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
			expect(firstText(res)).toContain('no "Authorization" header is stored');
			expect(client.createRequest).not.toHaveBeenCalled();
		});

		test("create_request stores rows in order, repeats and disabled rows kept", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{ collectionId: "col_1", name: "x", url: "https://h", headers: storedHeaders },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.headers).toEqual(storedHeaders);
		});

		test("both tools' headers schema takes the rows as read and refuses an undeclared member", () => {
			for (const name of ["create_request", "update_request"]) {
				const schema = TOOLS.find((t) => t.name === name)!.inputSchema.headers as z.ZodType;
				expect(schema.safeParse(readRows()).success, `${name} rows`).toBe(true);
				expect(schema.safeParse({ "X-A": "1" }).success, `${name} map`).toBe(true);
				expect(
					schema.safeParse([{ key: "X-A", value: "1", note: "x" }]).success,
					`${name} undeclared member`
				).toBe(false);
			}
		});
	});

	test("the CRUD tools name a stored script once, without the run tools' alias", () => {
		// `tests` is the engine's spelling for an ad-hoc run body; a second name
		// for a stored field would be a second name to keep in step.
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		for (const name of ["create_request", "update_request"]) {
			const schema = byName.get(name)?.inputSchema;
			expect(schema, name).toBeDefined();
			expect(Object.keys(schema!), name).toEqual(
				expect.arrayContaining(["preRequestScript", "postRequestScript"])
			);
			expect(Object.keys(schema!), name).not.toContain("tests");
		}
	});

	/*
	 * Collection + request CRUD (#378). The write surface used to be create-only,
	 * so an agent could file a request into a collection a human had made and
	 * could never correct or remove it. These cover the two things that make the
	 * new verbs safe to hand an agent: a patch carries only what the caller named
	 * (the engine merge-patches, so anything extra is a field silently rewritten),
	 * and a delete cannot happen without the user seeing what it destroys.
	 */
	test("every new write verb refuses before touching the engine when writes are off", async () => {
		const client = fakeClient();
		const calls: Array<[string, Record<string, unknown>, keyof EngineClient]> = [
			["create_collection", { name: "API" }, "createCollection"],
			["update_collection", { collectionId: "col_1", name: "API" }, "updateCollection"],
			["delete_collection", { collectionId: "col_1", confirmed: true }, "deleteCollection"],
			["update_request", { requestId: "req_1", name: "x" }, "updateRequest"],
			["delete_request", { requestId: "req_1", confirmed: true }, "deleteRequest"],
		];
		for (const [tool, args, method] of calls) {
			const res = await dispatchTool(tool, args, ctxWith(client, { allowWrites: false }));
			expect(res.isError, tool).toBe(true);
			expect(client[method], tool).not.toHaveBeenCalled();
		}
		// A delete must not even read what it would destroy while writes are off.
		expect(client.listCollections).not.toHaveBeenCalled();
		expect(client.getRequest).not.toHaveBeenCalled();
	});

	test("create_collection sends the stated fields and lets the engine assign the id", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{ name: "API", parentId: "col_root", description: "Public endpoints" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toEqual({
			name: "API",
			parentId: "col_root",
			description: "Public endpoints",
		});
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	test("create_collection omits parentId entirely for a top-level collection", async () => {
		// A `parentId: undefined` serializes to `"parentId": null`, which the
		// engine reads as an explicit reset rather than "not stated".
		const client = fakeClient();
		await dispatchTool(
			"create_collection",
			{ name: "API" },
			ctxWith(client, { allowWrites: true })
		);
		const payload = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(Object.keys(payload as object)).toEqual(["name"]);
	});

	test("update_collection patches only what the caller named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateCollection as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("col_1");
		expect(payload).toEqual({ name: "Renamed" });
	});

	test("update_collection refuses a patch that names nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
	});

	// A blank name is an input mistake caught before the engine is asked (#3253).
	test.each(["", "  ", "\t\r\n "])(
		"create_collection and update_collection refuse the blank name %j without calling the engine",
		async (blank) => {
			const client = fakeClient();
			const ctx = ctxWith(client, { allowWrites: true });
			const created = await dispatchTool("create_collection", { name: blank }, ctx);
			const renamed = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", name: blank },
				ctx
			);
			for (const res of [created, renamed]) {
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
			}
			expect(firstText(renamed)).toContain("whitespace-only");
			expect(client.createCollection).not.toHaveBeenCalled();
			expect(client.getCollection).not.toHaveBeenCalled();
			expect(client.updateCollection).not.toHaveBeenCalled();
		}
	);

	test("create_collection and update_collection keep a name's surrounding spaces as written", async () => {
		const client = fakeClient();
		const ctx = ctxWith(client, { allowWrites: true });
		await dispatchTool("create_collection", { name: " API " }, ctx);
		await dispatchTool("update_collection", { collectionId: "col_1", name: " Renamed " }, ctx);
		const created = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const [, patch] = (client.updateCollection as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(created).toEqual({ name: " API " });
		expect(patch).toEqual({ name: " Renamed " });
	});

	test("update_request patches only the named field, leaving the rest stored", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("req_1");
		// `PUT /requests/:id` merge-patches: a defaulted method or an empty header
		// list here would blank a field the caller never mentioned.
		expect(payload).toEqual({ name: "Renamed" });
	});

	test("update_request writes the body blob and its denormalized type together", async () => {
		const client = fakeClient();
		await dispatchTool(
			"update_request",
			{ requestId: "req_1", body: "a=1&b=2", bodyType: "x-www-form-urlencoded" },
			ctxWith(client, { allowWrites: true })
		);
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({
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

	test("update_request refuses a bodyType with no body to describe", async () => {
		// Writing the column without the blob leaves the two disagreeing about
		// what the request sends.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", bodyType: "json" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	describe("an mcpTool argument (#3792)", () => {
		const TOOL = {
			name: "execute_sql",
			inputSchema: { type: "object", properties: { region: { "x-mcp-header": "Region" } } },
		};
		const CALL = '{"method":"tools/call","params":{"name":"execute_sql"}}';
		const created = {
			collectionId: "c1",
			name: "Query",
			url: "https://mcp.example.com/mcp",
			method: "POST",
		};

		test("create_request stores the tool inside the mcp body", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{ ...created, bodyType: "mcp", body: CALL, mcpTool: TOOL },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload).toMatchObject({
				body: { mode: "mcp", content: CALL, mcpTool: TOOL },
				bodyType: "mcp",
			});
			expect(Object.keys(payload as object)).not.toContain("mcpTool");
		});

		test.each([
			["another bodyType", { bodyType: "json", body: "{}" }, 'not "json"'],
			["no bodyType", { body: CALL }, 'pass it with bodyType "mcp".'],
			["no body", { bodyType: "mcp" }, 'pass the "body" it belongs to'],
			["nothing else", {}, 'pass it with bodyType "mcp".'],
		])("both write tools refuse it with %s", async (_case, args, refusal) => {
			const client = fakeClient();
			const ctx = ctxWith(client, { allowWrites: true });
			for (const [name, base] of [
				["create_request", created],
				["update_request", { requestId: "req_1" }],
			] as const) {
				const res = await dispatchTool(name, { ...base, ...args, mcpTool: TOOL }, ctx);
				expect(res.isError, name).toBe(true);
				expect(firstText(res), name).toContain(refusal);
			}
			expect(client.createRequest).not.toHaveBeenCalled();
			expect(client.updateRequest).not.toHaveBeenCalled();
		});

		test("both tools' schema takes a tool as listed or imported and refuses a nameless one", () => {
			for (const name of ["create_request", "update_request"]) {
				const schema = TOOLS.find((t) => t.name === name)!.inputSchema.mcpTool as z.ZodType;
				const listed = {
					...TOOL,
					title: "Execute SQL",
					annotations: { readOnlyHint: false },
				};
				expect(schema.safeParse(listed).success, `${name} as listed`).toBe(true);
				expect(schema.safeParse({ name: "ping" }).success, `${name} as imported`).toBe(
					true
				);
				expect(schema.safeParse({ inputSchema: {} }).success, `${name} nameless`).toBe(
					false
				);
			}
		});
	});

	test("update_request refuses a patch with no fields at all", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request refuses fixed mode with no example id", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockResponseMode: "fixed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/mockResponseMode/);
		expect(firstText(res)).toMatch(/mockExampleId/);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request forwards a mock response mode that needs no example", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockResponseMode: "random" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ mockResponseMode: "random" });
	});

	test("update_request clears mockExampleId with an explicit null, distinct from omitting it", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockExampleId: null },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ mockExampleId: null });
	});

	test("update_environment sends no body id - the path is the identity", async () => {
		// A body id that disagrees with the path is a 400 since #97, and one that
		// agrees is dead weight. Same reason the renderer's PUT sends a patch only.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "secret" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("env_1");
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	test("update_environment merges variables and preserves the existing name", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "secret" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// PUT /environments/:id - the id is the path argument, not a body field.
		const call = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("env_1");
		const payload = call[1];
		expect(payload).not.toHaveProperty("id");
		expect(payload).toMatchObject({
			name: "Dev",
			variables: {
				baseUrl: { value: "x", enabled: true },
				apiKey: { value: "secret", enabled: true },
			},
		});
	});

	test("update_environment overwrites the value and keeps secret/type/createdAt", async () => {
		// A secret-marked token rotated through MCP must stay masked: the engine
		// replaces the variables blob wholesale, so whatever this payload drops
		// is gone for good and the popover renders the token in plaintext.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					apiKey: {
						value: "old",
						enabled: true,
						secret: true,
						type: "string",
						createdAt: 42,
					},
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "rotated" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(payload).toMatchObject({
			variables: {
				apiKey: {
					value: "rotated",
					enabled: true,
					secret: true,
					type: "string",
					createdAt: 42,
				},
			},
		});
	});

	test("update_environment does not re-enable a disabled variable", async () => {
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: { host: { value: "old", enabled: false } },
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { host: "new" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(payload).toMatchObject({ variables: { host: { value: "new", enabled: false } } });
	});

	test("update_environment gives a new key a sane default entry", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { brandNew: "v" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const entry = (payload as { variables: Record<string, unknown> }).variables.brandNew;
		expect(entry).toEqual({ value: "v", enabled: true });
	});

	test("update_environment replaces a malformed stored entry instead of spreading it", async () => {
		// A bare string off disk is a real case (D17). Spreading it would write
		// `{0:"o",1:"l",...}` into the blob every reader then has to survive.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: { loose: "old", listy: ["a"] },
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { loose: "new", listy: "new" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const vars = (payload as { variables: Record<string, unknown> }).variables;
		expect(vars.loose).toEqual({ value: "new", enabled: true });
		expect(vars.listy).toEqual({ value: "new", enabled: true });
	});

	test("update_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { a: "b" } },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});
});
