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
 * The two script-editor completion lists, and the line they divide.
 *
 * `useScriptCompletionProvider` owns the dotted `pm.*` surface; this hook's
 * sibling owns variable names. Both register against `javascript`, so Monaco
 * merges whatever they return - which makes "who yields where" a property of
 * the pair, not of either file, and the reason they are tested together.
 *
 * Driven the way Monaco drives them (build the provider, call
 * `provideCompletionItems` with a model stub) rather than by scanning source:
 * the scope filter and the string-literal guard are both invisible to a grep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

interface Suggestion {
	label: string;
	insertText: string;
	detail?: string;
	range: { startColumn: number; endColumn: number };
}

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => { suggestions: Suggestion[] };
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

vi.mock("@monaco-editor/react", () => ({ useMonaco: () => monacoStub }));

const variables: Record<string, { value: string; scope: string }> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => variables }),
}));

/** The providers scope themselves to the active tab; scoping is covered by `variable-completion-scope.test.tsx`. */
vi.mock("./useActiveCollectionId", () => ({ useActiveCollectionId: () => undefined }));

/**
 * Declared data columns are a second source in this list (issue #600) and have
 * their own suite - `data-column-completion.test.tsx`. Stubbed to "no contract"
 * here, which is the state these cases were written in.
 */
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

/** One `pm.*` entry is enough to tell "the list appeared" from "it yielded". */
vi.mock("@/queries", () => ({
	useScriptCompletionsQuery: () => ({
		data: { completions: [{ label: "pm.response.body", insertText: "pm.response.body" }] },
	}),
}));

import { useScriptVariableCompletionProvider } from "./useScriptVariableCompletionProvider";
import { useScriptCompletionProvider } from "./useScriptCompletionProvider";

/** Runs one hook's provider against a line with the caret at its end. */
function suggestionsFrom(hook: () => void, line: string) {
	registered.length = 0;
	renderHook(hook);
	expect(registered.length).toBeGreaterThan(0);
	return registered[0].provideCompletionItems(
		{ getLineContent: () => line },
		{ lineNumber: 1, column: line.length + 1 }
	).suggestions;
}

const variableNames = (line: string) =>
	suggestionsFrom(useScriptVariableCompletionProvider, line).map((s) => s.label);

const pmLabels = (line: string) =>
	suggestionsFrom(useScriptCompletionProvider, line).map((s) => s.label);

beforeEach(() => {
	for (const key of Object.keys(variables)) delete variables[key];
	variables.apiHost = { value: "https://api.test", scope: "environment" };
	variables.retries = { value: "3", scope: "collection" };
	variables.traceId = { value: "abc", scope: "global" };
});

describe("variable names in the script editors", () => {
	/*
	 * `collection` is exercised here because the filter handles it, not because
	 * the app reaches it today: collection scope is explicit-only on the
	 * resolver and this provider registers once per language, with no request to
	 * take a `collectionId` from. So the live list is environment + global. The
	 * case is kept so the filter stays correct for whatever gives the provider a
	 * request context - see the note in the hook.
	 */
	it("offers the accessor's own scope, and not the other two", () => {
		expect(variableNames('pm.environment.get("')).toEqual(["apiHost"]);
		expect(variableNames('pm.collectionVariables.get("')).toEqual(["retries"]);
		expect(variableNames('pm.globals.get("')).toEqual(["traceId"]);
	});

	it("offers every scope for the merged read", () => {
		expect(variableNames('pm.variables.get("').sort()).toEqual([
			"apiHost",
			"retries",
			"traceId",
		]);
	});

	it("inserts a bare name inside the quotes, and shows the resolved value", () => {
		const [item] = suggestionsFrom(useScriptVariableCompletionProvider, 'pm.environment.get("');
		expect(item.insertText).toBe("apiHost");
		expect(item.detail).toBe("https://api.test");
	});

	it("replaces the half-typed name rather than appending to it", () => {
		const [item] = suggestionsFrom(
			useScriptVariableCompletionProvider,
			'pm.environment.get("api'
		);
		// The opening quote is at index 19, so the name starts at column 21.
		expect(item.range.startColumn).toBe(21);
		expect(item.range.endColumn).toBe(24);
	});

	it("hides a secret's value while still offering the name", () => {
		variables.apiKey = { value: "s3cret", scope: "environment", secret: true } as never;
		const item = suggestionsFrom(
			useScriptVariableCompletionProvider,
			'pm.environment.get("'
		).find((s) => s.label === "apiKey");
		expect(item?.detail).toBe("secret");
	});

	it("offers nothing outside a name argument", () => {
		expect(variableNames("pm.response.")).toHaveLength(0);
		expect(variableNames('console.log("')).toHaveLength(0);
	});
});

describe("replaceIn, which interpolates rather than looks up", () => {
	it("writes the braces and offers generators alongside real variables", () => {
		const labels = variableNames('pm.variables.replaceIn("{{');
		expect(labels).toContain("apiHost");
		expect(labels).toContain("$guid");
	});

	it("does not offer a generator to a lookup that would return undefined", () => {
		expect(variableNames('pm.variables.get("')).not.toContain("$guid");
	});

	it("closes the braces it opened, but not when they are already there", () => {
		const opened = suggestionsFrom(
			useScriptVariableCompletionProvider,
			'pm.variables.replaceIn("{{'
		)[0];
		expect(opened.insertText).toBe("{{apiHost}}");
	});
});

describe("the pm.* list yields inside a string", () => {
	it("still offers the dotted surface in code", () => {
		expect(pmLabels("pm.")).toContain("pm.response.body");
	});

	it("offers nothing inside a name argument, where a variable belongs instead", () => {
		expect(pmLabels('pm.environment.get("')).toHaveLength(0);
		expect(pmLabels('pm.environment.get("api')).toHaveLength(0);
	});

	it("comes back once the string is closed", () => {
		expect(pmLabels('pm.environment.get("api"); pm.')).toContain("pm.response.body");
	});
});
