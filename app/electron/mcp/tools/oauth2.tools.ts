/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file oauth2.tools.ts
 * @brief The OAuth 2.0 token cache: fetch, status and clear.
 */

import { z } from "zod";
import { checkAllowlist } from "../safety.js";
import type { McpTool } from "./contract.js";
import { callEngine, errorResult, isRecord, requireStr, str, writesDisabled } from "./kit.js";
import {
	OAUTH2_INTERACTIVE_REFUSAL,
	oauth2CacheKeyInput,
	oauth2ConfigInput,
	projectOAuth2Status,
	projectOAuth2Token,
} from "./oauth2.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const OAUTH2_TOOLS: McpTool[] = [
	{
		name: "fetch_oauth2_token",
		category: "execute",
		invalidates: ["oauth"],
		description:
			"Acquire an OAuth 2.0 token for a client_credentials or password config and cache it engine-side, so the next run_request / start_load_run carrying the same config authenticates without a round trip - and so a token problem surfaces here, named, instead of as a wall of 401s inside a run. Pass `force: true` to refresh a token that is cached but stale. The interactive authorization_code grant is refused: it needs a browser and a loopback redirect the app owns, so authorize it there once and the cache this tool reads is the same one. GUARDED: the token endpoint's host must be on Vayu's MCP allowlist. The access token itself is never returned - what comes back is the cache entry's shape (key, type, scope, expiry, whether a refresh token came with it), because the engine applies the token to requests and nothing an agent does with the bearer needs its bytes.",
		annotations: {
			title: "Fetch OAuth 2.0 token",
			readOnlyHint: false,
			// It contacts a third party and writes a credential into the engine's
			// cache, replacing whatever was there for that key.
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			config: oauth2ConfigInput,
			force: z
				.boolean()
				.optional()
				.describe(
					"Refresh even when a valid token is cached. The engine uses the stored refresh token when the config allows it and falls back to a fresh grant. Default false - a cached, unexpired token is returned as-is."
				),
		},
		handler: async (args, ctx, signal) => {
			const config = isRecord(args.config) ? args.config : undefined;
			if (!config) return errorResult('"config" must be an OAuth 2.0 config object.');
			const grantType = str(config, "grantType");
			if (grantType === "authorization_code") {
				return errorResult(OAUTH2_INTERACTIVE_REFUSAL);
			}
			// Both URLs the engine may post to. The refresh URL defaults to the
			// token URL engine-side, so it is only checked when it names a
			// different host - a gate that read one of the two would be a gate a
			// config can walk around.
			for (const key of ["accessTokenUrl", "refreshTokenUrl"]) {
				const url = str(config, key);
				if (url === undefined || url === "") continue;
				const gate = checkAllowlist(url, ctx.config, ctx.host);
				if (!gate.ok) return errorResult(`${key}: ${gate.error!}`);
			}
			const payload: Record<string, unknown> = { config };
			if (args.force === true) payload.force = true;
			return callEngine(
				ctx,
				() => ctx.client.fetchOAuth2Token(payload, signal),
				(answer) => projectOAuth2Token(answer)
			);
		},
	},
	{
		name: "get_oauth2_token_status",
		category: "read",
		invalidates: [],
		description:
			"Ask whether a token is cached for a cache key, and whether it has expired - the read behind 'is this flow failing because the token went stale?'. The cache key is the `cacheKey` fetch_oauth2_token returned; the engine derives it from the token URL, client id, credentials id and (for password grants) the username, so configs differing only in scope share one entry. An absent entry is an answer (`found: false`), not an error. The access token is never returned, only the shape of the entry - see fetch_oauth2_token.",
		annotations: {
			title: "OAuth 2.0 token status",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: (args, ctx, signal) =>
			callEngine(
				ctx,
				() => ctx.client.getOAuth2TokenStatus(requireStr(args, "cacheKey"), signal),
				(answer) => projectOAuth2Status(answer)
			),
	},
	{
		name: "clear_oauth2_token",
		category: "write",
		invalidates: ["oauth"],
		description:
			"Drop the cached token for a cache key, so the next request that uses that config acquires a fresh one - the tool equivalent of the auth tab's Clear button. Use it when a provider has revoked or rotated credentials and the cache is still serving the old token. Idempotent: clearing a key nothing is cached under reports `deleted: false` rather than failing. No confirmation - nothing saved is lost, only a credential a re-fetch restores. " +
			GUARDED_WRITE_SENTENCE +
			".",
		annotations: {
			title: "Clear OAuth 2.0 token",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			return callEngine(ctx, () =>
				ctx.client.clearOAuth2Token(requireStr(args, "cacheKey"), signal)
			);
		},
	},
];
