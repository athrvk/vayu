/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scan and the class - the two things the Monaco token layer computes that
 * can be checked without an editor. What the hover *says* is a React tooltip
 * now (issue #1320), pinned in `EditorVariableTokensProvider.test.tsx`.
 *
 * Node env against plain objects: a model is two methods here, which is why the
 * scan takes a `ScannableModel` rather than Monaco's `ITextModel`.
 */

import { describe, it, expect } from "vitest";
import {
	variableTokenRanges,
	variableTokenClass,
	VARIABLE_TOKEN_CLASSES,
} from "./monaco-variable-tokens";
import type { VariableTokenKind } from "./variable-token-kind";

function model(...lines: string[]) {
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
	};
}

const resolved: VariableTokenKind = {
	state: "resolved",
	info: { value: "https://api.example.com", scope: "environment", sourceName: "Staging" },
};

describe("variableTokenRanges", () => {
	it("addresses a token in Monaco's 1-based columns", () => {
		const [token] = variableTokenRanges(model("GET {{baseUrl}}/users"));
		expect(token).toEqual({
			name: "baseUrl",
			lineNumber: 1,
			// `{` is the 5th character, and the range ends one past the final `}`.
			startColumn: 5,
			endColumn: 16,
		});
	});

	it("finds every token, on every line", () => {
		const tokens = variableTokenRanges(model("{{a}} {{b}}", "", "{{c}}"));
		expect(tokens.map((t) => [t.name, t.lineNumber])).toEqual([
			["a", 1],
			["b", 1],
			["c", 3],
		]);
	});

	it("skips a token that names nothing", () => {
		expect(variableTokenRanges(model("{{ }} {{ok}}")).map((t) => t.name)).toEqual(["ok"]);
	});

	it("trims the name, so `{{ base }}` is the same variable", () => {
		expect(variableTokenRanges(model("{{ base }}"))[0].name).toBe("base");
	});

	it("stops at the line cap, so a pasted payload is not scanned whole", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `{{v${i}}}`);
		expect(variableTokenRanges(model(...lines), 5)).toHaveLength(5);
	});
});

describe("variableTokenClass", () => {
	it("gives each state its own class, and only classes index.css declares", () => {
		const classes = [
			variableTokenClass(resolved),
			variableTokenClass({ state: "empty", info: { value: "", scope: "global" } }),
			variableTokenClass({ state: "undefined", info: null }),
			variableTokenClass({ state: "runtime", tone: "muted", description: "d", note: "n" }),
			variableTokenClass({ state: "runtime", tone: "warning", description: "d", note: "n" }),
		];
		expect(new Set(classes).size).toBe(classes.length);
		for (const cls of classes) expect(VARIABLE_TOKEN_CLASSES).toContain(cls);
	});
});
