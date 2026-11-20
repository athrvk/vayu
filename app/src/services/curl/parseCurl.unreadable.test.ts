/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `readCommand` never throws (#3685): `ImportModal` calls `importCommand`
 * unguarded, so a parser fault on odd input must come back as a verdict.
 * The parser's own throw is stubbed here because the inputs that really reach
 * one (a lone surrogate) are an accident of today's code, not a contract.
 */

import { describe, expect, it, vi } from "vitest";
import { importCommand, readCommand } from "./parseCurl";

vi.mock("./tokenize", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tokenize")>()),
	tokenize: () => {
		throw new RangeError("a parser fault that is not an unterminated quote");
	},
}));

describe("a parser fault", () => {
	it("is reported as unreadable rather than thrown", () => {
		expect(readCommand("curl https://x.com")).toEqual({ ok: false, reason: "unreadable" });
	});

	it("is null for the callers that only ask whether there is an import", () => {
		expect(importCommand("wget https://x.com")).toBeNull();
	});
});
