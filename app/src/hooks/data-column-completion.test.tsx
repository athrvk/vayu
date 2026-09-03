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

const monacoStub = {
	languages: {
		CompletionItemKind: { Variable: 4, Function: 1, Field: 3 },
		registerCompletionItemProvider: (language: string, provider: ProviderLike) => {
			registered.push({ language, provider });
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

/** No variables at all, so every suggestion below can only be a column. */
vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => ({}),
		getScopeVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
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

	/*
	 * The bare spelling a bound row answers too (issue #1007) - Postman writes
	 * `{{email}}`, not `{{data.email}}`, so the list has to offer the name that
	 * spelling, not only the collision-proof one.
	 */
	it("offers the declared columns bare too, alongside the prefixed spelling", () => {
		contract.current = declared;
		const suggestions = inBody("{{");
		const bareLabels = suggestions
			.filter((s) => s.label === "id" || s.label === "email")
			.map((s) => s.label);
		expect(bareLabels).toEqual(["id", "email"]);
	});

	it("inserts the bare column as a bare token, not the prefixed one", () => {
		contract.current = declared;
		const bare = inBody("{{").find((s) => s.label === "email");
		expect(bare!.insertText).toBe("{{email}}");
		expect(bare!.filterText).toBe("{{email");
	});

	it("labels the two spellings so picking one is deliberate", () => {
		contract.current = declared;
		const suggestions = inBody("{{");
		const prefixed = suggestions.find((s) => s.label === "data.email")!;
		const bare = suggestions.find((s) => s.label === "email")!;
		// Same column, two entries, and the details must not read identically -
		// that is the whole point of offering both.
		expect(prefixed.detail).not.toBe(bare.detail);
		expect(bare.detail).toMatch(/bare/i);
	});

	it("does not offer a bare column when the chain declares no contract", () => {
		contract.current = undefined;
		expect(inBody("{{").some((s) => s.label === "email")).toBe(false);
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

	it("does not bleed into a single-scope accessor, whose names are a different set", () => {
		contract.current = declared;
		// `pm.environment.get("email")` reads the environment; a column offered
		// there is a name that returns `undefined` at run time.
		expect(inScript('pm.environment.get("')).toEqual([]);
		expect(inScript("pm.globals.get('")).toEqual([]);
		expect(inScript('pm.collectionVariables.get("')).toEqual([]);
	});
});

/**
 * The merged accessor's list is the union of both sources (issue #1063).
 *
 * `pm.variables` is the one accessor that reads a bound row's bare column names
 * *and* the three scopes (issue #1007), so a column is genuinely one of the
 * names it can return - and it was the only such name the list withheld, which
 * makes a declared column something you have to already know to use.
 */
describe('`pm.variables.get("` in a script', () => {
	it("offers the declared columns, which the call really can return", () => {
		contract.current = declared;
		expect(inScript('pm.variables.get("').map((s) => s.label)).toEqual(["id", "email"]);
	});

	it("offers them to `.has` and to a guarded call too", () => {
		contract.current = declared;
		expect(inScript("pm.variables.has('").map((s) => s.label)).toEqual(["id", "email"]);
		expect(inScript('pm.variables?.get("').map((s) => s.label)).toEqual(["id", "email"]);
	});

	it("inserts a bare name - the argument is a name, not a template", () => {
		contract.current = declared;
		const column = inScript('pm.variables.get("').find((s) => s.label === "email")!;
		expect(column.insertText).toBe("email");
		expect(column.detail).toContain("Checkout flow");
	});

	it("offers nothing extra when the chain declares no contract", () => {
		contract.current = undefined;
		expect(inScript('pm.variables.get("')).toEqual([]);
	});

	/*
	 * `replaceIn` resolves a bare `{{email}}` from the bound row through the same
	 * `resolve_template_with_data` the merged `get` reads (issue #1007), so its
	 * list carries the columns too - as tokens, because that argument is a
	 * template. This case asserted the opposite until #1063: it was written at
	 * #600, when the row answered only `{{data.*}}` and a bare column really was
	 * not one of `replaceIn`'s names.
	 */
	it("offers them to replaceIn as tokens, which is what that argument takes", () => {
		contract.current = declared;
		const column = inScript('pm.variables.replaceIn("{{').find((s) => s.label === "email");
		expect(column, "replaceIn resolves a bare column from the bound row").toBeTruthy();
		// Braces on both, the way every other entry in *this* list spells them -
		// they share one `wrap`, so a column cannot drift from a variable here.
		expect(column!.insertText).toBe("{{email}}");
		expect(column!.filterText).toBe("{{email}}");
	});
});

/**
 * Which spelling each mode offers (issue #1077).
 *
 * `replaceIn` resolves `{{data.email}}` and `{{email}}` from the same row, so
 * offering one of the two would be the gap #1063 closed, one call over. A name
 * argument is the opposite case: `pm.variables.get("data.email")` reads no
 * column, so the prefixed spelling there would teach a call that returns
 * `undefined`.
 */
describe("the two column spellings, per accessor mode", () => {
	it("offers the prefixed spelling to replaceIn, beside the bare one", () => {
		contract.current = declared;
		const suggestions = inScript('pm.variables.replaceIn("{{');
		const prefixed = suggestions.find((s) => s.label === "data.email");
		expect(prefixed, "replaceIn resolves {{data.email}} from the bound row").toBeTruthy();
		expect(prefixed!.insertText).toBe("{{data.email}}");
	});

	it("labels the two spellings so picking one is deliberate", () => {
		contract.current = declared;
		const suggestions = inScript('pm.variables.replaceIn("{{');
		const prefixed = suggestions.find((s) => s.label === "data.email")!;
		const bare = suggestions.find((s) => s.label === "email")!;
		expect(prefixed.detail).not.toBe(bare.detail);
		expect(bare.detail).toMatch(/bare/i);
	});

	it("withholds the prefixed spelling from a name argument, which cannot read it", () => {
		/*
		 * The mutation check for the rule above: applying the fix to both modes
		 * is the obvious wrong version of it, and this is the only case that
		 * fails when it is.
		 */
		contract.current = declared;
		expect(inScript('pm.variables.get("').map((s) => s.label)).not.toContain("data.email");
		expect(inScript("pm.variables.has('").map((s) => s.label)).not.toContain("data.email");
	});

	it("does not say (bare) where only one spelling is offered", () => {
		// The word tells two adjacent entries apart; in a list with one entry
		// per column it names a contrast that list does not contain.
		contract.current = declared;
		const bare = inScript('pm.variables.get("').find((s) => s.label === "email")!;
		expect(bare.detail).not.toMatch(/bare/i);
		expect(bare.detail).toContain("Checkout flow");
	});
});
