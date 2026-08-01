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
 * Two things are asserted here, and they pull in opposite directions:
 *
 * - **which collection each provider asks for**, since asking for none was the
 *   whole defect; and
 * - **that the script list narrows the answer back down** to the immediate
 *   collection, because of decision D2 - the engine fills a script's single
 *   collection scope from the request's immediate parent, while the resolver
 *   merges the whole ancestor chain for `{{name}}`. Offering an ancestor's
 *   variable inside `pm.collectionVariables.get()` would offer a name that
 *   returns `undefined`, which is the exact failure the "the accessor picks the
 *   scope" rule exists to prevent.
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

describe("the script list narrows collection scope to the immediate collection (D2)", () => {
	beforeEach(() => {
		activeCollectionId.current = "leaf";
		variables.from_parent = { value: "1", scope: "collection", sourceId: "root" };
		variables.from_leaf = { value: "2", scope: "collection", sourceId: "leaf" };
		variables.from_env = { value: "3", scope: "environment", sourceId: "e1" };
	});

	it("drops an ancestor's variable from `pm.collectionVariables.get()`", () => {
		const labels = labelsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		);
		expect(labels).toContain("from_leaf");
		expect(
			labels,
			"the engine's script collection scope is the immediate parent only"
		).not.toContain("from_parent");
	});

	it("drops it from the merged `pm.variables.get()` too, keeping the other scopes", () => {
		const labels = labelsFor(() => useScriptVariableCompletionProvider(), 'pm.variables.get("');
		expect(labels).toContain("from_leaf");
		expect(labels).toContain("from_env");
		expect(labels).not.toContain("from_parent");
	});

	it("leaves the other scopes alone when no collection is in scope", () => {
		activeCollectionId.current = undefined;
		const labels = labelsFor(() => useScriptVariableCompletionProvider(), 'pm.variables.get("');
		expect(labels).toContain("from_env");
		expect(labels).not.toContain("from_leaf");
		expect(labels).not.toContain("from_parent");
	});
});
