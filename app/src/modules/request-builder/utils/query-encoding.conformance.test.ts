/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the app's query encoder against the engine's
 * (`engine/src/core/query_encoding.cpp`, which the Postman import and a
 * query-located API key go through), over the fixture both suites read
 * (issue #1771).
 *
 * The Params table writes the URL the engine then sends verbatim, and the
 * snippets append an API key the engine appends on send, so a case answered
 * two ways is a table edit that sends another query than an import of the same
 * rows would.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { KeyValueEntry } from "@/types";
import { resolveTemplate } from "@/lib/variable-resolution";
import { encodeQueryComponent, resolveUrlTemplate } from "./query-encoding";
import { buildUrlWithParams } from "./url";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.queryEncoding.paths.map(fromRepoRoot);

interface ComponentCase {
	name: string;
	text: string;
	key: string;
	value: string;
}

interface QueryCase {
	name: string;
	rows: KeyValueEntry[];
	encode?: false;
	query: string;
}

interface SubstitutionCase {
	name: string;
	url: string;
	variables: Record<string, string>;
	encode?: false;
	sent: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	components: ComponentCase[];
	queries: QueryCase[];
	substitutions: { cases: SubstitutionCase[] };
};

describe("query encoding conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.components.length).toBeGreaterThan(20);
		expect(fixture.queries.length).toBeGreaterThan(10);
		expect(fixture.substitutions.cases.length).toBeGreaterThan(10);
	});

	it.each(fixture.components.map((c) => [c.name, c] as const))("component: %s", (_name, c) => {
		expect(encodeQueryComponent(c.text, "key")).toBe(c.key);
		expect(encodeQueryComponent(c.text, "value")).toBe(c.value);
	});

	it.each(fixture.queries.map((c) => [c.name, c] as const))("query: %s", (_name, c) => {
		expect(buildUrlWithParams("https://x/", c.rows, { encode: c.encode !== false })).toBe(
			c.query ? `https://x/?${c.query}` : "https://x/"
		);
	});

	// Issue #1773: the Sends line resolves the URL as compose does.
	it.each(fixture.substitutions.cases.map((c) => [c.name, c] as const))(
		"substitution: %s",
		(_name, c) => {
			const resolve = (text: string) => resolveTemplate(text, (name) => c.variables[name]);
			expect(resolveUrlTemplate(c.url, resolve, { encode: c.encode !== false })).toBe(c.sent);
		}
	);
});
