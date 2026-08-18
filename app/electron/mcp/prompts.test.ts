/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file prompts.test.ts
 * @brief What the server-provided prompts say, and where they get their data.
 *
 * A prompt is the one surface that talks *about* the tools rather than calling
 * them, so it drifts silently: `suggest_load_profile` listed four modes for as
 * long as `start_load_run` supported five, steering agents away from a mode the
 * tool had (issue #760). These tests pin the two claims that can go stale - the
 * mode list, and which arguments a prompt genuinely needs.
 */

import { describe, expect, test, vi } from "vitest";
import { PROMPTS } from "./prompts.js";
import { resolveSafetyConfig } from "./config.js";
import { KNOWN_LOAD_MODES } from "./safety.js";
import type { ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

const REPORT = { latency: { p99: 120 }, summary: { avgRps: 500 }, statusCodes: { "200": 10 } };

function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
	return {
		getRunReport: vi.fn().mockResolvedValue(REPORT),
		getRun: vi.fn().mockResolvedValue({ id: "run_target", requestId: "req_1" }),
		listBaselineRuns: vi.fn().mockResolvedValue({ data: [{ id: "run_pinned" }] }),
		...overrides,
	} as unknown as EngineClient;
}

function ctxWith(client: EngineClient): ToolContext {
	return { client, config: resolveSafetyConfig() };
}

function prompt(name: string) {
	const found = PROMPTS.find((p) => p.name === name);
	if (!found) throw new Error(`prompt "${name}" is not registered`);
	return found;
}

const textOf = (result: { messages: Array<{ content: { text: string } }> }) =>
	result.messages.map((m) => m.content.text).join("\n");

describe("suggest_load_profile", () => {
	test("names every mode start_load_run accepts", async () => {
		const text = textOf(
			await prompt("suggest_load_profile").build(
				{ url: "https://api.example.com" },
				ctxWith(fakeClient())
			)
		);

		// The set `safety.ts` knows as `KNOWN_LOAD_MODES` - the guard that
		// decides which cap applies, so it is the one list that cannot fall
		// behind the engine. A mode the tool gains and the prompt does not is
		// exactly the drift this test exists to catch.
		expect(KNOWN_LOAD_MODES.size).toBeGreaterThan(0);
		for (const mode of KNOWN_LOAD_MODES) {
			expect(text, mode).toContain(mode);
		}
	});

	test("says when capacity is the mode to reach for, not merely that it exists", async () => {
		// A bare name in a list is not guidance: the whole reason the omission
		// mattered is that an agent picks a mode from what the prompt explains.
		const text = textOf(
			await prompt("suggest_load_profile").build(
				{ url: "https://api.example.com" },
				ctxWith(fakeClient())
			)
		);
		expect(text).toMatch(/capacity[^.]*sloMs|sloMs[^.]*capacity/s);
	});

	test("needs no engine data", async () => {
		const client = fakeClient();
		await prompt("suggest_load_profile").build({ url: "https://x.example" }, ctxWith(client));
		expect(client.getRunReport).not.toHaveBeenCalled();
	});
});

/**
 * The prompt asked for both run ids while the `compare_runs` *tool* has
 * resolved the pinned baseline since it shipped - the same question reaching a
 * user two ways, one of them demanding an id Vayu already knew.
 */
describe("compare_runs", () => {
	test("resolves the target's pinned baseline when none is given", async () => {
		const client = fakeClient();
		const text = textOf(
			await prompt("compare_runs").build({ targetRunId: "run_target" }, ctxWith(client))
		);

		expect(client.listBaselineRuns).toHaveBeenCalledWith("req_1", undefined);
		expect(client.getRunReport).toHaveBeenCalledWith("run_pinned", undefined);
		expect(text).toContain("run_pinned -> run_target");
	});

	test("an explicitly named base is used as-is, with nothing resolved", async () => {
		const client = fakeClient();
		const text = textOf(
			await prompt("compare_runs").build(
				{ baseRunId: "run_main", targetRunId: "run_target" },
				ctxWith(client)
			)
		);

		expect(client.listBaselineRuns).not.toHaveBeenCalled();
		expect(text).toContain("run_main -> run_target");
	});

	test("a target with no pinned baseline fails with the fix named", async () => {
		const client = fakeClient({ listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }) });

		// Loudly, rather than comparing against some other run: a regression
		// verdict about the wrong pair is a wrong answer presented as a right one.
		await expect(
			prompt("compare_runs").build({ targetRunId: "run_target" }, ctxWith(client))
		).rejects.toThrow(/baseline/i);
	});
});
