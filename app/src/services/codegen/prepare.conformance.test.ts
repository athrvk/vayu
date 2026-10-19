/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: which header a request's auth writes when the
 * request already carries one, against the engine's `apply_auth`
 * (`engine/src/http/auth_resolver.cpp`), over the fixture both suites read
 * (issue #2475).
 *
 * A snippet that prints the typed header and the auth one sends two lines where
 * Vayu sends one, so a case answered two ways is a snippet that does not do
 * what the app just did.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { prepareRequest } from "./prepare";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.authHeaderPrecedence.paths.map(fromRepoRoot);

interface PrecedenceCase {
	name: string;
	headers: Record<string, string>;
	auth: Record<string, unknown>;
	url: string;
	expected: { headers: Array<[string, string]>; url: string };
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: PrecedenceCase[] };

/**
 * The header pairs a request sends. Basic credentials stay structured in a
 * prepared request (curl `-u`, HTTPie `-a`, `auth=`), so they are rendered as
 * the `Authorization` every one of those writes.
 */
function wireHeaders(prepared: ReturnType<typeof prepareRequest>): Array<[string, string]> {
	if (!prepared.basicAuth) return prepared.headers;
	const { username, password } = prepared.basicAuth;
	const encoded = Buffer.from(`${username}:${password}`).toString("base64");
	return [...prepared.headers, ["Authorization", `Basic ${encoded}`]];
}

const byName = (a: [string, string], b: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);

describe("auth header precedence conformance fixture", () => {
	it("replays every case of a non-empty fixture", () => {
		// An empty table would pass every case, so the count is asserted too.
		expect(fixture.cases.length).toBeGreaterThan(10);
		let replayed = 0;
		for (const c of fixture.cases) {
			const prepared = prepareRequest({
				method: "GET",
				url: c.url,
				headers: c.headers,
				auth: c.auth,
			});
			expect([...wireHeaders(prepared)].sort(byName), c.name).toEqual(
				[...c.expected.headers].sort(byName)
			);
			expect(prepared.url, c.name).toBe(c.expected.url);
			replayed += 1;
		}
		expect(replayed).toBeGreaterThanOrEqual(fixture.cases.length);
	});
});
