/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which templates a script editor is offered, as a pure read over the engine's
 * completion table (#1223).
 *
 * The rules here are the ones a wrong answer hides rather than breaks: a test
 * template offered under a pre-request editor is advice that cannot work, and a
 * template silently dropped is a capability the engine shipped and the user
 * never sees.
 */

import { describe, it, expect } from "vitest";
import { SCRIPT_SNIPPET_KIND, countSnippets, snippetsForContext } from "./script-snippets";
import type { ScriptCompletion } from "@/types/domain";

function entry(over: Partial<ScriptCompletion>): ScriptCompletion {
	return {
		label: "a template",
		kind: SCRIPT_SNIPPET_KIND,
		insertText: "pm.test('x', function () {});",
		detail: "",
		documentation: "",
		...over,
	};
}

const TABLE: ScriptCompletion[] = [
	entry({ label: "set a header", context: "pre", group: "Request" }),
	entry({ label: "sign it", context: "pre", group: "Signing" }),
	entry({ label: "status code", context: "test", group: "Tests" }),
	entry({ label: "set a variable", context: "both", group: "Variables" }),
	entry({ label: "log the response", context: "test", group: "Logging" }),
	// Not a snippet: the completion popup's own entries, which are the bulk of
	// the table and none of this surface's business.
	entry({ label: "pm.response.json", kind: 1, context: undefined, group: undefined }),
];

describe("snippetsForContext", () => {
	it("offers a script kind its own templates and the shared ones", () => {
		const labels = snippetsForContext(TABLE, "pre").flatMap((g) =>
			g.snippets.map((s) => s.label)
		);

		expect(labels).toEqual(["set a variable", "set a header", "sign it"]);
		expect(labels).not.toContain("status code");
	});

	it("keeps a test editor clear of the request mutators it cannot run", () => {
		const labels = snippetsForContext(TABLE, "test").flatMap((g) =>
			g.snippets.map((s) => s.label)
		);

		expect(labels).toEqual(["set a variable", "status code", "log the response"]);
		expect(labels).not.toContain("set a header");
	});

	it("takes only the snippet entries, whatever else the table holds", () => {
		const all = snippetsForContext(TABLE, "test").flatMap((g) => g.snippets);

		expect(all.every((s) => s.kind === SCRIPT_SNIPPET_KIND)).toBe(true);
	});

	it("orders the headings the way a script author meets them", () => {
		const groups = snippetsForContext(TABLE, "pre").map((g) => g.group);

		expect(groups).toEqual(["Variables", "Request", "Signing"]);
	});

	/*
	 * The engine is the source, and it can ship a heading this build has never
	 * heard of. Listing it under its own name loses nothing; dropping it would
	 * hide a template the engine deliberately added.
	 */
	it("lists a heading it does not know rather than dropping the template", () => {
		const groups = snippetsForContext(
			[...TABLE, entry({ label: "future thing", context: "pre", group: "Telemetry" })],
			"pre"
		);

		expect(groups.map((g) => g.group)).toEqual([
			"Variables",
			"Request",
			"Signing",
			"Telemetry",
		]);
	});

	it("files a snippet with no heading under the one its context makes true", () => {
		const groups = snippetsForContext([entry({ label: "bare", context: "pre" })], "pre");

		expect(groups).toHaveLength(1);
		expect(groups[0].group).toBe("Request");
	});

	it("answers emptily while the table has not arrived", () => {
		expect(snippetsForContext(undefined, "pre")).toEqual([]);
		expect(countSnippets(snippetsForContext(undefined, "test"))).toBe(0);
	});

	it("counts what it is showing", () => {
		expect(countSnippets(snippetsForContext(TABLE, "pre"))).toBe(3);
		expect(countSnippets(snippetsForContext(TABLE, "test"))).toBe(3);
	});
});
