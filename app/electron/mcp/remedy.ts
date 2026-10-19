/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file remedy.ts
 * @brief What a refusal tells the user to do about it, per host. The Electron
 *        app has Settings screens and a window; the stdio CLI has neither, only
 *        the `VAYU_MCP_*` variables and a `vayu-engine` process. A sentence that
 *        names one to a session served by the other sends the user to something
 *        that does not exist (#2439), so every guard, outage and gate sentence
 *        gets its remedy here and nowhere else.
 */

import { SAFETY_ENV_VARS, type McpSafetyConfig } from "./config.js";
import type { McpHost } from "./tools/contract.js";

/** The variable the stdio CLI reads the engine's address from. */
export const ENGINE_URL_ENV_VAR = "VAYU_ENGINE_URL";

/** Where the Settings screens that hold the safety config live. */
const APP_SETTINGS_PATH = "Vayu Settings → MCP";

/**
 * What the user does in the app to change each safety field, as a verb phrase
 * that completes "ask the user to ...". The labels are the ones the Settings
 * panel prints (`app-settings.ts`).
 */
const APP_REMEDY: Record<keyof McpSafetyConfig, string> = {
	allowlist: `add the host in ${APP_SETTINGS_PATH} (Target allowlist)`,
	allowAll: `turn on Allow all hosts in ${APP_SETTINGS_PATH}`,
	maxRps: `raise Max RPS in ${APP_SETTINGS_PATH}`,
	maxConcurrency: `raise Max virtual users in ${APP_SETTINGS_PATH}`,
	maxDurationSeconds: `raise Max duration in ${APP_SETTINGS_PATH}`,
	maxIterations: `raise Max iterations in ${APP_SETTINGS_PATH}`,
	allowWrites: `turn on Write access in ${APP_SETTINGS_PATH}`,
	allowNetworkSettings: `turn on Network settings in ${APP_SETTINGS_PATH}`,
	revealSecretsToAgents: `turn on Reveal secrets to agents in ${APP_SETTINGS_PATH}`,
	disabledTools: `switch the tool back on in ${APP_SETTINGS_PATH} (Tools)`,
};

const RESTART_TAIL = "in the environment of the MCP server and restart it";

/**
 * What the user does in the CLI's environment to change each field. Derived
 * from {@link SAFETY_ENV_VARS} so a variable renamed there is renamed here, and
 * a field added without a variable fails to compile rather than naming nothing.
 */
const CLI_REMEDY: Record<keyof McpSafetyConfig, string> = {
	allowlist: `add the host to ${SAFETY_ENV_VARS.allowlist} (comma-separated) ${RESTART_TAIL}`,
	allowAll: `set ${SAFETY_ENV_VARS.allowAll}=true ${RESTART_TAIL}`,
	maxRps: `raise ${SAFETY_ENV_VARS.maxRps} ${RESTART_TAIL}`,
	maxConcurrency: `raise ${SAFETY_ENV_VARS.maxConcurrency} ${RESTART_TAIL}`,
	maxDurationSeconds: `raise ${SAFETY_ENV_VARS.maxDurationSeconds} ${RESTART_TAIL}`,
	maxIterations: `raise ${SAFETY_ENV_VARS.maxIterations} ${RESTART_TAIL}`,
	allowWrites: `set ${SAFETY_ENV_VARS.allowWrites}=true ${RESTART_TAIL}`,
	allowNetworkSettings: `set ${SAFETY_ENV_VARS.allowNetworkSettings}=true ${RESTART_TAIL}`,
	revealSecretsToAgents: `set ${SAFETY_ENV_VARS.revealSecretsToAgents}=true ${RESTART_TAIL}`,
	disabledTools: `remove the tool from ${SAFETY_ENV_VARS.disabledTools} ${RESTART_TAIL}`,
};

/**
 * The verb phrase that changes @p key on @p host, to follow "ask the user to"
 * or "the user can". Neither host's wording appears anywhere else.
 */
export function settingRemedy(key: keyof McpSafetyConfig, host: McpHost): string {
	return host === "cli" ? CLI_REMEDY[key] : APP_REMEDY[key];
}

/** The sentence that gets an unreachable engine reachable, without its closing punctuation. */
export function engineDownRemedy(host: McpHost): string {
	return host === "cli"
		? `Start vayu-engine, or point ${ENGINE_URL_ENV_VAR} at a running engine`
		: "Make sure the Vayu app is running";
}

/** How the user restarts the engine so a saved restart-required key takes effect. */
export function engineRestartRemedy(host: McpHost): string {
	return host === "cli"
		? "restart vayu-engine"
		: "Vayu Settings → restart engine, or relaunch the app";
}
