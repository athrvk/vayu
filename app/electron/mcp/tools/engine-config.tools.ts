/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file engine-config.tools.ts
 * @brief `update_engine_config`, the write half of the engine config; the read,
 *        `get_engine_config`, sits with the other reads in `reads.tools.ts`.
 */

import { z } from "zod";
import { secretsShape, withholdConfigCredentials } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	GUARDED_WRITE_SENTENCE,
	NETWORK_SETTINGS_TOKEN,
	RESTART_ENGINE_TOKEN,
	engineRestartRemedy,
	settingRemedy,
} from "../remedy.js";
import { engineErrorResult, errorResult } from "./kit.js";
import { configUpdateSchema, isNetworkConfigKey, restartRequiredAmong } from "./output-schemas.js";

export const ENGINE_CONFIG_TOOLS: McpTool[] = [
	{
		name: "update_engine_config",
		category: "write",
		invalidates: ["config"],
		description:
			"Update one or more engine configuration entries. " +
			GUARDED_WRITE_SENTENCE +
			", and the network entries - every `proxy*` key and `customCaCertificates` - additionally require Network settings (to enable them, " +
			NETWORK_SETTINGS_TOKEN +
			"); a batch naming one without it is refused whole. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine RESTART to take effect - the result lists those under `restartRequired`; they are saved but the running engine keeps the old value until the user restarts it (" +
			RESTART_ENGINE_TOKEN +
			").",
		annotations: {
			title: "Update engine config",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entries: z
				.record(z.string(), z.string())
				.describe('Map of config key to new value, e.g. { "workers": "8" }.'),
		},
		outputSchema: configUpdateSchema,
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					`Config writes are disabled. To allow this, ask the user to ${settingRemedy("allowWrites", ctx.host)}.`
				);
			}
			const entries = args.entries;
			if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
				return errorResult('"entries" must be an object mapping config keys to values.');
			}
			const network = Object.keys(entries).filter(isNetworkConfigKey);
			if (network.length > 0 && !ctx.config.allowNetworkSettings) {
				return errorResult(
					`Network settings are not open to agents: ${network.join(", ")} decide where every request goes and which certificate authorities Vayu trusts, so they need Network settings turned on as well as write access: ask the user to ${settingRemedy("allowNetworkSettings", ctx.host)}. Nothing was changed.`
				);
			}
			try {
				const updated = await ctx.client.updateConfig({ entries }, signal);
				const changedKeys = Object.keys(entries as Record<string, unknown>);
				// Best-effort: read back to flag restart-required keys. Failure here
				// must not fail the (already-applied) update.
				let restartRequired: string[] = [];
				try {
					const cfg = await ctx.client.getConfig(signal);
					restartRequired = restartRequiredAmong(cfg, changedKeys);
				} catch {
					/* leave restartRequired empty */
				}
				// The engine answers with the whole config table, so its echo is a
				// read like get_engine_config and withholds the same credentials.
				const result: Record<string, unknown> = {
					changedKeys,
					restartRequired,
					updated: secretsShape(ctx, withholdConfigCredentials)(updated),
				};
				if (restartRequired.length > 0) {
					const note =
						`Updated ${changedKeys.length} config key(s). ⚠ Restart required for: ` +
						`${restartRequired.join(", ")}. These are saved, but the running engine keeps ` +
						`the old values until it is restarted (${engineRestartRemedy(ctx.host)}).`;
					return {
						content: [
							{ type: "text", text: `${note}\n\n${JSON.stringify(result, null, 2)}` },
						],
						structuredContent: result,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					structuredContent: result,
				};
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
		},
	},
];
