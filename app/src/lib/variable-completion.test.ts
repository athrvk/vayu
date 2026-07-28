/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When the `{{variable}}` list should appear, and what it replaces.
 *
 * The rule lived inline in `VariableInput`, written twice in the same file -
 * once to decide whether to show the list, once to work out what to replace -
 * and now has a third consumer in the Monaco body editors. Two of those three
 * compute a *range* from it, and a range that starts in the wrong place is how
 * you get `{{{{name}}`, so the open index matters as much as the query.
 */

import { describe, it, expect } from "vitest";
import { variableCompletionContext } from "./variable-completion";

describe("inside an open marker", () => {
	it("matches the moment the second brace is typed", () => {
		expect(variableCompletionContext("{{")).toEqual({ query: "", openIndex: 0 });
	});

	it("reports what has been typed so far", () => {
		expect(variableCompletionContext('{"id": "{{merch')).toEqual({
			query: "merch",
			openIndex: 8,
		});
	});

	it("points at the opening brace, not the partial word", () => {
		// The range starts here. Starting at the word instead leaves the braces
		// behind and completes to `{{{{name}}`.
		const ctx = variableCompletionContext("prefix {{na");
		expect(ctx?.openIndex).toBe(7);
	});

	it("takes the last marker when there are several", () => {
		expect(variableCompletionContext("{{a}} and {{b")).toEqual({ query: "b", openIndex: 10 });
	});
});

describe("not inside one", () => {
	it("says nothing for ordinary text", () => {
		expect(variableCompletionContext('{"id": "abc')).toBeNull();
	});

	it("says nothing for a single brace", () => {
		expect(variableCompletionContext("{")).toBeNull();
	});

	it("stops once the marker is closed", () => {
		// The list must not reappear after a variable is finished.
		expect(variableCompletionContext("{{name}}")).toBeNull();
	});

	it("stops after a closed marker even with text following", () => {
		expect(variableCompletionContext('{{name}}", "next": "')).toBeNull();
	});

	it("says nothing for an empty line", () => {
		expect(variableCompletionContext("")).toBeNull();
	});
});

describe("JSON, where the braces are also syntax", () => {
	it("is not fooled by an object literal", () => {
		// A body editor is full of `{`. Only a doubled brace opens a marker.
		expect(variableCompletionContext('{ "a": { "b": ')).toBeNull();
	});

	it("still matches a marker inside an object", () => {
		expect(variableCompletionContext('{ "a": "{{to')).toEqual({ query: "to", openIndex: 8 });
	});
});
