/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A faint band that sweeps across the pane while a re-send is in flight.
 *
 * `index.tsx`'s `busy` dim (opacity-60, no motion) is the pane's own reading
 * of the "Loading" rule in docs/design-system.md - a stale exchange stays
 * exactly where it is and only its opacity says it is waiting. On its own that
 * read as inert rather than active: nothing there distinguishes "the new
 * response is on its way" from "the request stalled." This is deliberately
 * the one exception to "nothing else on the pane moves" - see the rule's own
 * paragraph in the doc for why a re-send earns it and a first load does not.
 *
 * `pointer-events-none` and `aria-hidden`: it is a hint layered over content
 * that is still readable and clickable underneath it, not a control, and
 * `aria-busy` on the pane already tells assistive tech the state a sighted
 * user reads from this. `via-foreground/[0.08]` is low enough that the stale
 * text under it stays legible at every point in the sweep - a shimmer built
 * to stand in for content nobody can see yet is stronger than this needs to
 * be, since here there is real content under it the whole time.
 */
export function SendingWave() {
	return (
		<div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
			<div className="response-wave absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent" />
		</div>
	);
}

export default SendingWave;
