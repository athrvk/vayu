/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Completeness of the shortcuts surface (#951).
 *
 * The help panel is worth having only if it cannot fall behind the registry, so
 * this walks the registry module's own exports for `Chord` objects and holds
 * two things about each: it is reachable from `SHORTCUT_GROUPS`, and it carries
 * a `label` to be listed under. Adding `export const FOO_CHORD` and forgetting
 * the group reddens here rather than shipping a shortcut nothing advertises.
 *
 * Walked rather than source-scanned because the chords arrive in three shapes -
 * a bare const, a `Record` keyed by drawer view, and a generated array - and a
 * scan would have to parse all three. The values are the truth; the identity
 * comparison is what makes "the same chord, listed once" checkable at all.
 */

import { describe, it, expect } from "vitest";
import type { Chord } from "@/lib/platform";
import * as shortcuts from "./shortcuts";

/** A `Chord` is the only exported object shape carrying a string `key`. */
function isChord(value: unknown): value is Chord {
	return typeof value === "object" && value !== null && typeof (value as Chord).key === "string";
}

/** Every chord reachable from a value, following arrays and plain objects. */
function collect(value: unknown, into: Set<Chord>): Set<Chord> {
	if (isChord(value)) {
		into.add(value);
		return into;
	}
	if (Array.isArray(value)) {
		for (const item of value) collect(item, into);
		return into;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) collect(item, into);
	}
	return into;
}

/** Every chord the module exports, however it is packaged. */
const declared = collect(shortcuts, new Set<Chord>());

/** Every chord the surface would print, in the order it prints them. */
const listed = shortcuts.SHORTCUT_GROUPS.flatMap((group) => [...group.chords]);

describe("the chord registry", () => {
	it("declares chords at all - an empty walk would pass every case below", () => {
		// Nine tab chords plus the ten named ones, with ⌘, shared.
		expect(declared.size).toBeGreaterThanOrEqual(18);
	});

	it("names every chord, so a row has something to be called", () => {
		for (const chord of declared) {
			expect(chord.label, `${chord.key} has no label`).toBeTruthy();
		}
	});

	it("puts every declared chord in a group", () => {
		const inGroups = new Set(listed);
		for (const chord of declared) {
			expect(
				inGroups.has(chord),
				`${chord.label ?? chord.key} is declared but reaches no SHORTCUT_GROUPS entry`
			).toBe(true);
		}
	});

	it("lists each chord once - ⌘, is both SETTINGS_CHORD and the settings drawer view", () => {
		expect(listed.length).toBe(new Set(listed).size);
		expect(listed).toContain(shortcuts.SETTINGS_CHORD);
	});

	it("gives every group a heading and something under it", () => {
		expect(shortcuts.SHORTCUT_GROUPS.length).toBeGreaterThan(0);
		for (const group of shortcuts.SHORTCUT_GROUPS) {
			expect(group.title).toBeTruthy();
			expect(group.chords.length, `group ${group.id} is empty`).toBeGreaterThan(0);
		}
	});
});
