/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file-reference trust flag is the engine's derived answer (#2356): the
 * editor reads it, a pick sets `false` until the next read, and no payload
 * carries it.
 */

import { describe, it, expect } from "vitest";
import type { FormFieldEntry, RequestBody } from "@/types";
import {
	flagAfterPick,
	isUnresolved,
	noFile,
	withoutBodyFileTrust,
	withoutFileTrust,
} from "./file-trust";

describe("isUnresolved", () => {
	// Absent is a path the engine has not answered for yet: typed or pasted.
	it.each([
		[false, false],
		[true, true],
		[undefined, true],
	])("reads %s as %s", (flag, expected) => {
		expect(isUnresolved(flag)).toBe(expected);
	});
});

describe("flagAfterPick", () => {
	it("is false for a pick that yielded a path, and nothing without one", () => {
		expect(flagAfterPick("/home/u/a.png")).toBe(false);
		expect(flagAfterPick("")).toBeUndefined();
	});
});

describe("noFile", () => {
	it("is an empty path with no flag, and a fresh object each time", () => {
		expect(noFile()).toEqual({ src: "" });
		expect(noFile()).not.toHaveProperty("unresolved");
		expect(noFile()).not.toBe(noFile());
	});
});

describe("withoutFileTrust", () => {
	const part = (unresolved: boolean | undefined): FormFieldEntry => ({
		key: "f",
		value: "",
		enabled: true,
		type: "file",
		src: "/a.png",
		unresolved,
	});

	it.each([[false], [true], [undefined]])("drops a file part's %s", (given) => {
		const [out] = withoutFileTrust([part(given)]);
		expect(out).not.toHaveProperty("unresolved");
		expect(out).toMatchObject({ type: "file", src: "/a.png" });
	});

	it("leaves a text part's members as they were", () => {
		const text: FormFieldEntry = { key: "k", value: "v", enabled: true };
		expect(withoutFileTrust([text])).toEqual([text]);
	});
});

describe("withoutBodyFileTrust", () => {
	it("drops a binary body's flag and keeps the rest of the reference", () => {
		const body: RequestBody = {
			mode: "binary",
			file: { src: "/a.bin", fileName: "a.bin", unresolved: true },
		};
		expect(withoutBodyFileTrust(body)).toEqual({
			mode: "binary",
			file: { src: "/a.bin", fileName: "a.bin" },
		});
	});

	it("drops a form-data file part's flag", () => {
		const body: RequestBody = {
			mode: "form-data",
			fields: [
				{ key: "f", value: "", enabled: true, type: "file", src: "/a", unresolved: false },
			],
		};
		const out = withoutBodyFileTrust(body);
		expect(out.mode === "form-data" && out.fields[0]).not.toHaveProperty("unresolved");
	});

	it("returns a body with no file reference unchanged", () => {
		const body: RequestBody = { mode: "json", content: "{}" };
		expect(withoutBodyFileTrust(body)).toBe(body);
	});
});
