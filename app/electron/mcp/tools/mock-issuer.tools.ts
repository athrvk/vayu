/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file mock-issuer.tools.ts
 * @brief The local mock OAuth 2.0 issuer: start, list, stop and update.
 */

import { z } from "zod";
import type { McpTool } from "./contract.js";
import { callEngine, requireStr, ToolArgError } from "./kit.js";
import {
	MOCK_ISSUER_FAILURE_MODES,
	mockIssuerPatchPayload,
	mockIssuerStartPayload,
} from "./mock-issuer.js";

export const MOCK_ISSUER_TOOLS: McpTool[] = [
	{
		name: "start_mock_issuer",
		category: "execute",
		// #502's Services drawer reads the issuer list and #756 added the
		// `service` entity; #757 is where the issuer tools take it, so an
		// MCP-started issuer appears without waiting out the drawer's poll.
		invalidates: ["service"],
		description:
			"Start a local OAuth 2.0 mock issuer and return its id, token URL, authorize URL and signing key. Use it to test an auth flow offline: start an issuer, point a request's oauth2 auth at the returned tokenUrl, run it with run_request, and assert on what the target received - no real identity provider, so no 2FA prompts, provider rate limits or account lockouts in the loop. It needs no allowlist entry: the engine binds every issuer to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. The access token is an HS256 JWT signed with the returned signingKey - hand that key to the service under test and it can verify the mock's tokens. Set a short expiresInSeconds (with issueRefreshTokens) to exercise the 401-then-refresh path, and failureMode to exercise retry handling. At most 8 issuers run at once; stop yours with stop_mock_issuer when you are done.",
		annotations: {
			title: "Start mock OAuth issuer",
			readOnlyHint: false,
			// It binds a loopback listener and mints tokens for it: it destroys no
			// saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			expiresInSeconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Lifetime of a minted access token, in seconds (default 3600). Set it low to make a token expire mid-test."
				),
			claims: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Extra JWT claims, e.g. {"sub": "alice", "roles": ["admin"]}. iss, iat, exp and jti are always the issuer\'s own; sub, client_id and scope are filled in only when you do not set them.'
				),
			clients: z
				.array(
					z.object({
						clientId: z.string().min(1).describe("Client id this issuer accepts."),
						clientSecret: z
							.string()
							.optional()
							.describe("Secret that client must then present."),
					})
				)
				.optional()
				.describe(
					"Clients the issuer accepts. Omit (the default) to accept any client id."
				),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token misbehaves: "none" (default), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401).'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe('Delay before /token answers, in milliseconds. Only "slow" reads it.'),
			issueRefreshTokens: z
				.boolean()
				.optional()
				.describe(
					"Return a refresh_token alongside the access token, so a refresh grant can be tested. A refresh rotates its token - the presented one is spent."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.startMockIssuer(mockIssuerStartPayload(args), signal)),
	},
	{
		name: "list_mock_issuers",
		category: "read",
		invalidates: [],
		description:
			"List the OAuth 2.0 mock issuers running right now, each with its id, urls, signing key, port, token expiry, failure mode and configured client count. Use it to find an issuer started earlier in the session, or to confirm one was stopped.",
		annotations: {
			title: "List mock OAuth issuers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(ctx, () => ctx.client.listMockIssuers(signal)),
	},
	{
		name: "stop_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a running OAuth 2.0 mock issuer and free its port. Tokens it already minted stay valid until they expire - nothing verifies them against the issuer once it is gone. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock OAuth issuer",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to stop (from start_mock_issuer)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.stopMockIssuer(requireStr(args, "issuerId"), signal)),
	},
	{
		name: "update_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change how a running OAuth 2.0 mock issuer's /token endpoint behaves, live: its failure mode and its slow-mode delay. Use it to walk a client through a sequence - mint a token against a healthy issuer, flip it to server_error to see the retry, flip it back - without stopping the issuer, which would invalidate the token URL the request under test is already pointed at and change the signing key. This is a merge-patch: a field you omit keeps its current value. Only these two settings can change under a running issuer; the port, client list, claims and refresh-token setting are fixed when it starts, and asking to change one is an error telling you to start a new issuer.",
		annotations: {
			title: "Update mock OAuth issuer",
			readOnlyHint: false,
			// It rewrites two settings of a loopback listener; nothing recorded is
			// lost and the same patch applied twice is the same issuer.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to update (from start_mock_issuer)."),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token should misbehave from now on: "none" (healthy), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401). Omit to leave it unchanged.'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'New delay before /token answers, in milliseconds (engine cap 60000). Only "slow" reads it. Omit to leave it unchanged.'
				),
		},
		handler: (args, ctx, signal) => {
			const issuerId = requireStr(args, "issuerId");
			const patch = mockIssuerPatchPayload(args);
			if (Object.keys(patch).length === 0) {
				// The engine accepts an empty patch and changes nothing, so a
				// success here would report a call that did not do what it was
				// asked - the `update_inbox_response` precedent.
				throw new ToolArgError('Name at least one of "failureMode" or "slowMs" to change.');
			}
			return callEngine(ctx, () => ctx.client.updateMockIssuer(issuerId, patch, signal));
		},
	},
];
