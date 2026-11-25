/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App-wide keyboard shortcuts. Each is one `Chord`, read by both the handler that fires it and the
 * label that advertises it, so a button cannot claim a combination the handler does not listen for.
 * `formatChord` renders them per platform (⌘↵ on macOS, Ctrl+↵ elsewhere; see `lib/platform.ts`).
 */

import { isMac, type Chord } from "@/lib/platform";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import type { DrawerView } from "@/stores/layout-store";

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
 * Open the command palette. ⌘K/Ctrl+K is the cross-app "search everything" chord (VS Code, Slack,
 * Linear, GitHub), worth taking because it is the one users already try.
 *
 * Declared here because two surfaces read it, the pairing this file exists to keep honest: the
 * palette's listener (`CommandPalette`) and the title-bar search bar that shows the chord
 * (`CommandSearchBar`).
 *
 * `mod: "strict"` is the one exception to the lenient modifier, and not a preference: the listener
 * runs on the *capture* phase, so a lenient match would take Ctrl+K on macOS (Cocoa's
 * kill-to-end-of-line) out of every input and editor in the app before the focused control saw it.
 */
export const PALETTE_CHORD: Chord = { mod: "strict", key: "K", label: "Open the command palette" };

/** Save the active tab's entity. */
export const SAVE_CHORD: Chord = { mod: true, key: "S", label: "Save the active tab" };

/** Close the active tab. */
export const CLOSE_TAB_CHORD: Chord = { mod: true, key: "W", label: "Close tab" };

/** Show/hide the left drawer. */
export const TOGGLE_DRAWER_CHORD: Chord = {
	mod: true,
	key: "B",
	label: "Show or hide the sidebar",
};

/** Show/hide the right context bar. */
export const TOGGLE_CONTEXT_BAR_CHORD: Chord = {
	mod: true,
	key: "I",
	label: "Show or hide the context bar",
};

/**
 * Show/hide the bottom panel (#3635); the Dock button and the palette row reach the same store
 * action.
 *
 * ⌘J, VS Code's chord for its own bottom panel, and unshifted by the elimination the chords below
 * record: Monaco's only CtrlCmd+J is the second half of its ⌘K ⌘J chord (unfold all), never a key
 * of its own, and its joinLines is ⌃J on macOS, a Control the lenient `mod` does not mean there;
 * this registry holds no other J; the native menu binds none (`electron/menu-accelerators.ts`). So
 * Monaco never swallows it, and it needs no entry in `lib/editor-chords.ts`.
 */
export const TOGGLE_BOTTOM_PANEL_CHORD: Chord = {
	mod: true,
	key: "J",
	label: `Show or hide the ${BOTTOM_PANEL_LABEL.toLowerCase()}`,
};

/**
 * Move the response pane from beside the request to below it, and back (#1711). Acts on the active
 * request tab only; the Dock button, the palette row and Settings > Appearance > Response position
 * reach the same store action.
 *
 * ⇧⌘B, by the elimination `EDIT_VARIABLE_CHORD` records: Monaco binds A, F, G, I, K, L, M, O and R
 * with Shift somewhere in the combination, this registry holds E, H, U, S, T, M and D, and the
 * native menu takes ⇧⌘W, ⇧⌘Z and ⇧⌘V. B is free in all three, and it sits beside ⌘B, the drawer
 * toggle, as the other chord that moves a pane.
 */
export const TOGGLE_RESPONSE_POSITION_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "B",
	label: "Toggle response position",
};

/** Open Settings, the platform convention for a preferences window. */
export const SETTINGS_CHORD: Chord = { mod: true, key: ",", label: "Open settings" };

/**
 * Open the application menu: the keyboard half of the title-bar icon (#1361). F10 is what a Windows
 * or Linux menu bar answers to, and this window draws none: it is frameless, so the menu the main
 * process installed is reachable only through the title bar. Alt alone opens the same menu, as it
 * does natively, but is not a chord (`lib/alt-tap.ts` says why a modifier with no key of its own
 * cannot be one).
 *
 * The label names the platforms because the binding is theirs: macOS keeps its menu bar and
 * registers nothing, and a row reading "Application menu" there would advertise a key that does
 * nothing. No modifier, so `AppIcon`'s handler matches it the way `Shell` matches F6: a function
 * key no text field consumes.
 */
export const APP_MENU_CHORD: Chord = {
	key: "F10",
	label: "Application menu (Windows and Linux)",
};

/** Create a request. ⌘N is what every app that makes things binds. */
export const NEW_REQUEST_CHORD: Chord = { mod: true, key: "N", label: "New request" };

/**
 * Put the caret in the URL field, as ⌘L does in a browser. Bridged out of Monaco
 * (`lib/editor-chords.ts`): the standalone editor binds CtrlCmd+L to `expandLineSelection`, and
 * this is the chord someone halfway through a request body reaches for.
 */
export const FOCUS_URL_CHORD: Chord = { mod: true, key: "L", label: "Focus the URL bar" };

/**
 * Move to the next open tab, and back. ⇧⌘] / ⇧⌘[ is Safari's and Chrome's own pair on macOS, and
 * free in both maps everywhere: the native menu's only brackets are Back and Forward, unshifted (⌘[
 * and ⌘] on macOS), and its only shifted chord is ⇧⌘W.
 *
 * Matched by `code`, as the digit row is: the character these keys produce moves with the layout
 * *and* with Shift (a US keyboard reports `}` for ⇧], an AZERTY one has no unshifted bracket at
 * all), while the position is the same everywhere. `key` stays the label, so the hint reads ⇧⌘]
 * rather than ⇧⌘}.
 *
 * One definition on every platform, not these brackets on macOS and the Ctrl+Tab pair Windows and
 * Linux browsers also offer. That fork is *available* (`mod: "strict"` already means the platform's
 * own modifier and refuses the other, so `isMac ? this : { mod: "strict", key: "Tab" }` would
 * express it); it is declined because a forked chord is two chords wearing one name: two bindings
 * for the bridge and the panel to get right, two rows for a platform test to pin, and a second key
 * to keep free in both maps forever. It would buy Windows and Linux a more familiar chord and
 * nothing else.
 *
 * What is inexpressible is Ctrl+Tab on *macOS*: `mod` is ⌘ there whether lenient or strict, and
 * `Chord.ctrl` is display only. A live literal Control would need threading through `matchesChord`,
 * `chordKeybinding` and `dispatchChord`, a reason not to reach for Ctrl+Tab everywhere, not a
 * reason against the fork above.
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
 * Go back to the previous place in the navigation history, and forward again.
 *
 * Defined per platform because the platforms disagree about what the chord *is*, not about which
 * modifier spells it: ⌘[ / ⌘] is what Safari and Chrome bind on macOS, Alt+← / Alt+→ is what every
 * browser binds on Windows and Linux, and each is dead or harmful on the other. Alt+← on macOS
 * moves the caret a word left in every text field; Ctrl+[ on Windows is Escape at the terminal
 * level and is bound by nothing a user would expect to navigate.
 *
 * Not the fork `NEXT_TAB_CHORD` declined, which would offer *two* chords for one action on one
 * platform. Here `isMac` picks one definition at import, so every surface reads a single `Chord`
 * with a single label and the Keyboard Shortcuts panel prints one row.
 *
 * Matched by `code`, as the digit row is: `[` is unshifted on a US layout and AltGr+8 on a German
 * one, while `BracketLeft` is the same key everywhere. `key` stays what is displayed, so the hint
 * reads ⌘[ and Alt+←.
 */
export const GO_BACK_CHORD: Chord = isMac
	? { mod: true, key: "[", code: "BracketLeft", label: "Go back" }
	: { alt: true, key: "←", code: "ArrowLeft", label: "Go back" };

export const GO_FORWARD_CHORD: Chord = isMac
	? { mod: true, key: "]", code: "BracketRight", label: "Go forward" }
	: { alt: true, key: "→", code: "ArrowRight", label: "Go forward" };

/**
 * Move the focused tab along the strip: one place left or right, or to either end. Alt+Arrow is the
 * reorder chord the collection tree already answers, and Alt+Home/End its jump to an end. Unlike
 * every chord above these act on the *focused* tab, not the active one, so the strip's own
 * `onKeyDown` binds them, only while a `role="tab"` element holds focus.
 *
 * Off macOS this is the same key as `GO_BACK_CHORD` / `GO_FORWARD_CHORD` (Alt+←/→), which `Shell`
 * matches before its modifier gate. The tree's precedent resolves it: the strip's handler takes the
 * chord while a tab has focus and calls `stopPropagation`, so `Shell`'s window listener never sees
 * it. Go back stays reachable from every other focus, from the title-bar buttons, the palette and
 * mouse buttons 3 and 4. On macOS Go back is ⌘[ and nothing collides.
 *
 * Left and right carry `code` for Go back's reason; Home and End are one character on every layout
 * and are matched by `key`.
 */
export const MOVE_TAB_LEFT_CHORD: Chord = {
	alt: true,
	key: "←",
	code: "ArrowLeft",
	label: "Move the focused tab left",
};

export const MOVE_TAB_RIGHT_CHORD: Chord = {
	alt: true,
	key: "→",
	code: "ArrowRight",
	label: "Move the focused tab right",
};

export const MOVE_TAB_START_CHORD: Chord = {
	alt: true,
	key: "Home",
	label: "Move the focused tab to the start",
};

export const MOVE_TAB_END_CHORD: Chord = {
	alt: true,
	key: "End",
	label: "Move the focused tab to the end",
};

/**
 * Move focus to the next region of the window and, shifted, to the previous. F6 is the desktop
 * convention for cycling panes (Windows Explorer, Firefox, VS Code's
 * `workbench.action.focusNextPart`), and answers what landmarks alone do not fix: the drawer is
 * labelled and in a screen reader's landmark list, yet reaching the URL bar from a collection row
 * would mean Tabbing through every request in the tree.
 *
 * Not a skip link: "Skip to content" exists because a web page has a top that a reader arrives at,
 * and a desktop window has none; focus is as likely to start in the context bar as anywhere else.
 *
 * No modifier, so `Shell`'s handler matches these before its `⌘ or Ctrl` gate. Safe because F6 is a
 * function key: no text field consumes it, and nothing in the app claims it.
 */
export const NEXT_REGION_CHORD: Chord = { key: "F6", label: "Focus the next region" };

export const PREVIOUS_REGION_CHORD: Chord = {
	shift: true,
	key: "F6",
	label: "Focus the previous region",
};

/**
 * Move focus into the notification stack, the only keyboard path to a toast's Undo (#3498).
 *
 * **Display only: nothing here binds it.** Radix's `ToastProvider` owns F8 (its default `hotkey`,
 * which `Toaster` leaves alone) and advertises it in the viewport's accessible name, so this chord
 * is for the Keyboard shortcuts panel and must never reach `matchesChord`. `Toaster.test.tsx` holds
 * the key equal to Radix's, so a changed default cannot leave the panel describing a dead key.
 */
export const FOCUS_NOTIFICATIONS_CHORD: Chord = { key: "F8", label: "Focus notifications" };

/**
 * Move focus out of a code editor. Monaco's Tab indents, right for a code editor and a keyboard
 * trap for anyone who reached one by tabbing (WCAG 2.1.2). Monaco's own way out,
 * `editor.action.toggleTabFocusMode`, cannot simply be advertised: its binding is Ctrl+M, on macOS
 * ⌃⇧M, a Control no live chord here can carry (`Chord.ctrl` is display only), while ⌘M, the
 * platform's spelling, is Minimize.
 *
 * So the app declares its own exit here, where the Keyboard Shortcuts panel lists it for free and
 * `lib/editor-chords.ts` binds it. ⇧ sits beside Monaco's Ctrl+M rather than taking it over, and
 * CtrlCmd+Shift+M is claimed by neither the standalone editor nor the native menu.
 *
 * Read-only editors have no trap: `tabFocusMode` is on for them (`ui/code-editor.tsx`), Tab having
 * no editing meaning there, so they show no hint. The binding is still registered on them: one
 * `addCommand` on every instance is cheaper to keep true than a `readOnly` branch through the
 * bridge, and it is only redundant with the Tab that already works.
 */
export const LEAVE_EDITOR_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "M",
	label: "Move focus out of the editor",
};

/**
 * Open the variable under the cursor, inside a code editor. The mouse route into a `{{token}}`'s
 * popover is ⌘-click on the token (#1220), and a keyboard user has no token to click: Monaco draws
 * its text rather than laying out DOM, so there is nothing to Tab to the way `VariableInput`'s
 * overlay strip offers. This chord reads the caret's own position, so it needs no pointer and no
 * roving tab stop.
 *
 * ⇧⌘D, because of the free letters: Monaco binds A, F, G, I, K, L, M, O and R with Shift somewhere
 * in the combination; this registry holds B, E, H, U, S, T and M; the native menu takes ⇧⌘W, and
 * the platform edit menu ⇧⌘Z and ⇧⌘V. D is claimed by none of them.
 *
 * Bound per editor in the token hook, not at `window`: which variable to open is a question only
 * the editor holding the caret can answer, as `LEAVE_EDITOR_CHORD` acts on *this* editor.
 */
export const EDIT_VARIABLE_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "D",
	label: "Edit the variable under the cursor",
};

/**
 * The drawer view switchers, keyed by the view they activate. ⌘S is Save, so Services takes ⇧⌘S,
 * which nothing else binds: the native menu's only ⇧⌘ chord is ⇧⌘W (close window). Settings is the
 * odd one out because ⌘, is the platform convention and predates the drawer's Settings view.
 *
 * Read by `Shell`'s handler and by the activity rail's tooltips (`ActivityRail`), the pairing this
 * file exists for.
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
 * ⌘1-⌘9, focusing the nth open tab. Bound by `code`, not by character (see `Chord.code`). The index
 * into this array is the tab index, so the order is the definition.
 */
export const TAB_CHORDS: readonly Chord[] = Array.from({ length: 9 }, (_, i) => ({
	mod: true,
	key: String(i + 1),
	code: `Digit${i + 1}`,
	label: `Focus tab ${i + 1}`,
}));

/**
 * Chords the native menu answers to (#3325): **display-only** here, because Electron's menu takes
 * these keydowns before the renderer sees them. Do not pass one to `matchesChord` or a live
 * handler: it would never fire, and `FULL_SCREEN_CHORD` on macOS, the one that is not a real `mod`
 * chord, would answer to a different key.
 *
 * `electron/menu-accelerators.ts` builds every accelerator the menu registers from these; the main
 * process cannot import this file, so `electron/menu-accelerators.test.ts` holds the two in step.
 */
export const ZOOM_IN_CHORD: Chord = { mod: true, key: "=", label: "Zoom in" };

export const ZOOM_OUT_CHORD: Chord = { mod: true, key: "-", label: "Zoom out" };

export const RESET_ZOOM_CHORD: Chord = { mod: true, key: "0", label: "Reset zoom" };

/**
 * Full screen: Electron's `togglefullscreen` role, which brings its own accelerator (F11 on Windows
 * and Linux, ⌃⌘F on macOS). Two definitions behind one name, chosen once at import as
 * `GO_BACK_CHORD` is, because the platforms disagree about the key, not the modifier.
 */
export const FULL_SCREEN_CHORD: Chord = isMac
	? { mod: true, ctrl: true, key: "F", label: "Full screen" }
	: { key: "F11", label: "Full screen" };

/**
 * Close the window. ⇧⌘W because ⌘W is Close tab, which the renderer owns; the menu item is rebound
 * so its accelerator does not swallow the keydown.
 */
export const CLOSE_WINDOW_CHORD: Chord = {
	mod: true,
	shift: true,
	key: "W",
	label: "Close window",
};

/**
 * Quit. The role's own accelerator is the platform default on macOS and Linux and absent on
 * Windows; the menu sets this one explicitly so the three agree and the panel's row is true
 * everywhere.
 */
export const QUIT_CHORD: Chord = { mod: true, key: "Q", label: "Quit" };

/**
 * The key-cap for deleting, as the platform names it. Both keys do the same thing everywhere
 * (`useRovingTreeFocus`, `TabItem`): a Mac's "delete" key reports `Backspace` and forward-delete
 * `Delete`, so the cap names both rather than whichever one the author's keyboard calls Delete.
 */
const DELETE_KEYS = isMac ? "⌫ / ⌦" : "Delete / Backspace";

/**
 * The collection tree's keys and the tab strip's close key (#3325). Like the tab-move chords above,
 * the focused element's own `onKeyDown` binds them, only while a row or tab holds focus, so they
 * are display-only here: nothing matches them through `matchesChord`.
 *
 * Alt+Arrow is the keyboard half of drag-and-reorder: up and down step past a sibling, left takes
 * the row out of its collection and right nests it in.
 */
export const TREE_MOVE_UP_CHORD: Chord = {
	alt: true,
	key: "↑",
	label: "Move the focused row up",
};

export const TREE_MOVE_DOWN_CHORD: Chord = {
	alt: true,
	key: "↓",
	label: "Move the focused row down",
};

export const TREE_MOVE_OUT_CHORD: Chord = {
	alt: true,
	key: "←",
	label: "Move the focused row out of its collection",
};

export const TREE_MOVE_IN_CHORD: Chord = {
	alt: true,
	key: "→",
	label: "Move the focused row into the collection above",
};

export const TREE_RENAME_CHORD: Chord = { key: "F2", label: "Rename" };

export const TREE_DELETE_CHORD: Chord = { key: DELETE_KEYS, label: "Delete the focused row" };

/**
 * Open the focused row's menu. Three keys reach it: Shift+F10 and the Menu key are the platform
 * pair, and Shift+Enter is the one a Mac keyboard has (it has no Menu key).
 */
export const TREE_MENU_CHORD: Chord = { shift: true, key: "F10", label: "Open the row menu" };

export const TREE_MENU_KEY_CHORD: Chord = {
	key: "Menu",
	label: "Open the row menu with the Menu key",
};

export const TREE_MENU_ENTER_CHORD: Chord = {
	shift: true,
	key: "↵",
	label: "Open the row menu with Shift and Enter",
};

export const CLOSE_FOCUSED_TAB_CHORD: Chord = { key: DELETE_KEYS, label: "Close the focused tab" };

/** A named block of chords, as a surface that lists them prints it. */
export interface ShortcutGroup {
	/** Stable across renders and reorderings - the React key. */
	id: string;
	/** Heading above the block. */
	title: string;
	chords: readonly Chord[];
}

/**
 * Every chord above, grouped for display (#951). The membership is written here, not in the panel
 * that draws it, so the surface holds no list of its own: it maps these groups, reads each chord's
 * `label` and renders the keys through `chordKeys`. Adding a chord to this file and to a group is
 * the whole edit; `shortcuts.listed.test.ts` walks this module's exports and fails if a chord
 * reaches neither.
 *
 * `⌘,` appears once: `DRAWER_VIEW_CHORDS.settings` *is* `SETTINGS_CHORD`, the same object on
 * purpose, so the drawer group filters it out by identity rather than printing a second row for a
 * key the reader already saw.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	{
		id: "requests",
		title: "Requests",
		chords: [NEW_REQUEST_CHORD, SEND_CHORD, LOAD_TEST_CHORD, FOCUS_URL_CHORD],
	},
	{
		id: "general",
		title: "General",
		chords: [
			PALETTE_CHORD,
			SAVE_CHORD,
			CLOSE_TAB_CHORD,
			TOGGLE_DRAWER_CHORD,
			TOGGLE_CONTEXT_BAR_CHORD,
			TOGGLE_BOTTOM_PANEL_CHORD,
			TOGGLE_RESPONSE_POSITION_CHORD,
			SETTINGS_CHORD,
			APP_MENU_CHORD,
		],
	},
	{
		id: "drawer",
		title: "Sidebar views",
		chords: Object.values(DRAWER_VIEW_CHORDS).filter((chord) => chord !== SETTINGS_CHORD),
	},
	{
		id: "tabs",
		title: "Tabs",
		chords: [
			GO_BACK_CHORD,
			GO_FORWARD_CHORD,
			NEXT_TAB_CHORD,
			PREVIOUS_TAB_CHORD,
			...TAB_CHORDS,
			MOVE_TAB_LEFT_CHORD,
			MOVE_TAB_RIGHT_CHORD,
			MOVE_TAB_START_CHORD,
			MOVE_TAB_END_CHORD,
		],
	},
	{
		id: "tree",
		title: "Collection tree and tabs",
		chords: [
			TREE_MOVE_UP_CHORD,
			TREE_MOVE_DOWN_CHORD,
			TREE_MOVE_OUT_CHORD,
			TREE_MOVE_IN_CHORD,
			TREE_RENAME_CHORD,
			TREE_DELETE_CHORD,
			TREE_MENU_CHORD,
			TREE_MENU_KEY_CHORD,
			TREE_MENU_ENTER_CHORD,
			CLOSE_FOCUSED_TAB_CHORD,
		],
	},
	{
		id: "focus",
		title: "Moving focus",
		chords: [NEXT_REGION_CHORD, PREVIOUS_REGION_CHORD, FOCUS_NOTIFICATIONS_CHORD],
	},
	{ id: "editors", title: "Editors", chords: [LEAVE_EDITOR_CHORD, EDIT_VARIABLE_CHORD] },
	{
		id: "window",
		title: "Window",
		chords: [
			ZOOM_IN_CHORD,
			ZOOM_OUT_CHORD,
			RESET_ZOOM_CHORD,
			FULL_SCREEN_CHORD,
			CLOSE_WINDOW_CHORD,
			QUIT_CHORD,
		],
	},
];

/**
 * Does this event match a chord?
 *
 * `shift` is compared strictly, not ignored: otherwise Ctrl+Shift+Enter satisfies Send's
 * `mod + Enter` too and both fire, the one thing a modifier-distinguished pair must not do.
 *
 * `alt` is compared the same way, as a bug fix rather than symmetry: on many European Windows
 * layouts AltGr *is* Ctrl+Alt, so a handler ignoring `altKey` would fire Save on AltGr+S and close
 * the tab on AltGr+W while the user types a `@`, `€` or `\`.
 *
 * The key is compared case-insensitively: a letter chord is declared in the case it is *displayed*
 * in ("K", so the hint reads ⌘K), while `KeyboardEvent.key` reports the character produced ("k"
 * unmodified, "K" under Caps Lock). Case never distinguishes two chords here; `shift` does, and is
 * still compared exactly. A chord carrying a `code` is matched on that instead, whatever character
 * it produces.
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
