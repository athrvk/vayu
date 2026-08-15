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
 * Dynamic variables have to be *offered*, or they stay undiscoverable.
 *
 * Nothing about `{{$guid}}` announces itself: it is not in any scope, so the
 * variables panel cannot list it, and a user who has never used Postman has no
 * reason to guess the name. The `{{` completion list is the only place the set
 * is visible, which makes this wiring part of the feature rather than polish.
 *
 * The provider is registered against Monaco, so the test drives it the way
 * Monaco does - build the provider, call `provideCompletionItems` with a model
 * stub - rather than scanning the source for the table's name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => { suggestions: Array<{ label: string; insertText: string; detail?: string }> };
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

vi.mock("@monaco-editor/react", () => ({
	useMonaco: () => monacoStub,
}));

const variables: Record<string, { value: string; scope: string }> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => variables }),
}));

/** The providers scope themselves to the active tab; scoping is covered by `variable-completion-scope.test.tsx`. */
vi.mock("./useActiveCollectionId", () => ({ useActiveCollectionId: () => undefined }));

/**
 * Declared data columns are a second source in both lists (issue #600) and have
 * their own suite - `data-column-completion.test.tsx`. Stubbed to "no contract"
 * here, which is the state these cases were written in.
 */
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

import { useVariableCompletionProvider } from "./useVariableCompletionProvider";

/** Completions offered for a line whose caret sits inside an open `{{`. */
function suggestionsFor(line = "{{") {
	registered.length = 0;
	renderHook(() => useVariableCompletionProvider());
	expect(registered.length).toBeGreaterThan(0);
	return registered[0].provideCompletionItems(
		{ getLineContent: () => line },
		{ lineNumber: 1, column: line.length + 1 }
	).suggestions;
}

beforeEach(() => {
	for (const key of Object.keys(variables)) delete variables[key];
});

describe("dynamic variables in the `{{` completion list", () => {
	it("offers every entry in the table", () => {
		const labels = suggestionsFor().map((s) => s.label);
		for (const dynamic of DYNAMIC_VARIABLES) {
			expect(labels).toContain(dynamic.name);
		}
	});

	it("inserts the braces, and describes what the value is", () => {
		const guid = suggestionsFor().find((s) => s.label === "$guid");
		expect(guid).toBeTruthy();
		expect(guid!.insertText).toBe("{{$guid}}");
		expect(guid!.detail).toBe("UUID v4");
	});

	it("still offers the workspace's own variables beside them", () => {
		variables.baseUrl = { value: "https://api.test", scope: "environment" };
		const labels = suggestionsFor().map((s) => s.label);
		expect(labels).toContain("baseUrl");
		expect(labels).toContain("$guid");
	});

	it("drops a generator that a real variable shadows, since the generator would not run", () => {
		variables.$guid = { value: "pinned", scope: "global" };
		const offered = suggestionsFor().filter((s) => s.label === "$guid");
		expect(offered).toHaveLength(1);
		expect(offered[0].detail).toBe("pinned");
	});

	it("offers nothing when the caret is not inside an open `{{`", () => {
		expect(suggestionsFor("plain text")).toHaveLength(0);
	});
});
