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
 *   its action through the very call the sidebar makes. Adding settings,
 *   environments or runs later is a source, not a change here.
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

import { useEffect, useRef, useState } from "react";
import { CommandDialog, CommandInput } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import { PALETTE_CHORD, matchesChord } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { useCommandContext } from "@/hooks/useCommandContext";
import RunCollectionDialog from "@/modules/collections/RunCollectionDialog";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { PaletteResults } from "./PaletteResults";
import { useCommandSurfaces } from "./useCommandSurfaces";
import type { PaletteItem } from "./types";

export function CommandPalette() {
	const paletteOpen = useLayoutStore((s) => s.paletteOpen);
	const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);
	const [query, setQuery] = useState("");
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
			e.preventDefault();
			// Toggling rather than only opening: the chord that summoned it is
			// the one a user presses again to dismiss it.
			setPaletteOpen(!useLayoutStore.getState().paletteOpen);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [setPaletteOpen]);

	const pick = (item: PaletteItem) => {
		item.perform();
		setPaletteOpen(false);
	};

	return (
		<>
			<CommandDialog
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				title="Command palette"
				description="Search open tabs, requests, collections, views and commands."
				className="max-w-xl"
			>
				<CommandInput
					value={query}
					onValueChange={setQuery}
					placeholder={`Search tabs, requests, commands… (${formatChord(PALETTE_CHORD)})`}
				/>
				{/*
				 * Mounted only while open, so a shut palette holds no query observers
				 * on collections, requests and run history - the same rule the
				 * context bar applies to a collapsed section.
				 */}
				{paletteOpen && (
					<PaletteResults query={query} onPick={pick} commandContext={commandContext} />
				)}
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
