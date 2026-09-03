/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every chord is either in the palette or excused, and the excuse is written
 * down (#1219).
 *
 * The palette is the app's discoverability surface: a chord absent from it can
 * be found only in the Settings panel, by someone who already suspects it
 * exists. Save, the drawer toggle, the context-bar toggle and all five view
 * switchers had been chords with no row for as long as the palette had existed,
 * and nothing could have said so - `Command.shortcut` points *from* a command
 * *to* a chord, so a chord with no command is invisible from both sides.
 *
 * This walks the other way. The partition below is total by construction: a new
 * chord that reaches neither list fails here, and the author has to decide
 * which it is rather than defaulting to silence. That is the whole value - the
 * exclusions are not a loophole, they are the record of a decision.
 */

import { describe, it, expect } from "vitest";
import { SHORTCUT_GROUPS, TAB_CHORDS } from "@/constants/shortcuts";
import * as shortcuts from "@/constants/shortcuts";
import type { Chord } from "@/lib/platform";
import { COMMANDS } from "./registry";

/**
 * Chords with no palette command, and why not. Keyed by the chord object
 * itself, so an entry cannot drift onto a chord that was renamed or respelled.
 */
const NO_COMMAND = new Map<Chord, string>([
	[
		shortcuts.PALETTE_CHORD,
		"the palette cannot offer a row that opens the palette you are already in",
	],
	[
		shortcuts.LEAVE_EDITOR_CHORD,
		"scoped to the editor that has focus; the palette takes focus away, so " +
			"there would be no editor to leave by the time it ran",
	],
	[
		shortcuts.EDIT_VARIABLE_CHORD,
		"reads the caret's own token in the editor that has focus - same reason " +
			"as the leave-editor chord above it, and the palette would have taken " +
			"the caret away before the command could look",
	],
	[
		shortcuts.FOCUS_URL_CHORD,
		"moves focus, and the palette restores focus to wherever it was when it " +
			"opened - the command would be undone as it closed",
	],
	[shortcuts.NEXT_REGION_CHORD, "moves focus - same reason as ⌘L"],
	[shortcuts.PREVIOUS_REGION_CHORD, "moves focus - same reason as ⌘L"],
	[
		shortcuts.NEXT_TAB_CHORD,
		"the palette already lists every open tab by name, which is the better " +
			"answer to 'go to that tab' when you are typing anyway",
	],
	[shortcuts.PREVIOUS_TAB_CHORD, "the palette already lists every open tab by name"],
	...TAB_CHORDS.map((chord): [Chord, string] => [
		chord,
		"nine 'Focus tab N' rows would bury the actions they sit among, and " +
			"the tabs are already listed by name",
	]),
]);

/** Every chord any surface prints, in the order the panel prints them. */
const listed = SHORTCUT_GROUPS.flatMap((group) => [...group.chords]);

/** The chords a palette row runs. */
const withCommand = new Set(
	COMMANDS.map((command) => command.shortcut).filter(
		(chord): chord is Chord => chord !== undefined
	)
);

describe("chords and palette commands", () => {
	it("has chords and commands to compare at all", () => {
		// Two floors, because either list arriving empty would make every case
		// below vacuously true.
		expect(listed.length).toBeGreaterThan(20);
		expect(withCommand.size).toBeGreaterThan(5);
	});

	it("gives every chord either a palette command or a written reason", () => {
		const unaccounted = listed.filter(
			(chord) => !withCommand.has(chord) && !NO_COMMAND.has(chord)
		);
		expect(
			unaccounted.map((chord) => chord.label ?? chord.key),
			"add a Command with this `shortcut`, or an entry to NO_COMMAND saying why not"
		).toEqual([]);
	});

	it("excuses no chord twice over", () => {
		// An entry that also has a command is a stale excuse, and a stale excuse
		// is how the list stops being read.
		const both = listed.filter((chord) => withCommand.has(chord) && NO_COMMAND.has(chord));
		expect(both.map((chord) => chord.label ?? chord.key)).toEqual([]);
	});

	it("excuses only chords that exist", () => {
		const shown = new Set(listed);
		const orphans = [...NO_COMMAND.keys()].filter((chord) => !shown.has(chord));
		expect(orphans.map((chord) => chord.label ?? chord.key)).toEqual([]);
	});

	it("says why, for each one", () => {
		for (const [chord, reason] of NO_COMMAND) {
			expect(
				reason.length,
				`${chord.label ?? chord.key} has an empty reason`
			).toBeGreaterThan(20);
		}
	});

	it("would notice a chord that reached neither list", () => {
		// The guard's own mutation check: with three of the newly-wired commands
		// pretended away, the chords they carry are exactly what should come
		// back unaccounted for.
		const pretendCommands = new Set(
			[...withCommand].filter(
				(chord) =>
					chord !== shortcuts.SAVE_CHORD &&
					chord !== shortcuts.TOGGLE_DRAWER_CHORD &&
					chord !== shortcuts.TOGGLE_CONTEXT_BAR_CHORD
			)
		);
		const unaccounted = listed.filter(
			(chord) => !pretendCommands.has(chord) && !NO_COMMAND.has(chord)
		);
		expect(unaccounted).toEqual([
			shortcuts.SAVE_CHORD,
			shortcuts.TOGGLE_DRAWER_CHORD,
			shortcuts.TOGGLE_CONTEXT_BAR_CHORD,
		]);
	});
});
