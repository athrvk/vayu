/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `update_engine_config`, the write half of the engine config; the read,
 *        `get_engine_config`, sits with the other reads in `reads.tools.ts`.
 */

import { z } from "zod";
import {
	isUrlConfigKey,
	restoreConfigCredentials,
	secretsShape,
	withholdConfigCredentials,
} from "../withhold.js";
import type { McpTool, ToolContext } from "./contract.js";
import {
	GUARDED_WRITE_SENTENCE,
	NETWORK_SETTINGS_TOKEN,
	RESTART_ENGINE_TOKEN,
	engineRestartRemedy,
	settingRemedy,
} from "../remedy.js";
import { engineErrorResult, errorResult, withCaveat } from "./kit.js";
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
					`Config writes are disabled. To allow this, ask the user to ${settingRemedy("allowWrites", ctx.host)}.`,
					"policy"
				);
			}
			const entries = args.entries;
			if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
				return errorResult(
					'"entries" must be an object mapping config keys to values.',
					"input"
				);
			}
			const network = Object.keys(entries).filter(isNetworkConfigKey);
			if (network.length > 0 && !ctx.config.allowNetworkSettings) {
				return errorResult(
					`Network settings are not open to agents: ${network.join(", ")} decide where every request goes and which certificate authorities Vayu trusts, so they need Network settings turned on as well as write access: ask the user to ${settingRemedy("allowNetworkSettings", ctx.host)}. Nothing was changed.`,
					"policy"
				);
			}
			try {
				const { entries: written, kept } = await restoreWithheldProxyCredentials(
					ctx,
					entries as Record<string, string>,
					signal
				);
				const updated = await ctx.client.updateConfig({ entries: written }, signal);
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
				const json = JSON.stringify(result);
				const note =
					restartRequired.length > 0
						? `Updated ${changedKeys.length} config key(s). ⚠ Restart required for: ` +
							`${restartRequired.join(", ")}. These are saved, but the running engine keeps ` +
							`the old values until it is restarted (${engineRestartRemedy(ctx.host)}).\n\n`
						: "";
				return withCaveat(
					{
						content: [{ type: "text", text: `${note}${json}` }],
						structuredContent: result,
					},
					kept.map(keptCredentialsLine).join("\n")
				);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
		},
	},
];

/**
 * @p entries with each URL entry written back exactly as the read showed it given its stored
 * credentials again (`restoreConfigCredentials`, #3549), so a batch that repeats the read-back
 * `proxyUrl` does not strip them. Read only while secrets are withheld and the batch names such an
 * entry. `/config` carries no version, so this read and the write are not one conditioned step: a
 * proxy edit the user saves between them is overwritten, as any concurrent `POST /config` already
 * is.
 */
async function restoreWithheldProxyCredentials(
	ctx: ToolContext,
	entries: Record<string, string>,
	signal: AbortSignal | undefined
): Promise<{ entries: Record<string, string>; kept: string[] }> {
	if (ctx.config.revealSecretsToAgents || !Object.keys(entries).some(isUrlConfigKey)) {
		return { entries, kept: [] };
	}
	return restoreConfigCredentials(entries, await ctx.client.getConfig(signal));
}

function keptCredentialsLine(key: string): string {
	return `${key} kept the user:password of its stored value, because the address written is the one the read showed without them. To drop them, clear ${key} and write the address again.`;
}
