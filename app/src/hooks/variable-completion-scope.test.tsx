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
import {
	stubAllVariables,
	stubOrigins,
	stubScopeVariables,
	type ScopeDefinitions,
} from "@/lib/scoped-variables.testkit";
import type { VariableScope } from "@/types";

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => { suggestions: Array<{ label: string; detail?: string; documentation?: string }> };
}

const registered: ProviderLike[] = [];

const monacoStub = {
	languages: {
		CompletionItemKind: { Variable: 4, Function: 1 },
		registerCompletionItemProvider: (_language: string, provider: ProviderLike) => {
			registered.push(provider);
			return { dispose: () => {} };
		},
	},
};

// `CodeEditor` gates rendering on `useLoadedMonaco` since #1146, and these
// hooks moved to it too - so the mock moves from `useMonaco` to the loader.
vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monacoStub,
	ensureMonaco: () => Promise.resolve(monacoStub),
}));

/** The `collectionId` each provider handed the resolver, in call order. */
const scopes: Array<string | undefined> = [];

/**
 * What each scope defines. The resolver's three views are derived from it
 * (`scoped-variables.testkit`), so a case cannot describe a scope map that
 * disagrees with the merged one - a state the real resolver cannot be in.
 */
const defs: ScopeDefinitions = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: (options?: { collectionId?: string }) => {
		scopes.push(options?.collectionId);
		return {
			getAllVariables: () => stubAllVariables(defs),
			getScopeVariables: (scope: VariableScope) => stubScopeVariables(defs, scope),
			getVariableOrigins: (name: string) => stubOrigins(defs, name),
		};
	},
}));

const activeCollectionId = { current: undefined as string | undefined };
vi.mock("./useActiveCollectionId", () => ({
	useActiveCollectionId: () => activeCollectionId.current,
}));

/**
 * Declared data columns are a second source in both lists (issue #600) and have
 * their own suite - `data-column-completion.test.tsx`. Stubbed to "no contract"
 * here, which is the state these cases were written in.
 */
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

import { useVariableCompletionProvider } from "./useVariableCompletionProvider";
import { useScriptVariableCompletionProvider } from "./useScriptVariableCompletionProvider";

/** What the first registered provider offers for `line`, caret at its end. */
function suggestionsFor(hook: () => void, line: string) {
	registered.length = 0;
	renderHook(hook);
	expect(registered.length).toBeGreaterThan(0);
	return registered[0].provideCompletionItems(
		{ getLineContent: () => line },
		{ lineNumber: 1, column: line.length + 1 }
	).suggestions;
}

/** Labels the first registered provider offers for `line`, caret at its end. */
function labelsFor(hook: () => void, line: string) {
	return suggestionsFor(hook, line).map((s) => s.label);
}

beforeEach(() => {
	scopes.length = 0;
	registered.length = 0;
	activeCollectionId.current = undefined;
	for (const scope of Object.keys(defs) as VariableScope[]) delete defs[scope];
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
		defs.collection = {
			from_parent: { value: "1", sourceId: "root" },
			from_leaf: { value: "2", sourceId: "leaf" },
		};

		const labels = labelsFor(() => useVariableCompletionProvider(), "{{");
		expect(labels).toContain("from_parent");
		expect(labels).toContain("from_leaf");
	});
});

describe("the script list offers the ancestor chain the engine now walks (#234)", () => {
	beforeEach(() => {
		activeCollectionId.current = "leaf";
		defs.collection = {
			from_parent: { value: "1", sourceId: "root" },
			from_leaf: { value: "2", sourceId: "leaf" },
		};
		defs.environment = { from_env: { value: "3", sourceId: "e1" } };
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

/**
 * The list a single-scope accessor gets is that scope's own definitions
 * (issue #1302).
 *
 * It used to be the winner map filtered by the winning scope, which answers a
 * different question: `pm.collectionVariables.get` reads the collection chain
 * and answers from it whether or not the environment defines the name too, so
 * filtering by "which scope won the ladder" hid a collection's own variable
 * behind an environment that shadowed it - and shadowed is exactly the case an
 * author needs the list for, since it is the one where the scoped read and the
 * `{{name}}` beside it disagree.
 *
 * Revert the hook to `getAllVariables()` filtered by `info.scope` and the first
 * three of these fail: the name is not offered at all, so there is no detail to
 * be wrong about.
 */
describe("a single-scope list is what that scope defines, not what it wins", () => {
	beforeEach(() => {
		activeCollectionId.current = "leaf";
	});

	it("offers a collection variable the environment shadows", () => {
		defs.collection = { shop_domain: { value: "shop.test", sourceName: "Acme" } };
		defs.environment = { shop_domain: { value: "staging.shop.test", sourceName: "Staging" } };

		const labels = labelsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		);
		expect(
			labels,
			"the call reads the collection chain, so the name is one it can answer"
		).toContain("shop_domain");
	});

	it("shows that scope's own value, not the winner's", () => {
		defs.collection = { shop_domain: { value: "shop.test", sourceName: "Acme" } };
		defs.environment = { shop_domain: { value: "staging.shop.test", sourceName: "Staging" } };

		const item = suggestionsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		).find((s) => s.label === "shop_domain");
		expect(item?.detail).toBe("shop.test");
		expect(item?.documentation).toBe("collection - Acme");
	});

	/**
	 * #1196's second item, reachable only now that the trapped name is offered:
	 * the collection row is enabled and empty, so the read returns `""` while
	 * `{{shop_domain}}` resolves the environment's value - and the sentence comes
	 * from `describeScopedRead`, the one the chip above the editor shows.
	 */
	it("says so when the scope's own row is empty and another scope holds the value", () => {
		defs.collection = { shop_domain: { value: "", sourceName: "Acme" } };
		defs.environment = { shop_domain: { value: "staging.shop.test", sourceName: "Staging" } };

		const item = suggestionsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		).find((s) => s.label === "shop_domain");
		expect(item?.detail).toBe('Empty at collection scope - this read returns ""');
		expect(item?.documentation).toContain("environment - Staging holds the value");
	});

	it("stays quiet where the scope's own answer is the one that resolves", () => {
		defs.collection = { shop_domain: { value: "shop.test", sourceName: "Acme" } };
		defs.global = { shop_domain: { value: "global.shop.test" } };

		const item = suggestionsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		).find((s) => s.label === "shop_domain");
		expect(item?.detail).toBe("shop.test");
		expect(item?.documentation).toBe("collection - Acme");
	});

	// `get` reads enabled rows only, so absence is the honest answer - the same
	// one the winner map gives a name whose every definition is switched off.
	it("leaves out a name whose definitions in that scope are all disabled", () => {
		defs.collection = { retired: { value: "1", enabled: false } };
		defs.environment = { retired: { value: "2" } };

		const labels = labelsFor(
			() => useScriptVariableCompletionProvider(),
			'pm.collectionVariables.get("'
		);
		expect(labels).not.toContain("retired");
		expect(
			labelsFor(() => useScriptVariableCompletionProvider(), 'pm.environment.get("'),
			"the environment's enabled row still answers there"
		).toContain("retired");
	});

	it("still leaves out a name only another scope defines", () => {
		defs.environment = { only_env: { value: "1" } };

		expect(
			labelsFor(() => useScriptVariableCompletionProvider(), 'pm.collectionVariables.get("')
		).not.toContain("only_env");
	});
});
