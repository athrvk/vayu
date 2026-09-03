/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the MCP variable resolver honest against the renderer's.
 *
 * `electron/mcp/variable-origins.ts` backs the MCP `resolve_variables` tool;
 * `src/lib/variable-resolution.ts` backs the app's own preview and popover. They
 * pick the winner the same way, written twice, because the process boundary
 * forbids sharing a source file in either direction: the main process emits with
 * `rootDir: "electron"` and cannot compile a file from `src/` (TS6059), and the
 * renderer cannot import one from `electron/`, which is a referenced composite
 * project (TS6305; excluding a file from that project to dodge it is TS6307).
 *
 * Drift here would be quiet and expensive - an agent told one variable answers a
 * name while the send uses another - so this file is where the two meet, the way
 * `compare.conformance.test.ts` does for the run diff. It reaches across the
 * boundary the way `tools.test.ts` already reaches for `@/constants`: a test may,
 * production code may not.
 *
 * The cases are the engine's own conformance fixture - the same 40 the engine's
 * C++ suite and `src/lib/variable-resolution.conformance.test.ts` replay - so all
 * three implementations answer one table. A case added there fails whichever side
 * forgot it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildVariableValues, type StoredVariableBag } from "@/lib/variable-resolution";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import {
	buildVariableOrigins,
	collectionChain,
	resolveVariableReports,
	type OriginScopes,
} from "./variable-origins.js";

const [fixturePath] = ENGINE_READING_GUARDS.mcpVariableOrigins.paths.map(fromRepoRoot);

interface ConformanceCase {
	name: string;
	scopes: {
		globals?: StoredVariableBag;
		chain?: StoredVariableBag[];
		environment?: StoredVariableBag;
	};
	input: string;
	expected: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: ConformanceCase[] };

/** The fixture's flat bags, in the shape this module's chain/environment take. */
function asOriginScopes(scopes: ConformanceCase["scopes"]): OriginScopes {
	return {
		globals: scopes.globals,
		chain: (scopes.chain ?? []).map((variables, i) => ({
			id: `c${i}`,
			name: `Collection ${i}`,
			variables,
		})),
		...(scopes.environment
			? { environment: { id: "e", name: "Env", variables: scopes.environment } }
			: {}),
	};
}

describe("MCP variable origins agree with the renderer's resolver", () => {
	test.each(fixture.cases.map((c) => [c.name, c] as const))(
		"%s - every name's winner matches buildVariableValues",
		(_name, c) => {
			const scopes = asOriginScopes(c.scopes);
			const rendererWinners = buildVariableValues({
				globals: c.scopes.globals,
				chain: c.scopes.chain,
				environment: c.scopes.environment,
			});

			for (const report of resolveVariableReports(scopes)) {
				const rendererValue = rendererWinners.get(report.name);
				if (report.resolved) {
					// Not a secret anywhere in the fixture, so the value is present.
					expect(report.value, report.name).toBe(rendererValue);
				} else {
					// Every definition disabled: the renderer drops the name entirely
					// rather than carrying it as an empty string.
					expect(rendererValue, report.name).toBeUndefined();
				}
			}

			// And the other direction: a name the renderer resolves is one this
			// module reports as resolved. Without this, dropping every name would
			// pass the loop above vacuously.
			const reported = new Map(
				resolveVariableReports(scopes)
					.filter((r) => r.resolved)
					.map((r) => [r.name, r.value])
			);
			expect(Object.fromEntries(reported)).toEqual(Object.fromEntries(rendererWinners));
		}
	);

	test("the fixture is non-empty and actually exercises all three scopes", () => {
		expect(fixture.cases.length).toBeGreaterThan(0);
		const used = new Set<string>();
		for (const c of fixture.cases) for (const k of Object.keys(c.scopes)) used.add(k);
		expect([...used].sort()).toEqual(["chain", "environment", "globals"]);
	});
});

describe("what the winner alone cannot say", () => {
	test("a disabled higher scope loses to the enabled one beneath, and says why", () => {
		const reports = resolveVariableReports({
			globals: { host: { value: "globals.test", enabled: true } },
			environment: {
				id: "e1",
				name: "Staging",
				variables: { host: { value: "env.test", enabled: false } },
			},
		});

		expect(reports).toHaveLength(1);
		const [host] = reports;
		expect(host.resolved).toBe(true);
		expect(host.value).toBe("globals.test");
		expect(host.scope).toBe("global");
		// The answer to "why is this not the value I set?" - a switched-off row,
		// not shadowing. Dropping `reason` here would make the two cases identical.
		expect(host.shadowedBy).toEqual([
			{
				scope: "environment",
				sourceId: "e1",
				sourceName: "Staging",
				value: "env.test",
				enabled: false,
				reason: "disabled",
			},
		]);
	});

	test("shadowed definitions read highest precedence first, each naming its collection", () => {
		const reports = resolveVariableReports({
			globals: { host: { value: "g", enabled: true } },
			chain: [
				{ id: "root", name: "Root", variables: { host: { value: "root", enabled: true } } },
				{ id: "leaf", name: "Leaf", variables: { host: { value: "leaf", enabled: true } } },
			],
		});

		const [host] = reports;
		expect(host.value).toBe("leaf");
		expect(host.sourceName).toBe("Leaf");
		// Two collections in one chain are two origins: collapsing them by scope
		// would hide the override that actually happened.
		expect(host.shadowedBy.map((s) => [s.scope, s.sourceName, s.value])).toEqual([
			["collection", "Root", "root"],
			["global", undefined, "g"],
		]);
	});

	test("every definition disabled resolves to nothing, not to the empty string", () => {
		const [host] = resolveVariableReports({
			globals: { host: { value: "g", enabled: false } },
		});
		expect(host.resolved).toBe(false);
		expect(host).not.toHaveProperty("value");
		expect(host.shadowedBy).toHaveLength(1);
	});

	test("a secret's value is withheld rather than silently dropped", () => {
		const [token] = resolveVariableReports({
			globals: { token: { value: "s3cret", enabled: true, secret: true } },
		});
		expect(token.resolved).toBe(true);
		expect(token).not.toHaveProperty("value");
		expect(token.valueWithheld).toBe(true);
		expect(token.secret).toBe(true);
	});

	test("a requested name nothing defines gets a row saying so", () => {
		const [missing] = resolveVariableReports({ globals: {} }, ["nope"]);
		expect(missing).toEqual({ name: "nope", resolved: false, shadowedBy: [] });
	});
});

describe("the collection chain walk", () => {
	const rows = [
		{ id: "root", name: "Root", parentId: null, variables: {} },
		{ id: "mid", name: "Mid", parentId: "root", variables: {} },
		{ id: "leaf", name: "Leaf", parentId: "mid", variables: {} },
	];

	test("walks root-first", () => {
		expect(collectionChain(rows, "leaf").map((c) => c.id)).toEqual(["root", "mid", "leaf"]);
	});

	test("treats null, absent and empty-string parents alike as root", () => {
		expect(collectionChain([{ id: "a", parentId: "" }], "a").map((c) => c.id)).toEqual(["a"]);
		expect(collectionChain([{ id: "a" }], "a").map((c) => c.id)).toEqual(["a"]);
		expect(collectionChain([{ id: "a", parentId: null }], "a").map((c) => c.id)).toEqual(["a"]);
	});

	test("a corrupted parentId loop terminates instead of hanging", () => {
		const looped = [
			{ id: "a", parentId: "b" },
			{ id: "b", parentId: "a" },
		];
		expect(collectionChain(looped, "a").map((c) => c.id)).toEqual(["b", "a"]);
		expect(collectionChain([{ id: "s", parentId: "s" }], "s").map((c) => c.id)).toEqual(["s"]);
	});

	test("an unknown id yields an empty chain rather than throwing", () => {
		expect(collectionChain(rows, "ghost")).toEqual([]);
	});
});

describe("origin accumulation", () => {
	test("marks the winner rather than inferring it from position", () => {
		const origins = buildVariableOrigins({
			globals: { host: { value: "g", enabled: true } },
			environment: {
				id: "e",
				name: "E",
				variables: { host: { value: "e", enabled: false } },
			},
		});
		// The last entry is the environment's, and it is not the winner.
		expect(origins.host.map((o) => [o.scope, o.winner])).toEqual([
			["global", true],
			["environment", false],
		]);
	});

	test("D17: absent enabled counts as enabled, a non-string value reads as empty", () => {
		const origins = buildVariableOrigins({
			globals: { a: { value: "x" }, b: { value: 42, enabled: true } },
		});
		expect(origins.a[0].enabled).toBe(true);
		expect(origins.b[0].value).toBe("");
	});
});
