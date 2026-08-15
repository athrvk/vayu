/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { diffDataSchema, describeDataSchemaDiff } from "./schema-diff";

describe("diffDataSchema", () => {
	it("reports both directions", () => {
		expect(diffDataSchema(["id", "email"], ["id", "nickname"])).toEqual({
			missing: ["email"],
			undeclared: ["nickname"],
		});
	});

	it("finds nothing when the file matches, whatever the order", () => {
		expect(diffDataSchema(["id", "email"], ["email", "id"])).toEqual({
			missing: [],
			undeclared: [],
		});
	});

	it("treats no contract as no mismatch rather than as everything undeclared", () => {
		// The absence of a contract is not a failed one - a collection that has
		// declared nothing must not warn about every column of every file.
		expect(diffDataSchema([], ["id", "email"])).toEqual({ missing: [], undeclared: [] });
		expect(describeDataSchemaDiff([], ["id", "email"])).toEqual([]);
	});
});

describe("describeDataSchemaDiff", () => {
	it("names the missing columns and a token that will not bind", () => {
		const [message] = describeDataSchemaDiff(["id", "email", "plan"], ["id"]);
		expect(message).toContain("2 declared columns");
		expect(message).toContain("email and plan");
		expect(message).toContain("{{data.email}}");
	});

	it("uses the singular for one column", () => {
		const [message] = describeDataSchemaDiff(["id", "email"], ["id"]);
		expect(message).toContain("a declared column: email");
	});

	it("reports an undeclared column as a second, separate sentence", () => {
		const messages = describeDataSchemaDiff(["id"], ["id", "nickname"]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("does not declare: nickname");
	});

	it("says nothing at all when the file matches", () => {
		expect(describeDataSchemaDiff(["id", "email"], ["id", "email"])).toEqual([]);
	});
});
