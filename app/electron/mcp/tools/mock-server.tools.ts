/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file mock-server.tools.ts
 * @brief Mock servers: start, list, routes, activity and stop.
 */

import { z } from "zod";
import { runOutputShape, withheldPointer } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	callEngineStructured,
	engineErrorResult,
	jsonResult,
	requireStr,
	withCaveat,
} from "./kit.js";
import { ID_KINDS } from "./failure.js";
import { mockActivitySchema, mockRoutesSchema, mockServerListSchema } from "./output-schemas.js";
import { mockServerCaveat, mockServerStartPayload } from "./mock-server.js";

export const MOCK_SERVER_TOOLS: McpTool[] = [
	{
		name: "start_mock_server",
		category: "execute",
		retry: { check: "list_mock_servers", noun: "mock server" },
		invalidates: ["service"],
		notFound: { ...ID_KINDS.collection, idArg: "collectionId" },
		description:
			"Start a local mock server that answers a collection's saved examples, and return its id and base URL. Use it to stand up the API a client under test expects without that API existing: point the client at the returned url and every request whose method and path match a saved request in the collection gets that request's example back - status, headers and body. A route whose request has no saved example answers 501, and a path that matches nothing answers 404, so the returned routeCount and routesWithoutExample are what say whether the mock is usable; get_mock_routes lists them. latencyMs and errorRatePct are how a client's timeout and retry handling get exercised - errorRatePct injects synthesized 500s at that rate. It needs no allowlist entry: the engine binds every mock to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. Which browser pages may read its answers is separate: by default any page can, without credentials, and allowedOrigins narrows that to the listed origins, with credentials. Stop it with stop_mock_server when you are done; a mock keeps its port until then.",
		annotations: {
			title: "Start mock server",
			readOnlyHint: false,
			// A loopback listener over data it only reads: it destroys nothing and
			// reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection whose saved examples the mock serves (from list_collections). Its sub-collections are included."
				),
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			latencyMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Artificial delay before every answer, in milliseconds (default 0). Use it to make a client's timeout handling fire."
				),
			errorRatePct: z
				.number()
				.int()
				.min(0)
				.max(100)
				.optional()
				.describe(
					"Percentage of answers replaced with a synthesized 500 (default 0). 0 and 100 are exact; in between it is a per-request roll."
				),
			allowedOrigins: z
				.array(z.string())
				.optional()
				.describe(
					'Browser origins allowed to read the mock\'s answers, e.g. ["https://app.example.com"]: only those pages get CORS headers, with credentials. Omit or leave empty (the default) for any origin, without credentials. Each is http:// or https:// plus a host and optional port - no path, trailing slash, wildcard or "null" - at most 32 of them. A bad entry is refused by name. Fixed for the mock\'s life.'
				),
		},
		handler: async (args, ctx, signal) => {
			const payload = mockServerStartPayload(args);
			let started: unknown;
			try {
				started = await ctx.client.startMockServer(payload, signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			// The caveat rides on the result rather than being left in the JSON:
			// "the mock started" and "the mock can answer" are different answers,
			// and only the second one is what the agent asked for. Read off the
			// engine's reply, which is why this is `pagedRead`'s shape rather
			// than a plain `callEngine`.
			return withCaveat(jsonResult(started), mockServerCaveat(started));
		},
	},
	{
		name: "list_mock_servers",
		category: "read",
		invalidates: [],
		description:
			"List the mock servers running right now, each with its id, the collection it serves and that collection's name, its base URL and port, its latency and error-rate knobs, its allowedOrigins, and how many routes it has. A stopped mock is gone rather than listed - its record dies with its listener - so this is also how to confirm one stopped.",
		annotations: {
			title: "List mock servers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: mockServerListSchema,
		handler: (_args, ctx, signal) =>
			callEngineStructured(ctx, () => ctx.client.listMockServers(signal)),
	},
	{
		name: "get_mock_routes",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.mockServer, idArg: "mockId" },
		description:
			"List the routes one mock server is serving: method, path template, the saved request behind each, and whether that request has an example (hasExample false means the route answers 501). This is how 'the mock answers 404' gets diagnosed without sending a request per guess. The table is a snapshot taken when the mock started and cannot change under it - editing the collection means restarting the mock - so a second read answers the same thing. Each row also carries `mode` (the request's mockResponseMode), `exampleName` (which saved example it currently answers with, when resolvable), and `hits` (how many times this route has been served since the mock started) - the last one does change under repeated reads, unlike the rest of the table.",
		annotations: {
			title: "Get mock server routes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID (from start_mock_server)."),
		},
		outputSchema: mockRoutesSchema,
		handler: (args, ctx, signal) =>
			callEngineStructured(ctx, () =>
				ctx.client.getMockServerRoutes(requireStr(args, "mockId"), signal)
			),
	},
	{
		name: "get_mock_activity",
		category: "read",
		retry: "safe",
		invalidates: [],
		notFound: { ...ID_KINDS.mockServer, idArg: "mockId" },
		description: (config) =>
			"What one mock server has served, newest first: method, path, the matched request and example (or unmatched/no-example), status, and whether the response was an injected failure. Discarded when the mock stops, like get_mock_routes' table - a fresh get_mock_activity right after start_mock_server is always empty." +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Get mock server activity",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID (from start_mock_server)."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("At most this many entries (default 50, max 200)."),
		},
		outputSchema: mockActivitySchema,
		handler: async (args, ctx, signal) => {
			const limit = args.limit as number | undefined;
			const mockId = requireStr(args, "mockId");
			return callEngineStructured(
				ctx,
				() => ctx.client.getMockServerActivity(mockId, limit ?? 50, signal),
				await runOutputShape(ctx, signal)
			);
		},
	},
	{
		name: "stop_mock_server",
		category: "execute",
		invalidates: ["service"],
		notFound: { ...ID_KINDS.mockServer, idArg: "mockId" },
		description:
			"Stop a running mock server and free its port. Unlike a webhook inbox there is nothing left to read afterwards - a mock records nothing, so its record goes with its listener and it disappears from list_mock_servers. Requests sent to the URL after this are refused by the machine. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock server",
			readOnlyHint: false,
			// Nothing recorded is lost: a mock serves stored examples and keeps no
			// state of its own.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID to stop (from start_mock_server)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.stopMockServer(requireStr(args, "mockId"), signal)),
	},
];
