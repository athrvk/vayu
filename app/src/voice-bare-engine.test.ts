/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Two words `docs/ux-writing.md` keeps out of rendered text (#2298):
 *
 *  - a bare "the engine". The daemon on port 9876 is "Vayu's engine"; a
 *    sentence that says "the engine" leaves the word free to mean the target
 *    server of the user's request, and the reader cannot tell whose process
 *    failed;
 *  - "design-mode". "Design" is a wire word, never a user word: the run kinds
 *    are Send, Collection run and Load test.
 *
 * The strings come from `ui-strings.testkit.ts`, which already leaves out
 * comments, logs, tests and `electron/mcp/**`.
 */

import { describe, it, expect } from "vitest";
import { uiStrings } from "@/lib/ui-strings.testkit";

// ---------------------------------------------------------------------------
// The detectors, exported for the cases at the bottom of this file.
// ---------------------------------------------------------------------------

/** "the engine", "The engine's", "the Engine"; "Vayu's engine" is the spelling to use. */
export function hasBareEngine(text: string): boolean {
	return /\bthe engine\b/i.test(text);
}

export function hasDesignMode(text: string): boolean {
	return /\bdesign[- ]mode\b/i.test(text);
}

const RULES: readonly { readonly name: string; readonly breaks: (text: string) => boolean }[] = [
	{ name: 'bare "the engine" (write "Vayu\'s engine")', breaks: hasBareEngine },
	{ name: '"design-mode" (write "Send")', breaks: hasDesignMode },
];

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const { files, strings } = uiStrings();

const breaches = strings.flatMap((entry) =>
	RULES.filter(({ breaks }) => breaks(entry.text)).map(({ name }) => ({
		report: `${entry.file}:${entry.line} ${name}: ${JSON.stringify(entry.text)}`,
	}))
);

describe("the bare-engine scan", () => {
	it("reads a real tree", () => {
		expect(files.length).toBeGreaterThan(500);
		expect(strings.length).toBeGreaterThan(2000);
		// A string that carries the right spelling, so a scan that read nothing of
		// the tree's text cannot pass for one that found no breach.
		expect(strings.some(({ text }) => text.includes("Vayu's engine"))).toBe(true);
	});

	it("finds no breach", () => {
		expect(
			breaches.map(({ report }) => report).join("\n"),
			'Say "Vayu\'s engine", and "Send" for a design-mode send (docs/ux-writing.md).'
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// The detectors, one bad and one good per rule.
// ---------------------------------------------------------------------------

describe("the bare-engine rule", () => {
	it("refuses the engine without Vayu's", () => {
		expect(hasBareEngine("Couldn't connect to the engine.")).toBe(true);
		expect(hasBareEngine("The engine returned no report for this run.")).toBe(true);
		expect(hasBareEngine("the engine's own limit")).toBe(true);
	});

	it("passes Vayu's engine, and other engines", () => {
		expect(hasBareEngine("Couldn't connect to Vayu's engine.")).toBe(false);
		expect(hasBareEngine("Vayu's engine returned no report for this run.")).toBe(false);
		expect(hasBareEngine("the engineering team")).toBe(false);
	});
});

describe("the design-mode rule", () => {
	it("refuses design-mode as a user word", () => {
		expect(hasDesignMode("stops a design-mode send there")).toBe(true);
		expect(hasDesignMode("Design mode requests")).toBe(true);
	});

	it("passes the run kinds, and the setting label", () => {
		expect(hasDesignMode("Vayu's engine stops a Send there")).toBe(false);
		expect(hasDesignMode("Max Design Response Body")).toBe(false);
	});
});
