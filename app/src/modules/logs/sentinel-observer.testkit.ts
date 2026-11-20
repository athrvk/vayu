/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An `IntersectionObserver` for the Logs list's window tests (#3670) that
 * never fires by itself: a case says which sentinel scrolled into view, by its
 * element, so the window only moves for the reason under test. jsdom has no
 * observer, and `useLogWindow` then mounts every row.
 */

import { vi } from "vitest";

export interface SentinelObserver {
	/** @p node scrolled into view: run the callback of the observer watching it. */
	reach: (node: Element) => void;
}

export function stubSentinelObserver(): SentinelObserver {
	const watching = new Map<Element, () => void>();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			private readonly nodes = new Set<Element>();
			constructor(private readonly callback: IntersectionObserverCallback) {}
			observe(node: Element) {
				this.nodes.add(node);
				watching.set(node, () =>
					this.callback(
						[
							{
								isIntersecting: true,
								target: node,
							} as unknown as IntersectionObserverEntry,
						],
						this as unknown as IntersectionObserver
					)
				);
			}
			disconnect() {
				for (const node of this.nodes) watching.delete(node);
				this.nodes.clear();
			}
		}
	);
	return {
		reach: (node) => {
			const fire = watching.get(node);
			if (!fire) throw new Error("Reached a sentinel nothing observes");
			fire();
		},
	};
}
