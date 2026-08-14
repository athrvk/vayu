/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Since issue #226 the engine owns execution-time resolution: every renderer
 * send site hands `POST /compose` the *raw* editor state and executes the
 * composed payload unchanged. The regression this guards is the quiet one:
 * a send site that starts resolving client-side again (reintroducing
 * `resolveString` / `resolveAuthForSend` into a payload) would interpolate the
 * payload twice - a body legitimately containing `{{...}}` gets mangled, and
 * `useVariableResolver`'s preview semantics silently become execution
 * semantics again. Nothing errors, nothing fails to type-check.
 *
 * A scan, not a render: same rationale as `request-settings-plumbing.test.ts` -
 * the send sites live inside `useCallback`s wired to queries, stores and the
 * engine service, and standing that up tests the mocks. The behavioural half
 * (composed payload forwarded unchanged, empty auth dropped) is asserted by
 * `DesignRunView.test.tsx` against a compose mock and, for the composition
 * itself, by the engine's request_composer_test.cpp.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob(
	["/src/modules/request-builder/index.tsx", "/src/modules/history/main/DesignRunView.tsx"],
	{ query: "?raw", import: "default", eager: true }
);

const builder = sources["/src/modules/request-builder/index.tsx"] as string | undefined;
const runView = sources["/src/modules/history/main/DesignRunView.tsx"] as string | undefined;

describe("every send site composes engine-side and never resolves client-side", () => {
	it("found both send-site sources (guards the scan itself)", () => {
		for (const src of [builder, runView]) {
			expect(typeof src).toBe("string");
			expect((src ?? "").length).toBeGreaterThan(1000);
			expect(src).toContain("engineExecuteRequest");
		}
	});

	it("the builder composes for Send and for a load test", () => {
		/*
		 * Two compose call sites, not three. `composeForSend` is shared by the
		 * buffered Send and the streaming one (issue #574) - they differ only in
		 * which endpoint answer they take, so a second composer for the stream
		 * would be a copy that could drift into measuring a different request.
		 * The other site is `handleConfirmLoadTest`.
		 */
		const calls = (builder ?? "").match(/engineComposeRequest\(\{/g) ?? [];
		expect(calls).toHaveLength(2);
		// The composed result is what gets executed / started, not a rebuilt one.
		expect(builder).toContain("{ ...composed, requestId: fetchedRequest.id, stream: false }");
		expect(builder).toContain("...(composed as unknown as StartLoadTestRequest)");
		// The streaming send spreads the same composed payload.
		expect(builder).toContain("apiService.executeStreamRequest({");
		expect(builder).toContain("...composed,");
	});

	it("the run view composes for replay", () => {
		const calls = (runView ?? "").match(/engineComposeRequest\(\{/g) ?? [];
		expect(calls).toHaveLength(1);
		expect(runView).toContain("...composed,");
	});

	it("no send site resolves variables or inherit auth client-side anymore", () => {
		for (const src of [builder ?? "", runView ?? ""]) {
			// `resolveString` was the execution-time interpolation; `resolveObject`
			// survives in the builder only for the load dialog's OAuth expiry
			// *preview* (pendingOAuth2Config), which sends nothing.
			expect(src).not.toContain("resolveString");
			expect(src).not.toContain("resolveAuthForSend");
		}
		const previewUses = (builder ?? "").match(/resolveObject\(/g) ?? [];
		expect(previewUses.length).toBeLessThanOrEqual(1);
	});

	it("raw editor state goes into compose - buildExecBody with the identity resolver", () => {
		// `buildExecBody(request, (s) => s)` twice in the builder (Send + load),
		// once in the run view. A resolver hooked back in here is the
		// double-interpolation regression.
		expect((builder ?? "").match(/buildExecBody\(\w+, \(s\) => s\)/g) ?? []).toHaveLength(2);
		expect((runView ?? "").match(/buildExecBody\(\w+, \(s\) => s\)/g) ?? []).toHaveLength(1);
	});
});
