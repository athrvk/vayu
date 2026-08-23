/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shortcuts panel must be the registry, not a picture of it (#951).
 *
 * Two ways it could stop being that, and one case each: a chord added to
 * `constants/shortcuts.ts` that never gets a row (the row count is compared to
 * the registry's own entry count, not to a number typed here), and a key-cap
 * spelled in the panel instead of rendered through `chordKeys` (the caps are
 * compared to what `chordKeys` returns, and the file is scanned for a modifier
 * glyph of its own).
 *
 * Nothing here asserts a platform. `chordKeys` answers differently on macOS and
 * elsewhere, so both sides of every comparison come from it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { chordKeys } from "@/lib/platform";
import { SHORTCUT_GROUPS } from "@/constants/shortcuts";
import KeyboardShortcutsPanel from "./KeyboardShortcutsPanel";

const CHORDS = SHORTCUT_GROUPS.flatMap((group) => [...group.chords]);

beforeEach(cleanup);

function rows(): HTMLElement[] {
	render(<KeyboardShortcutsPanel />);
	return [...document.querySelectorAll<HTMLElement>("[data-shortcut-row]")];
}

describe("KeyboardShortcutsPanel", () => {
	it("draws one row per registry chord, and no more", () => {
		// The registry itself is the expected count. A literal here would be the
		// hand-maintained copy this panel exists not to be.
		expect(CHORDS.length).toBeGreaterThanOrEqual(18);
		expect(rows().length).toBe(CHORDS.length);
	});

	it("names each row from the chord's own label", () => {
		const named = rows().map((row) => row.getAttribute("data-shortcut-row"));
		for (const chord of CHORDS) {
			expect(named, `no row for ${chord.key}`).toContain(chord.label);
			expect(screen.getByText(chord.label as string)).toBeTruthy();
		}
	});

	it("renders each chord's key-caps through chordKeys, one Kbd per key", () => {
		const byLabel = new Map(rows().map((row) => [row.getAttribute("data-shortcut-row"), row]));
		for (const chord of CHORDS) {
			const row = byLabel.get(chord.label ?? null);
			expect(row, `no row for ${chord.label}`).toBeTruthy();
			const caps = [...row!.querySelectorAll("kbd")].map((cap) => cap.textContent);
			expect(caps).toEqual(chordKeys(chord));
		}
	});

	it("prints every group heading", () => {
		render(<KeyboardShortcutsPanel />);
		for (const group of SHORTCUT_GROUPS) {
			expect(screen.getByText(group.title)).toBeTruthy();
		}
	});

	it("spells no modifier of its own", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "KeyboardShortcutsPanel.tsx"),
			"utf8"
		);
		// Comments are stripped first: the file's own header names the chords it
		// exists for, and a guard that flagged its rationale would be read as
		// noise and deleted. Both lengths are asserted, since a scan of an empty
		// string passes everything.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		expect(source.length).toBeGreaterThan(1000);
		expect(code.length).toBeGreaterThan(500);
		expect(code).toContain("chordKeys");
		// A cap typed here (⌘, ⇧, "Ctrl+…") is the second spelling this panel
		// exists to avoid; the platform module owns every one of them.
		expect(code).not.toMatch(/[⌘⇧⌥]/);
		expect(code).not.toMatch(/Ctrl\s*\+/);
	});
});
