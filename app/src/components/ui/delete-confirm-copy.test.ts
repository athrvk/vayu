/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An environment's delete is soft since #2970, so its dialog must not claim the
 * delete is final: the old "This can't be undone." would talk the user out of a
 * delete the Trash gives back. Mutation check: put that sentence back and the
 * first case fails.
 */

import { describe, it, expect } from "vitest";
import { environmentDeleteDescription, exampleDeleteDescription } from "./delete-confirm-copy";

const withVariables = (count: number) => ({
	variables: Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, {}])),
});

describe("environmentDeleteDescription", () => {
	it("points at the Trash instead of calling the delete final", () => {
		const description = environmentDeleteDescription(withVariables(2));

		expect(description).toContain("You can restore it from Trash.");
		expect(description).not.toMatch(/can't be undone|cannot be undone/);
	});

	it.each([
		[0, "Its 0 variables go with it."],
		[1, "Its 1 variable goes with it."],
		[12, "Its 12 variables go with it."],
	])("counts %i variables in agreement", (count, sentence) => {
		const description = environmentDeleteDescription(withVariables(count));
		expect(description.slice(0, sentence.length)).toBe(sentence);
	});

	it("still says what a request using them will send", () => {
		expect(environmentDeleteDescription(withVariables(1))).toContain(
			"Requests that use them will send the literal `{{variableName}}` text."
		);
	});
});

/**
 * A saved example's delete is soft since #2971, an imported one's is not: the
 * engine keeps it as a spec-sync tombstone. Mutation check: put "This can't be
 * undone." back for a saved example, or the Trash sentence onto an imported
 * one, and the matching case fails.
 */
describe("exampleDeleteDescription", () => {
	it("points a saved example at the Trash instead of calling the delete final", () => {
		const description = exampleDeleteDescription("user");

		expect(description).toContain("You can restore it from Trash.");
		expect(description).not.toMatch(/can't be undone|cannot be undone/);
		expect(description).not.toContain("re-importing");
	});

	it("keeps the spec-sync wording for an imported example and does not promise a restore", () => {
		const description = exampleDeleteDescription("import");

		expect(description).toContain("Syncing this collection with its spec won't bring it back");
		expect(description).toContain("re-importing the document will.");
		expect(description).not.toContain("Trash");
	});

	it.each(["user", "import"] as const)("tells a %s example what a mock server does", (origin) => {
		expect(exampleDeleteDescription(origin)).toContain(
			"A mock server for this collection stops answering with it once it is restarted."
		);
	});
});
