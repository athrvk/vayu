/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The ⌘K command palette.
 *
 * Reaching anything by name. Before this, a request meant the collections
 * drawer plus tree expansion, a run meant the history drawer plus scrolling,
 * and a settings section meant ⌘, plus its sidebar - so Vayu was navigated with
 * a mouse or not at all.
 *
 * Three things it deliberately is not:
 *
 * - **Not its own search implementation.** Results come from source hooks
 *   (`sources/`), each returning the same `PaletteItem` shape and performing
 *   its action through the very call the sidebar makes. Settings entries,
 *   variables and runs joined as three more sources and changed nothing here.
 * - **Not its own list of actions.** The Commands and Settings groups are
 *   `lib/commands`, the registry the native menu points at too. What this file
 *   does own is the *host* for the dialogs those commands open - see
 *   `useCommandSurfaces` for why the picker and the run dialog are mounted here
 *   rather than left to surfaces that are not always on screen.
 * - **Not a second copy of the tab strip's naming.** Tab rows are labelled by
 *   `tab-descriptors`, the hook the strip itself uses.
 *
 * Focus goes back where it came from on close, and that is this file's job, not
 * Radix's: `FocusScope` restores to the dialog's *trigger*, and a palette
 * summoned by a chord has none - measured, focus lands on `<body>`, so the caret
 * is gone from the editor the user was typing in. See `focusBefore` below.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { CommandDialog, CommandFooter, CommandInput, Kbd } from "@/components/ui";
import { useLayoutStore, useToastStore } from "@/stores";
import { PALETTE_CHORD, matchesChord } from "@/constants/shortcuts";
import { useCommandContext } from "@/hooks/useCommandContext";
import { isModalOpen } from "@/lib/modal";
import RunCollectionDialog from "@/modules/collections/RunCollectionDialog";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { PaletteResults } from "./PaletteResults";
import { useCommandSurfaces } from "./useCommandSurfaces";
import type { PaletteItem } from "./types";

/**
 * The highlight cmdk is handed while it must have none. A controlled `value`
 * that matches no row leaves every row unselected, and it has to be non-empty:
 * cmdk reads an empty one as "nothing chosen yet" and highlights the first row.
 * `\u0001` survives the `.trim()` cmdk applies, and no row's text can start
 * with it.
 */
const NO_HIGHLIGHT = "\u0001no-highlight";

/**
 * The keys cmdk answers by moving the highlight - not Enter, Escape or typing.
 * Mirrors its own switch (arrows, Home, End, and the vim bindings Ctrl+N/J/P/K),
 * minus a keystroke an IME owns, which cmdk ignores too.
 */
function movesHighlight(e: ReactKeyboardEvent): boolean {
	if (e.nativeEvent.isComposing || e.defaultPrevented) return false;
	if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return true;
	return e.ctrlKey && ["n", "j", "p", "k"].includes(e.key);
}

/** Shown when the chord is refused because another dialog is open (#3320). */
const PALETTE_BLOCKED_MESSAGE = "Close the dialog to use the command palette";

export function CommandPalette() {
	const paletteOpen = useLayoutStore((s) => s.paletteOpen);
	const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);
	const [query, setQuery] = useState("");
	/** The query matched nothing, so the rows on screen are suggestions (#3321). */
	const [nothingMatched, setNothingMatched] = useState(false);
	/**
	 * The user has moved the highlight since the query last changed. Until then a
	 * suggestion is not chosen, and Enter must not run it.
	 */
	const [navigated, setNavigated] = useState(false);
	/**
	 * What cmdk last said it highlighted, and how many times it has said so. The
	 * value is what a navigating user gets back; the count is what makes the
	 * withheld highlight re-apply when cmdk re-highlights the same row for the
	 * next query, which a bare value could not signal.
	 */
	const [highlight, setHighlight] = useState({ value: "", reports: 0 });
	const { surfaces, pickerProps, runTarget, dismissRunDialog } = useCommandSurfaces();
	const commandContext = useCommandContext(surfaces);
	/** Where focus was when the palette opened, to give it back on close. */
	const focusBefore = useRef<HTMLElement | null>(null);

	/*
	 * Read from a store subscription rather than from an effect on `paletteOpen`.
	 *
	 * An effect would be too late: child effects run before the parent's, so by
	 * the time this component's effect fires, the dialog below it has already
	 * moved focus to its own search field and `document.activeElement` is that
	 * field. A subscription runs inside `set()`, before React re-renders - the
	 * last moment the previous focus still exists.
	 *
	 * It also catches every opener, not just the chord: the welcome Launcher's
	 * Search tile and the title bar's search bar both flip this flag through the
	 * store.
	 */
	useEffect(
		() =>
			useLayoutStore.subscribe((state, previous) => {
				if (!state.paletteOpen || previous.paletteOpen) return;
				const active = document.activeElement;
				focusBefore.current = active instanceof HTMLElement ? active : null;
				// Every open starts empty, like Spotlight - a palette reopened with
				// the last query still in it shows yesterday's search. Here rather
				// than in `onOpenChange` so it holds for every opener, including the
				// ones that flip the store flag directly.
				setQuery("");
				setNavigated(false);
				setHighlight({ value: "", reports: 0 });
			}),
		[]
	);

	/*
	 * Restoring focus has to wait for the commit that unmounts the dialog: doing
	 * it in the subscription above would run before React re-renders, and Radix's
	 * own unmount handling would then move focus off again.
	 */
	useEffect(() => {
		if (paletteOpen) return;
		const previous = focusBefore.current;
		focusBefore.current = null;
		// `isConnected` because whatever had focus may have been unmounted by the
		// very thing the palette just did - picking a request replaces the main
		// pane, and focusing a detached node throws focus to `<body>` instead.
		if (previous?.isConnected) previous.focus();
	}, [paletteOpen]);

	/*
	 * Capture phase, unlike the rest of the app's shortcuts, which listen on the
	 * bubble in `Shell`.
	 *
	 * Monaco treats Ctrl/⌘+K as the start of a chord (⌘K ⌘C and friends) and
	 * calls `stopPropagation` on it, so a bubble-phase listener on `window`
	 * never sees the key while the caret is in a body or script editor - which
	 * is most of the time in this app, and exactly when reaching another
	 * request by name is worth the most. Capture runs before the editor gets
	 * the event.
	 *
	 * The scope of the divergence is one chord: everything else stays on the
	 * bubble, where a focused control still gets first refusal.
	 */
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!matchesChord(e, PALETTE_CHORD)) return;
			/*
			 * Not over another dialog (#3320): the palette would stack on it, and
			 * running a command from there acts on the page the dialog belongs to.
			 * Guarded on the palette being closed because the palette is itself a
			 * dialog - while it is open `isModalOpen()` is true, and the chord must
			 * still toggle it shut. Before the claim below, so the key stays the
			 * dialog's own.
			 */
			if (!useLayoutStore.getState().paletteOpen && isModalOpen()) {
				/*
				 * Say why nothing happened. `showToast` drops an identical open toast
				 * before appending, so a held key leaves one toast with a fresh timer
				 * rather than a stack. The toast viewport sits at z-[100], above the
				 * dialogs' z-50, and Radix announces it through its live region.
				 */
				useToastStore.getState().showToast(PALETTE_BLOCKED_MESSAGE, "info");
				return;
			}
			e.preventDefault();
			/*
			 * And stopped here, not merely prevented. `preventDefault` cancels the
			 * browser's own action and nothing else: the event still finished its
			 * journey to Monaco, which treats ⌘K as a chord *leader* and entered
			 * chord mode behind the open palette - so the next key typed in the
			 * editor answered "not a command" in its status bar. Capturing a key and
			 * leaving it in flight is half a claim.
			 *
			 * Scoped to this one chord like the capture phase itself: the `return`
			 * above is the only other way out of this handler, so no other key is
			 * stopped.
			 */
			e.stopPropagation();
			// Toggling rather than only opening: the chord that summoned it is
			// the one a user presses again to dismiss it.
			setPaletteOpen(!useLayoutStore.getState().paletteOpen);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [setPaletteOpen]);

	const changeQuery = (next: string) => {
		setQuery(next);
		setNavigated(false);
	};

	/*
	 * Close, then perform - and the close is flushed. A command that moves focus
	 * (closing a tab hands it to the replacement, #3401) has to do it once the
	 * palette is gone: while the dialog is open its focus trap pulls focus back
	 * into the search field, and the restore effect above, which runs on the
	 * close, would then take focus to whatever held it before the palette opened.
	 * Flushed so that effect has run by the time `perform` does, leaving the
	 * command the last word on where focus is.
	 */
	const pick = (item: PaletteItem) => {
		flushSync(() => setPaletteOpen(false));
		item.perform();
	};

	return (
		<>
			<CommandDialog
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				title="Command palette"
				description="Search open tabs, requests, collections, views, commands, settings, variables and past runs."
				className="max-w-xl"
				/* Matching belongs to `ranking.ts`, which needs to decide the top
				   result, the relevance floor and the announced count from one
				   pass. cmdk scoring the rendered rows again would be a second
				   authority over the same question - and the one that used to win,
				   since a section it could not re-order outranked any score. */
				shouldFilter={false}
				/* Nothing matched, so cmdk would highlight the first suggestion and
				   Enter would run it (#3321). The highlight is withheld until an
				   arrow key or the pointer chooses a row. cmdk re-highlights the
				   first row on every new search, and a controlled `value` only
				   re-applies when it changes - so the withheld value carries the
				   count of highlights cmdk has reported. `NO_HIGHLIGHT` names no row. */
				value={
					nothingMatched && !navigated
						? `${NO_HIGHLIGHT}${highlight.reports}`
						: highlight.value
				}
				onValueChange={(value) => setHighlight((h) => ({ value, reports: h.reports + 1 }))}
				onKeyDown={(e) => movesHighlight(e) && setNavigated(true)}
				onPointerMove={() => setNavigated(true)}
			>
				{/* No chord in the placeholder: the palette is already open by the
				    time anyone reads it, so the one thing it would teach has
				    just been used. The title bar's search bar advertises ⌘K
				    where it is still worth knowing. */}
				<CommandInput
					value={query}
					onValueChange={changeQuery}
					placeholder="Search tabs, requests, commands, settings…"
				/>
				{/*
				 * Mounted only while open, so a shut palette holds no query observers
				 * on collections, requests and run history - the same rule the
				 * context bar applies to a collapsed section.
				 */}
				{paletteOpen && (
					<PaletteResults
						query={query}
						onPick={pick}
						commandContext={commandContext}
						onNothingMatchedChange={setNothingMatched}
					/>
				)}
				{/* Below the list rather than inside it: `CommandList` is the band
				    that scrolls, and hints that scroll away are hints nobody
				    reads. Every key here is one the open palette answers - the
				    arrows and Enter are cmdk's, Escape is the dialog's. */}
				<CommandFooter>
					<span className="flex items-center gap-1">
						<Kbd size="sm">↑</Kbd>
						<Kbd size="sm">↓</Kbd>
						<span>Navigate</span>
					</span>
					<span className="flex items-center gap-1">
						<Kbd size="sm">↵</Kbd>
						<span>Open</span>
					</span>
					<span className="flex items-center gap-1">
						<Kbd size="sm">esc</Kbd>
						<span>Close</span>
					</span>
				</CommandFooter>
			</CommandDialog>
			{/* Outside the palette on purpose: a command closes the palette as it
			    runs, so a dialog rendered inside it would be unmounted by the very
			    pick that opened it. */}
			<CollectionPicker {...pickerProps} />
			{runTarget && (
				<RunCollectionDialog
					collection={runTarget}
					onOpenChange={(open) => !open && dismissRunDialog()}
				/>
			)}
		</>
	);
}
