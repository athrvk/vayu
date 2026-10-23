/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The JMeter comparison page's controller count, held to the importer (#2406).
 *
 * The page said "the six logic controllers" while `parse_controller` has no
 * `SwitchController` branch, so the sixth imports as a plain folder. A count in
 * prose is not code and no build reads it; this reads both sides, so a page that
 * claims all six while the importer leaves one unmapped is red, and so is the
 * importer gaining the sixth while the page still says five.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DOC_READING_GUARDS,
	ENGINE_READING_GUARDS,
	fromRepoRoot,
} from "@/lib/routed-inputs.testkit";

const [PAGE] = DOC_READING_GUARDS.jmeterCompareControllers.paths.map(fromRepoRoot);
const [IMPORTER] = ENGINE_READING_GUARDS.jmeterCompareControllers.paths.map(fromRepoRoot);

/** Prose wraps mid-phrase; fold whitespace so "six logic\ncontrollers" still matches. */
const page = readFileSync(PAGE, "utf8").replace(/\s+/g, " ");
const importer = readFileSync(IMPORTER, "utf8");

/** The body of `parse_controller`, which is where a controller class gains a `control.*` kind. */
function parseControllerBody(source: string): string {
	const start = source.indexOf("std::optional<KindConfig> parse_controller");
	if (start === -1) return "";
	const end = source.indexOf("\n}\n", start);
	return end === -1 ? "" : source.slice(start, end);
}

describe("the JMeter comparison page's logic controller count", () => {
	const body = parseControllerBody(importer);

	it("reads a page and an importer function that are not empty", () => {
		expect(page).toContain("logic controllers");
		expect(body).toContain('"LoopController"');
	});

	it("does not claim six while the importer leaves SwitchController unmapped", () => {
		const switchMapped = body.includes('tag == "SwitchController"');
		if (switchMapped) return;

		expect(page).not.toMatch(/six logic controllers/i);
	});

	it("names the unmapped one while the importer leaves it a plain folder", () => {
		const switchMapped = body.includes('tag == "SwitchController"');
		expect(switchMapped).toBe(false);
		expect(page).toMatch(/SwitchController`? imports as a plain folder/);
	});
});
