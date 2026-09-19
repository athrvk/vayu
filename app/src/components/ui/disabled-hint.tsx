/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DisabledHint - why this control is off (issue #1690).
 *
 * The app carries 163 `disabled=` props and, before this, not one of the
 * controls behind them said why. The obvious fix does not work: `Button`'s
 * baseline sets `disabled:pointer-events-none`, so a `Tooltip` wrapped around a
 * disabled button never receives the pointer events its trigger listens for,
 * and a disabled button is not focusable either - both paths to the tooltip are
 * gone at exactly the moment there is something to explain. Every attempt to
 * explain a gate therefore ended up as prose beside the control, which only the
 * surfaces with room for a sentence could afford.
 *
 * So the trigger is a wrapper *around* the control rather than the control
 * itself: a `span` that keeps its own pointer events and its own tab stop, with
 * the disabled child inert inside it. The reason arrives on hover like any
 * tooltip and on Tab for a keyboard user, and nothing about the child changes -
 * the gate stays the child's `disabled` prop, which is still what refuses the
 * click.
 *
 * `reason` doubles as the switch: falsy renders the children alone, so a caller
 * passes one expression rather than branching its JSX around an enabled and a
 * disabled copy of the same button. The two copies are how a hover state, an
 * icon or an `aria-label` ends up on one of them and not the other.
 *
 * A disabled *menu item* is the one gated control this does not wrap:
 * `RowAction`'s `disabledReason` puts the reason on the item itself, because a
 * tooltip inside a menu's focus trap competes with the menu for the keyboard.
 * See `components/shared/row-actions.ts`.
 */

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export interface DisabledHintProps {
	/**
	 * Why the control is off, e.g. "No captures to clear". Falsy means the
	 * control is not gated and the children render on their own.
	 */
	reason?: string | false | null;
	/** Tooltip placement. Defaults to top, matching `TooltipIconButton`. */
	side?: React.ComponentProps<typeof TooltipContent>["side"];
	children: React.ReactNode;
}

export function DisabledHint({ reason, side = "top", children }: DisabledHintProps) {
	if (!reason) return <>{children}</>;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the tab stop is the only keyboard path to the reason: the child it wraps is disabled and so unfocusable, exactly the shape Dock.tsx's error tooltips are suppressed for */}
				<span
					data-slot="disabled-hint"
					tabIndex={0}
					// `pointer-events-auto` is the load-bearing class, not decoration:
					// this span is often a child of the disabled control's own
					// container, and it has to keep receiving hover after
					// `disabled:pointer-events-none` has taken it off the button
					// inside. `inline-flex` so the span is the child's exact box and
					// adds no line-height of its own; the ring is the span's, because
					// the focus is the span's.
					className="pointer-events-auto inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					{children}
				</span>
			</TooltipTrigger>
			<TooltipContent side={side}>{reason}</TooltipContent>
		</Tooltip>
	);
}
