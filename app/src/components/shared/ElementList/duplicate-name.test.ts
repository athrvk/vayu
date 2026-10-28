/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { nextCopyName } from "./duplicate-name";

describe("nextCopyName", () => {
	it("appends ' copy' to a name no sibling has taken", () => {
		expect(nextCopyName("X", ["X"])).toBe("X copy");
	});

	it("numbers from 2 once the plain copy exists", () => {
		expect(nextCopyName("X", ["X", "X copy"])).toBe("X copy 2");
	});

	it("takes the first free number, not one past the highest", () => {
		expect(nextCopyName("X", ["X", "X copy", "X copy 3"])).toBe("X copy 2");
	});

	it("strips the suffix of a copy so duplicating a duplicate does not stack it", () => {
		expect(nextCopyName("X copy", ["X", "X copy"])).toBe("X copy 2");
		expect(nextCopyName("X copy 2", ["X", "X copy", "X copy 2"])).toBe("X copy 3");
	});

	it("restores the plain copy when only a numbered one is left", () => {
		expect(nextCopyName("X copy 2", ["X copy 2"])).toBe("X copy");
	});

	it("only treats a trailing, space-separated 'copy' as a suffix", () => {
		expect(nextCopyName("Copycat", ["Copycat"])).toBe("Copycat copy");
		expect(nextCopyName("copy", ["copy"])).toBe("copy copy");
		expect(nextCopyName("My copy of X", ["My copy of X"])).toBe("My copy of X copy");
	});
});
