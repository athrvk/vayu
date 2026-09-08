/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load-test payload's step-level elements are built by calling
 * `elementsParts()` over the collection chain (issue #1594), not by
 * forwarding the request's own elements directly - that is the whole point
 * of the wiring this guards: a load run used to validate only the request's
 * own `script.post` text (and only that one kind); a collection-level
 * element, or any `extract.*` / `assert.*` / `timer.think` element at all,
 * passed in design mode and was never checked under load.
 *
 * `elementsParts(collectionAncestors, requestId, requestElements)` resolves
 * the whole chain - root to leaf, then the request's own, minus
 * `inherit.disable` - the same call `handleSendRequest`'s own compose call
 * makes. Delete the `elementsParts(...)` call and fall back to
 * `pendingLoadTestRequest.elements` alone and: it still type-checks, the
 * rest of the suite still passes, and a load run silently stops validating
 * collection-level elements again - a "written but never read" regression
 * with no error, no type failure, and no visibly broken screen.
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

describe("load test's step-level elements are built from the collection chain", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(typeof source).toBe("string");
		expect((source ?? "").length).toBeGreaterThan(1000);
		expect(source).toContain("startLoadTest");
	});

	it("calls elementsParts() for the load test's requestElements, exactly once", () => {
		const src = source ?? "";
		// If the load payload reverts to sending `pendingLoadTestRequest.elements`
		// directly, this trips to zero.
		const calls = src.match(/const requestElements = elementsParts\(/g) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("passes the collection chain and the request's own elements into that call", () => {
		const src = source ?? "";
		const callStart = src.indexOf("const requestElements = elementsParts(");
		expect(callStart).toBeGreaterThan(-1);

		// The request's own elements, as the call's last argument. If the
		// chain were dropped in favour of the request's own elements alone,
		// this index would move outside (or disappear from) the call's
		// argument block.
		const ownElementsCall = "pendingLoadTestRequest.elements";
		const ownElementsIndex = src.indexOf(ownElementsCall, callStart);
		expect(ownElementsIndex).toBeGreaterThan(callStart);

		const callBlock = src.slice(callStart, ownElementsIndex + ownElementsCall.length);
		expect(callBlock).toContain("collectionAncestors");
		expect(callBlock).toContain("fetchedRequest.id");
	});

	it("sends the resolved elements to compose, not the retired tests field", () => {
		const src = source ?? "";
		// The legacy field `POST /runs` now refuses by name (issue #1594) must
		// not still be built for this payload.
		expect(src).not.toMatch(/tests:\s*scriptParts\(/);
		expect(src).toContain("elements: requestElements");
	});
});
