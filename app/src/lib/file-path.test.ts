/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Path text from any machine: an imported collection carries whatever the
 * exporter's platform wrote, so every helper here answers both separators
 * whichever host runs it.
 */

import { describe, it, expect } from "vitest";
import { fileBaseName, isUnderFolder, parentFolder } from "./file-path";

describe("fileBaseName", () => {
	it("takes the last segment for either separator", () => {
		expect(fileBaseName("/data/a.bin")).toBe("a.bin");
		expect(fileBaseName("C:\\data\\a.bin")).toBe("a.bin");
		expect(fileBaseName("a.bin")).toBe("a.bin");
	});
});

describe("parentFolder", () => {
	it("drops the last segment for either separator", () => {
		expect(parentFolder("/data/fixtures/a.bin")).toBe("/data/fixtures");
		expect(parentFolder("C:\\data\\a.bin")).toBe("C:\\data");
	});

	it("keeps a root a root", () => {
		expect(parentFolder("/a.bin")).toBe("/");
		expect(parentFolder("C:\\a.bin")).toBe("C:\\");
	});

	it("answers nothing for a path with no folder", () => {
		expect(parentFolder("a.bin")).toBe("");
		expect(parentFolder("")).toBe("");
	});
});

describe("isUnderFolder", () => {
	it("is true inside the folder and any folder below it", () => {
		expect(isUnderFolder("/data/fixtures/a.bin", "/data/fixtures")).toBe(true);
		expect(isUnderFolder("/data/fixtures/deep/a.bin", "/data/fixtures/")).toBe(true);
	});

	it("compares whole components, not prefixes", () => {
		expect(isUnderFolder("/data/fixtures-old/a.bin", "/data/fixtures")).toBe(false);
		expect(isUnderFolder("/data/fixtures", "/data/fixtures")).toBe(false);
	});

	it("reads a Windows path with either separator and any drive-letter case", () => {
		expect(isUnderFolder("c:\\Data\\a.bin", "C:/data")).toBe(true);
		expect(isUnderFolder("D:\\data\\a.bin", "C:\\data")).toBe(false);
	});

	it("treats the filesystem root as covering every absolute path", () => {
		expect(isUnderFolder("/a.bin", "/")).toBe(true);
		expect(isUnderFolder("a.bin", "/")).toBe(false);
	});

	it("is false for an empty side", () => {
		expect(isUnderFolder("", "/data")).toBe(false);
		expect(isUnderFolder("/data/a.bin", "")).toBe(false);
	});
});
