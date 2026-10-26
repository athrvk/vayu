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
import { describe, expect, it } from "vitest";
import { ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const [SECURITY_PATH] = ROOT_READING_GUARDS.securityPolicy.paths;
const doc = readFileSync(fromRepoRoot(SECURITY_PATH), "utf8");

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

/** A section's body: from its heading to the next `## ` one, whitespace folded. */
function section(title: string): string {
	const start = doc.indexOf(`\n## ${title}\n`);
	expect(start, `no '${title}' section`).toBeGreaterThan(-1);
	const next = doc.indexOf("\n## ", start + 1);
	return doc.slice(start, next === -1 ? undefined : next).replace(/\s+/g, " ");
}

describe("SECURITY.md covers the update check", () => {
	it("says under Network behaviour that the app checks for updates and cannot be told not to", () => {
		const network = section("Network behaviour");
		expect(network).toMatch(/update check/i);
		expect(network).toMatch(/no setting to turn the check off/);
	});

	it("says under Releases what the updater verifies", () => {
		const releases = section("Releases");
		expect(releases).toMatch(/in-app updater/i);
		expect(releases).toMatch(/installer's attestation, not the feed's/);
	});
});
