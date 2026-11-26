/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	DEFAULT_INBOX_CAPTURE_LIMIT,
	dispatchTool,
	MAX_INBOX_CAPTURE_LIMIT,
	MAX_INLINE_BODY_BYTES,
	TOOLS,
} from "../tools.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { descriptionOf, page, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("webhook inbox tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));
	const forwarded = (client: EngineClient, method: keyof EngineClient) =>
		(client[method] as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");

	describe("the loopback guarantee", () => {
		test("no inbox payload can carry a bind or a non-loopback confirmation", async () => {
			// The mutation check for epic #753's stated non-goal: an inbox MCP
			// started must not be reachable off this machine. Asserted as the
			// *absence* of both fields, whatever the caller sent - the engine only
			// leaves loopback when it is asked to, so never asking is the guard.
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ port: 45001, bind: "0.0.0.0", confirmNonLoopback: true },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			const payload = forwarded(client, "startInbox")[0] as Record<string, unknown>;
			expect(payload).not.toHaveProperty("bind");
			expect(payload).not.toHaveProperty("confirmNonLoopback");
			expect(payload).toEqual({ port: 45001 });
		});

		test("the schema does not offer a bind at all", () => {
			const schema = byName().get("start_webhook_inbox")?.inputSchema ?? {};
			expect(Object.keys(schema).sort()).toEqual(["allowedOrigins", "port", "response"]);
		});
	});

	describe("start_webhook_inbox", () => {
		test("forwards allowedOrigins and still never a bind", async () => {
			const client = fakeClient();
			const origins = ["https://app.example.com", "http://localhost:5173"];
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ port: 45002, allowedOrigins: origins, bind: "0.0.0.0", confirmNonLoopback: true },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "startInbox")[0]).toEqual({
				port: 45002,
				allowedOrigins: origins,
			});
		});

		test("sends no allowedOrigins when the caller named none", async () => {
			const client = fakeClient();
			await dispatchTool("start_webhook_inbox", { port: 45003 }, ctxWith(client));
			expect(forwarded(client, "startInbox")[0]).not.toHaveProperty("allowedOrigins");
		});

		test("the schema takes an array of strings and leaves the origin rules to the engine", () => {
			const shape = byName().get("start_webhook_inbox")?.inputSchema as Record<
				string,
				z.ZodType
			>;
			expect(shape.allowedOrigins.safeParse(["https://app.example.com"]).success).toBe(true);
			expect(shape.allowedOrigins.safeParse("https://app.example.com").success).toBe(false);
		});

		test("forwards only the canned-response fields the caller named", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ response: { status: 202, body: "queued", delayMs: 250 } },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			// An absent field must stay absent: `PUT /inbox/:id` is a merge-patch
			// and a spelled-out null is "reset this", not "unspecified".
			expect(forwarded(client, "startInbox")[0]).toEqual({
				response: { status: 202, body: "queued", delayMs: 250 },
			});
		});

		test("needs no write toggle - it saves nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{},
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBeFalsy();
			expect(client.startInbox).toHaveBeenCalled();
		});
	});

	describe("get_inbox_captures", () => {
		test("stated pagination is forwarded", async () => {
			const client = fakeClient();
			await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", limit: 50, offset: 100 },
				ctxWith(client)
			);
			expect(forwarded(client, "getInboxCaptures")).toEqual(["inbox_1", 50, 100, undefined]);
		});

		test("with no pagination it asks for the documented default page", async () => {
			const client = fakeClient();
			await dispatchTool("get_inbox_captures", { inboxId: "inbox_1" }, ctxWith(client));
			expect(forwarded(client, "getInboxCaptures")).toEqual([
				"inbox_1",
				DEFAULT_INBOX_CAPTURE_LIMIT,
				0,
				undefined,
			]);
		});

		test("a page beyond the tool's cap is refused, not clamped", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", limit: MAX_INBOX_CAPTURE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(String(MAX_INBOX_CAPTURE_LIMIT));
			expect(client.getInboxCaptures).not.toHaveBeenCalled();
		});

		test("non-positive pagination is refused", async () => {
			const client = fakeClient();
			for (const args of [
				{ inboxId: "inbox_1", limit: 0 },
				{ inboxId: "inbox_1", offset: -1 },
			]) {
				const res = await dispatchTool("get_inbox_captures", args, ctxWith(client));
				expect(res.isError).toBe(true);
			}
			expect(client.getInboxCaptures).not.toHaveBeenCalled();
		});

		test("a truncated page discloses what it left behind", async () => {
			const client = fakeClient({
				getInboxCaptures: vi
					.fn()
					.mockResolvedValue(page([{ id: 9, method: "POST" }], 400, 25)),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", offset: 25 },
				ctxWith(client)
			);
			expect(allText(res)).toMatch(/1 of 400 captures/);
			expect(allText(res)).toMatch(/offset: 26/);
		});

		test("a capture body past the inline bound is cut and says so", async () => {
			// A webhook can post megabytes; the engine stores up to
			// `inboxMaxBodyBytes` of it, which is configurable well past what a
			// tool result can carry (issue #767's case, arriving by another route).
			const body = "x".repeat(MAX_INLINE_BODY_BYTES + 500);
			const client = fakeClient({
				getInboxCaptures: vi.fn().mockResolvedValue(
					page([
						{ id: 1, method: "POST", body, bodyBytes: body.length },
						{ id: 2, method: "POST", body: "small", bodyBytes: 5 },
					])
				),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client)
			);
			const captures = (JSON.parse(firstText(res)) as { data: Record<string, unknown>[] })
				.data;
			expect((captures[0].body as string).length).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(captures[0].bodyTruncated).toBe(true);
			// The engine's own count of the original size survives the cut - a
			// smaller number here would look just as real and be wrong.
			expect(captures[0].bodyBytes).toBe(body.length);
			// Under the bound nothing is touched, flag included.
			expect(captures[1]).toEqual({ id: 2, method: "POST", body: "small", bodyBytes: 5 });
		});

		test("a base64 capture body is cut in decoded bytes and stays whole base64", async () => {
			// 3 bytes per 4 characters: bounding it as text would cut at 4/3 of the
			// limit and could end mid-quad, a string that no longer decodes (#3109).
			const bytes = Buffer.alloc(MAX_INLINE_BODY_BYTES + 3000, 0xff);
			const body = bytes.toString("base64");
			const client = fakeClient({
				getInboxCaptures: vi.fn().mockResolvedValue(
					page([
						{
							id: 1,
							method: "POST",
							body,
							bodyEncoding: "base64",
							bodyBytes: bytes.length,
							bodyTruncated: false,
						},
					])
				),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client)
			);
			const [capture] = (JSON.parse(firstText(res)) as { data: Record<string, unknown>[] })
				.data;
			// The marker an agent needs to know the body is not text survives the cut.
			expect(capture.bodyEncoding).toBe("base64");
			expect(capture.bodyTruncated).toBe(true);
			expect(capture.bodyBytes).toBe(bytes.length);
			const kept = Buffer.from(capture.body as string, "base64");
			expect(kept.length).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(kept.length).toBeGreaterThan(MAX_INLINE_BODY_BYTES - 3);
			expect(kept.toString("base64")).toBe(capture.body);
		});

		test("the description tells an agent that a body may be base64", () => {
			expect(descriptionOf(byName().get("get_inbox_captures"))).toMatch(
				/bodyEncoding.*base64/
			);
		});

		test("an unknown inbox is an engine error, not an empty page", async () => {
			const client = fakeClient({
				getInboxCaptures: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Inbox not found")
					),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "gone" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No inbox with id "gone"');
		});
	});

	describe("stop_webhook_inbox", () => {
		test("stops without the write toggle, and keeps the captures", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"stop_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBeFalsy();
			expect(client.stopInbox).toHaveBeenCalledWith("inbox_1", undefined);
			expect(client.deleteInbox).not.toHaveBeenCalled();
			// The distinction an agent has to be able to read off the tool list.
			expect(descriptionOf(byName().get("stop_webhook_inbox"))).toMatch(/NOT a delete/);
		});
	});

	describe("delete_webhook_inbox", () => {
		test("is refused while writes are off, without even reading the inbox", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1", confirmed: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.listInboxes).not.toHaveBeenCalled();
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});

		test("the preview names the real capture count and deletes nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("3 captured requests");
			expect(firstText(res)).toContain("http://127.0.0.1:45001");
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});

		test("an empty inbox says so rather than leaving the count unstated", async () => {
			const client = fakeClient({
				listInboxes: vi.fn().mockResolvedValue({
					data: [{ inboxId: "inbox_1", url: "http://127.0.0.1:45001", running: false }],
				}),
			});
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain("0 captured requests");
			expect(firstText(res)).toContain("stopped");
		});

		test("deletes once confirmed", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.deleteInbox).toHaveBeenCalledWith("inbox_1", undefined);
		});

		test("an id the engine does not list is an argument error, not a delete", async () => {
			const client = fakeClient({ listInboxes: vi.fn().mockResolvedValue({ data: [] }) });
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_gone", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("inbox_gone");
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});
	});

	describe("clear_inbox_captures", () => {
		test("is refused while writes are off", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"clear_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.clearInboxCaptures).not.toHaveBeenCalled();
		});

		test("clears with the toggle on, and needs no confirmation", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"clear_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.clearInboxCaptures).toHaveBeenCalledWith("inbox_1", undefined);
		});
	});

	describe("update_inbox_response", () => {
		test("sends only the named fields, so the rest keep their live values", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_inbox_response",
				{ inboxId: "inbox_1", status: 503, delayMs: 0 },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "updateInboxResponse")).toEqual([
				"inbox_1",
				{ status: 503, delayMs: 0 },
				undefined,
			]);
		});

		test("a patch naming no field is refused instead of reported as applied", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_inbox_response",
				{ inboxId: "inbox_1" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/status/);
			expect(client.updateInboxResponse).not.toHaveBeenCalled();
		});
	});

	describe("categories and hints", () => {
		test("the reads are reads, the listeners execute, and the two deletes write", () => {
			const tools = byName();
			expect(tools.get("list_webhook_inboxes")?.category).toBe("read");
			expect(tools.get("get_inbox_captures")?.category).toBe("read");
			expect(tools.get("start_webhook_inbox")?.category).toBe("execute");
			expect(tools.get("stop_webhook_inbox")?.category).toBe("execute");
			expect(tools.get("update_inbox_response")?.category).toBe("execute");
			// Both destroy recorded data, so both sit behind the write toggle.
			expect(tools.get("delete_webhook_inbox")?.category).toBe("write");
			expect(tools.get("clear_inbox_captures")?.category).toBe("write");
			expect(tools.get("delete_webhook_inbox")?.annotations.destructiveHint).toBe(true);
			expect(tools.get("clear_inbox_captures")?.annotations.destructiveHint).toBe(true);
			// A stop loses nothing, and neither reaches off the machine.
			expect(tools.get("stop_webhook_inbox")?.annotations.destructiveHint).toBe(false);
			for (const name of [
				"start_webhook_inbox",
				"list_webhook_inboxes",
				"stop_webhook_inbox",
				"delete_webhook_inbox",
				"get_inbox_captures",
				"clear_inbox_captures",
				"update_inbox_response",
			]) {
				expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			}
		});

		test("no tool offers the live SSE stream - polling the captures is the shape", () => {
			// Single-watcher engine-side (a second is a 409), and the app's own
			// inbox tab may hold it. Locked as a decision rather than an omission.
			expect(
				TOOLS.map((t) => t.name).filter((n) => /inbox.*live|live.*inbox/.test(n))
			).toEqual([]);
			expect(descriptionOf(byName().get("get_inbox_captures"))).toMatch(/no live stream/i);
		});
	});
});
