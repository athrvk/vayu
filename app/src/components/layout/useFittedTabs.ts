/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which section tabs fit the space a strip has, and which go to the overflow
 * menu (#2200).
 *
 * The response and request strips used to be `overflow-x-auto` with a hidden
 * scrollbar, so at the default split the last tabs were simply cut off with no
 * cue that they existed. This is the measured-fit `TabStrip` uses for document
 * tabs, applied to Radix `TabsTrigger`s: widths come from a canvas rather than
 * from the rendered triggers (hiding one would change what is measured next),
 * and the active tab is never the one overflowed.
 *
 * **`containerRef` goes on a wrapper around the `TabsList`, never on the list.**
 * The list is `min-w-0` and shrinks to its visible triggers, so measuring it
 * reads back the width the previous fit left - the feedback loop that collapsed
 * `TabStrip` to one tab (`TabStrip.overflow.test.tsx`). The wrapper has to fill
 * its parent whatever its content is (`flex-1` in a row, `w-full` in a column).
 *
 * It is a callback ref, not an object ref: a pane that returns early (an empty
 * response) has no wrapper on its first commit, and the observer must attach
 * when the wrapper does.
 */

import { useLayoutEffect, useMemo, useState } from "react";
import { fitTabs, makeTextMeasurer, naturalTriggerWidth } from "./tab-fit";

/** `text-xs` at the semibold weight a trigger reserves, until a trigger can be read. */
const FALLBACK_FONT = "600 12px sans-serif";

export interface FittedTabsInput<Id extends string> {
	ids: readonly Id[];
	/** The text each trigger draws, parallel to `ids`. */
	labels: readonly string[];
	activeId: Id;
	/** Room a tab's marks may grow into after the fit; see `MARK_ALLOWANCE`. */
	markAllowance?: (id: Id) => number;
	/** Width of the wrapper that is not triggers - the list's own padding. */
	reserved?: number;
}

export interface FittedTabs<Id extends string> {
	containerRef: (el: HTMLDivElement | null) => void;
	visibleIds: readonly Id[];
	overflowedIds: readonly Id[];
}

/**
 * The font a trigger draws its name in, read from a rendered one so the user's
 * font choice and scale are included. The weight is pinned to 600: `TabLabel`
 * reserves the bold width in every state, so that is the width a trigger takes.
 */
function triggerFont(container: HTMLElement): string {
	const trigger = container.querySelector('[data-slot="tabs-trigger"]') ?? container;
	const { fontSize, fontFamily } = getComputedStyle(trigger);
	if (!fontSize || !fontFamily) return FALLBACK_FONT;
	return `600 ${fontSize} ${fontFamily}`;
}

export function useFittedTabs<Id extends string>({
	ids,
	labels,
	activeId,
	markAllowance,
	reserved = 0,
}: FittedTabsInput<Id>): FittedTabs<Id> {
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [available, setAvailable] = useState(0);
	const [font, setFont] = useState(FALLBACK_FONT);

	/** Remeasure on resize - the pane's width is whatever the split leaves it. */
	useLayoutEffect(() => {
		if (!container) return;
		const read = () => {
			setAvailable(container.clientWidth);
			setFont(triggerFont(container));
		};
		read();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(read);
		ro.observe(container);
		return () => ro.disconnect();
	}, [container]);

	const measure = useMemo(() => makeTextMeasurer(font), [font]);
	const widths = ids.map((id, i) =>
		naturalTriggerWidth(labels[i], measure, markAllowance?.(id) ?? 0)
	);
	// Nothing to reserve for a New-tab button, and the "+N" control is paid for
	// by fitTabs itself, so a row that fits shows no menu.
	const { visible, overflowed } = fitTabs(widths, available, ids.indexOf(activeId), {
		reserved,
	});

	return {
		containerRef: setContainer,
		visibleIds: visible.map((i) => ids[i]),
		overflowedIds: overflowed.map((i) => ids[i]),
	};
}
