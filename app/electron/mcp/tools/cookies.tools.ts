/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file cookies.tools.ts
 * @brief The engine's cookie jar: reading and clearing it.
 */

import { z } from "zod";
import { secretsShape, WITHHELD_COOKIE_SENTENCE, withholdCookieValues } from "../withhold.js";
import type { McpTool } from "./contract.js";
import { callEngine, errorResult, str, writesDisabled } from "./kit.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const COOKIE_TOOLS: McpTool[] = [
	{
		name: "get_cookies",
		category: "read",
		invalidates: [],
		description:
			"Read the design-mode cookie jars - one entry per environment that holds anything, plus the jar used when no environment is selected, each cookie with its name, value, domain, path, secure/httpOnly flags and expiry. This is how 'why is this request already authenticated' gets answered: run_request and run_collection_smoke send through these jars and store what comes back, and the same jars serve the user's own sends in that environment. " +
			WITHHELD_COOKIE_SENTENCE,
		annotations: {
			title: "Get cookie jars",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				ctx,
				() => ctx.client.getCookies(signal),
				secretsShape(ctx, withholdCookieValues)
			),
	},
	{
		name: "clear_cookies",
		category: "write",
		invalidates: ["cookie"],
		description:
			"Drop stored cookies, so the next request starts a fresh session. Omit environmentId to clear every jar, pass an id to clear that environment's, or pass null to clear the jar used when no environment is selected. Returns how many cookies were dropped. No confirmation: nothing saved is lost, only session state a re-login restores. " +
			GUARDED_WRITE_SENTENCE +
			".",
		annotations: {
			title: "Clear cookie jars",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					'Scope to clear: an environment ID for that environment\'s jar, null for the no-environment jar, or omitted for every jar. Omitting and passing null are different calls - "all" and "the unnamed one".'
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			// Null, not falsy: `null` is a scope of its own here (the jar no
			// environment id can name), so it has to stay distinguishable from an
			// absent argument all the way to the query string.
			const stated = args.environmentId;
			if (stated !== undefined && stated !== null && typeof stated !== "string") {
				return errorResult(
					'"environmentId" must be an environment ID, null for the no-environment jar, or omitted for every jar.'
				);
			}
			const scope: string | null | undefined =
				stated === null ? null : str(args, "environmentId");
			return callEngine(ctx, () => ctx.client.clearCookies(scope, signal));
		},
	},
];
