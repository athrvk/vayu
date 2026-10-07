/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The MCP server's sensitive-header list against the engine's. `electron/`
 * cannot import the renderer's copy (`src/lib/sensitive-headers.ts`), so this
 * module holds one of its own, and all three read `sensitiveHeaderNames` in
 * `engine/tests/fixtures/log-redaction-conformance.json`. Its query-parameter
 * and Params-row set against the engine's `is_secret_param_name`, over the
 * same file's `sensitiveParamNames` (#1837). The run-output
 * mask's query form against the engine's `encode_query_component`, over
 * `engine/tests/fixtures/query-encoding-conformance.json`, for the same
 * reason (#1809).
 *
 * Mutation check: drop `x-csrf-token` from `SENSITIVE_HEADER_NAMES` in
 * `withhold.ts` and the list-equality case reds; add a name to
 * `SENSITIVE_PARAM_NAMES` and its list-equality case reds; drop `&` from the
 * query value set and the cases holding one red.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { SENSITIVE_HEADER_NAMES } from "@/lib/sensitive-headers";
import {
	encodeQueryValue,
	SENSITIVE_HEADER_NAMES as MCP_SENSITIVE_HEADER_NAMES,
	SENSITIVE_PARAM_NAMES,
	withholdRowSecrets,
} from "./withhold";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.mcpSensitiveHeaders.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	sensitiveHeaderNames: string[];
	sensitiveParamNames: string[];
};

describe("MCP sensitive header conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.sensitiveHeaderNames.length).toBeGreaterThan(0);
	});

	it("holds exactly the engine's list", () => {
		expect([...MCP_SENSITIVE_HEADER_NAMES].sort()).toEqual(
			[...fixture.sensitiveHeaderNames].sort()
		);
	});

	it("holds the renderer's list", () => {
		expect([...MCP_SENSITIVE_HEADER_NAMES].sort()).toEqual([...SENSITIVE_HEADER_NAMES].sort());
	});

	it.each(fixture.sensitiveHeaderNames)("withholds a %s row's value in any case", (name) => {
		for (const key of [name, name.toUpperCase()]) {
			expect(withholdRowSecrets({ headers: [{ key, value: "v", enabled: true }] })).toEqual({
				headers: [{ key, enabled: true, valueWithheld: true }],
			});
		}
	});
});

describe("MCP sensitive parameter name conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.sensitiveParamNames.length).toBeGreaterThan(0);
	});

	it("holds exactly the engine's list", () => {
		expect([...SENSITIVE_PARAM_NAMES].sort()).toEqual([...fixture.sensitiveParamNames].sort());
	});

	it("leaves out the generic names the engine treats as data", () => {
		expect(SENSITIVE_PARAM_NAMES).not.toContain("code");
		expect(SENSITIVE_PARAM_NAMES).not.toContain("key");
	});

	it.each(fixture.sensitiveParamNames)(
		"withholds a %s row and URL value in any case, and nothing around it",
		(name) => {
			for (const spelled of [name, name.toUpperCase()]) {
				expect(
					withholdRowSecrets({
						url: `/p?${spelled}=v&page=2`,
						params: [
							{ key: spelled, value: "v", enabled: true },
							{ key: "page", value: "2", enabled: true },
						],
					})
				).toEqual({
					url: `/p?${spelled}=&page=2`,
					params: [
						{ key: spelled, enabled: true, valueWithheld: true },
						{ key: "page", value: "2", enabled: true },
					],
				});
			}
		}
	);

	it.each(fixture.sensitiveParamNames)("matches %s as a whole name only", (name) => {
		const row = { url: `/p?${name}x=v`, params: [{ key: `${name}x`, value: "v" }] };
		expect(withholdRowSecrets(row)).toEqual(row);
	});
});

const [queryFixturePath] = ENGINE_READING_GUARDS.mcpQueryEncoding.paths.map(fromRepoRoot);
const queryFixture = JSON.parse(readFileSync(queryFixturePath, "utf8")) as {
	components: { name: string; text: string; value: string }[];
};

describe("MCP query value encoding conformance", () => {
	it("read a non-empty fixture", () => {
		expect(queryFixture.components.length).toBeGreaterThan(0);
	});

	it.each(queryFixture.components)("encodes $name as the engine writes a value", (row) => {
		expect(encodeQueryValue(row.text)).toBe(row.value);
	});
});
