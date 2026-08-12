/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reveal the setting a search result asked for.
 *
 * A result selects the owning category and leaves `highlightedKey` behind; this
 * finds the block that carries that key as `data-setting-anchor`, scrolls it
 * into view and outlines it for a moment.
 *
 * One mechanism for both halves. The engine cards originally did this with a
 * React ref and a conditional class, which worked only because those cards are
 * rendered by one component from one array - the app panels are seven
 * hand-written files, and giving them a second, different reveal would have
 * meant two implementations of "show me this setting" for one feature. An
 * attribute is what both can carry.
 */

/* global setTimeout, clearTimeout, MutationObserver */

import { useEffect } from "react";
import { useSettingsStore } from "@/modules/settings/settings-store";

/** How long the outline stays after the view scrolls to the setting. */
export const HIGHLIGHT_MS = 2500;

/**
 * Tailwind classes, applied imperatively.
 *
 * The alternative - a `highlighted` prop threaded down to every card in every
 * panel - is the change this attribute exists to avoid. Written as separate
 * literals so Tailwind's scanner emits them.
 */
const HIGHLIGHT_CLASSES = ["ring-2", "ring-primary", "rounded-lg"];

export function useRevealedSetting(): void {
	const highlightedKey = useSettingsStore((s) => s.highlightedKey);
	const clearHighlight = useSettingsStore((s) => s.clearHighlight);

	useEffect(() => {
		if (!highlightedKey) return;

		let target: Element | null = null;
		const reveal = () => {
			target = document.querySelector(`[data-setting-anchor="${highlightedKey}"]`);
			if (!target) return false;
			// jsdom has no layout and does not implement this, hence the optional call.
			target.scrollIntoView?.({ block: "center" });
			target.classList.add(...HIGHLIGHT_CLASSES);
			return true;
		};

		/*
		 * The panel can arrive after the key does - the engine catalogue is a
		 * query, and a panel switching category mounts on the next commit - so a
		 * single lookup would silently find nothing. The observer watches until
		 * the block appears; the timer below ends the attempt either way, so a
		 * key naming something that no longer exists cannot leave it running.
		 */
		let observer: MutationObserver | undefined;
		if (!reveal() && typeof MutationObserver !== "undefined") {
			observer = new MutationObserver(() => {
				if (reveal()) observer?.disconnect();
			});
			observer.observe(document.body, { childList: true, subtree: true });
		}

		const timer = setTimeout(() => {
			observer?.disconnect();
			target?.classList.remove(...HIGHLIGHT_CLASSES);
			clearHighlight();
		}, HIGHLIGHT_MS);

		return () => {
			observer?.disconnect();
			clearTimeout(timer);
			target?.classList.remove(...HIGHLIGHT_CLASSES);
		};
	}, [highlightedKey, clearHighlight]);
}
