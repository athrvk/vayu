/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The redirect policy has four hops in the renderer, and each one fails
 * silently on its own.
 *
 * Drop it from `initialRequest` and a saved `followRedirects: false` never
 * loads - the editor merges over `createDefaultRequestState()`, so the default
 * wins and the setting appears to work until the tab is reopened. Drop it from
 * `handleSave` and it is never persisted. Drop it from the execute payload and
 * the engine applies its own default (follow), so the 3xx the user asked to see
 * is followed anyway. Drop it from the load-test payload and the load test
 * measures a different request than Send does. None of the four produces an
 * error, a type failure, or a visibly broken screen - which is exactly the
 * "written but never read" shape this codebase keeps hitting.
 *
 * A scan, not a render: the four hops live inside `useCallback`s in a component
 * wired to TanStack Query, several zustand stores and the engine service.
 * Standing that up would test the mocks. Each hop is matched by the distinctive
 * source expression it reads from, so deleting any one of them trips exactly
 * one assertion.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/modules/request-builder/index.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const source = Object.values(sources)[0] as string | undefined;

/** Occurrences of `field: <expr>.<field>` in the payload object literals. */
function hops(src: string, holder: string, field: string): number {
	const re = new RegExp(`\\b${field}:\\s*${holder}\\.${field}\\b`, "g");
	return (src.match(re) ?? []).length;
}

describe("redirect policy reaches every payload the renderer builds", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(typeof source).toBe("string");
		expect((source ?? "").length).toBeGreaterThan(1000);
		expect(source).toContain("engineExecuteRequest");
	});

	for (const field of ["followRedirects", "maxRedirects"] as const) {
		it(`loads ${field} from the saved request into the editor state`, () => {
			expect(hops(source ?? "", "fetchedRequest", field)).toBe(1);
		});

		it(`sends ${field} on execute and persists it on save`, () => {
			// One for the `engineExecuteRequest` body, one for the update mutation.
			expect(hops(source ?? "", "request", field)).toBe(2);
		});

		it(`sends ${field} with the load test`, () => {
			expect(hops(source ?? "", "pendingLoadTestRequest", field)).toBe(1);
		});
	}
});
