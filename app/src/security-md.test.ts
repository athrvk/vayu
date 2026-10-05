/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SECURITY.md is what a user reads to decide whether to trust Vayu with a
 * secret. The sections that say what it defends and what it accepts must not
 * drift away unnoticed (#1783).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const doc = readFileSync(resolve(__dirname, "../../SECURITY.md"), "utf8");

const SECTIONS = [
	"What Vayu defends and what it does not",
	"Data at rest",
	"Agents (MCP)",
	"Network behaviour",
	"Releases",
];

describe("SECURITY.md structure", () => {
	it("was read from disk", () => {
		expect(doc.length).toBeGreaterThan(1000);
	});

	it.each(SECTIONS)("has a '%s' section", (title) => {
		expect(doc).toMatch(new RegExp(`^## ${title.replace(/[()]/g, "\\$&")}$`, "m"));
	});
});
