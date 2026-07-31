/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Dynamic variables through the resolver hook (issue #186).
 *
 * The table itself is covered by `lib/dynamic-variables.test.ts`; what is tested
 * here is the wiring the hook owns, which is where the interesting decisions
 * are: scopes are consulted first, generators run per occurrence, and an unknown
 * `$name` keeps its braces instead of joining the ordinary unknown names in
 * resolving to "".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const globals = { variables: {} as Record<string, unknown> };
const collections: Array<Record<string, unknown>> = [];
const environments: Array<Record<string, unknown>> = [];
const session = {
	activeEnvironmentId: null as string | null,
};

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useEnvironmentsQuery: () => ({ data: environments }),
}));
vi.mock("@/stores", () => ({
	useSessionStore: () => session,
}));

import { useVariableResolver } from "./useVariableResolver";

const v = (value: string) => ({ value, enabled: true });

function setup(globalVars: Record<string, unknown> = {}) {
	globals.variables = globalVars;
	return renderHook(() => useVariableResolver()).result.current;
}

beforeEach(() => {
	globals.variables = {};
	collections.length = 0;
	environments.length = 0;
	session.activeEnvironmentId = null;
});

describe("resolveString with dynamic variables", () => {
	it("resolves a known generator that no scope defines", () => {
		const { resolveString } = setup();
		expect(resolveString("https://x/y?id={{$guid}}")).toMatch(
			/^https:\/\/x\/y\?id=[0-9a-f-]{36}$/
		);
	});

	it("generates once per occurrence, so two tokens in one string differ", () => {
		const { resolveString } = setup();
		const [first, second] = resolveString("{{$guid}}|{{$guid}}").split("|");
		expect(first).not.toBe(second);
		expect(first).toHaveLength(36);
		expect(second).toHaveLength(36);
	});

	it("tolerates whitespace inside the braces", () => {
		const { resolveString } = setup();
		expect(resolveString("{{ $randomInt }}")).toMatch(/^\d+$/);
	});

	it("lets a user-defined variable of the same name win", () => {
		// A collection may already define a literal `$guid`; the generator must
		// not take it over, or adding this table would change existing requests.
		const { resolveString } = setup({ $guid: v("pinned-by-the-user") });
		expect(resolveString("{{$guid}}")).toBe("pinned-by-the-user");
	});

	it("leaves an unknown $name written as it stands", () => {
		// Not "": a typo'd generator that silently sent an empty field is the
		// defect this feature exists to fix. Leaving the braces puts it on the
		// wire where it can be seen.
		const { resolveString } = setup();
		expect(resolveString("a={{$randomInteger}}")).toBe("a={{$randomInteger}}");
	});

	it("still resolves an ordinary unknown name to an empty string", () => {
		// Unchanged behaviour - the `$` prefix is what marks the intent.
		const { resolveString } = setup();
		expect(resolveString("a={{nope}}")).toBe("a=");
	});

	it("resolves generators inside nested objects via resolveObject", () => {
		const { resolveObject } = setup({ base: v("https://api.test") });
		const out = resolveObject({
			url: "{{base}}/orders",
			headers: { "X-Trace": "{{$guid}}", "X-When": "{{$timestamp}}" },
			body: ["{{$guid}}"],
		});
		expect(out.url).toBe("https://api.test/orders");
		expect(out.headers["X-Trace"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(out.headers["X-When"]).toMatch(/^\d+$/);
		expect(out.body[0]).not.toBe(out.headers["X-Trace"]);
	});
});

describe("hasUnresolvedVariables", () => {
	it("does not report a known generator as unresolved", () => {
		const { hasUnresolvedVariables } = setup();
		expect(hasUnresolvedVariables("{{$guid}}")).toBe(false);
	});

	it("reports an unknown generator and an undefined ordinary name", () => {
		const { hasUnresolvedVariables } = setup();
		expect(hasUnresolvedVariables("{{$randomInteger}}")).toBe(true);
		expect(hasUnresolvedVariables("{{nope}}")).toBe(true);
	});
});
