/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App-wide keyboard shortcuts, in one place.
 *
 * Each is defined once as a `Chord` and read by both the handler that fires it
 * and the label that advertises it, so a button cannot claim a key combination
 * the handler does not listen for. Send had worked since forever and appeared
 * nowhere on screen; Load Test had no shortcut at all.
 *
 * `formatChord` renders them per platform (⌘↵ on macOS, Ctrl+↵ elsewhere) - see
 * `lib/platform.ts`.
 */

import { isMac, type Chord } from "@/lib/platform";
import type { DrawerView } from "@/stores";

/** Send the request. */
export const SEND_CHORD: Chord = { mod: true, key: "↵", label: "Send request" };

/** Start a load test. Shift distinguishes it from Send, as it escalates it. */
export const LOAD_TEST_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "↵",
	label: "Start a load test",
};

/**
 * Open the command palette.
 *
 * ⌘K/Ctrl+K is the cross-app convention for "search everything" (VS Code,
 * Slack, Linear, GitHub), which is the whole reason it is worth taking: the
 * chord is the one users already try.
 *
 * Declared here rather than inline in `Shell` because a second surface reads
 * it - the palette's own hint, and the title-bar search bar that will show the
 * chord it triggers. That is exactly the pairing this file exists to keep
 * honest.
 *
 * `mod: "strict"` is the one exception to the lenient modifier, and it is not a
 * preference: this listener runs on the *capture* phase (see `CommandPalette`),
 * so a lenient match ate Ctrl+K on macOS - the Cocoa kill-to-end-of-line - out
 * of every input and editor in the app before the focused control saw it.
 */
export const PALETTE_CHORD: Chord = { mod: "strict", key: "K", label: "Open the command palette" };

/** Save the active tab's entity. */
export const SAVE_CHORD: Chord = { mod: true, key: "S", label: "Save the active tab" };

/** Close the active tab. */
export const CLOSE_TAB_CHORD: Chord = { mod: true, key: "W", label: "Close tab" };

/** Show/hide the left drawer. */
export const TOGGLE_DRAWER_CHORD: Chord = { mod: true, key: "B", label: "Show or hide the drawer" };

/** Show/hide the right context bar. */
export const TOGGLE_CONTEXT_BAR_CHORD: Chord = {
	mod: true,
	key: "I",
	label: "Show or hide the context bar",
};

/** Open Settings, the platform convention for a preferences window. */
export const SETTINGS_CHORD: Chord = { mod: true, key: ",", label: "Open settings" };

/** Create a request. ⌘N is what every app that makes things binds. */
export const NEW_REQUEST_CHORD: Chord = { mod: true, key: "N", label: "New request" };

/**
 * Put the caret in the URL field, the way ⌘L does in a browser.
 *
 * Bridged out of Monaco (`lib/editor-chords.ts`): the standalone editor binds
 * CtrlCmd+L to `expandLineSelection`, and this is exactly the chord someone
 * halfway through a request body reaches for.
 */
export const FOCUS_URL_CHORD: Chord = { mod: true, key: "L", label: "Focus the URL bar" };

/**
 * Move to the next open tab, and back.
 *
 * ⇧⌘] / ⇧⌘[ is Safari's and Chrome's own pair on macOS, and free of both maps
 * on the others - the native menu binds no bracket at all and the renderer's
 * ⇧⌘ chords are E, H, U, S, T and M.
 *
 * Matched by `code`, for the reason the digit row is: the character these keys
 * produce moves with the layout *and* with Shift - a US keyboard reports `}`
 * for ⇧], and an AZERTY one has no unshifted bracket at all - while the
 * position is the same everywhere. `key` stays the label, so the hint reads
 * ⇧⌘] rather than ⇧⌘}.
 *
 * One definition on every platform, rather than these brackets on macOS and
 * the Ctrl+Tab pair Windows and Linux browsers also offer. That fork is
 * *available* - `mod: "strict"` already means the platform's own modifier and
 * refuses the other, so `isMac ? this : { mod: "strict", key: "Tab" }` would
 * express it - and it is a judgement, not an impossibility. It was declined
 * because a forked chord is two chords wearing one name: two bindings for the
 * bridge and the panel to get right, two rows for a platform test to pin, and
 * a second key to keep free in both maps forever. ⇧⌘] and ⇧⌘[ are already the
 * macOS convention, and free on the others, so the fork would buy Windows and
 * Linux a more familiar chord and nothing else.
 *
 * What is genuinely inexpressible is Ctrl+Tab on *macOS*: `mod` is ⌘ there
 * whether lenient or strict, and `Chord` has no word for a literal Control
 * key. That would need a new modifier threaded through `matchesChord`,
 * `chordKeys`, `chordKeybinding` and `dispatchChord` - which is a reason not
 * to reach for Ctrl+Tab everywhere, not a reason against the fork above.
 */
export const NEXT_TAB_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "]",
	code: "BracketRight",
	label: "Next tab",
};

export const PREVIOUS_TAB_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "[",
	code: "BracketLeft",
	label: "Previous tab",
};

/**
 * Move focus to the next region of the window - and, shifted, to the previous.
 *
 * F6 is the desktop convention for cycling panes (Windows Explorer, Firefox,
 * VS Code's `workbench.action.focusNextPart`), and it is the answer to the
 * thing landmarks alone do not fix: the drawer is labelled and reachable by a
 * screen reader's landmark list, and reaching the URL bar from a collection row
 * still meant Tabbing through every request in the tree.
 *
 * A skip link was the alternative and is the wrong shape here. "Skip to
 * content" exists because a web page has a top that a reader arrives at; a
 * desktop window has no top to skip from, and focus is as likely to start in
 * the context bar as anywhere else.
 *
 * No modifier, so `Shell`'s handler matches these before its `⌘ or Ctrl` gate.
 * That is safe because F6 is a function key: no text field consumes it, and
 * nothing in the app claims it.
 */
export const NEXT_REGION_CHORD: Chord = { key: "F6", label: "Focus the next region" };

export const PREVIOUS_REGION_CHORD: Chord = {
	shift: true,
	key: "F6",
	label: "Focus the previous region",
};

/**
 * Move focus out of a code editor.
 *
 * Monaco's Tab indents, which is right for a code editor and a keyboard trap
 * for anyone who reached one by tabbing (WCAG 2.1.2). Monaco's own way out is
 * `editor.action.toggleTabFocusMode`, and it cannot simply be advertised: its
 * binding is Ctrl+M, which on macOS is ⌃⇧M - a modifier this registry has no
 * word for - while the ⌘M the platform *would* spell it as is Minimize.
 *
 * So the app declares its own exit, here, where the Keyboard Shortcuts panel
 * lists it for free and `lib/editor-chords.ts` binds it. ⇧ sits beside Monaco's
 * Ctrl+M rather than taking it over, and CtrlCmd+Shift+M is claimed by neither
 * the standalone editor nor the native menu.
 *
 * Read-only editors have no trap to escape: `tabFocusMode` is simply on for
 * them (`ui/code-editor.tsx`), Tab having no editing meaning in text nobody can
 * type into, so they show no hint. The binding is still registered there - it
 * costs one `addCommand` and doing the same thing on every instance is cheaper
 * to keep true than a `readOnly` branch through the bridge - it is just
 * redundant with the Tab that already works.
 */
export const LEAVE_EDITOR_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "M",
	label: "Move focus out of the editor",
};

/**
 * Open the variable under the cursor, inside a code editor.
 *
 * The mouse route into a `{{token}}`'s popover is ⌘-click on the token itself
 * (issue #1220), and a keyboard user has no token to click - Monaco draws its
 * text rather than laying out DOM, so there is nothing there to Tab to the way
 * `VariableInput`'s overlay strip offers. This chord is that route: it reads the
 * caret's own position, so it needs no pointer and no roving tab stop.
 *
 * ⇧⌘D, and the free letters are why. Monaco binds A, F, G, I, K, L, M, O and R
 * with Shift somewhere in the combination; this registry already holds E, H, U,
 * S, T and M; the native menu takes ⇧⌘W, and the platform edit menu takes ⇧⌘Z
 * and ⇧⌘V. D is claimed by none of them.
 *
 * Bound per editor in the token hook rather than at `window`: which variable to
 * open is a question only the editor holding the caret can answer, exactly as
 * `LEAVE_EDITOR_CHORD` is the chord that acts on *this* editor.
 */
export const EDIT_VARIABLE_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "D",
	label: "Edit the variable under the cursor",
};

/**
 * The drawer view switchers, keyed by the view they activate.
 *
 * ⌘S is Save, so Services takes the shifted pair - free in both maps: the
 * renderer binds no other ⇧⌘ chord and the native menu's only one is ⇧⌘W
 * (close window). Settings is the odd one out because ⌘, is the platform
 * convention and predates the drawer having a Settings view at all.
 *
 * Read by the Shell's handler and by the Dock's tooltips, which is the pairing
 * this file exists for: the Dock advertised these as six independent
 * `formatChord` literals, coupled to the handler by a comment.
 */
export const DRAWER_VIEW_CHORDS: Record<DrawerView, Chord> = {
	collections: { mod: true, shift: true, key: "E", label: "Show collections" },
	history: { mod: true, shift: true, key: "H", label: "Show history" },
	variables: { mod: true, shift: true, key: "U", label: "Show variables" },
	services: { mod: true, shift: true, key: "S", label: "Show services" },
	// ⇧⌘T, free in both maps: the native menu binds no T at all (its only ⇧⌘
	// entry is ⇧⌘W) and the renderer's other view chords are E, H, U and S.
	trash: { mod: true, shift: true, key: "T", label: "Show trash" },
	settings: SETTINGS_CHORD,
};

/**
 * ⌘1-⌘9, focusing the nth open tab.
 *
 * Bound by `code` rather than by character - see `Chord.code`. The index into
 * this array is the tab index, so the order is the definition.
 */
export const TAB_CHORDS: readonly Chord[] = Array.from({ length: 9 }, (_, i) => ({
	mod: true,
	key: String(i + 1),
	code: `Digit${i + 1}`,
	label: `Focus tab ${i + 1}`,
}));

/** A named block of chords, as a surface that lists them prints it. */
export interface ShortcutGroup {
	/** Stable across renders and reorderings - the React key. */
	id: string;
	/** Heading above the block. */
	title: string;
	chords: readonly Chord[];
}

/**
 * Every chord above, grouped for display (#951).
 *
 * The membership is written here rather than in the panel that draws it, so the
 * surface holds no list of its own: it maps these groups, reads each chord's
 * `label`, and renders the keys through `chordKeys`. Adding a chord to this file
 * and to a group is the whole edit - `shortcuts.listed.test.ts` walks this
 * module's exports and fails if a chord reaches neither.
 *
 * `⌘,` appears once. `DRAWER_VIEW_CHORDS.settings` *is* `SETTINGS_CHORD` - the
 * same object, deliberately - so the drawer group filters it out by identity
 * rather than printing a second row for a key the reader already saw.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	{
		id: "requests",
		title: "Requests",
		chords: [NEW_REQUEST_CHORD, SEND_CHORD, LOAD_TEST_CHORD, FOCUS_URL_CHORD],
	},
	{
		id: "workspace",
		title: "Workspace",
		chords: [
			PALETTE_CHORD,
			SAVE_CHORD,
			CLOSE_TAB_CHORD,
			TOGGLE_DRAWER_CHORD,
			TOGGLE_CONTEXT_BAR_CHORD,
			SETTINGS_CHORD,
		],
	},
	{
		id: "drawer",
		title: "Drawer views",
		chords: Object.values(DRAWER_VIEW_CHORDS).filter((chord) => chord !== SETTINGS_CHORD),
	},
	{
		id: "tabs",
		title: "Tabs",
		chords: [NEXT_TAB_CHORD, PREVIOUS_TAB_CHORD, ...TAB_CHORDS],
	},
	{
		id: "focus",
		title: "Moving focus",
		chords: [NEXT_REGION_CHORD, PREVIOUS_REGION_CHORD],
	},
	{ id: "editors", title: "Editors", chords: [LEAVE_EDITOR_CHORD, EDIT_VARIABLE_CHORD] },
];

/**
 * Does this event match a chord?
 *
 * `shift` is compared strictly rather than ignored: without that,
 * Ctrl+Shift+Enter satisfies Send's `mod + Enter` too and both fire, which is
 * the one thing a modifier-distinguished pair must not do.
 *
 * `alt` is compared the same way, and that is a bug fix rather than symmetry:
 * on many European Windows layouts AltGr *is* Ctrl+Alt, so a handler that
 * ignored `altKey` fired Save on AltGr+S and closed the tab on AltGr+W while
 * the user was typing a `@`, `€` or `\`.
 *
 * The key itself is compared case-insensitively, because a letter chord is
 * declared in the case it is *displayed* in ("K", so the hint reads ⌘K) while
 * `KeyboardEvent.key` reports the character the keyboard produced - "k"
 * unmodified, "K" under Caps Lock. Case is never what distinguishes two chords
 * here; `shift` is, and it is still compared exactly. A chord carrying a `code`
 * is matched on that instead, the character it produces being irrelevant.
 */
export function matchesChord(
	e: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
	chord: Chord
): boolean {
	if (chord.code) {
		if (e.code !== chord.code) return false;
	} else {
		const key = chord.key === "↵" ? "Enter" : chord.key;
		if (e.key.toLowerCase() !== key.toLowerCase()) return false;
	}
	if (chord.mod === "strict") {
		if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
	} else if (!!chord.mod !== (e.metaKey || e.ctrlKey)) return false;
	if (!!chord.shift !== e.shiftKey) return false;
	if (!!chord.alt !== e.altKey) return false;
	return true;
}
