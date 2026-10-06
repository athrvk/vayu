/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saving an agent's run as a request (issue #1817).
 *
 * The description is what keeps the provenance once the run ages out, so it is
 * pinned in every spelling it can take: a product name, an identifier nothing
 * maps, no identifier at all. The date reads the run's start in an explicit
 * zone and locale, so no case reads the machine.
 */

import { describe, it, expect } from "vitest";
import {
	isUnsavedAgentRun,
	presetFromRun,
	requestNameFromRun,
	savedFromRunDescription,
} from "./save-run-as-request";
import { seedFromRun } from "./design-run-seed";
import type { Run, RunOrigin } from "@/types";

/** 2025-06-15T15:06:40Z. */
const STARTED = 1_750_000_000_000;
const UTC_EN = { timeZone: "UTC", locale: "en-US" };

function agentRun(overrides: Partial<Run> = {}, origin?: RunOrigin): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: STARTED,
		endTime: STARTED + 300,
		requestId: null,
		environmentId: null,
		origin: origin ?? { kind: "mcp", client: "claude-ai" },
		configSnapshot: {
			method: "POST",
			url: "https://api.example.test/users?page=2&key=abc#frag",
			headers: { "X-Plain": "visible" },
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "bearer" },
		},
		// A request with no live row seeds its headers from what went on the wire.
		result: {
			timestamp: STARTED,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: { request: { method: "POST", url: "", headers: { "X-Plain": "visible" } } },
		},
		...overrides,
	} as Run;
}

describe("savedFromRunDescription", () => {
	it("names the product, not the identifier the client sent", () => {
		const text = savedFromRunDescription(agentRun(), UTC_EN);
		expect(text).toBe("Saved from a run started by Claude Desktop on 6/15/25");
		expect(text).not.toContain("claude-ai");
	});

	it("keeps an identifier no product is known for, as sent", () => {
		const run = agentRun({}, { kind: "mcp", client: "acme-agent" });
		expect(savedFromRunDescription(run, UTC_EN)).toBe(
			"Saved from a run started by acme-agent on 6/15/25"
		);
	});

	it.each([null, undefined, "", "   "])(
		"reads an agent with no name (%j) as an MCP client",
		(client) => {
			const run = agentRun({}, { kind: "mcp", client });
			expect(savedFromRunDescription(run, UTC_EN)).toBe(
				"Saved from a run started by an MCP client on 6/15/25"
			);
		}
	);

	it("dates the run's start, in the zone it is formatted for", () => {
		// 15:06 UTC on the 15th is already the 16th at UTC+14.
		const tomorrow = savedFromRunDescription(agentRun(), {
			timeZone: "Pacific/Kiritimati",
			locale: "en-US",
		});
		expect(tomorrow).toMatch(/ on 6\/16\/25$/);
	});

	it("follows the locale's date order", () => {
		const text = savedFromRunDescription(agentRun(), { timeZone: "UTC", locale: "en-GB" });
		expect(text).toMatch(/ on 15\/06\/2025$/);
	});
});

describe("isUnsavedAgentRun", () => {
	it("holds for an agent's run with no request", () => {
		expect(isUnsavedAgentRun(agentRun())).toBe(true);
		expect(isUnsavedAgentRun(agentRun({ requestId: undefined }))).toBe(true);
	});

	it("does not hold for a linked run", () => {
		expect(isUnsavedAgentRun(agentRun({ requestId: "req_1" }))).toBe(false);
	});

	it.each([{ kind: "app" }, { kind: "other" }] as RunOrigin[])(
		"does not hold for a run whose origin is %j",
		(origin) => {
			expect(isUnsavedAgentRun(agentRun({}, origin))).toBe(false);
		}
	);

	it("does not hold for a run from an engine that records no origin", () => {
		expect(isUnsavedAgentRun(agentRun({ origin: undefined }))).toBe(false);
	});
});

describe("requestNameFromRun", () => {
	it("prefers the name the request carried when the run started", () => {
		const run = agentRun({ summary: { requestName: "Create user" } } as Partial<Run>);
		expect(requestNameFromRun(run, seedFromRun(run, null))).toBe("Create user");
	});

	it("falls back to METHOD url, without the query or fragment", () => {
		const run = agentRun({ summary: { requestName: "New Request" } } as Partial<Run>);
		expect(requestNameFromRun(run, seedFromRun(run, null))).toBe(
			"POST https://api.example.test/users"
		);
	});

	it("does not name a request after a url the engine withheld", () => {
		const run = agentRun({
			configSnapshot: {
				method: "GET",
				url: "https://api.example.test/{{secret}}/<redacted>",
			},
		} as Partial<Run>);
		const seed = seedFromRun(run, null);
		seed.withheld.url = true;
		expect(requestNameFromRun(run, seed)).toBe("GET request");
	});
});

describe("presetFromRun", () => {
	it("carries the seeded request, the name and the stamped description", () => {
		const run = agentRun();
		const preset = presetFromRun(run, seedFromRun(run, null), UTC_EN);

		expect(preset).toMatchObject({
			name: "POST https://api.example.test/users",
			description: "Saved from a run started by Claude Desktop on 6/15/25",
			method: "POST",
			url: "https://api.example.test/users?page=2&key=abc#frag",
			body: { mode: "json", content: '{"a":1}' },
			headers: [expect.objectContaining({ key: "X-Plain", value: "visible" })],
		});
	});

	it("never writes auth: the run holds only its mode", () => {
		const run = agentRun();
		expect(presetFromRun(run, seedFromRun(run, null), UTC_EN)).not.toHaveProperty("auth");
	});

	it("leaves a withheld url empty and a withheld body unwritten", () => {
		const run = agentRun();
		const seed = seedFromRun(run, null);
		seed.withheld.url = true;
		seed.withheld.params = true;
		seed.withheld.body = true;
		const preset = presetFromRun(run, seed, UTC_EN);

		expect(preset.url).toBe("");
		expect(preset).not.toHaveProperty("params");
		expect(preset).not.toHaveProperty("body");
	});
});
