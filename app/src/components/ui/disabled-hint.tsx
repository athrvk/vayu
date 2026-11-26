/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Why this control is off (#1690). A `Tooltip` around a disabled `Button` cannot work: the baseline
 * `disabled:pointer-events-none` starves the trigger of pointer events, and a disabled button is
 * not focusable, so both paths to the tooltip are gone when there is something to explain. So the
 * trigger is a wrapper *around* the control: a `span` keeping its own pointer events and tab stop,
 * the disabled child inert inside. The reason arrives on hover and on Tab, and the child is
 * unchanged: its `disabled` prop still refuses the click.
 *
 * `reason` is also the switch: falsy renders the children alone, so a caller passes one expression
 * instead of an enabled and a disabled copy of a button, which is how a hover state, icon or
 * `aria-label` ends up on only one. Crossing the gate replaces the child's DOM node (the wrapper
 * exists on one side only); nothing visible depends on it, as a disabled control has no focus to
 * lose, but a test holding a reference across the flip must re-query.
 *
 * A disabled *menu item* is not wrapped: `RowAction`'s `disabledReason` puts the reason on the
 * item, as a tooltip in a menu's focus trap competes with the menu for the keyboard
 * (`components/shared/row-actions.ts`).
 */

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export interface DisabledHintProps {
	/**
	 * Why the control is off ("No captures to clear"); falsy means not gated, and the children
	 * render alone.
	 */
	reason?: string | false | null;
	/** Tooltip placement. Defaults to top, matching `TooltipIconButton`. */
	side?: React.ComponentProps<typeof TooltipContent>["side"];
	children: React.ReactNode;
}

/**
 * `pointer-events-auto` is load-bearing: this span is often inside the disabled control's container
 * and must keep hover after `disabled:pointer-events-none` takes it off the button. `inline-flex`
 * so the span is the child's box with no line-height of its own; the ring is the span's, as the
 * focus is. A constant so the `tabIndex` below fits on the line its `eslint-disable-next-line`
 * covers.
 */
const WRAPPER_CLASS =
	"pointer-events-auto inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function DisabledHint({ reason, side = "top", children }: DisabledHintProps) {
	if (!reason) return <>{children}</>;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the tab stop is the only keyboard path to the reason: the child it wraps is disabled and so unfocusable, exactly the shape Dock.tsx's error tooltips are suppressed for */}
				<span data-slot="disabled-hint" tabIndex={0} className={WRAPPER_CLASS}>
					{children}
				</span>
			</TooltipTrigger>
			<TooltipContent side={side}>{reason}</TooltipContent>
		</Tooltip>
	);
}
