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
	maxResponseSamples: `raise Max response samples in ${APP_SETTINGS_PATH}`,
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
	maxResponseSamples: `raise ${SAFETY_ENV_VARS.maxResponseSamples} ${RESTART_TAIL}`,
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

/**
 * Remedies that have no `McpSafetyConfig` field behind them, as the verb phrase
 * each host's user performs. Phrases that follow "the user" or "a person".
 */
const PHRASES = {
	restartEngine: { app: engineRestartRemedy("app"), cli: engineRestartRemedy("cli") },
	engineDown: { app: engineDownRemedy("app"), cli: engineDownRemedy("cli") },
	// The Files allowlist lives in the app's Settings; the stdio server has no
	// setting that edits it and no request editor to pick a file in.
	binaryFileAccess: {
		app: "the user has picked that file in the request editor or it lies under a folder allowed in Settings > Files",
		cli: "it lies under a folder the engine already allows - this session has no request editor to pick a file in and no setting that allows a folder",
	},
	// The authority list is the engine's `customCaCertificates` entry, which a
	// CLI reaches through update_engine_config behind its two gates.
	trustAuthority: {
		app: "add the internal authority under Vayu Settings > Network & connectivity",
		cli: `add the internal authority's certificate to the engine's customCaCertificates entry (update_engine_config, which needs ${SAFETY_ENV_VARS.allowWrites}=true and ${SAFETY_ENV_VARS.allowNetworkSettings}=true in the environment of the MCP server)`,
	},
	// `dataFileLocation` is absent on stdio, so no path is ever remembered there.
	dataFileLocation: {
		app: "the Vayu app remembers where that file is on this machine",
		cli: "this session remembers where that file is on this machine (a stdio session never does, so ask the user for the path)",
	},
	proxySettings: {
		app: "check the proxy mode and URL in Vayu Settings -> Network",
		cli: "check the engine's proxy entries (get_engine_config)",
	},
	specSync: {
		app: "needs a person to tick it in the Vayu app (Collection -> Spec -> Sync)",
		cli: "needs a person to tick it under Collection -> Spec -> Sync in the desktop app, which a stdio session does not have",
	},
} as const satisfies Record<string, Record<McpHost, string>>;

type PhraseName = keyof typeof PHRASES;
type RemedyName = keyof McpSafetyConfig | PhraseName;

/**
 * `{{remedy:name}}`: a placeholder in a static description, filled per session.
 * Matches only names this module defines, so a user's own text that happens to
 * contain braces (a variable name in an error message) passes through unchanged;
 * a typo in a description's token is caught by the `tools/list` scan instead.
 */
const TOKEN_PATTERN = new RegExp(
	`\\{\\{remedy:(${[...Object.keys(APP_REMEDY), ...Object.keys(PHRASES)].join("|")})\\}\\}`,
	"g"
);

function remedyToken(name: RemedyName): string {
	return `{{remedy:${name}}}`;
}

function remedyFor(name: string, host: McpHost): string {
	return name in PHRASES
		? PHRASES[name as PhraseName][host]
		: settingRemedy(name as keyof McpSafetyConfig, host);
}

/**
 * What a gate tells the user to do depends on the host serving the session,
 * and a description is built before the host is known. A description
 * names its remedy with one of the tokens below and the server fills it in per
 * session (`server.ts`, `toolCatalog`), so neither host's wording is written
 * into a description and a new host cannot inherit the other's.
 */
export const GUARDED_WRITE_SENTENCE = `GUARDED: requires write access (to enable it, ${remedyToken("allowWrites")})`;
/** Completes "unless the user has chosen to ...". */
export const REVEAL_SETTING_TOKEN = remedyToken("revealSecretsToAgents");
export const NETWORK_SETTINGS_TOKEN = remedyToken("allowNetworkSettings");
export const ENGINE_DOWN_TOKEN = remedyToken("engineDown");
export const RESTART_ENGINE_TOKEN = remedyToken("restartEngine");
export const BINARY_FILE_ACCESS_TOKEN = remedyToken("binaryFileAccess");
export const TRUST_AUTHORITY_TOKEN = remedyToken("trustAuthority");
export const DATA_FILE_LOCATION_TOKEN = remedyToken("dataFileLocation");
export const PROXY_SETTINGS_TOKEN = remedyToken("proxySettings");
export const SPEC_SYNC_TOKEN = remedyToken("specSync");

/**
 * @p value with every remedy token replaced by @p host's wording. Strings are
 * replaced, arrays and plain objects are walked, anything else is returned
 * as is - so a whole `tools/list` result (descriptions and the schemas' own
 * property descriptions) resolves in one pass.
 */
export function resolveRemedyTokens<T>(value: T, host: McpHost): T {
	if (typeof value === "string") {
		return value.replace(TOKEN_PATTERN, (_whole, name: string) => remedyFor(name, host)) as T;
	}
	if (Array.isArray(value)) return value.map((item) => resolveRemedyTokens(item, host)) as T;
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, resolveRemedyTokens(item, host)])
	) as T;
}
