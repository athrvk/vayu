/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { EngineRequestError } from "../engine-client.js";
import { fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/*
 * The collection mock server (#757). The engine has served `/mock/*` since #481
 * and the UI has driven it since 0.16.0; these four tools are what let an agent
 * asked to "stand up the API this client expects" do it from the collection's
 * own saved examples rather than writing a stub server.
 */
describe("mock server tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));

	test("start and stop are execute, the reads are read, and none opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_server")?.category).toBe("execute");
		expect(tools.get("stop_mock_server")?.category).toBe("execute");
		expect(tools.get("list_mock_servers")?.category).toBe("read");
		expect(tools.get("get_mock_routes")?.category).toBe("read");
		expect(tools.get("get_mock_activity")?.category).toBe("read");
		for (const name of [
			"start_mock_server",
			"stop_mock_server",
			"list_mock_servers",
			"get_mock_routes",
			"get_mock_activity",
		]) {
			// Loopback-only by engine contract (`listener.start ("127.0.0.1", …)`),
			// so a cautious client must not be told these reach an open world.
			expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			// A mock serves stored examples and records nothing, so a stop loses
			// nothing that was not recreatable by starting it again.
			expect(tools.get(name)?.annotations.destructiveHint, name).toBeFalsy();
		}
	});

	test("the mutating ones invalidate the services family, the reads stay silent", () => {
		expect(byName().get("start_mock_server")?.invalidates).toEqual(["service"]);
		expect(byName().get("stop_mock_server")?.invalidates).toEqual(["service"]);
		expect(byName().get("list_mock_servers")?.invalidates).toEqual([]);
		expect(byName().get("get_mock_routes")?.invalidates).toEqual([]);
		expect(byName().get("get_mock_activity")?.invalidates).toEqual([]);
	});

	test("start sends the collection plus only the knobs the caller named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1", latencyMs: 250 },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startMockServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An absent knob stays absent: the engine reads a present one with a bad
		// value as a 400 rather than falling back to its default.
		expect(payload).toEqual({ collectionId: "col_1", latencyMs: 250 });
		expect(Object.keys(payload as object)).not.toContain("port");
		expect(Object.keys(payload as object)).not.toContain("errorRatePct");
		// Absent means the engine's any-origin default; a `[]` the caller never
		// wrote would be a policy statement they did not make.
		expect(Object.keys(payload as object)).not.toContain("allowedOrigins");
		const body = JSON.parse(firstText(res)) as Record<string, unknown>;
		expect(body.mockId).toBe("mock_1");
		expect(body.url).toBe("http://127.0.0.1:45010");
		expect(body.routeCount).toBe(4);
	});

	test("start forwards every knob under the engine's own names", async () => {
		const client = fakeClient();
		const args = {
			collectionId: "col_1",
			port: 45010,
			latencyMs: 100,
			errorRatePct: 25,
			allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
		};
		const res = await dispatchTool("start_mock_server", args, ctxWith(client));
		expect(res.isError).toBeFalsy();
		// Keyed exactly as `parse_mock_start` reads them - a rename here is a knob
		// the engine silently ignores while the tool reports it applied.
		expect((client.startMockServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(args);
	});

	test("start refuses a missing collection before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("start_mock_server", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/collectionId/);
		expect(client.startMockServer).not.toHaveBeenCalled();
	});

	test("a mock whose routes have no examples says so, instead of leaving it in the JSON", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_2",
				url: "http://127.0.0.1:45011",
				routeCount: 5,
				routesWithoutExample: 3,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// "It started" and "it can answer" are different answers, and only the
		// second is what was asked for - three of five routes answer 501 here.
		const caveat = res.content.map((c) => c.text).join("\n");
		expect(caveat).toMatch(/3 of 5 route\(s\) have no saved example/);
		expect(caveat).toMatch(/501/);
	});

	test("a mock with no routes at all gets the sharper caveat", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_3",
				url: "http://127.0.0.1:45012",
				routeCount: 0,
				routesWithoutExample: 0,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_empty" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/serves no routes/);
		expect(text).toMatch(/404/);
	});

	test("a mock with shadowed requests says which ones never answer (#3115)", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_4",
				url: "http://127.0.0.1:45013",
				routeCount: 5,
				routesWithoutExample: 0,
				duplicateRoutes: 2,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/2 request\(s\) share a method and path/);
		expect(text).toMatch(/get_mock_routes/);
		expect(text).not.toMatch(/no saved example/);
	});

	test("missing examples and shadowed requests are both reported", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_5",
				url: "http://127.0.0.1:45014",
				routeCount: 5,
				routesWithoutExample: 1,
				duplicateRoutes: 1,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/1 of 5 route\(s\) have no saved example/);
		expect(text).toMatch(/1 request\(s\) share a method and path/);
	});

	test("a fully-exampled mock gets no caveat at all", async () => {
		// The mutation check for the two above: with nothing to warn about, the
		// result is the engine's record and nothing else.
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(fakeClient())
		);
		expect(res.isError).toBeFalsy();
		expect(res.content).toHaveLength(1);
	});

	test("list and routes round-trip the engine's envelopes", async () => {
		const running = {
			data: [
				{
					mockId: "mock_1",
					collectionId: "col_1",
					collectionName: "API",
					url: "http://127.0.0.1:45010",
					port: 45010,
					routeCount: 4,
				},
			],
		};
		const client = fakeClient({ listMockServers: vi.fn().mockResolvedValue(running) });
		const listed = await dispatchTool("list_mock_servers", {}, ctxWith(client));
		expect(listed.isError).toBeFalsy();
		expect(JSON.parse(firstText(listed))).toEqual(running);

		const routes = await dispatchTool("get_mock_routes", { mockId: "mock_1" }, ctxWith(client));
		expect(routes.isError).toBeFalsy();
		expect(client.getMockServerRoutes).toHaveBeenCalledWith("mock_1", undefined);
		// The has-example flag is the whole point of the table - it is what says
		// which routes answer 501 rather than a body.
		const table = JSON.parse(firstText(routes)) as { data: Array<Record<string, unknown>> };
		expect(table.data[0].hasExample).toBe(true);
		expect(table.data[0].path).toBe("/users");
	});

	test("routes refuses an empty id before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_mock_routes", { mockId: "" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.getMockServerRoutes).not.toHaveBeenCalled();
	});

	/**
	 * The engine route pages by `limit` alone and keeps 200 entries, so the tool
	 * always reads the whole ring and slices it: `offset` and the envelope are
	 * this layer's.
	 */
	describe("get_mock_activity paging", () => {
		/** 120 entries, newest first: `p119` ... `p0`. */
		const ring = Array.from({ length: 120 }, (_, i) => ({
			at_ms: 120 - i,
			method: "GET",
			path: `/p${119 - i}`,
			status: 200,
		}));
		const ringClient = () =>
			fakeClient({ getMockServerActivity: vi.fn().mockResolvedValue({ data: ring }) });
		const pageOf = async (args: Record<string, unknown>, client = ringClient()) => {
			const res = await dispatchTool(
				"get_mock_activity",
				{ mockId: "mock_1", ...args },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			return JSON.parse(firstText(res)) as {
				data: { path: string }[];
				pagination: Record<string, unknown>;
			};
		};

		test("reads the whole 200-entry ring whatever the limit, and defaults to 50 entries", async () => {
			const client = ringClient();
			const page = await pageOf({}, client);
			expect(client.getMockServerActivity).toHaveBeenCalledWith("mock_1", 200, undefined);
			expect(page.data).toHaveLength(50);
			expect(page.data[0].path).toBe("/p119");
			expect(page.pagination).toMatchObject({
				total: 120,
				limit: 50,
				offset: 0,
				returned: 50,
				hasMore: true,
				nextOffset: 50,
			});
			expect(page.pagination.note).toMatch(/offset: 50/);

			const limited = ringClient();
			await pageOf({ limit: 10 }, limited);
			expect(limited.getMockServerActivity).toHaveBeenCalledWith("mock_1", 200, undefined);
		});

		test("offset skips from the newest entry and the last page says it is the last", async () => {
			const second = await pageOf({ limit: 50, offset: 50 });
			expect(second.data.map((e) => e.path)).toEqual(ring.slice(50, 100).map((e) => e.path));
			expect(second.pagination).toMatchObject({ offset: 50, returned: 50, hasMore: true });

			const last = await pageOf({ limit: 50, offset: 100 });
			expect(last.data).toHaveLength(20);
			expect(last.pagination).toMatchObject({
				total: 120,
				offset: 100,
				returned: 20,
				hasMore: false,
				nextOffset: null,
			});
			expect(last.pagination.note).toBeUndefined();

			const past = await pageOf({ offset: 500 });
			expect(past.data).toEqual([]);
			expect(past.pagination).toMatchObject({ total: 120, returned: 0, hasMore: false });
		});

		test("an empty ring is an empty page, not a missing envelope", async () => {
			const page = await pageOf({}, fakeClient());
			expect(page.data).toEqual([]);
			expect(page.pagination).toMatchObject({ total: 0, returned: 0, hasMore: false });
		});

		test.each([
			[{ limit: 201 }, /"limit" must be 200 or less/],
			[{ limit: 0 }, /"limit" must be a whole number greater than 0/],
			[{ offset: -1 }, /"offset" must be a whole number of 0 or more/],
			[{ offset: 1.5 }, /"offset" must be a whole number of 0 or more/],
		])("refuses %j without calling the engine", async (args, message) => {
			const client = ringClient();
			const res = await dispatchTool(
				"get_mock_activity",
				{ mockId: "mock_1", ...args },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(message);
			expect(client.getMockServerActivity).not.toHaveBeenCalled();
		});

		test("the page validates against the declared output schema", async () => {
			const res = await dispatchTool(
				"get_mock_activity",
				{ mockId: "mock_1", limit: 5 },
				ctxWith(ringClient())
			);
			const tool = TOOLS.find((t) => t.name === "get_mock_activity")!;
			expect(() => tool.outputSchema!.parse(res.structuredContent)).not.toThrow();
		});
	});

	test("activity surfaces an unknown mock id as a tool error", async () => {
		const gone = fakeClient({
			getMockServerActivity: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock server not found")
				),
		});
		const res = await dispatchTool("get_mock_activity", { mockId: "mock_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No mock server with id "mock_9"');
	});

	test("stop names the mock, and an unknown id is an error rather than a shrug", async () => {
		const client = fakeClient();
		const ok = await dispatchTool("stop_mock_server", { mockId: "mock_1" }, ctxWith(client));
		expect(ok.isError).toBeFalsy();
		expect(client.stopMockServer).toHaveBeenCalledWith("mock_1", undefined);

		const gone = fakeClient({
			stopMockServer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock server not found")
				),
		});
		const res = await dispatchTool("stop_mock_server", { mockId: "mock_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No mock server with id "mock_9"');
		expect(firstText(res)).toContain("list_mock_servers");
	});

	test("the schema refuses a malformed knob before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_server")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.port.safeParse(70000).success).toBe(false);
		expect(shape.port.safeParse(0).success).toBe(true);
		// A percentage is 0-100 by definition rather than by an engine constant,
		// which is why this bound lives here and `latencyMs`'s ceiling does not.
		expect(shape.errorRatePct.safeParse(101).success).toBe(false);
		expect(shape.errorRatePct.safeParse(100).success).toBe(true);
		expect(shape.latencyMs.safeParse(-1).success).toBe(false);
		// The origin list's shape is the schema's; what makes an entry an origin,
		// and how many may be listed, is the engine's to refuse by name.
		expect(shape.allowedOrigins.safeParse(["https://app.example.com"]).success).toBe(true);
		expect(shape.allowedOrigins.safeParse([]).success).toBe(true);
		expect(shape.allowedOrigins.safeParse("https://app.example.com").success).toBe(false);
		expect(shape.allowedOrigins.safeParse([42]).success).toBe(false);
		// The collection is the one thing a mock cannot be started without.
		expect(argumentsSchema(shape).safeParse({}).success).toBe(false);
		expect(argumentsSchema(shape).safeParse({ collectionId: "col_1" }).success).toBe(true);
	});

	/*
	 * The gating matrix, for the same reason the issuer block carries one: a mock
	 * is loopback-only by engine contract, so neither the allowlist (which exists
	 * to stop an agent generating traffic against third parties) nor the write
	 * toggle (which gates saved data - a mock only reads it) applies.
	 */
	test("neither the empty allowlist nor the write toggle gates them", async () => {
		const client = fakeClient();
		const locked = ctxWith(client, { allowlist: [], allowAll: false, allowWrites: false });
		for (const [tool, args] of [
			["start_mock_server", { collectionId: "col_1" }],
			["list_mock_servers", {}],
			["get_mock_routes", { mockId: "mock_1" }],
			["get_mock_activity", { mockId: "mock_1" }],
			["stop_mock_server", { mockId: "mock_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, locked);
			expect(res.isError, tool).toBeFalsy();
		}
		expect(client.startMockServer).toHaveBeenCalled();
		expect(client.stopMockServer).toHaveBeenCalled();
	});

	test("the per-tool switch is what turns them off", async () => {
		const client = fakeClient();
		const off = ctxWith(client, {
			disabledTools: [
				"start_mock_server",
				"list_mock_servers",
				"get_mock_routes",
				"get_mock_activity",
				"stop_mock_server",
			],
		});
		for (const [tool, args] of [
			["start_mock_server", { collectionId: "col_1" }],
			["list_mock_servers", {}],
			["get_mock_routes", { mockId: "mock_1" }],
			["get_mock_activity", { mockId: "mock_1" }],
			["stop_mock_server", { mockId: "mock_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/is disabled\..*Vayu Settings → MCP/);
		}
		expect(client.startMockServer).not.toHaveBeenCalled();
		expect(client.stopMockServer).not.toHaveBeenCalled();
	});

	test("an agent stands up a mock, reads its table and points a request at it", async () => {
		// The owner scenario from #481, through the MCP layer: start a mock for a
		// collection, confirm what it serves, send to it, stop it.
		const client = fakeClient();
		const ctx = ctxWith(client, { allowlist: ["127.0.0.1"] });

		const started = await dispatchTool("start_mock_server", { collectionId: "col_1" }, ctx);
		expect(started.isError).toBeFalsy();
		const { mockId, url } = JSON.parse(firstText(started)) as { mockId: string; url: string };

		const routes = await dispatchTool("get_mock_routes", { mockId }, ctx);
		expect(routes.isError).toBeFalsy();
		const { data } = JSON.parse(firstText(routes)) as { data: Array<{ path: string }> };

		const sent = await dispatchTool(
			"run_request",
			{ method: "GET", url: `${url}${data[0].path}` },
			ctx
		);
		expect(sent.isError).toBeFalsy();
		expect((client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].url).toBe(
			"http://127.0.0.1:45010/users"
		);

		const stopped = await dispatchTool("stop_mock_server", { mockId }, ctx);
		expect(stopped.isError).toBeFalsy();
		expect(client.stopMockServer).toHaveBeenCalledWith("mock_1", undefined);
	});
});
