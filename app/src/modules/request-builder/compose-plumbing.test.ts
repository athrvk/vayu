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
 * Every send site builds its compose body through `buildComposeBody`
 * (`utils/compose-body.ts`, issue #2638), so the raw-state rule is scanned in
 * that one file, and the send sites are scanned for building through it rather
 * than spelling a payload of their own - a second literal is a copy that can
 * drift into composing a different request.
 *
 * A scan, not a render: same rationale as `request-settings-plumbing.test.ts` -
 * the send sites live inside `useCallback`s wired to queries, stores and the
 * engine service, and standing that up tests the mocks. The behavioural half
 * (composed payload forwarded unchanged, empty auth dropped) is asserted by
 * `DesignRunView.test.tsx` against a compose mock, the body's fields by
 * `compose-body.test.ts`, and the composition itself by the engine's
 * request_composer_test.cpp.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob(
	[
		"/src/modules/request-builder/index.tsx",
		"/src/modules/history/main/DesignRunView.tsx",
		"/src/modules/request-builder/utils/compose-body.ts",
	],
	{ query: "?raw", import: "default", eager: true }
);

const builder = sources["/src/modules/request-builder/index.tsx"] as string | undefined;
const runView = sources["/src/modules/history/main/DesignRunView.tsx"] as string | undefined;
const composeBody = sources["/src/modules/request-builder/utils/compose-body.ts"] as
	string | undefined;

describe("every send site composes engine-side and never resolves client-side", () => {
	it("found both send-site sources (guards the scan itself)", () => {
		for (const src of [builder, runView]) {
			expect(typeof src).toBe("string");
			expect((src ?? "").length).toBeGreaterThan(1000);
			expect(src).toContain("engineExecuteRequest");
		}
		expect(typeof composeBody).toBe("string");
		expect((composeBody ?? "").length).toBeGreaterThan(1000);
		expect(composeBody).toContain("export function buildComposeBody");
	});

	it("the builder composes for Send and for a load test", () => {
		/*
		 * Three engine compose calls, two bodies. `buildSendBody` is shared by the
		 * buffered Send and the streaming one (issue #574) - they differ only in
		 * which endpoint answer they take, so a second builder for the stream
		 * would be a copy that could drift into measuring a different request.
		 * Each handler makes the engine call itself, after taking `leftOut` from
		 * the built body (#3066). The other body is `handleConfirmLoadTest`'s.
		 * Both are the shared builder's; an inline `engineComposeRequest({` literal
		 * is a send site that stopped going through it.
		 */
		const calls = (builder ?? "").match(/engineComposeRequest\(/g) ?? [];
		expect(calls).toHaveLength(3);
		expect(builder).not.toMatch(/engineComposeRequest\(\{/);
		expect((builder ?? "").match(/buildComposeBody\(\{/g) ?? []).toHaveLength(2);
		/*
		 * The composed result is what gets executed / started, not a rebuilt one.
		 *
		 * Asserted as a spread plus the fields laid over it, rather than as one
		 * literal line: the payload gained `data` for a send-with-row (#601) and
		 * prettier broke the line, which turned a guard about *composition* red
		 * over formatting. What has to stay true is that `composed` is spread and
		 * nothing rebuilds it - so that is what is scanned for.
		 */
		// Anchored to the *first* member of the execute call's object literal:
		// an unbounded `[\s\S]*?` would happily find the `...composed` of the
		// load-test call further down the file and pass a rebuilt payload.
		const comments = String.raw`(?:\/\/[^\n]*\n\s*)*`;
		expect(builder).toMatch(
			new RegExp(
				String.raw`engineExecuteRequest\(\s*${comments}\{\s*${comments}\.\.\.composed`
			)
		);
		expect(builder).toContain("requestId: fetchedRequest.id");
		expect(builder).toContain("stream: false");
		expect(builder).toContain("...(composed as unknown as StartLoadTestRequest)");
		// The streaming send spreads the same composed payload.
		expect(builder).toContain("apiService.executeStreamRequest({");
		expect(builder).toContain("...composed,");
	});

	it("only Send's composition leaves out unfinished draft elements, never the load run's (#3066)", () => {
		/*
		 * `onlyRunnable` is Send's filter. A load run composes the same chain
		 * without it (its dialog reads every element the request holds), so the
		 * option appears once in the builder: inside `buildSendBody`, ahead of the
		 * load-test composition.
		 */
		const uses = (builder ?? "").match(/onlyRunnable:/g) ?? [];
		expect(uses).toHaveLength(1);
		const sendCompose = (builder ?? "").indexOf("const buildSendBody");
		const loadCompose = (builder ?? "").indexOf("const handleConfirmLoadTest");
		const filter = (builder ?? "").indexOf("onlyRunnable:");
		expect(sendCompose).toBeGreaterThan(-1);
		expect(filter).toBeGreaterThan(sendCompose);
		expect(filter).toBeLessThan(loadCompose);
	});

	it("the run view composes for replay", () => {
		const calls = (runView ?? "").match(/engineComposeRequest\(/g) ?? [];
		expect(calls).toHaveLength(1);
		expect(runView).not.toMatch(/engineComposeRequest\(\{/);
		expect((runView ?? "").match(/buildComposeBody\(\{/g) ?? []).toHaveLength(1);
		expect(runView).toContain("...composed,");
	});

	it("no send site resolves variables or inherit auth client-side anymore", () => {
		// The shared builder is every send site's payload, so it resolves nothing.
		for (const resolver of ["resolveString", "resolveObject", "resolveAuthForSend"]) {
			expect(composeBody ?? "").not.toContain(resolver);
		}
		// `resolveString` was the execution-time interpolation.
		expect(runView ?? "").not.toContain("resolveString");
		// It survives in the builder only for the load dialog's target preview
		// (`pendingLoadTestUrl`, #2117), which names a host and sends nothing.
		const stringResolves = (builder ?? "").match(/resolveString\(/g) ?? [];
		expect(stringResolves).toHaveLength(1);
		expect(builder).toMatch(/pendingLoadTestUrl = useMemo\([^;]*?resolveString\(/);
		// `resolveObject` survives in the builder only for the load dialog's
		// OAuth expiry *preview* (pendingOAuth2Config), which sends nothing.
		const previewUses = (builder ?? "").match(/resolveObject\(/g) ?? [];
		expect(previewUses.length).toBeLessThanOrEqual(1);
		// `resolveAuthForSend` is a send-path regression in the run view, which
		// has no other reason to touch it - unchanged.
		expect(runView ?? "").not.toContain("resolveAuthForSend");
		/*
		 * The builder gets one exception since issue #1436: `DeletedRequestBanner`
		 * calls `resolveAuthForSend(request.auth, [])` to build a "Copy as curl"
		 * snippet for a request that was deleted elsewhere - never sent to the
		 * engine, and with no ancestor chain left to walk (the collection may be
		 * gone too), so an empty chain is the honest answer rather than a guess.
		 * A second occurrence would mean it crept into an actual send site.
		 */
		const authResolveUses = (builder ?? "").match(/resolveAuthForSend\(/g) ?? [];
		expect(authResolveUses).toHaveLength(1);
	});

	it("raw editor state goes into compose - buildExecBody with the identity resolver", () => {
		// Once, in the shared builder. A resolver hooked back in there is the
		// double-interpolation regression; a `buildExecBody` call back at a send
		// site is that site building a body of its own again.
		expect((composeBody ?? "").match(/buildExecBody\(\w+, \(s\) => s\)/g) ?? []).toHaveLength(
			1
		);
		expect(builder ?? "").not.toContain("buildExecBody(");
		expect(runView ?? "").not.toContain("buildExecBody(");
	});
});
