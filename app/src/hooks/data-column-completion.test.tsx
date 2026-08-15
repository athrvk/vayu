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
 * Declared columns in the two Monaco lists (issue #600).
 *
 * A contract nobody can complete from is a contract nobody uses: the columns
 * live on the collection, and the places you spell them are a body editor
 * (`{{data.email}}`) and a script (`pm.iterationData.get("email")`). Both
 * providers are registered once per language in `App`, so this drives them the
 * way Monaco does - build the provider, call `provideCompletionItems` against a
 * line - rather than scanning source.
 *
 * What each case is really guarding is the *scoping*: a list that offered
 * columns everywhere would offer names that bind nothing in every workspace
 * that declares no contract.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DataContractScope } from "@/types";

interface Suggestion {
	label: string;
	insertText: string;
	detail?: string;
	filterText?: string;
}

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => { suggestions: Suggestion[] };
}

const registered: Array<{ language: string; provider: ProviderLike }> = [];

vi.mock("@monaco-editor/react", () => ({
	useMonaco: () => ({
		languages: {
			CompletionItemKind: { Variable: 4, Function: 1, Field: 3 },
			registerCompletionItemProvider: (language: string, provider: ProviderLike) => {
				registered.push({ language, provider });
				return { dispose: () => {} };
			},
		},
	}),
}));

/** No variables at all, so every suggestion below can only be a column. */
vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => ({}) }),
}));

vi.mock("./useActiveCollectionId", () => ({ useActiveCollectionId: () => "col_1" }));

const contract = {
	current: undefined as DataContractScope | undefined,
};
vi.mock("./useDataContract", () => ({ useDataContract: () => contract.current }));

const { useVariableCompletionProvider } = await import("./useVariableCompletionProvider");
const { useScriptVariableCompletionProvider } =
	await import("./useScriptVariableCompletionProvider");

const declared: DataContractScope = {
	collectionId: "col-checkout",
	collectionName: "Checkout flow",
	columns: ["id", "email"],
};

/** Completions the first provider registered for `language` offers for `line`. */
function suggestionsFor(hook: () => void, line: string, language: string): Suggestion[] {
	registered.length = 0;
	renderHook(hook);
	const entry = registered.find((r) => r.language === language);
	expect(entry).toBeTruthy();
	return entry!.provider.provideCompletionItems(
		{ getLineContent: () => line },
		{ lineNumber: 1, column: line.length + 1 }
	).suggestions;
}

const inBody = (line: string) => suggestionsFor(useVariableCompletionProvider, line, "json");
/**
 * Just the column entries. The body list also carries every generator
 * (`{{$guid}}` and friends), which is a different feature and has its own suite
 * - filtering here keeps a new generator from reddening these cases.
 */
const columnsInBody = (line: string) => inBody(line).filter((s) => s.label.startsWith("data."));
const inScript = (line: string) =>
	suggestionsFor(useScriptVariableCompletionProvider, line, "javascript");

describe("`{{data.` in a request body", () => {
	it("offers the declared columns, ready to insert as tokens", () => {
		contract.current = declared;
		const suggestions = columnsInBody('{"email": "{{data.');
		expect(suggestions.map((s) => s.label)).toEqual(["data.id", "data.email"]);
		expect(suggestions[1].insertText).toBe("{{data.email}}");
		// The list has to say where the columns came from: in a sub-collection
		// they are an ancestor's, and its Data tab is where they change.
		expect(suggestions[1].detail).toContain("Checkout flow");
	});

	it("filters on the whole `{{data.` prefix, which is how Monaco narrows it", () => {
		contract.current = declared;
		// Monaco matches `filterText` against what has been typed since the
		// replace range started, and the range starts at the braces - a bare
		// `email` there would never match a caret sitting after `{{data.`.
		expect(columnsInBody("{{data.").map((s) => s.filterText)).toEqual([
			"{{data.id",
			"{{data.email",
		]);
	});

	it("offers nothing when the chain declares no contract", () => {
		contract.current = undefined;
		expect(columnsInBody("{{")).toEqual([]);
		// The rest of the list is untouched - this adds a source, it does not
		// replace one.
		expect(inBody("{{").length).toBeGreaterThan(0);
	});

	it("offers nothing when the caret is not inside an open `{{`", () => {
		contract.current = declared;
		expect(inBody('{"email": "someone@example.com"')).toEqual([]);
	});
});

describe('`pm.iterationData.get("` in a script', () => {
	it("offers the declared columns as bare names - the argument is not a template", () => {
		contract.current = declared;
		const suggestions = inScript('const user = pm.iterationData.get("');
		expect(suggestions.map((s) => s.label)).toEqual(["id", "email"]);
		expect(suggestions[0].insertText).toBe("id");
		expect(suggestions[0].detail).toContain("Checkout flow");
	});

	it("offers them to a guarded call too", () => {
		contract.current = declared;
		expect(inScript("pm.iterationData?.has('").map((s) => s.label)).toEqual(["id", "email"]);
	});

	it("offers nothing when the chain declares no contract", () => {
		contract.current = undefined;
		expect(inScript('pm.iterationData.get("')).toEqual([]);
	});

	it("does not bleed into a variable accessor, whose names are a different set", () => {
		contract.current = declared;
		// `pm.environment.get("email")` reads the environment; a column offered
		// there is a name that returns `undefined` at run time.
		expect(inScript('pm.environment.get("')).toEqual([]);
		// `replaceIn` interpolates variables, and the data pass is a different
		// pass over the composed request - a column is not one of its names.
		expect(inScript('pm.variables.replaceIn("{{').map((s) => s.label)).not.toContain("email");
	});
});
