/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `{{token}}` whose value is produced at run time rather than stored in a
 * scope - `{{$guid}}`, which a generator invents per use, and `{{data.email}}`,
 * which a collection run binds from the iteration's row.
 *
 * The sibling `EditableVariable` cannot serve either. It offers a popover for
 * viewing and editing a stored value, and neither of these has one: there is
 * nothing to edit, and any value it showed would be one it had just invented
 * rather than the one the request will carry. What it *would* do is worse -
 * a name no scope defines paints `text-destructive-text` with a "not defined"
 * tooltip, and offers to create the variable. For a generator that is exactly
 * backwards; for a `data.*` name the offer is a trap, since the namespace is
 * disjoint from the scopes and a variable of that name can never answer for the
 * column.
 *
 * One component for both, rather than one each: they differ only in the words
 * of the tooltip, and a hand-rolled copy of a primitive does not receive the
 * primitive's fixes.
 *
 * So: same typeface and layout as `EditableVariable` (see the font note there -
 * the caret is steered by a transparent input underneath and any width
 * difference walks it off the glyphs), muted rather than accent-coloured, and a
 * tooltip that says where the value will come from.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";

export interface RuntimeTokenProps {
	/** Name as written inside the braces, e.g. `"$guid"` or `"data.email"`. */
	name: string;
	/** What the token stands for, e.g. "UUID v4". */
	description: string;
	/** When it is produced, e.g. "generated per use". */
	note: string;
}

export default function RuntimeToken({ name, description, note }: RuntimeTokenProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="inline rounded-md font-[inherit] text-muted-foreground"
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs">
				<span className="flex items-baseline gap-2">
					<span className="break-all">{description}</span>
					<span className="shrink-0 text-primary-foreground/70">{note}</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
