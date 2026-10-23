/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer and the MCP client budget `POST /execute` with two copies of one
 * function (issue #2836), because the main process cannot import the renderer's.
 * They disagreeing is how the class of bug this guards started: one client
 * aborting a send the other lets run. Drive both with the same payloads and
 * settings, cold-config ceilings included.
 */

import { describe, expect, it } from "vitest";
import { executeBudgetMs as rendererBudget } from "@/lib/execute-budget";
import { executeBudgetMs as mcpBudget } from "./execute-budget.js";

const pre = { id: "a", kind: "script.pre", enabled: true, config: {} };
const post = { id: "b", kind: "script.post", enabled: true, config: {} };
const off = { id: "c", kind: "script.pre", enabled: false, config: {} };
const assertion = { id: "d", kind: "assert.status", enabled: true, config: {} };

const PAYLOADS: Array<[string, unknown]> = [
	["not an object", "https://x"],
	["empty", {}],
	["plain", { url: "https://x", auth: { mode: "bearer" } }],
	["oauth2", { auth: { mode: "oauth2" } }],
	["pre script", { elements: [pre] }],
	["pre and post", { elements: [pre, post, assertion] }],
	["disabled script", { elements: [off, assertion] }],
	["oauth2 and scripts", { auth: { mode: "oauth2" }, elements: [pre, post] }],
	["own timeout", { timeout: 200_000, auth: { mode: "oauth2" } }],
	["malformed elements", { elements: [null, 3, "script.pre", {}] }],
];

const SETTINGS = [
	["cold", { defaultTimeoutMs: 0, scriptTimeoutMs: 0 }],
	["short", { defaultTimeoutMs: 2_500, scriptTimeoutMs: 1_000 }],
	["long", { defaultTimeoutMs: 120_000, scriptTimeoutMs: 60_000 }],
	["unreadable", { defaultTimeoutMs: Number.NaN, scriptTimeoutMs: -1 }],
] as const;

describe("renderer and MCP execute budgets agree", () => {
	it.each(
		PAYLOADS.flatMap(([p, payload]) =>
			SETTINGS.map(([s, set]) => [p, s, payload, set] as const)
		)
	)("%s, %s config", (_payloadName, _settingName, payload, settings) => {
		expect(mcpBudget(payload, settings)).toBe(rendererBudget(payload, settings));
	});

	it("is not comparing two constants: the worst case differs across the table", () => {
		const budgets = new Set(PAYLOADS.map(([, p]) => rendererBudget(p, SETTINGS[2][1])));
		expect(budgets.size).toBeGreaterThan(4);
	});
});
