/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file safety.tools.ts
 * @brief `get_safety_config`: the session's own limits, readable before an
 *        agent acts rather than discovered one refusal at a time (#2444).
 */

import type { McpTool } from "./contract.js";
import { structuredResult } from "./kit.js";
import { safetyConfigSchema } from "./output-schemas.js";

export const SAFETY_TOOLS: McpTool[] = [
	{
		name: "get_safety_config",
		category: "read",
		invalidates: [],
		description:
			"Vayu's safety limits for this session, so a load profile or a target is chosen inside them instead of being refused one cap at a time. Returns `allowlist` (`allowAll` and the permitted `hosts`), `caps` (`maxRps`, `maxConcurrency`, `maxDurationSeconds`, `maxIterations`), `gates` (`allowWrites`, `allowNetworkSettings`, `revealSecretsToAgents`, each on or off) and `disabledToolCount`. Reads the session's configuration only: no network call, no secret value, and the user changes these limits, never a tool.",
		annotations: {
			title: "Get the safety limits",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: safetyConfigSchema,
		handler: async (_args, ctx) => {
			const { config } = ctx;
			return structuredResult({
				allowlist: { allowAll: config.allowAll, hosts: [...config.allowlist] },
				caps: {
					maxRps: config.maxRps,
					maxConcurrency: config.maxConcurrency,
					maxDurationSeconds: config.maxDurationSeconds,
					maxIterations: config.maxIterations,
				},
				gates: {
					allowWrites: config.allowWrites,
					allowNetworkSettings: config.allowNetworkSettings,
					revealSecretsToAgents: config.revealSecretsToAgents,
				},
				disabledToolCount: config.disabledTools.length,
			});
		},
	},
];
