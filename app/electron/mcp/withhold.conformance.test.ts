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
 * reason (#1809). The renderer's credential parameter predicate, which the
 * token cache key reads (`src/services/oauth/credential-params.ts`, #2536),
 * against this module's, list for list and name for name.
 *
 * Mutation check: drop `x-csrf-token` from `SENSITIVE_HEADER_NAMES` in
 * `withhold.ts` and the list-equality case reds; add a name to
 * `SENSITIVE_PARAM_NAMES` and its list-equality case reds; drop `&` from the
 * query value set and the cases holding one red; drop `assertion` from the
 * renderer's `CREDENTIAL_PARAM_KEYS` and its list case reds, and stop its
 * `namesCredentialParam` folding case and the upper-cased predicate cases red.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { SENSITIVE_HEADER_NAMES } from "@/lib/sensitive-headers";
import * as rendererCredentialParams from "@/services/oauth/credential-params";
import {
	CREDENTIAL_AUTH_MEMBERS,
	CREDENTIAL_PARAM_KEYS,
	encodeQueryKey,
	encodeQueryValue,
	namesCredentialParam,
	SENSITIVE_HEADER_NAMES as MCP_SENSITIVE_HEADER_NAMES,
	SENSITIVE_PARAM_NAMES,
	withholdRowSecrets,
	withholdRunOutput,
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

describe.each(["headerLines", "requestHeaderLines", "sentHeaderLines"])(
	"MCP sensitive header conformance in run output's %s (#2460, #2466)",
	(member) => {
		it("read a non-empty fixture", () => {
			expect(fixture.sensitiveHeaderNames.length).toBeGreaterThan(0);
		});

		it.each(fixture.sensitiveHeaderNames)("withholds a %s row's value in any case", (name) => {
			for (const spelled of [name, name.toUpperCase()]) {
				expect(
					withholdRunOutput(
						{
							[member]: [
								{ name: spelled, value: "v" },
								{ name: "X-Plain", value: "kept" },
							],
						},
						{ forms: [], apiKeyHeaders: [] }
					)
				).toEqual({
					[member]: [
						{ name: spelled, value: "<redacted>" },
						{ name: "X-Plain", value: "kept" },
					],
				});
			}
		});
	}
);

describe("MCP sensitive header conformance in a redirect hop's headerLines (#2461)", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.sensitiveHeaderNames.length).toBeGreaterThan(0);
	});

	it.each(fixture.sensitiveHeaderNames)("withholds a %s row's value in any case", (name) => {
		for (const spelled of [name, name.toUpperCase()]) {
			expect(
				withholdRunOutput(
					{
						redirects: [
							{
								status: 302,
								statusText: "Found",
								headerLines: [
									{ name: spelled, value: "v" },
									{ name: "Location", value: "/home" },
								],
							},
						],
					},
					{ forms: [], apiKeyHeaders: [] }
				)
			).toEqual({
				redirects: [
					{
						status: 302,
						statusText: "Found",
						headerLines: [
							{ name: spelled, value: "<redacted>" },
							{ name: "Location", value: "/home" },
						],
					},
				],
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

describe("Credential parameter predicate: the renderer's copy against this one (#2536)", () => {
	const lists: [string, readonly string[], readonly string[]][] = [
		[
			"auth members",
			[...rendererCredentialParams.CREDENTIAL_AUTH_MEMBERS],
			[...CREDENTIAL_AUTH_MEMBERS],
		],
		[
			"parameter keys",
			[...rendererCredentialParams.CREDENTIAL_PARAM_KEYS],
			[...CREDENTIAL_PARAM_KEYS],
		],
		[
			"sensitive parameter names",
			[...rendererCredentialParams.SENSITIVE_PARAM_NAMES],
			[...SENSITIVE_PARAM_NAMES],
		],
	];

	it.each(lists)("holds the same %s", (_, renderer, mcp) => {
		expect(renderer.length).toBeGreaterThan(0);
		expect([...renderer].sort()).toEqual([...mcp].sort());
	});

	it("holds exactly the engine's sensitive parameter names", () => {
		expect([...rendererCredentialParams.SENSITIVE_PARAM_NAMES].sort()).toEqual(
			[...fixture.sensitiveParamNames].sort()
		);
	});

	const names = [...new Set(lists.flatMap(([, renderer, mcp]) => [...renderer, ...mcp]))];
	const spellings = names.flatMap((name) => [name, name.toUpperCase(), `${name}x`]);

	it.each(spellings)("judges %s as this module does", (name) => {
		expect(rendererCredentialParams.namesCredentialParam(name)).toBe(
			namesCredentialParam(name)
		);
	});
});

const [queryFixturePath] = ENGINE_READING_GUARDS.mcpQueryEncoding.paths.map(fromRepoRoot);
const queryFixture = JSON.parse(readFileSync(queryFixturePath, "utf8")) as {
	components: { name: string; text: string; key: string; value: string }[];
};

describe("MCP query value encoding conformance", () => {
	it("read a non-empty fixture", () => {
		expect(queryFixture.components.length).toBeGreaterThan(0);
	});

	it.each(queryFixture.components)("encodes $name as the engine writes a value", (row) => {
		expect(encodeQueryValue(row.text)).toBe(row.value);
	});

	it.each(queryFixture.components)("encodes $name as the engine writes a key", (row) => {
		expect(encodeQueryKey(row.text)).toBe(row.key);
	});
});
