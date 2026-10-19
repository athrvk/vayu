/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_MCP_SAFETY_CONFIG, SAFETY_ENV_VARS, type McpSafetyConfig } from "./config.js";
import {
	BINARY_FILE_ACCESS_TOKEN,
	DATA_FILE_LOCATION_TOKEN,
	ENGINE_URL_ENV_VAR,
	GUARDED_WRITE_SENTENCE,
	NETWORK_SETTINGS_TOKEN,
	PROXY_SETTINGS_TOKEN,
	RESTART_ENGINE_TOKEN,
	REVEAL_SETTING_TOKEN,
	SPEC_SYNC_TOKEN,
	TRUST_AUTHORITY_TOKEN,
	engineDownRemedy,
	engineRestartRemedy,
	resolveRemedyTokens,
	settingRemedy,
} from "./remedy.js";

const KEYS = Object.keys(DEFAULT_MCP_SAFETY_CONFIG) as (keyof McpSafetyConfig)[];

describe("settingRemedy", () => {
	it("covers every safety field and every field has an environment variable", () => {
		expect(KEYS.length).toBeGreaterThan(0);
		expect(Object.keys(SAFETY_ENV_VARS).sort()).toEqual([...KEYS].sort());
	});

	// Iterates the variable map, so a field added with a variable but no CLI
	// wording (or the reverse) fails here instead of naming nothing to a user.
	it.each(Object.entries(SAFETY_ENV_VARS))(
		"names %s's variable to the CLI, with a restart, and no screen",
		(key, variable) => {
			const sentence = settingRemedy(key as keyof McpSafetyConfig, "cli");
			expect(sentence).toContain(variable);
			expect(sentence).toContain("restart");
			expect(sentence).not.toMatch(/Settings|Vayu app/);
		}
	);

	it.each(KEYS)("names the Settings screen to the app for %s, and no variable", (key) => {
		const sentence = settingRemedy(key, "app");
		expect(sentence).toContain("Vayu Settings → MCP");
		expect(sentence).not.toContain("VAYU_MCP_");
	});

	it.each([
		["allowWrites", "turn on Write access in Vayu Settings → MCP"],
		["allowNetworkSettings", "turn on Network settings in Vayu Settings → MCP"],
		["revealSecretsToAgents", "turn on Reveal secrets to agents in Vayu Settings → MCP"],
		["allowAll", "turn on Allow all hosts in Vayu Settings → MCP"],
		["maxRps", "raise Max RPS in Vayu Settings → MCP"],
		["maxConcurrency", "raise Max virtual users in Vayu Settings → MCP"],
		["maxDurationSeconds", "raise Max duration in Vayu Settings → MCP"],
		["maxIterations", "raise Max iterations in Vayu Settings → MCP"],
		["allowlist", "add the host in Vayu Settings → MCP (Target allowlist)"],
		["disabledTools", "switch the tool back on in Vayu Settings → MCP (Tools)"],
	] as const)("words the app sentence for %s", (key, expected) => {
		expect(settingRemedy(key, "app")).toBe(expected);
	});

	it.each([
		[
			"allowWrites",
			"set VAYU_MCP_ALLOW_WRITES=true in the environment of the MCP server and restart it",
		],
		[
			"allowlist",
			"add the host to VAYU_MCP_ALLOWLIST (comma-separated) in the environment of the MCP server and restart it",
		],
		["maxRps", "raise VAYU_MCP_MAX_RPS in the environment of the MCP server and restart it"],
	] as const)("words the CLI sentence for %s", (key, expected) => {
		expect(settingRemedy(key, "cli")).toBe(expected);
	});
});

describe("engineDownRemedy", () => {
	it("tells the app user to start the app", () => {
		expect(engineDownRemedy("app")).toBe("Make sure the Vayu app is running");
	});

	it("tells the CLI user to start the engine or point at one", () => {
		const sentence = engineDownRemedy("cli");
		expect(sentence).toBe("Start vayu-engine, or point VAYU_ENGINE_URL at a running engine");
		expect(sentence).toContain(ENGINE_URL_ENV_VAR);
		expect(sentence).not.toContain("Vayu app");
	});
});

describe("engineRestartRemedy", () => {
	it("names the process to the CLI and the app's controls to the app", () => {
		expect(engineRestartRemedy("cli")).toBe("restart vayu-engine");
		expect(engineRestartRemedy("app")).toBe(
			"Vayu Settings → restart engine, or relaunch the app"
		);
	});
});

describe("resolveRemedyTokens", () => {
	const TOKENS = {
		GUARDED_WRITE_SENTENCE,
		REVEAL_SETTING_TOKEN,
		NETWORK_SETTINGS_TOKEN,
		RESTART_ENGINE_TOKEN,
		BINARY_FILE_ACCESS_TOKEN,
		TRUST_AUTHORITY_TOKEN,
		DATA_FILE_LOCATION_TOKEN,
		PROXY_SETTINGS_TOKEN,
		SPEC_SYNC_TOKEN,
	};

	it.each(Object.entries(TOKENS))("resolves %s for both hosts", (_name, token) => {
		expect(token).toContain("{{remedy:");
		for (const host of ["app", "cli"] as const) {
			const text = resolveRemedyTokens(token, host);
			expect(text.length).toBeGreaterThan(0);
			expect(text).not.toContain("{{remedy:");
		}
		expect(resolveRemedyTokens(token, "cli")).not.toMatch(/Settings|Vayu app/);
		expect(resolveRemedyTokens(token, "app")).not.toBe(resolveRemedyTokens(token, "cli"));
	});

	it("puts the same sentence settingRemedy gives into a gate", () => {
		expect(resolveRemedyTokens(GUARDED_WRITE_SENTENCE, "cli")).toBe(
			`GUARDED: requires write access (to enable it, ${settingRemedy("allowWrites", "cli")})`
		);
		expect(resolveRemedyTokens(REVEAL_SETTING_TOKEN, "app")).toBe(
			settingRemedy("revealSecretsToAgents", "app")
		);
	});

	it("walks arrays and objects and leaves every other value alone", () => {
		const input = {
			a: [REVEAL_SETTING_TOKEN, 3, null, true],
			b: { c: GUARDED_WRITE_SENTENCE },
		};
		const out = resolveRemedyTokens(input, "cli");
		expect(JSON.stringify(out)).not.toContain("{{remedy:");
		expect(out.a.slice(1)).toEqual([3, null, true]);
		expect(input.b.c).toContain("{{remedy:");
	});

	it("leaves braces it does not own, so a user's text is never rewritten", () => {
		const text = "Variable {{remedy:nothing}} and {{token}} stay as written.";
		expect(resolveRemedyTokens(text, "cli")).toBe(text);
	});
});
