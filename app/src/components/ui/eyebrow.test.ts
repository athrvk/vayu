/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The eyebrow class string is typed out in exactly one place.
 *
 * `EYEBROW_CLASS` was extracted precisely because the value had been re-typed
 * across the app and drifted - the two in `HeadersViewer` were `text-sm ...
 * tracking-wide` and `text-xs ... uppercase`, neither of them the 11px the rest
 * of the app used. Extracting a constant does not stop that on its own: twelve
 * byte-for-byte copies of the full class string were still sitting in the
 * settings panels, the welcome screens and the GraphQL body pane, and one in
 * `InheritanceChain` had drifted to `tracking-[0.07em]`. A constant nobody is
 * required to use is a suggestion.
 *
 * The rule this guards is narrow on purpose: **the exact string may appear
 * once**. It says nothing about the other uppercase labels in the tree, and
 * should not - `CollectionDetail/shared.tsx` and `ChainCard` run a denser 10px
 * tier, and `ResponseBody`'s content-type chip is 11px *without* the semibold
 * because it sits inline in a 32px toolbar band. Those are different things
 * that happen to be uppercase, not copies of this one.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { EYEBROW_CLASS } from "./eyebrow";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

/** Where the constant itself is declared - the one legal occurrence. */
const DECLARATION = join(here, "eyebrow.tsx");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

describe("EYEBROW_CLASS is written once", () => {
	const files = walk(srcRoot).filter((f) => !f.endsWith("eyebrow.test.ts"));

	it("scanned a non-empty tree", () => {
		// A guard that reads nothing passes forever.
		expect(files.length).toBeGreaterThan(100);
		expect(EYEBROW_CLASS).toContain("text-[11px]");
	});

	it("no file re-types the full class string", () => {
		const offenders = files
			.filter((f) => f !== DECLARATION)
			.filter((f) => readFileSync(f, "utf8").includes(EYEBROW_CLASS))
			.map((f) => relative(srcRoot, f));

		expect(offenders).toEqual([]);
	});

	it("the declaration still holds it, so the scan is looking for something real", () => {
		expect(readFileSync(DECLARATION, "utf8")).toContain(EYEBROW_CLASS);
	});
});
