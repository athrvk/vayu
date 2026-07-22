/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load-test payload's `tests` field is built by calling `scriptParts()`
 * over the collection chain, not by forwarding the request's own `testScript`
 * directly - that is the whole point of Task 7 (a load run used to validate
 * only the request's own test script; a collection-level assertion passed in
 * design mode and was never checked under load).
 *
 * Delete that `scriptParts(...)` call and fall back to
 * `tests: pendingLoadTestRequest.testScript || undefined` and: it still
 * type-checks (`ScriptPart[] | undefined` vs `string | undefined` would be
 * the only mismatch, and a bare string literal assignment fails, but nothing
 * stops a well-meaning "simplification" that wraps the string back into a
 * single-element list), the rest of the suite still passes, and load runs
 * silently stop validating collection-level scripts again - a "written but
 * never read" regression with no error, no type failure, and no visibly
 * broken screen.
 *
 * A scan, not a render: same rationale as `redirect-policy-plumbing.test.ts` -
 * standing up the component would test the mocks, not the wiring.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/modules/request-builder/index.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const source = Object.values(sources)[0] as string | undefined;

describe("load test's `tests` field is built from the collection chain", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(typeof source).toBe("string");
		expect((source ?? "").length).toBeGreaterThan(1000);
		expect(source).toContain("startLoadTest");
	});

	it("calls scriptParts() for `tests`, exactly once", () => {
		const src = source ?? "";
		// If the load payload reverts to sending `pendingLoadTestRequest.testScript`
		// directly (with or without wrapping it in a one-element array literal),
		// this trips to zero.
		const calls = src.match(/tests:\s*scriptParts\(/g) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("passes the collection chain and the request's own test script into that call", () => {
		const src = source ?? "";
		const callStart = src.indexOf("tests: scriptParts(");
		expect(callStart).toBeGreaterThan(-1);

		// `pendingLoadTestRequest.testScript` appears exactly once in the file -
		// as the last argument of this call. If the chain were dropped in favour
		// of the request's own script alone, this index would move outside (or
		// disappear from) the call's argument block.
		const testScriptIndex = src.indexOf("pendingLoadTestRequest.testScript");
		expect(testScriptIndex).toBeGreaterThan(callStart);

		const callBlock = src.slice(
			callStart,
			testScriptIndex + "pendingLoadTestRequest.testScript".length
		);
		expect(callBlock).toContain("collectionAncestors");
		expect(callBlock).toContain("postRequestScript");
	});
});
