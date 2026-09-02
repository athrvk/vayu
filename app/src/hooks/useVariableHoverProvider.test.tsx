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
 * The hover is registered against Monaco, so this drives it the way Monaco
 * does - build the provider, call `provideHover` with a model stub - rather
 * than scanning the source, the same shape as the completion suites beside it.
 *
 * The registration list is read from `BODY_LANGUAGES` rather than spelled again
 * here: the completion providers and this one must cover the same surfaces, and
 * a second copy of the list is how the two would come to disagree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { BODY_LANGUAGES } from "./useVariableCompletionProvider";
import { markVariableTokenModel } from "@/lib/variable-token-models";
import type * as Monaco from "monaco-editor";
import type { ResolvedVariable, VariableOrigin } from "@/types";

interface HoverLike {
	provideHover: (
		model: { getLineContent: (line: number) => string },
		position: { lineNumber: number; column: number }
	) => { contents: Array<{ value: string }>; range: { startColumn: number } } | null;
}

const registered: Array<{ language: string; provider: HoverLike }> = [];

const monacoStub = {
	languages: {
		registerHoverProvider: (language: string, provider: HoverLike) => {
			registered.push({ language, provider });
			return { dispose: () => {} };
		},
	},
};

vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monacoStub,
	ensureMonaco: () => Promise.resolve(monacoStub),
}));

const variables: Record<string, ResolvedVariable> = {};
const origins: Record<string, VariableOrigin[]> = {};

vi.mock("./useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => variables,
		getVariableOrigins: (name: string) => origins[name] ?? [],
	}),
}));

/** Scoping to the active tab is covered by `variable-completion-scope.test.tsx`. */
vi.mock("./useActiveCollectionId", () => ({
	useActiveCollectionId: () => undefined,
	useActiveRequestId: () => null,
}));
vi.mock("./useDataContract", () => ({ useDataContract: () => undefined }));

import { useVariableHoverProvider } from "./useVariableHoverProvider";

/** A model an editor has painted, which is the only kind the hover answers for. */
function paintedModel(line: string) {
	const model = { getLineContent: () => line };
	markVariableTokenModel(model as unknown as Monaco.editor.ITextModel);
	return model;
}

/** The hover Monaco would show for a caret sitting at `column` on `line`. */
function hoverFor(line: string, column: number, model = paintedModel(line)) {
	registered.length = 0;
	renderHook(() => useVariableHoverProvider());
	expect(registered.length).toBeGreaterThan(0);
	return registered[0].provider.provideHover(model, { lineNumber: 1, column });
}

beforeEach(() => {
	for (const key of Object.keys(variables)) delete variables[key];
	for (const key of Object.keys(origins)) delete origins[key];
});

describe("useVariableHoverProvider", () => {
	it("registers for exactly the languages `{{` completion is registered for", () => {
		registered.length = 0;
		renderHook(() => useVariableHoverProvider());
		expect(registered.map((r) => r.language).sort()).toEqual([...BODY_LANGUAGES].sort());
	});

	it("answers on a token with its value and its source", () => {
		variables.baseUrl = {
			value: "https://api.example.com",
			scope: "environment",
			sourceName: "Staging",
		};
		const hover = hoverFor("GET {{baseUrl}}/users", 8);
		expect(hover).not.toBeNull();
		const text = hover!.contents.map((c) => c.value).join("\n");
		expect(text).toContain("https://api.example.com");
		expect(text).toContain("Staging");
		// The highlight is the token, not the word Monaco would have guessed.
		expect(hover!.range.startColumn).toBe(5);
	});

	it("says nothing about a model no editor paints - a response body is data", () => {
		variables.userId = { value: "42", scope: "environment" };
		// Mutation check: drop the `isVariableTokenModel` guard and the response
		// viewer starts offering to define the ids in a payload someone was sent.
		expect(hoverFor("{{userId}}", 4, { getLineContent: () => "{{userId}}" })).toBeNull();
	});

	it("lets a bound row answer above the scopes, as the field's tooltip does", () => {
		variables.email = { value: "from-env", scope: "environment" };
		origins.email = [
			{ scope: "environment", value: "from-env", enabled: true, winner: false },
			{ scope: "row", value: "row@example.com", enabled: true, winner: true },
		];
		const text = hoverFor("{{email}}", 4)!
			.contents.map((c) => c.value)
			.join("\n");
		expect(text).toContain("row@example.com");
		expect(text).toContain("Bound row");
	});

	it("says nothing where there is no token", () => {
		variables.baseUrl = { value: "x", scope: "global" };
		expect(hoverFor("GET {{baseUrl}}/users", 2)).toBeNull();
	});

	it("never prints a secret's value", () => {
		variables.token = { value: "s3cr3t-token", scope: "environment", secret: true };
		const text = hoverFor("Bearer {{token}}", 10)!
			.contents.map((c) => c.value)
			.join("\n");
		expect(text).not.toContain("s3cr3t-token");
		expect(text).toContain("secret");
	});

	it("offers an edit route on a variable and none on a generator", () => {
		const variableHover = hoverFor("{{missing}}", 4)!
			.contents.map((c) => c.value)
			.join("\n");
		expect(variableHover).toContain("to edit");

		const generatorHover = hoverFor("{{$guid}}", 4)!
			.contents.map((c) => c.value)
			.join("\n");
		expect(generatorHover).toContain("generated per use");
		expect(generatorHover).not.toContain("to edit");
	});
});
