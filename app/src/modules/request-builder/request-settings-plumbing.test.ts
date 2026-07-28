/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The redirect policy and the protocol (`httpVersion`) each have four hops in
 * the renderer, and each hop fails silently on its own.
 *
 * Drop a field from `initialRequest` and a saved non-default value never
 * loads - the editor merges over `createDefaultRequestState()`, so the default
 * wins and the setting appears to work until the tab is reopened. This is the
 * exact bug `httpVersion` had: a stored `http2` request loaded into the
 * builder as `auto`, and the very next auto-save silently downgraded it,
 * because `initialRequest` copied `followRedirects` / `maxRedirects` but not
 * `httpVersion`. Drop a field from `handleSave` and it is never persisted.
 * Drop it from the execute payload and the engine applies its own default, so
 * the user gets a protocol (or a followed 3xx) they did not ask for. Drop it
 * from the load-test payload and the load test measures a different request
 * than Send does. None of these produces an error, a type failure, or a
 * visibly broken screen - which is exactly the "written but never read" shape
 * this codebase keeps hitting.
 *
 * A scan, not a render: the hops live inside `useCallback`s in a component
 * wired to TanStack Query, several zustand stores and the engine service.
 * Standing that up would test the mocks. Each hop is matched by the distinctive
 * source expression it reads from, so deleting any one of them trips exactly
 * one assertion.
 *
 * Formerly `redirect-policy-plumbing.test.ts` - renamed when `httpVersion`
 * joined the fields this file guards, for the same reason
 * `isRedirectPolicyNonDefault` was renamed to `isRequestSettingsNonDefault`: a
 * name that only mentions redirects is how the next field misses this file.
 *
 * `httpVersion` diverges from the other two at the load-test hop only (Task
 * 12): `LoadTestConfigDialog` pre-fills its picker from the request's own
 * protocol but lets the user override it for that run alone, so the
 * load-test payload must read the confirmed `LoadTestConfig`, not
 * `pendingLoadTestRequest` directly - reading the request there would
 * silently discard the override and is exactly the bug this file exists to
 * catch. `followRedirects`/`maxRedirects` have no such override yet, so they
 * keep the original shape.
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

describe("redirect policy and protocol reach every payload the renderer builds", () => {
	it("found the request builder source (guards the scan itself)", () => {
		// vitest stubs some imports to "", and a moved file would make every
		// assertion below pass vacuously.
		expect(typeof source).toBe("string");
		expect((source ?? "").length).toBeGreaterThan(1000);
		expect(source).toContain("engineExecuteRequest");
	});

	for (const field of ["followRedirects", "maxRedirects", "httpVersion"] as const) {
		it(`loads ${field} from the saved request into the editor state`, () => {
			expect(hops(source ?? "", "fetchedRequest", field)).toBe(1);
		});

		it(`sends ${field} on execute and persists it on save`, () => {
			// One for the `engineExecuteRequest` body, one for the update mutation.
			expect(hops(source ?? "", "request", field)).toBe(2);
		});
	}

	for (const field of ["followRedirects", "maxRedirects"] as const) {
		it(`sends ${field} with the load test`, () => {
			expect(hops(source ?? "", "pendingLoadTestRequest", field)).toBe(1);
		});
	}

	it("sends the load test's per-run httpVersion override, not the saved request's protocol directly", () => {
		expect(hops(source ?? "", "config", "httpVersion")).toBe(1);
		expect(hops(source ?? "", "pendingLoadTestRequest", "httpVersion")).toBe(0);
	});

	/**
	 * The data-loss case Task 12 calls out explicitly: confirming a load test
	 * with an overridden protocol must never persist that override onto the
	 * saved request - a user trying one run at HTTP/1.1 must not permanently
	 * downgrade their request. `updateRequestMutation` is the only path that
	 * writes a request (see `handleSave` above, which is the sole caller this
	 * scan permits), so its absence from `handleConfirmLoadTest`'s body is what
	 * proves the override stays run-scoped.
	 */
	it("confirming a load test never writes the per-run override back to the request", () => {
		const src = source ?? "";
		const start = src.indexOf("const handleConfirmLoadTest");
		const end = src.indexOf("const handleCloseLoadTestDialog");

		// Guards the slice itself: a rename of either marker would make the
		// assertions below pass over an empty or wrong body.
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = src.slice(start, end);
		expect(body.length).toBeGreaterThan(500);

		expect(body).toContain("httpVersion: config.httpVersion");
		expect(body).not.toContain("updateRequestMutation");
	});
});
