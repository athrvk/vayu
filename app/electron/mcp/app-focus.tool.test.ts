/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `get_app_focus` (issue #2045): the open tab and environment the renderer
 * published, answered as names and ids and nothing else.
 */

import { describe, expect, test } from "vitest";

import type { AppFocus } from "../app-focus.js";
import { resolveSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import { dispatchTool, TOOLS, type ToolContext } from "./tools.js";

const RUN_FOCUS: AppFocus = {
	activeTab: { type: "run", entityId: "run_9", label: "Design run" },
	activeEnvironment: { id: "env_1", name: "Staging" },
};

function ctxWith(appFocus?: ToolContext["appFocus"]): ToolContext {
	return {
		client: {} as unknown as EngineClient,
		config: resolveSafetyConfig({ allowWrites: false }),
		host: "app",
		appFocus,
	};
}

const answer = (result: Awaited<ReturnType<typeof dispatchTool>>) => result.structuredContent;

describe("get_app_focus", () => {
	test("a run tab answers its run id and the environment's id and name", async () => {
		const result = await dispatchTool(
			"get_app_focus",
			{},
			ctxWith(() => RUN_FOCUS)
		);
		expect(result.isError).toBeFalsy();
		// Mutation check: return `run: null` for a run tab and this fails.
		expect(answer(result)).toEqual({
			activeTab: { type: "run", entityId: "run_9", label: "Design run" },
			run: { runId: "run_9" },
			activeEnvironment: { id: "env_1", name: "Staging" },
		});
	});

	test("a request tab names its entity and sets no run", async () => {
		const focus: AppFocus = {
			activeTab: { type: "request", entityId: "req_4", label: "Create order" },
			activeEnvironment: null,
		};
		const result = await dispatchTool(
			"get_app_focus",
			{},
			ctxWith(() => focus)
		);
		expect(answer(result)).toEqual({
			activeTab: { type: "request", entityId: "req_4", label: "Create order" },
			run: null,
			activeEnvironment: null,
		});
	});

	test("nothing open answers nulls, not an error", async () => {
		const focus: AppFocus = { activeTab: null, activeEnvironment: null };
		const result = await dispatchTool(
			"get_app_focus",
			{},
			ctxWith(() => focus)
		);
		expect(result.isError).toBeFalsy();
		expect(answer(result)).toEqual({ activeTab: null, run: null, activeEnvironment: null });
	});

	test("a run tab with no entity id sets no run", async () => {
		const focus: AppFocus = {
			activeTab: { type: "run", entityId: null, label: "Run" },
			activeEnvironment: null,
		};
		expect(
			answer(
				await dispatchTool(
					"get_app_focus",
					{},
					ctxWith(() => focus)
				)
			)?.run
		).toBeNull();
	});

	test("a host with no window (the stdio CLI) answers an error saying so", async () => {
		const result = await dispatchTool("get_app_focus", {}, ctxWith());
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/Vayu window is not connected/);
	});

	test("a window that has not published yet answers the same error", async () => {
		const result = await dispatchTool(
			"get_app_focus",
			{},
			ctxWith(() => undefined)
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/Vayu window is not connected/);
	});

	test("the answer holds no key that could carry a value", async () => {
		const result = await dispatchTool(
			"get_app_focus",
			{},
			ctxWith(() => RUN_FOCUS)
		);
		const keys = new Set<string>();
		const walk = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			for (const [key, child] of Object.entries(node)) {
				keys.add(key);
				walk(child);
			}
		};
		walk(answer(result));
		// A guard that walked nothing would pass forever.
		expect(keys.size).toBeGreaterThan(0);
		for (const forbidden of ["value", "headers", "auth", "token", "variables"]) {
			expect(keys, forbidden).not.toContain(forbidden);
		}
	});

	test("is a read tool carrying read-only annotations, listed after get_engine_health", () => {
		const names = TOOLS.map((t) => t.name);
		expect(names.indexOf("get_app_focus")).toBe(names.indexOf("get_engine_health") + 1);
		const tool = TOOLS.find((t) => t.name === "get_app_focus");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(Object.keys(tool?.inputSchema ?? { x: 1 })).toEqual([]);
	});
});
