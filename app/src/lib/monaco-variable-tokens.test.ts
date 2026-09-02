/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scan, the class and the hover text - the three things the Monaco token
 * layer computes and the only ones that can be checked without an editor.
 *
 * Node env against plain objects: a model is two methods here, which is why the
 * scan takes a `ScannableModel` rather than Monaco's `ITextModel`.
 */

import { describe, it, expect } from "vitest";
import {
	variableTokenRanges,
	variableTokensInLine,
	variableTokenClass,
	variableHoverMarkdown,
	VARIABLE_TOKEN_CLASSES,
} from "./monaco-variable-tokens";
import type { VariableTokenKind } from "./variable-token-kind";
import type { VariableOrigin } from "@/types";

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
		expect(variableTokensInLine("{{ }} {{ok}}", 1).map((t) => t.name)).toEqual(["ok"]);
	});

	it("trims the name, so `{{ base }}` is the same variable", () => {
		expect(variableTokensInLine("{{ base }}", 1)[0].name).toBe("base");
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

describe("variableHoverMarkdown", () => {
	it("prints the value and where it came from", () => {
		const [first] = variableHoverMarkdown("baseUrl", resolved, []);
		expect(first).toContain("{{baseUrl}}");
		expect(first).toContain("https://api.example.com");
		expect(first).toContain("environment - Staging");
	});

	it("fences a value that holds backticks, instead of escaping them", () => {
		// A backslash is literal inside a code span, so `\`` would not close
		// anything - the value's own backtick would, and the rest would render as
		// markup. Mutation check: go back to `"`" + value.replace(/`/g, "\\`")`
		// and the run below survives into the output.
		const backticked: VariableTokenKind = {
			state: "resolved",
			info: { value: "echo ``ls`` \\home", scope: "global" },
		};
		const [first] = variableHoverMarkdown("cmd", backticked, []);
		expect(first).toContain("```echo ``ls`` \\home```");
		expect(first).not.toContain("\\`");
	});

	it("never prints a secret, only the word", () => {
		const secret: VariableTokenKind = {
			state: "resolved",
			info: { value: "s3cr3t-token", scope: "environment", secret: true },
		};
		const contents = variableHoverMarkdown("token", secret, []).join("\n");
		// Mutation check: drop the `secret` branch in `printedValue` and this
		// fails - which is the whole reason the tooltip has one.
		expect(contents).not.toContain("s3cr3t-token");
		expect(contents).toContain("secret");
	});

	it("says so when nothing defines the name", () => {
		const contents = variableHoverMarkdown("nope", { state: "undefined", info: null }, []);
		expect(contents.join("\n")).toContain("not defined");
	});

	it("lets a bound row answer above the scopes", () => {
		const origins: VariableOrigin[] = [
			{ scope: "environment", value: "from-env", enabled: true, winner: false },
			{ scope: "row", value: "from-row", enabled: true, winner: true },
		];
		const contents = variableHoverMarkdown("email", resolved, origins).join("\n");
		expect(contents).toContain("from-row");
		expect(contents).toContain("Bound row");
	});

	it("lists the definitions that lost, and marks the ones switched off", () => {
		const origins: VariableOrigin[] = [
			{ scope: "global", value: "old", enabled: false, winner: false },
			{
				scope: "environment",
				sourceName: "Staging",
				value: "https://api.example.com",
				enabled: true,
				winner: true,
			},
		];
		const contents = variableHoverMarkdown("baseUrl", resolved, origins).join("\n");
		expect(contents).toContain("Also defined in:");
		expect(contents).toContain("global");
		expect(contents).toContain("(off)");
		// The winner is the headline, not a row in the list beneath it.
		expect(contents.match(/Staging/g)).toHaveLength(1);
	});

	it("describes a run-time token and offers no edit route", () => {
		const contents = variableHoverMarkdown(
			"$guid",
			{ state: "runtime", tone: "muted", description: "UUID v4", note: "generated per use" },
			[],
			"⌘-click to edit"
		).join("\n");
		expect(contents).toContain("UUID v4");
		expect(contents).toContain("generated per use");
		// There is nothing stored behind it, so an edit hint would be a lie.
		expect(contents).not.toContain("to edit");
	});

	it("names both edit routes on a token that has one", () => {
		const contents = variableHoverMarkdown("baseUrl", resolved, [], "⌘-click or ⇧⌘D to edit");
		expect(contents.join("\n")).toContain("⇧⌘D");
	});
});
