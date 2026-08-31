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
 * `$vu` / `$iteration` in `pm.variables.replaceIn`'s `{{` completion list
 * (issue #1057). Same shape as `useVariableCompletionProvider.iteration.test.tsx`
 * beside it - the engine resolver now answers these two names from `replaceIn`,
 * so the editor offers them there too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { ITERATION_VARIABLES } from "@/lib/iteration-variables";

interface ProviderLike {
	provideCompletionItems: (
		model: { getLineContent: () => string },
		position: { lineNumber: number; column: number }
	) => {
		suggestions: Array<{
			label: string;
			insertText: string;
			detail?: string;
			documentation?: string;
		}>;
	};
}

const registered: ProviderLike[] = [];

const monacoStub = {
	languages: {
		CompletionItemKind: { Variable: 4, Function: 1, Constant: 5, Field: 6 },
		registerCompletionItemProvider: (_language: string, provider: ProviderLike) => {
			registered.push(provider);
			return { dispose: () => {} };
		},
	},
};

// `CodeEditor` gates rendering on `useLoadedMonaco` since #1146, and this
// hook moved to it too - so the mock moves from `useMonaco` to the loader.
vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monacoStub,
	ensureMonaco: () => Promise.resolve(monacoStub),
}));

const variables: Record<string, { value: string; scope: string }> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => variables }),
}));

vi.mock("./useActiveCollectionId", () => ({ useActiveCollectionId: () => undefined }));
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

import { useScriptVariableCompletionProvider } from "./useScriptVariableCompletionProvider";

/** `pm.variables.replaceIn("{{` puts the caret in template mode, scope "all". */
function suggestionsFor(line = 'pm.variables.replaceIn("{{') {
	registered.length = 0;
	renderHook(() => useScriptVariableCompletionProvider());
	expect(registered.length).toBeGreaterThan(0);
	return registered[0].provideCompletionItems(
		{ getLineContent: () => line },
		{ lineNumber: 1, column: line.length + 1 }
	).suggestions;
}

beforeEach(() => {
	for (const key of Object.keys(variables)) delete variables[key];
});

describe("$vu / $iteration in replaceIn's `{{` completion list", () => {
	it("offers both reserved names", () => {
		const labels = suggestionsFor().map((s) => s.label);
		for (const identity of ITERATION_VARIABLES) {
			expect(labels).toContain(identity.name);
		}
	});

	it("describes them as bound by the request beside the script, not generated", () => {
		const vu = suggestionsFor().find((s) => s.label === "$vu");
		expect(vu).toBeTruthy();
		expect(vu!.insertText).toBe("{{$vu}}");
		expect(vu!.detail).toMatch(/virtual user/i);
		expect(vu!.documentation).toMatch(/bound with/i);
	});

	it("is offered alongside a scope variable of the same name - unlike a generator, it is never shadowed", () => {
		// A stored `$vu` variable would shadow `$guid` in the dynamic-variable
		// group; the reserved identity must still appear, because the engine
		// resolves these two names ahead of every scope lookup.
		variables.$vu = { value: "shadowed", scope: "global" };
		const offered = suggestionsFor().filter((s) => s.label === "$vu");
		expect(offered).toHaveLength(2);
		expect(
			offered.some((s) =>
				(s.documentation ?? "").includes(
					"Resolves to what the request beside the script was bound with"
				)
			)
		).toBe(true);
	});

	it("is absent outside template mode - a bare pm.variables.get name argument", () => {
		// `pm.variables.get("` is "name" mode, not "template": the identity is
		// interpolated syntax, not a lookup name, so it must not appear here.
		const labels = suggestionsFor('pm.variables.get("').map((s) => s.label);
		expect(labels).not.toContain("$vu");
		expect(labels).not.toContain("$iteration");
	});
});
