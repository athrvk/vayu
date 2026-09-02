/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `{{token}}` whose value is produced at run time rather than stored in a
 * scope - `{{$guid}}`, which a generator invents per use; `{{data.email}}`,
 * which a collection run binds from the iteration's row; and `{{$vu}}` /
 * `{{$iteration}}`, which the iteration that sends the request binds from the
 * run itself (issue #1101).
 *
 * The sibling `EditableVariable` cannot serve any of them. It offers a popover for
 * viewing and editing a stored value, and none of these has one: there is
 * nothing to edit, and any value it showed would be one it had just invented
 * rather than the one the request will carry. What it *would* do is worse -
 * a name no scope defines paints `text-destructive-text` with a "not defined"
 * tooltip, and offers to create the variable. For a generator that is exactly
 * backwards; for a `data.*` or identity name the offer is a trap, since both
 * namespaces are disjoint from the scopes and a variable of that name can never
 * answer for the column or the identity.
 *
 * One component for all three, rather than one each: they differ only in the words
 * of the tooltip, and a hand-rolled copy of a primitive does not receive the
 * primitive's fixes.
 *
 * So: same typeface and layout as `EditableVariable` (see the font note there -
 * the caret is steered by a transparent input underneath and any width
 * difference walks it off the glyphs), muted rather than accent-coloured, and a
 * tooltip that says where the value will come from.
 */

import { Tooltip, TooltipContent, TooltipTrigger, TooltipValue } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { DataTokenTone } from "@/lib/data-contract";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";

export interface RuntimeTokenProps {
	/** Name as written inside the braces, e.g. `"$guid"` or `"data.email"`. */
	name: string;
	/** What the token stands for, e.g. "UUID v4". */
	description: string;
	/** When it is produced, e.g. "generated per use". */
	note: string;
	/**
	 * `warning` for a token that will read correctly only if the run's file
	 * disagrees with the contract - a `{{data.x}}` naming a column no contract
	 * in scope declares (issue #600). Never `destructive`: that paint means "no
	 * value can ever answer this name", and an undeclared column can still bind
	 * from a file the contract has drifted from.
	 */
	tone?: DataTokenTone;
	/**
	 * Position in the host field's roving tab order (issue #1238), the same prop
	 * `EditableVariable` takes. `VariableInput` paints one strip over one input
	 * and gives exactly one token in it the Tab stop. Left at `0` for a token
	 * rendered on its own.
	 */
	tabIndex?: number;
	/**
	 * The host field is disabled. The token leaves the tab order rather than
	 * sitting in it, exactly as the editable one does (`variable-popover.tsx`) -
	 * a field nobody can edit should not cost a stop to walk past. The tooltip
	 * still opens on hover, because reading is not editing.
	 */
	disabled?: boolean;
}

export default function RuntimeToken({
	name,
	description,
	note,
	tone = "muted",
	tabIndex = 0,
	disabled = false,
}: RuntimeTokenProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/*
				 * Focusable, and deliberately not a `role="button"` (issue #1238).
				 *
				 * Radix's `asChild` clones its handlers and `aria-*` onto this span
				 * but does not make a span focusable - it assumes an interactive
				 * child - so this token was mouse-only, and its tooltip is the whole
				 * of it: the generator's description, "not generated here" for an
				 * identity, and the amber "Not a declared column of ..." that is how
				 * a drifted contract is spotted at all (issues #600, #1195). None of
				 * that reached a keyboard.
				 *
				 * A `tabIndex` is the entire fix, because `Tooltip` opens on focus
				 * and points `aria-describedby` at the content it opened. The
				 * editable token's other half - `role="button"` plus Enter/Space -
				 * would be a lie here: nothing is activated, there is no popover
				 * behind this, and announcing a button that answers no key is worse
				 * than announcing nothing.
				 */}
				<span
					className={cn("inline rounded-md font-[inherit]", DATA_TOKEN_TONE_CLASS[tone])}
					tabIndex={disabled ? -1 : tabIndex}
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs">
				{/*
				 * The same stacked shape as `EditableVariable`, and for a sharper
				 * reason: this note carries the declared column list, so it is the
				 * user's own data and unbounded in length (issue #1195).
				 */}
				<TooltipValue hint={note}>{description}</TooltipValue>
			</TooltipContent>
		</Tooltip>
	);
}
