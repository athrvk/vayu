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
 * A collection's own variables have to reach the Monaco completion lists.
 *
 * `useVariableResolver` includes collection-scope variables only when it is
 * *told* which collection - the session-store fallback was removed on purpose.
 * Both Monaco providers are registered once in `App`, far from any collection,
 * and both called the resolver with no options at all: a collection holding
 * `coll_var` offered globals, the active environment and the dynamic table, and
 * silently left its own names out. Every other surface (headers, params, URL)
 * was fine, because `VariableInput` reads the request builder's context, which
 * does pass the id.
 *
 * Two things are asserted here:
 *
 * - **which collection each provider asks for**, since asking for none was the
 *   whole defect; and
 * - **that both lists carry the whole ancestor chain**. They did not always:
 *   while the engine filled a script's collection scope from the request's
 *   immediate parent alone (decision D2), the script list narrowed to match,
 *   because offering an ancestor's variable inside
 *   `pm.collectionVariables.get()` would have offered a name that returns
 *   `undefined`. Issue #234 made the engine walk the chain for scripts too, so
 *   the narrowing came off. The rule underneath is unchanged and is what these
 *   cases pin: **the list offers exactly what the call can read** - so if the
 *   engine's walk ever changes again, these fail rather than the user finding
 *   out from an `undefined`.
 *
 * The lists themselves are covered by
 * `useVariableCompletionProvider.dynamic.test.tsx` and
 * `script-completion-split.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => { suggestions: Array<{ label: string }> };
}

const registered: ProviderLike[] = [];

vi.mock("@monaco-editor/react", () => ({
	useMonaco: () => ({
		languages: {
			CompletionItemKind: { Variable: 4, Function: 1 },
			registerCompletionItemProvider: (_language: string, provider: ProviderLike) => {
				registered.push(provider);
				return { dispose: () => {} };
			},
		},
	}),
}));

/** The `collectionId` each provider handed the resolver, in call order. */
const scopes: Array<string | undefined> = [];

/** What the resolver reports - keyed the way `ResolvedVariable` is shaped. */
const variables: Record<string, { value: string; scope: string; sourceId?: string }> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: (options?: { collectionId?: string }) => {
		scopes.push(options?.collectionId);
		return { getAllVariables: () => variables };
	},
}));

const activeCollectionId = { current: undefined as string | undefined };
vi.mock("./useActiveCollectionId", () => ({
	useActiveCollectionId: () => activeCollectionId.current,
}));

import { useVariableCompletionProvider } from "./useVariableCompletionProvider";
import { useScriptVariableCompletionProvider } from "./useScriptVariableCompletionProvider";

/** Labels the first registered provider offers for `line`, caret at its end. */
function labelsFor(hook: () => void, line: string) {
	registered.length = 0;
	renderHook(hook);
	expect(registered.length).toBeGreaterThan(0);
	return registered[0]
		.provideCompletionItems(
			{ getLineContent: () => line },
			{ lineNumber: 1, column: line.length + 1 }
		)
		.suggestions.map((s) => s.label);
}

beforeEach(() => {
	scopes.length = 0;
	registered.length = 0;
	activeCollectionId.current = undefined;
	for (const key of Object.keys(variables)) delete variables[key];
});

describe("the Monaco completion providers resolve against the active collection", () => {
	it("scopes the body `{{` list to it", () => {
		activeCollectionId.current = "c1";
		renderHook(() => useVariableCompletionProvider());
		expect(scopes, "collection variables never reach the body editor").toEqual(["c1"]);
	});

	it("scopes the script string-argument list to it", () => {
		activeCollectionId.current = "c1";
		renderHook(() => useScriptVariableCompletionProvider());
		expect(scopes, "collection variables never reach the script editors").toEqual(["c1"]);
	});

	it("passes nothing through when no collection is in scope", () => {
		renderHook(() => useVariableCompletionProvider());
		expect(scopes).toEqual([undefined]);
	});
});

describe("the body `{{` list offers the whole ancestor chain", () => {
	it("offers a parent collection's variable, which `{{name}}` does resolve", () => {
		activeCollectionId.current = "leaf";
		variables.from_parent = { value: "1", scope: "collection", sourceId: "root" };
		variables.from_leaf = { value: "2", scope: "collection", sourceId: "leaf" };

		const labels = labelsFor(() => useVariableCompletionProvider(), "{{");
		expect(labels).toContain("from_parent");
		expect(labels).toContain("from_leaf");
	});
});

describe("the script list offers the ancestor chain the engine now walks (#234)", () => {
	beforeEach(() => {
		activeCollectionId.current = "leaf";
		variables.from_parent = { value: "1", scope: "collection", sourceId: "root" };
		variables.from_leaf = { value: "2", scope: "collection", sourceId: "leaf" };
		variables.from_env = { value: "3", scope: "environment", sourceId: "e1" };
	});

	it("offers an ancestor's variable inside `pm.collectionVariables.get()`", () => {
		const labels = labelsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		);
		expect(labels).toContain("from_leaf");
		expect(
			labels,
			"the engine walks the collection chain for scripts, so this call does read it"
		).toContain("from_parent");
		// The accessor still picks the scope: this one does not read environment.
		expect(labels).not.toContain("from_env");
	});

	it("offers it from the merged `pm.variables.get()` too, alongside the other scopes", () => {
		const labels = labelsFor(() => useScriptVariableCompletionProvider(), 'pm.variables.get("');
		expect(labels).toContain("from_leaf");
		expect(labels).toContain("from_env");
		expect(labels).toContain("from_parent");
	});

	// With the narrowing gone, the resolver is the only thing deciding which
	// collection variables exist - so what this provider asks it for is the
	// whole of the scoping, and a second local filter would be a copy that
	// drifts.
	it("asks the resolver for nothing when no collection is in scope", () => {
		activeCollectionId.current = undefined;
		labelsFor(() => useScriptVariableCompletionProvider(), 'pm.variables.get("');
		expect(scopes).toEqual([undefined]);
	});
});
