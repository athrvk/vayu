/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which section tabs fit a strip's space and which go to the overflow menu (#2200): `TabStrip`'s
 * measured fit for document tabs, applied to Radix `TabsTrigger`s. Widths come from a canvas, not
 * the rendered triggers (hiding one would change what is measured next), and the active tab never
 * overflows.
 *
 * **`containerRef` goes on a wrapper around the `TabsList`, never on the list.** The list is
 * `min-w-0` and shrinks to its visible triggers, so measuring it reads back the previous fit's
 * width, a feedback loop that collapses the strip to one tab (`TabStrip.overflow.test.tsx`). The
 * wrapper must fill its parent whatever its content (`flex-1` in a row, `w-full` in a column). A
 * callback ref, not an object ref: a pane returning early (an empty response) has no wrapper on its
 * first commit, and the observer must attach when the wrapper does.
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
 * The font a trigger draws its name in, read from a rendered one so the user's font choice and
 * scale count. The weight is pinned to 600: `TabLabel` reserves the bold width in every state, so
 * that is the width a trigger takes.
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
	// No New-tab button to reserve for, and `fitTabs` pays for the "+N" control itself, so a row
	// that fits shows no menu.
	const { visible, overflowed } = fitTabs(widths, available, ids.indexOf(activeId), {
		reserved,
	});

	return {
		containerRef: setContainer,
		visibleIds: visible.map((i) => ids[i]),
		overflowedIds: overflowed.map((i) => ids[i]),
	};
}
