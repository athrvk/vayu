/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file-body trust flag as every writer states it. The engine reads an
 * absent `unresolved` as `true`, so the two branches that matter are an
 * explicit `false` (chosen here) and everything else.
 */

import { describe, it, expect } from "vitest";
import type { FormFieldEntry } from "@/types";
import { isUnresolved, noFile, withFileTrust } from "./file-trust";

describe("isUnresolved", () => {
	it.each([
		[false, false],
		[true, true],
		[undefined, true],
	])("reads %s as %s", (flag, expected) => {
		expect(isUnresolved(flag)).toBe(expected);
	});
});

describe("noFile", () => {
	it("is an empty path nobody chose, and a fresh object each time", () => {
		expect(noFile()).toEqual({ src: "", unresolved: true });
		expect(noFile()).not.toBe(noFile());
	});
});

describe("withFileTrust", () => {
	const part = (unresolved: boolean | undefined): FormFieldEntry => ({
		key: "f",
		value: "",
		enabled: true,
		type: "file",
		src: "/a.png",
		unresolved,
	});

	it.each([
		[false, false],
		[true, true],
		[undefined, true],
	])("states a file part's %s as %s", (given, stated) => {
		expect(withFileTrust([part(given)])[0]).toHaveProperty("unresolved", stated);
	});

	it("leaves a text part without the flag", () => {
		const text: FormFieldEntry = { key: "k", value: "v", enabled: true };
		expect(withFileTrust([text])[0]).toBe(text);
	});
});
