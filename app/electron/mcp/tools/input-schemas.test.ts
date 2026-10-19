/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file input-schemas.test.ts
 * @brief Holds the shared `auth` input to a closed set of modes (#2477).
 *
 * The engine maps an unknown mode to "no auth" and sends anyway, and reads only
 * `in: "query"` as query placement, so a mistyped mode or a Postman-style
 * `addTo` used to come back as an ordinary result for an unauthenticated
 * request. The refusal has to be the schema's.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOLS } from "../tools.js";
import { authInput, storedAuthInput } from "./input-schemas.js";

const MODES = ["bearer", "basic", "apikey", "oauth2", "inherit", "none", "noauth"];

/** The messages a refused parse carries. */
function refusal(value: unknown, schema: z.ZodType = authInput): string[] {
	const parsed = schema.safeParse(value);
	expect(parsed.success).toBe(false);
	return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("authInput modes", () => {
	it.each(MODES)("accepts %s", (mode) => {
		expect(authInput.safeParse({ mode }).success).toBe(true);
	});

	it("accepts an omitted auth block, which keeps what is stored", () => {
		expect(authInput.safeParse(undefined).success).toBe(true);
	});

	it("keeps the members the engine owns", () => {
		const block = { mode: "oauth2", config: { grantType: "client_credentials" } };
		expect(authInput.parse(block)).toEqual(block);
	});

	it.each(["Bearer", "api-key", "BASIC", ""])("refuses the misspelling %j", (mode) => {
		const [message] = refusal({ mode });
		expect(message).toContain("Unknown auth mode");
		expect(message).toContain(MODES.join(", "));
		expect(message).toContain('Leave "auth" out to keep what is stored');
	});

	it.each(["digest", "aws", "ntlm", "hawk", "oauth1", "edgegrid", "jwt"])(
		"refuses the unexecuted mode %s by saying Vayu does not execute it",
		(mode) => {
			const [message] = refusal({ mode });
			expect(message).toContain(`Vayu does not execute auth mode "${mode}"`);
			expect(message).toContain('Leave "auth" out to keep what is stored');
		}
	);

	it("refuses a block with no mode", () => {
		expect(refusal({ token: "t" })).not.toHaveLength(0);
	});
});

describe("authInput apikey placement", () => {
	it("accepts in: query", () => {
		expect(
			authInput.safeParse({ mode: "apikey", key: "k", value: "v", in: "query" }).success
		).toBe(true);
	});

	it("accepts in: header", () => {
		expect(
			authInput.safeParse({ mode: "apikey", key: "k", value: "v", in: "header" }).success
		).toBe(true);
	});

	it("accepts no placement, which the engine reads as a header", () => {
		expect(authInput.safeParse({ mode: "apikey", key: "k", value: "v" }).success).toBe(true);
	});

	it("refuses a Postman-style addTo and names in", () => {
		const [message] = refusal({ mode: "apikey", key: "k", value: "v", addTo: "query" });
		expect(message).toContain('"in"');
		expect(message).toContain('"addTo"');
	});

	it("refuses an in the engine would read as a header", () => {
		expect(refusal({ mode: "apikey", key: "k", value: "v", in: "cookie" })).not.toHaveLength(0);
	});

	it("leaves addTo alone on a mode that is not apikey", () => {
		expect(authInput.safeParse({ mode: "bearer", token: "t", addTo: "x" }).success).toBe(true);
	});
});

describe("the stored-auth description keeps the same schema", () => {
	const stored = storedAuthInput("a request", "Extra.");

	it("refuses what authInput refuses", () => {
		refusal({ mode: "Bearer" }, stored);
		refusal({ mode: "apikey", addTo: "query" }, stored);
	});

	it("accepts what authInput accepts", () => {
		expect(stored.safeParse({ mode: "bearer", token: "{{t}}" }).success).toBe(true);
	});
});

describe("a tool call is refused by the registered schema", () => {
	// `dispatchTool` runs the handler directly; the SDK validates the arguments
	// against `z.object(tool.inputSchema)` before dispatch (server.ts).
	const tools = TOOLS.filter((t) => "auth" in t.inputSchema);

	it("finds the tools that take an auth block", () => {
		const names = tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"run_request",
				"start_load_run",
				"create_request",
				"update_request",
			])
		);
	});

	it.each(["run_request", "start_load_run", "create_request", "update_request"])(
		"%s refuses mode Bearer",
		(name) => {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool).toBeDefined();
			const schema = z.object(tool?.inputSchema ?? {});
			const parsed = schema.safeParse({
				url: "https://api.example.com",
				requestId: "req_1",
				collectionId: "col_1",
				name: "r",
				auth: { mode: "Bearer", token: "t" },
			});
			expect(parsed.success).toBe(false);
			expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path[0])).toContain(
				"auth"
			);
		}
	);
});
