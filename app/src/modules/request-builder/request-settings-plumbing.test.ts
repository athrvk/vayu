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
 * `verifySSL` joined them in issue #706, with the same four hops and one extra
 * reason to send it at the default: the engine's default is to *verify*, so a
 * dropped `false` does not merely pick the engine's preference - it verifies
 * the certificate the user turned verification off for, and the request fails
 * against the host the setting exists for.
 *
 * All four fields have the same shape at every hop, deliberately. A revision
 * of this branch gave `httpVersion` a per-run picker in the load test dialog,
 * so the load-test hop read the confirmed `LoadTestConfig` instead of the
 * request. That was reversed: one control in the request builder's Settings
 * tab governs Send and load test alike, which is what `followRedirects` and
 * `maxRedirects` already did. A second control for one of the three would have
 * made that tab mean something different for that field alone.
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

	for (const field of ["followRedirects", "maxRedirects", "httpVersion", "verifySSL"] as const) {
		it(`loads ${field} from the saved request into the editor state`, () => {
			expect(hops(source ?? "", "fetchedRequest", field)).toBe(1);
		});

		it(`sends ${field} on execute and persists it on save`, () => {
			// One for the `engineExecuteRequest` body, one for the update mutation.
			expect(hops(source ?? "", "request", field)).toBe(2);
		});
	}

	for (const field of ["followRedirects", "maxRedirects", "httpVersion", "verifySSL"] as const) {
		it(`sends ${field} with the load test`, () => {
			expect(hops(source ?? "", "pendingLoadTestRequest", field)).toBe(1);
		});
	}

	/**
	 * `stream` has the same load hop and the same save hop, and a *different*
	 * execute hop, which is the point (issue #574).
	 *
	 * The other three fields ride the composed payload as
	 * `field: request.field`. This one selects which endpoint answer the send
	 * takes, so each path declares the flag it means unconditionally - the
	 * buffered execute sends `stream: false`, the streaming service sends
	 * `stream: true` - and the request's own flag is read once, in the provider,
	 * to choose between them. Passing `request.stream` through instead would
	 * make it possible for the payload and the path taken to disagree, which is
	 * the one thing that must be unrepresentable here.
	 */
	it("loads the event-stream flag from the saved request and persists it on save", () => {
		expect(hops(source ?? "", "fetchedRequest", "stream")).toBe(1);
		expect(hops(source ?? "", "request", "stream")).toBe(1);
	});

	it("declares stream on the buffered execute rather than letting it default", () => {
		expect(source).toContain("stream: false");
	});

	it("takes the load test's stream flag from the request, never from the dialog", () => {
		// `POST /runs` refused `stream` outright until issue #576, when the load
		// event loop learned to bound one. It is still read off the *request*
		// and never off the load config: whether a request streams belongs to
		// the request's Settings tab, and only the caps - how much of each
		// stream this run measures - belong to the dialog. A `config.stream`
		// here would mean a second control had crept in, exactly as
		// `config.httpVersion` would below.
		expect(hops(source ?? "", "pendingLoadTestRequest", "stream")).toBe(1);
		expect(hops(source ?? "", "config", "stream")).toBe(0);
	});

	it("sends both stream caps from the dialog, in the engine's milliseconds", () => {
		// The other half of that split, and the one a refactor could silently
		// drop: without the caps the run is bounded by the engine's
		// `sseMaxStreamDurationMs` setting, which the dialog never showed.
		expect(source).toContain("maxStreamEvents: config.stream_max_events");
		expect(source).toContain("config.stream_duration_seconds * 1000");
	});

	it("takes the load test's protocol from the request, never from the dialog's config", () => {
		// The load dialog decides load shape (rps, duration, concurrency), not
		// request semantics. A `config.httpVersion` here would mean a second
		// control had crept back in and the Settings tab no longer governs both
		// modes.
		expect(hops(source ?? "", "config", "httpVersion")).toBe(0);
	});

	/**
	 * Starting a load test must never write to the saved request. There is no
	 * per-run protocol override any more, so this is no longer about protecting
	 * one from leaking - but `handleConfirmLoadTest` still reads request state
	 * to build its payload, and the cheapest way for a future edit to go wrong
	 * is to persist something while it is in there. `updateRequestMutation` is
	 * the only path that writes a request (`handleSave` is its sole caller this
	 * scan permits), so its absence from this body is the guard.
	 */
	it("confirming a load test never writes anything back to the request", () => {
		const src = source ?? "";
		const start = src.indexOf("const handleConfirmLoadTest");
		const end = src.indexOf("const handleCloseLoadTestDialog");

		// Guards the slice itself: a rename of either marker would make the
		// assertions below pass over an empty or wrong body.
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = src.slice(start, end);
		expect(body.length).toBeGreaterThan(500);

		expect(body).toContain("httpVersion: pendingLoadTestRequest.httpVersion");
		expect(body).not.toContain("updateRequestMutation");
	});
});
