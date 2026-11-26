/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A faint band sweeping the pane while a re-send is in flight. `index.tsx`'s `busy` dim
 * (opacity-60, no motion) is the pane's reading of the "Loading" rule in
 * docs/design-system/component-patterns.md, but alone it reads inert, telling "on its way" from
 * "stalled" by nothing. This is the deliberate exception to "nothing else on the pane moves"; the
 * rule's paragraph says why a re-send earns it and a first load does not. `pointer-events-none` and
 * `aria-hidden`: a hint over content still readable and clickable, and `aria-busy` on the pane
 * already tells assistive tech. `via-foreground/[0.08]` keeps the stale text legible through the
 * sweep, weaker than a placeholder shimmer since real content is under it.
 */
export function SendingWave() {
	return (
		<div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
			<div className="response-wave absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent" />
		</div>
	);
}

export default SendingWave;
