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
 * `$vu` / `$iteration` in the Monaco `{{` completion list (issue #994). Same
 * shape as `useVariableCompletionProvider.dynamic.test.tsx` beside it, but a
 * separate file because the two behave differently: a same-named scope
 * variable shadows a generator, but must never shadow the reserved identity.
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

vi.mock("@monaco-editor/react", () => ({
	useMonaco: () => monacoStub,
}));

const variables: Record<string, { value: string; scope: string }> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => variables }),
}));

vi.mock("./useActiveCollectionId", () => ({ useActiveCollectionId: () => undefined }));
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

import { useVariableCompletionProvider } from "./useVariableCompletionProvider";

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

describe("$vu / $iteration in the `{{` completion list", () => {
	it("offers both reserved names", () => {
		const labels = suggestionsFor().map((s) => s.label);
		for (const identity of ITERATION_VARIABLES) {
			expect(labels).toContain(identity.name);
		}
	});

	it("describes them as run-bound, not generated", () => {
		const vu = suggestionsFor().find((s) => s.label === "$vu");
		expect(vu).toBeTruthy();
		expect(vu!.insertText).toBe("{{$vu}}");
		expect(vu!.detail).toMatch(/virtual user/i);
		expect(vu!.documentation).toMatch(/bound per iteration/i);
	});

	it("is offered alongside a scope variable of the same name - unlike a generator, it is never shadowed", () => {
		// A stored `$vu` variable would shadow `$guid` in the dynamic-variable
		// group (see the sibling `.dynamic.test.tsx`); the reserved identity must
		// still appear, because `variable-resolution.ts` never lets that scope
		// definition answer for it.
		variables.$vu = { value: "shadowed", scope: "global" };
		const offered = suggestionsFor().filter((s) => s.label === "$vu");
		expect(offered).toHaveLength(2);
		expect(offered.some((s) => s.documentation === "Bound per iteration by the run, not generated here")).toBe(
			true
		);
	});
});
