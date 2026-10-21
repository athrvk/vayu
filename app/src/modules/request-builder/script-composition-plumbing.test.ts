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
 * `inherit.disable`. Since issue #2638 the call lives in `buildComposeBody`
 * (`utils/compose-body.ts`), which Send and the load test both build through:
 * the load test hands it the chain and reads the resolved list back as its
 * `requestElements`. Hand it `{ resolved: pendingLoadTestRequest.elements }`
 * instead, or drop the chain, and: it still type-checks, the rest of the
 * suite still passes, and a load run silently stops validating
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

const composeBodySources = import.meta.glob("/src/modules/request-builder/utils/compose-body.ts", {
	query: "?raw",
	import: "default",
	eager: true,
});

const composeBody = Object.values(composeBodySources)[0] as string | undefined;

describe("load test's step-level elements are built from the collection chain", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(typeof source).toBe("string");
		expect((source ?? "").length).toBeGreaterThan(1000);
		expect(source).toContain("startLoadTest");
		expect(typeof composeBody).toBe("string");
		expect((composeBody ?? "").length).toBeGreaterThan(1000);
		expect(composeBody).toContain("export function buildComposeBody");
	});

	it("the shared compose body resolves its elements from the chain with elementsParts()", () => {
		const shared = composeBody ?? "";
		const calls = shared.match(/elementsParts\(/g) ?? [];
		expect(calls).toHaveLength(1);
		expect(shared).toMatch(
			/elementsParts\(input\.elements\.chain, input\.elements\.ownerId, request\.elements\)/
		);
	});

	it("takes the load test's requestElements from the shared body, built over the chain", () => {
		const src = source ?? "";
		const callStart = src.indexOf(
			"const { body, elements: requestElements } = buildComposeBody({"
		);
		expect(callStart).toBeGreaterThan(-1);

		// A window bounded well past the call's own argument list, not the rest
		// of the file - a match anywhere after `callStart` could belong to
		// something that has nothing to do with this call.
		const CALL_WINDOW = 400;
		const window = src.slice(callStart, callStart + CALL_WINDOW);

		// The chain and the owning request, not a pre-resolved list: a
		// `{ resolved: ... }` source here is the request's own elements alone.
		expect(window).toContain("request: pendingLoadTestRequest,");
		expect(window).toContain(
			"elements: { chain: collectionAncestors, ownerId: fetchedRequest.id }"
		);
		expect(window).not.toContain("resolved:");
	});

	it("sends the resolved elements to compose, not the retired tests field", () => {
		const src = source ?? "";
		// The legacy field `POST /runs` now refuses by name (issue #1594) must
		// not still be built for this payload.
		expect(src).not.toMatch(/tests:\s*scriptParts\(/);
		// And the shared body carries the resolved list it returns.
		expect(composeBody ?? "").toMatch(/\n\t+elements,\n/);
	});
});
